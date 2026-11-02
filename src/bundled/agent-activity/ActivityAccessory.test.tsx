// @vitest-environment jsdom
import { createLocalAgentActivity } from "../../features/agents/local-activity";
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

import { Profiler } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ActivityAccessory,
  ActivityTypingReplacement,
} from "./ActivityAccessory";
import { TypingPresentation } from "../../features/conversation/typing-presentation";
import { TypingIndicator } from "../../features/messages/TypingIndicator";
import { createAgentActivity } from "../../features/agents/activity";
import { createAgentLibrary } from "../../features/agents/library";
import type { RelaySession } from "../../features/relay/session";

// Stop's results are host toasts; the shared Toast owns how they show.
const notify = vi.hoisted(() => vi.fn());
vi.mock("../../shared/design-system/ui/Toast", async (original) => ({
  ...(await original<typeof import("../../shared/design-system/ui/Toast")>()),
  useToastNotification: () => notify,
}));

afterEach(() => {
  cleanup();
  notify.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const A = "b".repeat(64),
  B = "c".repeat(64),
  viewer = "a".repeat(64),
  root = "1".repeat(64),
  next = "2".repeat(64);
function fixture(local?: ReturnType<typeof createLocalAgentActivity>) {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  let generation = 0,
    serial = 0;
  const activity = createAgentActivity(
    true,
    (g) => {
      generation = g ?? 0;
    },
    () => true,
    undefined,
    undefined,
    local ? { source: local.reader, scope: "test" } : undefined,
  );
  const release = activity.queries.activate();
  const live = {
    status: "connected" as const,
    routes: [
      { id: "observer", status: "live" as const, replay: "unknown" as const },
    ],
  };
  activity.state(live);
  const profiles = new Map([
    [A, { name: "Blossom", isAgent: true }],
    [B, { name: "Bubbles", isAgent: true }],
  ]);
  const session = {
    viewer,
    presence: {
      subscribe: () => () => {},
      status: () => "online",
      limited: () => false,
    },
    agentActivity: activity.queries,
    agentChoices: createAgentLibrary(undefined).queries,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
    },
    live: { retry: () => activity.state(live) },
    media: () => undefined,
  } as unknown as RelaySession;
  const send = (
    agent: string,
    turnId: string,
    seq: number,
    kind: string,
    payload: unknown = {},
  ) =>
    act(() => {
      activity.receive(
        {
          id: (++serial).toString(16).padStart(64, "0"),
          agent,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({
            kind,
            turnId,
            channelId: "c",
            sessionId: "S",
            seq,
            timestamp: new Date().toISOString(),
            payload,
          }),
        },
        generation,
      );
    });
  const open = vi.fn(() => true);
  const props = {
    session,
    scope: "test",
    channelId: "c",
    threadRootId: root,
    message: {
      id: root,
      channelId: "c",
      authorId: viewer,
      createdAt: 1,
      content: "Request",
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
    },
    canOpen: () => true,
    open,
  };
  return {
    activity,
    release,
    send,
    props,
    live,
    profiles,
    dispose: () => {
      release();
      activity.dispose();
    },
  };
}

it("shows one bubble with one avatar per agent across multiple turns, removing only the settled agent", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a1", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "a2", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b1", 1, "turn_started", { triggeringEventIds: [root] });
    expect(
      screen.getAllByRole("button", { name: /View agent activity/ }),
    ).toHaveLength(1);
    expect(screen.getAllByTitle("Blossom")).toHaveLength(1);
    expect(screen.getAllByTitle("Bubbles")).toHaveLength(1);
    expect(view.container.querySelector(".buzz-avatar-status-dot")).toBeNull();
    f.send(A, "a1", 2, "turn_completed");
    expect(
      screen.getByRole("button", { name: /View agent activity: Blossom/ }),
    ).toBeInTheDocument();
    f.send(A, "a2", 2, "turn_completed");
    expect(
      screen.queryByRole("button", { name: /Blossom/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /View agent activity: Bubbles/ }),
    ).toBeInTheDocument();
    f.send(B, "b1", 2, "turn_completed");
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("does not show sibling thread work and reports lost freshness without pretending completion", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "other", 1, "turn_started", { triggeringEventIds: [next] });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    f.send(B, "here", 1, "turn_started", { triggeringEventIds: [root] });
    act(() => vi.advanceTimersByTime(31000));
    expect(
      screen.getByRole("button", { name: /View agent activity: Bubbles/ }),
    ).toHaveTextContent("Status unknown");
    f.send(B, "here", 2, "turn_completed");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("keeps namesakes as separate exact identities", () => {
  const f = fixture();
  f.profiles.set(B, { name: "Blossom", isAgent: true });
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "b", 1, "turn_started", { triggeringEventIds: [root] });
    const avatars = screen.getAllByTitle(/Blossom/);
    expect(avatars).toHaveLength(2);
    expect(avatars[0]?.getAttribute("title")).not.toBe(
      avatars[1]?.getAttribute("title"),
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("previews only live scoped actions and retains profile navigation", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "old", 1, "turn_started", { triggeringEventIds: [root] });
    const thought = (text: string) => ({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text },
        },
      },
    });
    f.send(A, "old", 2, "acp_read", thought("Old thought"));
    f.send(A, "old", 3, "turn_completed");
    f.send(A, "new", 1, "turn_started", { triggeringEventIds: [root] });
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    expect(
      screen.getByText("Waiting for activity details"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Old thought")).not.toBeInTheDocument();
    f.send(A, "new", 2, "acp_read", thought("Current thought"));
    expect(screen.getByText("Current thought")).toBeInTheDocument();
    f.send(B, "sibling", 1, "turn_started", { triggeringEventIds: [next] });
    f.send(B, "sibling", 2, "acp_read", thought("Private sibling thought"));
    expect(
      screen.queryByText("Private sibling thought"),
    ).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(31000));
    expect(
      screen.getByText("Activity interrupted or out of date"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Current thought")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View activity for Blossom" }),
    );
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(
      `buzz:profile?agent=${A}&tab=activity`,
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("removes the whole popup when access is revoked", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(<ActivityAccessory {...f.props} canOpen={() => false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("makes the compact avatar and tool preview one action, retaining the popup when opening fails", () => {
  const f = fixture();
  f.props.open.mockReturnValue(false);
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "a", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(A, "a", 2, "acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read",
          title: "buzz-dev-mcp__read_file",
          status: "in_progress",
          rawInput: { path: "/project/file.ts" },
        },
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    const popup = within(
      screen.getByRole("dialog", { name: "Agent activity" }),
    );
    expect(popup.getAllByRole("button")).toHaveLength(1);
    for (const text of [
      "Agent activity",
      "Latest reported activity for this message.",
      "Blossom",
      "View activity",
      "Close",
    ])
      expect(popup.queryByText(text, { exact: true })).not.toBeInTheDocument();
    const row = popup.getByRole("button", {
      name: "View activity for Blossom",
    });
    expect(row).toHaveTextContent("Read file · Running");
    expect(row.querySelector(".buzz-avatar")).not.toBeNull();
    fireEvent.click(popup.getByText("file.ts"));
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(
      `buzz:profile?agent=${A}&tab=activity`,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(
      <ActivityAccessory
        {...f.props}
        canOpen={(target) => !target.startsWith("buzz:profile?")}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "View activity for Blossom" }),
    ).not.toBeInTheDocument();
    expect(f.props.open).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("keeps main's unassociated work visible, replacing it only for a linked message in this thread", () => {
  const f = fixture();
  const typing = [{ pubkey: A, channelId: "c", threadRootId: root }];
  const session = {
    ...f.props.session,
    typing: { snapshot: () => typing, subscribe: () => () => {} },
  } as unknown as RelaySession;
  const props = { ...f.props, session };
  const ui = (replacement: boolean) => (
    <TypingPresentation active>
      {/* MessageRow gives each row its own presentation scope. */}
      <TypingPresentation active>
        <ActivityAccessory {...props} />
      </TypingPresentation>
      {replacement && <ActivityTypingReplacement {...props} />}
      <TypingIndicator session={session} channelId="c" threadRootId={root} />
    </TypingPresentation>
  );
  const view = render(ui(true));
  try {
    f.send(A, "unlinked", 1, "turn_liveness");
    expect(
      screen.getByRole("button", { name: "Activity: Blossom working" }),
    ).toBeInTheDocument();
    f.send(A, "sibling", 1, "turn_started", { triggeringEventIds: [next] });
    expect(
      screen.getByRole("button", { name: "Activity: Blossom working" }),
    ).toBeInTheDocument();
    f.send(A, "here", 1, "turn_started", { triggeringEventIds: [root] });
    expect(
      screen.getByRole("button", {
        name: "View agent activity: Blossom, working",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Activity: Blossom working" }),
    ).not.toBeInTheDocument();
    view.rerender(ui(false));
    expect(
      screen.getByRole("button", { name: "Activity: Blossom working" }),
    ).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("shows local receipt and failure without requiring an ACP transcript, and opens the agent profile", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    let work!: ReturnType<typeof local.begin>;
    act(() => {
      work = local.begin({
        scope: "test",
        channelId: "c",
        threadRootId: root,
        messageId: root,
        agent: A,
      });
    });
    const bubble = screen.getByRole("button", {
      name: "View agent activity: Blossom, Received · waiting to start",
    });
    expect(bubble.querySelector('[data-state="waiting"]')).not.toBeNull();
    act(() => work.started());
    expect(bubble).toHaveAccessibleName(
      "View agent activity: Blossom, Starting",
    );
    expect(bubble.querySelector('[data-state="waiting"]')).not.toBeNull();
    act(() => work.step("Read", "notes.txt"));
    expect(bubble).toHaveAccessibleName(
      "View agent activity: Blossom, Reading notes.txt",
    );
    expect(bubble.querySelector('[data-state="working"]')).not.toBeNull();
    act(() => work.finish({ ok: false, error: "Provider unavailable" }));
    expect(bubble).toHaveTextContent("1 failed");
    expect(bubble.querySelector("[data-state]")).toBeNull();
    fireEvent.click(bubble);
    expect(screen.getByText("Provider unavailable")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View activity for Blossom" }),
    );
    expect(f.props.open).toHaveBeenCalledExactlyOnceWith(
      `buzz:profile?agent=${A}&tab=activity`,
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("dismisses only that agent's error on this message, without changing other work", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const onFocusedRemoval = vi.fn();
  const view = render(
    <ActivityAccessory {...f.props} onFocusedRemoval={onFocusedRemoval} />,
  );
  const begin = (agent: string, messageId: string) =>
    local.begin({
      scope: "test",
      channelId: "c",
      threadRootId: root,
      messageId,
      agent,
    });
  try {
    act(() => {
      begin(A, root).finish({
        ok: false,
        error: "Provider unavailable after a long and detailed reason",
      });
      begin(A, next).finish({ ok: false, error: "Elsewhere" });
      begin(B, root).step("Read", "notes.txt");
    });
    const mixed = screen.getByRole("button", { name: /View agent activity/ });
    expect(mixed).toHaveTextContent("1 failed");
    const failedBadge = mixed.querySelector("[data-activity-failure]");
    const workingBadge = mixed.querySelector("[data-thread-working]");
    expect(failedBadge?.querySelector('[title="Blossom"]')).not.toBeNull();
    expect(workingBadge?.querySelector('[title="Bubbles"]')).not.toBeNull();
    expect(workingBadge?.querySelector('[title="Blossom"]')).toBeNull();
    expect(failedBadge?.parentElement).toBe(workingBadge?.parentElement);
    expect(mixed.querySelector('[data-state="working"]')).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /View agent activity/ }),
    );
    expect(
      screen.getByText("Provider unavailable after a long and detailed reason")
        .parentElement,
    ).toHaveAttribute("data-error");
    expect(
      screen.queryByRole("button", { name: "Dismiss error from Bubbles" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss error from Blossom" }),
    );
    expect(f.props.open).not.toHaveBeenCalled();
    expect(onFocusedRemoval).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "View activity for Bubbles" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View activity for Blossom" }),
    ).toBeNull();
    expect(
      local.reader
        .work()
        .filter((row) => row.agent === A)
        .map((row) => [row.messageId, row.state, row.dismissed]),
    ).toEqual([
      // The outcome remains as settled evidence; only its display is hidden.
      [root, "error", true],
      [next, "error", undefined],
    ]);
  } finally {
    view.unmount();
    f.dispose();
  }
});

it.each([false, true])(
  "returns focus after retiring the last error unless focus moved: %s",
  async (moved) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const onFocusedRemoval = vi.fn();
    const view = render(
      <>
        <button type="button">Other task</button>
        <ActivityAccessory {...f.props} onFocusedRemoval={onFocusedRemoval} />
      </>,
    );
    try {
      act(() => {
        local
          .begin({
            scope: "test",
            channelId: "c",
            threadRootId: root,
            messageId: root,
            agent: A,
          })
          .finish({ ok: false, error: "Provider unavailable" });
      });
      fireEvent.click(
        screen.getByRole("button", { name: /View agent activity/ }),
      );
      const dismiss = screen.getByRole("button", {
        name: "Dismiss error from Blossom",
      });
      act(() => dismiss.focus());
      fireEvent.click(dismiss);
      // The owned clock holds the handoff microtask after React removes the
      // popup, so a deliberate focus move wins before that handoff runs.
      expect(onFocusedRemoval).not.toHaveBeenCalled();
      if (moved)
        act(() => screen.getByRole("button", { name: "Other task" }).focus());
      await act(async () => vi.runAllTicks());
      expect(onFocusedRemoval).toHaveBeenCalledTimes(moved ? 0 : 1);
      expect(screen.queryByText("Provider unavailable")).toBeNull();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);

it("keeps an idle reply summary mounted without advertising an activity popup", () => {
  const f = fixture();
  const navigate = vi.fn();
  const view = render(
    <ActivityAccessory
      {...f.props}
      renderMessageSummary={(activity) => (
        <button type="button" ref={activity?.ref} onClick={navigate}>
          View thread{activity ? `: ${activity.label}` : ""}
        </button>
      )}
    />,
  );
  try {
    const summary = screen.getByRole("button", { name: "View thread" });
    expect(summary).not.toHaveAttribute("aria-haspopup");
    expect(summary).not.toHaveAttribute("aria-expanded");
    f.send(A, "here", 1, "turn_started", { triggeringEventIds: [root] });
    expect(screen.getByRole("button", { name: /View thread/ })).toBe(summary);
    expect(summary).toHaveAttribute("aria-haspopup", "dialog");
    f.send(A, "here", 2, "turn_completed");
    expect(screen.getByRole("button", { name: "View thread" })).toBe(summary);
    expect(summary).not.toHaveAttribute("aria-haspopup");
    expect(summary).not.toHaveAttribute("aria-expanded");
    fireEvent.click(summary);
    expect(navigate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

const settle = () => act(async () => {});
const openBubble = () =>
  fireEvent.click(screen.getByRole("button", { name: /View agent activity/ }));
const stopButton = () => screen.queryByRole("button", { name: "Stop Blossom" });
// Reopen the popup, if anything closed it, to read the agent's row.
const look = () => {
  const activity = screen.queryByRole("button", {
    name: /View agent activity/,
  });
  if (activity && !screen.queryByRole("dialog")) fireEvent.click(activity);
  return screen;
};
const stopPending = () =>
  expect(stopButton()).toHaveAttribute("aria-disabled", "true");
const stopReady = () =>
  expect(stopButton()).not.toHaveAttribute("aria-disabled");
function hosted(running: boolean | Promise<boolean> = true) {
  return {
    interruptible: vi.fn(() => true),
    interrupt: vi.fn(async () => running),
  };
}

it.each(["waiting", "working"])(
  "stops a local request that is %s through its harness, then notes it stopped",
  async (state) => {
    const local = createLocalAgentActivity();
    const f = fixture(local);
    const queries = f.props.session.agentActivity;
    const interrupt = vi.fn(queries.interrupt);
    const session = {
      ...f.props.session,
      agentActivity: { ...queries, interrupt },
    };
    const stop = vi.fn(async () => {});
    const view = render(<ActivityAccessory {...f.props} session={session} />);
    try {
      act(() => {
        const work = local.begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        });
        work.interruptible(stop);
        if (state === "working") work.started();
      });
      openBubble();
      fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
      expect(interrupt).toHaveBeenCalledExactlyOnceWith(A, "c", root);
      await settle();
      expect(stop).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        "Stopped Blossom",
        "success",
      );
      expect(
        screen.queryByRole("button", { name: /View agent activity/ }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Blossom · Stopped")).toBeInTheDocument();
      // Handling the same message again replaces the note with its live work.
      act(() => {
        local
          .begin({
            scope: "test",
            channelId: "c",
            threadRootId: root,
            messageId: root,
            agent: A,
          })
          .started();
      });
      expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /View agent activity: Blossom/ }),
      ).toBeInTheDocument();
    } finally {
      view.unmount();
      f.dispose();
    }
  },
);
it("notes a stopped request beside a thread summary host", async () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(
    <ActivityAccessory
      {...f.props}
      renderMessageSummary={(activity) =>
        activity ? (
          <button type="button" ref={activity.ref}>
            View thread: {activity.label}
          </button>
        ) : null
      }
    />,
  );
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .interruptible(async () => {});
    });
    expect(
      screen.getByRole("button", { name: /View thread: Blossom/ }),
    ).toBeInTheDocument();
    // The browser journey stops it through the summary's popup.
    await act(() => f.props.session.agentActivity.interrupt(A, "c", root));
    expect(
      screen.queryByRole("button", { name: /View thread/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Blossom · Stopped")).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});
it("notes only stopped requests once their work settles", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .finish({ ok: true });
    });
    expect(
      screen.queryByLabelText("Agent activity on this message"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("hands focus back to the host when a focused Stop retires with its work", async () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const onFocusedRemoval = vi.fn();
  const view = render(
    <ActivityAccessory {...f.props} onFocusedRemoval={onFocusedRemoval} />,
  );
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .interruptible(async () => {});
    });
    openBubble();
    const stop = stopButton() as HTMLElement;
    act(() => stop.focus());
    fireEvent.click(stop);
    await settle();
    expect(stop.isConnected).toBe(false);
    await act(async () => vi.runAllTicks());
    expect(onFocusedRemoval).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("shows a local request as stopping until its harness has stopped it", async () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  let release = () => {};
  const stop = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    act(() => {
      local
        .begin({
          scope: "test",
          channelId: "c",
          threadRootId: root,
          messageId: root,
          agent: A,
        })
        .interruptible(stop);
    });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
    fireEvent.click(stopButton() as HTMLElement);
    expect(stop).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
    release();
    await settle();
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Stopped Blossom",
      "success",
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers no Stop for a local request that cannot be stopped or has failed", () => {
  const local = createLocalAgentActivity();
  const f = fixture(local);
  const view = render(<ActivityAccessory {...f.props} />);
  const begin = (agent: string) =>
    local.begin({
      scope: "test",
      channelId: "c",
      threadRootId: root,
      messageId: root,
      agent,
    });
  try {
    act(() => {
      begin(A).started();
      const failed = begin(B);
      failed.interruptible(async () => {});
      failed.finish({ ok: false, error: "Provider unavailable" });
    });
    openBubble();
    expect(stopButton()).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop Bubbles" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss error from Bubbles" }),
    ).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("stops a hosted agent's turn through its provider in this thread", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    expect(agents.interruptible).toHaveBeenCalledWith(A);
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(agents.interrupt).toHaveBeenCalledExactlyOnceWith(A, {
      channelId: "c",
      threadRootId: root,
    });
    // Its turn ends when the provider reports it, so it shows as stopping.
    await settle();
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Stopping Blossom",
      "success",
    );
    f.send(A, "t", 2, "turn_completed");
    expect(
      screen.queryByRole("button", { name: /View agent activity/ }),
    ).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("stops a hosted agent in the thread its message replies to", () => {
  const f = fixture();
  const agents = hosted();
  const reply = { ...f.props.message, id: next, threadRootId: root };
  const view = render(
    <ActivityAccessory {...f.props} message={reply} agents={agents} />,
  );
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [next] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(agents.interrupt).toHaveBeenCalledExactlyOnceWith(A, {
      channelId: "c",
      threadRootId: root,
    });
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers each agent its own Stop in the activity popup", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    f.send(B, "u", 1, "turn_started", { triggeringEventIds: [root] });
    expect(stopButton()).not.toBeInTheDocument();
    openBubble();
    const popup = within(screen.getByRole("dialog"));
    expect(
      popup.getByRole("button", { name: "Stop Blossom" }),
    ).toHaveTextContent("Stop");
    fireEvent.click(popup.getByRole("button", { name: "Stop Bubbles" }));
    expect(agents.interrupt).toHaveBeenCalledExactlyOnceWith(B, {
      channelId: "c",
      threadRootId: root,
    });
    await settle();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Stopping Bubbles",
      "success",
    );
    expect(popup.getByRole("button", { name: "Stop Bubbles" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    stopReady();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("returns a hosted agent to its activity when its provider had nothing running to stop", async () => {
  const f = fixture();
  const view = render(
    <ActivityAccessory {...f.props} agents={hosted(false)} />,
  );
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    expect(
      look().getByText("Waiting for activity details"),
    ).toBeInTheDocument();
    stopReady();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Blossom had nothing running to stop",
      "info",
    );
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("says why a hosted agent could not be stopped and lets the owner try again", async () => {
  const f = fixture();
  const agents = hosted();
  agents.interrupt.mockRejectedValueOnce(new Error("Provider is busy."));
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    await settle();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Couldn’t stop Blossom. Provider is busy.",
      "error",
    );
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    stopReady();
    fireEvent.click(stopButton() as HTMLElement);
    expect(agents.interrupt).toHaveBeenCalledTimes(2);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("forgets a stop once its agent's work here has ended", async () => {
  const f = fixture();
  const agents = hosted();
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    f.send(A, "t", 2, "turn_completed");
    f.send(A, "u", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    stopReady();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers no Stop for a hosted agent that is not interruptible, or whose activity is out of date", () => {
  const f = fixture();
  const agents = hosted();
  agents.interruptible.mockReturnValue(false);
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    expect(stopButton()).not.toBeInTheDocument();
    // Interruptible, but no longer known to be working.
    agents.interruptible.mockReturnValue(true);
    view.rerender(<ActivityAccessory {...f.props} agents={agents} />);
    expect(stopButton()).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(31000));
    expect(
      screen.getByText("Activity interrupted or out of date"),
    ).toBeInTheDocument();
    expect(stopButton()).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("offers no Stop for a hosted agent when the host supplies no agents", () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    expect(stopButton()).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("shows no activity, and so no Stop, without a message", () => {
  const f = fixture();
  const agents = hosted();
  const { message: _message, ...props } = f.props;
  const view = render(<ActivityAccessory {...props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(agents.interruptible).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    f.dispose();
  }
});

const NOT_STOPPED = "Blossom hasn’t stopped yet. Try again.";
const notStopped = () =>
  notify.mock.calls.filter(([title]) => title === NOT_STOPPED).length;
const elapse = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const alive = (f: ReturnType<typeof fixture>, turn: string, seq: number) =>
  f.send(A, turn, seq, "acp_read", {});

it("lets the owner try Stop again when a hosted turn is still working 30 seconds after it was stopped", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
    elapse(15_000);
    alive(f, "t", 2);
    elapse(14_999);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    expect(notStopped()).toBe(0);
    alive(f, "t", 3);
    elapse(1);
    expect(notify).toHaveBeenLastCalledWith(NOT_STOPPED, "error");
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    stopReady();
    fireEvent.click(stopButton() as HTMLElement);
    await settle();
    expect(agents.interrupt).toHaveBeenCalledTimes(2);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    stopPending();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("does not let an older stop's timeout overwrite a newer stop of the same agent", async () => {
  const f = fixture();
  const agents = hosted(true);
  const view = render(<ActivityAccessory {...f.props} agents={agents} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    // The turn ends and the agent starts another before the first timeout.
    elapse(10_000);
    f.send(A, "t", 2, "turn_completed");
    f.send(A, "u", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    fireEvent.click(stopButton() as HTMLElement);
    await settle();
    expect(agents.interrupt).toHaveBeenCalledTimes(2);
    // The first attempt's timeout (30s after it) passes; the second's has not.
    elapse(15_000);
    alive(f, "u", 2);
    elapse(5_000);
    expect(look().getByText("Stopping…")).toBeInTheDocument();
    expect(notStopped()).toBe(0);
    stopPending();
    alive(f, "u", 3);
    elapse(10_000);
    expect(notStopped()).toBe(1);
    stopReady();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("shows nothing later when a stopped hosted turn ends before its 30 seconds", async () => {
  const f = fixture();
  const view = render(<ActivityAccessory {...f.props} agents={hosted(true)} />);
  try {
    f.send(A, "t", 1, "turn_started", { triggeringEventIds: [root] });
    openBubble();
    fireEvent.click(screen.getByRole("button", { name: "Stop Blossom" }));
    await settle();
    elapse(10_000);
    f.send(A, "t", 2, "turn_completed");
    elapse(60_000);
    expect(notStopped()).toBe(0);
    expect(look().queryByText("Stopping…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  } finally {
    view.unmount();
    f.dispose();
  }
});

it("does not re-render the typing replacement for liveness that leaves its agents unchanged", () => {
  const f = fixture();
  const onRender = vi.fn();
  const view = render(
    <Profiler id="replacement" onRender={onRender}>
      <ActivityTypingReplacement {...f.props} />
    </Profiler>,
  );
  try {
    f.send(A, "here", 1, "turn_started", { triggeringEventIds: [root] });
    const renders = onRender.mock.calls.length;
    f.send(A, "here", 2, "turn_liveness");
    f.send(A, "here", 3, "turn_liveness");
    expect(onRender).toHaveBeenCalledTimes(renders);
    f.send(B, "there", 1, "turn_started", { triggeringEventIds: [root] });
    expect(onRender.mock.calls.length).toBeGreaterThan(renders);
  } finally {
    view.unmount();
    f.dispose();
  }
});
