# Foundry Test Adapter Negotiation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure, launch, validate, and negotiate a framework-neutral Foundry test adapter while keeping human-facing tasks, LSP, and future Test Explorer presentation independent.

**Architecture:** A new `src/testing/` unit separates pure command construction and capabilities validation from subprocess ownership, temporary-artifact orchestration, generation-safe runtime coordination, and status presentation. The VS Code entry point only reads settings, adapts events/UI, and owns deactivation.

**Tech Stack:** TypeScript 5.6, Node.js child processes/filesystem, VS Code Extension API, Vitest, esbuild, VSIX packaging.

---

### Task 1: Settings and exact capabilities command

**Files:**
- Create: `src/testing/command.ts`
- Create: `src/testing/command.test.ts`
- Modify: `package.json`
- Modify: `src/extension.test.ts`

- [ ] **Step 1: Write failing manifest and command tests**

Add manifest assertions for `foundryScript.testing.enabled` defaulting to `false`, `foundryScript.testing.runner` defaulting to `""`, and `foundryScript.testing.args` as a string array defaulting to `[]`. Add command tests using this public request shape:

```ts
createTestAdapterCapabilitiesCommand({
  enginePath: "/opt/foundry",
  project: "/workspace/game",
  runner: "res://tests/runner.fs",
  frameworkArgs: ["--path", "res://specs", "--output", "opaque"],
  outputPath: "/tmp/capabilities.json",
});
```

Assert `command === "/opt/foundry"`, `cwd === "/workspace/game"`, and exact arguments:

```ts
[
  "--headless", "--no-header", "project", "test",
  "--project", "/workspace/game",
  "--runner", "res://tests/runner.fs", "--",
  "adapter", "capabilities", "--output", "/tmp/capabilities.json",
  "--", "--path", "res://specs", "--output", "opaque",
]
```

Also assert the second separator is omitted for no framework args, opaque empty/option-looking values are retained, and failures have stable kinds/settings for blank engine, missing project, blank runner, and each noncanonical runner: native path, bare relative path, `res://`, backslash, dot segment, empty segment, and trailing slash.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run src/testing/command.test.ts src/extension.test.ts`

Expected: FAIL because the testing settings and command module do not exist.

- [ ] **Step 3: Implement settings and pure command construction**

Define:

```ts
export type TestAdapterConfigurationErrorKind =
  | "missing_engine"
  | "missing_project"
  | "missing_runner"
  | "invalid_runner";

export interface TestAdapterCapabilitiesCommandRequest {
  readonly enginePath: string;
  readonly project: string | undefined;
  readonly runner: string;
  readonly frameworkArgs: readonly string[];
  readonly outputPath: string;
}

export interface TestAdapterCommand {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
}
```

Validate a canonical non-root `res://` resource by rejecting backslashes, empty/dot segments, and trailing separators. Construct arguments without shell quoting and append `...["--", ...frameworkArgs]` only when the array is non-empty. Add the three manifest settings without changing `foundryScript.test.runner`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run src/testing/command.test.ts src/extension.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json src/extension.test.ts src/testing/command.ts src/testing/command.test.ts
git commit -m "feat: configure test adapter commands"
```

### Task 2: Strict capabilities validation and negotiation

**Files:**
- Create: `src/testing/capabilities.ts`
- Create: `src/testing/capabilities.test.ts`
- Create: `src/testing/fixtures/capabilities-minimal.json`
- Create: `src/testing/fixtures/capabilities-additive.json`
- Create: `src/testing/fixtures/capabilities-multi-version.json`

- [ ] **Step 1: Add synthetic fixture and parser tests**

Capture framework-neutral fixtures with LF endings. Minimal advertises version 1 and framework `{id:"neutral-spec",name:"Neutral Spec",version:"2.4.0"}`. Additive includes unknown top-level/framework properties and unknown extension names. Multi-version advertises `[1,2,4]`.

Tests call:

```ts
parseAndNegotiateCapabilities(bytes, [1, 2, 3]);
```

and assert:

```ts
{
  protocolVersion: 2,
  framework: { id: "neutral-spec", name: "Neutral Spec", version: "2.4.0" },
  extensions: ["neutral.coverage"],
}
```

Add one focused case for every validation rule: UTF-8 BOM, invalid UTF-8, missing LF, CRLF, malformed/extra JSON values, non-object root, wrong protocol, absent/wrong-type required fields, empty/duplicate/noninteger/nonpositive/unsorted versions, invalid framework strings, and invalid/duplicate extensions. Assert unknown additive fields succeed. Assert a valid document with no shared version throws `incompatible_adapter`, while structural/semantic violations throw `malformed_capabilities` with a concrete field-oriented message.

- [ ] **Step 2: Run parser tests and verify RED**

Run: `npx vitest run src/testing/capabilities.test.ts`

Expected: FAIL because the parser module is missing.

- [ ] **Step 3: Implement complete validation**

Define:

```ts
export interface TestFrameworkMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export interface NegotiatedTestAdapter {
  readonly protocolVersion: number;
  readonly framework: TestFrameworkMetadata;
  readonly extensions: readonly string[];
}
```

Decode with `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })` after explicitly rejecting the UTF-8 BOM bytes. Require terminal LF and reject CR. Parse exactly one JSON value with `JSON.parse`. Use small type guards for plain JSON objects, positive integers, and non-empty control-free strings. Validate every required field and semantic constraint before computing the descending client/adapter intersection.

- [ ] **Step 4: Run parser tests and verify GREEN**

Run: `npx vitest run src/testing/capabilities.test.ts`

Expected: all parser and fixture tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/testing/capabilities.ts src/testing/capabilities.test.ts src/testing/fixtures
git commit -m "feat: validate test adapter capabilities"
```

### Task 3: Owned adapter subprocess and bounded cancellation

**Files:**
- Create: `src/testing/process.ts`
- Create: `src/testing/process.test.ts`

- [ ] **Step 1: Write process lifecycle tests**

Drive `FoundryTestAdapterProcess` with a fake `ChildProcess` exposing stdout/stderr emitters, `kill`, `exitCode`, and close/error events. Assert the process launches with:

```ts
{ cwd: command.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] }
```

Assert byte-exact stdout/stderr callbacks stay separate, a close returns the actual code, synchronous and emitted `ENOENT` become `missing_engine`, other spawn errors become `spawn_failed`, completion happens once, abort before start returns `cancelled`, and abort after start sends `SIGTERM` then `SIGKILL` after the injected grace deadline if still alive. Assert shutdown resolves within an injected hard deadline even if close never arrives.

- [ ] **Step 2: Run process tests and verify RED**

Run: `npx vitest run src/testing/process.test.ts`

Expected: FAIL because the process module is missing.

- [ ] **Step 3: Implement process ownership**

Expose:

```ts
export interface TestAdapterProcessResult {
  readonly kind: "exited" | "cancelled";
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class FoundryTestAdapterProcess {
  run(command: TestAdapterCommand, signal: AbortSignal): Promise<TestAdapterProcessResult>;
}
```

Use `spawn`, never a shell. Append stdout/stderr only to their own buffers and optional output callback. Register abort once; terminate with `SIGTERM`, grace-timer `SIGKILL`, and a hard shutdown timer that resolves cancellation without waiting forever. Clear all timers/listeners on the first terminal event.

- [ ] **Step 4: Run process tests and verify GREEN**

Run: `npx vitest run src/testing/process.test.ts`

Expected: all process tests pass without leaked timer warnings.

- [ ] **Step 5: Commit**

```bash
git add src/testing/process.ts src/testing/process.test.ts
git commit -m "feat: own test adapter processes"
```

### Task 4: Unique temporary artifacts and actionable negotiation outcomes

**Files:**
- Create: `src/testing/adapter.ts`
- Create: `src/testing/adapter.test.ts`

- [ ] **Step 1: Write artifact orchestration tests**

Inject `runProcess(command, signal)` while using real OS temporary directories. Have the fake process write capabilities only to the received `--output` path and return deliberate stdout/stderr. Assert:

- two operations receive different directories and artifact paths outside the workspace;
- stdout/stderr containing invalid JSON cannot affect a valid artifact;
- valid exit 0 returns negotiated framework/version/extensions;
- valid artifact plus nonzero exit is `process_failed`;
- absent artifact is `legacy_runner` for exit 0, 1, or 2;
- malformed existing artifact is `malformed_capabilities` regardless of exit;
- empty intersection is `incompatible_adapter`;
- unreadable existing artifact is `read_failed`;
- command validation errors retain missing runner, invalid runner, missing engine, and missing project kinds;
- process spawn failures retain missing engine versus generic spawn failure;
- aborted operations return internal cancellation; and
- after every success, failure, and cancellation, the exact temporary directory no longer exists.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `npx vitest run src/testing/adapter.test.ts`

Expected: FAIL because adapter orchestration is missing.

- [ ] **Step 3: Implement adapter orchestration**

Define a stable error contract:

```ts
export type TestAdapterFailureKind =
  | TestAdapterConfigurationErrorKind
  | "malformed_capabilities"
  | "incompatible_adapter"
  | "process_failed"
  | "legacy_runner"
  | "spawn_failed"
  | "read_failed";

export class TestAdapterFailure extends Error {
  readonly kind: TestAdapterFailureKind;
  readonly setting?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}
```

Create `mkdtemp(join(tmpdir(), "foundryscript-test-adapter-"))`, use `<dir>/capabilities.json`, and run the command. If cancelled, throw an `AbortError`. Otherwise attempt the artifact read before judging exit code. Map `ENOENT` to legacy, other reads to read failure, parse/negotiation failures to their stable kinds, and only then reject nonzero exit. Always `rm(dir, {recursive:true, force:true})` in `finally` where `dir` is the exact `mkdtemp` return.

- [ ] **Step 4: Run adapter tests and verify GREEN**

Run: `npx vitest run src/testing/adapter.test.ts`

Expected: all negotiation and cleanup tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/testing/adapter.ts src/testing/adapter.test.ts
git commit -m "feat: negotiate test adapter artifacts"
```

### Task 5: Generation-safe runtime and testing status

**Files:**
- Create: `src/testing/runtime.ts`
- Create: `src/testing/runtime.test.ts`
- Create: `src/testing/status.ts`
- Create: `src/testing/status.test.ts`

- [ ] **Step 1: Write runtime and status tests**

Use deferred operation promises and injected abort controllers to prove:

- disabled configuration starts no operation and publishes disabled;
- enabled configuration publishes negotiating then ready with all framework metadata;
- each meaningful settings/project change invalidates and aborts the prior generation;
- identical settings do not restart;
- a stale success and stale failure publish nothing after a newer generation;
- disabling immediately publishes disabled, aborts the child, and awaits bounded completion;
- `stop()` is idempotent and makes all later completions inert;
- cancellation never becomes an error state;
- each failure kind renders an actionable message; and
- disabled status disposes its status item, re-enable creates a fresh item, and ready tooltip contains framework ID/name/version, protocol, and extensions.

Use these states:

```ts
type TestingState =
  | { kind: "disabled" }
  | { kind: "negotiating"; runner: string }
  | { kind: "ready"; adapter: NegotiatedTestAdapter }
  | { kind: "error"; failure: TestAdapterFailure };
```

- [ ] **Step 2: Run runtime/status tests and verify RED**

Run: `npx vitest run src/testing/runtime.test.ts src/testing/status.test.ts`

Expected: FAIL because runtime and status modules are missing.

- [ ] **Step 3: Implement generation coordination and lazy status**

`TestingRuntime.configure(request)` compares an immutable request key, increments a generation before aborting any active operation, and checks the token after every await. It starts negotiation only if enabled. `stop()` increments the generation, records stopped state, aborts the active controller, awaits its already bounded result, and publishes disabled once.

`TestingStatusController` receives a status-item factory. It creates/shows an item for negotiating, ready, or error. On disabled it disposes the item and clears its reference. Ready text names the framework; the tooltip records framework ID/name/version, protocol version, and comma-separated extensions or `none`.

- [ ] **Step 4: Run runtime/status tests and verify GREEN**

Run: `npx vitest run src/testing/runtime.test.ts src/testing/status.test.ts`

Expected: all generation, disable, and status tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/testing/runtime.ts src/testing/runtime.test.ts src/testing/status.ts src/testing/status.test.ts
git commit -m "feat: coordinate test adapter status"
```

### Task 6: VS Code lifecycle wiring without task or LSP coupling

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts`

- [ ] **Step 1: Write failing extension integration tests**

Extend the VS Code mock with `onDidChangeConfiguration`, `onDidChangeWorkspaceFolders`, separate named output channels, and multiple status items. Mock `createTestingRuntime` and assert:

- activation always registers the existing task provider and follows existing LSP behavior;
- disabled testing configures no adapter process and shows no testing status;
- enabled testing passes engine, first workspace project, runner, and exact args to the testing runtime;
- relevant configuration and workspace changes reconfigure testing;
- unrelated configuration changes do not;
- disabling testing does not stop the connection manager or unregister tasks;
- deactivation awaits exactly one testing runtime stop and exactly one active LSP manager stop; and
- missing-runner/invalid-runner/missing-engine failures offer the precise setting, missing project offers a folder, and protocol/process/legacy failures offer the testing output channel.

- [ ] **Step 2: Run extension tests and verify RED**

Run: `npx vitest run src/extension.test.ts`

Expected: FAIL because testing runtime wiring is absent.

- [ ] **Step 3: Implement extension bridge**

Read:

```ts
{
  enabled: configuration.get("testing.enabled", false),
  enginePath: configuration.get("enginePath", "foundry"),
  project: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  runner: configuration.get("testing.runner", ""),
  frameworkArgs: configuration.get("testing.args", []),
}
```

Create a dedicated `FoundryScript Testing` output channel, status controller factory, process, negotiator, and runtime. Register configuration/workspace listeners that call `configure` only for relevant changes. Start configuration without awaiting the adapter child. On deactivation, clear the global runtime reference before awaiting `stop()` so repeated deactivation is idempotent. Keep task registration and the existing LSP early-return paths unchanged.

- [ ] **Step 4: Run focused and adjacent tests and verify GREEN**

Run: `npx vitest run src/extension.test.ts src/tasks/provider.test.ts src/client/runtime.test.ts`

Expected: extension, task, and LSP tests all pass.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/extension.test.ts
git commit -m "feat: wire test adapter lifecycle"
```

### Task 7: Real protocol integration and publication verification

**Files:**
- Modify only test/production files if a verified integration defect requires a TDD fix.

- [ ] **Step 1: Run all focused testing tests**

Run: `npx vitest run src/testing src/extension.test.ts src/tasks/provider.test.ts src/client/runtime.test.ts`

Expected: all focused tests pass.

- [ ] **Step 2: Build and verify an exact Foundry dependency checkout**

Use a temporary checkout at Foundry commit `af7af3946a9c554b6f35285ee59b8411b5c3f4d0`. Build there with the repository-supported macOS agent build command and confirm the resulting binary reports the exact checkout commit/build. Do not write to the user's Foundry checkout.

- [ ] **Step 3: Run the exact FoundryLib reference adapter**

Use a temporary FoundryLib checkout at `6df2b4d7ff43c013a4c9e9033c01cdadbdeda19a`. Invoke its runner with the exact capabilities command and an output path under a unique temporary directory. Validate the artifact through the extension parser and assert negotiated protocol `1`, framework ID `foundrylib-testlib`, name `FoundryLib TestLib`, version `1.0.0`, exit `0`, and complete cleanup. Confirm captured engine/application stdout and stderr are absent from the JSON artifact.

- [ ] **Step 4: Run the complete fresh gate**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run package -- --out <temporary-directory>/foundryscript-issue-19.vsix
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: every command exits zero, the VSIX exists, and the worktree is clean.

- [ ] **Step 5: Rebase and review**

Fetch `origin/main`. If it advanced, rebase, repeat the complete fresh gate, and commit only verified conflict resolutions. Run Cursor's exact read-only wrapper against `origin/main`. Validate every finding with receiving-code-review and systematic-debugging; fix real defects through RED→GREEN TDD, commit, reverify, and repeat until a valid `RESULT: clean` on final HEAD.

- [ ] **Step 6: Publish and clean up after merge**

Push `issue-19`, open a ready PR to `main` whose body ends `Closes #19`, enable squash auto-merge only for the reviewed HEAD, and monitor every CI check through merge. Remove only the merged issue-19 worktree, local branch, and remote branch. Preserve the main checkout, `.claude/`, and all other worktrees/repositories.
