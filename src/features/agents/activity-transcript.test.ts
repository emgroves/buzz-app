import { expect, it } from "vitest";
import { eventBody } from "../agent-harness/turn-records";
import {
  activityTranscript,
  promptMessage,
  promptSections,
  STEER,
} from "./activity-transcript";

const agent = "a".repeat(64);
const other = "b".repeat(64);
const root = "c".repeat(64);
const otherRoot = "d".repeat(64);
const message = "e".repeat(64);
const base = Date.parse("2026-10-07T12:00:00.000Z");
let serial = 0;
type Frame = { kind: string; [key: string]: unknown };
function event(
  turnId: string,
  kind: string,
  payload: unknown = {},
  offset = serial,
  channelId: string | null = "alpha",
): Frame {
  return {
    seq: offset,
    timestamp: new Date(base + offset * 1000).toISOString(),
    kind,
    agentIndex: 0,
    channelId,
    sessionId: "S",
    turnId,
    payload,
  };
}
function record(events: readonly Frame[], pubkey = agent) {
  serial++;
  return {
    id: serial.toString(16).padStart(64, "0"),
    agent: pubkey,
    receivedAt: base + 3_600_000,
    plaintext: JSON.stringify(
      events.length === 1 ? events[0] : { kind: "batch", payload: { events } },
    ),
  };
}
const update = (sessionUpdate: string, fields: object) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "S", update: { sessionUpdate, ...fields } },
});
const prompt = (id: number, context: string, content: string) => ({
  jsonrpc: "2.0",
  id,
  method: "session/prompt",
  params: {
    sessionId: "S",
    prompt: [
      {
        type: "text",
        text: [
          "<context>",
          context,
          "</context>",
          "",
          '<buzz-event type="mention">',
          `Event ID: ${message}`,
          "Channel: Alpha (#alpha)",
          "Kind: 9",
          "From: Salman (npub: npub1xyz, hex: ff)",
          "Time: 2026-10-07T12:00:00+00:00",
          `Content: ${content}`,
          'Tags: [["h","alpha"]]',
          "</buzz-event>",
        ].join("\n"),
      },
    ],
  },
});

it("projects one thread turn into prompt, thought, tool, permission and reply", () => {
  serial = 0;
  const records = [
    record([
      event(
        "t1",
        "turn_started",
        {
          source: "channel",
          triggeringEventIds: [message, "not-an-id"],
          threadRootEventId: root,
        },
        0,
      ),
      event(
        "t1",
        "session_resolved",
        { sessionId: "S", isNewSession: true },
        1,
      ),
      event(
        "t1",
        "acp_write",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "session/new",
          params: {
            _meta: {
              systemPrompt: {
                append:
                  "<base>\nbe kind\n</base>\n<core-memory>\nremember\n</core-memory>",
              },
            },
          },
        },
        2,
      ),
      // pi-acp returns its banner in session/new, then repeats it as a message.
      event(
        "t1",
        "acp_read",
        {
          jsonrpc: "2.0",
          id: 1,
          result: { _meta: { piAcp: { startupInfo: "pi v1\n## Skills" } } },
        },
        2,
      ),
      event(
        "t1",
        "acp_read",
        update("agent_message_chunk", {
          content: { type: "text", text: "pi v1\n## Skills" },
        }),
        2,
      ),
      event(
        "t1",
        "session_config_captured",
        {
          configOptions: [
            {
              category: "model",
              name: "Model",
              currentValue: "m1",
              options: [{ value: "m1", name: "Opus" }],
            },
            {
              category: "thought_level",
              name: "Thinking",
              currentValue: "high",
              options: [{ value: "high", name: "Thinking: high" }],
            },
            { category: "mode", currentValue: "auto" },
            { category: "mode", name: "Unset" },
          ],
        },
        2,
      ),
      event(
        "t1",
        "acp_write",
        prompt(3, `Scope: thread\nThread root: ${root}`, "please\nrun tests"),
        3,
      ),
    ]),
    record([
      event(
        "t1",
        "acp_read",
        update("agent_thought_chunk", {
          content: { type: "text", text: "Consider " },
        }),
        4,
      ),
      event(
        "t1",
        "acp_read",
        update("agent_thought_chunk", {
          content: { type: "text", text: "tests." },
        }),
        5,
      ),
      event(
        "t1",
        "acp_read",
        update("agent_message_chunk", {
          messageId: "m1",
          content: { type: "text", text: "Running " },
        }),
        6,
      ),
      event(
        "t1",
        "acp_read",
        update("tool_call", {
          toolCallId: "call-1",
          title: "buzz-dev-mcp__shell",
          status: "pending",
          rawInput: { command: "pnpm test" },
        }),
        7,
      ),
      // Agent request id 3 collides with our session/prompt request id 3.
      event(
        "t1",
        "acp_read",
        {
          jsonrpc: "2.0",
          id: 3,
          method: "session/request_permission",
          params: {
            toolCall: { toolCallId: "call-1" },
            options: [
              { optionId: "a", name: "Allow", kind: "allow_once" },
              { optionId: "r", name: "Deny", kind: "reject_once" },
            ],
          },
        },
        8,
      ),
      event(
        "t1",
        "acp_write",
        {
          jsonrpc: "2.0",
          id: 3,
          result: { outcome: { outcome: "selected", optionId: "a" } },
        },
        9,
      ),
      event(
        "t1",
        "acp_read",
        update("tool_call_update", {
          toolCallId: "call-1",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "ok …[elided 9 bytes]… done" },
            },
          ],
        }),
        10,
      ),
      event(
        "t1",
        "acp_read",
        update("agent_message_chunk", {
          messageId: "m1",
          content: { type: "text", text: "tests: done" },
        }),
        11,
      ),
      event(
        "t1",
        "acp_read",
        update("usage_update", { used: 1200, size: 200000 }),
        12,
      ),
      event(
        "t1",
        "acp_read",
        { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } },
        13,
      ),
      event("t1", "turn_completed", {}, 14),
    ]),
  ];
  const { turns } = activityTranscript(records, { agent, channelId: "alpha" });
  expect(turns).toHaveLength(1);
  const [turn] = turns;
  expect(turn).toMatchObject({
    turnId: "t1",
    channelId: "alpha",
    threadRootId: root,
    source: "channel",
    triggeringEventIds: [message],
    sessionId: "S",
    newSession: true,
    config: ["Model: Opus", "Thinking: high", "auto"],
    startedAt: base,
    endedAt: base + 14_000,
    stopReason: "end_turn",
    context: { used: 1200, size: 200000 },
    partial: false,
  });
  expect(turn?.items.map((item) => item.type)).toEqual([
    "system",
    "prompt",
    "thought",
    "message",
    "tool",
  ]);
  const [system, request, thought, reply, tool] = turn?.items ?? [];
  expect(system).toMatchObject({
    sections: [
      { tag: "base", body: "be kind" },
      { tag: "core-memory", body: "remember" },
    ],
  });
  expect(request).toMatchObject({
    text: "please\nrun tests",
    author: "Salman",
    steer: false,
  });
  expect(thought).toMatchObject({ text: "Consider tests." });
  // Explicit message IDs join across the interleaved tool call.
  expect(reply).toMatchObject({ text: "Running tests: done" });
  // Adapter-specific names and inputs are kept as sent, not interpreted.
  expect(tool).toMatchObject({
    toolCallId: "call-1",
    title: "buzz-dev-mcp__shell",
    kind: "",
    status: "completed",
    input: JSON.stringify({ command: "pnpm test" }, null, 2),
    output: "ok …[elided 9 bytes]… done",
    truncated: true,
    completedAt: base + 10_000,
    permission: { options: ["Allow", "Deny"], outcome: "Allow" },
  });
});

it("takes the thread from the payload root, then the prompt context", () => {
  serial = 0;
  const records = [
    record([
      event("payload", "turn_liveness", { threadRootEventId: otherRoot }, 1),
    ]),
    // Older harnesses omit the payload root; the prompt still names it.
    record([
      event(
        "legacy",
        "turn_started",
        { source: "channel", triggeringEventIds: [] },
        2,
      ),
      event(
        "legacy",
        "acp_write",
        prompt(1, `Scope: thread\nThread root: ${root}`, "old"),
        3,
      ),
    ]),
    record([
      event("main", "turn_started", {}, 4),
      event("main", "acp_write", prompt(2, "Scope: channel", "channel"), 5),
    ]),
    record([event("unknown", "turn_liveness", {}, 6)]),
  ];
  const channel = activityTranscript(records, { agent, channelId: "alpha" });
  expect(
    channel.turns.map((turn) => [turn.turnId, turn.threadRootId, turn.partial]),
  ).toEqual([
    ["payload", otherRoot, true],
    ["legacy", root, false],
    ["main", null, false],
    ["unknown", undefined, true],
  ]);
});

it("keeps batch children in their own channel and other agents out", () => {
  serial = 0;
  const records = [
    record([
      event("one", "turn_liveness", {}, 1, "alpha"),
      event("two", "turn_liveness", {}, 2, "beta"),
      event("three", "turn_liveness", {}, 3, null),
    ]),
    record([event("theirs", "turn_liveness", {}, 4)], other),
    { ...record([]), plaintext: "{not json" },
  ];
  expect(
    activityTranscript(records, { agent, channelId: "alpha" }).turns.map(
      (turn) => turn.turnId,
    ),
  ).toEqual(["one"]);
  expect(
    activityTranscript(records, { agent }).turns.map((turn) => turn.turnId),
  ).toEqual(["one", "two", "three"]);
});

it("records errors, elided payloads, plan revisions and steering prompts", () => {
  serial = 0;
  const { turns } = activityTranscript(
    [
      record([
        event("t", "turn_started", {}, 0),
        event(
          "t",
          "acp_read",
          update("plan", { entries: [{ content: "a", status: "pending" }] }),
          1,
        ),
        event(
          "t",
          "acp_read",
          update("plan", {
            entries: [
              { content: "a", status: "completed" },
              { content: "", status: "x" },
            ],
          }),
          2,
        ),
        event(
          "t",
          "acp_write",
          {
            jsonrpc: "2.0",
            method: "_session/steering",
            params: { prompt: [{ type: "text", text: "also lint" }] },
          },
          3,
        ),
        event(
          "t",
          "acp_read",
          { elided: "acp_read payload too large", originalBytes: 99999 },
          4,
        ),
        event(
          "t",
          "acp_read",
          update("tool_call", {
            toolCallId: "edit",
            title: "edit",
            kind: "edit",
            locations: [{ path: "/a.md" }],
          }),
          4,
        ),
        event(
          "t",
          "acp_read",
          update("tool_call_update", {
            toolCallId: "edit",
            status: "failed",
            content: [
              { type: "diff", path: "/a.md", oldText: "x\ny", newText: "x\nz" },
              { type: "diff", path: "/b.md", oldText: null, newText: "new" },
              { type: "terminal", terminalId: "t1" },
              {
                type: "content",
                content: { type: "text", text: "```console\nExit code 1\n```" },
              },
            ],
          }),
          4,
        ),
        event(
          "t",
          "turn_error",
          { outcome: "timeout", error: "turn timed out" },
          5,
        ),
      ]),
    ],
    { agent },
  );
  expect(turns[0]).toMatchObject({
    error: "turn timed out",
    endedAt: base + 5000,
  });
  expect(turns[0]?.items).toMatchObject([
    { type: "plan", entries: [{ content: "a", status: "completed" }] },
    { type: "prompt", text: "also lint", steer: true },
    { type: "status", text: expect.stringContaining("elided") },
    {
      type: "tool",
      kind: "edit",
      status: "failed",
      paths: ["/a.md"],
      output: "Exit code 1",
      diffs: [
        { path: "/a.md", oldText: "x\ny", newText: "x\nz" },
        { path: "/b.md", newText: "new" },
      ],
    },
  ]);
});

it("carries a session's config into its later turns only", () => {
  serial = 0;
  const at = (
    turnId: string,
    kind: string,
    payload: object,
    offset: number,
    sessionId: string | null,
  ) => ({ ...event(turnId, kind, payload, offset), sessionId });
  const captured = {
    configOptions: [
      {
        category: "model",
        name: "Model",
        currentValue: "a",
        options: [{ value: "a", name: "A" }],
      },
    ],
  };
  const resolved = (sessionId: string) => ({ sessionId, isNewSession: true });
  const { turns } = activityTranscript(
    [
      record([
        at("before", "turn_started", {}, 1, "S1"),
        // The capture precedes session_resolved, so its frame has no session.
        at("first", "turn_started", {}, 2, null),
        at("first", "session_config_captured", captured, 2, null),
        at("first", "session_resolved", resolved("S1"), 2, null),
        at("reused", "turn_started", {}, 3, "S1"),
        at("replaced", "turn_started", {}, 4, null),
        at("replaced", "session_resolved", resolved("S2"), 4, null),
      ]),
    ],
    { agent },
  );
  expect(turns.map((turn) => [turn.turnId, turn.config])).toEqual([
    ["before", []],
    ["first", ["Model: A"]],
    ["reused", ["Model: A"]],
    ["replaced", []],
  ]);
});

it("splits prompt sections and keeps unterminated framing as text", () => {
  expect(
    promptSections(
      'intro\n<context a="b">\nScope: channel\n</context>\n<x>\nopen',
    ),
  ).toEqual([
    { tag: "context", body: "Scope: channel" },
    { tag: "text", body: "intro\n<x>\nopen" },
  ]);
});

it("reads an event sent as an exact record, in its own or a steer's section", () => {
  const event = {
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    kind: 9,
    created_at: 1,
    content: "@Claude <b>",
    tags: [],
  };
  const body = eventBody(event, "<b>");
  const name = (pubkey: string) =>
    pubkey === event.pubkey ? "Sam" : undefined;
  for (const tag of ["buzz-event", STEER])
    expect(
      promptMessage(promptSections(`<${tag}>\n${body}\n</${tag}>`), name),
    ).toEqual({ text: "<b>", author: "Sam" });
  expect(promptMessage([{ tag: "buzz-event", body }])).toEqual({
    text: "<b>",
    author: undefined,
  });
  // A steer before records wrapped a whole turn, which is not an event.
  expect(
    promptMessage([{ tag: STEER, body: "<buzz-event>\nContent: x\n" }]),
  ).toEqual({ text: "", author: undefined });
});

it("names an exact-record prompt's author in the turn, as the viewer knows them", () => {
  serial = 0;
  const sender = "f".repeat(64);
  const body = eventBody(
    {
      id: message,
      pubkey: sender,
      kind: 9,
      created_at: 1,
      content: "hi",
      tags: [],
    },
    "hi",
  );
  const records = [
    record([
      event("t1", "turn_started", {}, 0),
      event(
        "t1",
        "acp_write",
        {
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
        1,
      ),
    ]),
  ];
  const author = (name?: (pubkey: string) => string | undefined) =>
    activityTranscript(records, { agent }, name).turns[0]?.items[0];
  expect(
    author((pubkey) => (pubkey === sender ? "Salman" : undefined)),
  ).toMatchObject({ type: "prompt", text: "hi", author: "Salman" });
  expect(author()).not.toHaveProperty("author");
});
