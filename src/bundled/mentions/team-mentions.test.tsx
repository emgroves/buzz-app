// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MentionCompletion } from "./MentionCompletion";
import { MentionPicker } from "./MentionPicker";
import { mentionQuery } from "./mention-query";
import { useMentionChoices } from "./use-mention-choices";
import { useTeamMentions } from "./use-team-mentions";
import { createAgentLibrary } from "../../features/agents/library";
import { createAgentChoices } from "../../features/agents/choices";
import { ComposerCompletions } from "../../features/conversation/ComposerCompletions";
import type {
  ComposerCompletion,
  CompletionResult,
} from "../../features/conversation/contracts";
import type { CompletionEditor } from "../../features/conversation/useCompletionEditor";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import type { MentionRecipient } from "../../features/messages/mention-draft";
import { SelectedMentionContext } from "../../features/messages/selected-mention-context";
import type { RelaySession } from "../../features/relay/session";
import type { Contribution } from "../../plugins/contributions";
import * as personMatch from "../../features/search/person-match";

// jsdom lacks scrollIntoView; the search highlight keeps its row in view.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.restoreAllMocks();
});

function fixture({
  count = 1,
  loading = false,
  failure = false,
  dm = false,
  team = 1,
} = {}) {
  const people = Array.from({ length: count }, (_, i) => ({
    pubkey: (i + 1).toString(16).padStart(64, "0"),
    name: `Person ${String(i).padStart(2, "0")}`,
  }));
  const agent = people[0];
  if (!agent) throw new Error("Fixture needs at least one person");
  const teamAgents = people.slice(0, team);
  const read = vi.fn(async () => ({
    definitions: [],
    identities: teamAgents,
  }));
  if (failure) read.mockRejectedValueOnce(new Error("temporary read failure"));
  const library = createAgentLibrary(read);
  const choices = createAgentChoices({
    scope: "test",
    library: library.queries,
    signal: new AbortController().signal,
  });
  const profiles = new Map(people.map((p) => [p.pubkey, { name: p.name }]));
  let list: ReturnType<RelaySession["channels"]["list"]> = {
    status: "ready",
    channels: [
      {
        id: "parent",
        name: "Parent",
        channelType: dm ? "dm" : "stream",
        members: failure ? [] : people.map((p) => p.pubkey),
      },
    ],
  };
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const archives = { status: "ready" as const, archived: [] };
  const entries: ReturnType<
    NonNullable<RelaySession["channelKit"]>["snapshot"]
  >["entries"] = [
    {
      eventId: "head",
      createdAt: 1,
      record: {
        version: 1,
        community: "fixture",
        deleted: false,
        value: {
          type: "team",
          id: "team",
          name: "Team",
          agents: teamAgents.map((person) => person.pubkey),
        },
      },
    },
  ];
  let catalog: ReturnType<NonNullable<RelaySession["channelKit"]>["snapshot"]> =
    { status: loading ? "loading" : "ready", entries: loading ? [] : entries };
  const none = () => () => {};
  const session = {
    unread: undefined,
    directMessages: {
      people: vi.fn(async () => ({ people: [], hasMore: false })),
    },
    archives: {
      snapshot: () => archives,
      subscribe: none,
      ensure: async () => {},
      refresh: async () => {},
      state: () => "not-archived",
    },
    channels: {
      list: () => list,
      subscribeList: subscribe,
      ensureList: () => {},
    },
    profiles: {
      snapshot: () => profiles,
      subscribe: none,
      ensure: async () => {},
    },
    names: { subscribe: none, snapshot: () => 0, scope: () => () => undefined },
    agentLibrary: library.queries,
    agentChoices: choices,
    media: () => undefined,
    channelKit: {
      available: true,
      snapshot: () => catalog,
      subscribe,
      ensure() {},
      async refresh() {},
      async save() {
        return "head";
      },
    },
  } as unknown as RelaySession;
  return {
    session,
    people,
    agent,
    read,
    library,
    loaded() {
      act(() => {
        catalog = { status: "ready", entries };
        listeners.forEach((f) => {
          f();
        });
      });
    },
    remove(notify = true) {
      act(() => {
        list = {
          ...list,
          channels: list.channels.map((c) => ({ ...c, members: [] })),
        };
        if (notify)
          listeners.forEach((f) => {
            f();
          });
      });
    },
    notify() {
      act(() => {
        listeners.forEach((f) => {
          f();
        });
      });
    },
    /** Replace the channel summary, as a new message or metadata change does. */
    update(patch: Partial<(typeof list.channels)[number]>) {
      act(() => {
        list = {
          ...list,
          channels: list.channels.map((c) => ({ ...c, ...patch })),
        };
        listeners.forEach((f) => {
          f();
        });
      });
    },
  };
}

function inline(session: RelaySession, inviteAgents = false) {
  const publish = vi.fn();
  const props = {
    session,
    scope: "test",
    channelId: "parent",
    inviteAgents,
    publish,
    observation: { revision: 1, text: "@", start: 1, end: 1 },
    query: { start: 0, end: 1, query: "" },
  };
  const view = render(<MentionCompletion {...props} />);
  const result = () => publish.mock.lastCall?.[0] as CompletionResult;
  return {
    view,
    props,
    result,
    team: () => result()?.items.find((i) => i.id === "team:team"),
  };
}

it("late teams preserve the highlighted recipient and all 50 installed people", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const h = fixture({ count: 50, loading: true });
  const replace = vi.fn(
    (_edit: CompletionResult["items"][number]["edit"]) => true,
  );
  const provider: Contribution<ComposerCompletion> = {
    id: "typeahead",
    key: "buzz.mentions/typeahead",
    pluginId: "buzz.mentions",
    revision: "1",
    title: "Mention",
    match: ({ text, start }) => mentionQuery(text, start),
    component: MentionCompletion,
  };
  const providers = [provider];
  const input = document.createElement(
    "div",
  ) as unknown as ComposerInputElement;
  document.body.append(input);
  const editor = {
    observation: { revision: 1, text: "@", start: 1, end: 1 },
    valid: () => true,
    observe() {},
    invalidate() {},
    keys: { current: undefined },
    composing: { current: false },
  } as unknown as CompletionEditor;
  const view = render(
    <ComposerCompletions
      registry={{ snapshot: () => providers, subscribe: () => () => {} }}
      editor={editor}
      input={{ current: input }}
      replace={replace}
      resolved={{ text: "@", recipients: [] }}
      session={h.session}
      scope="test"
      channelId="parent"
    />,
  );
  const press = (key: string) =>
    act(() =>
      editor.keys.current?.({
        key,
        nativeEvent: {},
        preventDefault() {},
        stopPropagation() {},
      } as Parameters<NonNullable<CompletionEditor["keys"]["current"]>>[0]),
    );
  try {
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(50));
    const initial = screen.getAllByRole("option").map((row) => row.textContent);
    press("ArrowUp");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
      "Person 49",
    );
    h.loaded();
    await waitFor(() => expect(h.read).toHaveBeenCalledOnce());
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(
      initial,
    );
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
      "Person 49",
    );
    press("Enter");
    expect(replace.mock.lastCall?.[0]).toEqual({ mention: h.people[49] });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Narrow your search",
      ),
    );
  } finally {
    view.unmount();
    input.remove();
    h.library.dispose();
  }
});

it("late directory people do not displace a team already filling the shared budget", async () => {
  const h = fixture({ count: 49 });
  let resolve!: (value: {
    people: { pubkey: string; name: string }[];
    hasMore: boolean;
  }) => void;
  const people = vi.fn(
    () =>
      new Promise<{
        people: { pubkey: string; name: string }[];
        hasMore: boolean;
      }>((done) => {
        resolve = done;
      }),
  );
  const session = {
    ...h.session,
    directMessages: { ...h.session.directMessages, people },
  };
  const menu = inline(session);
  try {
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    expect(menu.result().items).toHaveLength(50);
    const ids = menu.result().items.map((item) => item.id);
    await waitFor(() => expect(people).toHaveBeenCalledOnce());
    await act(async () =>
      resolve({
        people: [{ pubkey: "f".repeat(64), name: "Zed" }],
        hasMore: false,
      }),
    );
    expect(menu.result().items.map((item) => item.id)).toEqual(ids);
    expect(menu.team()?.canSelect?.("Enter")).toBe(true);
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("teams retain installed membership through rerenders and stale acceptance until a new query", async () => {
  const h = fixture();
  const menu = inline(h.session, true);
  try {
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    const stale = menu.team();
    if (!stale) throw new Error("Expected team choice");
    // Revoke membership before React sees the new roster: acceptance must reread it.
    h.remove(false);
    expect(stale.canSelect?.("Enter")).toBe(false);
    h.notify();
    expect(menu.team()?.disabled).toContain("membership changed");
    expect(menu.team()?.canSelect?.("Enter")).toBe(false);
    expect(menu.team()?.edit.mentions).toBeUndefined();
    expect(
      menu.result().items.find((i) => i.id === h.agent.pubkey)?.disabled,
    ).toContain("membership changed");
    menu.view.rerender(
      <MentionCompletion
        {...menu.props}
        query={{ start: 0, end: 3, query: "Te" }}
      />,
    );
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    expect(menu.team()?.detail).toContain("Adds 1");
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("a team pick in an agents-only audience replaces the audience with the team", async () => {
  const h = fixture({ count: 2, team: 2 }),
    user = userEvent.setup(),
    only = vi.fn();
  const view = render(
    <MentionPicker
      session={h.session}
      scope="test"
      channelId="parent"
      disabled={false}
      inviteAgents
      audience={{ recipients: [], named: false, only, toggle: vi.fn() }}
      select={() => true}
      selectTeam={() => true}
    />,
  );
  try {
    await user.click(screen.getByRole("button", { name: "Choose agent" }));
    const team = await screen.findByRole("button", {
      name: /Team.*Saved team/,
    });
    await waitFor(() => expect(team).toBeEnabled());
    await user.click(team);
    const [first, second] = [
      { pubkey: "1".padStart(64, "0"), name: "Person 00" },
      { pubkey: "2".padStart(64, "0"), name: "Person 01" },
    ];
    expect(only).toHaveBeenCalledExactlyOnceWith([first, second]);
    await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
  } finally {
    view.unmount();
    h.library.dispose();
  }
});

it("the team picker disables a removed member until reopened", async () => {
  const h = fixture(),
    user = userEvent.setup(),
    selectTeam = vi.fn(() => true);
  const view = render(
    <MentionPicker
      session={h.session}
      scope="test"
      channelId="parent"
      disabled={false}
      inviteAgents
      select={() => true}
      selectTeam={selectTeam}
    />,
  );
  try {
    const trigger = screen.getByRole("button", { name: "Mention a member" });
    await user.click(trigger);
    const team = await screen.findByRole("button", {
      name: /Team.*Saved team/,
    });
    await waitFor(() => expect(team).toBeEnabled());
    h.remove();
    expect(team).toBeDisabled();
    expect(team).toHaveTextContent("membership changed");
    await user.click(team);
    expect(selectTeam).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await user.click(trigger);
    const reopened = await screen.findByRole("button", {
      name: /Team.*Saved team/,
    });
    expect(reopened).toBeEnabled();
    await user.click(reopened);
    expect(selectTeam).toHaveBeenCalledWith([h.agent]);
  } finally {
    view.unmount();
    h.library.dispose();
  }
});

it.each([false, true])(
  "inline Retry recovers the team inventory (DM: %s)",
  async (dm) => {
    const h = fixture({ failure: true, dm });
    const menu = inline(h.session);
    try {
      await waitFor(() =>
        expect(menu.result()?.status).toBe(
          "Could not load agents. Retry to refresh.",
        ),
      );
      expect(menu.team()?.disabled).toContain("unavailable");
      act(() => menu.result().retry?.());
      await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
      expect(menu.team()?.edit.mentions).toEqual([h.agent]);
    } finally {
      menu.view.unmount();
      h.library.dispose();
    }
  },
);

it.each([false, true])(
  "picker Retry recovers a selectable team (DM: %s)",
  async (dm) => {
    const h = fixture({ failure: true, dm }),
      user = userEvent.setup(),
      selectTeam = vi.fn(() => true);
    const view = render(
      <MentionPicker
        session={h.session}
        scope="test"
        channelId="parent"
        disabled={false}
        select={() => true}
        selectTeam={selectTeam}
      />,
    );
    try {
      await user.click(
        screen.getByRole("button", { name: "Mention a member" }),
      );
      const retry = await screen.findByRole("button", {
        name: "Retry agent list",
      });
      expect(
        screen.getByRole("button", { name: /Team.*unavailable/ }),
      ).toBeDisabled();
      await user.click(retry);
      await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
      const team = await screen.findByRole("button", {
        name: /Team.*Saved team/,
      });
      expect(team).toBeEnabled();
      await user.click(team);
      expect(selectTeam).toHaveBeenCalledWith([h.agent]);
    } finally {
      view.unmount();
      h.library.dispose();
    }
  },
);

it("reserves room for teams ready when the first 50-choice budget installs", async () => {
  const h = fixture({ count: 50 });
  const menu = inline(h.session);
  try {
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    expect(menu.result().items).toHaveLength(50);
    expect(
      menu
        .result()
        .items.slice(0, 49)
        .map((item) => item.id),
    ).toEqual(h.people.slice(0, 49).map((person) => person.pubkey));
    expect(menu.result().items[49]?.id).toBe("team:team");
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("waits for the initial roster before installing team membership facts", async () => {
  const h = fixture();
  let pending = true;
  const loading: ReturnType<RelaySession["channels"]["list"]> = {
    status: "loading",
    channels: [],
  };
  const session = {
    ...h.session,
    channels: {
      ...h.session.channels,
      list: () => (pending ? loading : h.session.channels.list()),
    },
  };
  const menu = inline(session, true);
  try {
    await waitFor(() =>
      expect(h.session.agentChoices.snapshot().status).toBe("ready"),
    );
    expect(menu.team()).toBeUndefined();
    pending = false;
    h.notify();
    await waitFor(() => expect(menu.team()?.canSelect?.("Enter")).toBe(true));
    const stale = menu.team();
    h.remove();
    expect(menu.team()?.disabled).toContain("membership changed");
    expect(stale?.canSelect?.("Enter")).toBe(false);
  } finally {
    menu.view.unmount();
    h.library.dispose();
  }
});

it("a closed chooser reads no member while its composer rerenders", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const h = fixture({ count: 300 });
  const members = new Set(h.people.map((person) => person.pubkey));
  const get = vi.spyOn(h.session.profiles.snapshot(), "get");
  const memberReads = () =>
    get.mock.calls.filter(([key]) => members.has(key)).length;
  const picker = (select: () => boolean) => (
    <MentionPicker
      session={h.session}
      scope="test"
      channelId="parent"
      disabled={false}
      select={select}
      selectTeam={() => true}
    />
  );
  const view = render(picker(() => true));
  // Each keystroke rerenders the composer and its closed chooser.
  for (let key = 0; key < 5; key++) view.rerender(picker(() => true));
  expect(memberReads()).toBe(0);
  await userEvent.click(
    screen.getByRole("button", { name: "Mention a member" }),
  );
  expect(memberReads()).toBeGreaterThan(0);
});

it("an @ keystroke reuses the name index across draft and team rerenders", async () => {
  const h = fixture({ count: 300 });
  const starts = vi.spyOn(personMatch, "nameStarts");
  function Chooser({ query }: { query: string }) {
    const model = useMentionChoices(h.session, "parent", false, query, "open");
    // Shown team rows read candidates with their own directory.
    useTeamMentions(h.session, "parent", false, query, model);
    return null;
  }
  // The draft builds a new recipient array on every edit.
  const draft = (query: string, selected: readonly MentionRecipient[]) => (
    <SelectedMentionContext.Provider value={selected}>
      {/* Inline completion remounts on every keystroke. */}
      <Chooser key={query} query={query} />
    </SelectedMentionContext.Provider>
  );
  vi.useFakeTimers();
  // Each settled directory search finds nobody.
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  const view = render(draft("te", []));
  await settle();
  expect(h.session.directMessages.people).toHaveBeenCalled();
  expect(starts).toHaveBeenCalled();
  starts.mockClear();
  view.rerender(draft("tea", []));
  await settle();
  view.rerender(draft("team", []));
  await settle();
  expect(starts).not.toHaveBeenCalled();
  // A different selection is a different naming fact.
  view.rerender(draft("team", [{ pubkey: "f".repeat(64), name: "Picked" }]));
  expect(starts).toHaveBeenCalled();
  view.unmount();
  h.library.dispose();
});

it("directory pages rebuild the name index only for people they add", async () => {
  const h = fixture({ count: 300 });
  const profiles = h.session.profiles.snapshot();
  // Naming knows every profile, as the real service does.
  Object.assign(h.session, {
    names: {
      subscribe: () => () => {},
      snapshot: () => 0,
      scope: () => (key: string) => {
        const name = profiles.get(key)?.name;
        return name ? { name, source: "public-profile" } : undefined;
      },
    },
  });
  const members = h.people.slice(1, 4);
  const outsider = { pubkey: "e".repeat(64), name: "Teal Outsider" };
  let page = members;
  // Every settled search returns a new array. Pages are truncated so each
  // keystroke reads rather than deriving from the complete `p` page.
  vi.mocked(h.session.directMessages.people).mockImplementation(async () => ({
    people: [...page],
    hasMore: true,
  }));
  const starts = vi.spyOn(personMatch, "nameStarts");
  function Chooser({ query }: { query: string }) {
    const model = useMentionChoices(h.session, "parent", false, query, "open");
    useTeamMentions(h.session, "parent", false, query, model);
    return null;
  }
  vi.useFakeTimers();
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  // Inline completion remounts on every keystroke.
  const type = async (query: string) => {
    view.rerender(<Chooser key={query} query={query} />);
    await settle();
  };
  const view = render(<Chooser key="p" query="p" />);
  await settle();
  starts.mockClear();
  // Pages of members change no row.
  await type("pe");
  await type("per");
  expect(h.session.directMessages.people).toHaveBeenCalledTimes(3);
  expect(starts).not.toHaveBeenCalled();
  // An outsider is a new choice set: one rebuild, then reused while it stays.
  page = [...members, outsider];
  await type("pers");
  expect(starts).toHaveBeenCalledTimes(301);
  starts.mockClear();
  await type("perso");
  await type("person");
  expect(starts).not.toHaveBeenCalled();
  view.unmount();
  h.library.dispose();
});

it("an open chooser relabels choices when only names change", async () => {
  const h = fixture();
  let name = "Before";
  let revision = 0;
  const listeners = new Set<() => void>();
  Object.assign(h.session, {
    names: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => revision,
      scope: () => () => ({ name, source: "agent-directory" }),
    },
  });
  function Chooser() {
    const model = useMentionChoices(h.session, "parent", false, "", "open");
    return <>{model.candidates.map((choice) => choice.label).join(",")}</>;
  }
  render(<Chooser />);
  await waitFor(() => expect(screen.getByText("Before")).toBeInTheDocument());
  act(() => {
    name = "After";
    revision++;
    for (const listener of listeners) listener();
  });
  expect(screen.getByText("After")).toBeInTheDocument();
  h.library.dispose();
});

it("keeps a closed chooser quiet when a message only changes the channel preview", () => {
  const h = fixture();
  let renders = 0;
  let members: readonly string[] | undefined;
  function Chooser() {
    renders++;
    members = useMentionChoices(h.session, "parent", false, "", "closed", false)
      .channel?.members;
    return null;
  }
  render(<Chooser />);
  const settled = renders;
  h.update({ preview: "New message", lastActivityAt: 2 });
  h.update({ preview: "Another message", lastActivityAt: 3 });
  expect(renders).toBe(settled);
  h.update({ members: [h.agent.pubkey, "f".repeat(64)] });
  expect(renders).toBe(settled + 1);
  expect(members).toEqual([h.agent.pubkey, "f".repeat(64)]);
  h.library.dispose();
});
