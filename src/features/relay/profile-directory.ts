import { createVerifiedProfileDirectory } from "./verified-profile-directory";
import type {
  VerifiedProfileAuthority,
  VerifiedProfileFilter,
  VerifiedProfileSink,
} from "./verified-profile";
import { retryRead } from "./read-retry";
import { attestedOwner } from "../agents/owner-attestation";
import { hasEventProof } from "./events";
import type { Outbox } from "./outbox";
import { ByteLru } from "./budget";
import type { Profile } from "./contracts";
import type { RelayEvent } from "./events";
import { newer } from "./events";
import { foldProfiles } from "./profiles";
import type { Priority, RelayReader } from "./reader";

/** Shared profile reads for any feature, independent of channel history. */
export interface ProfileQueries {
  snapshot(): ReadonlyMap<string, Profile>;
  subscribe(listener: () => void): () => void;
  /** Fetch missing profiles; optional enrichment can yield to conversation reads. */
  ensure(ids: readonly string[], priority?: Priority): Promise<void>;
  /** The winning signed kind 0 retained for one identity, for provenance checks. */
  event?(pubkey: string): RelayEvent | undefined;
  /** Identities a completed read found no profile for, until one arrives. */
  unnamed?(): ReadonlySet<string>;
  /** Cryptographically verified owner of the retained signed profile head. */
  owner?(pubkey: string): string | undefined;
}

/** Authors per profile read, the reader's largest page. A page that fills it
 * may have left out authors who do have a profile. */
const PROFILE_PAGE = 500;

/** One bounded source of signed profile events. Display values are derived from it. */
export function createProfileDirectory(
  reader: RelayReader,
  local?: Pick<Outbox, "snapshot" | "subscribe">,
  notify = (listener: () => void) => listener(),
  verification?: {
    authority?: VerifiedProfileAuthority | undefined;
    refresh?:
      | ((signal: AbortSignal) => Promise<VerifiedProfileAuthority | null>)
      | undefined;
    subscribe(
      filter: VerifiedProfileFilter,
      sink: VerifiedProfileSink,
    ): (() => void) | undefined;
  },
) {
  const events = new ByteLru<RelayEvent>(1024, 2 * 1024 * 1024);
  const owners = new WeakMap<RelayEvent, string>();
  const pending = new Map<
    string,
    {
      work: Promise<void>;
      authors: string[];
      priority: Priority;
      reading: boolean;
    }
  >();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyMap<string, Profile> = new Map();
  // Replaced, never mutated, so stores can compare it like `snapshot`.
  let unnamed: ReadonlySet<string> = new Set();
  // Absences this connection has read. Background enrichment does not
  // reread them: the live profiles route delivers a later kind 0.
  const absent = new Set<string>();
  // Keys with kind-0 metadata. A verified-only overlay must not satisfy ensure.
  let loaded: ReadonlySet<string> = new Set();
  let controller = new AbortController();
  let closed = false;
  const verified =
    verification &&
    createVerifiedProfileDirectory(
      verification.authority,
      verification.subscribe,
      () => publish(),
      verification.refresh,
    );
  function accept(incoming: readonly RelayEvent[]) {
    if (closed) return;
    let changed = false;
    const attested: Promise<boolean>[] = [];
    for (const event of incoming) {
      if (event.kind !== 0) continue;
      const previous = events.peek(event.pubkey);
      if (newer(previous, event) === previous) continue;
      events.set(event.pubkey, event);
      if (hasEventProof(event))
        attested.push(
          attestedOwner(event).then((owner) => {
            if (closed || events.peek(event.pubkey) !== event || !owner)
              return false;
            owners.set(event, owner);
            return true;
          }),
        );
      changed = true;
    }
    if (changed) publish(true);
    // One notification per batch: every publish refolds all profiles, and
    // listeners refold every cached channel.
    if (attested.length)
      void Promise.all(attested).then((settled) => {
        if (!closed && settled.some(Boolean)) publish(true);
      });
  }
  /** Notifies on display changes, and on winning-event changes for `event()` readers. */
  function publish(headChanged = false) {
    const next = foldProfiles([
      ...events.keys().flatMap((id) => {
        const event = events.peek(id);
        return event ? [event] : [];
      }),
      ...((closed ? undefined : local)
        ?.snapshot()
        .filter((item) => item.event.kind === 0 && item.delivery !== "failed")
        .map((item) => item.event) ?? []),
    ]);
    loaded = new Set(next.keys());
    for (const [id, value] of verified?.snapshot() ?? []) {
      const { nameIsFallback: _fallback, ...base } = next.get(id) ?? {};
      next.set(
        id,
        Object.freeze({
          ...base,
          name: value.displayName,
          username: value.username,
          verified: value,
        }),
      );
    }
    // Qualify all namesakes in the shared directory, including self-declared
    // names that imitate a verified name. This carries through string consumers.
    const assertions = [...next].filter(([, profile]) => profile.verified);
    for (const [id, profile] of next) {
      const duplicate = assertions.some(
        ([other, value]) =>
          other !== id &&
          ((profile.verified?.displayName ?? profile.name) ===
            value.verified?.displayName ||
            (!!profile.verified && profile.username === value.username)),
      );
      if (duplicate)
        next.set(
          id,
          Object.freeze({
            ...profile,
            name: `${profile.name} (${id.slice(0, 10)})`,
          }),
        );
    }
    for (const [id, value] of next) {
      const old = snapshot.get(id);
      if (
        old?.name === value.name &&
        old?.nameIsFallback === value.nameIsFallback &&
        old?.username === value.username &&
        old?.picture === value.picture &&
        old?.about === value.about &&
        old?.nip05 === value.nip05 &&
        old?.isAgent === value.isAgent &&
        old?.ownerPubkey === value.ownerPubkey &&
        JSON.stringify(old?.verified) === JSON.stringify(value.verified)
      )
        next.set(id, old);
    }
    if (
      next.size !== snapshot.size ||
      [...next].some(([id, value]) => snapshot.get(id) !== value)
    ) {
      snapshot = next;
      if ([...unnamed].some((id) => next.has(id)))
        unnamed = new Set([...unnamed].filter((id) => !next.has(id)));
    } else if (!headChanged) return;
    for (const listener of listeners) notify(listener);
  }
  /** A completed read that returned no kind 0 is evidence too: the identity is known unnamed. */
  function missed(ids: readonly string[]) {
    for (const id of ids) if (!loaded.has(id)) absent.add(id);
    for (const id of absent) {
      if (absent.size <= 1024) break;
      absent.delete(id);
    }
    const fresh = ids.filter((id) => !snapshot.has(id) && !unnamed.has(id));
    if (!fresh.length) return;
    unnamed = new Set([...unnamed, ...fresh].slice(-1024));
    for (const listener of listeners) notify(listener);
  }
  async function ensure(
    ids: readonly string[],
    priority: Priority = "foreground",
    refresh = false,
  ) {
    if (closed) throw new DOMException("Session closed", "AbortError");
    const unique = [...new Set(ids)];
    verified?.ensure(unique);
    if (!refresh && unique.length > 1024)
      throw new Error("Profile request exceeds the directory budget");
    const signal = controller.signal;
    const waiting = new Set<Promise<void>>();
    const missing = unique.filter((id) => {
      const batch = pending.get(id);
      if (batch) {
        // Rejoin the equal read so the reader promotes it if still queued;
        // waiting on the old promise alone would leave it behind background work.
        if (priority === "foreground" && batch.priority === "background") {
          batch.priority = priority;
          if (batch.reading)
            void reader
              .read(
                [{ kinds: [0], authors: batch.authors, limit: PROFILE_PAGE }],
                { signal, priority },
              )
              .catch(() => {});
        }
        waiting.add(batch.work);
      }
      return (
        !batch &&
        (refresh ||
          !(loaded.has(id) || (priority === "background" && absent.has(id))))
      );
    });
    for (let offset = 0; offset < missing.length; offset += PROFILE_PAGE) {
      const authors = missing.slice(offset, offset + PROFILE_PAGE);
      let answered = false;
      const batch = {
        authors,
        priority,
        reading: false,
        work: Promise.resolve(),
      };
      batch.work = retryRead(async (signal) => {
        // A promotion during backoff applies to the next attempt instead.
        batch.reading = true;
        try {
          const result = await reader.read(
            [{ kinds: [0], authors, limit: PROFILE_PAGE }],
            { signal, priority: batch.priority },
          );
          answered = true;
          return result;
        } finally {
          batch.reading = false;
        }
      }, signal)
        .then((result) => {
          if (signal.aborted) return;
          accept(result.filter((event) => authors.includes(event.pubkey)));
          // A page at the limit may have left out authors who do have one.
          if (result.length < PROFILE_PAGE) missed(authors);
        })
        .catch((error: unknown) => {
          // The old directory contract silently discards a retired success.
          if (!signal.aborted || !answered) throw error;
        })
        .finally(() => {
          for (const id of authors)
            if (pending.get(id) === batch) pending.delete(id);
        });
      for (const id of authors) pending.set(id, batch);
      waiting.add(batch.work);
    }
    await Promise.all(waiting);
  }
  function clear() {
    controller.abort();
    controller = new AbortController();
    pending.clear();
    absent.clear();
    events.clear();
    verified?.clear();
    const forgot = unnamed.size > 0;
    unnamed = new Set();
    publish(forgot);
  }
  const queries: ProfileQueries = Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure,
    event: (pubkey: string) => events.peek(pubkey),
    unnamed: () => unnamed,
    owner: (pubkey: string) => {
      const event = events.peek(pubkey);
      return event ? owners.get(event) : undefined;
    },
  });
  let localProfiles = "";
  const unsubscribeLocal = local?.subscribe(() => {
    const signature = local
      .snapshot()
      .filter((item) => item.event.kind === 0 && item.delivery !== "failed")
      .map((item) => item.event.id)
      .join(":");
    if (signature === localProfiles) return;
    localProfiles = signature;
    publish();
  });
  publish();
  return {
    queries,
    ensure,
    accept,
    clear,
    connected(value: boolean) {
      verified?.connected(value);
    },
    reconnect() {
      verified?.connected(true);
      // Keep winning signed heads: a lagging or failed read must not roll them back.
      const ids = [...new Set([...events.keys(), ...pending.keys()])];
      controller.abort();
      controller = new AbortController();
      pending.clear();
      // A kind 0 published while offline was not delivered live.
      absent.clear();
      return ensure(ids, "background", true);
    },
    event: (id: string) => events.peek(id),
    stats: () => events.stats(),
    dispose() {
      closed = true;
      verified?.dispose();
      unsubscribeLocal?.();
      clear();
      listeners.clear();
    },
  };
}
export type ProfileDirectory = ReturnType<typeof createProfileDirectory>;
