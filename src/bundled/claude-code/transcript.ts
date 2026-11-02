// A conversation's Claude Code session, read from the transcript Claude Code
// keeps on this computer and shown in the host's turn-transcript model. Claude
// Code owns the file; nothing here writes or keeps it.
import { isMessageTool } from "../../buzz-mcp/session-tools";
import { readEventBody } from "../../features/agent-harness/turn-records";
import { readFile } from "../../buzz-mcp/app-client";
import {
  promptMessage,
  promptSections,
  STEER,
  type ToolItem,
  type Transcript,
  type TranscriptItem,
  type TranscriptTurn,
} from "../../features/agents/activity-transcript";
import type { Spawn } from "./claude";
import { readProject, type Start } from "./history";

/** The latest turns shown; the file keeps the rest. */
export const TURN_LIMIT = 50;
/** A conversation's transcript, and why some of its sessions may be missing
 * when the history could not all be searched. */
export type ClaudeTranscript = Transcript & {
  more: boolean;
  incomplete?: string;
};

type Json = Record<string, unknown>;
/** A person's display name, if known. */
type Names = (pubkey: string) => string | undefined;
/** One session file's conversation. */
type Session = Readonly<{
  sessionId: string;
  channelId: string;
  root?: string;
}>;
/** A conversation to read: the agent's sessions for its thread or channel,
 * including the one this build of the app saved, if any. */
export type Conversation = Readonly<{
  /** The agent's membership key, as its turn prompts name it. */
  agent: string;
  sessionId?: string;
  channelId: string;
  root?: string;
}>;

const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const blocks = (value: unknown) =>
  (Array.isArray(value) ? value : []).flatMap((block) => {
    const entry = object(block);
    return entry ? [entry] : [];
  });
const text = (value: unknown) =>
  typeof value === "string"
    ? value
    : blocks(value)
        .map((block) => str(block.text))
        .filter(Boolean)
        .join("\n");
const KINDS: Record<string, string> = {
  Bash: "execute",
  Read: "read",
  Edit: "edit",
  Write: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
};

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

/** Transcript lines as turns, each opened by a prompt. Claude Code's own
 * entries (metadata, subagents, attachments) are left out. */
export function claudeTurns(
  file: string,
  conversation: Session,
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
  const turn = (id: string, at: number, partial: boolean) => {
    const current = turns.at(-1);
    if (current) current.endedAt = Math.max(last, current.startedAt);
    const next: TranscriptTurn = {
      turnId: id,
      channelId: conversation.channelId,
      threadRootId: conversation.root ?? null,
      triggeringEventIds: [],
      sessionId: conversation.sessionId,
      newSession: false,
      config: [],
      startedAt: at,
      partial,
      items: [],
    };
    turns.push(next);
    return next;
  };
  for (const line of file.split("\n")) {
    let entry: Json | undefined;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry || entry.isSidechain || entry.isMeta) continue;
    const message = object(entry.message);
    const id = str(entry.uuid);
    const at = Date.parse(str(entry.timestamp)) || last;
    if (
      !message ||
      !id ||
      (entry.type !== "user" && entry.type !== "assistant")
    )
      continue;
    const results = blocks(message.content).filter(
      (block) => block.type === "tool_result",
    );
    if (entry.type === "user" && !results.length) {
      const item = prompt(id, at, text(message.content), name);
      const current =
        item.type === "prompt" && item.steer ? turns.at(-1) : undefined;
      (current ?? turn(id, at, false)).items.push(item);
      last = at;
      continue;
    }
    const current = turns.at(-1) ?? turn(id, at, true);
    last = at;
    for (const result of results) {
      const sent = sends.get(str(result.tool_use_id));
      if (sent && !result.is_error) sent.message.posted = true;
      else if (sent) {
        sent.turn.items.push({
          id: `${id}:${str(result.tool_use_id)}`,
          at,
          type: "status",
          text: `The message above was not posted: ${text(result.content)}`,
        });
      }
      const tool = tools.get(str(result.tool_use_id));
      if (!tool) continue;
      tool.output = text(result.content);
      tool.status = result.is_error ? "failed" : "completed";
      tool.completedAt = at;
    }
    blocks(message.content).forEach((block, index) => {
      const key = `${id}:${index}`;
      if (block.type === "text" && str(block.text).trim())
        current.items.push({
          id: key,
          at,
          type: "message",
          text: str(block.text),
        });
      else if (block.type === "thinking" && str(block.thinking).trim())
        current.items.push({
          id: key,
          at,
          type: "thought",
          text: str(block.thinking),
        });
      else if (block.type === "tool_use") {
        const name = str(block.name);
        const input = object(block.input) ?? {};
        if (
          name.startsWith("mcp__buzz__") &&
          isMessageTool(name.slice("mcp__buzz__".length)) &&
          str(input.text).trim()
        ) {
          const message: TranscriptItem & { posted?: boolean } = {
            id: key,
            at,
            type: "message",
            text: str(input.text),
          };
          current.items.push(message);
          sends.set(str(block.id), { turn: current, message });
          return;
        }
        const path = str(input.file_path) || str(input.path);
        const tool: ToolItem = {
          id: key,
          at,
          type: "tool",
          toolCallId: str(block.id),
          // MCP tools as Codex names them: buzz.read, not mcp__buzz__read.
          title: str(input.command) || name.replace(/^mcp__(.+?)__/, "$1."),
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
  }
  const current = turns.at(-1);
  if (current && !working) current.endedAt = Math.max(last, current.startedAt);
  return turns;
}

/** Claude Code's project folder name for a working directory. Longer paths
 * get a hash suffix this does not reproduce, so they are not found. */
export const projectName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const PROJECT_NAME_LIMIT = 200;

/** Whether a session file was started for `conversation`: its first prompt
 * names the same agent, channel and, for a thread session, thread root.
 * Prompts from before agents were named match any agent. */
export function startedFor(file: string, conversation: Conversation) {
  for (const line of file.split("\n")) {
    let entry: Json | undefined;
    try {
      entry = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry?.type !== "user" || entry.isMeta || entry.isSidechain) continue;
    const context = promptSections(text(object(entry.message)?.content)).find(
      (section) => section.tag === "context",
    )?.body;
    if (!context) return false;
    const field = (name: string) =>
      context.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1];
    const agent = field("Agent");
    return (
      (agent === undefined || agent === conversation.agent) &&
      !!field("Channel")?.endsWith(`(#${conversation.channelId})`) &&
      (conversation.root
        ? field("Session scope") === "thread" &&
          field("Thread root") === conversation.root
        : field("Session scope") !== "thread")
    );
  }
  return false;
}

/** Whether the index says a session was started for `conversation`. Its
 * fields come from the first line naming any, which `startedFor` checks is
 * the first prompt once the file is read. */
const indexedFor = (start: Start, conversation: Conversation) =>
  (start.agent === undefined || start.agent === conversation.agent) &&
  start.channelId === conversation.channelId &&
  (conversation.root
    ? start.scope === "thread" && start.root === conversation.root
    : start.scope !== "thread");

/** The Claude Code project directory name for the agent's workspace, or
 * undefined when it is too long to be one. */
export async function workspaceProject(
  spawn: Spawn,
  workspace: string,
  signal: AbortSignal,
) {
  let directory = "";
  const process = await spawn("workspace", {
    cwd: workspace,
    onStdout: (data) => {
      directory += data;
    },
  });
  if ((await process.exited) !== 0)
    throw new Error("Could not find the agent's workspace");
  signal.throwIfAborted();
  const project = projectName(directory.trim());
  return project.length > PROJECT_NAME_LIMIT ? undefined : project;
}

/** The title Claude Code generated for a session (its latest `ai-title`
 * record), or undefined before it has one. */
export async function readSessionTitle(
  spawn: Spawn,
  workspace: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const project = await workspaceProject(spawn, workspace, signal);
  if (!project || !/^[\w-]+$/.test(sessionId)) return undefined;
  let file: string;
  try {
    file = new TextDecoder().decode(
      await readFile(
        spawn,
        "~/.claude/projects",
        `./${project}/${sessionId}.jsonl`,
        signal,
      ),
    );
  } catch (error) {
    signal.throwIfAborted();
    if (/no such file/i.test(error instanceof Error ? error.message : ""))
      return undefined;
    throw error;
  }
  let title: string | undefined;
  for (const line of file.split("\n")) {
    if (!line.includes('"ai-title"')) continue;
    try {
      const record = object(JSON.parse(line));
      const value = str(record?.aiTitle).trim();
      if (record?.type === "ai-title" && value) title = value;
    } catch {
      // A partial last line is still being written.
    }
  }
  return title;
}

/** The conversation's transcript across its sessions, or undefined when this
 * computer has no file for it: deleted, or started in a workspace the agent
 * no longer uses. */
export async function readTranscript(
  spawn: Spawn,
  workspace: string,
  conversation: Conversation,
  working: boolean,
  signal: AbortSignal,
  nameOf?: Names,
): Promise<ClaudeTranscript | undefined> {
  const project = await workspaceProject(spawn, workspace, signal);
  if (!project) return undefined;
  const saved = conversation.sessionId && `${conversation.sessionId}.jsonl`;
  // The agent starts a new session when it cannot resume one, e.g. in
  // another build of the app, which keeps its own saved sessions. A failed
  // listing still finds the saved one, and a partly failed search the
  // sessions it did search; the transcript says it may be missing some.
  let failure: unknown;
  const starts = await readProject(spawn, project).then(
    (state) => {
      failure = state.incomplete;
      return state.starts;
    },
    (error: unknown) => {
      failure = error;
      return new Map<string, Start>();
    },
  );
  const names = new Set([
    ...(saved ? [saved] : []),
    ...[...starts]
      .filter(([, start]) => indexedFor(start, conversation))
      .map(([name]) => name),
  ]);
  signal.throwIfAborted();
  const turns: TranscriptTurn[] = [];
  let found = false;
  for (const name of names) {
    let file: string;
    try {
      file = new TextDecoder().decode(
        await readFile(
          spawn,
          "~/.claude/projects",
          // Project names start with `-`; GNU base64 would read one as options.
          `./${project}/${name}`,
          signal,
        ),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (/no such file/i.test(error instanceof Error ? error.message : ""))
        continue;
      throw error;
    }
    if (name !== saved && !startedFor(file, conversation)) continue;
    found = true;
    const sessionId = name.slice(0, -".jsonl".length);
    turns.push(
      ...claudeTurns(
        file,
        {
          sessionId,
          channelId: conversation.channelId,
          ...(conversation.root ? { root: conversation.root } : {}),
        },
        working && name === saved,
        nameOf,
      ),
    );
  }
  // Nothing found is no transcript only when every file was searched.
  if (!found) {
    if (failure) throw failure;
    return undefined;
  }
  turns.sort((a, b) => a.startedAt - b.startedAt);
  return {
    turns: turns.slice(-TURN_LIMIT),
    more: turns.length > TURN_LIMIT,
    ...(failure
      ? {
          incomplete:
            failure instanceof Error ? failure.message : String(failure),
        }
      : {}),
  };
}
