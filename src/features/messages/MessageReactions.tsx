import { useConversationPresentation } from "../conversation/ConversationPresentation";
import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { PreviewCard } from "../../shared/design-system/ui/PreviewCard";
import {
  MenuItem,
  MenuNote,
  MenuPopup,
  MenuRoot,
} from "../../shared/design-system/ui/Menu";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import { profileTarget } from "../profiles/target";
import { ReactionDelivery, ReactionTool } from "../conversation/ReactionTool";
import { InlineText } from "../conversation/InlineText";
import type {
  ComposerTool,
  ContributionReader,
  InlineRenderer,
} from "../conversation/contracts";
import type {
  ChannelMessage,
  MessageReaction,
  Profile,
} from "../relay/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { RelaySession } from "../relay/session";
import type { OutgoingEvent } from "../relay/outbox";
import { selectProfiles } from "../relay/profile-selection";
import { recordReaction, useQuickReactions } from "./quick-reactions";
import styles from "./Messages.module.css";

type Props = {
  row: ChannelMessage;
  session: RelaySession;
  scope: string;
  disabled: boolean;
  tools: ContributionReader<ComposerTool>;
  inline: ContributionReader<InlineRenderer>;
};
/** Names and profile destinations for the people who reacted. */
type Reactors = {
  profiles?: ReadonlyMap<string, Profile> | undefined;
  agentPubkeys?: ReadonlySet<string> | undefined;
  onOpenLink?: ((target: string) => boolean) | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
};
const noSubscribe = () => () => {};
const noOperations = Object.freeze([]);
const empty = () => noOperations;

function useReactionAction({ row, session, scope, disabled }: Props) {
  const presented = useConversationPresentation();
  const [error, setError] = useState<string>();
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = !disabled && presented;
  });
  useLayoutEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const operations = useSyncExternalStore(
    session.outbox?.subscribe ?? noSubscribe,
    session.outbox?.snapshot ?? empty,
    session.outbox?.snapshot ?? empty,
  );
  const blocksToggle = (item: OutgoingEvent) =>
    ["sending", "failed", "unknown"].includes(item.delivery) &&
    session.messages.reactionTarget(item.event) === row.id;
  const busy = operations.some(blocksToggle);
  const toggle = (content: string, emoji?: CustomEmoji) => {
    if (!active.current || session.outbox?.snapshot().some(blocksToggle))
      return false;
    try {
      const group = row.reactions.find(
        (reaction) =>
          reaction.content === content && reaction.emoji?.url === emoji?.url,
      );
      const mine =
        group?.events.filter((event) => event.authorId === session.viewer) ??
        [];
      if (mine.length) session.messages.remove(mine.map((event) => event.id));
      else {
        session.messages.react(row.id, content, emoji);
        recordReaction(scope, content);
      }
      setError(undefined);
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not update reaction. Try again.",
      );
      return false;
    }
  };
  return { toggle, disabled: disabled || busy, error };
}

function ReactionLabel({
  reaction,
  row,
  inline,
  session,
}: {
  reaction: MessageReaction;
  row: ChannelMessage;
  inline: ContributionReader<InlineRenderer>;
  session: RelaySession;
}) {
  return (
    <InlineText
      registry={inline}
      content={{ text: reaction.content, message: row, reaction }}
      media={session.media}
    />
  );
}

const catalogIndexes = new WeakMap<
  readonly CustomEmoji[],
  ReadonlyMap<string, CustomEmoji>
>();
/** Every row looks up its quick reactions on each render; index each catalog snapshot once. */
function catalogEmoji(entries: readonly CustomEmoji[], content: string) {
  if (!content.startsWith(":")) return undefined;
  let index = catalogIndexes.get(entries);
  if (!index) {
    index = new Map(entries.map((entry) => [`:${entry.shortcode}:`, entry]));
    catalogIndexes.set(entries, index);
  }
  return index.get(content.toLowerCase());
}

/** PR 1's quick-control slot. The emoji contribution continues to own its picker. */
export function MessageReactionControls(props: Props) {
  const { row, session, scope, inline, tools } = props;
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const shortcuts = useQuickReactions(scope, catalog.entries);
  const action = useReactionAction(props);
  const select = (content: string) =>
    action.toggle(content, catalogEmoji(catalog.entries, content));
  return (
    <>
      {shortcuts.map((content) => {
        const emoji = catalogEmoji(catalog.entries, content);
        const mine = row.reactions.some(
          (reaction) =>
            reaction.content === content &&
            reaction.emoji?.url === emoji?.url &&
            reaction.events.some((event) => event.authorId === session.viewer),
        );
        return (
          <span key={content} className={styles.quickReaction}>
            <IconButton
              size="sm"
              variant="ghost"
              disabled={action.disabled}
              aria-label={`${mine ? "Remove" : "React with"} ${content}`}
              aria-pressed={mine}
              onClick={() => select(content)}
              icon={
                <span
                  className={styles.quickReactionGlyph}
                  data-emoji={emoji ? undefined : content}
                >
                  {emoji && (
                    <ReactionLabel
                      row={row}
                      inline={inline}
                      session={session}
                      reaction={{ content, emoji, events: [] }}
                    />
                  )}
                </span>
              }
            />
          </span>
        );
      })}
      <ReactionTool
        registry={tools}
        session={session}
        scope={scope}
        messageId={row.id}
        disabled={action.disabled}
        select={select}
        showDelivery={false}
      />
      {action.error && <span role="alert">{action.error}</span>}
    </>
  );
}

function ReactionGlyph({
  reaction,
  session,
}: {
  reaction: MessageReaction;
  session: RelaySession;
}) {
  const source = reaction.emoji ? session.media(reaction.emoji.url) : undefined;
  const [failed, setFailed] = useState<string>();
  return source && source !== failed ? (
    <img
      className={styles.reactionCustomEmoji}
      src={source}
      alt=""
      draggable={false}
      onError={() => setFailed(source)}
    />
  ) : (
    <span
      className={
        reaction.emoji
          ? styles.reactionFallbackEmoji
          : styles.reactionNativeEmoji
      }
      aria-hidden="true"
    >
      {reaction.emoji ? `:${reaction.emoji.shortcode}:` : reaction.content}
    </span>
  );
}

/** Everyone in a grouped reaction, mounted only with its list. A group can
 * outgrow the profile directory's request budget, and loading everyone would
 * evict names the timeline shows: load names as rows near the visible area. */
function ReactorItems({
  popup,
  people,
  session,
  profiles,
  agentPubkeys,
  onOpenLink,
  canOpenLink,
}: Reactors & {
  popup: RefObject<HTMLDivElement | null>;
  people: readonly string[];
  session: RelaySession;
}) {
  const requested = useRef(new Set<string>());
  const [failed, setFailed] = useState(false);
  // Show any names already loaded; request only the rows that come into view.
  const selection = useMemo(
    () => selectProfiles(session.profiles, people),
    [session.profiles, people],
  );
  const loaded = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: people adds rows to observe.
  useEffect(() => {
    const root = popup.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const page = entries.flatMap(({ isIntersecting, target }) => {
          const id = (target as HTMLElement).dataset.reactor;
          if (!isIntersecting || !id || requested.current.has(id)) return [];
          requested.current.add(id);
          observer.unobserve(target);
          return [id];
        });
        if (!page.length) return;
        session.profiles
          .ensure(page, "background")
          .catch(() => setFailed(true));
      },
      // The visible rows and the next screenful, far below the request budget.
      { root, rootMargin: "100% 0px" },
    );
    for (const row of root.querySelectorAll<HTMLElement>("[data-reactor]"))
      if (!requested.current.has(row.dataset.reactor ?? ""))
        observer.observe(row);
    return () => observer.disconnect();
  }, [popup, people, session]);
  return (
    <>
      {failed && (
        <MenuNote role="alert">
          Some names could not load. Reopen this list to try again.
        </MenuNote>
      )}
      {people.map((authorId) => {
        const profile = loaded.get(authorId) ?? profiles?.get(authorId);
        const name =
          authorId === session.viewer
            ? "You"
            : (profile?.name ?? authorId.slice(0, 10));
        const agent = !!agentPubkeys?.has(authorId);
        const target = profileTarget(authorId, { agent });
        const destination =
          target && canOpenLink?.(target) ? target : undefined;
        return (
          <MenuItem
            key={authorId}
            data-reactor={authorId}
            // A host without profile destinations leaves every row enabled:
            // nothing here is unavailable, and choosing one closes the list.
            disabled={!!canOpenLink && !destination}
            onClick={() => destination && onOpenLink?.(destination)}
          >
            <ChoiceRow
              leading={
                <Avatar
                  alt=""
                  fallback={profile?.name ?? name}
                  src={avatarMedia(profile?.picture, session.media)}
                  size="small"
                  shape={agent || profile?.isAgent ? "squircle" : "circle"}
                />
              }
              label={name}
            />
          </MenuItem>
        );
      })}
    </>
  );
}

function ReactionEmoji({
  reaction,
  authorIds,
  mine,
  session,
  profiles,
  agentPubkeys,
  onOpenLink,
  canOpenLink,
  disabled,
  unavailable,
  toggle,
  onFocusedRemoval,
  previewWarm,
  previewSlide,
  previewOpen,
  onPreviewChange,
}: Reactors & {
  reaction: MessageReaction;
  authorIds: string[];
  mine: boolean;
  session: RelaySession;
  disabled: boolean;
  unavailable: boolean;
  toggle(content: string, emoji?: CustomEmoji): boolean;
  onFocusedRemoval?: (() => void) | undefined;
  previewWarm: boolean;
  previewSlide: "left" | "right" | undefined;
  previewOpen: boolean;
  onPreviewChange(open: boolean): void;
}) {
  const [name, setName] = useState(reaction.content);
  // A retained focus must not reopen the preview over delivery recovery controls.
  // Fresh pointer or keyboard entry can reveal it again.
  const [previewDismissed, setPreviewDismissed] = useState(false);
  const [previewTilt, setPreviewTilt] = useState("0deg");
  const emojiAnchor = useRef<HTMLSpanElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const othersButton = useRef<HTMLButtonElement>(null);
  const listPopup = useRef<HTMLDivElement>(null);
  const [listOpen, setListOpen] = useState(false);
  // You first, then everyone else in reaction order.
  const people = useMemo(
    () =>
      session.viewer && authorIds.includes(session.viewer)
        ? [session.viewer, ...authorIds.filter((id) => id !== session.viewer)]
        : authorIds,
    [authorIds, session.viewer],
  );
  const previewAuthors = useMemo(() => people.slice(0, 3), [people]);
  const remaining = people.length - previewAuthors.length;
  // The emoji keeps its instance as the group shrinks; an open list must not
  // come back when the remainder does.
  if (remaining === 0 && listOpen) setListOpen(false);
  const reactorProfiles = useMemo(
    () => selectProfiles(session.profiles, previewAuthors),
    [session.profiles, previewAuthors],
  );
  const loadedReactors = useSyncExternalStore(
    reactorProfiles.subscribe,
    reactorProfiles.snapshot,
    reactorProfiles.snapshot,
  );
  const grouped = authorIds.length > 1;
  const own = !!session.viewer && authorIds.includes(session.viewer);
  const users = previewAuthors.map((authorId) =>
    authorId === session.viewer
      ? "You"
      : (loadedReactors.get(authorId)?.name ??
        profiles?.get(authorId)?.name ??
        authorId.slice(0, 10)),
  );
  const user = users.join(", ");
  const revealName = () => {
    void session.profiles.ensure(previewAuthors, "background").catch(() => {});
    if (reaction.emoji) return;
    void import("./reaction-name").then(({ reactionName }) =>
      setName(reactionName(reaction.content)),
    );
  };
  return (
    <span className={styles.reactionItem}>
      <PreviewCard
        side="top"
        align="center"
        anchor={emojiAnchor}
        open={previewOpen && !previewDismissed && !unavailable}
        warm={previewWarm}
        className={[
          styles.reactionPreview,
          previewSlide === "left" && styles.reactionPreviewSlideLeft,
          previewSlide === "right" && styles.reactionPreviewSlideRight,
        ]
          .filter(Boolean)
          .join(" ")}
        onOpenChange={onPreviewChange}
        {...(remaining > 0 && {
          actionRef: othersButton,
          "aria-label": `${reaction.content} reactions`,
        })}
        trigger={
          <Button
            ref={pill}
            variant="link"
            size="sm"
            shape={grouped ? "capsule" : "icon"}
            data-reaction={reaction.content}
            data-reaction-url={reaction.emoji?.url}
            aria-label={`${reaction.content}: ${grouped ? `${authorIds.length} people` : user}`}
            aria-pressed={mine}
            aria-disabled={unavailable}
            disabled={disabled}
            onMouseEnter={(event) => {
              setPreviewDismissed(false);
              const tilt = `${Math.random() * 20 - 10}deg`;
              event.currentTarget.style.setProperty("--reaction-tilt", tilt);
              setPreviewTilt(tilt);
              revealName();
            }}
            onFocus={() => {
              setPreviewDismissed(false);
              revealName();
            }}
            onClick={(event) => {
              if (unavailable) return;
              setPreviewDismissed(true);
              onPreviewChange(false);
              const losesFocus =
                own &&
                authorIds.length === 1 &&
                event.currentTarget === document.activeElement;
              if (toggle(reaction.content, reaction.emoji) && losesFocus)
                onFocusedRemoval?.();
            }}
          >
            <span
              ref={emojiAnchor}
              className={styles.reactionGlyph}
              data-reaction-glyph
              data-grouped={grouped || undefined}
            >
              <ReactionGlyph reaction={reaction} session={session} />
              {grouped && (
                <span className={styles.reactionCount}>{authorIds.length}</span>
              )}
            </span>
          </Button>
        }
      >
        <div className={styles.reactionPreviewContent}>
          <span
            className={styles.reactionPreviewEmoji}
            style={{ "--reaction-preview-tilt": previewTilt } as CSSProperties}
          >
            <ReactionGlyph reaction={reaction} session={session} />
          </span>
          <span className={styles.reactionPreviewNames}>
            {users.map((user, index) => (
              <span
                key={previewAuthors[index]}
                className={styles.reactionPreviewPerson}
              >
                {user}
              </span>
            ))}
          </span>
          {remaining > 0 && (
            <Button
              ref={othersButton}
              variant="link"
              size="inline"
              aria-haspopup="menu"
              onClick={() => {
                onPreviewChange(false);
                setListOpen(true);
              }}
            >
              and {remaining} {remaining === 1 ? "other" : "others"}
            </Button>
          )}
          <span className={styles.reactionPreviewName}>{name}</span>
        </div>
      </PreviewCard>
      {remaining > 0 && (
        <MenuRoot open={listOpen} onOpenChange={setListOpen}>
          <MenuPopup
            ref={listPopup}
            anchor={emojiAnchor}
            finalFocus={pill}
            aria-label={`Everyone who reacted with ${reaction.content}`}
            // Focus here counts as on this emoji: if it splits up, focus
            // moves to one of its individual emojis.
            data-reaction={reaction.content}
            data-reaction-url={reaction.emoji?.url}
          >
            <ReactorItems
              popup={listPopup}
              people={people}
              session={session}
              profiles={profiles}
              agentPubkeys={agentPubkeys}
              onOpenLink={onOpenLink}
              canOpenLink={canOpenLink}
            />
          </MenuPopup>
        </MenuRoot>
      )}
    </span>
  );
}

/** Always mounted under the message so failed add/remove operations stay recoverable. */
export function MessageReactions(
  props: Props &
    Reactors & {
      onFocusedRemoval?: () => void;
    },
) {
  const active = useConversationPresentation();
  const { row, session, scope, tools } = props;
  const action = useReactionAction(props);
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const [pointerInRow, setPointerInRow] = useState(false);
  const reactionRow = useRef<HTMLDivElement>(null);
  const focusedReaction = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const previous = focusedReaction.current;
    if (!previous || previous.isConnected) return;
    focusedReaction.current = null;
    if (!active || document.activeElement !== document.body) return;
    // Grouping can replace the focused control after a local or live update.
    const replacement = Array.from(
      reactionRow.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-reaction]",
      ) ?? [],
    ).find(
      (button) =>
        button.dataset.reaction === previous.dataset.reaction &&
        button.dataset.reactionUrl === previous.dataset.reactionUrl,
    );
    if (replacement) replacement.focus({ preventScroll: true });
  });
  const [preview, setPreview] = useState<{
    key: string | null;
    index: number;
    fromIndex: number | undefined;
  }>();
  if (!active && preview) setPreview(undefined);
  if (!active && pointerInRow) setPointerInRow(false);
  const select = (content: string) => {
    return action.toggle(content, catalogEmoji(catalog.entries, content));
  };
  // Count people, not duplicate events. Each emoji shares one control and preview.
  const reactions = useMemo(
    () =>
      row.reactions.map((reaction) => {
        const authorIds = [
          ...new Set(reaction.events.map((event) => event.authorId)),
        ];
        const mine = !!session.viewer && authorIds.includes(session.viewer);
        return { reaction, authorIds, mine };
      }),
    [row.reactions, session.viewer],
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: This groups reactions, not form fields.
    <div
      ref={reactionRow}
      className={styles.reactions}
      data-message-reactions={(active && reactions.length > 0) || undefined}
      data-testid="reaction-row"
      data-populated={(active && reactions.length > 0) || undefined}
      role="group"
      aria-label="Reactions"
      onFocusCapture={(event) => {
        focusedReaction.current =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>(
                "button[data-reaction], [role='menu'][data-reaction]",
              )
            : null;
      }}
      onBlurCapture={() => {
        if (focusedReaction.current?.isConnected)
          focusedReaction.current = null;
      }}
      onMouseEnter={() => setPointerInRow(true)}
      onMouseLeave={() => {
        setPointerInRow(false);
        // An open preview keeps its own hover close, so the pointer can cross
        // the gap to it; only a closed one stops warming the next pill here.
        setPreview((current) => (current?.key ? current : undefined));
      }}
    >
      {active &&
        reactions.map(({ reaction, authorIds, mine }, index) => {
          const key = JSON.stringify([reaction.content, reaction.emoji?.url]);
          const slideFrom =
            preview?.key === key ? preview.fromIndex : preview?.index;
          const previewSlide =
            pointerInRow && slideFrom !== undefined && slideFrom !== index
              ? index > slideFrom
                ? "right"
                : "left"
              : undefined;
          return (
            <ReactionEmoji
              key={key}
              reaction={reaction}
              authorIds={authorIds}
              mine={mine}
              session={session}
              profiles={props.profiles}
              agentPubkeys={props.agentPubkeys}
              onOpenLink={props.onOpenLink}
              canOpenLink={props.canOpenLink}
              disabled={props.disabled}
              unavailable={action.disabled}
              toggle={action.toggle}
              onFocusedRemoval={props.onFocusedRemoval}
              // Who reacted is a preview (DESIGN.md "Hover timing"): once one is
              // open, moving along the row slides it to the next pill at once.
              previewWarm={!!preview}
              previewOpen={preview?.key === key}
              previewSlide={previewSlide}
              onPreviewChange={(open) =>
                setPreview((current) =>
                  open
                    ? {
                        key,
                        index,
                        fromIndex:
                          current?.key === key
                            ? current.fromIndex
                            : current?.index,
                      }
                    : current?.key !== key
                      ? current
                      : pointerInRow
                        ? { ...current, key: null }
                        : undefined,
                )
              }
            />
          );
        })}
      {active &&
        reactions.length > 0 &&
        row.audience !== "agents" &&
        !props.disabled && (
          <span
            className={styles.inlineReactionTool}
            data-message-reactions
            data-testid="inline-add-reaction"
          >
            <ReactionTool
              registry={tools}
              session={session}
              scope={scope}
              messageId={row.id}
              disabled={action.disabled}
              select={select}
              showDelivery={false}
            />
          </span>
        )}
      {action.error && <span role="alert">{action.error}</span>}
      <ReactionDelivery session={session} messageId={row.id} />
    </div>
  );
}
