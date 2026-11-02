// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ActivityTranscript } from "./ActivityTranscript";
import type { TranscriptTurn } from "./activity-transcript";
import { codexTurns } from "../../bundled/codex/transcript";
import { restoreRecordedTools } from "../../bundled/codex/recorded-tools";
import { formatItemTimestamp } from "../../shared/datetime";

afterEach(cleanup);

it.each([
  ["failed", "Failed"],
  ["terminated", "Terminated"],
])("shows %s script status before opening its output", (status, label) => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [],
      },
    ],
    { channelId: "channel" },
  );
  turns[0]?.items.push({
    id: "script",
    toolCallId: "script",
    at: 1000,
    type: "tool",
    title: "exec",
    kind: "execute",
    status,
    input: "throw new Error('failed')",
    output: `Script ${status}\nOutput:\nError`,
    paths: [],
    diffs: [],
    truncated: false,
  });
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText(label, { exact: true })).toBeVisible();
  expect(
    screen.getByText("exec", { exact: true }).closest("details"),
  ).not.toHaveAttribute("open");
});

it("shows the recorded tool name, highlights tool calls, and keeps script text intact without raw details", async () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [],
      },
    ],
    { channelId: "channel" },
  );
  const script =
    "text(await tools.buzz__channels({all:true}));\ntext(await tools.clock__curr_time({}));";
  restoreRecordedTools(
    turns,
    [
      { type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "script",
          name: "exec",
          input: script,
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "script",
          output: [
            {
              type: "input_text",
              text: "Script completed\nOutput:\nchannel list",
            },
          ],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  );
  const user = userEvent.setup();
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  await user.click(screen.getByText("exec", { exact: true }));
  const channels = screen.getByText("tools.buzz__channels", { exact: true });
  expect(channels).toBeVisible();
  expect(channels).toHaveClass("text-accent");
  expect(
    screen.getByText("tools.clock__curr_time", { exact: true }),
  ).toHaveClass("text-accent");
  expect(channels.closest("pre")?.textContent).toBe(script);
  expect(
    screen.getByText(/^Script completed Output: channel list$/),
  ).toBeVisible();
  expect(screen.queryByText("Raw details")).not.toBeInTheDocument();
});

it("shows a failed nested call on the collapsed script while preserving the script's status", () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [
          {
            type: "commandExecution",
            id: "failed",
            command: "false",
            status: "failed",
            aggregatedOutput: "exit 1",
          },
        ],
      },
    ],
    { channelId: "channel" },
  );
  const turn = turns[0];
  const failed = turn?.items[0];
  if (!turn || failed?.type !== "tool") throw new Error("Missing failed tool");
  turn.items = [
    {
      ...failed,
      id: "script",
      toolCallId: "script",
      title: "exec",
      status: "completed",
      children: [failed],
    },
  ];
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText("· 1 failed call")).toBeVisible();
  const script = screen.getByText("exec", { exact: true }).closest("details");
  expect(script).not.toHaveAttribute("open");
  expect(script).toHaveAttribute("data-status", "completed");
  // The script and its nested call each carry their own time.
  expect(script?.querySelectorAll("time")).toHaveLength(1);
  expect(script?.parentElement?.querySelectorAll("time")).toHaveLength(2);
});

it("discloses tool arguments and results without raw details, including a posted send", async () => {
  const turns = codexTurns(
    [
      {
        id: "t",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        items: [
          {
            type: "dynamicToolCall",
            id: "read",
            namespace: "buzz",
            tool: "read",
            arguments: { limit: 2 },
            status: "completed",
            contentItems: [{ type: "inputText", text: "two messages" }],
            success: true,
          },
          {
            type: "dynamicToolCall",
            id: "send",
            namespace: "buzz",
            tool: "send",
            arguments: { text: "Done" },
            status: "completed",
            contentItems: [{ type: "inputText", text: "sent" }],
            success: true,
          },
        ],
      },
    ],
    { channelId: "channel" },
  );
  const user = userEvent.setup();
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  const tool = screen.getByText("buzz.read").closest("details");
  expect(tool).not.toHaveAttribute("open");
  await user.click(screen.getByText("buzz.read"));
  expect(tool).toHaveAttribute("open");
  expect(screen.getByText('{ "limit": 2 }')).toBeVisible();
  expect(screen.getByText("two messages")).toBeVisible();
  expect(screen.getByText("Done")).toBeVisible();
  expect(screen.queryByText("Raw details")).not.toBeInTheDocument();
});

it("shows each entry's time under it, with the full date on hover, except the prompt", () => {
  const at = Date.UTC(2026, 9, 20, 20, 1, 28);
  const { container } = render(
    <ActivityTranscript
      transcript={{
        turns: [
          {
            turnId: "t",
            startedAt: at,
            endedAt: at + 9000,
            threadRootId: null,
            config: [],
            items: [
              { id: "prompt", at, type: "prompt", text: "hi", sections: [] },
              { id: "thought", at: at + 3000, type: "thought", text: "hmm" },
              { id: "reply", at: at + 70_000, type: "message", text: "done" },
            ],
          } as never,
        ],
      }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  const stamps = [
    ...container.querySelectorAll<HTMLTimeElement>("article > div time"),
  ];
  expect(stamps.map((stamp) => stamp.getAttribute("datetime"))).toEqual([
    new Date(at + 3000).toISOString(),
    new Date(at + 70_000).toISOString(),
  ]);
  for (const stamp of stamps) {
    expect(stamp.previousElementSibling).not.toBeNull();
    expect(stamp.title).toContain("2026");
  }
});

it("shows no time for an entry with a zero, non-finite or invalid time", () => {
  const { container } = render(
    <ActivityTranscript
      transcript={{
        turns: [
          {
            turnId: "t",
            startedAt: 0,
            endedAt: 0,
            threadRootId: null,
            config: [],
            items: [
              { id: "zero", at: 0, type: "thought", text: "a" },
              { id: "inf", at: Infinity, type: "thought", text: "b" },
              { id: "nan", at: NaN, type: "message", text: "c" },
              {
                id: "script",
                at: 0,
                type: "tool",
                title: "exec",
                status: "completed",
                paths: [],
                diffs: [],
                children: [
                  { id: "child", at: 1e20, type: "message", text: "d" },
                ],
              },
            ],
          } as never,
        ],
      }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  expect(container.querySelectorAll("time")).toHaveLength(0);
});

it("dates the turn heading in the shared format, and omits an unknown start", () => {
  const at = Date.UTC(2026, 9, 20, 20, 1, 28);
  const turn = (startedAt: number) =>
    ({
      turnId: `t${startedAt}`,
      startedAt,
      endedAt: startedAt,
      threadRootId: null,
      config: ["gpt-6"],
      items: [],
    }) as never;
  render(
    <ActivityTranscript
      transcript={{ turns: [turn(at), turn(0), turn(NaN)] }}
      agentName="Sol"
      state={() => "ended"}
    />,
  );
  const expected = formatItemTimestamp(at / 1000, { withTime: true });
  expect(screen.getByText(expected, { selector: "time" })).toBeInTheDocument();
  expect(
    screen
      .getAllByRole("article")
      .map((article) => article.querySelector("header")?.textContent),
  ).toEqual([
    `${expected} · Completed · 0.0s · gpt-6`,
    "Status unknown · gpt-6",
    "Status unknown · gpt-6",
  ]);
});

it("keeps different threads distinguishable when showing all conversations", () => {
  const turns: TranscriptTurn[] = ["a".repeat(64), "b".repeat(64)].map(
    (threadRootId, index) => ({
      turnId: `turn-${index}`,
      channelId: "channel",
      threadRootId,
      triggeringEventIds: [],
      newSession: false,
      config: ["gpt-6"],
      startedAt: Date.parse("2026-10-20T12:00:00Z"),
      endedAt: Date.parse("2026-10-20T12:01:00Z"),
      partial: false,
      items: [],
    }),
  );
  render(
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Agent"
      state={() => "ended"}
    />,
  );
  expect(screen.getByText("· Thread aaaaaaaa")).toBeVisible();
  expect(screen.getByText("· Thread bbbbbbbb")).toBeVisible();
  // The place follows the duration and leads the remaining facts.
  expect(
    screen.getAllByRole("article")[0]?.querySelector("header")?.textContent,
  ).toMatch(/Completed · 1m 0s · Thread aaaaaaaa · gpt-6$/);
});

it("opens a turn's thread or channel from its label, keeping thread labels it can't open as text", () => {
  const turn = (
    turnId: string,
    channelId: string | null,
    threadRootId: string | null | undefined,
  ): TranscriptTurn => ({
    turnId,
    channelId,
    threadRootId,
    triggeringEventIds: [],
    newSession: false,
    config: [],
    startedAt: Date.parse("2026-10-20T12:00:00Z"),
    endedAt: Date.parse("2026-10-20T12:01:00Z"),
    partial: false,
    items: [],
  });
  const transcript = {
    turns: [
      turn("thread", "channel", "a".repeat(64)),
      turn("channel", "channel", null),
      // Neither an unknown thread nor a turn without a channel can be opened.
      turn("unknown", "channel", undefined),
      turn("nowhere", null, "b".repeat(64)),
    ],
  };
  const openConversation = vi.fn();
  const view = render(
    <ActivityTranscript
      transcript={transcript}
      agentName="Agent"
      state={() => "ended"}
      openConversation={openConversation}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Thread aaaaaaaa" }));
  expect(openConversation).toHaveBeenLastCalledWith("channel", "a".repeat(64));
  fireEvent.click(screen.getByRole("button", { name: "Channel" }));
  expect(openConversation).toHaveBeenLastCalledWith("channel", undefined);
  expect(screen.getAllByRole("button")).toHaveLength(2);
  expect(screen.getByText("· Thread unknown")).toBeInTheDocument();
  expect(screen.getByText("· Thread bbbbbbbb")).toBeInTheDocument();
  // A host that can't open conversations shows thread labels as text and
  // leaves channel turns unlabelled.
  view.rerender(
    <ActivityTranscript
      transcript={transcript}
      agentName="Agent"
      state={() => "ended"}
    />,
  );
  expect(screen.queryAllByRole("button")).toEqual([]);
  expect(screen.getByText("· Thread aaaaaaaa")).toBeInTheDocument();
  expect(screen.queryByText(/Channel/)).toBeNull();
  expect(openConversation).toHaveBeenCalledTimes(2);
});

it("opens at the latest turn and follows new ones until the reader scrolls up", () => {
  const turn = (id: string, at: number): TranscriptTurn => ({
    turnId: id,
    channelId: "channel",
    threadRootId: null,
    triggeringEventIds: [],
    newSession: false,
    config: [],
    startedAt: at,
    endedAt: at + 1000,
    partial: false,
    items: [],
  });
  let height = 1000;
  const scrolling = () => {
    const view = document.createElement("div");
    view.style.overflowY = "auto";
    Object.defineProperty(view, "scrollHeight", { get: () => height });
    Object.defineProperty(view, "clientHeight", { get: () => 200 });
    return document.body.appendChild(view);
  };
  const view = scrolling();
  const show = (turns: TranscriptTurn[], follow?: boolean) => (
    <ActivityTranscript
      transcript={{ turns }}
      agentName="Sol"
      state={() => "ended"}
      {...(follow === undefined ? {} : { follow })}
    />
  );
  const { rerender, unmount } = render(show([turn("a", 1)]), {
    container: view,
  });
  expect(view.scrollTop).toBe(1000);
  height = 1400;
  rerender(show([turn("a", 1), turn("b", 2)]));
  expect(view.scrollTop).toBe(1400);
  view.scrollTop = 100;
  fireEvent.scroll(view);
  height = 1800;
  rerender(show([turn("a", 1), turn("b", 2), turn("c", 3)]));
  expect(view.scrollTop).toBe(100);
  unmount();
  const shared = scrolling();
  render(show([turn("a", 1)], false), { container: shared });
  expect(shared.scrollTop).toBe(0);
  view.remove();
  shared.remove();
});
