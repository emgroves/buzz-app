// The turns a remote agent published to its owner over the relay this session.
import {
  type ComponentType,
  type ReactNode,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useRelayConnection } from "../../../features/relay/react";
import type { RelayData } from "../../../features/relay/service";
import type { RelaySession } from "../../../features/relay/session";
import { activityTranscript } from "../../../features/agents/activity-transcript";
import { ActivityTranscript } from "../../../features/agents/ActivityTranscript";
import type { Agent, AgentViewProps } from "../../../features/agents/service";

export type AgentActivity = RelaySession["agentActivity"];

const UNAVAILABLE = "Activity isn't available here.";

export function createActivityTab(
  relay: RelayData,
): ComponentType<AgentViewProps> {
  return function PublishedActivity({ agent, openConversation }) {
    const connection = useRelayConnection(relay);
    return (
      <ActivityPanel
        agent={agent}
        openConversation={openConversation}
        activity={
          connection.status === "ready"
            ? connection.session.agentActivity
            : undefined
        }
      />
    );
  };
}

export function ActivityPanel({
  agent,
  activity,
  openConversation,
}: {
  agent: Agent;
  /** Absent while the owner's session connects. */
  activity: AgentActivity | undefined;
  openConversation?: AgentViewProps["openConversation"];
}) {
  if (!activity) return <Note>Activity shows once Buzz is connected.</Note>;
  return (
    <ActivityFeed
      agent={agent}
      activity={activity}
      openConversation={openConversation}
    />
  );
}

// Hosted frames don't always name their thread, so turns aren't scoped to the
// conversation the agent was opened from.
function ActivityFeed({
  agent,
  activity,
  openConversation,
}: {
  agent: Agent;
  activity: AgentActivity;
  openConversation: AgentViewProps["openConversation"];
}) {
  // The Agent Activity plugin owns the feed's lease; this only reads it.
  const snapshot = useSyncExternalStore(
    activity.subscribe,
    activity.snapshot,
    activity.snapshot,
  );
  const transcript = useMemo(
    () =>
      activityTranscript(
        snapshot.records.filter((record) => record.agent === agent.pubkey),
        { agent: agent.pubkey },
      ),
    [snapshot.records, agent.pubkey],
  );
  if (snapshot.status === "unavailable") return <Note>{UNAVAILABLE}</Note>;
  if (snapshot.status === "disabled")
    return (
      <Note>Turn on Agent Activity in Settings → Plugins to see activity.</Note>
    );
  if (!transcript.turns.length && snapshot.status === "connecting")
    return <Note>Connecting to the live feed…</Note>;
  const state = new Map(
    snapshot.turns
      .filter((turn) => turn.agent === agent.pubkey)
      .map((turn) => [turn.turnId, turn.state]),
  );
  return (
    <ActivityTranscript
      transcript={transcript}
      agentName={agent.name}
      state={(turnId) => state.get(turnId)}
      follow={false}
      openConversation={openConversation}
      before={
        <>
          <Note>
            Turns from all of this agent's conversations, captured while Buzz
            has been open. Earlier turns aren't shown.
          </Note>
          {snapshot.status === "interrupted" && (
            <Note>
              The live feed was interrupted; it reconnects on its own.
            </Note>
          )}
          {snapshot.trimmed > 0 && (
            <Note>Older activity was dropped to save memory.</Note>
          )}
        </>
      }
    />
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-body-sm text-secondary">
      {children}
    </p>
  );
}
