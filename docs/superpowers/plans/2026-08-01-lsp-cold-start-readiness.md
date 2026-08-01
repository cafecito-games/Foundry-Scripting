# LSP Cold-Start Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an extension-owned Foundry language server continue initializing while it emits startup activity, cap total startup at two minutes, and expose startup progress and timeout reasons in the LSP log.

**Architecture:** Keep readiness and process ownership in `FoundryHostLauncher`. Replace its fixed deadline with inactivity and absolute deadlines driven by child-stream activity, and extend the existing observer to parse protocol lines, classify bind failures, and emit structured log records without changing connection-manager behavior.

**Tech Stack:** TypeScript 5 in strict mode, Node.js child-process and stream APIs, VS Code output channels, Vitest.

---

## File structure

| File | Responsibility |
|---|---|
| `src/client/host-launcher.ts` | Spawn Foundry, observe output, enforce readiness limits, classify failures, and own shutdown. |
| `src/client/host-launcher.test.ts` | Prove timing, output, readiness, failure precedence, and cleanup behavior. |
| `README.md` | Explain cold-start limits and where startup progress is visible. |

### Task 1: Replace the fixed deadline with inactivity and absolute limits

**Files:**

- Modify: `src/client/host-launcher.test.ts`
- Modify: `src/client/host-launcher.ts`

- [ ] **Step 1: Update existing test options and write failing timing tests**

In existing launcher test setups, replace `timeoutMs: 100` with
`inactivityTimeoutMs: 100, absoluteTimeoutMs: 200`; replace `timeoutMs: 20` with
`inactivityTimeoutMs: 20, absoluteTimeoutMs: 100`; and replace `timeoutMs: 50` with
`inactivityTimeoutMs: 50, absoluteTimeoutMs: 100`.

Add these focused cases before the abort test:

```ts
it("reports inactivity when a silent host does not become ready", async () => {
  const child = new FakeChildProcess();
  const launcher = new FoundryHostLauncher({
    allocatePort: () => Promise.resolve(49153),
    spawnProcess: () => child.asChildProcess(),
    inactivityTimeoutMs: 20,
    absoluteTimeoutMs: 100,
    pollIntervalMs: 5,
  });

  const failure = await launcher
    .launch({ enginePath: "foundry", project: "/workspace/game" })
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({
    kind: "readiness_timeout",
    timeoutReason: "inactivity",
    timeoutMs: 20,
  });
  expect((failure as Error).message).toContain(
    "produced no startup output for 20 milliseconds",
  );
});

it.each(["stdout", "stderr"] as const)(
  "extends the inactivity window when %s output arrives",
  async (stream) => {
    const readyChild = new FakeChildProcess();
    const readyLauncher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49154),
      spawnProcess: () => {
        setTimeout(() => readyChild[stream].write("still importing"), 10);
        if (stream === "stdout") {
          setTimeout(() => readyChild.stdout.write("\n"), 15);
        }
        setTimeout(() => {
          readyChild.stdout.write(
            'FOUNDRY_TOOLING {"project":"/workspace/game","pid":4321,"local_only":true,"services":["lsp"],"lsp_port":50100}\n',
          );
        }, 25);
        return readyChild.asChildProcess();
      },
      inactivityTimeoutMs: 20,
      absoluteTimeoutMs: 100,
      pollIntervalMs: 5,
    });
    const host = await readyLauncher.launch({
      enginePath: "foundry",
      project: "/workspace/game",
    });
    expect(host.readiness.lspPort).toBe(50100);
    await host.stop();
  },
);

it("enforces the absolute limit while output continues", async () => {
  const noisyChild = new FakeChildProcess();
  const noisyLauncher = new FoundryHostLauncher({
    allocatePort: () => Promise.resolve(49155),
    spawnProcess: () => {
      const activity = setInterval(() => noisyChild.stdout.write("working\n"), 5);
      noisyChild.once("exit", () => clearInterval(activity));
      return noisyChild.asChildProcess();
    },
    inactivityTimeoutMs: 20,
    absoluteTimeoutMs: 40,
    pollIntervalMs: 5,
  });
  const failure = await noisyLauncher
    .launch({ enginePath: "foundry", project: "/workspace/game" })
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({
    kind: "readiness_timeout",
    timeoutReason: "absolute",
    timeoutMs: 40,
  });
});
```

- [ ] **Step 2: Run the type contract check and verify RED**

Run `npm run typecheck`.

Expected: compilation fails on the new launcher options and timeout-reason assertions
because that contract does not exist. This is the RED result; do not proceed until the
errors point only to the missing timing feature.

- [ ] **Step 3: Add the timeout contract and defaults**

In `src/client/host-launcher.ts`, add:

```ts
export type HostStartupTimeoutReason = "inactivity" | "absolute";

export interface HostStartupFailureDetails extends LegacyLspCommandRequest {
  kind: HostStartupFailureKind;
  exitCode?: number | null;
  timeoutReason?: HostStartupTimeoutReason;
  timeoutMs?: number;
  cause?: unknown;
}
```

Add these properties to `HostStartupFailure` and assign them in its constructor:

```ts
readonly timeoutReason: HostStartupTimeoutReason | undefined;
readonly timeoutMs: number | undefined;
```

```ts
this.timeoutReason = details.timeoutReason;
this.timeoutMs = details.timeoutMs;
```

Render `readiness_timeout` as:

```ts
case "readiness_timeout":
  if (details.timeoutReason === "inactivity" && details.timeoutMs !== undefined) {
    return `Foundry produced no startup output for ${details.timeoutMs} milliseconds while starting the language server for ${target}.`;
  }
  if (details.timeoutReason === "absolute" && details.timeoutMs !== undefined) {
    return `Foundry did not become ready within ${details.timeoutMs} milliseconds while starting the language server for ${target}.`;
  }
  return `Timed out waiting for the Foundry language server for ${target}.`;
```

Replace `timeoutMs?: number` in `FoundryHostLauncherOptions` with:

```ts
inactivityTimeoutMs?: number;
absoluteTimeoutMs?: number;
```

Add `lastActivityAt: number` to `StartupState`. Replace the class's `timeoutMs` field
with `inactivityTimeoutMs` and `absoluteTimeoutMs`, defaulting them in the constructor:

```ts
this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 15_000;
this.absoluteTimeoutMs = options.absoluteTimeoutMs ?? 120_000;
```

- [ ] **Step 4: Record activity and enforce both limits**

Replace the existing `observeOutput` with this timing-aware interim version:

```ts
function observeOutput(
  child: ChildProcess,
  state: StartupState,
  now: () => number,
): void {
  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    if (text.length === 0) return;
    state.lastActivityAt = now();
    stdoutBuffer += text;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      state.readiness ??= parseToolingReadinessLine(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    if (text.length === 0) return;
    state.lastActivityAt = now();
    state.stderr += text;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("FOUNDRY_TOOLING_ERROR ")) continue;
      try {
        const record = JSON.parse(
          line.slice("FOUNDRY_TOOLING_ERROR ".length),
        ) as { error?: unknown };
        state.structuredBindFailure ||= record.error === "bind_failed";
      } catch {
        // Human-readable stderr is classified below.
      }
    }
  });
}
```

Immediately after spawn, set `const startedAt = Date.now()`, initialize
`lastActivityAt: startedAt`, and call `observeOutput(child, state, Date.now)`.

Pass `startedAt` into `waitForReadiness`. Replace the fixed-deadline condition and final
throw with this timeout block inside `while (true)`, after readiness/error/exit checks
and before the TCP probe:

```ts
const now = Date.now();
const absoluteElapsedMs = now - startedAt;
const inactiveElapsedMs = now - state.lastActivityAt;
const timeoutReason: HostStartupTimeoutReason | undefined =
  absoluteElapsedMs >= this.absoluteTimeoutMs
    ? "absolute"
    : inactiveElapsedMs >= this.inactivityTimeoutMs
      ? "inactivity"
      : undefined;
if (timeoutReason !== undefined) {
  const timeoutMs =
    timeoutReason === "absolute"
      ? this.absoluteTimeoutMs
      : this.inactivityTimeoutMs;
  throw new HostStartupFailure({
    ...request,
    kind: isBindFailure(state) ? "port_conflict" : "readiness_timeout",
    timeoutReason,
    timeoutMs,
  });
}
```

After the TCP probe, bound the polling delay by both remaining limits:

```ts
await delay(
  Math.max(
    1,
    Math.min(
      this.pollIntervalMs,
      this.absoluteTimeoutMs - absoluteElapsedMs,
      this.inactivityTimeoutMs - inactiveElapsedMs,
    ),
  ),
);
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run `npm run test:unit -- src/client/host-launcher.test.ts`.

Expected: all host-launcher tests pass, including output-extended inactivity and the
absolute cap.

- [ ] **Step 6: Commit the timing change**

```bash
git add src/client/host-launcher.ts src/client/host-launcher.test.ts
git commit -m "fix: tolerate active Foundry LSP cold starts"
```

### Task 2: Log startup output and timeout reasons

**Files:**

- Modify: `src/client/host-launcher.test.ts`
- Modify: `src/client/host-launcher.ts`

- [ ] **Step 1: Write failing output-log tests**

Add this test:

```ts
it("logs complete startup lines and flushes unterminated tails once", async () => {
  const child = new FakeChildProcess();
  const output = { appendLine: vi.fn() };
  const launcher = new FoundryHostLauncher({
    allocatePort: () => Promise.resolve(49156),
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stdout.write("scan started\nscan complete\n");
        child.stderr.write("warning tail");
        child.stdout.write(
          'FOUNDRY_TOOLING {"project":"/workspace/game","pid":4321,"local_only":true,"services":["lsp"],"lsp_port":50100}\n',
        );
      });
      return child.asChildProcess();
    },
    output,
    inactivityTimeoutMs: 50,
    absoluteTimeoutMs: 100,
    pollIntervalMs: 5,
  });

  const host = await launcher.launch({
    enginePath: "foundry",
    project: "/workspace/game",
  });
  await host.stop();

  const records = output.appendLine.mock.calls.map(
    ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
  );
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "lsp.host.output",
        stream: "stdout",
        message: "scan started",
      }),
      expect.objectContaining({
        event: "lsp.host.output",
        stream: "stdout",
        message: "scan complete",
      }),
      expect.objectContaining({
        event: "lsp.host.output",
        stream: "stderr",
        message: "warning tail",
      }),
    ]),
  );
  expect(
    records.filter((record) => record.message === "warning tail"),
  ).toHaveLength(1);
});

it("flushes an unterminated tail when startup exits", async () => {
  const child = new FakeChildProcess();
  const output = { appendLine: vi.fn() };
  const launcher = new FoundryHostLauncher({
    allocatePort: () => Promise.resolve(49157),
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write("fatal tail");
        child.exitCode = 23;
        child.emit("exit", 23, null);
      });
      return child.asChildProcess();
    },
    output,
    inactivityTimeoutMs: 50,
    absoluteTimeoutMs: 100,
    pollIntervalMs: 5,
  });

  await expect(
    launcher.launch({ enginePath: "foundry", project: "/workspace/game" }),
  ).rejects.toMatchObject({ kind: "process_exit", exitCode: 23 });

  const records = output.appendLine.mock.calls.map(
    ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
  );
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "lsp.host.output",
        stream: "stderr",
        message: "fatal tail",
      }),
    ]),
  );
});
```

In the silent-host test, create `const output = { appendLine: vi.fn() }`, pass `output`
to the launcher, and append this exact assertion after the failure-message assertion:

```ts
const records = output.appendLine.mock.calls.map(
  ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
);
expect(records).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      level: "error",
      event: "lsp.host.timeout",
      project: "/workspace/game",
      port: 49153,
      reason: "inactivity",
      timeoutMs: 20,
    }),
  ]),
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `npm run test:unit -- src/client/host-launcher.test.ts`.

Expected: assertions fail because neither output nor timeout records exist and buffered
tails are not flushed.

- [ ] **Step 3: Make the observer line-aware and flushable**

Add these types:

```ts
type HostOutputStream = "stdout" | "stderr";
interface StartupOutputObserver { flush(): void; }
```

Replace `observeOutput` with:

```ts
function observeOutput(
  child: ChildProcess,
  state: StartupState,
  now: () => number,
  onLine: (stream: HostOutputStream, line: string) => void,
): StartupOutputObserver {
  const buffers: Record<HostOutputStream, string> = {
    stdout: "",
    stderr: "",
  };

  const acceptLine = (stream: HostOutputStream, line: string): void => {
    if (stream === "stdout") {
      state.readiness ??= parseToolingReadinessLine(line);
    } else if (line.startsWith("FOUNDRY_TOOLING_ERROR ")) {
      try {
        const record = JSON.parse(
          line.slice("FOUNDRY_TOOLING_ERROR ".length),
        ) as { error?: unknown };
        state.structuredBindFailure ||= record.error === "bind_failed";
      } catch {
        // Human-readable stderr is classified below.
      }
    }
    if (line !== "") onLine(stream, line);
  };

  const acceptChunk = (
    stream: HostOutputStream,
    chunk: Buffer | string,
  ): void => {
    const text = chunk.toString();
    if (text.length === 0) return;
    state.lastActivityAt = now();
    if (stream === "stderr") state.stderr += text;
    buffers[stream] += text;
    const lines = buffers[stream].split(/\r?\n/);
    buffers[stream] = lines.pop() ?? "";
    for (const line of lines) acceptLine(stream, line);
  };

  child.stdout?.on("data", (chunk: Buffer | string) =>
    acceptChunk("stdout", chunk),
  );
  child.stderr?.on("data", (chunk: Buffer | string) =>
    acceptChunk("stderr", chunk),
  );

  return {
    flush: () => {
      for (const stream of ["stdout", "stderr"] as const) {
        const tail = buffers[stream];
        buffers[stream] = "";
        if (tail !== "") acceptLine(stream, tail);
      }
    },
  };
}
```

Create the observer in `launch` with:

```ts
const outputObserver = observeOutput(child, state, Date.now, (stream, message) => {
  this.log("info", "lsp.host.output", {
    project: request.project,
    port,
    stream,
    message,
  });
});
```

Use the observer in both ownership paths:

```ts
stop: async () => {
  if (stopped) return;
  stopped = true;
  await stopChild(child);
  outputObserver.flush();
},
```

```ts
} catch (error) {
  await stopChild(child);
  outputObserver.flush();
  throw error;
}
```

- [ ] **Step 4: Log timeout context before throwing**

Inside the timeout branch, before constructing `HostStartupFailure`, add:

```ts
this.log("error", "lsp.host.timeout", {
  project: request.project,
  port: request.port,
  reason: timeoutReason,
  timeoutMs,
});
```

Keep bind-failure precedence unchanged.

- [ ] **Step 5: Verify output behavior and static correctness**

Run:

```bash
npm run test:unit -- src/client/host-launcher.test.ts
npm run typecheck
npm run lint
```

Expected: all commands exit 0 and every complete line or buffered tail is logged once.

- [ ] **Step 6: Commit output diagnostics**

```bash
git add src/client/host-launcher.ts src/client/host-launcher.test.ts
git commit -m "feat: log Foundry LSP startup progress"
```

### Task 3: Document and fully verify cold starts

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Document the readiness policy**

After the connection-mode paragraph in `README.md`, add:

```md
Cold project initialization may include file scanning, script-class registration, and
editor setup before the language-server port opens. While Foundry emits startup output,
the extension allows that work to continue for up to two minutes. A silent startup is
treated as stalled after 15 seconds. Startup output and the specific timeout reason are
available from the `FoundryScript LSP` output channel.
```

- [ ] **Step 2: Run the complete required verification**

Run each command separately:

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Expected: every command exits 0; unit and grammar tests report no failures.

- [ ] **Step 3: Inspect and commit the documentation**

Run `git diff --check` and `git status --short`. Confirm only `README.md` remains
uncommitted, then commit it:

```bash
git add README.md
git commit -m "docs: explain Foundry LSP cold startup"
```

- [ ] **Step 4: Confirm the final repository state**

Run:

```bash
git status --short
git log -4 --oneline
```

Expected: the worktree is clean and the log contains the design, timing, output, and
documentation commits.
