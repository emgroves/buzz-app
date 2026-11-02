import type { AgentViewProps } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type {
  JsonValue,
  NavigationScope,
  OpenTarget,
} from "../../features/navigation/targets";

type PageTarget = Extract<OpenTarget, { kind: "page" }>;
const providerKey = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

export function agentProviderRoute(value: JsonValue | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const keys = Object.keys(value);
  const provider = (value as Readonly<Record<string, JsonValue>>).provider;
  return keys.length === 1 &&
    keys[0] === "provider" &&
    typeof provider === "string" &&
    providerKey.test(provider)
    ? provider
    : undefined;
}

/** An agent of yours to open, as `{ agent: pubkey }`. */
export function agentRoute(value: JsonValue | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const keys = Object.keys(value);
  const agent = (value as Readonly<Record<string, JsonValue>>).agent;
  return keys.length === 1 &&
    keys[0] === "agent" &&
    typeof agent === "string" &&
    /^[0-9a-f]{64}$/.test(agent)
    ? agent
    : undefined;
}

export const availableAgentProviderRoute = (value: JsonValue) =>
  Boolean(agentProviderRoute(value) ?? agentRoute(value));

/** The Agents page with `pubkey` open. */
export const agentTarget = (pubkey: string) =>
  ({
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    route: { version: 1, params: { agent: pubkey } },
  }) as const;

export function agentProviderTarget(
  target: PageTarget,
  provider?: string,
): PageTarget {
  const { route: _route, ...page } = target;
  return provider
    ? { ...page, route: { version: 1, params: { provider } } }
    : page;
}

/** Opens an activity turn's channel, or its thread at the root, in `scope`'s
 * community; undefined where the host can't navigate there. */
export function conversationOpener(
  navigation: Navigation | undefined,
  scope: NavigationScope | undefined,
): AgentViewProps["openConversation"] {
  if (!navigation || !scope) return undefined;
  return (channelId, threadRootId) =>
    void navigation.open({
      version: 1,
      kind: "conversation",
      scope,
      channelId,
      ...(threadRootId ? { messageId: threadRootId, threadRootId } : {}),
    });
}
