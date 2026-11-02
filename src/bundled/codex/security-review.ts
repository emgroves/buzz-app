import { resolveModel } from "./config";
import { AppServer, listModels } from "./rpc";
import type {
  ProtectedSpawn,
  ReviewPrompt,
} from "../../features/agent-protection/models";

type Started = { thread: { id: string }; model: string };
type Begun = { turn: { id: string } };
type Worker = Readonly<{
  rpc: AppServer;
  /** The worker's MCP servers, each turned off for review threads. */
  mcp: Record<string, Record<string, unknown>>;
}>;
// One worker per protection provider: its spawn stays the same while the
// provider lasts, and the provider kills the worker when it goes.
const workers = new WeakMap<ProtectedSpawn, Promise<Worker>>();

function worker(spawn: ProtectedSpawn) {
  const known = workers.get(spawn);
  if (known) return known;
  const rpc = new AppServer();
  const ready = (async () => {
    await rpc.open(
      (_id, options) =>
        spawn({
          ...options,
          env: { BUZZ_SECURITY_REVIEW_ONLY: "1", BASH_ENV: null, ENV: null },
        }),
      undefined,
      true,
    );
    const normalized = await rpc.request<{
      config: { mcp_servers?: Record<string, Record<string, unknown>> };
    }>("config/read", {});
    const mcp = Object.fromEntries(
      Object.entries(normalized.config.mcp_servers ?? {}).map(
        ([name, server]) => [
          name,
          {
            ...(typeof server.command === "string"
              ? { command: server.command }
              : { url: server.url }),
            enabled: false,
          },
        ],
      ),
    );
    return { rpc, mcp };
  })();
  const drop = () => {
    if (workers.get(spawn) === ready) workers.delete(spawn);
  };
  rpc.onMessage((wire) => {
    if (wire.method === "connection/closed") drop();
  });
  ready.catch(() => {
    drop();
    void rpc.close();
  });
  workers.set(spawn, ready);
  return ready;
}

/** Reviews on a separate native worker whose model requests offer no tools and
 * whose dispatcher refuses every tool, including unadvertised calls. Each
 * review is its own ephemeral thread on the provider's one worker. */
export async function reviewModel(
  spawn: ProtectedSpawn | undefined,
  model: { provider?: string; id: string },
  prompt: ReviewPrompt,
  cancelled: AbortSignal,
) {
  if (!spawn) throw new Error("Protected Codex review worker is unavailable");
  const signal = AbortSignal.any([cancelled, AbortSignal.timeout(60_000)]);
  let threadId: string | undefined;
  let thread: Promise<Started> | undefined;
  let turn: Promise<Begun> | undefined;
  let ended = false;
  let reply = "";
  let finish!: () => void, fail!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void completed.catch(() => undefined);
  const abort = () => fail(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  // Waits for the worker without stopping it, since other reviews share it.
  const until = <T>(step: Promise<T>) =>
    Promise.race([step, completed.then(() => step)]);
  let rpc: AppServer | undefined;
  let off = () => {};
  try {
    signal.throwIfAborted();
    const ready = await until(worker(spawn));
    rpc = ready.rpc;
    off = rpc.onMessage((wire) => {
      const params = wire.params as
        | {
            threadId?: string;
            item?: { type?: string; text?: string };
            turn?: { status?: string; error?: { message?: string } };
          }
        | undefined;
      if (wire.method === "connection/closed")
        fail(new Error("The security model connection closed"));
      if (!threadId || params?.threadId !== threadId) return;
      if (
        wire.method === "item/completed" &&
        params.item?.type === "agentMessage"
      )
        reply = params.item.text ?? "";
      if (wire.method === "turn/completed") {
        ended = true;
        if (params.turn?.status === "completed") finish();
        else
          fail(
            new Error(
              params.turn?.error?.message ??
                "The security model did not complete",
            ),
          );
      }
    });
    const models = model.provider
      ? []
      : await until(listModels(rpc)).catch((error) => {
          if (!model.id || signal.aborted) throw error;
          return [];
        });
    const selected = model.provider ? model.id : resolveModel(model.id, models);
    if (!selected && !model.provider)
      throw new Error("The recommended Codex review model is unavailable");
    const entry = models.find((entry) => entry.model === selected);
    const effort = entry?.supportedReasoningEfforts.some(
      (choice) => choice.reasoningEffort === "low",
    )
      ? "low"
      : entry?.defaultReasoningEffort;
    thread = rpc.request<Started>("thread/start", {
      ...(selected ? { model: selected } : {}),
      ephemeral: true,
      developerInstructions: prompt.system,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        mcp_servers: ready.mcp,
        web_search: "disabled",
        "features.plugins": false,
        "features.apps": false,
        ...(model.provider ? { model_provider: model.provider } : {}),
      },
    });
    const started = await until(thread);
    threadId = started.thread.id;
    turn = rpc.request<Begun>("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt.input, text_elements: [] }],
      ...(effort ? { effort } : {}),
      ...(prompt.outputSchema ? { outputSchema: prompt.outputSchema } : {}),
    });
    await until(turn);
    await completed;
    return {
      text: reply,
      model: {
        ...(model.provider ? { provider: model.provider } : {}),
        id: started.model,
      },
    };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    off();
    signal.removeEventListener("abort", abort);
    if (rpc && thread) void release(rpc, thread, ended ? undefined : turn);
  }
}

/** Stops a review's unfinished turn, even one still starting, and unloads
 * its thread from the shared worker. */
async function release(
  rpc: AppServer,
  thread: Promise<Started>,
  turn: Promise<Begun> | undefined,
) {
  const threadId = (await thread.catch(() => undefined))?.thread.id;
  if (!threadId) return;
  const turnId = (await turn?.catch(() => undefined))?.turn.id;
  if (turnId)
    await rpc
      .request("turn/interrupt", { threadId, turnId })
      .catch(() => undefined);
  await rpc.request("thread/unsubscribe", { threadId }).catch(() => undefined);
}
