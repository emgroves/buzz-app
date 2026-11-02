import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import type { activityRecords } from "../../features/agents/activity-records";
import { profileActivityViewTarget } from "../../features/profiles/target";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  OctagonIcon,
  WarningCircleIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { currentActivity } from "./current-activity";
import { messageWork } from "./message-activity";
import type { ActivityTurn } from "../../features/agents/activity";
import type { Agents } from "../../features/agents/service";
import {
  requestWork,
  type RequestWork,
} from "../../features/agents/request-work";
import {
  localWorkLabel,
  type WorkStep,
} from "../../features/agents/local-activity";
import { useTypingReplacement } from "../../features/conversation/typing-presentation";
import styles from "./ActivityAccessory.module.css";
import { avatarMedia } from "../../shared/avatar-source";

const noSubscribe = () => () => {};
/** How long a hosted stop shows as stopping before Stop can be tried again:
 * its provider may never report the turn's end. */
const HOSTED_STOP_MS = 30_000;
/** What Stop needs of Agents: a hosted agent's provider stops its turns. */
export type ActivityAgents = Pick<Agents, "interruptible" | "interrupt">;
type ActivityProps = ComposerAccessoryProps & { agents?: ActivityAgents };
/** Activity belongs to the exact triggering message, not the composer. */
export function ActivityAccessory(props: ActivityProps) {
  const { session, channelId, message, canOpen } = props;
  const messageId = message?.id;
  // Every row mounts this; only rows with work subscribe to each activity
  // step, profile and choice change. Others read once and wait for work.
  const hasWork = useSyncExternalStore(session.agentActivity.subscribe, () => {
    if (!messageId) return false;
    const work = messageWork(
      session.agentActivity.snapshot(),
      channelId,
      messageId,
    );
    return work.live.length > 0 || work.stopped.length > 0;
  });
  const snapshot = useSyncExternalStore(
    hasWork ? session.agentActivity.subscribe : noSubscribe,
    session.agentActivity.snapshot,
  );
  const { live: entries, stopped } = useMemo(
    () =>
      messageId && hasWork
        ? messageWork(snapshot, channelId, messageId)
        : { live: [], stopped: [] },
    [snapshot, channelId, messageId, hasWork],
  );
  const profiles = useSyncExternalStore(
    hasWork ? session.profiles.subscribe : noSubscribe,
    session.profiles.snapshot,
  );
  const choices = useSyncExternalStore(
    hasWork ? session.agentChoices.subscribe : noSubscribe,
    session.agentChoices.snapshot,
  );
  const resolveName = useChannelIdentityNames(session, channelId);
  const keys = [...entries, ...stopped].map((entry) => entry.agent);
  const identityKeys = keys.join(":");
  useEffect(() => {
    if (identityKeys)
      void session.profiles
        .ensure(identityKeys.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, identityKeys]);
  const suffixes = publicKeyLabels(keys);
  const names = keys.map((key) =>
    resolveName(
      key,
      profiles.get(key)?.name ??
        choices.identities.find((row) => row.pubkey === key)?.name ??
        suffixes.get(key) ??
        "Agent",
    ),
  );
  const named = (agent: string) => {
    const name = names[keys.indexOf(agent)] ?? "Agent";
    return names.filter((value) => value === name).length > 1
      ? `${name} · ${suffixes.get(agent)}`
      : name;
  };
  const visible = (entry: { agent: string }) =>
    canOpen(profileActivityViewTarget(entry.agent) ?? "");
  const shown: Entry[] = entries.filter(visible).map((entry) => {
    return {
      agent: entry.agent,
      name: named(entry.agent),
      picture: profiles.get(entry.agent)?.picture,
      working: entry.working,
      state: entry.state,
      reason: entry.reason,
      ...(entry.step ? { step: entry.step } : {}),
      ...(entry.stoppable ? { stoppable: true } : {}),
      lifecycle: entry.lifecycle,
      records: entry.selected.records,
      turns: entry.turns,
    };
  });
  // When work ends (not when access is revoked), keep the last bubble long
  // enough for the shared leave recipe, then remove it.
  const section = useRef<HTMLElement>(null);
  const retained = useRef<Entry[]>([]);
  const [leaving, setLeaving] = useState<Entry[] | null>(null);
  const ended = !entries.length;
  useLayoutEffect(() => {
    // Child closes its portal and restores focus before this subtree is inert.
    if (section.current) section.current.inert = !shown.length;
    if (shown.length) {
      retained.current = shown;
      if (leaving) setLeaving(null);
      return;
    }
    if (ended && retained.current.length) setLeaving(retained.current);
    retained.current = [];
  });
  useLayoutEffect(() => {
    if (!leaving) return;
    const animations = section.current?.getAnimations?.() ?? [];
    if (!animations.length) {
      setLeaving(null);
      return;
    }
    let live = true;
    const done = () => {
      if (live) setLeaving(null);
    };
    void Promise.all(animations.map((animation) => animation.finished)).then(
      done,
      done,
    );
    return () => {
      live = false;
    };
  }, [leaving]);
  // The render where work ends keeps the same element (from the last shown
  // entries) so the list never loses and regains its height mid-handoff.
  const bubble = shown.length
    ? shown
    : (leaving ?? (ended ? retained.current : []));
  // Once its live bubble has left, a stopped request stays noted here.
  const noted = bubble.length ? [] : stopped.filter(visible);
  const note = noted.length ? (
    <div
      className={`${styles.root} ${styles.stopped} text-caption text-subtle buzz-arrive`}
      data-activity-stopped=""
      data-buzz-ui=""
    >
      <AvatarStack
        size="mini"
        items={noted.map(({ agent }) => ({
          id: agent,
          name: named(agent),
          src: avatarMedia(profiles.get(agent)?.picture, session.media),
          shape: "squircle",
        }))}
      />
      <span>{noted.map(({ agent }) => named(agent)).join(", ")} · Stopped</span>
    </div>
  ) : null;
  if (props.renderMessageSummary) {
    return (
      <>
        {shown.map((entry) => (
          <TypingReplacement key={entry.agent} {...props} agent={entry.agent} />
        ))}
        <ActivityBubble
          {...props}
          entries={bubble}
          interactive={shown.length > 0}
        />
        {note}
      </>
    );
  }
  if (!bubble.length) return note;
  return (
    <section
      ref={section}
      className={`${styles.root} buzz-arrive`}
      data-message-activity=""
      data-arrive="grow"
      data-leaving={shown.length ? undefined : ""}
      data-buzz-ui=""
      aria-label="Agent activity on this message"
      aria-hidden={shown.length ? undefined : true}
    >
      <div>
        {shown.map((entry) => (
          <TypingReplacement key={entry.agent} {...props} agent={entry.agent} />
        ))}
        <ActivityBubble
          key={`${channelId}:${message?.id ?? ""}`}
          {...props}
          entries={bubble}
          interactive={shown.length > 0}
        />
      </div>
    </section>
  );
}

type Entry = {
  agent: string;
  name: string;
  picture: string | undefined;
  working: boolean;
  state: RequestWork["state"];
  reason: string | undefined;
  step?: WorkStep;
  stoppable?: boolean;
  lifecycle: boolean;
  records: ReturnType<typeof activityRecords>;
  turns: readonly ActivityTurn[];
};

function ActivityBubble({
  entries,
  interactive,
  agents,
  ...props
}: ActivityProps & { entries: Entry[]; interactive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // Agents asked to stop whose work has not stopped yet.
  const [stops, setStops] = useState<ReadonlySet<string>>(new Set());
  // The latest stop asked of each agent, so a late timeout knows its own.
  const attempts = useRef(new Map<string, symbol>());
  const notify = useToastNotification();
  // A hosted stop still pending when its activity goes away needs no retry.
  useEffect(() => {
    const pending = attempts.current;
    return () => pending.clear();
  }, []);
  const message = props.message;
  const stoppable = (entry: Entry) =>
    !!message &&
    (entry.lifecycle
      ? !!entry.stoppable &&
        (entry.state === "working" || entry.state === "waiting")
      : entry.working && !!agents?.interruptible(entry.agent));
  const forget = (agent: string) => {
    attempts.current.delete(agent);
    setStops((prior) => {
      if (!prior.has(agent)) return prior;
      const next = new Set(prior);
      next.delete(agent);
      return next;
    });
  };
  const stop = (entry: Entry) => {
    if (!message) return;
    const attempt = Symbol(entry.agent);
    attempts.current.set(entry.agent, attempt);
    setStops((prior) => new Set(prior).add(entry.agent));
    const newer = () => {
      const latest = attempts.current.get(entry.agent);
      return !!latest && latest !== attempt;
    };
    // A local request settles as stopped; a hosted turn ends when its
    // provider reports it, so it shows as stopping until then.
    const asked = entry.lifecycle
      ? props.session.agentActivity.interrupt(
          entry.agent,
          props.channelId,
          message.id,
        )
      : agents?.interrupt(entry.agent, {
          channelId: props.channelId,
          threadRootId: message.threadRootId ?? message.id,
        });
    void Promise.resolve(asked).then(
      (running) => {
        // A newer stop of this agent reports its own result.
        if (newer()) return;
        if (entry.lifecycle) {
          forget(entry.agent);
          notify(`Stopped ${entry.name}`, "success");
        } else if (running === false) {
          forget(entry.agent);
          notify(`${entry.name} had nothing running to stop`, "info");
        } else {
          notify(`Stopping ${entry.name}`, "success");
          setTimeout(() => {
            if (attempts.current.get(entry.agent) !== attempt) return;
            forget(entry.agent);
            notify(`${entry.name} hasn’t stopped yet. Try again.`, "error");
          }, HOSTED_STOP_MS);
        }
      },
      (error: unknown) => {
        if (newer()) return;
        forget(entry.agent);
        notify(
          `Couldn’t stop ${entry.name}. ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      },
    );
  };
  // A stop is forgotten once its agent's work here has ended.
  const live = entries
    .filter((entry) => entry.working || entry.state === "waiting")
    .map((entry) => entry.agent)
    .join(":");
  useEffect(() => {
    const agents = new Set(live.split(":"));
    for (const agent of attempts.current.keys())
      if (!agents.has(agent)) attempts.current.delete(agent);
    setStops((prior) =>
      [...prior].every((agent) => agents.has(agent))
        ? prior
        : new Set([...prior].filter((agent) => agents.has(agent))),
    );
  }, [live]);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (interactive) return;
    const source = popup.current;
    const button = trigger.current;
    const document = (source ?? button)?.ownerDocument;
    const active = document?.activeElement;
    setExpanded(false);
    if (active && (button?.contains(active) || source?.contains(active))) {
      // Commit closure before handing off: its overlay currently hides the
      // host's target. DOM observers release that target at this checkpoint.
      // Keep the retired nodes so unmount does not erase focus ownership.
      queueMicrotask(() => {
        const current = document?.activeElement;
        if (
          current === document?.body ||
          (current && (button?.contains(current) || source?.contains(current)))
        )
          props.onFocusedRemoval?.();
      });
    }
  }, [interactive, props.onFocusedRemoval]);
  const working = entries.some((entry) => entry.working);
  // Local work breathes until its first step ("Starting"), like the sidebar and thread.
  const starting = (entry: Entry) =>
    entry.lifecycle &&
    (entry.state === "waiting" || (entry.state === "working" && !entry.step));
  const waiting = entries.some(starting);
  const stepping = entries.some((entry) => entry.working && !starting(entry));

  const unknown = entries.some((entry) => !entry.lifecycle && !entry.working);
  const failedCount = entries.filter(
    (entry) => entry.lifecycle && entry.state === "error",
  ).length;
  const label = (entry: Entry) =>
    entry.lifecycle
      ? localWorkLabel({
          state:
            entry.state === "ended"
              ? "done"
              : entry.state === "unknown"
                ? "error"
                : entry.state,
          ...(entry.reason ? { error: entry.reason } : {}),
          ...(entry.step ? { step: entry.step } : {}),
        })
      : entry.working
        ? "working"
        : "status unknown";
  const failedEntries = entries.filter(
    (entry) => entry.lifecycle && entry.state === "error",
  );
  const otherEntries = entries.filter(
    (entry) => !failedEntries.includes(entry),
  );
  const avatars = (group: Entry[]) => (
    <AvatarStack
      size="mini"
      items={group.map((entry) => ({
        id: entry.agent,
        name: entry.name,
        src: avatarMedia(entry.picture, props.session.media),
        shape: "squircle",
      }))}
    />
  );
  const content = (
    <span className={styles.summaryGroups}>
      {otherEntries.length > 0 && (
        <span className={styles.summaryActivity} data-thread-working="">
          {avatars(otherEntries)}
          {(working || waiting) && (
            <TypingDots size="small" state={stepping ? "working" : "waiting"} />
          )}
          {unknown && <span>Status unknown</span>}
        </span>
      )}
      {failedCount > 0 && (
        <span
          className={`${styles.summaryActivity} ${styles.failure}`}
          data-activity-failure=""
        >
          {avatars(failedEntries)}
          <WarningCircleIcon size={12} aria-hidden="true" />
          <span>{failedCount} failed</span>
        </span>
      )}
    </span>
  );
  const summary = props.renderMessageSummary?.(
    entries.length
      ? {
          participants: entries.map((entry) => entry.agent),
          content,
          label: entries
            .map((entry) => `${entry.name}, ${label(entry)}`)
            .join("; "),
          ref: trigger,
        }
      : undefined,
  );
  if (!entries.length && !summary) return null;
  return (
    <PopoverRoot
      open={expanded}
      onOpenChange={(open) => setExpanded(interactive && open)}
    >
      <PopoverTrigger
        openOnHover={interactive && "preview"}
        {...(!interactive
          ? {
              "aria-haspopup": undefined,
              "aria-expanded": undefined,
              "aria-controls": undefined,
            }
          : {})}
        onClick={(event) => {
          if (!interactive) {
            event.preventBaseUIHandler();
            return;
          }
          if (summary) {
            event.preventBaseUIHandler();
            setExpanded(false);
          } else if (props.openThread?.()) {
            event.preventBaseUIHandler();
            setExpanded(false);
          }
        }}
        render={
          summary ?? (
            <Button
              ref={trigger}
              tabIndex={interactive ? undefined : -1}
              size="xs"
              variant="subtle"
              data-activity-summary=""
              aria-label={`${props.openThread ? "Open thread" : "View agent activity"}: ${entries.map((entry) => `${entry.name}, ${label(entry)}`).join("; ")}`}
            >
              {content}
            </Button>
          )
        }
      />
      <PopoverPopup
        ref={popup}
        finalFocus={interactive ? undefined : false}
        side="top"
        padding="list"
        aria-label="Agent activity"
      >
        {expanded && (
          <div className={styles.previews}>
            {entries.map((entry) => {
              // Opens the agent's profile on its Activity tab.
              const target = profileActivityViewTarget(entry.agent);
              const preview = entry.working
                ? currentActivity(entry.records, entry.turns)
                : undefined;
              const stopping = stops.has(entry.agent);
              return (
                <div key={entry.agent} className={styles.row}>
                  <NavigationItem
                    variant="option"
                    aria-label={`View activity for ${entry.name}`}
                    disabled={!target || !props.canOpen(target)}
                    onClick={() => {
                      if (target && props.canOpen(target) && props.open(target))
                        setExpanded(false);
                    }}
                    icon={
                      <ActivityAvatar
                        session={props.session}
                        entry={entry}
                        size="small"
                      />
                    }
                    label={
                      <span
                        className={`text-body-sm ${styles.preview}`}
                        data-error={
                          entry.lifecycle && entry.state === "error"
                            ? ""
                            : undefined
                        }
                      >
                        <ShimmerText
                          active={stopping || entry.working || starting(entry)}
                        >
                          {(stopping ? "Stopping…" : undefined) ??
                            (entry.lifecycle
                              ? label(entry)
                              : !entry.working
                                ? "Activity interrupted or out of date"
                                : (preview?.title ??
                                  "Waiting for activity details"))}
                        </ShimmerText>
                        {preview?.detail && (
                          <span className={styles.detail}>
                            <ShimmerText active={entry.working}>
                              {preview.detail}
                            </ShimmerText>
                          </span>
                        )}
                      </span>
                    }
                  />
                  {entry.lifecycle && entry.state === "error" ? (
                    <span className={styles.action}>
                      <IconButton
                        size="sm"
                        variant="ghost"
                        aria-label={`Dismiss error from ${entry.name}`}
                        icon={<XIcon />}
                        onClick={(event) => {
                          event.stopPropagation();
                          // Retirement owns the last popup's close and focus
                          // handoff; keep its focused contents until that effect.
                          if (props.message)
                            props.session.agentActivity.dismissError?.(
                              entry.agent,
                              props.channelId,
                              props.message.id,
                            );
                        }}
                      />
                    </span>
                  ) : stoppable(entry) ? (
                    <span className={styles.action}>
                      <Button
                        size="sm"
                        variant="subtle"
                        aria-label={`Stop ${entry.name}`}
                        loading={stopping}
                        onClick={(event) => {
                          event.stopPropagation();
                          stop(entry);
                        }}
                      >
                        <OctagonIcon
                          className={styles.stopIcon}
                          aria-hidden="true"
                        />
                        <span>Stop</span>
                      </Button>
                    </span>
                  ) : undefined}
                </div>
              );
            })}
          </div>
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}

/** Message-linked work replaces the composer control; unassociated work keeps
 * main's existing presentation rather than disappearing without a bubble. */
export function ActivityTypingReplacement(props: ComposerAccessoryProps) {
  // Subscribe to which agents are replaced, not every observer frame.
  const agents = useSyncExternalStore(
    props.session.agentActivity.subscribe,
    () => replacedAgents(props),
  );
  return (
    <>
      {agents
        .split(",")
        .filter(Boolean)
        .map((agent) => (
          <TypingReplacement key={agent} {...props} agent={agent} />
        ))}
    </>
  );
}
function replacedAgents(props: ComposerAccessoryProps) {
  const activity = props.session.agentActivity.snapshot();
  const ids = [
    ...(props.threadRootId ? [props.threadRootId] : []),
    ...(activity.local ?? [])
      .filter(
        (request) =>
          request.channelId === props.channelId &&
          (!props.threadRootId ||
            (request.threadRootId ?? request.messageId) === props.threadRootId),
      )
      .map((request) => request.messageId),
    ...activity.turns.flatMap((turn) =>
      turn.channelId === props.channelId
        ? (turn.requests ?? [])
            .filter(
              (request) =>
                !props.threadRootId ||
                request.threadRootId === props.threadRootId,
            )
            .map((request) => request.messageId)
        : [],
    ),
  ];
  return requestWork(activity, props.channelId, ids)
    .map(({ agent }) => agent)
    .join(",");
}
function TypingReplacement({
  session,
  channelId,
  threadRootId,
  agent,
}: ComposerAccessoryProps & { agent: string }) {
  useTypingReplacement(
    { session, channelId, threadRootId, pubkey: agent },
    true,
  );
  return null;
}

function ActivityAvatar({
  session,
  entry,
  size = "compact",
}: Pick<ComposerAccessoryProps, "session"> & {
  entry: Entry;
  size?: "compact" | "small";
}) {
  return (
    <Avatar
      src={avatarMedia(entry.picture, session.media)}
      alt={entry.name}
      fallback={entry.name}
      size={size}
      shape="squircle"
    />
  );
}
