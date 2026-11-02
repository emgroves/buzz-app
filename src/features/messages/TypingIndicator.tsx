import { useReplacedTypers } from "../conversation/typing-presentation";
import { useChannelIdentityNames } from "../identity-names/react";
import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  openProfileTranscript,
  profileActivityViewTarget,
} from "../profiles/target";
import {
  currentActivity,
  type CurrentActivity,
} from "../agents/current-activity";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentActivityRow } from "../agents/AgentActivityRow";
import activityStyles from "../agents/ActivityRows.module.css";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import type { RelaySession } from "../relay/session";
import type { ComposerSession } from "./composer-session";
import type { MessageLinkOrigin } from "./MessageRow";
import styles from "./TypingIndicator.module.css";
import { avatarMedia } from "../../shared/avatar-source";
import { useActivityLanePublisher } from "./activity-lane";

const noSubscribe = () => () => {};
const noActivity = () => undefined;
const noRows: readonly never[] = [];
const sameActivity = (
  a: ReadonlyMap<string, CurrentActivity>,
  b: ReadonlyMap<string, CurrentActivity>,
) =>
  a.size === b.size &&
  [...a].every(([agent, value]) => {
    const other = b.get(agent);
    return (
      other?.label === value.label &&
      other.roots.length === value.roots.length &&
      other.roots.every((root, i) => root === value.roots[i])
    );
  });

/** Agents working in one conversation, over existing stores; no reads or capture. */
function useConversationAgents(
  session: ComposerSession & Partial<Pick<RelaySession, "agentActivity">>,
  channelId: string,
  threadRootId: string | undefined,
) {
  const replaced = useReplacedTypers(session, channelId, threadRootId);
  const entries = useSyncExternalStore(
    session.typing.subscribe,
    session.typing.snapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const ownedAgents = useMemo(
    () => new Set(choices.identities.map(({ pubkey }) => pubkey)),
    [choices],
  );
  // Subscribe to what this indicator shows, not every observer frame.
  const last = useRef<ReadonlyMap<string, CurrentActivity>>(new Map());
  const getDetails = () => {
    const next = currentActivity(
      (session.agentActivity?.snapshot ?? noActivity)(),
      entries,
      ownedAgents,
      channelId,
      threadRootId,
    );
    if (!sameActivity(last.current, next)) last.current = next;
    return last.current;
  };
  const details = useSyncExternalStore(
    session.agentActivity?.subscribe ?? noSubscribe,
    getDetails,
    getDetails,
  );
  const agents = [...details.keys()].filter((key) => !replaced.has(key)).sort();
  return { details, entries, replaced, agents };
}

/** Floating conversation activity over existing stores; no reads or capture. */
export function TypingIndicator({
  session,
  channelId,
  threadRootId,
  canOpenActivity,
  clickOpensPanel = false,
  openActivity,
}: {
  clickOpensPanel?: boolean | undefined;
  session: ComposerSession & Partial<Pick<RelaySession, "agentActivity">>;
  channelId: string;
  threadRootId?: string | undefined;
  canOpenActivity?: ((target: string) => boolean) | undefined;
  openActivity?:
    | ((target: string, origin?: MessageLinkOrigin) => boolean)
    | undefined;
}) {
  const { details, entries, replaced, agents } = useConversationAgents(
    session,
    channelId,
    threadRootId,
  );
  // The history's jump button beside this composer reserves the lane the pill uses.
  useActivityLanePublisher(session, channelId, threadRootId, agents.length > 0);
  const resolveName = useChannelIdentityNames(session, channelId);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  // Read only the already-loaded channel window to name threads. No ensure/read.
  const needsRows = details.size > 0 && !threadRootId;
  const subscribeRows = useCallback(
    (listener: () => void) =>
      needsRows
        ? (session.channels.subscribeWindow?.(channelId, listener) ??
          (() => {}))
        : () => {},
    [session, channelId, needsRows],
  );
  const getRows = useCallback(
    () =>
      needsRows
        ? (session.channels.window?.(channelId).rows ?? noRows)
        : noRows,
    [session, channelId, needsRows],
  );
  const rows = useSyncExternalStore(subscribeRows, getRows);
  const firstAgent = agents[0];
  const humans = entries.filter(
    (entry) =>
      entry.channelId === channelId &&
      entry.threadRootId === threadRootId &&
      !details.has(entry.pubkey) &&
      !replaced.has(entry.pubkey),
  );
  const name = (pubkey: string) =>
    resolveName(pubkey, profiles.get(pubkey)?.name ?? pubkey.slice(0, 10));
  const avatar = (pubkey: string) => {
    const picture = profiles.get(pubkey)?.picture;
    return (
      <span className={styles.avatar} key={pubkey}>
        <Avatar
          alt=""
          fallback={name(pubkey)}
          shape="squircle"
          size="fill"
          src={avatarMedia(picture, session.media)}
        />
      </span>
    );
  };
  const scopeLabel = (pubkey: string) => {
    if (threadRootId) return undefined;
    const roots = details.get(pubkey)?.roots ?? [];
    const labels = roots.slice(0, 2).map((root) => {
      if (root === null) return "Channel conversation";
      if (!root) return "Work with unconfirmed thread";
      const text = rows
        .find((row) => row.id === root)
        ?.content.replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      return `Thread · ${text || root.slice(0, 8)}`;
    });
    return [
      ...labels,
      ...(roots.length > 2 ? [`+${roots.length - 2} more`] : []),
    ].join(" / ");
  };
  // Unknown or multiple scopes open channel activity, never an inferred transcript.
  const activityOrigin = (pubkey: string): MessageLinkOrigin | undefined => {
    const roots = details.get(pubkey)?.roots ?? [];
    const rootId = threadRootId ?? (roots.length === 1 ? roots[0] : undefined);
    return rootId ? { rootId } : undefined;
  };
  // Only work in one known conversation opens straight to its transcript.
  const activityTarget = (pubkey: string) => {
    const roots = details.get(pubkey)?.roots ?? [];
    const known =
      !!threadRootId ||
      (roots.length === 1 && (roots[0] === null || !!roots[0]));
    return profileActivityViewTarget(pubkey, { transcript: known });
  };
  const directTarget =
    clickOpensPanel && agents.length === 1 && firstAgent
      ? activityTarget(firstAgent)
      : undefined;
  const agentStatus = (
    pubkey: string,
    navigate: (target: string, origin?: MessageLinkOrigin) => void,
  ) => {
    const detail = details.get(pubkey);
    if (!detail) return null;
    const target = activityTarget(pubkey);
    const canOpen = !!target && !!openActivity && !!canOpenActivity?.(target);
    const knownRoots = detail.roots.filter(
      (value) => typeof value === "string",
    );
    const conversationRoot =
      threadRootId ?? (knownRoots.length === 1 ? knownRoots[0] : undefined);
    const conversation = conversationRoot
      ? `buzz://message?${new URLSearchParams({ channel: channelId, id: conversationRoot, thread: conversationRoot })}`
      : `buzz://channel/${encodeURIComponent(channelId)}`;
    const picture = profiles.get(pubkey)?.picture;
    const viewActivity =
      canOpen && target
        ? () => navigate(target, activityOrigin(pubkey))
        : undefined;
    // Going to the conversation already shown would do nothing, so the row
    // opens its activity instead.
    if (viewActivity && conversationRoot === threadRootId)
      return (
        <AgentActivityRow
          name={name(pubkey)}
          picture={avatarMedia(picture, session.media)}
          status={detail.label}
          scope={scopeLabel(pubkey)}
          openLabel={`View ${name(pubkey)} activity`}
          onOpen={viewActivity}
        />
      );
    return (
      <AgentActivityRow
        name={name(pubkey)}
        picture={avatarMedia(picture, session.media)}
        status={detail.label}
        scope={scopeLabel(pubkey)}
        openLabel={`Open ${conversationRoot ? "thread" : "conversation"} for ${name(pubkey)}`}
        onOpen={openActivity ? () => navigate(conversation) : undefined}
        onOpenActivity={viewActivity}
      />
    );
  };
  const workingText = agents.length
    ? `${agents.map(name).join(", ")}${agents.length === 1 ? " is working" : " are working"}`
    : "";
  const typingText = humans.length
    ? `${humans
        .slice(0, 2)
        .map(({ pubkey }) => name(pubkey))
        .join(
          ", ",
        )}${humans.length > 2 ? ` and ${humans.length - 2} others` : ""}${humans.length === 1 ? " is typing" : " are typing"}`
    : "";
  return (
    <>
      {/* Establish the live region before the first working/typing transition. */}
      <span
        className="sr-only"
        role="status"
        aria-label="Conversation activity"
        data-agent-working-status=""
      >
        {[workingText, typingText].filter(Boolean).join(". ")}
      </span>
      {(agents.length > 0 || humans.length > 0) && (
        <div className={styles.typing} data-conversation-activity="">
          {agents.length > 0 && (
            <AgentChooser
              key={`${channelId}:${threadRootId ?? ""}`}
              label={
                agents.length === 1 && firstAgent
                  ? `Activity: ${name(firstAgent)} working`
                  : `Activity: ${agents.length} agents working`
              }
              avatars={agents.slice(0, 4).map(avatar)}
              overflow={Math.max(0, agents.length - 4)}
              openTarget={
                openActivity &&
                ((target, origin) =>
                  openProfileTranscript(target, (next) =>
                    openActivity(next, origin),
                  ))
              }
              directTarget={
                directTarget && canOpenActivity?.(directTarget)
                  ? directTarget
                  : undefined
              }
              directOrigin={firstAgent ? activityOrigin(firstAgent) : undefined}
            >
              {(navigate) =>
                agents.map((pubkey) => (
                  <div key={pubkey}>{agentStatus(pubkey, navigate)}</div>
                ))
              }
            </AgentChooser>
          )}
          {humans.length > 0 && (
            <span className={styles.humans} aria-hidden="true">
              <span className={styles.dots} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className={styles.label}>{typingText}</span>
            </span>
          )}
        </div>
      )}
    </>
  );
}

function AgentChooser({
  label,
  avatars,
  overflow,
  openTarget,
  directTarget,
  directOrigin,
  children,
}: {
  label: string;
  avatars: ReactNode;
  overflow: number;
  openTarget?:
    | ((target: string, origin?: MessageLinkOrigin) => boolean)
    | undefined;
  directTarget?: string | undefined;
  directOrigin?: MessageLinkOrigin | undefined;
  children(
    navigate: (target: string, origin?: MessageLinkOrigin) => void,
  ): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const keyboardPreview = useRef(false);
  const actions =
    useRef<
      NonNullable<ComponentProps<typeof PopoverRoot>["actionsRef"]>["current"]
    >(null);
  useEffect(() => {
    if (!open) {
      keyboardPreview.current = false;
      return;
    }
    // Hover leaves focus in the composer. Consume Escape before its panel's
    // React handler; Base UI's document-bubble dismissal would arrive too late.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229)
        return;
      event.preventDefault();
      event.stopPropagation();
      actions.current?.close();
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [open]);
  const navigate = (target: string, origin?: MessageLinkOrigin) => {
    const previous = document.activeElement;
    // The popup action unmounts after navigation. Existing panel navigation
    // captures activeElement, so give it the retained avatar control instead.
    trigger.current?.focus({ preventScroll: true });
    // Close through Base UI so its hover/press state resets too. A retained
    // conversation keeps this control mounted after navigation.
    if (openTarget?.(target, origin)) {
      if (actions.current) actions.current.close();
      else setOpen(false);
    } else if (previous instanceof HTMLElement)
      previous.focus({ preventScroll: true });
  };
  return (
    <PopoverRoot
      modal={false}
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (directTarget && details.reason === "trigger-press") {
          details.cancel();
          return;
        }
        // Base UI tracks compositionstart/end; also honor the native key flags
        // when composition began before this hover popup mounted.
        if (
          details.reason === "escape-key" &&
          details.event instanceof KeyboardEvent &&
          (details.event.isComposing || details.event.keyCode === 229)
        ) {
          details.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
      actionsRef={actions}
    >
      <PopoverTrigger
        ref={trigger}
        openOnHover="preview"
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={label}
            data-agent-activity-trigger=""
            aria-keyshortcuts={directTarget ? "ArrowDown" : undefined}
            aria-description={
              directTarget
                ? "Press Down Arrow for working agents and conversation actions."
                : undefined
            }
            onKeyDown={(event) => {
              if (
                !directTarget ||
                event.key !== "ArrowDown" ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229 ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              keyboardPreview.current = true;
              setOpen(true);
              popup.current?.focus();
            }}
            onClick={(event) => {
              if (!directTarget) return;
              // Keep hover preview separate from explicit click/keyboard activation.
              event.preventDefault();
              navigate(directTarget, directOrigin);
            }}
          >
            <span className={styles.avatars} aria-hidden="true">
              {avatars}
              {overflow > 0 && (
                <span className={styles.overflow}>+{overflow}</span>
              )}
            </span>
          </Button>
        }
      />
      <PopoverPopup
        ref={popup}
        initialFocus={keyboardPreview.current ? popup : undefined}
        size="wide"
        padding="list"
        side="top"
        align="end"
        aria-label="Working now"
      >
        <section
          className={activityStyles.activityList}
          aria-label="Agents working now"
        >
          <h2 className={activityStyles.activitySectionLabel}>Working now</h2>
          {children(navigate)}
        </section>
      </PopoverPopup>
    </PopoverRoot>
  );
}
