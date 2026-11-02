import { afterEach, expect, it, vi } from "vitest";
import { getEventHash, verifyEvent, verifiedSymbol } from "nostr-tools";
import { createEventVerifier, eventDto } from "./events";
import { connectBrokerTransport, connectSignedTransport } from "./transport";
import { hostSigner, keypair, signed } from "./testing";
import { ByteLru } from "./budget";

// Count the actual dependency verifier; never replace its cryptographic result.
vi.mock("nostr-tools", async (original) => {
  const actual = await original<typeof import("nostr-tools")>();
  return { ...actual, verifyEvent: vi.fn(actual.verifyEvent) };
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const key = keypair();
const other = keypair();
const event = signed(key, { kind: 9, content: "original", tags: [["h", "a"]] });
const wire = () => JSON.parse(JSON.stringify(event));

it("reuses only its own proof while returning newly owned, frozen wire fields", () => {
  const verify = createEventVerifier();
  const first = verify(event); // even a genuine incoming verifiedSymbol is ignored
  const raw = wire();
  raw[verifiedSymbol] = false;
  raw.extra = "not retained";
  const second = verify(raw);
  expect(verifyEvent).toHaveBeenCalledTimes(1);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(second.tags).not.toBe(first.tags);
  expect(second[verifiedSymbol]).toBe(true);
  expect(second).not.toHaveProperty("extra");
  raw.tags[0].push("changed");
  expect(second.tags).toEqual([["h", "a"]]);
  expect(Object.isFrozen(second)).toBe(true);
  expect(Object.isFrozen(second.tags)).toBe(true);
  expect(Object.isFrozen(second.tags[0])).toBe(true);
  createEventVerifier()(wire()); // another connection has no proof
  eventDto(wire()); // uncached boundary remains uncached
  eventDto(wire());
  expect(verifyEvent).toHaveBeenCalledTimes(4);
});

it("rehashes every signed field on a proof hit and rejects forged markers and IDs", () => {
  const verify = createEventVerifier();
  verify(wire());
  for (const patch of [
    { content: "tampered" },
    { pubkey: other.pubkey },
    { created_at: event.created_at + 1 },
    { kind: 1 },
    { tags: [["h", "b"]] },
    { tags: [["h", "a", "extra"]] },
    { sig: "0".repeat(128) },
    { id: "0".repeat(64) },
  ]) {
    expect(() =>
      verify({ ...wire(), ...patch, [verifiedSymbol]: true }),
    ).toThrow(/malformed/);
  }
  const changed = { ...wire(), content: "new hash with old signature" };
  changed.id = getEventHash(changed);
  expect(() => verify(changed)).toThrow(/malformed/);
  expect(verify(wire()).id).toBe(event.id); // failed input cannot poison valid proof
});

it("still validates envelope values on hits and never memoizes a failure", () => {
  const verify = createEventVerifier();
  verify(wire());
  for (const patch of [
    { created_at: Infinity },
    { created_at: 1.5 },
    { kind: 65536 },
    { pubkey: event.pubkey.toUpperCase() },
    { sig: event.sig.toUpperCase() },
    { content: null },
    { tags: [["h", 1]] },
  ])
    expect(() => verify({ ...wire(), ...patch })).toThrow(/malformed/);
  const bad = { ...wire(), sig: "0".repeat(128), [verifiedSymbol]: true };
  vi.mocked(verifyEvent).mockClear();
  expect(() => verify(bad)).toThrow();
  expect(() => verify(bad)).toThrow();
  expect(verifyEvent).toHaveBeenCalledTimes(2);
  expect(verify(wire()).id).toBe(event.id);
  expect(verifyEvent).toHaveBeenCalledTimes(2);
});

it("a different valid signature for the same event ID earns a new proof", () => {
  const verify = createEventVerifier();
  const alternate = signed(key, {
    kind: event.kind,
    created_at: event.created_at,
    content: event.content,
    tags: event.tags,
  });
  expect(alternate.id).toBe(event.id);
  expect(alternate.sig).not.toBe(event.sig);
  verify(wire());
  verify(alternate);
  expect(verifyEvent).toHaveBeenCalledTimes(2);
  verify(JSON.parse(JSON.stringify(alternate)));
  expect(verifyEvent).toHaveBeenCalledTimes(2);
  verify(wire()); // only one signature is retained per ID
  expect(verifyEvent).toHaveBeenCalledTimes(3);
});

it("evicts the oldest proof at the fixed 8192-entry bound and re-verifies it", () => {
  // Observe the real memo populated by cryptographic verification, then fill its
  // remaining slots directly. Cache pressure needs opaque entries, not thousands
  // of signatures generated and verified inside one runner deadline.
  const writes = vi.spyOn(ByteLru.prototype, "set");
  const verify = createEventVerifier();
  verify(wire());
  const memo = writes.mock.contexts[0] as ByteLru<string>;
  writes.mockRestore();
  expect(memo.maxEntries).toBe(8192);
  expect(memo.maxBytes).toBe(8192 * 192);
  for (let i = 0; i < 8191; i++) memo.set(`filler:${i}`, "opaque", 192);
  expect(memo.stats()).toEqual({ entries: 8192, bytes: 8192 * 192 });
  expect(memo.peek(event.id)).toBe(event.sig);

  const newest = signed(key, { kind: 9, content: "newest", tags: [] });
  verify(newest);
  expect(memo.stats()).toEqual({ entries: 8192, bytes: 8192 * 192 });
  expect(memo.peek(event.id)).toBeUndefined();
  expect(verifyEvent).toHaveBeenCalledTimes(2);
  verify(newest);
  expect(verifyEvent).toHaveBeenCalledTimes(2);
  verify(wire());
  expect(verifyEvent).toHaveBeenCalledTimes(3);
  expect(memo.peek(event.id)).toBe(event.sig);
});

it.each(["broker", "signed"])(
  "%s HTTP queries keep fresh reads, reject changed warm bytes and isolate proofs",
  async (mode) => {
    let payload: unknown = wire();
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith("/session")
        ? Response.json({ viewer: key.pubkey, relayAuthor: key.pubkey })
        : Response.json([payload, payload]),
    );
    vi.stubGlobal("fetch", fetcher);
    const connect = () =>
      mode === "broker"
        ? connectBrokerTransport()
        : connectSignedTransport(
            hostSigner(key),
            "https://proof.test",
            key.pubkey,
          );
    const first = await connect();
    const filters = [{ kinds: [9], "#h": ["a"], limit: 2 }];
    expect(await first.query(filters)).toHaveLength(2);
    expect(await first.query(filters)).toHaveLength(2);
    expect(verifyEvent).toHaveBeenCalledTimes(1);
    payload = { ...wire(), content: "corrupted after cold read" };
    await expect(first.query(filters)).rejects.toThrow(/malformed/);
    payload = { ...wire(), sig: "0".repeat(128) };
    await expect(first.query(filters)).rejects.toThrow(/malformed/);
    payload = wire();
    vi.mocked(verifyEvent).mockClear();
    expect(await first.query(filters)).toHaveLength(2);
    expect(verifyEvent).not.toHaveBeenCalled();
    const second = await connect();
    expect(await second.query(filters)).toHaveLength(2);
    expect(verifyEvent).toHaveBeenCalledTimes(1);
    expect(
      fetcher.mock.calls.filter(([url]) => url.endsWith("/query")),
    ).toHaveLength(6);
    const aborted = new AbortController();
    aborted.abort();
    await expect(first.query(filters, aborted.signal)).rejects.toThrow();
  },
);
