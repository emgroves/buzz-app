// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { BuzzClient } from "../../buzz-mcp/client";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { GitHubCli } from "./gh";
import { addPullStateTool } from "./pull-state-tool";
import { createPullStates } from "./pull-states";
import { gitHubPulls } from "./service";

const pull = "https://github.com/block/buzz-app/pull/7";
const second = "https://github.com/block/buzz/pull/9";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
  expect(github.prState(pull)).toBeUndefined();
  expect(
    github.prState("https://github.com/block/buzz-app/issues/7"),
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
  expect(github.prState(pull)?.state).toBe("merged");
  // The same pull request, however its link is written.
  expect(
    github.prState("https://github.com/Block/Buzz-App/pull/7/files")?.state,
  ).toBe("merged");
  expect(github.prState(second)?.state).toBe("draft");

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
  expect(github.prState(pull)?.state).toBe("merged");

  // With the link gone, observing does not keep the pull request polled.
  unwatch();
  const reads = gh.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(gh.mock.calls.length).toBe(reads);
});

it("keeps reading, and telling the other observers, when one observer throws", async () => {
  const reported = vi.fn();
  vi.stubGlobal("reportError", reported);
  const gh = vi.fn(async () => ({
    r0: rollup("MERGED"),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  const github = gitHubPulls(states);
  const failure = new Error("observer failed");
  github.subscribe(() => {
    throw failure;
  });
  const after = vi.fn();
  github.subscribe(after);
  const watched = vi.fn();
  const unwatch = states.watch(pull, watched);
  await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
  expect(watched).toHaveBeenCalledOnce();
  expect(reported).toHaveBeenCalledWith(failure);
  expect(github.prState(pull)?.state).toBe("merged");
  expect(states.readAt(pull)?.error).toBeUndefined();
  unwatch();
});

it("answers as the agent tool github_pr_state does, without reading again", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let fail = false;
  const gh = vi.fn(async () => {
    if (fail) throw new Error("socket hang up");
    return {
      r0: {
        pullRequest: {
          state: "OPEN",
          isDraft: false,
          mergeStateStatus: "DIRTY",
          headRefOid: "abc123",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: "FAILURE",
                    contexts: {
                      totalCount: 1,
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "unit",
                          status: "COMPLETED",
                          conclusion: "FAILURE",
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };
  }) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const states = createPullStates(gh);
  const github = gitHubPulls(states);
  const tools: AddedTool[] = [];
  addPullStateTool({ addTool: (tool) => tools.push(tool) }, states);
  const tool = tools[0] as AddedTool;
  const ask = async (args: Record<string, unknown>) =>
    JSON.parse(
      String(await tool.call({} as BuzzClient, { channel: "c" }, args)),
    );

  const unwatch = states.watch(pull, () => {});
  await vi.waitFor(() => expect(states.get(pull)).toBeDefined());
  const readAt = states.readAt(pull)?.readAt ?? 0;
  vi.setSystemTime(readAt + 12_000);
  const report = github.prState(pull);
  expect(report).toMatchObject({
    state: "open",
    checks: "failure",
    failed: ["unit"],
    conflicts: true,
    head: "abc123",
    age_seconds: 12,
    source: "gh",
  });
  // The tool answers the same from the same read, within its minute.
  expect(JSON.parse(JSON.stringify(report))).toEqual(await ask({ url: pull }));
  // Details nobody read are not there, and asking for them reads nothing.
  expect(github.prState(pull, { details: true })).not.toHaveProperty("details");
  expect(gh).toHaveBeenCalledOnce();

  // When reading it again fails, both give the last state and why.
  fail = true;
  vi.setSystemTime(readAt + 120_000);
  const stale = await ask({ url: pull });
  expect(stale.last_read_failed).toBe("socket hang up");
  expect(JSON.parse(JSON.stringify(github.prState(pull)))).toEqual(stale);
  unwatch();
});
