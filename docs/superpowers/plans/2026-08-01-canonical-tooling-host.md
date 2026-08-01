# Canonical Combined Tooling Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make extension-owned startup launch the canonical combined Foundry tooling host and rely exclusively on its validated readiness and terminal-error records.

**Architecture:** Keep process ownership and protocol parsing in `src/client/host-launcher.ts`. Replace the legacy caller-selected port and TCP probe with an exact `tooling serve` command and record-only readiness, preserve both reported service ports, and represent structured terminal failures before generic exit or timeout state. Leave connection-manager attach behavior unchanged.

**Tech Stack:** TypeScript 5 strict mode, Node.js child-process streams, VS Code language-client TCP transport, Vitest, ESLint.

---

## File structure

| File | Responsibility |
|---|---|
| `src/client/host-launcher.ts` | Build the tooling command, parse readiness/error records, supervise the child, and classify startup failures. |
| `src/client/host-launcher.test.ts` | Prove command arguments, record validation, stream buffering, failure precedence, timeouts, and exactly-once child cleanup. |
| `src/client/connection-manager.test.ts` | Prove spawned connections use the reported LSP port while attach and auto-attach retain the configured port. |
| `src/extension.test.ts` | Construct the port-free startup failure contract used by extension error handling. |
| `README.md` | Explain canonical spawn behavior and attach/auto port behavior. |
| `AGENTS.md` | Name the canonical combined tooling-host command. |
| `.cursor/skills/foundryscript-expert/SKILL.md` | Keep repository-specific agent guidance current. |
| `.cursor/skills/foundryscript-expert/references/foundryscript-language.md` | Keep the engine-integration command reference current. |

### Task 1: Replace the legacy command API

**Files:**

- Modify: `src/client/host-launcher.test.ts`
- Modify: `src/client/host-launcher.ts`

- [ ] **Step 1: Write the failing canonical command test**

Replace the legacy command import and test with:

```ts
import {
  buildToolingHostCommand,
  FoundryHostLauncher,
  HostStartupFailure,
  parseToolingReadinessLine,
} from "./host-launcher.js";

it("builds the canonical combined tooling-host invocation", () => {
  expect(
    buildToolingHostCommand({
      enginePath: "/opt/foundry",
      project: "/workspace/game",
    }),
  ).toEqual({
    command: "/opt/foundry",
    args: [
      "tooling",
      "serve",
      "--project",
      "/workspace/game",
      "--lsp-port",
      "0",
      "--dap-port",
      "0",
    ],
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test:unit -- src/client/host-launcher.test.ts`

Expected: FAIL because `buildToolingHostCommand` is not exported.

- [ ] **Step 3: Add the canonical command builder**

Add this implementation beside `HostCommand`:

```ts
export function buildToolingHostCommand({
  enginePath,
  project,
}: HostLaunchRequest): HostCommand {
  return {
    command: enginePath,
    args: [
      "tooling",
      "serve",
      "--project",
      project,
      "--lsp-port",
      "0",
      "--dap-port",
      "0",
    ],
  };
}
```

Leave the legacy builder temporarily in place until Task 2 switches the launcher.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run test:unit -- src/client/host-launcher.test.ts`

Expected: PASS, including the new exact argument-vector assertion.

- [ ] **Step 5: Commit the command contract**

```bash
git add src/client/host-launcher.ts src/client/host-launcher.test.ts
git commit -m "feat: build canonical Foundry tooling command"
```

### Task 2: Require the combined readiness record

**Files:**

- Modify: `src/client/host-launcher.test.ts`
- Modify: `src/client/host-launcher.ts`
- Modify: `src/extension.test.ts`

- [ ] **Step 1: Write failing readiness validation tests**

Pass the expected project to `parseToolingReadinessLine` and add this invalid-record
matrix:

```ts
const validReadiness = {
  project: "/workspace/game",
  pid: 99,
  local_only: true,
  services: ["lsp", "dap"],
  lsp_port: 49152,
  dap_port: 49153,
};

it.each([
  ["wrong marker", "OTHER " + JSON.stringify(validReadiness)],
  ["malformed JSON", "FOUNDRY_TOOLING {"],
  ["wrong project", `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, project: "/workspace/other" })}`],
  ["zero PID", `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, pid: 0 })}`],
  ["remote contract", `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, local_only: false })}`],
  ["missing DAP service", `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, services: ["lsp"] })}`],
  ["missing DAP port", `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, dap_port: undefined })}`],
  ["invalid LSP port", `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, lsp_port: 0 })}`],
  ["invalid DAP port", `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, dap_port: 65536 })}`],
  ["identical ports", `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, dap_port: 49152 })}`],
])("rejects %s readiness", (_name, line) => {
  expect(parseToolingReadinessLine(line, "/workspace/game")).toBeUndefined();
});
```

Update the valid assertion to call
`parseToolingReadinessLine(line, "/workspace/game")` and expect both ports.

- [ ] **Step 2: Write failing record-only launcher tests**

Replace the TCP-readiness and future-record tests with tests that:

```ts
it.each(["complete", "split"] as const)(
  "starts only after a %s combined readiness record",
  async (delivery) => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        const line = `FOUNDRY_TOOLING ${JSON.stringify(validReadiness)}\n`;
        if (delivery === "split") {
          child.stdout.write(line.slice(0, 17));
          child.stdout.write(line.slice(17));
        } else {
          child.stdout.write(line);
        }
      });
      return child.asChildProcess();
    });
    const launcher = new FoundryHostLauncher({
      spawnProcess,
      inactivityTimeoutMs: 100,
      absoluteTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    const host = await launcher.launch({
      enginePath: "/opt/foundry",
      project: "/workspace/game",
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/foundry",
      ["tooling", "serve", "--project", "/workspace/game", "--lsp-port", "0", "--dap-port", "0"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(host.readiness).toEqual({
      project: "/workspace/game",
      pid: 99,
      localOnly: true,
      services: ["lsp", "dap"],
      lspPort: 49152,
      dapPort: 49153,
    });
    await host.stop();
  },
);
```

Add a test that opens a loopback server, launches a silent fake child, and asserts an
inactivity timeout. This proves an open TCP listener cannot substitute for the record.
Remove the allocator test and every `allocatePort` option from launcher setup.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm run test:unit -- src/client/host-launcher.test.ts`

Expected: FAIL because readiness does not require the expected project, positive PID,
DAP service/port, or distinct ports, and the launcher still allocates and probes a port.

- [ ] **Step 4: Implement strict readiness parsing**

Change the parser signature and validation to:

```ts
export function parseToolingReadinessLine(
  line: string,
  expectedProject: string,
): ToolingHostReadiness | undefined {
  const prefix = "FOUNDRY_TOOLING ";
  if (!line.startsWith(prefix)) return undefined;

  let record: ToolingReadinessRecord;
  try {
    record = JSON.parse(line.slice(prefix.length)) as ToolingReadinessRecord;
  } catch {
    return undefined;
  }

  if (
    record.project !== expectedProject ||
    !Number.isInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    record.local_only !== true ||
    !Array.isArray(record.services) ||
    !record.services.every((service) => typeof service === "string") ||
    !record.services.includes("lsp") ||
    !record.services.includes("dap") ||
    !isPort(record.lsp_port) ||
    !isPort(record.dap_port) ||
    record.lsp_port === record.dap_port
  ) {
    return undefined;
  }

  return {
    project: record.project,
    pid: Number(record.pid),
    localOnly: true,
    services: record.services,
    lspPort: record.lsp_port,
    dapPort: record.dap_port,
  };
}
```

- [ ] **Step 5: Remove guessed-port startup and TCP fallback**

Remove the `node:net` import, `LegacyLspCommandRequest`, `buildLegacyLspCommand`,
`allocateLoopbackPort`, and `canConnect`. Make `HostStartupFailureDetails` extend
`HostLaunchRequest`, remove `port` from `HostStartupFailure`, and make
`FoundryHostLauncherOptions.buildCommand` accept `HostLaunchRequest`.

In `launch`, build directly from `request`, log the command without a guessed port, and
pass `request.project` to the output observer so it calls:

```ts
state.readiness ??= parseToolingReadinessLine(line, expectedProject);
```

Make `waitForReadiness` accept `HostLaunchRequest`, remove the TCP probe block, and keep
the inactivity/absolute delay bounded by the remaining limits. Update timeout/output
logs to omit a guessed `port` field. Update the extension test's `HostStartupFailure`
construction to omit `port`.

- [ ] **Step 6: Run focused tests and typecheck, then verify GREEN**

Run:

```bash
npm run test:unit -- src/client/host-launcher.test.ts src/extension.test.ts
npm run typecheck
```

Expected: both test files pass and TypeScript reports no errors.

- [ ] **Step 7: Commit record-only startup**

```bash
git add src/client/host-launcher.ts src/client/host-launcher.test.ts src/extension.test.ts
git commit -m "feat: require combined tooling readiness"
```

### Task 3: Preserve structured terminal startup failures

**Files:**

- Modify: `src/client/host-launcher.test.ts`
- Modify: `src/client/host-launcher.ts`

- [ ] **Step 1: Write failing structured-error tests**

Add table-driven tests for stdout and stderr. Each fake child writes one of these
records, then exits:

```ts
const toolingErrors = [
  {
    error: "bind_failed",
    service: "dap",
    requested_port: 6006,
    message: "port busy",
    expectedKind: "port_conflict",
  },
  {
    error: "invalid_project",
    reason: "missing_project_file",
    project: "/workspace/game",
    message: "Project directory does not contain project.foundry: /workspace/game",
    expectedKind: "invalid_project",
  },
  {
    error: "service_unavailable",
    service: "lsp",
    message: "language service unavailable",
    expectedKind: "spawn_failed",
  },
] as const;
```

For every stream and record, assert `failure.kind === expectedKind`, the failure message
contains the engine message, and a subsequent exit does not change the classification to
`process_exit`. Assert the child receives exactly one `SIGTERM` cleanup call.

Add focused cases proving cancellation, timeout, malformed readiness followed by timeout,
terminal error, and early exit each call `kill` once and log an unterminated output tail
once. Keep the synchronous spawn rejection assertion at zero child cleanup calls.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm run test:unit -- src/client/host-launcher.test.ts`

Expected: FAIL because stdout tooling errors are ignored, invalid-project and unknown
records are not represented, and exit currently wins over a structured terminal record.

- [ ] **Step 3: Add structured tooling-error state**

Add:

```ts
interface ToolingErrorRecord {
  error: string;
  message?: string;
}

function parseToolingErrorLine(line: string): ToolingErrorRecord | undefined {
  const prefix = "FOUNDRY_TOOLING_ERROR ";
  if (!line.startsWith(prefix)) return undefined;
  try {
    const record = JSON.parse(line.slice(prefix.length)) as {
      error?: unknown;
      message?: unknown;
    };
    if (
      typeof record.error !== "string" ||
      record.error === "" ||
      (record.message !== undefined && typeof record.message !== "string")
    ) {
      return undefined;
    }
    return {
      error: record.error,
      ...(record.message === undefined ? {} : { message: record.message }),
    };
  } catch {
    return undefined;
  }
}
```

Store the first parsed record as `StartupState.toolingError` for lines from either
stream. Continue collecting human-readable stderr only as a compatibility fallback.

- [ ] **Step 4: Map structured errors before generic state**

Add `"invalid_project"` to `HostStartupFailureKind` and `toolingMessage?: string` to
`HostStartupFailureDetails`. Render the engine message in `startupFailureMessage` when
present; otherwise use project-specific defaults for bind, invalid-project, and generic
spawn failure.

At the start of each readiness loop, after cancellation and readiness but before spawn
error, exit, or timeout checks, throw:

```ts
if (state.toolingError !== undefined) {
  const kind: HostStartupFailureKind =
    state.toolingError.error === "bind_failed"
      ? "port_conflict"
      : state.toolingError.error === "invalid_project"
        ? "invalid_project"
        : "spawn_failed";
  throw new HostStartupFailure({
    ...request,
    kind,
    toolingMessage: state.toolingError.message,
  });
}
```

Keep human-readable bind classification only for legacy stderr that has no structured
record. Preserve the single existing `try/catch` cleanup path so each unsuccessful owned
startup stops and flushes once.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `npm run test:unit -- src/client/host-launcher.test.ts`

Expected: all host-launcher tests pass, including both-stream records, specific failure
messages, failure precedence, and cleanup counts.

- [ ] **Step 6: Commit structured failure handling**

```bash
git add src/client/host-launcher.ts src/client/host-launcher.test.ts
git commit -m "fix: preserve tooling startup failures"
```

### Task 4: Lock connection behavior and update active guidance

**Files:**

- Modify: `src/client/connection-manager.test.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.cursor/skills/foundryscript-expert/SKILL.md`
- Modify: `.cursor/skills/foundryscript-expert/references/foundryscript-language.md`

- [ ] **Step 1: Strengthen connection-mode assertions**

Make `createHost` return combined readiness by default:

```ts
readiness: {
  project: "/workspace/game",
  pid: 1234,
  localOnly: true,
  services: ["lsp", "dap"],
  lspPort,
  dapPort: lspPort + 1,
},
```

In the spawn test, keep configured port `7001`, return reported LSP port `49152`, and
assert the only endpoint is `127.0.0.1:49152`. In auto fallback, keep configured attach
port `6005`, return reported LSP port `49153`, and assert endpoints are exactly `6005`
then `49153`. These observable assertions prove the manager does not substitute the
configured port after a spawn.

- [ ] **Step 2: Run connection tests and verify GREEN**

Run: `npm run test:unit -- src/client/connection-manager.test.ts`

Expected: all connection-manager tests pass without production changes.

- [ ] **Step 3: Update active documentation and guidance**

Change active references from `foundry lsp serve` to the canonical command. README must
state that spawn mode runs:

```sh
foundry tooling serve --project <dir> --lsp-port 0 --dap-port 0
```

Explain that Foundry binds two ephemeral loopback ports, the extension learns them from
`FOUNDRY_TOOLING`, and only the reported LSP port is used today. Explain that attach and
auto's initial attach continue using `foundryScript.lsp.port`. Update the command rows in
`AGENTS.md`, the expert skill, and its language reference to `foundry tooling serve`.

- [ ] **Step 4: Check active references**

Run:

```bash
rg -n "foundry lsp serve|buildLegacyLspCommand|LegacyLspCommandRequest|allocateLoopbackPort" README.md AGENTS.md .cursor src --glob '!docs/superpowers/**'
```

Expected: no matches.

- [ ] **Step 5: Commit connection coverage and docs**

```bash
git add src/client/connection-manager.test.ts README.md AGENTS.md .cursor/skills/foundryscript-expert/SKILL.md .cursor/skills/foundryscript-expert/references/foundryscript-language.md
git commit -m "docs: describe combined tooling host startup"
```

### Task 5: Run repository verification

**Files:**

- Verify all modified files

- [ ] **Step 1: Install the locked dependency set**

Run: `npm ci`

Expected: exit 0 with dependencies installed from `package-lock.json`.

- [ ] **Step 2: Build the extension**

Run: `npm run build`

Expected: exit 0 and `dist/extension.js` is produced.

- [ ] **Step 3: Typecheck strict TypeScript**

Run: `npm run typecheck`

Expected: exit 0 with no diagnostics.

- [ ] **Step 4: Run ESLint**

Run: `npm run lint`

Expected: exit 0 with no lint errors.

- [ ] **Step 5: Run unit and grammar tests**

Run: `npm test`

Expected: exit 0 with every Vitest and TextMate grammar test passing.

- [ ] **Step 6: Inspect the final branch**

Run:

```bash
git status --short --branch
git diff --check main...HEAD
git log --oneline --decorate main..HEAD
```

Expected: clean feature branch, no whitespace errors, and only issue #41 design,
implementation, test, and documentation commits.
