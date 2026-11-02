import {
  getEventHash,
  verifyEvent,
  verifiedSymbol,
  type Event,
  type VerifiedEvent,
} from "nostr-tools";
import { ByteLru } from "./budget.ts";
/** A relay event whose signature has been verified at the transport boundary. */
export type RelayEvent = VerifiedEvent;
/** Event payload shared by locally authored intent and verified relay records.
 * Only RelayEvent carries signature verification; local intent never establishes relay authority. */
export type EventData = Readonly<
  Pick<RelayEvent, "id" | "pubkey" | "created_at" | "kind" | "content" | "tags">
>;
export type ReadFilter = Readonly<{
  kinds?: readonly number[];
  ids?: readonly string[];
  /** NIP-01 single-letter tag filters, including references (#e/#a) and topics (#t). */
  [tag: `#${string}`]: readonly string[] | undefined;
  limit: number;
  authors?: readonly string[];
  /** Read from the writer when resolving uncertain publication or admission. */
  consistency?: "strong";
  /** NIP-AR artifact reads: current heads only, or a `d`'s revision history. */
  artifact?: "current" | "history";
  /** NIP-AR artifact page offset (≤ 10,000). */
  offset?: number;
  until?: number;
  since?: number;
  "#h"?: readonly string[];
  "#d"?: readonly string[];
  "#p"?: readonly string[];
  /** Buzz relay extensions for channel history windows. */
  top_level?: boolean;
  include_aux?: boolean;
  include_summaries?: boolean;
  before_id?: string;
  /** HTTP bridge finite search, home-feed, and thread traversal extensions. */
  search?: string;
  search_mode?: "prefix" | "fulltext";
  /** Only for relays advertising `buzz-search-sort`. */
  search_sort?: "newest";
  page?: number;
  feed_types?: readonly string[];
  thread_window?: boolean;
  depth_limit?: number;
  thread_cursor?: number;
  thread_cursor_id?: string;
}>;
// Identity-only evidence for immutable records owned by this admission boundary.
// Neither a caller-provided nostr-tools symbol nor a copied record is proof.
const admitted = new WeakSet<object>();
export function hasEventProof(event: EventData): boolean {
  return admitted.has(event);
}

export function eventDto(value: unknown): RelayEvent {
  return checkedEvent(value, verifyEvent);
}

/** A whole query response; one bad event rejects it, as relay reads do. */
export function eventsDto(value: unknown): RelayEvent[] {
  if (!Array.isArray(value))
    throw new Error("Relay response is not an event array");
  return value.map(eventDto);
}

/** One HTTP connection's bounded proof memo, not an event/result cache. Only a
 * matching content hash AND exact signature can reuse a successful verification.
 * Retains no payload, authorization, freshness or caller-supplied proof symbols. */
export function createEventVerifier() {
  // Idle sessions periodically re-read the same events. An LRU smaller than that
  // working set misses on every in-order re-read, so keep it well above it.
  const proofs = new ByteLru<string>(8192, 8192 * 192);
  return (value: unknown): RelayEvent =>
    checkedEvent(value, (event): event is VerifiedEvent => {
      if (
        proofs.get(event.id) === event.sig &&
        getEventHash(event) === event.id
      ) {
        event[verifiedSymbol] = true;
        return true;
      }
      if (!verifyEvent(event)) return false;
      proofs.set(event.id, event.sig, 192); // fixed ASCII id (64) + signature (128)
      return true;
    });
}

function checkedEvent(
  value: unknown,
  verify: (event: Event) => event is VerifiedEvent,
): RelayEvent {
  const invalid = () =>
    new Error("Relay supplied a malformed or invalidly signed event");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const raw = value as Record<string, unknown>;
  // nostr-tools validates only typeof number here. JSON overflow becomes Infinity
  // and hashes as null; fractions/unsafe integers cannot be protocol timestamps.
  if (
    typeof raw.created_at !== "number" ||
    !Number.isSafeInteger(raw.created_at) ||
    raw.created_at < 0 ||
    typeof raw.kind !== "number" ||
    !Number.isInteger(raw.kind) ||
    raw.kind < 0 ||
    raw.kind > 65535 ||
    typeof raw.id !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.id) ||
    typeof raw.pubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.pubkey) ||
    typeof raw.sig !== "string" ||
    !/^[0-9a-f]{128}$/.test(raw.sig) ||
    typeof raw.content !== "string" ||
    !Array.isArray(raw.tags) ||
    raw.tags.some(
      (tag) =>
        !Array.isArray(tag) || tag.some((item) => typeof item !== "string"),
    )
  )
    throw invalid();
  // Copy only wire fields before verification. Never trust a cached verification
  // symbol from a caller-owned object whose signed bytes may have changed.
  const owned = {
    id: raw.id,
    pubkey: raw.pubkey,
    sig: raw.sig,
    created_at: raw.created_at,
    kind: raw.kind,
    content: raw.content,
    tags: raw.tags.map((tag: string[]) => [...tag]),
  };
  if (!verify(owned)) throw invalid();
  for (const tag of owned.tags) Object.freeze(tag);
  Object.freeze(owned.tags);
  Object.freeze(owned);
  admitted.add(owned);
  return owned;
}

export const tag = (event: RelayEvent, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];
export const hasTag = (event: RelayEvent, name: string, value: string) =>
  event.tags.some((entry) => entry[0] === name && entry[1] === value);

/** Later created_at wins; ties break on lower id so replay order cannot flip the result. */
export function newer<T extends Pick<EventData, "created_at" | "id">>(
  current: T | undefined,
  candidate: T,
): T {
  return !current ||
    candidate.created_at > current.created_at ||
    (candidate.created_at === current.created_at && candidate.id < current.id)
    ? candidate
    : current;
}
