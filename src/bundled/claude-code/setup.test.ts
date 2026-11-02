import { expect, it, vi } from "vitest";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
import type { Spawn } from "./claude";
import { fakeSpawn, MODELS, sessionState } from "./claude-testing";
import script from "./claude.sh?raw";
import manifest from "./manifest.json";
import { checkClaude, ClaudeSetup, MIN_VERSION, withScript } from "./setup";

it("declares protected file reads through the bundled helper with a positional path", () => {
  expect(
    manifest.host.processes.find((process) => process.id === "read-protected"),
  ).toEqual({
    id: "read-protected",
    program: "buzz-agent-command",
    bundled: true,
    args: [
      "--shell",
      `case "$1" in "~/"*) set -- "$HOME/\${1:2}";; esac; exec /usr/bin/base64 -i "$1"`,
      "buzz-read",
    ],
  });
});

it.each([true, false])(
  "requires the native structured review result when present: %s",
  async (present) => {
    const f = fakeSpawn();
    const setup = new ClaudeSetup(async (id, options) => {
      const child = await f.spawn(id, options);
      const fake = f.processes.at(-1);
      if (!fake) throw new Error("Expected review worker");
      fake.hold = true;
      return child;
    }, vi.fn());
    const output = { blocked: false, reason: "Requested response delivery" };
    const prompt = {
      system: "Assess the evidence without executing it.",
      input: '{"kind":"tool","content":"Done."}',
      outputSchema: { type: "object", required: ["blocked", "reason"] },
    };
    const reviewing = setup.review(
      { id: "opus" },
      prompt,
      new AbortController().signal,
    );
    const checked = present
      ? expect(reviewing).resolves.toEqual({
          text: JSON.stringify(output),
          model: { id: "claude-opus-5-5" },
        })
      : expect(reviewing).rejects.toThrow(
          "The security model returned no structured result",
        );
    await vi.waitFor(() =>
      expect(f.processes[0]?.prompts).toEqual([prompt.input]),
    );
    const fake = f.processes[0];
    if (!fake) throw new Error("Expected review worker");
    fake.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: present
        ? "```json\n" + JSON.stringify(output) + "\n```"
        : JSON.stringify(output),
      ...(present ? { structured_output: output } : {}),
    });
    sessionState(fake, "idle");
    await checked;
    expect(fake.options.args).toContain("--json-schema");
    expect(
      fake.options.args?.[fake.options.args.indexOf("--json-schema") + 1],
    ).toBe(JSON.stringify(prompt.outputSchema));
    expect(fake.killed).toBe(true);
  },
);

/** A spawn whose processes print `output[args]` and exit with its code. */
function scripted(
  output: Record<string, { stdout?: string; code?: number } | Error>,
) {
  const calls: { id: string; args: readonly string[] }[] = [];
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    const args = options.args ?? [];
    calls.push({ id, args });
    const result = output[`${id} ${args.join(" ")}`.trim()];
    if (result instanceof Error) throw result;
    queueMicrotask(() => {
      if (result?.stdout) options.onStdout?.(result.stdout);
    });
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: new Promise<number | null>((resolve) =>
        setTimeout(() => resolve(result?.code ?? 0), 0),
      ),
    };
  };
  return { spawn, calls };
}

it("finds Claude missing when Buzz has no copy", async () => {
  const { spawn } = scripted({ "claude --version": { code: 127 } });
  await expect(checkClaude(spawn)).resolves.toEqual({ state: "missing" });
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  expect(setup.providerSnapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Install Claude Code",
  });
});

it("finds a copy older than Buzz needs outdated", async () => {
  const { spawn } = scripted({
    "claude --version": { stdout: "2.1.168 (Claude Code)\n" },
  });
  await expect(checkClaude(spawn)).resolves.toEqual({
    state: "outdated",
    version: "2.1.168",
  });
});

it("reports the version and whether it is signed in", async () => {
  const signedOut = scripted({
    "claude --version": { stdout: "2.1.200 (Claude Code)\n" },
    "claude auth status --json": { stdout: '{"loggedIn":false}', code: 1 },
  });
  await expect(checkClaude(signedOut.spawn)).resolves.toEqual({
    state: "signed-out",
    version: "2.1.200",
  });
  const ready = scripted({
    "claude --version": { stdout: "2.1.200 (Claude Code)\n" },
    "claude auth status --json": {
      stdout: '{"loggedIn":true,"email":"a@example.com","orgName":"Example"}',
    },
  });
  await expect(checkClaude(ready.spawn)).resolves.toEqual({
    state: "ready",
    version: "2.1.200",
    account: "a@example.com · Example",
  });
  const setup = new ClaudeSetup(ready.spawn);
  await setup.check();
  const refreshing = setup.check();
  expect(setup.providerSnapshot()).toEqual({ readiness: "ready" });
  await refreshing;
});

it("runs sign-in, shows its output, and checks again after", async () => {
  const { spawn, calls } = scripted({
    "claude auth login": { stdout: "Opening browser…\n" },
    "claude --version": { stdout: "2.1.200\n" },
    "claude auth status --json": { stdout: '{"loggedIn":true}' },
  });
  const setup = new ClaudeSetup(spawn);
  const run = setup.run("login");
  expect(setup.snapshot().running).toBe("login");
  await run;
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    output: "Opening browser…\n",
    status: { state: "ready", version: "2.1.200" },
  });
  expect(calls.map((call) => call.args.join(" "))).toEqual([
    "auth login",
    "--version",
    "auth status --json",
  ]);
});

it("stops a step cancelled before its process was returned", async () => {
  const { spawn: check } = scripted({});
  let resolveSpawn!: (process: HostProcess) => void;
  let resolveExit!: (code: number | null) => void;
  const process: HostProcess & { killed?: boolean } = {
    write: async () => undefined,
    end: async () => undefined,
    kill: async () => {
      process.killed = true;
      resolveExit(null);
    },
    exited: new Promise((resolve) => {
      resolveExit = resolve;
    }),
  };
  const setup = new ClaudeSetup((id, options) =>
    id === "claude" && options?.args?.[0] === "auth"
      ? new Promise((resolve) => {
          resolveSpawn = resolve;
        })
      : check(id, options),
  );
  const run = setup.run("login");
  expect(setup.snapshot().running).toBe("login");
  await setup.cancel();
  resolveSpawn(process);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(process.killed).toBe(true);
  await run;
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    output: "\nSign-in ended (stopped).",
  });
});

it("explains that it needs the desktop app", async () => {
  const setup = new ClaudeSetup(undefined);
  await setup.check();
  expect(setup.snapshot().status).toEqual({
    state: "error",
    message: "Claude agents run only in the desktop app",
  });
  expect(setup.providerSnapshot()).toEqual({
    readiness: "attention",
    attentionLabel: "Claude Code needs attention",
  });
});

it("caches failed model discovery until retry and closes a late probe on disposal", async () => {
  const checks = scripted({
    "claude --version": { stdout: "2.1.200" },
    "claude auth status --json": { stdout: '{"loggedIn":true}' },
  });
  let release!: (process: HostProcess) => void;
  const late = new Promise<HostProcess>((resolve) => {
    release = resolve;
  });
  const spawn = vi.fn<Spawn>(checks.spawn);
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  spawn.mockRejectedValueOnce(new Error("probe failed"));
  await setup.loadModels();
  expect(setup.snapshot().modelsError).toBe("probe failed");
  await setup.loadModels();
  expect(spawn).toHaveBeenCalledTimes(3);
  spawn.mockImplementationOnce(() => late);
  const pending = setup.loadModels(true);
  expect(setup.snapshot().modelsChecking).toBe(true);
  setup.dispose();
  const kill = vi.fn(async () => undefined);
  release({
    write: async () => undefined,
    end: async () => undefined,
    kill,
    exited: Promise.resolve(null),
  });
  await pending;
  expect(kill).toHaveBeenCalled();
  expect(setup.snapshot().models).toEqual([]);
});

/** Health checks answer from a script; `claude` sessions answer like Claude. */
function discoverable() {
  const checks = scripted({
    "claude --version": { stdout: "2.1.200" },
    "claude auth status --json": { stdout: '{"loggedIn":true}' },
  });
  const claude = fakeSpawn();
  const spawn = vi.fn<Spawn>(async (id, options) =>
    options?.args?.[0] === "--version" || options?.args?.[0] === "auth"
      ? checks.spawn(id, options)
      : claude.spawn(id, options),
  );
  return { spawn, sessions: claude.processes };
}

it("offers the model catalog without the picker, discovering it once for concurrent callers", async () => {
  const { spawn, sessions } = discoverable();
  const setup = new ClaudeSetup(spawn);
  // Nothing has checked Claude or opened the picker yet.
  expect(setup.snapshot().models).toEqual([]);
  const [first, second] = await Promise.all([setup.catalog(), setup.catalog()]);
  expect(first.map((model) => model.value)).toEqual(
    MODELS.map((model) => model.value),
  );
  expect(second).toBe(first);
  expect(sessions).toHaveLength(1);
  await setup.catalog();
  expect(sessions).toHaveLength(1);
});

it("looks for the catalog again after a discovery that listed nothing", async () => {
  const { spawn, sessions } = discoverable();
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  spawn.mockRejectedValueOnce(new Error("probe failed"));
  await expect(setup.catalog()).resolves.toEqual([]);
  expect(setup.snapshot().modelsError).toBe("probe failed");
  expect(await setup.catalog()).not.toEqual([]);
  expect(sessions).toHaveLength(1);
});

it("bounds a stalled discovery and releases it for an explicit retry", async () => {
  const checks = scripted({
    "claude --version": { stdout: "2.1.200" },
    "claude auth status --json": { stdout: '{"loggedIn":true}' },
  });
  let exit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    exit = resolve;
  });
  const kill = vi.fn(async () => {
    exit(null);
  });
  const spawn = vi.fn<Spawn>(checks.spawn);
  const setup = new ClaudeSetup(spawn);
  await setup.check();
  spawn.mockResolvedValueOnce({
    write: async () => undefined,
    end: async () => undefined,
    kill,
    exited,
  });
  vi.useFakeTimers();
  try {
    const pending = setup.loadModels();
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(kill).toHaveBeenCalled();
    expect(setup.snapshot().modelsChecking).toBe(false);
    expect(setup.snapshot().modelsError).toBe(
      "Claude Code model discovery timed out",
    );
    spawn.mockRejectedValueOnce(new Error("retry reached the process"));
    await setup.loadModels(true);
    expect(setup.snapshot().modelsError).toBe("retry reached the process");
  } finally {
    setup.dispose();
    vi.useRealTimers();
  }
});

const CHECKSUM = "a".repeat(64);

/** Buzz's copy on a fake disk, and downloads.claude.ai offering `latest`. */
function releases(
  latest: string,
  { current, broken }: { current?: string; broken?: string } = {},
) {
  const state = {
    current,
    offline: false,
    fetched: [] as string[],
    used: [] as string[],
  };
  const claude = fakeSpawn();
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    const args = options.args ?? [];
    if (id === "claude" && args.includes("stream-json"))
      return claude.spawn(id, options);
    const version = options.env?.BUZZ_CLAUDE_VERSION ?? state.current;
    let result: { stdout?: string; stderr?: string; code: number } = {
      code: 0,
    };
    if (id === "platform") result = { stdout: "Darwin arm64\n", code: 0 };
    else if (id === "install") {
      state.fetched.push(args.join(" "));
      if (state.offline) result = { code: 1 };
    } else if (id === "use") state.current = args[0];
    else if (args[0] === "--version")
      result = !version
        ? { code: 127 }
        : version === broken
          ? { stderr: "Killed: 9", code: 137 }
          : { stdout: `${version} (Claude Code)\n`, code: 0 };
    else if (args[0] === "auth")
      result = { stdout: '{"loggedIn":true}', code: 0 };
    if (id === "use") state.used.push(args.join(" "));
    queueMicrotask(() => {
      if (result.stdout) options.onStdout?.(result.stdout);
      if (result.stderr) options.onStderr?.(result.stderr);
    });
    return {
      write: async () => undefined,
      end: async () => undefined,
      kill: async () => undefined,
      exited: new Promise<number | null>((resolve) =>
        setTimeout(() => resolve(result.code), 0),
      ),
    };
  };
  const requests: string[] = [];
  const request = async ({ url }: { url: string }) => {
    requests.push(url);
    const path = url.replace(
      "https://downloads.claude.ai/claude-code-releases/",
      "",
    );
    const body =
      path === "latest"
        ? `${latest}\n`
        : path === `${latest}/manifest.json`
          ? JSON.stringify({
              platforms: { "darwin-arm64": { checksum: CHECKSUM } },
            })
          : undefined;
    return { status: body ? 200 : 404, headers: {}, body: body ?? "" };
  };
  return { spawn, request, requests, state, claude };
}

it("installs the latest release once it passes its test", async () => {
  const { spawn, request, state, claude } = releases("2.1.300");
  const setup = new ClaudeSetup(spawn, request);
  await setup.run("install");
  expect(state.fetched).toEqual([`2.1.300 darwin-arm64 ${CHECKSUM}`]);
  // The test ran the new release, not the copy in use.
  expect(claude.processes[0]?.options.env?.BUZZ_CLAUDE_VERSION).toBe("2.1.300");
  expect(claude.processes[0]?.killed).toBe(true);
  expect(state.used).toEqual(["2.1.300"]);
  expect(setup.snapshot()).toMatchObject({
    running: undefined,
    notice: undefined,
    status: { state: "ready", version: "2.1.300" },
  });
});

it("keeps the copy in use when a new release fails its test", async () => {
  const { spawn, request, state } = releases("2.1.300", {
    current: "2.1.200",
    broken: "2.1.300",
  });
  const setup = new ClaudeSetup(spawn, request);
  await setup.update(false);
  expect(state.fetched).toHaveLength(1);
  expect(state.used).toEqual([]);
  expect(setup.snapshot()).toMatchObject({
    notice:
      "Claude 2.1.300 failed its test: Killed: 9. Buzz keeps using 2.1.200.",
    status: { state: "ready", version: "2.1.200" },
  });
  // A refused release is not downloaded again, unless the person asks.
  await setup.update(false);
  expect(state.fetched).toHaveLength(1);
  await setup.run("install");
  expect(state.fetched).toHaveLength(2);
});

it("does nothing when the copy is already the latest", async () => {
  const { spawn, request, state } = releases("2.1.300", { current: "2.1.300" });
  await new ClaudeSetup(spawn, request).update(true);
  expect(state.fetched).toEqual([]);
});

it("refuses a release older than Buzz needs", async () => {
  const { spawn, request, state } = releases("2.1.100");
  const setup = new ClaudeSetup(spawn, request);
  await setup.run("install");
  expect(state.fetched).toEqual([]);
  expect(setup.snapshot().output).toContain(
    `Claude 2.1.100 is older than Buzz needs (${MIN_VERSION}).`,
  );
});

it("waits for a Claude agent before the first download", async () => {
  const { spawn, request, requests } = releases("2.1.300");
  const setup = new ClaudeSetup(spawn, request);
  await setup.update(false);
  expect(requests).toEqual([]);
  await setup.update(true);
  expect(requests).toHaveLength(2);
});

it("starts Claude and its install steps as steps of claude.sh", async () => {
  const { spawn, calls } = scripted({});
  const run = withScript(spawn);
  await run("claude", { args: ["--version"] });
  await run("use", { args: ["2.1.300"] });
  await run("platform");
  await run("claude", {
    args: ["--protected"],
    protection: { readOnlyPaths: [], hiddenPaths: [] },
  });
  expect(
    manifest.host.processes.find(
      (process) => process.id === "claude-protected-sh",
    ),
  ).toMatchObject({
    program: "buzz-agent-command",
    bundled: true,
    args: ["--shell"],
  });
  expect(calls).toEqual([
    { id: "claude-sh", args: [script, "claude.sh", "run", "--version"] },
    { id: "claude-sh", args: [script, "claude.sh", "use", "2.1.300"] },
    { id: "platform", args: [] },
    {
      id: "claude-protected-sh",
      args: [script, "claude.sh", "run", "--protected"],
    },
  ]);
});

/** `releases` whose first `id` process waits until `release` is called. */
function held(disk: ReturnType<typeof releases>, id: string) {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let first = true;
  const spawn = async (name: string, options?: HostProcessOptions) => {
    if (name === id && first) {
      first = false;
      started();
      await gate;
    }
    return disk.spawn(name, options);
  };
  return { spawn, waiting, release };
}

it("holds a delivery while it downloads the first copy", async () => {
  const disk = releases("2.1.300");
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new ClaudeSetup(spawn, disk.request);
  const update = setup.update(true);
  await waiting;
  let delivered = false;
  const delivery = setup.installed(new AbortController().signal).then(() => {
    delivered = true;
  });
  // Settles only once the held download does, which nothing has released.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(delivered).toBe(false);
  release();
  await Promise.all([update, delivery]);
  expect(disk.state.used).toEqual(["2.1.300"]);
  expect(setup.snapshot().status).toMatchObject({ version: "2.1.300" });
});

it("stops holding a delivery when its deadline passes", async () => {
  const disk = releases("2.1.300");
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new ClaudeSetup(spawn, disk.request);
  const update = setup.update(true);
  await waiting;
  const deadline = new AbortController();
  const delivery = setup.installed(deadline.signal);
  deadline.abort(new Error("timed out"));
  await expect(delivery).rejects.toThrow("timed out");
  release();
  await update;
});

it("does not hold deliveries while it updates a copy in use", async () => {
  const disk = releases("2.1.300", { current: "2.1.200" });
  const { spawn, waiting, release } = held(disk, "install");
  const setup = new ClaudeSetup(spawn, disk.request);
  const update = setup.update(false);
  await waiting;
  await setup.installed(new AbortController().signal);
  release();
  await update;
});

it("holds a delivery that arrives while it first looks for its copy", async () => {
  const disk = releases("2.1.300");
  const { spawn, waiting, release } = held(disk, "claude");
  const setup = new ClaudeSetup(spawn, disk.request);
  const update = setup.update(true);
  await waiting;
  let used: string[] | undefined;
  const delivery = setup.installed(new AbortController().signal).then(() => {
    used = [...disk.state.used];
  });
  release();
  await Promise.all([update, delivery]);
  // Released only once the first copy was in use.
  expect(used).toEqual(["2.1.300"]);
});

it("tries the first download again when a mention finds no copy", async () => {
  const disk = releases("2.1.300");
  const setup = new ClaudeSetup(disk.spawn, disk.request);
  disk.state.offline = true;
  await setup.update(true);
  expect(setup.snapshot().status).toEqual({ state: "missing" });
  disk.state.offline = false;
  await setup.installed(new AbortController().signal);
  expect(disk.state.fetched).toHaveLength(2);
  expect(disk.state.used).toEqual(["2.1.300"]);
});
