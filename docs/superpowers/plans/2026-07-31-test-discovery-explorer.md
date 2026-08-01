# Foundry Test Discovery and Test Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover tests through Foundry Test Adapter Protocol v1 and reconcile complete valid discovery into one stable hierarchical VS Code TestController.

**Architecture:** Extend issue #19's independent testing pipeline with a pure discovery command, strict byte-oriented JSONL parser, owned temporary-artifact discoverer, generation-safe negotiate-then-discover runtime, and protocol-neutral stable-ID Test Explorer reconciler. Only complete valid exit-consistent discovery mutates the tree; valid empty discovery clears it, while invalid operations retain the last-known-good hierarchy.

**Tech Stack:** TypeScript, Node.js child processes and filesystem APIs, VS Code TestController/TestItem API, Vitest, esbuild, VSCE, Foundry Test Adapter Protocol v1 fixtures.

---

### Task 1: Exact Discovery Command

**Files:**
- Modify: `src/testing/command.ts`
- Modify: `src/testing/command.test.ts`

- [ ] **Step 1: Write failing discovery command tests**

Add tests that call a new `createTestAdapterDiscoveryCommand()` with engine `/opt/foundry`, project `/workspace/game`, runner `res://tests/runner.fs`, negotiated version `1`, output `/tmp/discovery.jsonl`, and opaque arguments `--path`, `res://specs`, `--output`, `opaque`. Assert this exact command:

```ts
{
  command: "/opt/foundry",
  cwd: "/workspace/game",
  args: [
    "--headless", "--no-header", "project", "test",
    "--project", "/workspace/game",
    "--runner", "res://tests/runner.fs", "--",
    "adapter", "discover",
    "--protocol-version", "1",
    "--output", "/tmp/discovery.jsonl",
    "--", "--path", "res://specs", "--output", "opaque",
  ],
}
```

Add separate cases proving the adapter-level separator is omitted when framework arguments are empty, opaque empty/option-looking values are preserved, and version `0`, `-1`, `1.5`, `NaN`, and `Infinity` throw `TestAdapterConfigurationError` with kind `invalid_protocol_version` and no settings key.

- [ ] **Step 2: Run command tests and verify RED**

Run: `npx vitest run src/testing/command.test.ts`

Expected: FAIL because the discovery request type, error kind, and command builder do not exist.

- [ ] **Step 3: Refactor shared validation and implement the discovery command**

Keep `TestAdapterCommand` as the common process boundary. Extend the configuration kind union and add this public request and function:

```ts
export interface TestAdapterCommandRequestFields {
  readonly enginePath: string;
  readonly project: string | undefined;
  readonly runner: string;
  readonly frameworkArgs: readonly string[];
}

export interface TestAdapterDiscoveryCommandRequest
  extends TestAdapterCommandRequestFields {
  readonly protocolVersion: number;
  readonly outputPath: string;
}

export function createTestAdapterDiscoveryCommand(
  request: TestAdapterDiscoveryCommandRequest,
): TestAdapterCommand;
```

Extract the existing engine/project/runner/framework-argument checks into one private validator used by both capability and discovery builders. Validate the version with `Number.isInteger(version) && version > 0`. Construct reserved discovery arguments exactly as asserted and append `"--", ...frameworkArgs` only when non-empty. Add the actionable message `Use a negotiated positive integer Foundry test adapter protocol version.` for `invalid_protocol_version`.

- [ ] **Step 4: Run command tests and verify GREEN**

Run: `npx vitest run src/testing/command.test.ts && npm run typecheck && npm run lint`

Expected: all command tests, typecheck, and lint pass.

- [ ] **Step 5: Commit**

```bash
git add src/testing/command.ts src/testing/command.test.ts
git commit -m "feat: construct test adapter discovery commands"
```

### Task 2: Normative Discovery Fixtures and Strict Parser

**Files:**
- Create: `src/testing/discovery.ts`
- Create: `src/testing/discovery.test.ts`
- Create: `src/testing/fixtures/discovery/valid/*.jsonl`
- Create: `src/testing/fixtures/discovery/invalid/*.jsonl`

- [ ] **Step 1: Vendor the immutable normative discovery fixture bytes**

Use `git archive` from `/Users/christian/CafecitoGames/Foundry` at exact commit `bd801d667e9c6118fc4617cc53dc0e08175adeaa` to extract only:

```text
tools/foundry-test-adapter/protocol/v1/fixtures/valid/discovery/
tools/foundry-test-adapter/protocol/v1/fixtures/invalid/discovery/
```

Copy the six valid and twenty-five invalid files into the matching extension fixture directories without normalizing bytes or line endings. Verify the copied file names and byte hashes against the exact Git objects. This intentionally preserves BOM, invalid UTF-8, CRLF, and missing-terminal-LF fixtures.

- [ ] **Step 2: Write failing parser tests over the complete fixture matrix**

Define exact valid and invalid filename arrays so omitting a normative row fails review:

```ts
const validFixtures = [
  "additive.jsonl", "astral-range.jsonl", "empty.jsonl",
  "nested.jsonl", "with-errors.jsonl", "with-skip.jsonl",
] as const;

const invalidFixtures = [
  "blank-line.jsonl", "byte-order-mark.jsonl", "count-mismatch.jsonl",
  "crlf.jsonl", "duplicate-id.jsonl", "duplicate-start.jsonl",
  "inherited-skip.jsonl", "invalid-utf8.jsonl", "late-start.jsonl",
  "malformed-line.jsonl", "missing-end.jsonl", "missing-start.jsonl",
  "non-canonical-path.jsonl", "non-canonical-root.jsonl",
  "non-runnable-skipped.jsonl", "range-order.jsonl",
  "range-without-path.jsonl", "reason-without-skip.jsonl",
  "records-after-end.jsonl", "skip-without-reason.jsonl",
  "test-as-parent.jsonl", "truncated.jsonl", "unknown-event.jsonl",
  "unknown-parent.jsonl", "wrong-version.jsonl",
] as const;
```

Assert every valid file returns a model and every invalid file throws `TestDiscoveryParseError`. Add focused assertions that:

- `empty.jsonl` returns zero items and zero counts;
- `nested.jsonl` preserves parent-before-child order, globally distinct IDs despite colliding labels, nullable and non-null case keys, runnable state, and exact ranges;
- `with-errors.jsonl` returns valid suite/test/error records together and error count `1`;
- `with-skip.jsonl` retains skipped state and reason;
- `astral-range.jsonl` retains character offsets `2` and `30` unchanged;
- `additive.jsonl` ignores unknown fields; and
- a synthetic framework-neutral JSONL string containing U+2028/U+2029 inside a label parses because only LF separates records.

- [ ] **Step 3: Run parser tests and verify RED**

Run: `npx vitest run src/testing/discovery.test.ts`

Expected: FAIL because the parser and discovery model do not exist.

- [ ] **Step 4: Implement the byte-oriented discovery model and parser**

Define explicit protocol types:

```ts
export interface TestDiscoveryPosition { readonly line: number; readonly character: number }
export interface TestDiscoveryRange { readonly start: TestDiscoveryPosition; readonly end: TestDiscoveryPosition }

export type TestDiscoveryItem = TestDiscoverySuite | TestDiscoveryTest | TestDiscoveryError;

export interface TestDiscoveryNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly label: string;
  readonly resourcePath: string | null;
  readonly range: TestDiscoveryRange | null;
  readonly runnable: boolean;
  readonly skipped: boolean;
  readonly skipReason: string | null;
}

export interface TestDiscoverySuite extends TestDiscoveryNode {
  readonly kind: "suite";
}

export interface TestDiscoveryTest extends TestDiscoveryNode {
  readonly kind: "test";
  readonly caseKey: string | null;
}

export interface TestDiscoveryError {
  readonly kind: "error";
  readonly id: string;
  readonly parentId: string | null;
  readonly label: string;
  readonly message: string;
  readonly resourcePath: string | null;
  readonly range: TestDiscoveryRange | null;
}

export interface TestDiscoveryModel {
  readonly root: string;
  readonly items: readonly TestDiscoveryItem[];
  readonly suiteCount: number;
  readonly testCount: number;
  readonly errorCount: number;
}

export type TestDiscoveryParseErrorKind =
  | "malformed_discovery"
  | "incomplete_discovery";

export class TestDiscoveryParseError extends Error {
  constructor(readonly kind: TestDiscoveryParseErrorKind, message: string, options?: ErrorOptions);
}

export function parseTestDiscovery(bytes: Uint8Array): TestDiscoveryModel;
```

Implement fatal UTF-8 decoding and reject BOM, carriage returns, missing final LF, empty/blank lines, malformed JSON, non-object roots, wrong protocol/version, and unknown events. Parse each event with required-field helpers that distinguish absent/null/wrong types while ignoring additive properties.

Validate canonical non-empty `res://` paths; control-free non-empty strings; nullable fields; non-negative integer positions; lexicographic start/end ordering; skip reason/state; non-runnable test skip prohibition; and non-empty case keys. In a single ordered stream pass, require start first, end last, global ID uniqueness, and each non-null parent to identify a previously accepted suite. Track suite ancestors so every runnable test under a skipped suite is explicitly skipped. Finally compare all three counts. Classify missing terminal LF, absent final end, and truncated lifecycle as `incomplete_discovery`; classify all other violations as `malformed_discovery`.

- [ ] **Step 5: Run parser tests and verify GREEN**

Run: `npx vitest run src/testing/discovery.test.ts && npm run typecheck && npm run lint`

Expected: all six valid and twenty-five invalid normative fixtures, synthetic cases, typecheck, and lint pass.

- [ ] **Step 6: Commit**

```bash
git add src/testing/discovery.ts src/testing/discovery.test.ts src/testing/fixtures/discovery
git commit -m "feat: validate test adapter discovery streams"
```

### Task 3: Owned Discovery Artifact Operation

**Files:**
- Create: `src/testing/discoverer.ts`
- Create: `src/testing/discoverer.test.ts`
- Modify: `src/testing/adapter.ts`

- [ ] **Step 1: Write failing discoverer orchestration tests**

Inject process, read, temporary-directory, cleanup, and cleanup-diagnostic functions as issue #19 does. Assert:

- each concurrent operation receives a unique absolute output under OS temp, never under the project;
- the process receives the exact command and the parser reads only the artifact, never deliberate JSON-looking stdout/stderr;
- a valid zero-error model with exit `0` resolves;
- a valid represented-error model with exit `1` resolves with valid items and errors;
- zero errors with exit `1`, represented errors with exit `0`, and any valid artifact with exit `2` reject as `discovery_exit_mismatch`;
- malformed/incomplete artifacts take precedence over every process exit;
- missing and unreadable artifacts, missing engine/spawn failures, and cancellation remain distinct failures;
- cancellation throws internal `AbortError` and never publishes a model;
- exact temporary cleanup occurs on every result; and
- cleanup failure invokes diagnostics without masking a success or classified failure and without leaking real test directories.

- [ ] **Step 2: Run discoverer tests and verify RED**

Run: `npx vitest run src/testing/discoverer.test.ts`

Expected: FAIL because `FoundryTestAdapterDiscoverer` does not exist.

- [ ] **Step 3: Implement discovery orchestration**

Create these public interfaces:

```ts
export interface TestAdapterDiscoveryRequest extends TestAdapterNegotiationRequest {
  readonly protocolVersion: number;
}

export interface FoundryTestAdapterDiscovererOptions {
  readonly runProcess?: (command: TestAdapterCommand, signal: AbortSignal) => Promise<TestAdapterProcessResult>;
  readonly readArtifact?: (artifactPath: string) => Promise<Buffer>;
  readonly makeTemporaryDirectory?: (prefix: string) => Promise<string>;
  readonly removeTemporaryDirectory?: (directory: string) => Promise<void>;
  readonly onCleanupError?: (error: unknown, directory: string) => void;
  readonly temporaryRoot?: string;
}

export class FoundryTestAdapterDiscoverer {
  discover(request: TestAdapterDiscoveryRequest, signal: AbortSignal): Promise<TestDiscoveryModel>;
}
```

Use prefix `foundryscript-test-discovery-` and file `discovery.jsonl`. Build, spawn, cancel, read, and parse in that order. Compute expected exit as `model.errorCount > 0 ? 1 : 0`; reject any mismatch before returning. Extend `TestAdapterFailureKind` with `malformed_discovery`, `incomplete_discovery`, and `discovery_exit_mismatch`, preserving stdout/stderr and causes. Treat ENOENT as `read_failed` with a discovery-specific message. Mirror issue #19's cleanup-error containment.

- [ ] **Step 4: Run discoverer tests and verify GREEN**

Run: `npx vitest run src/testing/discoverer.test.ts src/testing/process.test.ts src/testing/adapter.test.ts && npm run typecheck && npm run lint`

Expected: discoverer plus adjacent process/capability orchestration tests, typecheck, and lint pass.

- [ ] **Step 5: Commit**

```bash
git add src/testing/discoverer.ts src/testing/discoverer.test.ts src/testing/adapter.ts
git commit -m "feat: own test adapter discovery artifacts"
```

### Task 4: Stable Test Explorer Reconciler

**Files:**
- Create: `src/testing/explorer.ts`
- Create: `src/testing/explorer.test.ts`

- [ ] **Step 1: Write failing Test Explorer reconciliation tests**

Build a behavioral mock implementing the `TestController`, `TestItem`, and `TestItemCollection` subset, including automatic parent assignment. Test public `FoundryTestExplorer.reconcile(project, model)`, `clear()`, and `getMetadata(id)` behavior:

- nested suites/tests/errors use authoritative IDs and parent collections, never labels;
- `res://tests/example.fs` resolves under the supplied project;
- range factories receive the exact zero-based UTF-16 integers, including astral offsets `2` and `30`;
- colliding parameter labels produce distinct items and preserve opaque case keys;
- runnable, skipped, skip reason, non-runnable, and error metadata/description/error are retained visibly;
- repeated unchanged discovery returns the identical object references;
- rename and range changes mutate the same item;
- reparenting detaches and re-adds the same item object under the new suite;
- additions/removals and `sortText` follow discovery order deterministically;
- immutable path or event-kind change recreates only that ID;
- a valid empty model clears all prior items; and
- calling no reconcile after a simulated parser/discoverer failure leaves the prior hierarchy unchanged.

- [ ] **Step 2: Run explorer tests and verify RED**

Run: `npx vitest run src/testing/explorer.test.ts`

Expected: FAIL because the reconciler does not exist.

- [ ] **Step 3: Implement the protocol-neutral reconciler**

Import VS Code interfaces as type-only dependencies. Define:

```ts
export interface FoundryTestExplorerValues {
  readonly createUri: (nativePath: string) => vscode.Uri;
  readonly createRange: (range: TestDiscoveryRange) => vscode.Range;
}

export interface FoundryTestItemMetadata {
  readonly kind: TestDiscoveryItem["kind"];
  readonly parentId: string | null;
  readonly resourcePath: string | null;
  readonly runnable: boolean;
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly caseKey: string | null;
}

export class FoundryTestExplorer {
  constructor(controller: vscode.TestController, values: FoundryTestExplorerValues);
  reconcile(project: string, model: TestDiscoveryModel): void;
  clear(): void;
  getMetadata(id: string): FoundryTestItemMetadata | undefined;
}
```

Track item, metadata, parent-ID, resource-path, kind, and prior-order maps. Before adding the new model, detach removed/recreated/reparented items child-first. Recreate only immutable URI/kind changes; otherwise mutate label, range, description, error, and nine-digit zero-padded `sortText`. Add parent-before-child to either controller items or the already-present suite. Use `path.join(project, resourcePath.slice("res://".length))`; parser validation guarantees containment. Error records set `error = message` and description `Discovery error`; skipped records use `Skipped: <reason>`; non-runnable records use `Not runnable`; other descriptions/errors are cleared.

- [ ] **Step 4: Run explorer tests and verify GREEN**

Run: `npx vitest run src/testing/explorer.test.ts && npm run typecheck && npm run lint`

Expected: every identity, hierarchy, projection, and authoritative-empty case passes.

- [ ] **Step 5: Commit**

```bash
git add src/testing/explorer.ts src/testing/explorer.test.ts
git commit -m "feat: reconcile discovered tests by adapter id"
```

### Task 5: Negotiate-Then-Discover Runtime and Status

**Files:**
- Modify: `src/testing/runtime.ts`
- Modify: `src/testing/runtime.test.ts`
- Modify: `src/testing/status.ts`
- Modify: `src/testing/status.test.ts`

- [ ] **Step 1: Write failing runtime pipeline tests**

Extend runtime options with `discover`, `onDiscovery`, and `onClear`. Assert:

- enabled configuration negotiates first, passes the exact negotiated version and original request into discovery, then publishes the model and ready state;
- state order is `negotiating`, `discovering`, `ready`;
- a complete empty model calls `onDiscovery` and therefore authoritatively clears through reconciliation;
- a complete model with recoverable errors publishes normally and ready state retains error count;
- rejected malformed/incomplete/exit-mismatch discovery publishes error state but never calls `onDiscovery` or `onClear`;
- a newer configure/refresh aborts the old generation and stale discovery success/failure is inert;
- `refresh()` repeats negotiation/discovery for unchanged configuration;
- refresh while disabled or before configuration does not spawn;
- disabling cancels the process, calls `onClear` once, and removes status;
- stop remains idempotent and bounded; and
- discovery cancellation is internal control flow, not an unavailable error.

Add status tests for `discovering`, ready with zero errors, and ready with one/multiple represented errors.

- [ ] **Step 2: Run runtime/status tests and verify RED**

Run: `npx vitest run src/testing/runtime.test.ts src/testing/status.test.ts`

Expected: FAIL because discovery pipeline callbacks, refresh, and states do not exist.

- [ ] **Step 3: Implement the generation-owned pipeline**

Add runtime options:

```ts
readonly discover: (
  request: TestAdapterDiscoveryRequest,
  signal: AbortSignal,
) => Promise<TestDiscoveryModel>;
readonly onDiscovery: (project: string, model: TestDiscoveryModel) => void;
readonly onClear: () => void;
```

Store the latest configuration. Refactor configure into one `start(configuration, force)` path that preserves issue #19's conditional wait before installing a new controller. `refresh()` calls the same path with `force: true`. In a current generation: negotiate, publish `discovering`, discover with `adapter.protocolVersion`, call `onDiscovery(project, model)`, then publish ready with `discoveryErrorCount`. Never call the authoritative callback from a catch/cancel/stale path. Explicit disable calls `onClear`; ordinary operation errors do not.

Extend `TestingState` with:

```ts
| { readonly kind: "discovering"; readonly adapter: NegotiatedTestAdapter }
| { readonly kind: "ready"; readonly adapter: NegotiatedTestAdapter; readonly discoveryErrorCount: number }
```

Render discovering with a spinner. Render clean ready as the existing framework status. Render ready with errors as a warning status and tooltip that includes the exact represented discovery error count.

- [ ] **Step 4: Run runtime/status tests and verify GREEN**

Run: `npx vitest run src/testing/runtime.test.ts src/testing/status.test.ts src/testing/discoverer.test.ts && npm run typecheck && npm run lint`

Expected: runtime, status, discoverer, typecheck, and lint pass.

- [ ] **Step 5: Commit**

```bash
git add src/testing/runtime.ts src/testing/runtime.test.ts src/testing/status.ts src/testing/status.test.ts
git commit -m "feat: coordinate test adapter discovery"
```

### Task 6: VS Code TestController Integration

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts`

- [ ] **Step 1: Write failing extension integration tests**

Extend the existing VS Code mock with `tests.createTestController`, behavioral item collections, `Uri.file`, `Range`, and cancellation tokens. Assert:

- activation creates exactly one controller with ID `foundryScript.tests` and label `FoundryScript` even when testing is disabled;
- no run profile is registered;
- enabled testing negotiates, discovers, and reconciles the returned hierarchy;
- the controller refresh handler forces a second negotiation/discovery for unchanged settings and awaits completion;
- an already-cancelled refresh token starts no operation;
- a malformed refresh leaves prior controller item object references intact and reports through testing status/log;
- a valid empty refresh removes prior items;
- disabling clears controller items without stopping tasks or LSP;
- controller, runtime, status, and output are registered for disposal exactly once;
- LSP `off`, missing-project, and connection failure paths still keep the independent controller lifecycle; and
- deactivation still awaits testing and LSP stop without registering execution behavior.

- [ ] **Step 2: Run extension tests and verify RED**

Run: `npx vitest run src/extension.test.ts`

Expected: FAIL because discovery/controller wiring is absent.

- [ ] **Step 3: Wire one controller into the independent testing lifecycle**

In `registerTestingRuntime`:

```ts
const controller = vscode.tests.createTestController("foundryScript.tests", "FoundryScript");
const explorer = new FoundryTestExplorer(controller, {
  createUri: (nativePath) => vscode.Uri.file(nativePath),
  createRange: (range) => new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  ),
});
```

Create one `FoundryTestAdapterDiscoverer` sharing the existing owned process and cleanup logger. Inject `discover`, `onDiscovery: explorer.reconcile`, and `onClear: explorer.clear` into the runtime. Register the controller in `context.subscriptions`. Set `controller.refreshHandler` to return early for an already-cancelled token and otherwise await `runtime.refresh()`.

Extend testing-log state messages for discovery and represented-error ready states. Keep configuration listeners, task registration, and LSP code unchanged. Do not create a run profile.

- [ ] **Step 4: Run extension and adjacent tests and verify GREEN**

Run: `npx vitest run src/extension.test.ts src/testing src/tasks/provider.test.ts src/client/runtime.test.ts && npm run typecheck && npm run lint && npm run build`

Expected: extension, all testing units, ordinary tasks, LSP runtime, typecheck, lint, and build pass.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/extension.test.ts
git commit -m "feat: discover tests into Test Explorer"
```

### Task 7: Real Discovery, Review, Publication, and Cleanup

**Files:**
- Modify only implementation/tests/docs if a verified gate or review defect requires a TDD fix.

- [ ] **Step 1: Run the complete focused and fresh local gates**

Run:

```bash
npx vitest run src/testing src/extension.test.ts src/tasks/provider.test.ts src/client/runtime.test.ts
npm test
npm run typecheck
npm run lint
npm run build
issue20_temp="$(mktemp -d /tmp/foundryscript-issue20-gates.XXXXXX)"
mkdir -p "$issue20_temp/package"
npm run package -- --out "$issue20_temp/package/foundryscript-issue-20.vsix"
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: all focused tests, full unit/grammar tests, typecheck, lint, build, package, diff check, and clean status pass.

- [ ] **Step 2: Verify the candidate Foundry binary contains the required protocol**

Inspect `/Users/christian/.Trash/foundry-semantic-RFOrfW/Foundry/bin/foundry.macos.editor.dev.arm64` only if it exists. Require `--version` and embedded revision evidence for `bd801d667e9c6118fc4617cc53dc0e08175adeaa`, which contains Foundry#1428. If either check fails, create a clean temporary Foundry checkout containing #1428 and build there with `scripts/agent_build.py`; never modify the user's Foundry checkout.

- [ ] **Step 3: Run the real production discovery pipeline**

Create a clean temporary FoundryLib checkout at `6df2b4d7ff43c013a4c9e9033c01cdadbdeda19a`. Use a temporary TypeScript harness executed by the worktree's `vite-node` to import the production negotiator and discoverer. Negotiate capabilities, then discover with:

```text
runner: res://addons/foundrylib/testlib/cli/run.fs
framework args: --path res://tests/testlib/adapter_fixtures/live/clean
```

Assert protocol `1`, one suite, four tests, zero errors, distinct authoritative IDs for the two colliding-label parameter rows, case keys `row:0` and `row:1`, and non-null ranges. Run a second discovery against `res://tests/testlib/adapter_fixtures/discovery`; assert process exit `1` is accepted as an authoritative model containing valid suite/test records plus one or more discovery errors. Snapshot `foundryscript-test-adapter-*` and `foundryscript-test-discovery-*` temp directories before and after and require equality. Remove the exact harness and temporary checkouts after recording evidence.

- [ ] **Step 4: Integrate current main and obtain a clean Cursor verdict**

Fetch `origin/main`. If it advanced, rebase `issue-20`, resolve only in-scope conflicts, repeat Steps 1-3, and commit verified resolutions. Run `/Users/christian/.agents/skills/cursor-review/SKILL.md`'s exact foreground read-only wrapper with base `origin/main` and workspace issue-20. Validate every finding with receiving-code-review and systematic-debugging. For each real defect, reproduce RED, implement one fix, verify GREEN, commit, rerun the complete relevant gate, and repeat Cursor until a valid `RESULT: clean` on final HEAD. No waiver is allowed.

- [ ] **Step 5: Publish only the clean-reviewed head**

Push `issue-20`, open a ready PR to `main` with a body covering architecture, fixture matrix, real FoundryLib evidence, and verification, ending exactly `Closes #20`. Confirm the remote PR head equals the clean-reviewed SHA before enabling squash auto-merge. Monitor every GitHub Actions check; diagnose failures from logs, fix through RED→GREEN TDD, recommit, reverify, and rerun Cursor before re-enabling auto-merge on a changed head.

- [ ] **Step 6: Confirm merge and clean exact task state**

Require the PR state `MERGED`, record the squash SHA, and require issue #20 closed. Then remove only the merged issue-20 remote branch, worktree, local branch, fixture-extraction/integration/package directories, and Cursor output files. Verify the main checkout and every unrelated worktree/repository remain unchanged and clean.
