import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import type { ChannelChoice } from "../../features/agents/attention";
import type {
  Agent,
  AgentConversation,
  AgentSettingsHost,
  Agents,
  AgentViewProps,
  RegisteredAgentType,
  TranscriptRequest,
} from "../../features/agents/service";
import type { AgentMemories } from "../../features/agents/MemoryPanel";
import type { CommunityReader } from "../../features/communities/service";
import { agentSections } from "../../features/agents/tabs";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentSaveState } from "../../features/agents/AgentSaveButton";

/** An agent's sections as tabs, opening on the first. */
export function AgentTabs(props: {
  agents: Agents;
  agent: Agent;
  type: RegisteredAgentType | undefined;
  channels: readonly ChannelChoice[];
  settingsHost: AgentSettingsHost;
  memories: AgentMemories | undefined;
  communities?: CommunityReader | undefined;
  settingsContent: ReactNode;
  conversation?: AgentConversation | undefined;
  initialActivity?: boolean | undefined;
  initialTranscript?: TranscriptRequest | undefined;
  close?: (() => void) | undefined;
  openConversation?: AgentViewProps["openConversation"];
  onDiscard?: () => void;
}) {
  const split = props.type?.tabs?.some(
    (section) => section.role === "settings" && section.splitSettings,
  );
  const supplied = agentSections({
    ...props,
    ...(split ? { settingsSection: "identity" as const } : {}),
  });
  const identity = supplied.find(
    (section) => section.value === "agent:settings",
  );
  const sections = [
    ...(identity ? [{ ...identity, label: "Identity" }] : []),
    ...supplied.filter((section) => section.value.startsWith("agent:type:")),
    ...supplied.filter((section) => section.value === "agent:memory"),
    ...supplied.filter((section) => section.value === "agent:activity"),
    ...supplied.filter((section) => section.value.startsWith("agent:added:")),
    ...supplied.filter((section) => section.value === "agent:history"),
    {
      value: "agent:management",
      label: "Settings",
      render: () => props.settingsContent,
    },
  ];
  const [tab, setTab] = useState<string>(
    props.initialActivity ? "agent:activity" : (sections[0]?.value ?? ""),
  );
  const [draft, setDraft] = useState({ dirty: false, saving: false });
  const drafts = useRef(new Map<string, { dirty: boolean; saving: boolean }>());
  const reportDraft = useCallback(
    (state: { dirty: boolean; saving: boolean } | null, id: string) => {
      if (state) drafts.current.set(id, state);
      else drafts.current.delete(id);
      const states = [...drafts.current.values()];
      setDraft({
        dirty: states.some((state) => state.dirty),
        saving: states.some((state) => state.saving),
      });
    },
    [],
  );
  const [pendingTab, setPendingTab] = useState<string>();
  const panelPrefix = useId();
  const selected =
    sections.find((section) => section.value === tab) ?? sections[0];
  const settingsSelected =
    selected?.value === "agent:settings" ||
    selected?.value === "agent:management";
  // Each section owns its draft and save action for its visible lifetime.
  const settings = split
    ? agentSections({
        ...props,
        settingsSection:
          selected?.value === "agent:management" ? "runtime" : "identity",
        settingsContent: props.settingsContent,
      }).find((section) => section.value === "agent:settings")
    : undefined;
  const settingsValue =
    selected?.value === "agent:management"
      ? "agent:management"
      : "agent:settings";
  const panelId = (value: string) => `${panelPrefix}-${value}`;
  return (
    <AgentSaveState value={reportDraft}>
      <Tabs
        value={selected?.value ?? ""}
        onValueChange={(value) => {
          if (value === selected?.value || draft.saving) return;
          if (draft.dirty || props.settingsHost.pendingSave)
            setPendingTab(value);
          else setTab(value);
        }}
        items={sections.map(({ value, label }) => ({
          value,
          label,
          panelId: panelId(value),
          disabled: draft.saving && value !== selected?.value,
        }))}
        label={`${props.agent.name} sections`}
        variant="panel"
      />
      {settings && settingsSelected && (
        <div
          key={settingsValue}
          role="tabpanel"
          id={panelId(settingsValue)}
          aria-labelledby={`${panelId(settingsValue)}-tab`}
        >
          <div className="grid gap-6 pt-4">{settings.render()}</div>
        </div>
      )}
      {sections
        .filter(
          ({ value }) =>
            !(
              settings &&
              (value === "agent:settings" || value === "agent:management")
            ) && value === selected?.value,
        )
        .map((section) => (
          <div
            role="tabpanel"
            id={panelId(section.value)}
            aria-labelledby={`${panelId(section.value)}-tab`}
            key={section.value}
          >
            <div className="grid gap-6 pt-4">{section.render()}</div>
          </div>
        ))}
      {pendingTab && (
        <AlertDialog
          title="Discard changes?"
          description="Your unsaved changes will be lost if you switch tabs."
          onClose={() => setPendingTab(undefined)}
          actions={
            <>
              <Button onClick={() => setPendingTab(undefined)}>
                Keep editing
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  props.onDiscard?.();
                  setDraft({ dirty: false, saving: false });
                  setTab(pendingTab);
                  setPendingTab(undefined);
                }}
              >
                Discard changes
              </Button>
            </>
          }
        />
      )}
    </AgentSaveState>
  );
}
