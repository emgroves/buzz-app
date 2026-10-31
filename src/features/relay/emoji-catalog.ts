import { normalizeShortcode, type CustomEmoji } from "./emoji";
import { readErrorKind } from "./errors";
import type { RelayEvent } from "./events";
import type { RelayReader } from "./reader";

/** One custom emoji per event, keyed by author and shortcode (NIP-CE). */
export const EMOJI_ENTRY_KIND = 30180;
/** Shortest prefix, in letters and digits, that is worth a relay search. */
export const EMOJI_SEARCH_MIN_CHARS = 2;
/** Results asked of the relay for one search. */
export const EMOJI_SEARCH_LIMIT = 50;
const PREFIX_CACHE_MAX = 64;
const PREFIX_CACHE_TTL_MS = 60_000;
const FAILURE_COOLDOWN_MS = 30_000;
const KNOWN_MAX = 500;
const URL_MAX = 2048;

export type EmojiSearchOptions = Readonly<{
  signal?: AbortSignal;
  /** An explicit retry ends the cooldown that follows a failed search. */
  retry?: boolean;
}>;
type CatalogEntry = CustomEmoji & Readonly<{ id: string; createdAt: number }>;

/** Relay text for a typed shortcode prefix, or undefined when it cannot name a
 * catalog entry or is too short to search. The relay indexes `_` and `-` as spaces. */
export function catalogSearchText(prefix: string): string | undefined {
  const code = normalizeShortcode(prefix);
  if (!code) return undefined;
  const text = code.replace(/[_-]+/g, " ").trim();
  return text.replaceAll(" ", "").length >= EMOJI_SEARCH_MIN_CHARS
    ? text
    : undefined;
}

function catalogEntry(event: RelayEvent): CatalogEntry | undefined {
  if (event.kind !== EMOJI_ENTRY_KIND) return undefined;
  let d: string[] | undefined;
  let emoji: string[] | undefined;
  for (const tag of event.tags) {
    if (tag[0] === "h") return undefined;
    if (tag[0] === "d") {
      if (d) return undefined;
      d = tag;
    } else if (tag[0] === "emoji") {
      if (emoji) return undefined;
      emoji = tag;
    }
  }
  const shortcode = emoji?.[1];
  const url = emoji?.[2];
  if (
    emoji?.length !== 3 ||
    d?.length !== 2 ||
    !shortcode ||
    !url ||
    d[1] !== shortcode ||
    normalizeShortcode(shortcode) !== shortcode ||
    url.length > URL_MAX ||
    !/^https?:\/\/\S+$/i.test(url)
  )
    return undefined;
  return { shortcode, url, id: event.id, createdAt: event.created_at };
}

/** One emoji per shortcode: the newest entry across authors wins, then the lowest
 * event id, the relay's own tie-break. Malformed entries are skipped. Keeps the
 * order in which shortcodes first appear, so relay relevance survives. */
export function collapseCatalog(
  events: readonly RelayEvent[],
): readonly CustomEmoji[] {
  const winners = new Map<string, CatalogEntry>();
  for (const event of events) {
    const entry = catalogEntry(event);
    if (!entry) continue;
    const old = winners.get(entry.shortcode);
    if (
      !old ||
      entry.createdAt > old.createdAt ||
      (entry.createdAt === old.createdAt && entry.id < old.id)
    )
      winners.set(entry.shortcode, entry);
  }
  return [...winners.values()].map(({ shortcode, url }) =>
    Object.freeze({ shortcode, url }),
  );
}

/** Shortcodes the first list already has keep their entry. */
export function mergeEmoji(
  preferred: readonly CustomEmoji[],
  extra: readonly CustomEmoji[],
): readonly CustomEmoji[] {
  if (!extra.length) return preferred;
  const names = new Set(preferred.map((entry) => entry.shortcode));
  return [
    ...preferred,
    ...extra.filter((entry) => !names.has(entry.shortcode)),
  ];
}

const cancelled = () =>
  new DOMException("Emoji lookup cancelled", "AbortError");

/** Session-owned relay lookups of kind-30180 catalog entries. Holds only bounded,
 * expiring state; `clear` fences reads still in flight. */
export function createEmojiCatalog(
  reader: RelayReader,
  now: () => number = Date.now,
) {
  const prefixes = new Map<
    string,
    { at: number; entries: readonly CustomEmoji[] }
  >();
  const known = new Map<string, CustomEmoji>();
  let epoch = new AbortController();
  let failedAt: number | undefined;
  let closed = false;

  function remember(entries: readonly CustomEmoji[]) {
    for (const entry of entries) {
      known.delete(entry.shortcode);
      known.set(entry.shortcode, entry);
    }
    for (const name of known.keys()) {
      if (known.size <= KNOWN_MAX) break;
      known.delete(name);
    }
  }
  const lifetime = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, epoch.signal]) : epoch.signal;

  /** A still-fresh answer to an earlier search of this prefix, without a read. */
  function cached(prefix: string): readonly CustomEmoji[] | undefined {
    const text = catalogSearchText(prefix);
    const hit = text === undefined ? undefined : prefixes.get(text);
    if (!text || !hit || now() - hit.at >= PREFIX_CACHE_TTL_MS)
      return undefined;
    prefixes.delete(text);
    prefixes.set(text, hit);
    remember(hit.entries);
    return hit.entries;
  }

  /** Entries whose shortcode has the typed prefix as a word prefix, relevance first.
   * Resolves empty only when nothing matched or the prefix is not searchable;
   * every failure rejects, and a failure pauses further searches until retried. */
  async function search(
    prefix: string,
    { signal, retry = false }: EmojiSearchOptions = {},
  ): Promise<readonly CustomEmoji[]> {
    if (closed) throw cancelled();
    const text = catalogSearchText(prefix);
    if (!text) return [];
    const hit = cached(prefix);
    if (hit) return hit;
    if (retry) failedAt = undefined;
    else if (failedAt !== undefined && now() - failedAt < FAILURE_COOLDOWN_MS)
      throw new Error("Community emoji search unavailable");
    const owned = lifetime(signal);
    try {
      const events = await reader.read(
        [
          {
            kinds: [EMOJI_ENTRY_KIND],
            search: text,
            search_mode: "prefix",
            limit: EMOJI_SEARCH_LIMIT,
          },
        ],
        { signal: owned, priority: "foreground" },
      );
      owned.throwIfAborted();
      const entries = collapseCatalog(events).slice(0, EMOJI_SEARCH_LIMIT);
      failedAt = undefined;
      prefixes.set(text, { at: now(), entries });
      for (const key of prefixes.keys()) {
        if (prefixes.size <= PREFIX_CACHE_MAX) break;
        prefixes.delete(key);
      }
      remember(entries);
      return entries;
    } catch (error) {
      if (!owned.aborted && readErrorKind(error) !== "cancelled")
        failedAt = now();
      throw error;
    }
  }

  function clear() {
    epoch.abort();
    epoch = new AbortController();
    prefixes.clear();
    known.clear();
    failedAt = undefined;
  }
  return {
    search,
    cached,
    /** Catalog emoji already read from the relay this session, newest last. */
    known: (): readonly CustomEmoji[] => [...known.values()],
    clear,
    dispose() {
      closed = true;
      clear();
    },
  };
}
