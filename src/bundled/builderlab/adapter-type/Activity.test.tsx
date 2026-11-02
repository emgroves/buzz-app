// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { eventBody } from "../../../features/agent-harness/turn-records";
import type { Agent } from "../../../features/agents/service";
import type { IdentityNameView } from "../../../features/identity-names/service";
import { ActivityPanel, type AgentActivity } from "./Activity";

afterEach(cleanup);

const pubkey = "a".repeat(64);
const other = "b".repeat(64);
const root = "c".repeat(64);
const agent = { pubkey, name: "Ada", place: "hosted" } as Agent;

let serial = 0;
function record(
  turnId: string,
  reply: string,
  author = pubkey,
  channelId = "alpha",
) {
  serial++;
  const event = (kind: string, payload: unknown, seq: number) => ({
    seq,
    timestamp: new Date(
      Date.UTC(2026, 9, 19, 12, 0, serial * 10 + seq),
    ).toISOString(),
    kind,
    agentIndex: 0,
    channelId,
    sessionId: "S",
    turnId,
    payload,
  });
  return {
    id: serial.toString(16).padStart(64, "0"),
    agent: author,
    createdAt: 0,
    receivedAt: Date.UTC(2026, 9, 19, 13) + serial,
    historical: false,
    kind: "batch",
    channelIds: [channelId],
    plaintext: JSON.stringify({
      kind: "batch",
      payload: {
        events: [
          event("turn_started", { threadRootEventId: root }, 0),
          event(
            "acp_read",
            {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "S",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  messageId: `${turnId}-m`,
                  content: { type: "text", text: reply },
                },
              },
            },
            1,
          ),
        ],
      },
    }),
  };
}

/** A turn whose prompt is the exact record of one Buzz message. */
function promptRecord(sender: string) {
  const body = eventBody(
    {
      id: root,
      pubkey: sender,
      kind: 9,
      created_at: 1,
      content: "go",
      tags: [],
    },
    "go",
  );
  const frame = record("t1", "Done");
  const batch = JSON.parse(frame.plaintext);
  batch.payload.events.splice(1, 0, {
    ...batch.payload.events[0],
    seq: 9,
    kind: "acp_write",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: {
        sessionId: "S",
        prompt: [
          {
            type: "text",
            text: `<buzz-event type="mention">\n${body}\n</buzz-event>`,
          },
        ],
      },
    },
  });
  return { ...frame, plaintext: JSON.stringify(batch) };
}

type Snapshot = ReturnType<AgentActivity["snapshot"]>;
function fakeActivity(overrides: Partial<Snapshot> = {}) {
  let snapshot = {
    status: "listening",
    records: [],
    turns: [],
    typing: [],
    trimmed: 0,
    ...overrides,
  } as Snapshot;
  const listeners = new Set<() => void>();
  const activity = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activate: vi.fn(),
  } as unknown as AgentActivity;
  const update = (next: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  return { activity, update };
}

it("shows this agent's published turns, leaving the feed's lease to the plugin", () => {
  const { activity } = fakeActivity({
    records: [
      record("t1", "Deployed the fix"),
      record("t2", "Someone else's work", other),
    ] as unknown as Snapshot["records"],
    turns: [
      {
        agent: pubkey,
        turnId: "t1",
        channelId: "alpha",
        timestamp: 0,
        state: "working",
      },
    ],
  });
  render(<ActivityPanel agent={agent} activity={activity} />);
  expect(screen.getByText("Deployed the fix")).toBeInTheDocument();
  expect(screen.queryByText("Someone else's work")).not.toBeInTheDocument();
  expect(screen.getByText("Working")).toBeInTheDocument();
  expect(activity.activate).not.toHaveBeenCalled();
});

it.each([
  [undefined, "Activity shows once Buzz is connected."],
  [{ status: "unavailable" }, "Activity isn't available here."],
  [
    { status: "disabled" },
    "Turn on Agent Activity in Settings → Plugins to see activity.",
  ],
  [{ status: "connecting" }, "Connecting to the live feed…"],
] as const)("explains a feed that can't show turns yet (%o)", (state, text) => {
  const activity = state && fakeActivity(state as Partial<Snapshot>).activity;
  render(<ActivityPanel agent={agent} activity={activity} />);
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(
    screen.queryByText("No turns captured for this scope yet."),
  ).not.toBeInTheDocument();
});

it("shows every conversation's turns, wherever it was opened from", () => {
  const { activity } = fakeActivity({
    records: [
      record("t1", "In the thread"),
      record("t2", "In beta", pubkey, "beta"),
    ] as unknown as Snapshot["records"],
  });
  render(<ActivityPanel agent={agent} activity={activity} />);
  expect(screen.getByText("In the thread")).toBeInTheDocument();
  expect(screen.getByText("In beta")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("says when older activity was dropped", () => {
  const { activity } = fakeActivity({ trimmed: 3 });
  render(<ActivityPanel agent={agent} activity={activity} />);
  expect(
    screen.getByText("Older activity was dropped to save memory."),
  ).toBeInTheDocument();
});

it("names the person whose message prompted a turn", () => {
  const { activity } = fakeActivity({
    records: [promptRecord(other)] as unknown as Snapshot["records"],
  });
  const names = {
    snapshot: () => 0,
    subscribe: () => () => {},
    resolve: (key: string, fallback?: string) =>
      key === other ? "Salman" : fallback,
  } as unknown as IdentityNameView;
  render(<ActivityPanel agent={agent} activity={activity} names={names} />);
  expect(screen.getByText("Salman")).toBeInTheDocument();
  expect(screen.getByText("go")).toBeInTheDocument();
});
