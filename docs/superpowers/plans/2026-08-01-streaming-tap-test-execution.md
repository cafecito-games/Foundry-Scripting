# Streaming TAP Test Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one VS Code Run profile that executes exact discovered Foundry test leaves and publishes strictly validated streaming TAP13 results.

**Architecture:** A pure discovery-order selector feeds an exact adapter run command. A strict byte-incremental TAP state machine emits only complete flushed points, an executor tails a unique external report while the child lives, and a profile adapter maps those events into VS Code states while invalidating false successes on infrastructure failure.

**Tech Stack:** TypeScript 5.6, VS Code Testing API 1.90, Node child processes/filesystem, Vitest 2, `yaml` 2.9, Foundry Test Adapter Protocol v1 fixtures.

---

## File Structure

- Modify `package.json` and `package-lock.json`: add the shipped YAML diagnostic parser.
- Modify `src/testing/command.ts` and `src/testing/command.test.ts`: build exact adapter run commands.
- Create `src/testing/selection.ts` and `src/testing/selection.test.ts`: convert include/exclude IDs and the authoritative discovery graph into an ordered runnable-leaf plan.
- Create `src/testing/report.ts` and `src/testing/report.test.ts`: incrementally decode and validate the strict Foundry v1 TAP13 profile.
- Copy `src/testing/fixtures/report/**`: immutable normative Foundry #1428 report artifacts plus a report-only manifest projection.
- Create `src/testing/executor.ts` and `src/testing/executor.test.ts`: own the temporary report, child, tail loop, output, cancellation, exit reconciliation, and cleanup.
- Create `src/testing/profile.ts` and `src/testing/profile.test.ts`: bridge selections and executor events to the VS Code TestRun surface.
- Modify `src/testing/process.ts` and `src/testing/process.test.ts`: allow one run-scoped output observer without weakening owned-process cancellation.
- Modify `src/testing/explorer.ts` and `src/testing/explorer.test.ts`: expose authoritative record/item snapshots for selection and exact result routing.
- Modify `src/testing/runtime.ts` and `src/testing/runtime.test.ts`: expose generation-matched ready context for runs.
- Modify `src/testing/adapter.ts` and `src/testing/status.test.ts`: classify run artifact and lifecycle failures.
- Modify `src/extension.ts` and `src/extension.test.ts`: register exactly one Run profile, inject production values, and preserve existing activation behavior.
- Create `scripts/verify-foundry-test-run.mjs`: exercise the production command/report path against pinned FoundryLib for the live gate.

### Task 1: Exact Selection and Command Grammar

**Files:**
- Create: `src/testing/selection.ts`
- Create: `src/testing/selection.test.ts`
- Modify: `src/testing/command.ts`
- Modify: `src/testing/command.test.ts`

- [ ] **Step 1: Write the failing command tests**

Add tests that call `createTestAdapterRunCommand` with protocol version `1`, report `/tmp/report.tap`, selections `['test-b', '--']`, and framework arguments `['--select', 'framework-value']`. Assert the exact array ends with:

```ts
[
  "--", "adapter", "run",
  "--protocol-version", "1",
  "--report", "/tmp/report.tap",
  "--select", "test-b",
  "--select", "--",
  "--", "--select", "framework-value",
]
```

Also assert no second separator is emitted for empty framework arguments and invalid versions reuse `invalid_protocol_version`.

- [ ] **Step 2: Run the command tests and verify RED**

Run: `npx vitest run src/testing/command.test.ts`

Expected: FAIL because `createTestAdapterRunCommand` and `TestAdapterRunCommandRequest` do not exist.

- [ ] **Step 3: Add the minimal run command builder**

Define:

```ts
export interface TestAdapterRunCommandRequest
  extends TestAdapterCommandRequestFields {
  readonly protocolVersion: number;
  readonly reportPath: string;
  readonly selections: readonly string[];
}

export function createTestAdapterRunCommand(
  request: TestAdapterRunCommandRequest,
): TestAdapterCommand;
```

Validate common configuration and the positive integer version, append `--select` pairs in input order, then call the existing framework-argument helper.

- [ ] **Step 4: Run the command tests and verify GREEN**

Run: `npx vitest run src/testing/command.test.ts`

Expected: all command tests pass.

- [ ] **Step 5: Write failing selection tests**

Build one nested discovery model containing runnable and non-runnable tests, an empty suite, a discovery error, and duplicate display labels. Assert:

```ts
expect(selectRunnableLeaves(model, undefined, [])).toEqual([
  expect.objectContaining({ id: "test-a" }),
  expect.objectContaining({ id: "test-b" }),
  expect.objectContaining({ id: "test-c" }),
]);
expect(selectRunnableLeaves(model, ["suite-a", "test-b", "suite-a"], ["suite-b"]))
  .toEqual([expect.objectContaining({ id: "test-a" })]);
expect(selectRunnableLeaves(model, ["error-a", "test-disabled"], [])).toEqual([]);
```

Cover nested suite expansion, descendant exclusions, overlap, repeats, undefined include, empty include, and discovery order.

- [ ] **Step 6: Run the selection tests and verify RED**

Run: `npx vitest run src/testing/selection.test.ts`

Expected: FAIL because `selectRunnableLeaves` is absent.

- [ ] **Step 7: Implement the pure selector**

Export:

```ts
export function selectRunnableLeaves(
  model: TestDiscoveryModel,
  includeIds: readonly string[] | undefined,
  excludeIds: readonly string[],
): readonly TestDiscoveryTest[];
```

Build parent/children maps from authoritative records, expand suites recursively, choose only `kind === "test" && runnable`, apply excludes after includes, and return the discovery-order filter of the chosen set.

- [ ] **Step 8: Run focused tests, then commit**

Run: `npx vitest run src/testing/command.test.ts src/testing/selection.test.ts`

Expected: both files pass.

Commit: `feat: plan exact Foundry test selections`

### Task 2: Strict Incremental TAP Preamble and Point Structure

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/testing/report.ts`
- Create: `src/testing/report.test.ts`

- [ ] **Step 1: Add the YAML runtime dependency**

Run: `npm install yaml@2.9.0 --save-exact`

Expected: `yaml` appears under `dependencies` and the lockfile records version `2.9.0`.

- [ ] **Step 2: Write failing incremental decoding and preamble tests**

Test a `FoundryTap13Parser` wished-for API:

```ts
const parser = new FoundryTap13Parser(plan, (point) => emitted.push(point));
parser.push(firstBytes);
parser.push(secondBytes);
const completion = parser.finish({ kind: "exited", exitCode: 0 });
```

Assert an astral label split inside its four-byte UTF-8 scalar parses once, an incomplete final scalar fails on `finish`, BOM/CRLF fail, exact header/comment/leading plan are required, plan and point digit runs are capped at nine, and no point is emitted before the terminating `  ...\n`.

- [ ] **Step 3: Run parser tests and verify RED**

Run: `npx vitest run src/testing/report.test.ts`

Expected: FAIL because `FoundryTap13Parser` does not exist.

- [ ] **Step 4: Implement the byte/line state machine through complete block collection**

Define public values:

```ts
export type FoundryStatusDetail =
  | "" | "discovery_error" | "runtime_error"
  | "timed_out" | "aborted" | "setup_error";

export interface FoundryTapPoint {
  readonly number: number;
  readonly ok: boolean;
  readonly label: string;
  readonly skipReason?: string;
  readonly testId: string;
  readonly durationMs: number;
  readonly statusDetail: FoundryStatusDetail;
  readonly message?: string;
  readonly location?: { readonly fileName: string; readonly lineNumber: number; readonly columnNumber: number };
}
```

Maintain one fatal streaming `TextDecoder`, a text suffix, parser phase, plan count, point candidate, YAML lines, seen IDs, and emitted points. Process only LF-complete lines during `push`; call `decoder.decode()` without bytes during `finish` and require no undecoded/text suffix for normal completion.

- [ ] **Step 5: Parse point syntax and strict YAML mappings**

Use `parseDocument` from `yaml` with strict error handling. Require exact two-space TAP indentation, mapping top level, mapping `_foundry`, required fields and closed detail set, message/status constraints, canonical location, expected ID/order, unique ID, and exact discovered skip state. Ignore unknown additive mapping keys.

- [ ] **Step 6: Run parser tests and verify GREEN**

Run: `npx vitest run src/testing/report.test.ts`

Expected: all incremental structure and metadata tests pass.

- [ ] **Step 7: Commit**

Commit: `feat: parse streaming Foundry TAP reports`

### Task 3: Normative Foundry Report Conformance

**Files:**
- Create: `src/testing/fixtures/report/manifest.json`
- Create: `src/testing/fixtures/report/valid/*.tap`
- Create: `src/testing/fixtures/report/invalid/*.tap`
- Modify: `src/testing/report.test.ts`

- [ ] **Step 1: Copy immutable report fixtures and project the manifest**

Copy every `protocol/v1/fixtures/{valid,invalid}/report/*.tap` byte-for-byte from Foundry commit `af7af3946a9c554b6f35285ee59b8411b5c3f4d0`. Create a report-only JSON manifest retaining each report entry's artifact, process exit, cancelled flag, discovery fixture, selections, expected validity, completeness, classification, and diagnostic code set.

- [ ] **Step 2: Write the failing manifest-driven test**

For each entry, load the bytes without newline normalization, supply existing discovery fixtures when named, reconstruct the selected plan, stream the report through varied chunk boundaries, and assert the parser result's validity, completeness, classification, and exact code set.

- [ ] **Step 3: Run normative tests and verify RED**

Run: `npx vitest run src/testing/report.test.ts`

Expected: at least one normative invalid/cancellation/bailout fixture exposes a missing strict rule.

- [ ] **Step 4: Complete lifecycle, bailout, cancellation, and diagnostic rules**

Implement exact terminal behavior:

```ts
parser.finish({ kind: "exited", exitCode });
parser.finish({ kind: "cancelled" });
```

Normal finish validates terminal LF, plan satisfaction, bailout placement/trailing content, and required exit. Cancelled finish discards only the unflushed byte suffix and incomplete trailing point candidate, accepts only protocol-defined prefixes, and rejects a completed malformed unit, bailout, or satisfied plan.

- [ ] **Step 5: Run all normative report tests and verify GREEN**

Run: `npx vitest run src/testing/report.test.ts`

Expected: all normative report entries and synthetic chunking cases pass.

- [ ] **Step 6: Verify fixture provenance and commit**

Run byte comparisons against `/tmp/foundry-1428.1qzVmy/tools/foundry-test-adapter/protocol/v1/fixtures` using `cmp` for every copied TAP file.

Expected: every comparison exits `0`.

Commit: `test: cover normative Foundry TAP fixtures`

### Task 4: Streaming Executor, Output, Cleanup, and Cancellation

**Files:**
- Modify: `src/testing/process.ts`
- Modify: `src/testing/process.test.ts`
- Create: `src/testing/executor.ts`
- Create: `src/testing/executor.test.ts`
- Modify: `src/testing/adapter.ts`
- Modify: `src/testing/status.test.ts`

- [ ] **Step 1: Write the failing process observer test**

Call `process.run(command, signal, observer)` on a fake child and assert constructor-level and run-level observers each receive stdout/stderr exactly once while the returned buffers remain unchanged.

- [ ] **Step 2: Run the process test and verify RED**

Run: `npx vitest run src/testing/process.test.ts`

Expected: FAIL because `run` accepts no per-run observer.

- [ ] **Step 3: Add the per-run observer and verify GREEN**

Extend `run` with optional:

```ts
onOutput?: (text: string, stream: "stdout" | "stderr") => void
```

Invoke it beside the existing observer without changing buffering, abort, timers, or cleanup.

Run: `npx vitest run src/testing/process.test.ts`

Expected: all process tests pass.

- [ ] **Step 4: Write failing executor streaming tests**

Use a deferred fake child and mutable in-memory report reader. Assert the executor:

- creates a unique absolute report path outside the project;
- reports a complete first point before the child promise resolves;
- performs one final read after child completion;
- never feeds stdout/stderr to TAP parsing;
- detects report truncation or changed prefixes;
- accepts genuine cancelled prefixes and retains completed points;
- rejects malformed cancellation and incomplete normal exit;
- classifies missing/unreadable artifacts and spawn failures;
- removes only the exact temporary directory; and
- preserves a primary result when cleanup diagnostics throw.

- [ ] **Step 5: Run executor tests and verify RED**

Run: `npx vitest run src/testing/executor.test.ts`

Expected: FAIL because `FoundryTestExecutor` does not exist.

- [ ] **Step 6: Implement the executor**

Export requests and callbacks:

```ts
export interface TestExecutionRequest extends TestAdapterNegotiationRequest {
  readonly project: string;
  readonly protocolVersion: number;
  readonly model: TestDiscoveryModel;
  readonly leaves: readonly TestDiscoveryTest[];
}

export interface TestExecutionObserver {
  readonly onPoint: (point: FoundryTapPoint) => void;
  readonly onOutput: (text: string, stream: "stdout" | "stderr") => void;
}
```

Create a unique temp directory, build the command, start the child, poll the complete report bytes with an injectable scheduler, verify immutable prefixes, stream appended bytes, final-read after process settlement, finish with exited/cancelled context, and clean up in `finally`.

- [ ] **Step 7: Add classified run failures and verify GREEN**

Extend `TestAdapterFailureKind` with `malformed_report`, `incomplete_report`, `report_exit_mismatch`, and `report_read_failed`. Preserve stdout/stderr and parser diagnostic context in failures.

Run: `npx vitest run src/testing/process.test.ts src/testing/executor.test.ts src/testing/status.test.ts`

Expected: all focused tests pass.

- [ ] **Step 8: Commit**

Commit: `feat: stream owned Foundry test executions`

### Task 5: Explorer Snapshot and Runtime Ready Context

**Files:**
- Modify: `src/testing/explorer.ts`
- Modify: `src/testing/explorer.test.ts`
- Modify: `src/testing/runtime.ts`
- Modify: `src/testing/runtime.test.ts`

- [ ] **Step 1: Write failing explorer snapshot tests**

After reconcile, assert `explorer.snapshot()` returns the exact model plus item lookup by authoritative ID, preserves colliding labels as distinct items, and returns `undefined` for standalone errors/nonexistent IDs where a runnable item is requested. Assert clear removes snapshot readiness.

- [ ] **Step 2: Run explorer tests and verify RED**

Run: `npx vitest run src/testing/explorer.test.ts`

Expected: FAIL because no snapshot API exists.

- [ ] **Step 3: Implement immutable explorer snapshots**

Expose:

```ts
export interface FoundryTestExplorerSnapshot {
  readonly model: TestDiscoveryModel;
  readonly item: (id: string) => vscode.TestItem | undefined;
}
```

Store the latest model only after a successful reconcile and clear it with the item maps.

- [ ] **Step 4: Write failing runtime ready-context tests**

Assert `runtime.readyContext()` is undefined during negotiation/discovery, contains the exact configuration/adapter/model after authoritative publication, clears immediately when configuration changes or disables, remains generation-safe against stale completion, and clears on stop.

- [ ] **Step 5: Run runtime tests and verify RED**

Run: `npx vitest run src/testing/runtime.test.ts`

Expected: FAIL because ready context is not exposed.

- [ ] **Step 6: Implement ready context and verify GREEN**

Define:

```ts
export interface TestingReadyContext {
  readonly configuration: TestingRuntimeConfiguration;
  readonly adapter: NegotiatedTestAdapter;
  readonly model: TestDiscoveryModel;
}
```

Clear it at every new generation and stop; set it immediately before the authoritative `onDiscovery`/ready publication for the current generation; return the immutable reference from `readyContext()`.

Run: `npx vitest run src/testing/explorer.test.ts src/testing/runtime.test.ts`

Expected: both focused files pass.

- [ ] **Step 7: Commit**

Commit: `feat: expose ready test execution context`

### Task 6: VS Code Run Profile Projection

**Files:**
- Create: `src/testing/profile.ts`
- Create: `src/testing/profile.test.ts`

- [ ] **Step 1: Write failing profile behavior tests**

Create VS Code-shaped fakes for `TestController`, `TestRun`, `TestMessage`, `Location`, and cancellation. Assert one handler invocation:

- calls `createTestRun` synchronously and once;
- translates include/exclude IDs through the pure selector;
- enqueues every leaf before starting any leaf;
- passes exact leaf IDs to the executor;
- routes colliding labels by `_foundry.id` only;
- maps pass, skip, ordinary fail, and all five non-empty status details;
- carries duration, failure text, and zero-based message location;
- converts application LF output to CRLF;
- keeps completed results only on genuine cancellation and skips remaining leaves;
- errors the full plan on every other infrastructure failure, including previously passed leaves; and
- calls `end()` exactly once for success, failure, cancellation, zero plan, not-ready, and thrown dependencies.

- [ ] **Step 2: Run profile tests and verify RED**

Run: `npx vitest run src/testing/profile.test.ts`

Expected: FAIL because `FoundryTestRunProfile` does not exist.

- [ ] **Step 3: Implement profile values and mapping**

Use dependency-injected VS Code constructors:

```ts
export interface FoundryTestRunProfileValues {
  readonly createMessage: (message: string) => TestMessageLike;
  readonly createLocation: (nativePath: string, line: number, character: number) => unknown;
}
```

The handler captures ready context and explorer snapshot, computes leaf IDs, creates a TestRun, enqueues all then starts all, delegates to the executor, maps points by ID, and wraps the entire lifecycle in one `try/catch/finally` whose `finally` ends the run once.

- [ ] **Step 4: Run profile tests and verify GREEN**

Run: `npx vitest run src/testing/profile.test.ts`

Expected: all profile behavior tests pass.

- [ ] **Step 5: Commit**

Commit: `feat: map Foundry results into VS Code runs`

### Task 7: Extension Wiring and Regression Coverage

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts`

- [ ] **Step 1: Extend the extension fake and write failing profile registration tests**

Capture `createRunProfile` arguments and fake `createTestRun`. Assert activation calls:

```ts
controller.createRunProfile(
  "Run",
  vscode.TestRunProfileKind.Run,
  expect.any(Function),
  true,
);
```

Assert it is called exactly once, no Debug kind is registered, the handler uses the production executor/process and current runtime/explorer contexts, and every activation/disable/deactivation path preserves existing task and LSP behavior.

- [ ] **Step 2: Run extension tests and verify RED**

Run: `npx vitest run src/extension.test.ts`

Expected: FAIL because activation still creates a discovery-only controller.

- [ ] **Step 3: Wire the production executor and profile**

Instantiate one `FoundryTestExecutor` using the shared owned process, cleanup logger, and production temp/report reader. Instantiate the profile adapter with `runtime.readyContext`, `explorer.snapshot`, `vscode.TestMessage`, `vscode.Location`, `vscode.Uri.file`, and `vscode.Position`. Register one default Run profile and add it to subscriptions only if required by the VS Code API.

- [ ] **Step 4: Run extension and all focused testing tests**

Run:

```sh
npx vitest run \
  src/testing/command.test.ts \
  src/testing/selection.test.ts \
  src/testing/report.test.ts \
  src/testing/process.test.ts \
  src/testing/executor.test.ts \
  src/testing/profile.test.ts \
  src/testing/explorer.test.ts \
  src/testing/runtime.test.ts \
  src/testing/status.test.ts \
  src/extension.test.ts
```

Expected: all focused tests pass without warnings.

- [ ] **Step 5: Commit**

Commit: `feat: register Foundry test run profile`

### Task 8: Live Pinned FoundryLib Streaming Gate

**Files:**
- Create: `scripts/verify-foundry-test-run.mjs`

- [ ] **Step 1: Write the live verifier against the production modules**

The script accepts explicit `--foundry`, `--project`, and `--runner` values, negotiates and discovers with the production classes, selects the streaming fixture's suite through the production selector, starts execution, and asserts:

- negotiated version is `1`;
- all requested IDs came from discovery;
- the first complete point callback fires before the adapter child exits;
- application stdout is observable but absent from the report parser input;
- the final plan and process exit conform; and
- the unique temporary directory is removed.

- [ ] **Step 2: Locate or build an isolated verified Foundry binary**

Search existing binaries and verify commit/help/transport behavior contains #1428. If none qualifies, use a separate temporary Foundry checkout at `af7af3946a9c554b6f35285ee59b8411b5c3f4d0` and build only its macOS test/editor target. Never modify another repository checkout.

- [ ] **Step 3: Run the pinned FoundryLib gate**

Use the clean checkout `/tmp/foundrylib-11.CjYgaD` at `6df2b4d7ff43c013a4c9e9033c01cdadbdeda19a` and its adapter runner resource.

Run: `node scripts/verify-foundry-test-run.mjs --foundry /tmp/foundry-1428.1qzVmy/bin/foundry.macos.editor.dev.arm64 --project /tmp/foundrylib-11.CjYgaD --runner res://addons/foundrylib/testlib/cli/run.fs --path res://tests/testlib/adapter_fixtures/live/streaming`

Expected: the script reports negotiated v1, a point observed before exit, conforming completion, and cleaned temporary artifacts.

- [ ] **Step 4: Run the full pre-review suite and commit**

Run: `npm test && npm run typecheck && npm run lint && npm run build`

Expected: every command exits `0`.

Commit: `test: verify live Foundry test streaming`

### Task 9: Review, Integrate, and Publish

**Files:**
- Modify only files required by validated review findings.

- [ ] **Step 1: Verify requirements and repository hygiene**

Run:

```sh
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
```

Re-read the approved design and map every goal/non-goal to tests and implementation. Expected: no uncommitted changes, no whitespace errors, and no out-of-scope #21 lifecycle work.

- [ ] **Step 2: Run Cursor review to a clean verdict**

Use the exact cursor-review skill wrapper with `CURSOR_REVIEW_BASE=origin/main`, committed HEAD, foreground execution, mutation checks, and a task-specific output path. Validate findings with receiving-code-review; for each real bug use systematic-debugging plus a failing regression test before a fix. Commit fixes and repeat until the latest valid result is exactly `RESULT: clean`.

- [ ] **Step 3: Integrate advanced main and re-review**

Fetch `origin/main`. If it advanced, merge it into `issue-22`, resolve only issue-scoped conflicts, rerun focused and broad verification, commit the integration if necessary, and obtain a fresh clean Cursor result against the new base.

- [ ] **Step 4: Run fresh publication gates**

Run, from the final reviewed HEAD:

```sh
npx vitest run src/testing/selection.test.ts src/testing/report.test.ts src/testing/executor.test.ts src/testing/profile.test.ts src/extension.test.ts
npm test
npm run typecheck
npm run lint
npm run build
npm run package
git diff --check origin/main...HEAD
```

Rerun the live pinned FoundryLib verifier. Expected: every command exits `0`, package creation succeeds, fixture comparison remains exact, and the live stream is conforming.

- [ ] **Step 5: Push and open the ready PR**

Push `issue-22`, create a non-draft PR to `main` with a concise summary and verification evidence, and ensure its body ends exactly:

```text
Closes #22
```

- [ ] **Step 6: Enable squash auto-merge and monitor through actual merge**

Only after the clean Cursor result and final gates, enable squash auto-merge. Poll all checks and reviews. Diagnose any failure from complete logs, add a failing regression where applicable, fix, verify, commit, push, and re-obtain clean review for the changed HEAD. Continue until GitHub reports the PR merged.

- [ ] **Step 7: Verify closure and clean exact task artifacts**

Confirm the squash commit is on `origin/main`, issue #22 is closed, and the PR is merged. Update the primary `main` checkout without touching its unrelated state. Remove only the `issue-22` worktree, local/remote issue branch, copied review output, and task-specific temporary Foundry/FoundryLib checkouts after confirming they are no longer needed.
