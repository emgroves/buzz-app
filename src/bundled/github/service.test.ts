// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { GitHubCli } from "./gh";
import { createPullStates } from "./pull-states";
import { gitHubPulls } from "./service";

const pull = "https://github.com/block/buzz-app/pull/7";
const second = "https://github.com/block/buzz/pull/9";

afterEach(() => {
  vi.useRealTimers();
});

const rollup = (state: string, isDraft = false) => ({
  pullRequest: {
    state,
    isDraft,
    mergeStateStatus: "CLEAN",
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  },
});

it("gives other plugins the states links read, and never reads GitHub itself", async () => {
  const gh = vi.fn(async () => ({
    r0: rollup("MERGED"),
    r1: rollup("OPEN", true),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  const github = gitHubPulls(states);
  const heard = vi.fn();
  const stop = github.subscribe(heard);

  // Asking about a pull request nobody shows reads nothing.
  expect(github.pullState(pull)).toBeUndefined();
  expect(
    github.pullState("https://github.com/block/buzz-app/issues/7"),
  ).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(gh).not.toHaveBeenCalled();
  expect(heard).not.toHaveBeenCalled();

  // A link shown in a message reads both; the observer hears of it.
  const unwatch = [
    states.watch(pull, () => {}),
    states.watch(second, () => {}),
  ];
  await vi.waitFor(() => expect(heard).toHaveBeenCalled());
  expect(gh).toHaveBeenCalledOnce();
  expect(github.pullState(pull)).toBe("merged");
  // The same pull request, however its link is written.
  expect(
    github.pullState("https://github.com/Block/Buzz-App/pull/7/files"),
  ).toBe("merged");
  expect(github.pullState(second)).toBe("draft");

  stop();
  for (const end of unwatch) end();
  expect(Object.isFrozen(github)).toBe(true);
});

it("stops telling an observer once it unsubscribes, and an observer alone keeps nothing read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let state = "OPEN";
  const gh = vi.fn(async () => ({
    r0: rollup(state),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  const github = gitHubPulls(states);
  const kept = vi.fn();
  const left = vi.fn();
  github.subscribe(kept);
  const stop = github.subscribe(left);
  const unwatch = states.watch(pull, () => {});
  await vi.waitFor(() => expect(kept).toHaveBeenCalledOnce());
  expect(left).toHaveBeenCalledOnce();
  stop();

  state = "MERGED";
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(kept).toHaveBeenCalledTimes(2));
  expect(left).toHaveBeenCalledOnce();
  expect(github.pullState(pull)).toBe("merged");

  // With the link gone, observing does not keep the pull request polled.
  unwatch();
  const reads = gh.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(gh.mock.calls.length).toBe(reads);
});
