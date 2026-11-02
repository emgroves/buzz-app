// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { TypingEntry } from "../relay/typing";
import {
  profileActivityViewTarget,
  claimProfileTranscript,
  profileTranscriptRequest,
} from "../profiles/target";
import { TypingIndicator } from "./TypingIndicator";

afterEach(cleanup);
const agent = "a".repeat(64),
  human = "b".repeat(64),
  other = "c".repeat(64);
const root = "d".repeat(64),
  secondRoot = "e".repeat(64);
type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
function fixture() {
  const listeners = new Set<() => void>();
  let typing: readonly TypingEntry[] = [];
  let activity: Snapshot = {
    status: "listening",
    typing: [],
    records: [],
    turns: [],
    trimmed: 0,
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const profiles = new Map([
    [agent, { name: "Agent" }],
    [human, { name: "Human", isAgent: true }],
    [other, { name: "Other" }],
  ]);
  const library = { identities: [{ pubkey: agent }, { pubkey: other }] };
  const rows = [
    { id: root, content: "First task" },
    { id: secondRoot, content: "Second task" },
  ];
  const ensure = vi.fn();
  const session = {
    typing: { snapshot: () => typing, subscribe },
    agentActivity: { snapshot: () => activity, subscribe },
    profiles: { snapshot: () => profiles, subscribe, ensure },
    agentChoices: { snapshot: () => library, subscribe },
    channels: {
      window: () => ({ rows }),
      subscribeWindow: (_id: string, fn: () => void) => subscribe(fn),
      ensure,
    },
  } as unknown as RelaySession;
  return {
    session,
    ensure,
    update(entries: readonly TypingEntry[], patch: Partial<Snapshot> = {}) {
      act(() => {
        typing = entries;
        activity = { ...activity, ...patch };
        for (const listener of listeners) listener();
      });
    },
  };
}
const entry = (
  pubkey = agent,
  threadRootId: string | undefined = root,
): TypingEntry => ({ pubkey, channelId: "channel", threadRootId });

it("opens one avatar by hover, with separate thread and activity actions and keyboard focus return", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry()]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  expect(trigger).toHaveTextContent("A");
  expect(trigger).not.toHaveTextContent("Working");
  await user.hover(trigger);
  let dialog = await screen.findByRole("dialog", { name: "Working now" });
  expect(within(dialog).getByText("Thread · First task")).toBeVisible();
  await user.click(
    within(dialog).getByRole("button", { name: "View Agent activity" }),
  );
  const transcript = profileActivityViewTarget(agent, { transcript: true });
  expect(open).toHaveBeenLastCalledWith(transcript, {
    rootId: root,
  });
  // The click asks the profile it opens for the transcript, once.
  expect(profileTranscriptRequest(transcript ?? "")).toBeDefined();
  claimProfileTranscript(transcript ?? "");
  trigger.focus();
  await user.keyboard("{Enter}");
  dialog = await screen.findByRole("dialog", { name: "Working now" });
  await user.click(
    within(dialog).getByRole("button", { name: "Open thread for Agent" }),
  );
  expect(open).toHaveBeenLastCalledWith(
    `buzz://message?channel=channel&id=${root}&thread=${root}`,
    undefined,
  );
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  expect(f.ensure).not.toHaveBeenCalled();
});

it.each([
  [{ title: "unknown", kind: "__proto__" }, "Running a tool"],
  [{ title: "unknown", kind: "constructor" }, "Running a tool"],
  [{ title: "__proto__", kind: "read" }, "Reading"],
  [{ title: "constructor", kind: "read" }, "Reading"],
] as const)(
  "renders the Working now chooser for inherited tool keys: %j",
  async (tool, label) => {
    const f = fixture(),
      user = userEvent.setup();
    const now = Date.parse("2026-10-08T12:00:00Z");
    f.update([], {
      turns: [
        {
          agent,
          channelId: "channel",
          turnId: "turn",
          state: "working",
          timestamp: now,
        },
      ],
      records: [
        {
          id: "f".repeat(64),
          agent,
          createdAt: now / 1000,
          receivedAt: now,
          kind: "acp_read",
          channelIds: ["channel"],
          plaintext: JSON.stringify({
            kind: "acp_read",
            channelId: "channel",
            turnId: "turn",
            timestamp: new Date(now).toISOString(),
            payload: {
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "call",
                  status: "in_progress",
                  rawInput: { path: "/private/report.txt" },
                  ...tool,
                },
              },
            },
          }),
        },
      ],
    });
    render(<TypingIndicator session={f.session} channelId="channel" />);
    await user.click(
      screen.getByRole("button", { name: "Activity: Agent working" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Working now" });
    expect(within(dialog).getByText(label, { exact: true })).toBeVisible();
    expect(dialog).not.toHaveTextContent("report.txt");
  },
);

it("shows stable agent ordering, scopes humans exactly, and clears after work stops", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const props = {
    session: f.session,
    channelId: "channel",
    openActivity: () => true,
    canOpenActivity: () => true,
  };
  f.update([entry(other, secondRoot), entry(agent), entry(human)]);
  const view = render(<TypingIndicator {...props} />);
  expect(screen.getByRole("status")).not.toHaveTextContent("Human is typing");
  const trigger = screen.getByRole("button", {
    name: "Activity: 2 agents working",
  });
  await user.hover(trigger);
  const dialog = await screen.findByRole("dialog");
  const labels = () =>
    within(dialog)
      .getAllByRole("button", { name: /^Open thread/ })
      .map((el) => el.getAttribute("aria-label"));
  expect(labels()).toEqual(["Open thread for Agent", "Open thread for Other"]);
  f.update([entry(human), entry(agent), entry(other, secondRoot)]);
  expect(labels()).toEqual(["Open thread for Agent", "Open thread for Other"]);
  view.rerender(<TypingIndicator {...props} threadRootId={root} />);
  expect(screen.getByRole("status")).toHaveTextContent("Human is typing");
  expect(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  ).toBeVisible();
  f.update([]);
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps a non-navigable status when the plugin is unavailable and does not close after rejected navigation", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => false);
  f.update([entry()], { status: "disabled" });
  const view = render(
    <TypingIndicator session={f.session} channelId="channel" />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  await user.click(trigger);
  let dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Working")).toBeVisible();
  expect(within(dialog).queryByRole("button")).toBeNull();
  view.rerender(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => false}
    />,
  );
  dialog = screen.getByRole("dialog");
  expect(
    within(dialog).queryByRole("button", { name: "View Agent activity" }),
  ).toBeNull();
  await user.click(
    within(dialog).getByRole("button", { name: "Open thread for Agent" }),
  );
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("never chooses one thread from simultaneous work and deduplicates public and owner evidence", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry(), entry(agent, secondRoot)], {
    typing: [
      {
        agent,
        channelId: "channel",
        threadRootId: root,
        working: true,
        startedAt: 1,
        timestamp: 1,
        expiresAt: 100,
      },
    ],
  });
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  const dialog = await screen.findByRole("dialog");
  // The channel conversation is already shown, so the one row opens activity.
  expect(within(dialog).getAllByRole("button")).toHaveLength(1);
  await user.click(
    within(dialog).getByRole("button", { name: "View Agent activity" }),
  );
  expect(open).toHaveBeenLastCalledWith(
    profileActivityViewTarget(agent),
    undefined,
  );
});

it("opens activity for the composer's explicit thread", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry(), entry(agent, secondRoot)]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      threadRootId={root}
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  expect(
    screen.queryByRole("button", { name: "Open thread for Agent" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "View Agent activity" }));
  expect(open).toHaveBeenLastCalledWith(
    profileActivityViewTarget(agent, { transcript: true }),
    {
      rootId: root,
    },
  );
});

it("retains one explicit live region from idle through work and back to idle", () => {
  const f = fixture();
  render(<TypingIndicator session={f.session} channelId="channel" />);
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  expect(status).toHaveClass("sr-only");
  f.update([entry()]);
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveTextContent("Agent is working");
  expect(within(status).queryByRole("button")).toBeNull();
  f.update([]);
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toBeEmptyDOMElement();
  expect(screen.queryByRole("button")).toBeNull();
});

it("keeps another owner's self-declared agent as ordinary typing without activity actions", () => {
  const f = fixture();
  f.update([{ pubkey: human, channelId: "channel" }]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={() => true}
      canOpenActivity={() => true}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Human is typing");
  expect(screen.queryByRole("button")).toBeNull();
});

it.each([null, undefined])(
  "opens channel activity from its row for root %s",
  async (threadRootId) => {
    const f = fixture(),
      user = userEvent.setup(),
      open = vi.fn(() => true);
    f.update(
      [],
      threadRootId === null
        ? {
            typing: [
              {
                agent,
                channelId: "channel",
                threadRootId: undefined,
                working: true,
                startedAt: 1,
                timestamp: 1,
                expiresAt: 100,
              },
            ],
          }
        : {
            turns: [
              {
                agent,
                channelId: "channel",
                turnId: "unknown",
                state: "working",
                timestamp: 1,
              },
            ],
          },
    );
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        openActivity={open}
        canOpenActivity={() => true}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Activity: Agent working" }),
    );
    await user.click(
      screen.getByRole("button", { name: "View Agent activity" }),
    );
    expect(open).toHaveBeenLastCalledWith(
      profileActivityViewTarget(agent, {
        transcript: threadRootId === null,
      }),
      undefined,
    );
    // Opening the channel already shown would do nothing.
    expect(
      screen.queryByRole("button", { name: "Open conversation for Agent" }),
    ).toBeNull();
  },
);

it("opens the sole known conversation without attributing unknown telemetry to that thread", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry()], {
    turns: [
      {
        agent,
        channelId: "channel",
        turnId: "unconfirmed",
        state: "working",
        timestamp: 1,
      },
    ],
  });
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  expect(screen.getByText(/Work with unconfirmed thread/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "View Agent activity" }));
  expect(open).toHaveBeenLastCalledWith(
    profileActivityViewTarget(agent),
    undefined,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Open thread for Agent" }),
  );
  expect(open).toHaveBeenLastCalledWith(
    `buzz://message?channel=channel&id=${root}&thread=${root}`,
    undefined,
  );
});

it.each(["hover", "keyboard"])(
  "consumes %s popup Escape before the owning panel and preserves IME",
  async (mode) => {
    const f = fixture(),
      user = userEvent.setup(),
      panelKey = vi.fn();
    f.update([entry()]);
    render(
      <section aria-label="Thread" onKeyDown={panelKey}>
        <input aria-label="Composer" />
        <TypingIndicator session={f.session} channelId="channel" />
      </section>,
    );
    const input = screen.getByRole("textbox");
    const trigger = screen.getByRole("button", {
      name: "Activity: Agent working",
    });
    input.focus();
    if (mode === "hover") await user.hover(trigger);
    else {
      trigger.focus();
      await user.keyboard("{Enter}");
    }
    await screen.findByRole("dialog");
    panelKey.mockClear();
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    expect(screen.getByRole("dialog")).toBeVisible();
    panelKey.mockClear();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panelKey).not.toHaveBeenCalled();
  },
);

it("hands navigation a retained trigger instead of the disposable popup action", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const captured: (Element | null)[] = [];
  const open = vi.fn(() => {
    captured.push(document.activeElement);
    return true;
  });
  f.update([entry()]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "View Agent activity" }));
  expect(captured).toEqual([trigger]);
  expect(captured[0]).toBeInTheDocument();
});

it.each(["click", "Enter", "Space"])(
  "Solo chat single-agent %s opens Activity directly while hover retains its preview",
  async (activation) => {
    const f = fixture(),
      user = userEvent.setup(),
      open = vi.fn(() => true);
    f.update([entry()]);
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        clickOpensPanel
        canOpenActivity={() => true}
        openActivity={open}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Activity: Agent working",
    });
    await user.hover(trigger);
    expect(
      await screen.findByRole("dialog", { name: "Working now" }),
    ).toBeVisible();
    expect(open).not.toHaveBeenCalled();
    if (activation === "click") await user.click(trigger);
    else {
      trigger.focus();
      await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }
    expect(open).toHaveBeenCalledExactlyOnceWith(
      profileActivityViewTarget(agent, { transcript: true }),
      { rootId: root },
    );
    expect(
      screen.queryByRole("dialog", { name: "Working now" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  },
);

it("Solo chat multiple-agent activation keeps the chooser and unavailable Activity keeps status", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry(), entry(other)]);
  const view = render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      clickOpensPanel
      canOpenActivity={() => true}
      openActivity={open}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: 2 agents working" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Working now" }),
  ).toBeVisible();
  expect(open).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  f.update([entry()]);
  view.rerender(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      clickOpensPanel
      canOpenActivity={() => false}
      openActivity={open}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Working now" }),
  ).toBeVisible();
  expect(open).not.toHaveBeenCalled();
});

it("Solo chat ArrowDown exposes retained thread navigation without opening Activity", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry()]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      clickOpensPanel
      canOpenActivity={() => true}
      openActivity={open}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown", isComposing: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.keyboard("{ArrowDown}");
  const dialog = await screen.findByRole("dialog", { name: "Working now" });
  await waitFor(() => expect(dialog).toHaveFocus());
  expect(open).not.toHaveBeenCalled();
  await user.tab();
  expect(
    within(dialog).getByRole("button", { name: "Open thread for Agent" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(open).toHaveBeenCalledExactlyOnceWith(
    `buzz://message?channel=channel&id=${root}&thread=${root}`,
    undefined,
  );
  expect(trigger).toHaveFocus();
});

it("does not re-render for activity updates that leave its agents unchanged", () => {
  const f = fixture();
  const entries = [entry()];
  f.update(entries);
  const onRender = vi.fn();
  render(
    <Profiler id="typing" onRender={onRender}>
      <TypingIndicator session={f.session} channelId="channel" />
    </Profiler>,
  );
  expect(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  ).toBeVisible();
  const renders = onRender.mock.calls.length;
  f.update(entries, { records: [], turns: [] });
  f.update(entries, { records: [], turns: [] });
  expect(onRender).toHaveBeenCalledTimes(renders);
  f.update([...entries, entry(other, secondRoot)]);
  expect(
    screen.getByRole("button", { name: "Activity: 2 agents working" }),
  ).toBeVisible();
});
