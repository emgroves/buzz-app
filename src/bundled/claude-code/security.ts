import type { AgentProtection } from "../../features/agent-protection/service";
import type { Spawn } from "./claude";
export const PROTECTED_CLAUDE_VERSION = "2.1.305";
export type ClaudeProtection = Readonly<{
  gate: AgentProtection;
  history(path: string, signal: AbortSignal): Promise<unknown>;
}>;
/** Native request logs repeat tool catalogues; retain all conversation evidence. */
export function protectionHistoryEntry(entry: unknown): unknown {
  const record = entry as Record<string, unknown> | null;
  const attachment = record?.attachment as Record<string, unknown> | undefined;
  const field =
    record?.type === "attachment" && attachment?.type === "prompt_snapshot"
      ? "attachment"
      : record?.type === "api-request-shape"
        ? "shape"
        : undefined;
  const value = field && record?.[field];
  if (
    !field ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("tools" in value)
  )
    return entry;
  const { tools: _catalogue, ...evidence } = value;
  return { ...record, [field]: evidence };
}
type InputSource = {
  kind: "context" | "tool-result";
  content: { source: string; value: unknown };
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const bookkeeping = [
  "type",
  "parentUuid",
  "isSidechain",
  "promptId",
  "uuid",
  "timestamp",
  "permissionMode",
  "promptSource",
  "turnOrigin",
  "turnPosition",
  "userType",
  "entrypoint",
  "cwd",
  "sessionId",
  "session_id",
  "version",
  "gitBranch",
  "isReplay",
  "parent_tool_use_id",
];
/** Canonical model content lets the provider recognize approved native replays.
 * Unknown fields remain independent evidence; action records stay untouched. */
export function protectionSources(
  value: unknown,
  source = "message",
  kind: InputSource["kind"] = "context",
): InputSource[] {
  const raw = (value: unknown, label = source): InputSource => ({
    kind,
    content: { source: label, value },
  });
  if (!record(value)) return [raw(value)];
  const residual = (keys: string[]) => {
    const rest = Object.fromEntries(
      Object.entries(value).filter(([key]) => !keys.includes(key)),
    );
    return Object.keys(rest).length ? [raw(rest)] : [];
  };
  const message = (message: unknown): InputSource[] => {
    if (!record(message) || typeof message.role !== "string")
      return [raw(message)];
    const { role, content, ...rest } = message;
    const blocks = Array.isArray(content) ? content : [content];
    return [
      ...blocks.flatMap((block): InputSource[] => {
        const text =
          record(block) &&
          block.type === "text" &&
          typeof block.text === "string";
        const extra = text
          ? Object.fromEntries(
              Object.entries(block).filter(
                ([key]) => key !== "type" && key !== "text",
              ),
            )
          : {};
        return [
          {
            kind:
              record(block) && block.type === "tool_result"
                ? "tool-result"
                : "context",
            content: {
              source: "message",
              value: { role, content: text ? block.text : block },
            },
          },
          ...(Object.keys(extra).length ? [raw(extra)] : []),
        ];
      }),
      ...(Object.keys(rest).length ? [raw(rest)] : []),
    ];
  };
  if (source === "hook" && typeof value.prompt === "string")
    return [
      ...message({ role: "user", content: value.prompt }),
      ...residual(["prompt", "prompt_id"]),
    ];
  if (value.type === "api-request-blob")
    return [
      ...message(value.message),
      ...residual(["type", "sessionId", "hash", "message"]),
    ];
  if (
    ["user", "assistant"].includes(String(value.type)) &&
    record(value.message) &&
    value.message.role === value.type
  )
    return [
      ...message(value.message),
      ...residual([...bookkeeping, "message"]),
    ];
  if (value.type === "queue-operation")
    return [
      ...(typeof value.content === "string"
        ? message({ role: "user", content: value.content })
        : []),
      ...residual([
        "type",
        "operation",
        "timestamp",
        "sessionId",
        ...(typeof value.content === "string" ? ["content"] : []),
      ]),
    ];
  // A native preview is not another model message; its full prompt is above.
  if (value.type === "last-prompt")
    return residual([
      "type",
      "lastPrompt",
      "leafUuid",
      "explicit",
      "rewound",
      "sessionId",
    ]);
  if (typeof value.role === "string" && "content" in value)
    return message(value);
  return [raw(value)];
}
export async function protectedRuntime(spawn: Spawn) {
  let stdout = "",
    stderr = "";
  const process = await spawn("runtime", {
    env: { BUZZ_CLAUDE_VERSION: PROTECTED_CLAUDE_VERSION },
    onStdout: (data) => {
      stdout += data;
    },
    onStderr: (data) => {
      stderr += data;
    },
  });
  const timer = setTimeout(() => void process.kill(), 15000);
  try {
    if ((await process.exited) !== 0)
      throw new Error(
        stderr.trim() || "Install the protected Claude runtime in Buzz",
      );
    const result = JSON.parse(stdout) as { version: string; root: string };
    if (
      result.version !== PROTECTED_CLAUDE_VERSION ||
      !result.root?.startsWith("/")
    )
      throw new Error("The protected Claude runtime is unavailable");
    return result;
  } finally {
    clearTimeout(timer);
  }
}
