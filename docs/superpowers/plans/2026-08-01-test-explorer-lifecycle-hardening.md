# Test Explorer Lifecycle Hardening Implementation Plan

> Execute this plan in the isolated `issue-21` worktree. Preserve strict
> RED-to-GREEN evidence for each behavior group and do not weaken existing
> issue #19/#20/#22 protocol assertions.

**Goal:** Make Test Explorer refresh, cancellation, failures, cleanup, and
deactivation visible, recoverable, non-destructive, and race-safe.

**Architecture:** A deterministic refresh coordinator drives a generation-safe
runtime. The dedicated testing process tracks only its own children, the
executor owns readiness and user-cancellation precedence, and presentation maps
classified failures into concise status plus detailed output without popup
loops.

**Stack:** TypeScript, VS Code Extension API, Node child processes/filesystem,
Vitest fake timers and process fakes, ESLint, esbuild, Foundry Test Adapter
Protocol v1, live pinned FoundryLib.

---

## Task 1: Deterministic Refresh Coordination

**Files:**

- Create `src/testing/refresh.ts`
- Create `src/testing/refresh.test.ts`

### Step 1: Write failing relevance-filter tests

Specify an exported pure predicate that receives active-project and changed
native paths. Assert it accepts project-local `.fs` creates/changes/deletes and
the root `project.foundry`, rejects paths outside the active project, rejects
non-Foundry files, and rejects any relative component equal to `.git`,
`.foundry`, `build`, or `dist`. Assert adapter temporary directory basenames
beginning `foundryscript-test-` are rejected.

Run:

```bash
npx vitest run src/testing/refresh.test.ts
```

Expected: RED because the refresh module does not exist.

### Step 2: Implement the pure relevance predicate

Use `path.relative` and component equality rather than substring matching. Do
not resolve or mutate filesystem paths.

Run the focused test and require GREEN.

### Step 3: Write failing fake-clock coordinator tests

With `vi.useFakeTimers()`, assert:

- multiple relevant events inside 250 ms produce exactly one refresh;
- the last event resets the full debounce window;
- irrelevant events schedule nothing;
- explicit refresh cancels pending debounce and starts immediately;
- `cancelPending()` invalidates even a captured late timer callback;
- disposal is idempotent and permanently inert; and
- a rejected scheduled refresh is routed to an injected error observer without
  an unhandled rejection.

Run the focused suite and retain the RED output.

### Step 4: Implement `TestingRefreshCoordinator`

Inject schedule/cancel operations and the refresh callback. Use a generation or
identity guard in addition to clearing the timer so late callbacks are inert.
Return the explicit refresh promise to the caller.

Run:

```bash
npx vitest run src/testing/refresh.test.ts
npx tsc --noEmit
```

Expected: GREEN.

### Step 5: Commit the refresh unit

```bash
git add src/testing/refresh.ts src/testing/refresh.test.ts
git commit -m "feat: coordinate test explorer refreshes"
```

## Task 2: Generation-Safe Runtime and Cancellation

**Files:**

- Modify `src/testing/runtime.ts`
- Modify `src/testing/runtime.test.ts`
- Modify `src/testing/status.ts`
- Modify `src/testing/status.test.ts`

### Step 1: Write failing synchronous-invalidation tests

After a successful ready generation, invoke changed `configure()` without
awaiting it and immediately assert `readyContext()` is undefined. Cover engine,
project, runner, arguments, and disable changes. Assert unchanged explicit
refresh keeps the old ready context during negotiation/discovery.

Run:

```bash
npx vitest run src/testing/runtime.test.ts
```

Expected: RED because refresh currently clears ready context and changed
configuration invalidation is not independently specified.

### Step 2: Write failing overlapping-generation tests

Use deferred promises that ignore abort. Assert a second configure/refresh
starts without waiting for the first; stale success, failure, and abort publish
nothing; only the latest success reconciles; and a same-configuration failed
refresh retains its prior tree and ready context.

Add an explicit `refresh(signal)` cancellation case. Assert the discovery
signal aborts, the last tree/context survive, and current state becomes
`refresh_cancelled`. Assert a superseded abort never publishes cancellation.

Retain RED output.

### Step 3: Implement runtime lifecycle changes

Track outstanding operations in a set. On every request:

1. synchronously store configuration and compare its key;
2. synchronously invalidate ready context when the key changed;
3. increment generation and abort the prior current controller;
4. start the new operation without awaiting the old promise; and
5. guard every state/context/model mutation with current-generation checks.

Link an optional external refresh signal with a disposable listener. Preserve
same-key ready context through refresh. Add `refresh_cancelled` to
`TestingState` with retained-adapter metadata when available.

### Step 4: Write failing bounded-stop tests

Inject lifecycle scheduling and use fake time. Make negotiate/discover ignore
abort forever. Assert idempotent `stop()` aborts every outstanding generation,
publishes disabled once, and resolves at five seconds without late publication.

### Step 5: Implement bounded runtime stop

Use the repository testing lifecycle default of five seconds. Inject the wait
for deterministic tests. Stop must not reject because an operation rejects
after invalidation.

### Step 6: Add concise cancelled/error status cases

Specify `Refresh cancelled`, `Unsupported`, `Version mismatch`, `Discovery
failed`, `Process crashed`, and `Timed out` text. Retain exact actionable
tooltips and existing ready metadata/error counts.

Run:

```bash
npx vitest run src/testing/runtime.test.ts src/testing/status.test.ts
npx tsc --noEmit
```

Expected: GREEN.

### Step 7: Commit runtime lifecycle

```bash
git add src/testing/runtime.ts src/testing/runtime.test.ts src/testing/status.ts src/testing/status.test.ts
git commit -m "feat: make test discovery generations recoverable"
```

## Task 3: Dedicated Process Ownership and Crash Semantics

**Files:**

- Modify `src/testing/process.ts`
- Modify `src/testing/process.test.ts`

### Step 1: Write failing concurrent-child ownership tests

Create two fake children and independent abort signals. Assert aborting the
first sends TERM/KILL only to the first, while the second continues and
completes normally. Assert captured stdout/stderr remain operation-local.

### Step 2: Write failing process-wide stop tests

Assert `stop()`:

- terminates every child spawned by this process owner;
- uses TERM, the injected two-second grace, then KILL;
- resolves at the injected five-second hard deadline if close never arrives;
- is idempotent;
- prevents future spawns by returning cancellation; and
- ignores late close/error/timer events after settlement.

### Step 3: Write failing crash-result tests

Emit `close(null, "SIGSEGV")` without cancellation. Require an exited result
that retains `signal: "SIGSEGV"` and no invented numeric success. Confirm an
owned cancellation with null code remains `cancelled`.

Run:

```bash
npx vitest run src/testing/process.test.ts
```

Expected: RED because the owner does not track active children, expose stop, or
retain close signals.

### Step 4: Implement active process records and stop

Give each `run()` a private abort controller linked to its caller and the
process owner. Store only the record needed to abort and await settlement.
Remove it in `finally`. Preserve one terminal settlement and current listener
cleanup behavior.

Run:

```bash
npx vitest run src/testing/process.test.ts
npx tsc --noEmit
```

Expected: GREEN.

### Step 5: Commit process ownership

```bash
git add src/testing/process.ts src/testing/process.test.ts
git commit -m "feat: supervise owned test adapter processes"
```

## Task 4: Lifecycle Failure Classification and Artifact Cleanup

**Files:**

- Modify `src/testing/adapter.ts`
- Modify `src/testing/adapter.test.ts`
- Modify `src/testing/discoverer.ts`
- Modify `src/testing/discoverer.test.ts`
- Modify `src/testing/executor.ts`
- Modify `src/testing/executor.test.ts`

### Step 1: Write failing crash-precedence tests

For capabilities, discovery, and execution, assert abnormal termination or a
nonzero process with no required artifact becomes `process_crash`, preserving
stdout, stderr, signal, and phase. A successful capabilities process with no
artifact remains `legacy_runner`. An ordinary unreadable present artifact
remains the relevant read failure.

### Step 2: Write failing exact-cleanup matrices

For each owner, parameterize success, parser failure, process failure/crash,
read failure, cancellation, and thrown dependency. Assert the exact directory
returned by `makeTemporaryDirectory` is passed once to removal. Assert cleanup
failure invokes diagnostics and does not replace the primary result.

Run:

```bash
npx vitest run src/testing/adapter.test.ts src/testing/discoverer.test.ts src/testing/executor.test.ts
```

Expected: crash classification cases RED; existing cleanup cases remain GREEN.

### Step 3: Implement stable process failure details

Add `process_crash` to `TestAdapterFailureKind` and structured optional
`phase`, `exitCode`, and `signal` fields. Centralize only small repeated
classification helpers; do not collapse protocol-specific read/parse behavior.

Read required artifacts before interpreting a normal nonzero exit so represented
discovery errors and test failures remain valid. Apply crash precedence only
when termination was abnormal or the required artifact is absent after an
abnormal/nonzero exit.

Run the focused suites and require GREEN.

### Step 4: Commit taxonomy and cleanup coverage

```bash
git add src/testing/adapter.ts src/testing/adapter.test.ts src/testing/discoverer.ts src/testing/discoverer.test.ts src/testing/executor.ts src/testing/executor.test.ts
git commit -m "feat: classify test adapter lifecycle failures"
```

## Task 5: First-Report Readiness and Cancellation Precedence

**Files:**

- Modify `src/testing/executor.ts`
- Modify `src/testing/executor.test.ts`

### Step 1: Write failing first-byte fake-clock tests

Inject `now`, polling, and `readinessTimeoutMs`. Assert:

- no readable report byte for 30 seconds aborts only the local child and throws
  `readiness_timeout` after process settlement;
- any first byte disarms readiness permanently;
- a long test after first byte is not timed out;
- user cancellation before the deadline wins classification;
- user cancellation becoming visible in the same polling turn wins; and
- timeout cannot abort another concurrent execution.

### Step 2: Write failing parser outcome tests

Assert malformed TAP includes one-based line/test-point context, bailout stays
distinct, an unsatisfied plan is incomplete and invalid, and a final-read byte
arriving with process close is consumed before completion.

Run:

```bash
npx vitest run src/testing/executor.test.ts src/testing/report.test.ts
```

Expected: readiness tests RED; parser contract tests GREEN unless a diagnostic
context gap is exposed.

### Step 3: Implement linked local execution control

Create a run-local controller linked to the caller. Track cause as user,
readiness timeout, or none. Check user signal before choosing timeout in every
race. Start process and poll concurrently, marking readiness after a nonempty
artifact read. On timeout, abort local controller, await bounded process result,
perform final read, then throw classified timeout. Dispose every link.

### Step 4: Close any parser diagnostic gap through TDD

If the focused RED identifies missing line/point context, add the smallest
parser state needed to report it without changing fixture validity.

Run:

```bash
npx vitest run src/testing/executor.test.ts src/testing/report.test.ts
npx tsc --noEmit
```

Expected: GREEN.

### Step 5: Commit readiness lifecycle

```bash
git add src/testing/executor.ts src/testing/executor.test.ts src/testing/report.ts src/testing/report.test.ts
git commit -m "feat: bound test report readiness"
```

## Task 6: Consistent Run Cancellation and Detailed Diagnostics

**Files:**

- Modify `src/testing/profile.ts`
- Modify `src/testing/profile.test.ts`

### Step 1: Write failing cancellation-state tests

Assert genuine cancellation:

- retains passed, failed, errored, and explicitly skipped complete points;
- marks every selected item without a complete point skipped exactly once;
- appends a concise user-cancellation line; and
- ends exactly once.

Assert malformed cancellation, readiness timeout, crash, bailout, malformed
point, incomplete plan, and thrown executor dependency all error the complete
selected plan, including any provisionally passed point.

### Step 2: Write failing classified-output tests

Require run output to include stable failure kind or TAP diagnostic code and
the available line/test-point context, without duplicating the
`Foundry test infrastructure failed` prefix.

Run:

```bash
npx vitest run src/testing/profile.test.ts
```

Expected: RED for cancellation output and structured thrown failures.

### Step 3: Implement terminal state reconciliation

Track completed point IDs independently of their VS Code terminal state. On
genuine user cancellation, skip only the remainder. On every other invalid
outcome, error all selected items. Format `TestAdapterFailure` fields and TAP
completion diagnostics in one detailed message.

Run:

```bash
npx vitest run src/testing/profile.test.ts src/testing/executor.test.ts src/testing/report.test.ts
npx tsc --noEmit
```

Expected: GREEN.

### Step 4: Commit run reconciliation

```bash
git add src/testing/profile.ts src/testing/profile.test.ts
git commit -m "feat: reconcile cancelled test runs consistently"
```

## Task 7: Extension Watchers, Presentation, and Isolation

**Files:**

- Modify `src/extension.ts`
- Modify `src/extension.test.ts`
- Modify VS Code fakes in the existing extension test as needed

### Step 1: Write failing watcher lifecycle integration tests

Extend the VS Code mock with file-system watcher factories and emitters. Assert:

- exactly the `.fs` and `project.foundry` watchers are created for the active
  first workspace when testing is enabled;
- create/change/delete events enter the 250 ms coordinator;
- filtered/generated/outside paths do nothing;
- bursts coalesce once;
- explicit refresh cancels the pending debounce and links token cancellation;
- disable, workspace switch, disposal, and deactivation synchronously cancel
  the timer and dispose old watchers; and
- re-enable/new workspace creates fresh watchers without duplicates.

### Step 2: Write failing popup and detailed-output tests

Assert configuration, legacy, and version failures show one actionable prompt
per stable fingerprint/configuration epoch. Repeated malformed discovery,
process crash, and readiness timeout states show no popup. Require output to
include kind, phase, exit/signal, stdout, and stderr when present.

### Step 3: Write failing deactivation and isolation tests

Assert deactivation awaits idempotent runtime and testing-process stops exactly
once. Simulate testing refresh/run failures and verify no LSP stop/reconnect,
diagnostic clear, or task-provider change. Assert no Debug profile is created.

Run:

```bash
npx vitest run src/extension.test.ts
```

Expected: RED because watchers, refresh coordination, process stop, and prompt
deduplication are not wired.

### Step 4: Implement production extension wiring

Create/dispose watchers as the active project and enabled flag change. Bridge
the VS Code refresh token to an `AbortController`. Instantiate one refresh
coordinator and one dedicated testing process. On state changes, always update
status and detailed output; invoke the deduplicated actionable presenter only
for configured categories. Keep testing subscriptions independent from LSP,
diagnostics, and tasks.

Run:

```bash
npx vitest run src/extension.test.ts src/testing/refresh.test.ts src/testing/runtime.test.ts src/testing/status.test.ts
npx tsc --noEmit
npm run lint
```

Expected: GREEN.

### Step 5: Commit extension integration

```bash
git add src/extension.ts src/extension.test.ts
git commit -m "feat: harden test explorer lifecycle integration"
```

## Task 8: Full Verification and Live FoundryLib Lifecycle Gate

**Files:**

- Modify `scripts/verify-foundry-test-run.mjs` only if the approved lifecycle
  assertions require a backward-compatible verifier extension
- Modify tests/production only through a new RED regression if live evidence
  exposes a defect

### Step 1: Run the complete repository gates

```bash
npm test
npm run test:grammar
npx tsc --noEmit
npm run lint
npm run build
git diff --check origin/main...HEAD
git status --short
```

Expected: every command succeeds; only intended issue files differ.

### Step 2: Verify fixture coverage and protocol invariants

Run all normative capabilities, discovery JSONL, and TAP fixture suites. Confirm
malformed record/test-point diagnostics identify their location, cancellation
keeps only complete points, and unsatisfied plans never classify successful.

### Step 3: Locate or build a verified Foundry binary

Use an existing binary only after proving its embedded revision contains
Foundry#1428. Otherwise create a clean task-specific temporary Foundry checkout
at the already verified #1428 commit and build only the needed macOS target.
Never modify another repository checkout.

### Step 4: Run pinned FoundryLib end to end

Use a clean temporary checkout of FoundryLib
`6df2b4d7ff43c013a4c9e9033c01cdadbdeda19a`. Through production code verify:

- capabilities negotiation and cleanup;
- complete discovery and cleanup;
- streaming execution with an observable complete point before exit;
- user cancellation after at least one complete point, owned-child termination,
  retained prefix, skipped remainder, and cleanup; and
- a subsequent refresh/run succeeds, proving recovery and absence of stale
  overwrite.

Record exact Foundry/FoundryLib revisions and command evidence for the PR body.

### Step 5: Re-run full verification after live evidence

If the live gate exposes a defect, first add a failing deterministic regression,
then fix and repeat Tasks 8.1-8.4. Do not proceed with a failing or flaky gate.

### Step 6: Commit live verifier changes, if any

```bash
git add scripts/verify-foundry-test-run.mjs
git commit -m "test: verify test explorer lifecycle live"
```

Skip the commit when the existing verifier and temporary harness suffice.

## Task 9: Independent Review, PR, Merge, and Cleanup

### Step 1: Sync base before review

Fetch `origin/main`. If it advanced, merge it into `issue-21`, resolve only
issue-scoped conflicts, rerun all gates and the live lifecycle gate, and commit
the integration.

### Step 2: Run exact Cursor review

Follow the cursor-review skill exactly against `origin/main`. Store the full
review output outside the repository. Treat actionable findings through the
receiving-code-review workflow: verify each technically, add a RED regression
where applicable, fix, rerun full verification, commit, and repeat Cursor
review on the changed HEAD. Continue until the exact reviewed HEAD has a clean
verdict.

### Step 3: Open a ready PR

Push `issue-21` and open a non-draft PR to `main`. The body must summarize
refresh/race ownership, cancellation/result semantics, failure taxonomy,
cleanup/bounded deactivation, deterministic verification, exact live revisions,
and Cursor verdict. End the body with exactly:

```text
Closes #21
```

### Step 4: Protect reviewed HEAD and merge

Require the remote PR head to equal the clean-reviewed SHA. Enable squash
auto-merge only for that HEAD. Monitor every Actions check and review until the
PR is merged. Any changed HEAD requires full verification, live gate as
relevant, and a fresh clean Cursor verdict before auto-merge is re-enabled.

### Step 5: Verify closure and clean task-owned state

Require GitHub PR state `MERGED`, issue #21 closed, and the squash commit present
on `origin/main`. Update the primary `main` checkout only if safe and without
touching unrelated user changes. Remove only the merged `issue-21` worktree,
local/remote issue branch, external review output, and task-specific temporary
Foundry/FoundryLib checkouts. Confirm unrelated worktrees and repositories are
unchanged.
