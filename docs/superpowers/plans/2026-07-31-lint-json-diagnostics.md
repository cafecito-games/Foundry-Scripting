# Lint JSON Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse Foundry lint JSON into the shared VS Code diagnostic collection while preserving task output, cancellation, rerun clearing, and LSP precedence.

**Architecture:** A strict domain parser converts captured version 1 reports to absolute paths and zero-based ranges. A stateful publisher adapts those records to VS Code diagnostics and sends per-file CLI batches to the issue #11 arbiter. The issue #12 process sink labels stdout/stderr chunks so the lint terminal can capture only stdout while forwarding all terminal text unchanged; LSP middleware and connection state feed the same arbiter.

**Tech Stack:** TypeScript, VS Code extension API, `vscode-languageclient`, Node child processes, Vitest, JSON fixtures.

---

## File map

- Create `src/tasks/fixtures/lint-report.json`: captured version 1 Foundry lint output.
- Create `src/tasks/lint-report.ts`: strict JSON schema and path/range conversion.
- Create `src/tasks/lint-report.test.ts`: fixture-driven parser tests and rejection cases.
- Create `src/tasks/lint-diagnostics.ts`: VS Code adaptation, per-file batching, rerun clearing, and run ordering.
- Create `src/tasks/lint-diagnostics.test.ts`: publisher behavior with a fake diagnostics unit.
- Modify `src/tasks/process.ts` and `src/tasks/process.test.ts`: label output chunks by stream without changing text or cancellation.
- Modify `src/tasks/provider.ts` and `src/tasks/provider.test.ts`: capture lint stdout and apply only complete exit 0/1 reports.
- Modify `src/client/language-client.ts` and `src/client/language-client.test.ts`: route LSP diagnostics through middleware without calling the default writer.
- Modify `src/client/connection-manager.ts` and `src/client/connection-manager.test.ts`: notify the arbiter when a connection becomes active or inactive.
- Modify `src/client/runtime.ts` and `src/client/runtime.test.ts`: connect LSP batches and state to the diagnostics unit.
- Modify `src/extension.ts` and `src/extension.test.ts`: create and dispose one shared collection and inject it into tasks and LSP runtime.

### Task 1: Parse captured lint JSON

**Files:**
- Create: `src/tasks/fixtures/lint-report.json`
- Create: `src/tasks/lint-report.test.ts`
- Create: `src/tasks/lint-report.ts`

- [ ] **Step 1: Add the captured fixture and failing parser tests**

Capture the real version 1 root and diagnostics fields, including one error and one warning on different `res://` files. Test this wished-for API:

```ts
const report = parseFoundryLintReport(fixture, "/workspace/game");
expect(report.diagnostics[0]).toEqual({
  filePath: "/workspace/game/tests/grammar/annotations.fs",
  range: {
    start: { line: 8, character: 0 },
    end: { line: 8, character: 16 },
  },
  severity: "error",
  source: "foundry_script",
  ruleId: "parse-error",
  message: expect.any(String),
});
```

Add separate cases for `note`, absolute and relative paths, unsupported versions,
malformed JSON, missing fields, unknown severity, nonpositive coordinates, and an
end before the start.

- [ ] **Step 2: Run the parser test and verify RED**

Run: `npm run test:unit -- src/tasks/lint-report.test.ts`

Expected: FAIL because `./lint-report.js` does not exist. Add an exported scaffold,
rerun, and confirm behavioral assertions fail for the missing conversion.

- [ ] **Step 3: Implement the strict parser minimally**

Export domain types, `LintReportError`, and:

```ts
export function parseFoundryLintReport(
  text: string,
  projectPath: string,
): FoundryLintReport;
```

Use `JSON.parse`, explicit type guards, `path.resolve`, and subtract one from every
validated line/column. Accept only version 1 and `error | warning | note`. Throw one
`LintReportError` for any malformed report; never return partial diagnostics.

- [ ] **Step 4: Run the parser test and verify GREEN**

Run: `npm run test:unit -- src/tasks/lint-report.test.ts`

Expected: all parser tests pass without invoking `foundry`.

- [ ] **Step 5: Commit the parser layer**

```bash
git add src/tasks/fixtures/lint-report.json src/tasks/lint-report.ts src/tasks/lint-report.test.ts
git commit -m "feat: parse Foundry lint JSON"
```

### Task 2: Publish per-file CLI diagnostics and clear reruns

**Files:**
- Create: `src/tasks/lint-diagnostics.test.ts`
- Create: `src/tasks/lint-diagnostics.ts`

- [ ] **Step 1: Write failing publisher tests**

Mock only VS Code value types (`Uri.file`, `Position`, `Range`, `Diagnostic`, and
`DiagnosticSeverity`) and use a real parsed fixture plus a fake `DiagnosticsUnit`.
Test that `beginRun(project)` returns a run accepting stdout and completion, and that:

```ts
run.appendStdout(fixture);
run.complete(1);
expect(unit.accept).toHaveBeenCalledWith({
  source: "cli",
  uri: expect.objectContaining({ fsPath: expect.stringContaining("annotations.fs") }),
  diagnostics: [expect.objectContaining({
    code: "parse-error",
    source: "foundry_script",
    severity: DiagnosticSeverity.Error,
  })],
});
```

Add cases for grouping multiple diagnostics per file, clearing prior URIs on a clean
exit 0 rerun, accepting warning/note severities, preserving prior state on exit 2 or
`undefined`, malformed JSON preserving state, and an older overlapping run being
ignored after a newer run starts.

- [ ] **Step 2: Run publisher tests and verify RED**

Run: `npm run test:unit -- src/tasks/lint-diagnostics.test.ts`

Expected: FAIL because `./lint-diagnostics.js` does not exist; after a scaffold,
behavioral tests fail with no accepted batches.

- [ ] **Step 3: Implement the stateful publisher minimally**

Export `FoundryLintDiagnosticsPublisher` and a run interface:

```ts
export interface FoundryLintRun {
  appendStdout(text: string): void;
  complete(exitCode: number | undefined): void;
}
```

Increment a generation in `beginRun`. On current-generation completion 0/1, parse,
convert to VS Code diagnostics, group by URI string, accept all current groups, send
empty batches for prior missing URIs, then replace remembered URIs. Other exit codes
do nothing. Let `LintReportError` reach the provider so it can report ingestion
failure without changing publisher state.

- [ ] **Step 4: Run publisher tests and verify GREEN**

Run: `npm run test:unit -- src/tasks/lint-diagnostics.test.ts`

Expected: all per-file, clearing, preservation, and ordering tests pass.

- [ ] **Step 5: Commit the publisher layer**

```bash
git add src/tasks/lint-diagnostics.ts src/tasks/lint-diagnostics.test.ts
git commit -m "feat: publish CLI lint diagnostics"
```

### Task 3: Capture lint stdout without changing task behavior

**Files:**
- Modify: `src/tasks/process.test.ts`
- Modify: `src/tasks/process.ts`
- Modify: `src/tasks/provider.test.ts`
- Modify: `src/tasks/provider.ts`

- [ ] **Step 1: Write a failing process stream-identity test**

Update the sink signature to the wished-for contract and assert interleaved events:

```ts
expect(sink.write.mock.calls).toEqual([
  ["stdout one\r\n", "stdout"],
  ["stderr one\r\n", "stderr"],
  ["stdout two\r\n", "stdout"],
]);
```

Keep every existing cancellation, spawn, exit, CRLF-boundary, and ordinary-output
assertion.

- [ ] **Step 2: Run process tests and verify RED**

Run: `npm run test:unit -- src/tasks/process.test.ts`

Expected: FAIL because current sink writes only the text argument.

- [ ] **Step 3: Label chunks minimally and verify GREEN**

Add `FoundryTaskProcessStream = "stdout" | "stderr"` and pass the corresponding
label from each existing stream listener. Do not change newline conversion, spawn
options, exit handling, timers, or kill signals.

Run: `npm run test:unit -- src/tasks/process.test.ts`

Expected: all process tests pass with identical joined terminal text.

- [ ] **Step 4: Write failing provider integration tests**

Inject a fake diagnostics unit, execute the lint task with a fake child, interleave
valid JSON stdout with stderr, and assert terminal writes preserve all chunks while
the diagnostics unit receives only parsed stdout after close 1. Add rerun-clear,
cancel, exit 2, malformed-output, and non-lint ordinary-output cases. Assert every
task still has `problemMatchers: []`.

- [ ] **Step 5: Run provider tests and verify RED**

Run: `npm run test:unit -- src/tasks/provider.test.ts`

Expected: lint produces no diagnostic batches and stderr cannot yet be excluded from
capture.

- [ ] **Step 6: Wire the publisher into the provider minimally**

Require a shared diagnostics unit in `FoundryTaskProvider`, create one
`FoundryLintDiagnosticsPublisher`, begin a run only for `kind === "lint"`, append only
stdout-labeled text, and call `complete` before terminal close. On `LintReportError`,
write/show `Could not ingest Foundry lint JSON: ...` and close nonzero. Preserve all
existing task error actions and process cancellation.

- [ ] **Step 7: Run provider and process tests and verify GREEN**

Run: `npm run test:unit -- src/tasks/provider.test.ts src/tasks/process.test.ts`

Expected: both suites pass, including cancellation and output-equivalence tests.

- [ ] **Step 8: Commit task integration**

```bash
git add src/tasks/process.ts src/tasks/process.test.ts src/tasks/provider.ts src/tasks/provider.test.ts
git commit -m "feat: ingest lint task output"
```

### Task 4: Route LSP diagnostics through the shared arbiter

**Files:**
- Modify: `src/client/language-client.test.ts`
- Modify: `src/client/language-client.ts`
- Modify: `src/client/connection-manager.test.ts`
- Modify: `src/client/connection-manager.ts`
- Modify: `src/client/runtime.test.ts`
- Modify: `src/client/runtime.ts`

- [ ] **Step 1: Write failing language-client middleware test**

Capture `clientOptions.middleware.handleDiagnostics`, pass a fake URI, diagnostic
array, and `next` spy, then assert `onDiagnostics` receives the values and `next` is
not called. This proves the default language-client collection cannot duplicate the
shared collection.

- [ ] **Step 2: Run language-client test and verify RED**

Run: `npm run test:unit -- src/client/language-client.test.ts`

Expected: FAIL because no diagnostic middleware or callback exists.

- [ ] **Step 3: Implement middleware and verify GREEN**

Add `onDiagnostics?: (uri, diagnostics) => void` to client options. Install
`middleware.handleDiagnostics` only when supplied, invoke the callback, and omit
`next` deliberately.

Run: `npm run test:unit -- src/client/language-client.test.ts`

Expected: middleware test and existing language-client tests pass.

- [ ] **Step 4: Write failing connection-state tests**

Inject `onConnectionStateChanged`, assert `[true, false]` across successful
start/stop, no `true` on failed startup, and `false` still occurs when client stop
rejects.

- [ ] **Step 5: Run connection-manager tests and verify RED**

Run: `npm run test:unit -- src/client/connection-manager.test.ts`

Expected: FAIL because state changes are not reported.

- [ ] **Step 6: Implement connection-state notifications minimally**

Add the optional callback to `ConnectionManagerOptions`, emit `true` only after the
active client is established, and emit `false` in shutdown cleanup whenever an
active client was removed. Do not alter connection modes or host ownership.

- [ ] **Step 7: Write and implement runtime wiring via RED/GREEN**

First extend `runtime.test.ts` to supply a fake `DiagnosticsUnit` and assert LSP
batches become `{source: "lsp", ...}` while connection-state callbacks call
`setLanguageServerConnected`. Run it to fail. Then require the unit in
`createConnectionManager`, pass `onDiagnostics` to each language client and the state
callback to the manager, and rerun to green.

Run: `npm run test:unit -- src/client/runtime.test.ts src/client/connection-manager.test.ts`

Expected: both suites pass.

- [ ] **Step 8: Commit LSP arbitration wiring**

```bash
git add src/client/language-client.ts src/client/language-client.test.ts src/client/connection-manager.ts src/client/connection-manager.test.ts src/client/runtime.ts src/client/runtime.test.ts
git commit -m "feat: arbitrate LSP diagnostics"
```

### Task 5: Own one diagnostics unit in extension activation

**Files:**
- Modify: `src/extension.test.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Write failing activation tests**

Mock `createDiagnosticsUnit` and assert activation creates it from exactly one
`languages.createDiagnosticCollection("foundryscript")`, registers it for disposal,
passes it to the task provider and connection runtime, and still does so when LSP
mode is off. Assert the manifest contains no `problemMatcher` or `problemMatchers`
keys.

- [ ] **Step 2: Run extension tests and verify RED**

Run: `npm run test:unit -- src/extension.test.ts`

Expected: FAIL because activation does not create or inject the diagnostics unit.

- [ ] **Step 3: Implement extension ownership minimally**

Create the unit before LSP early returns, push it to `context.subscriptions`, pass it
to `registerFoundryTaskProvider`, and pass it to `createConnectionManager`. Preserve
the existing output channel and startup error behavior.

- [ ] **Step 4: Run all focused tests and verify GREEN**

Run: `npm run test:unit -- src/tasks/lint-report.test.ts src/tasks/lint-diagnostics.test.ts src/tasks/process.test.ts src/tasks/provider.test.ts src/client/language-client.test.ts src/client/connection-manager.test.ts src/client/runtime.test.ts src/diagnostics/index.test.ts src/extension.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit activation wiring**

```bash
git add src/extension.ts src/extension.test.ts
git commit -m "feat: share diagnostics across tasks and LSP"
```

### Task 6: Verify, review, publish, and clean up

**Files:**
- Review all issue #13 changes.

- [ ] **Step 1: Run fresh publication verification**

Run each command and require exit 0:

```bash
npm test
npm run typecheck
npm run lint
npm run build
issue13_package_dir=$(mktemp -d)
npm run package -- --out "$issue13_package_dir/foundryscript-issue-13.vsix"
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Fetch and integrate current main**

Run `git fetch origin`. If `origin/main` advanced, rebase `issue-13`, resolve only
issue #13 overlaps, rerun the entire verification matrix, and commit any necessary
integration changes.

- [ ] **Step 3: Run read-only Cursor review to convergence**

Use the `cursor-review` skill against `origin/main`. Validate every finding with
`receiving-code-review`; use `systematic-debugging` plus a new failing test for real
bugs. Commit fixes and rerun full verification and Cursor until a valid
`RESULT: clean`. Do not waive review.

- [ ] **Step 4: Publish and monitor**

Push `issue-13`, open a ready PR to `main` whose body ends `Closes #13`, verify the
base and head match the reviewed commits, enable squash auto-merge, and watch all CI
checks. If main changes would enter the merge, disable auto-merge until the final
integrated HEAD is reverified and re-reviewed.

- [ ] **Step 5: Verify merge and clean exact resources**

After GitHub reports the PR merged, fetch and verify the squash commit on
`origin/main` and issue #13 closed. Remove only
`/Users/christian/.config/superpowers/worktrees/FoundryScript/issue-13`, then delete
the local and remote `issue-13` branches. Preserve `.claude/`, issue-9, and all other
worktrees.
