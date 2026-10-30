// @vitest-environment jsdom
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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { MessageReactionControls, MessageReactions } from "./MessageReactions";
import { profileTarget } from "../profiles/target";
import { PREVIEW_REST_MS } from "../../shared/design-system/ui/hoverIntent";
import { createRelaySession } from "../relay/session";
import {
  flush,
  keypair,
  message,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "../relay/testing";
import type { LiveCallbacks } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import type {
  ComposerTool,
  ContributionReader,
  InlineRenderer,
  ReactionToolProps,
} from "../conversation/contracts";
import { PublishRejected } from "../relay/outbox";
import { type ComponentProps, useSyncExternalStore } from "react";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const owners: { dispose(): void }[] = [];
const observers = new Set<{
  callback: IntersectionObserverCallback;
  rows: Set<Element>;
}>();
beforeEach(() => {
  // jsdom hides [popover] but does not implement showPopover. Model opening
  // for content assertions; browser tests cover top-layer painting and clipping.
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  // jsdom has no layout: tests decide which reactor rows scroll into view.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      rows = new Set<Element>();
      constructor(readonly callback: IntersectionObserverCallback) {
        observers.add(this);
      }
      observe(row: Element) {
        this.rows.add(row);
      }
      unobserve(row: Element) {
        this.rows.delete(row);
      }
      disconnect() {
        observers.delete(this);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  observers.clear();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
/** Scrolls these rows of the full reaction list into view. */
function reveal(rows: readonly Element[]) {
  act(() => {
    for (const observer of [...observers])
      observer.callback(
        rows
          .filter((row) => observer.rows.has(row))
          .map(
            (target) =>
              ({ target, isIntersecting: true }) as IntersectionObserverEntry,
          ),
        observer as unknown as IntersectionObserver,
      );
  });
}
const registry = <T,>(
  entries: ReturnType<ContributionReader<T>["snapshot"]>,
): ContributionReader<T> => ({
  snapshot: () => entries,
  subscribe: () => () => {},
});
const inline = registry<InlineRenderer>([]);
const tools = registry<ComposerTool>([]);
const root = message(other, "c", "Message", 1);
const react = (key = viewer, time = 2) =>
  signed(key, {
    kind: 7,
    content: "👍",
    created_at: time,
    tags: [
      ["h", "c"],
      ["e", root.id],
    ],
  });
const customReaction = (key: typeof viewer, code: string, url: string) =>
  signed(key, {
    kind: 7,
    content: `:${code}:`,
    created_at: 2,
    tags: [
      ["h", "c"],
      ["e", root.id],
      ["emoji", code, url],
    ],
  });
function harness(
  events: RelayEvent[] = [],
  publish = vi.fn(async (_event: RelayEvent) => {}),
  pickerTools = tools,
  media?: (url: string, size?: "small") => string | undefined,
) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      ...(media ? { media } : {}),
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  live.receive([roster(relay, "c", [viewer.pubkey], 1), root, ...events]);
  function Controls({
    disabled = false,
    onFocusedRemoval,
    audience,
    ...reactors
  }: Pick<
    ComponentProps<typeof MessageReactions>,
    "agentPubkeys" | "onOpenLink" | "canOpenLink"
  > & {
    audience?: "agents";
    disabled?: boolean;
    onFocusedRemoval?: () => void;
  }) {
    const state = useSyncExternalStore(
      (fn) => owner.session.channels.subscribeWindow("c", fn),
      () => owner.session.channels.window("c"),
    );
    const row = state.rows[0];
    return (
      row && (
        <>
          <MessageReactionControls
            row={audience ? { ...row, audience } : row}
            session={owner.session}
            scope="test"
            disabled={disabled}
            tools={pickerTools}
            inline={inline}
          />
          <MessageReactions
            {...reactors}
            {...(onFocusedRemoval ? { onFocusedRemoval } : {})}
            row={audience ? { ...row, audience } : row}
            session={owner.session}
            scope="test"
            disabled={disabled}
            tools={pickerTools}
            inline={inline}
          />
        </>
      )
    );
  }
  return { ...owner, live, wire, publish, Controls };
}
it("shows one bubble per emoji, counts unique people, and removes all my duplicate events", async () => {
  const mine = react(),
    duplicate = react(viewer, 3),
    theirs = react(other);
  const h = harness([mine, duplicate, theirs]);
  render(<h.Controls />);
  expect(
    screen.getAllByRole("button", { name: /React with|Remove/ }),
  ).toHaveLength(3);
  expect(
    screen.getByTestId("reaction-row").querySelectorAll("[data-reaction]"),
  ).toHaveLength(1);
  const own = screen.getByRole("button", {
    name: "👍: 2 people",
  });
  expect(own.getAttribute("aria-pressed")).toBe("true");
  expect(own.textContent).toBe("👍2");
  fireEvent.mouseEnter(own);
  fireEvent.mouseMove(own);
  const preview = await screen.findByRole("tooltip", {}, { timeout: 2500 });
  expect(preview.textContent).toContain("You");
  expect(preview.textContent).toContain(other.pubkey.slice(0, 10));
  fireEvent.click(own);
  const operation = h.session.outbox?.snapshot()[0];
  expect(operation?.event).toMatchObject({
    kind: 5,
    tags: expect.arrayContaining([
      ["e", mine.id],
      ["e", duplicate.id],
    ]),
  });
  expect(operation?.event.tags).not.toContainEqual(["e", theirs.id]);
  expect(
    screen
      .getByRole("button", { name: `👍: ${other.pubkey.slice(0, 10)}` })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  await act(async () => {
    await flush();
    await flush();
  });
});
it("keeps one bubble and focus when the count crosses the former grouping threshold", async () => {
  const others = Array.from({ length: 8 }, () => keypair());
  const h = harness(others.map((person) => react(person)));
  const onFocusedRemoval = vi.fn();
  render(<h.Controls onFocusedRemoval={onFocusedRemoval} />);
  const pills = () =>
    screen.getByTestId("reaction-row").querySelectorAll("[data-reaction]");
  expect(pills()).toHaveLength(1);
  // A second event from one person must not increase the count.
  act(() => h.live.receive([react(others[0], 3)]));
  expect(pills()).toHaveLength(1);
  expect(screen.getByRole("button", { name: "👍: 8 people" }).textContent).toBe(
    "👍8",
  );
  act(() => h.live.receive([react()]));
  expect(pills()).toHaveLength(1);
  const group = screen.getByRole("button", { name: "👍: 9 people" });
  expect(group.textContent).toBe("👍9");
  expect(group.getAttribute("aria-pressed")).toBe("true");
  act(() => group.focus());
  const preview = await screen.findByRole("dialog", { name: "👍 reactions" });
  expect(preview.textContent).toContain("You");
  for (const person of others.slice(0, 2))
    expect(preview.textContent).toContain(person.pubkey.slice(0, 10));
  expect(preview.textContent).toContain("and 6 others");
  for (const person of others.slice(2))
    expect(preview.textContent).not.toContain(person.pubkey.slice(0, 10));
  fireEvent.click(group);
  expect(pills()).toHaveLength(1);
  expect(document.activeElement).toBe(group);
  expect(onFocusedRemoval).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()[0]?.event.kind).toBe(5);
  await act(async () => {
    await flush();
    await flush();
  });
});

it.each([
  [3, null],
  [4, "and 1 other"],
  [5, "and 2 others"],
] as const)(
  "pluralizes the preview remainder for %i reactors",
  async (count, remainder) => {
    const people = Array.from({ length: count }, () => keypair());
    const h = harness(people.map((person) => react(person)));
    render(<h.Controls />);
    act(() =>
      screen.getByRole("button", { name: `👍: ${count} people` }).focus(),
    );
    // A preview with a remainder link is a named dialog; otherwise a tooltip.
    const preview = remainder
      ? await screen.findByRole("dialog", { name: "👍 reactions" })
      : await screen.findByRole("tooltip");
    if (remainder)
      expect(
        within(preview).getByRole("button", { name: remainder }),
      ).toBeTruthy();
    else expect(within(preview).queryByText(/^and /)).toBeNull();
  },
);

it("lists everyone in a grouped reaction, loading names as rows scroll in", async () => {
  const named = keypair(),
    blocked = keypair(),
    agent = keypair();
  const people = [
    named,
    blocked,
    agent,
    ...Array.from({ length: 7 }, () => keypair()),
  ];
  // My later reaction is listed first; a duplicate never lists its author twice.
  const h = harness([
    ...people.map((person, index) => react(person, 2 + index)),
    react(named, 20),
    react(viewer, 21),
  ]);
  const onOpenLink = vi.fn((_target: string) => true);
  render(
    <h.Controls
      agentPubkeys={new Set([agent.pubkey])}
      onOpenLink={onOpenLink}
      canOpenLink={(target) => target !== profileTarget(blocked.pubkey)}
    />,
  );
  const group = screen.getByRole("button", { name: "👍: 11 people" });
  fireEvent.mouseEnter(group);
  fireEvent.mouseMove(group);
  const preview = await screen.findByRole(
    "dialog",
    { name: "👍 reactions" },
    { timeout: 2500 },
  );
  fireEvent.click(
    within(preview).getByRole("button", { name: "and 8 others" }),
  );
  const list = await screen.findByRole("menu", {
    name: "Everyone who reacted with 👍",
  });
  const items = within(list).getAllByRole("menuitem");
  const expected = ["You", ...people.map((_, index) => `Person ${index}`)];
  expect(items).toHaveLength(expected.length);
  const profileReads = () =>
    h.wire.pending.filter((entry) => entry.filters[0]?.kinds?.includes(0));
  // Profile reads run one at a time, so answer each as it is issued.
  const resolve = async (names: readonly string[]) => {
    const resolved = () =>
      names.every(
        (name) =>
          within(list).queryAllByRole("menuitem", { name }).length === 1,
      );
    for (let read = 0; read < 10 && !resolved(); read++)
      await act(async () => {
        for (const entry of profileReads())
          entry.respond(
            people.flatMap((person, index) =>
              entry.filters[0]?.authors?.includes(person.pubkey)
                ? [profile(person, { name: `Person ${index}` })]
                : [],
            ),
          );
        await flush();
      });
    expect(resolved()).toBe(true);
  };
  reveal(items.slice(0, 5));
  await resolve(expected.slice(0, 5));
  // Rows out of view load nothing until they scroll in.
  const requested = profileReads().flatMap(
    (entry) => entry.filters[0]?.authors ?? [],
  );
  for (const person of people.slice(4))
    expect(requested).not.toContain(person.pubkey);
  reveal(items.slice(5));
  await resolve(expected);
  for (const [index, name] of expected.entries())
    expect(within(list).getByRole("menuitem", { name })).toBe(items[index]);
  const [, human, refused, agentRow] = items;
  if (!human || !refused || !agentRow) throw new Error("Expected reactor rows");
  expect(refused.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(refused);
  expect(onOpenLink).not.toHaveBeenCalled();
  expect(
    agentRow
      .querySelector("[data-avatar-shape]")
      ?.getAttribute("data-avatar-shape"),
  ).toBe("squircle");
  fireEvent.click(agentRow);
  expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(
    profileTarget(agent.pubkey, { agent: true }),
  );
  expect(onOpenLink.mock.calls[0]?.[0]).toMatch(/^buzz:agent-profile:/);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.click(
    within(
      await screen.findByRole("dialog", { name: "👍 reactions" }),
    ).getByRole("button", { name: "and 8 others" }),
  );
  fireEvent.click(
    within(await screen.findByRole("menu")).getByRole("menuitem", {
      name: "Person 0",
    }),
  );
  expect(onOpenLink).toHaveBeenLastCalledWith(profileTarget(named.pubkey));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

it("says when names in the full list could not load and retries on reopening", async () => {
  const people = Array.from({ length: 9 }, () => keypair());
  const h = harness(people.map((person, index) => react(person, 2 + index)));
  render(<h.Controls />);
  const group = screen.getByRole("button", { name: "👍: 9 people" });
  const last = people.at(-1)?.pubkey ?? "";
  const reads = () =>
    h.wire.pending.filter((entry) => entry.filters[0]?.authors?.includes(last));
  // Profile reads run one at a time: answer the preview's until the list's runs.
  const open = async (count: number) => {
    const preview = await screen.findByRole("dialog", { name: "👍 reactions" });
    fireEvent.click(
      within(preview).getByRole("button", { name: "and 6 others" }),
    );
    const list = await screen.findByRole("menu");
    reveal(within(list).getAllByRole("menuitem"));
    for (let read = 0; read < 10 && reads().length < count; read++)
      await act(async () => {
        for (const entry of h.wire.pending)
          if (
            entry.filters[0]?.kinds?.includes(0) &&
            !entry.filters[0].authors?.includes(last)
          )
            entry.respond([]);
        await flush();
      });
    expect(reads()).toHaveLength(count);
    return list;
  };
  act(() => group.focus());
  const list = await open(1);
  await act(async () => {
    reads()[0]?.fail(new Error("Profiles offline"));
    await flush();
  });
  expect(within(list).getByRole("alert").textContent).toBe(
    "Some names could not load. Reopen this list to try again.",
  );
  expect(within(list).getAllByRole("menuitem")).toHaveLength(9);
  fireEvent.keyDown(list, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await open(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("reaches the full list by keyboard and returns to the emoji on Escape", async () => {
  const user = userEvent.setup();
  const h = harness(
    Array.from({ length: 9 }, (_, index) => react(keypair(), 2 + index)),
  );
  const onOpenLink = vi.fn((_target: string) => true);
  render(<h.Controls onOpenLink={onOpenLink} canOpenLink={() => true} />);
  const group = screen.getByRole("button", { name: "👍: 9 people" });
  act(() => group.focus());
  const preview = await screen.findByRole("dialog", { name: "👍 reactions" });
  await user.keyboard("{Tab}");
  expect(document.activeElement).toBe(
    within(preview).getByRole("button", { name: "and 6 others" }),
  );
  await user.keyboard("{Enter}");
  const list = await screen.findByRole("menu", {
    name: "Everyone who reacted with 👍",
  });
  expect(within(list).getAllByRole("menuitem")).toHaveLength(9);
  await waitFor(() => expect(list.contains(document.activeElement)).toBe(true));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(group));
  // Escape closes one layer: back on the emoji, its preview opens again.
  await screen.findByRole("dialog", { name: "👍 reactions" });
  expect(onOpenLink).not.toHaveBeenCalled();
  expect(h.session.outbox?.snapshot()).toHaveLength(0);
});

it("closes the full list without dropping focus when the group splits", async () => {
  const people = Array.from({ length: 4 }, () => keypair());
  const reactions = people.map((person, index) => react(person, 2 + index));
  const h = harness(reactions);
  render(<h.Controls />);
  const group = screen.getByRole("button", { name: "👍: 4 people" });
  act(() => group.focus());
  const preview = await screen.findByRole("dialog", { name: "👍 reactions" });
  fireEvent.click(within(preview).getByRole("button", { name: "and 1 other" }));
  const list = await screen.findByRole("menu");
  await waitFor(() => expect(list.contains(document.activeElement)).toBe(true));
  // A host that opens no profiles lists names without marking them unavailable.
  for (const item of within(list).getAllByRole("menuitem"))
    expect(item.hasAttribute("data-disabled")).toBe(false);
  // Everyone but the last reactor leaves at once, so the group becomes one emoji.
  act(() =>
    h.live.receive(
      reactions.slice(0, 3).map((removed, index) => {
        const leaving = people[index];
        if (!leaving) throw new Error("Expected a reactor");
        return signed(leaving, {
          kind: 5,
          content: "",
          created_at: 20,
          tags: [["e", removed.id]],
        });
      }),
    ),
  );
  expect(screen.queryByRole("menu")).toBeNull();
  const individual = screen.getAllByRole("button", { name: /^👍:/ });
  expect(individual).toHaveLength(1);
  expect(document.activeElement).toBe(individual[0]);
});

it("keeps custom emoji URLs separate and updates a grouped count when I join", async () => {
  const people = Array.from({ length: 9 }, () => keypair());
  const first = "https://a.test/first.gif";
  const second = "https://a.test/second.gif";
  const h = harness([
    ...people.map((person) => customReaction(person, "party", first)),
    customReaction(other, "party", second),
  ]);
  const onFocusedRemoval = vi.fn();
  render(<h.Controls onFocusedRemoval={onFocusedRemoval} />);
  const group = screen.getByRole("button", { name: ":party:: 9 people" });
  expect(group.getAttribute("aria-pressed")).toBe("false");
  expect(group.querySelector("img")?.getAttribute("src")).toBe(first);
  expect(
    screen
      .getByRole("button", { name: `:party:: ${other.pubkey.slice(0, 10)}` })
      .querySelector("img")
      ?.getAttribute("src"),
  ).toBe(second);
  fireEvent.click(group);
  const joined = screen.getByRole("button", { name: ":party:: 10 people" });
  expect(joined).toBe(group);
  expect(joined.textContent).toBe("10");
  expect(joined.getAttribute("aria-pressed")).toBe("true");
  expect(h.session.outbox?.snapshot()[0]?.event.tags).toContainEqual([
    "emoji",
    "party",
    first,
  ]);
  await act(async () => {
    await flush();
    await flush();
  });
  act(() => joined.focus());
  fireEvent.click(joined);
  expect(screen.getByRole("button", { name: ":party:: 9 people" })).toBe(
    joined,
  );
  expect(document.activeElement).toBe(joined);
  expect(onFocusedRemoval).not.toHaveBeenCalled();
  await act(async () => {
    await flush();
    await flush();
  });
});

it("keeps the same bubble and focus through single and multiple reactor transitions", async () => {
  const others = [other];
  const h = harness([react(other)]);
  render(
    <>
      <button type="button">Elsewhere</button>
      <h.Controls />
    </>,
  );
  const individual = screen.getByRole("button", { name: /^👍:/ });
  if (!individual) throw new Error("Expected an individual reaction");
  act(() => individual.focus());
  fireEvent.click(individual);
  const group = screen.getByRole("button", { name: "👍: 2 people" });
  expect(group).toBe(individual);
  expect(document.activeElement).toBe(group);
  await act(async () => {
    await flush();
    await flush();
  });
  // A live removal takes the count back to one without replacing the control.
  const removedPerson = others[0];
  if (!removedPerson) throw new Error("Expected another reactor");
  const removed = react(removedPerson);
  act(() =>
    h.live.receive([
      signed(removedPerson, {
        kind: 5,
        content: "",
        created_at: 3,
        tags: [["e", removed.id]],
      }),
    ]),
  );
  expect(document.activeElement).toBe(
    screen.getAllByRole("button", { name: /^👍:/ })[0],
  );
  // A live second reactor updates the same focused control.
  act(() => h.live.receive([react(keypair(), 4)]));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "👍: 2 people" }),
  );
  act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
  act(() => h.live.receive([react(keypair(), 5)]));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Elsewhere" }),
  );
});

it("keeps failed first-reaction delivery visible and retries the same event", async () => {
  const publish = vi.fn(async (_event: RelayEvent) => {
    throw new PublishRejected("Nope");
  });
  const h = harness([], publish);
  render(<h.Controls />);
  fireEvent.click(screen.getByRole("button", { name: "React with ❤️" }));
  await act(async () => {
    await flush();
    await flush();
  });
  expect(screen.queryByRole("button", { name: "❤️: You" })).toBeNull();
  const original = publish.mock.calls[0]?.[0];
  publish.mockImplementation(async () => undefined as never);
  fireEvent.click(screen.getByRole("button", { name: "Retry reaction" }));
  await act(async () => {
    await flush();
    await flush();
  });
  expect(publish.mock.calls[1]?.[0]).toEqual(original);
});
it("prevents duplicate submissions and unavailable-message actions", async () => {
  const h = harness();
  const view = render(<h.Controls disabled />);
  fireEvent.click(screen.getByRole("button", { name: "React with 👍" }));
  expect(h.session.outbox?.snapshot()).toHaveLength(0);
  view.rerender(<h.Controls />);
  const button = screen.getByRole("button", { name: "React with 👍" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(h.session.outbox?.snapshot()).toHaveLength(1);
  await act(async () => {
    await flush();
    await flush();
  });
});

it("keeps emojis visually active but rejects another click while delivery is pending or failed", async () => {
  let release!: () => void;
  const publish = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const h = harness([react(other)], publish);
  render(<h.Controls />);
  fireEvent.click(
    screen.getByRole("button", { name: `👍: ${other.pubkey.slice(0, 10)}` }),
  );
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  const pill = screen.getByRole("button", {
    name: "👍: 2 people",
  });
  expect(pill.getAttribute("aria-disabled")).toBe("true");
  expect(pill.hasAttribute("disabled")).toBe(false);
  fireEvent.click(pill);
  expect(h.session.outbox?.snapshot()).toHaveLength(1);
  await act(async () => {
    release();
    await flush();
    await flush();
  });
  expect(pill.getAttribute("aria-disabled")).toBe("false");

  const failed = harness(
    [react(other)],
    vi.fn(async () => {
      throw new PublishRejected("Nope");
    }),
  );
  const failedView = render(<failed.Controls />);
  fireEvent.click(
    within(failedView.container).getByRole("button", {
      name: `👍: ${other.pubkey.slice(0, 10)}`,
    }),
  );
  await act(async () => {
    await flush();
    await flush();
  });
  const failedPill = within(failedView.container)
    .getByTestId("reaction-row")
    .querySelector("button[data-reaction]");
  if (!failedPill) throw new Error("Reaction missing");
  expect(failedPill.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(failedPill);
  expect(failed.session.outbox?.snapshot()).toHaveLength(1);
});

it("uses the picker catalog URL even when an old URL has my reaction", async () => {
  const oldUrl = "https://a.test/old.png";
  const newUrl = "https://a.test/new.png";
  const pickerTools = registry<ComposerTool>([
    {
      key: "picker",
      pluginId: "picker",
      revision: "one",
      id: "picker",
      title: "Picker",
      component: () => null,
      reactionComponent: ({ select }: ReactionToolProps) => (
        <button type="button" onClick={() => select(":party:")}>
          Choose party
        </button>
      ),
    },
  ]);
  const h = harness(
    [customReaction(viewer, "party", oldUrl)],
    undefined,
    pickerTools,
  );
  h.live.receive([
    signed(other, {
      kind: 30030,
      content: "",
      created_at: 3,
      tags: [
        ["d", "buzz:custom-emoji"],
        ["emoji", "party", newUrl],
      ],
    }),
  ]);
  render(<h.Controls />);
  fireEvent.click(
    within(screen.getByTestId("inline-add-reaction")).getByRole("button", {
      name: "Choose party",
    }),
  );
  const operation = h.session.outbox?.snapshot()[0];
  expect(operation?.event.kind).toBe(7);
  expect(operation?.event.tags).toContainEqual(["emoji", "party", newUrl]);
  const parties = screen.getAllByRole("button", {
    name: ":party:: You",
  });
  expect(parties).toHaveLength(2);
  expect(parties[0]?.querySelector("img")?.getAttribute("src")).toBe(oldUrl);
  expect(parties[1]?.querySelector("img")?.getAttribute("src")).toBe(newUrl);
  await act(async () => {
    await flush();
    await flush();
  });
});

it("uses the original animated emoji in reaction emojis and previews", async () => {
  const url = "https://a.test/eyes-intensifies.gif";
  const media = vi.fn((source: string, size?: "small") =>
    size === "small" ? source.replace(/\.gif$/, ".thumb.jpg") : source,
  );
  const h = harness(
    [customReaction(other, "eyes-intensifies", url)],
    undefined,
    tools,
    media,
  );
  render(<h.Controls />);
  const pill = screen.getByRole("button", {
    name: `:eyes-intensifies:: ${other.pubkey.slice(0, 10)}`,
  });
  expect(pill.querySelector("img")?.getAttribute("src")).toBe(url);
  fireEvent.mouseEnter(pill);
  fireEvent.mouseMove(pill);
  const preview = await screen.findByRole("tooltip", {}, { timeout: 2500 });
  expect(preview.querySelector("img")?.getAttribute("src")).toBe(url);
  expect(media).not.toHaveBeenCalledWith(url, "small");
});

it("loads names for people who only reacted after a preview opens", async () => {
  const h = harness([react(other)]);
  render(<h.Controls />);
  const pill = screen.getByRole("button", {
    name: `👍: ${other.pubkey.slice(0, 10)}`,
  });
  fireEvent.mouseEnter(pill);
  fireEvent.mouseMove(pill);
  await screen.findByText(other.pubkey.slice(0, 10), {}, { timeout: 2500 });
  await waitFor(() =>
    expect(
      h.wire.pending.some((entry) => entry.filters[0]?.kinds?.includes(0)),
    ).toBe(true),
  );
  const pending = h.wire.pending.find((entry) =>
    entry.filters[0]?.kinds?.includes(0),
  );
  expect(pending?.filters).toEqual([
    { kinds: [0], authors: [other.pubkey], limit: 500 },
  ]);
  await act(async () => {
    pending?.respond([profile(other, { name: "Fresh Reactor" })]);
    await flush();
  });
  await waitFor(() => expect(screen.getByText("Fresh Reactor")).toBeTruthy(), {
    timeout: 2500,
  });
});

it("shows custom shortcodes in emojis and previews when media is refused or fails", async () => {
  const h = harness(
    [
      customReaction(other, "denied", "https://a.test/denied.png"),
      customReaction(other, "broken", "https://a.test/broken.png"),
    ],
    undefined,
    tools,
    (url) => (url.includes("denied") ? undefined : url),
  );
  render(<h.Controls />);
  const denied = screen.getByRole("button", {
    name: `:denied:: ${other.pubkey.slice(0, 10)}`,
  });
  const broken = screen.getByRole("button", {
    name: `:broken:: ${other.pubkey.slice(0, 10)}`,
  });
  expect(denied.textContent).toContain(":denied:");
  const image = broken.querySelector("img");
  if (!image) throw new Error("Custom reaction image missing");
  fireEvent.error(image);
  expect(broken.textContent).toContain(":broken:");
  fireEvent.mouseEnter(denied);
  fireEvent.mouseMove(denied);
  const preview = await screen.findByRole("tooltip", {}, { timeout: 2500 });
  expect(preview.textContent).toContain(":denied:");
  fireEvent.mouseLeave(denied);
  fireEvent.mouseEnter(broken);
  fireEvent.mouseMove(broken);
  await waitFor(
    () =>
      expect(
        screen
          .queryAllByRole("tooltip")
          .some((item) => item.textContent?.includes(":broken:")),
      ).toBe(true),
    { timeout: 2500 },
  );
});

it("forwards the contributed picker into true toggles and releases confirmed writes without an echo", async () => {
  const pickerTools = registry<ComposerTool>([
    {
      key: "picker",
      pluginId: "picker",
      revision: "one",
      id: "picker",
      title: "Picker",
      component: () => null,
      reactionComponent: ({ select, disabled }: ReactionToolProps) => (
        <button type="button" disabled={disabled} onClick={() => select("👍")}>
          Choose from picker
        </button>
      ),
    },
  ]);
  const h = harness([react()], undefined, pickerTools);
  render(<h.Controls />);
  const picker = screen.getAllByRole("button", {
    name: "Choose from picker",
  })[0];
  if (!picker) throw new Error("Picker control missing");
  fireEvent.click(picker);
  expect(h.session.outbox?.snapshot()[0]?.event.kind).toBe(5);
  await act(async () => {
    await flush();
    await flush();
  });
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("accepted");
  expect(screen.queryByRole("button", { name: "👍: You" })).toBeNull();
  fireEvent.click(picker);
  expect(h.session.outbox?.snapshot().map((item) => item.event.kind)).toEqual([
    5, 7,
  ]);
  await act(async () => {
    await flush();
    await flush();
  });
});

it("rolls back a failed last-reaction removal and retries it after remount", async () => {
  const publish = vi.fn(async (_event: RelayEvent) => {
    throw new PublishRejected("Nope");
  });
  const h = harness([react()], publish);
  const view = render(<h.Controls />);
  fireEvent.click(screen.getByRole("button", { name: "👍: You" }));
  expect(screen.queryByRole("button", { name: "👍: You" })).toBeNull();
  await act(async () => {
    await flush();
    await flush();
  });
  expect(screen.getByRole("button", { name: "👍: You" })).toBeTruthy();
  view.unmount();
  render(<h.Controls />);
  expect(
    screen.getAllByRole("button", { name: "Retry reaction" }),
  ).toHaveLength(1);
  const original = publish.mock.calls[0]?.[0];
  publish.mockImplementation(async () => undefined as never);
  fireEvent.click(screen.getByRole("button", { name: "Retry reaction" }));
  await act(async () => {
    await flush();
    await flush();
  });
  expect(publish.mock.calls[1]?.[0]).toEqual(original);
  expect(screen.queryByRole("button", { name: "👍: You" })).toBeNull();
});

it("retires reaction previews while retaining the reaction delivery owner", async () => {
  const h = harness([react(other)]);
  vi.useFakeTimers();
  try {
    const tree = (active: boolean) => (
      <ConversationPresentation value={active}>
        <div hidden={!active} inert={!active}>
          <h.Controls />
        </div>
      </ConversationPresentation>
    );
    const view = render(tree(true));
    const pill = screen.getByRole("button", {
      name: `👍: ${other.pubkey.slice(0, 10)}`,
    });
    fireEvent.mouseEnter(pill);
    fireEvent.mouseMove(pill);
    await act(() => vi.advanceTimersByTimeAsync(PREVIEW_REST_MS - 1));
    expect(screen.queryByRole("tooltip")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("tooltip")).toBeTruthy();
    const reactions = screen.getByTestId("reaction-row");
    view.rerender(tree(false));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(screen.getByTestId("reaction-row")).toBe(reactions);
    view.rerender(tree(true));
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(h.publish).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps focus on the bubble when my reaction is removed and another person remains", async () => {
  const h = harness([react(), react(other)]);
  const onFocusedRemoval = vi.fn();
  render(<h.Controls onFocusedRemoval={onFocusedRemoval} />);
  const own = screen.getByRole("button", { name: "👍: 2 people" });
  act(() => own.focus());
  fireEvent.click(own);
  expect(onFocusedRemoval).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(own);
  expect(screen.queryByRole("button", { name: "👍: You" })).toBeNull();
  expect(
    screen.getByRole("button", { name: `👍: ${other.pubkey.slice(0, 10)}` }),
  ).toBeTruthy();
  await act(async () => {
    await flush();
    await flush();
  });
});
it("hands focus back when the last reaction is removed", async () => {
  const h = harness([react()]);
  const onFocusedRemoval = vi.fn();
  render(<h.Controls onFocusedRemoval={onFocusedRemoval} />);
  const own = screen.getByRole("button", { name: "👍: You" });
  act(() => own.focus());
  fireEvent.click(own);
  expect(onFocusedRemoval).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "👍: You" })).toBeNull();
  await act(async () => {
    await flush();
    await flush();
  });
});
it.each([false, true])(
  "hides inline add on coordination while retaining existing reactions (%s)",
  (populated) => {
    const pickerTools = registry<ComposerTool>([
      {
        key: "picker",
        pluginId: "picker",
        revision: "one",
        id: "picker",
        title: "Picker",
        component: () => null,
        reactionComponent: ({ select }: ReactionToolProps) => (
          <button type="button" onClick={() => select("👍")}>
            Choose reaction
          </button>
        ),
      },
    ]);
    const h = harness(populated ? [react(other)] : [], undefined, pickerTools);
    const view = render(<h.Controls audience="agents" />);
    expect(screen.queryByTestId("inline-add-reaction")).toBeNull();
    if (populated)
      expect(
        screen.getByRole("button", {
          name: `👍: ${other.pubkey.slice(0, 10)}`,
        }),
      ).toBeTruthy();
    view.rerender(<h.Controls audience="agents" disabled />);
    expect(screen.queryByTestId("inline-add-reaction")).toBeNull();
    view.rerender(<h.Controls />);
    if (populated)
      expect(
        within(screen.getByTestId("inline-add-reaction")).getByRole("button", {
          name: "Choose reaction",
        }),
      ).toBeTruthy();
    else expect(screen.queryByTestId("inline-add-reaction")).toBeNull();
  },
);
