import { afterEach, expect, it, vi } from "vitest";
import {
  EMOJI_ENTRY_KIND,
  EMOJI_SEARCH_LIMIT,
  catalogSearchText,
  collapseCatalog,
  createEmojiCatalog,
  mergeEmoji,
} from "./emoji-catalog";
import { createEmojiDirectory } from "./emoji-directory";
import { ReadError } from "./errors";
import type { RelayEvent } from "./events";
import type { ReadOptions } from "./reader";
import { keypair, signed } from "./testing";

const alice = keypair();
const bob = keypair();
const png = (name: string) => `https://emoji.test/${name}.png`;

function entry(
  shortcode: string,
  url = png(shortcode),
  { key = alice, at = 100, extra = [] as string[][] } = {},
) {
  return signed(key, {
    kind: EMOJI_ENTRY_KIND,
    created_at: at,
    content: shortcode.replace(/[_-]+/g, " "),
    tags: [["d", shortcode], ["emoji", shortcode, url], ...extra],
  });
}
type Read = (
  filters: readonly { [key: string]: unknown }[],
  options?: ReadOptions,
) => Promise<readonly RelayEvent[]>;
function relay(read: Read = async () => []) {
  const reader = { read: vi.fn(read) };
  return reader;
}
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function catalog(reader = relay(), now = () => 0) {
  const made = createEmojiCatalog(reader, now);
  owners.push(made);
  return made;
}

it.each([
  ["party", "party"],
  ["Party_Parrot", "party parrot"],
  [":sad-parrot", "sad parrot"],
  ["party_", "party"],
  ["a", undefined],
  ["a_", undefined],
  ["-1", undefined],
  ["+1", undefined],
  ["no spaces", undefined],
  ["x".repeat(65), undefined],
])("maps the typed prefix %j to relay search text %j", (prefix, text) => {
  expect(catalogSearchText(prefix)).toBe(text);
});

it("keeps only well-formed catalog entries and picks the newest per shortcode", () => {
  const good = entry("party_parrot");
  const events = [
    good,
    signed(alice, {
      kind: 30030,
      created_at: 100,
      content: "",
      tags: [
        ["d", "party"],
        ["emoji", "party", png("party")],
      ],
    }),
    entry("shouty", png("shouty"), { extra: [] }),
    signed(alice, {
      kind: EMOJI_ENTRY_KIND,
      created_at: 100,
      content: "",
      tags: [
        ["d", "Shouty"],
        ["emoji", "Shouty", png("shouty")],
      ],
    }),
    signed(alice, {
      kind: EMOJI_ENTRY_KIND,
      created_at: 100,
      content: "",
      tags: [
        ["d", "other"],
        ["emoji", "party_parrot", png("p")],
      ],
    }),
    entry("scheme", "ftp://emoji.test/x.png"),
    entry("long", `https://emoji.test/${"x".repeat(2048)}`),
    entry("scoped", png("scoped"), { extra: [["h", "channel"]] }),
    entry("twice", png("twice"), { extra: [["emoji", "twice", png("t2")]] }),
    entry("pair", png("pair"), { extra: [["d", "pair"]] }),
    entry("older", png("old"), { at: 1 }),
    entry("older", png("new"), { key: bob, at: 2 }),
  ];
  expect(collapseCatalog(events)).toEqual([
    { shortcode: "party_parrot", url: png("party_parrot") },
    { shortcode: "shouty", url: png("shouty") },
    { shortcode: "older", url: png("new") },
  ]);
});

it("breaks a created_at tie with the lowest event id", () => {
  const a = entry("tie", png("a"), { key: alice, at: 5 });
  const b = entry("tie", png("b"), { key: bob, at: 5 });
  const lowest = a.id < b.id ? a : b;
  const url = lowest.tags[1]?.[2];
  expect(collapseCatalog([a, b])[0]?.url).toBe(url);
  expect(collapseCatalog([b, a])[0]?.url).toBe(url);
});

it("merges so the preferred list keeps shared shortcodes", () => {
  const legacy = [{ shortcode: "party", url: "legacy" }];
  const relayed = [
    { shortcode: "party", url: "relay" },
    { shortcode: "parrot", url: "relay" },
  ];
  expect(mergeEmoji(legacy, relayed)).toEqual([
    { shortcode: "party", url: "legacy" },
    { shortcode: "parrot", url: "relay" },
  ]);
  expect(mergeEmoji(legacy, [])).toBe(legacy);
});

it("searches by prefix, caches each prefix briefly and never reports a failure as empty", async () => {
  let time = 0;
  const reader = relay(async () => [entry("party_parrot")]);
  const emoji = catalog(reader, () => time);
  expect(await emoji.search("parr")).toEqual([
    { shortcode: "party_parrot", url: png("party_parrot") },
  ]);
  expect(reader.read.mock.calls[0]?.[0]).toEqual([
    {
      kinds: [30180],
      search: "parr",
      search_mode: "prefix",
      limit: EMOJI_SEARCH_LIMIT,
    },
  ]);
  await emoji.search("PARR");
  expect(reader.read).toHaveBeenCalledTimes(1);
  expect(emoji.cached("parr")).toHaveLength(1);
  time = 61_000;
  expect(emoji.cached("parr")).toBeUndefined();
  await emoji.search("parr");
  expect(reader.read).toHaveBeenCalledTimes(2);

  expect(await emoji.search("p")).toEqual([]);
  expect(await emoji.search("+1")).toEqual([]);
  expect(reader.read).toHaveBeenCalledTimes(2);

  reader.read.mockRejectedValueOnce(new ReadError("unavailable", "down", 500));
  await expect(emoji.search("sad")).rejects.toThrow("down");
  expect(reader.read).toHaveBeenCalledTimes(3);
  time += 1_000;
  await expect(emoji.search("sad")).rejects.toThrow("unavailable");
  await expect(emoji.search("sadness")).rejects.toThrow("unavailable");
  expect(reader.read).toHaveBeenCalledTimes(3);
  expect(await emoji.search("sad", { retry: true })).toHaveLength(1);
  expect(reader.read).toHaveBeenCalledTimes(4);
  expect(await emoji.search("sadness")).toHaveLength(1);
  expect(reader.read).toHaveBeenCalledTimes(5);

  reader.read.mockRejectedValueOnce(new ReadError("unavailable", "down", 500));
  await expect(emoji.search("again")).rejects.toThrow("down");
  time += 31_000;
  expect(await emoji.search("again")).toHaveLength(1);
});

it("does not count its own cancellation as a failure", async () => {
  const reader = relay(
    (_filters, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("cancelled", "AbortError")),
        ),
      ),
  );
  const emoji = catalog(reader);
  const typing = new AbortController();
  const pending = emoji.search("par", { signal: typing.signal });
  typing.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  reader.read.mockResolvedValueOnce([entry("party")]);
  expect(await emoji.search("pa")).toHaveLength(1);
  const invalidated = relay(async () => {
    throw new DOMException("Relay read cancelled", "AbortError");
  });
  const other = catalog(invalidated);
  await expect(other.search("par")).rejects.toMatchObject({
    name: "AbortError",
  });
  await expect(other.search("par")).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(invalidated.read).toHaveBeenCalledTimes(2);
});

it("bounds what one relay answer and the session retain", async () => {
  const many = Array.from({ length: 120 }, (_, index) =>
    entry(`emoji_${index}`),
  );
  const reader = relay(async () => many);
  const emoji = catalog(reader);
  expect(await emoji.search("emoji")).toHaveLength(EMOJI_SEARCH_LIMIT);
  for (let index = 0; index < 600; index++) {
    reader.read.mockResolvedValueOnce([entry(`bulk_${index}`)]);
    await emoji.search(`bulk${index}`);
  }
  expect(emoji.known()).toHaveLength(500);
  expect(emoji.known().at(-1)?.shortcode).toBe("bulk_599");
  expect(emoji.known().some((item) => item.shortcode === "emoji_0")).toBe(
    false,
  );
});

it("fences a search that a clear overtakes", async () => {
  let release!: () => void;
  const reader = relay(
    () =>
      new Promise((resolve) => {
        release = () => resolve([entry("party")]);
      }),
  );
  const emoji = catalog(reader);
  const pending = emoji.search("par");
  await vi.waitFor(() => expect(reader.read).toHaveBeenCalled());
  emoji.clear();
  release();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(emoji.known()).toEqual([]);
  reader.read.mockResolvedValueOnce([]);
  expect(await emoji.search("par")).toEqual([]);
  expect(reader.read).toHaveBeenCalledTimes(2);
});

it("rejects every lookup after disposal", async () => {
  const emoji = createEmojiCatalog(relay());
  emoji.dispose();
  await expect(emoji.search("party")).rejects.toMatchObject({
    name: "AbortError",
  });
});

it("lets a message use a catalog emoji it has read, with the legacy catalog winning a shared name", async () => {
  const legacy = signed(alice, {
    kind: 30030,
    created_at: 1,
    content: "",
    tags: [
      ["d", "buzz:custom-emoji"],
      ["emoji", "wave", png("legacy-wave")],
    ],
  });
  const reader = relay(async (filters) =>
    filters[0]?.kinds && (filters[0].kinds as number[])[0] === 30030
      ? [legacy]
      : [entry("party_parrot"), entry("wave", png("catalog-wave"))],
  );
  const directory = createEmojiDirectory(reader);
  owners.push(directory);
  await directory.queries.ensure();
  expect(directory.tags(":party_parrot: :wave:")).toEqual([
    ["emoji", "wave", png("legacy-wave")],
  ]);
  await directory.queries.search("par");
  expect(directory.tags(":party_parrot: :wave:")).toEqual([
    ["emoji", "party_parrot", png("party_parrot")],
    ["emoji", "wave", png("legacy-wave")],
  ]);
  directory.clear();
  await directory.queries.ensure();
  expect(directory.tags(":party_parrot:")).toEqual([]);
});

it("serves a fresh prefix from memory and keeps what it offers usable in a message", async () => {
  const reader = relay(async () => [entry("party_parrot")]);
  const directory = createEmojiDirectory(reader);
  owners.push(directory);
  const { queries } = directory;
  await queries.ensure();
  expect(queries.cached("par")).toBeUndefined();
  await queries.search("par");
  for (let batch = 0; batch < 10; batch++) {
    reader.read.mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, index) => entry(`bulk${batch}_${index}`)),
    );
    await queries.search(`bulk${batch}`);
  }
  expect(
    queries.known().some((item) => item.shortcode === "party_parrot"),
  ).toBe(false);
  expect(queries.cached("PAR")).toEqual([
    { shortcode: "party_parrot", url: png("party_parrot") },
  ]);
  expect(directory.tags(":party_parrot:")).toEqual([
    ["emoji", "party_parrot", png("party_parrot")],
  ]);
  expect(queries.cached("p")).toBeUndefined();
});
