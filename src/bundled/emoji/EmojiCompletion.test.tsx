// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type {
  CompletionResult,
  ComposerCompletionProps,
} from "../../features/conversation/contracts";
import type { CustomEmoji } from "../../features/relay/emoji";
import type { EmojiSearchOptions } from "../../features/relay/emoji-catalog";
import { EMOJI_SEARCH_DEBOUNCE_MS, EmojiCompletion } from "./EmojiCompletion";
import { searchEmoji } from "./emoji-search";

const party = { shortcode: "party_parrot", url: "https://emoji.test/p.png" };
const legacy = { shortcode: "party_hat", url: "https://emoji.test/h.png" };

beforeAll(async () => {
  await searchEmoji("smile", []);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fixture({
  search,
  known,
  entries = [],
}: {
  search?: (
    prefix: string,
    options?: EmojiSearchOptions,
  ) => Promise<readonly CustomEmoji[]>;
  known?: () => readonly CustomEmoji[];
  entries?: readonly CustomEmoji[];
} = {}) {
  vi.useFakeTimers();
  const catalog = { status: "ready" as const, entries };
  let result: CompletionResult | undefined;
  const session = {
    media: (url: string) => url,
    emoji: {
      snapshot: () => catalog,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
      ...(search ? { search: vi.fn(search) } : {}),
      ...(known ? { known } : {}),
    },
  };
  const publish = vi.fn((next: CompletionResult) => {
    result = next;
    return () => {
      if (result === next) result = undefined;
    };
  });
  const props = (query: string) =>
    ({
      session,
      query: { start: 0, end: query.length + 1, query },
      publish,
    }) as unknown as ComposerCompletionProps;
  const view = render(<EmojiCompletion {...props("")} />);
  const show = (query: string) =>
    view.rerender(<EmojiCompletion {...props(query)} />);
  const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
  return {
    session,
    show,
    settle,
    unmount: view.unmount,
    result: () => {
      if (!result) throw new Error("Nothing published");
      return result;
    },
    labels: () =>
      result?.items
        .filter((item) => item.id.startsWith("custom/"))
        .map((item) => item.label),
  };
}

it("searches the relay after a pause, merges what it finds, and gates exact replacement on it", async () => {
  let release!: () => void;
  const h = fixture({
    entries: [legacy],
    search: () =>
      new Promise((resolve) => {
        release = () =>
          resolve([party, { ...legacy, url: "https://relay.test/x" }]);
      }),
  });
  h.show("par");
  await h.settle();
  expect(h.labels()).toEqual([":party_hat:"]);
  h.show("part");
  await act(() => vi.advanceTimersByTimeAsync(EMOJI_SEARCH_DEBOUNCE_MS - 1));
  expect(h.session.emoji.search).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(h.session.emoji.search).toHaveBeenCalledTimes(1);
  expect(h.session.emoji.search).toHaveBeenCalledWith("part", {
    signal: expect.any(AbortSignal),
    retry: false,
  });
  expect(h.result().spaceId).toBeUndefined();
  await act(async () => release());
  await h.settle();
  expect(h.labels()).toEqual([":party_hat:", ":party_parrot:"]);
  const hat = h.result().items.find((item) => item.id === "custom/party_hat");
  expect(hat?.edit).toEqual({ text: ":party_hat:" });
  const preview = hat?.preview as ReactElement<{ emoji: CustomEmoji }>;
  expect(preview.props.emoji).toEqual(legacy);

  h.show("smile");
  await h.settle();
  expect(h.result().spaceId).toBeUndefined();
  await act(() => vi.advanceTimersByTimeAsync(EMOJI_SEARCH_DEBOUNCE_MS));
  await act(async () => release());
  await h.settle();
  expect(h.result().spaceId).toBe("unicode/smile");
});

it("shows catalog emoji already read at once and cancels a search the next keystroke replaces", async () => {
  const signals: AbortSignal[] = [];
  const h = fixture({
    known: () => [party],
    search: (_prefix, options) => {
      if (options?.signal) signals.push(options.signal);
      return new Promise(() => {});
    },
  });
  h.show("parro");
  await h.settle();
  expect(h.labels()).toEqual([":party_parrot:"]);
  await act(() => vi.advanceTimersByTimeAsync(EMOJI_SEARCH_DEBOUNCE_MS));
  h.show("parrot");
  expect(signals[0]?.aborted).toBe(true);
  h.unmount();
  await act(() => vi.advanceTimersByTimeAsync(EMOJI_SEARCH_DEBOUNCE_MS * 2));
  expect(h.session.emoji.search).toHaveBeenCalledTimes(1);
});

it("keeps loaded emoji, says the search failed and retries on request", async () => {
  let fail = true;
  const h = fixture({
    entries: [legacy],
    search: async () => {
      if (fail) throw new Error("down");
      return [party];
    },
  });
  h.show("part");
  await act(() => vi.advanceTimersByTimeAsync(EMOJI_SEARCH_DEBOUNCE_MS));
  expect(h.labels()).toEqual([":party_hat:"]);
  expect(h.result().status).toBe(
    "Community emoji search unavailable; showing loaded emoji.",
  );
  expect(h.result().spaceId).toBeUndefined();
  fail = false;
  await act(async () => h.result().retry?.());
  await act(() => vi.advanceTimersByTimeAsync(EMOJI_SEARCH_DEBOUNCE_MS));
  expect(h.session.emoji.search).toHaveBeenLastCalledWith("part", {
    signal: expect.any(AbortSignal),
    retry: true,
  });
  expect(h.labels()).toEqual([":party_hat:", ":party_parrot:"]);
  expect(h.result().status).toBeUndefined();
});

it("does not wait for the relay when it cannot hold the name or the host cannot search", async () => {
  const h = fixture({ search: async () => [] });
  h.show("+1");
  await h.settle();
  expect(h.result().spaceId).toBe("unicode/+1");
  await act(() => vi.advanceTimersByTimeAsync(EMOJI_SEARCH_DEBOUNCE_MS * 2));
  expect(h.session.emoji.search).not.toHaveBeenCalled();
  h.unmount();

  const detached = fixture();
  detached.show("smile");
  await detached.settle();
  expect(detached.result().spaceId).toBe("unicode/smile");
});
