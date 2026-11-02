// A Buzz conversation's Pi conversation, read from the agent's Pi durable
// storage through the host and shown in the host's turn-transcript model. Pi
// owns the entries; nothing here writes or keeps them.
import { isMessageTool } from "../../buzz-mcp/session-tools";
import { readEventBody } from "../../features/agent-harness/turn-records";
import {
  promptMessage,
  promptSections,
  STEER,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
} from "../../features/agents/activity-transcript";
import type { Pi } from "./pi";

/** The latest turns shown; Pi's storage keeps the rest. */
export const TURN_LIMIT = 50;
const PREFIX = "buzz_";
const KINDS: Record<string, string> = {
  read: "read",
  write: "edit",
  edit: "edit",
  bash: "execute",
};

type Part = Readonly<{
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Readonly<Record<string, unknown>>;
}>;
type Message = Readonly<{
  role: string;
  content?: string | readonly Part[];
  timestamp?: number;
  toolCallId?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  provider?: string;
  responseId?: string;
  /** pi-ai's token counts and cost of an answer. */
  usage?: unknown;
}>;
/** A Pi entry as the host reads it: its messages, as pi-ai has them. */
export type PiEntry = Readonly<{
  id: number;
  kind: string;
  /** A tool result Pi wrote for a call an abort cut off. */
  aborted?: boolean;
  model?: readonly Message[];
}>;
/** The Pi conversation of a Buzz thread or channel. */
type Conversation = Readonly<{
  conversation: number;
  channelId: string;
  root?: string;
}>;
type PiTranscript = Transcript & { more: boolean };

const text = (content: Message["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .map((part) =>
          part.type === "text"
            ? (part.text ?? "")
            : part.type === "image"
              ? "[image]"
              : "",
        )
        .filter(Boolean)
        .join("\n");
const str = (value: unknown) => (typeof value === "string" ? value : "");
/** A person's display name, if known. */
type Names = (pubkey: string) => string | undefined;
/** A Buzz prompt, or a steer, as the turn's opening item. */
function prompt(
  id: string,
  at: number,
  raw: string,
  name?: Names,
): TranscriptItem {
  let sections = promptSections(raw);
  const steer = sections.find((section) => section.tag === STEER);
  // An older steer wraps a whole turn.
  if (steer && !readEventBody(steer.body))
    sections = promptSections(steer.body);
  const { text, author } = promptMessage(sections, name);
  return {
    id,
    at,
    type: "prompt",
    text: text || raw,
    ...(author ? { author } : {}),
    sections,
    steer: !!steer,
  };
}
/** Whether an entry is a prompt that opens a turn, not a steer into one. */
const opens = ({ id, kind, model }: PiEntry) => {
  if (kind !== "pi.user") return false;
  const item = prompt(String(id), 0, text(model?.[0]?.content));
  return !(item.type === "prompt" && item.steer);
};

/** Entries, oldest first, as turns, each opened by a prompt. */
export function piTurns(
  entries: readonly PiEntry[],
  conversation: Conversation,
  working: boolean,
  name?: Names,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const tools = new Map<string, ToolItem>();
  /** Messages sent with send, until their result says whether they were posted. */
  const sends = new Map<
    string,
    { turn: TranscriptTurn; message: { posted?: boolean } }
  >();
  let last = 0;
  /** The aborted answer the turn ends with so far, by its message's id. */
  let aborted: string | undefined;
  const turn = (id: string, at: number, partial: boolean) => {
    const current = turns.at(-1);
    if (current) current.endedAt = Math.max(last, current.startedAt);
    const next: TranscriptTurn = {
      turnId: id,
      channelId: conversation.channelId,
      threadRootId: conversation.root ?? null,
      triggeringEventIds: [],
      sessionId: String(conversation.conversation),
      newSession: false,
      config: [],
      startedAt: at,
      partial,
      items: [],
    };
    turns.push(next);
    return next;
  };
  for (const entry of entries)
    (entry.model ?? []).forEach((message, position) => {
      const id = `${entry.id}:${position}`;
      const at = message.timestamp ?? last;
      if (entry.kind === "pi.user" && message.role === "user") {
        aborted = undefined;
        const item = prompt(id, at, text(message.content), name);
        const current =
          item.type === "prompt" && item.steer ? turns.at(-1) : undefined;
        (current ?? turn(id, at, false)).items.push(item);
        last = at;
        return;
      }
      if (message.role !== "assistant" && message.role !== "toolResult") return;
      const current = turns.at(-1) ?? turn(id, at, true);
      last = at;
      if (message.role === "toolResult") {
        const sent = sends.get(message.toolCallId ?? "");
        if (sent && !message.isError) sent.message.posted = true;
        else if (sent)
          sent.turn.items.push({
            id,
            at,
            type: "status",
            text: `The message above was not posted: ${text(message.content)}`,
          });
        // A Stop in the tools phase leaves no aborted answer, only these
        // results; an answer after them means the run went on.
        if (entry.aborted) current.stopReason = "stopped";
        const tool = tools.get(message.toolCallId ?? "");
        if (!tool) return;
        tool.output = text(message.content);
        tool.status = entry.aborted
          ? "terminated"
          : message.isError
            ? "failed"
            : "completed";
        tool.completedAt = at;
        return;
      }
      if (message.model && !current.config.includes(message.model))
        current.config.push(message.model);
      // Pi keeps each failed attempt it retried: only the last one counts.
      if (message.stopReason === "error")
        current.error = message.errorMessage || "The model did not answer";
      else delete current.error;
      // Pi saves an interrupted run's partial answer as aborted, then
      // continues the turn: a later answer replaces it. A Stop ends the run,
      // so its aborted answer stays last.
      if (aborted !== undefined) {
        const prefix = `${aborted}:`;
        current.items = current.items.filter(
          (item) => !item.id.startsWith(prefix),
        );
      }
      if (message.stopReason === "aborted") {
        current.stopReason = "stopped";
        aborted = id;
      } else {
        delete current.stopReason;
        aborted = undefined;
      }
      (typeof message.content === "string"
        ? []
        : (message.content ?? [])
      ).forEach((part, index) => {
        const key = `${id}:${index}`;
        if (part.type === "text" && part.text?.trim())
          current.items.push({
            id: key,
            at,
            type: "message",
            text: part.text,
          });
        else if (part.type === "thinking" && part.thinking?.trim())
          current.items.push({
            id: key,
            at,
            type: "thought",
            text: part.thinking,
          });
        else if (part.type === "toolCall") {
          const name = str(part.name);
          const input = part.arguments ?? {};
          if (
            name.startsWith(PREFIX) &&
            isMessageTool(name.slice(PREFIX.length)) &&
            str(input.text).trim()
          ) {
            const message: TranscriptItem & { posted?: boolean } = {
              id: key,
              at,
              type: "message",
              text: str(input.text),
            };
            current.items.push(message);
            sends.set(str(part.id), { turn: current, message });
            return;
          }
          const path = str(input.path);
          const tool: ToolItem = {
            id: key,
            at,
            type: "tool",
            toolCallId: str(part.id),
            // Buzz tools as Claude's transcript names them: buzz.read.
            title:
              str(input.command) ||
              (name.startsWith(PREFIX)
                ? `buzz.${name.slice(PREFIX.length)}`
                : name),
            kind: KINDS[name] ?? "other",
            status: "in_progress",
            input: JSON.stringify(input, null, 2),
            output: "",
            diffs: [],
            paths: path ? [path] : [],
            truncated: false,
          };
          tools.set(tool.toolCallId, tool);
          current.items.push(tool);
        }
      });
    });
  const current = turns.at(-1);
  if (current && !working) current.endedAt = Math.max(last, current.startedAt);
  return turns;
}

/** The conversation's latest turns, read newest first until there are
 * enough of them. */
export async function readTranscript(
  pi: Pick<Pi, "request">,
  agent: string,
  conversation: Conversation,
  working: boolean,
  signal: AbortSignal,
  name?: Names,
): Promise<PiTranscript> {
  const entries: PiEntry[] = [];
  let turns = 0;
  let cursor: unknown;
  do {
    const page = await pi.request<{ entries: PiEntry[]; next?: unknown }>(
      "entries",
      {
        agent,
        conversation: conversation.conversation,
        ...(cursor ? { cursor } : {}),
      },
    );
    signal.throwIfAborted();
    entries.push(...page.entries);
    turns += page.entries.filter(opens).length;
    cursor = page.next;
    // One more than shown, so the oldest shown turn starts with its prompt.
  } while (cursor && turns <= TURN_LIMIT);
  const all = piTurns(entries.reverse(), conversation, working, name);
  return {
    turns: all.slice(-TURN_LIMIT),
    more: all.length > TURN_LIMIT,
  };
}
