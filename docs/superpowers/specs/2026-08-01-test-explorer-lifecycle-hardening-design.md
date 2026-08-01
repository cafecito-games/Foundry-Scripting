# Test Explorer Lifecycle Hardening Design

**Date:** 2026-08-01

**Issue:** cafecito-games/Foundry-Scripting#21

**Parent:** cafecito-games/Foundry-Scripting#18

**Protocol authority:** Foundry Test Adapter Protocol v1 from Foundry#1428

## Goal

Make FoundryScript Test Explorer refresh, cancellation, failure reporting, and
shutdown visible, recoverable, race-safe, and isolated from every non-testing
extension subsystem.

This design builds on the negotiated adapter, discovery explorer, and streaming
TAP run profile delivered by issues #19, #20, and #22. It does not change the
protocol, introduce a Debug profile, or make FoundryLib a runtime dependency.

## User-visible contract

- The Test Explorer retains its last complete discovery tree until a newer
  complete discovery replaces it or testing is explicitly disabled.
- Explicit refresh begins immediately. Relevant workspace changes are
  coalesced into one refresh after 250 ms.
- Cancelling refresh or execution terminates only the adapter child owned by
  that operation. Completed, LF-flushed TAP points survive genuine user
  cancellation; every selected item without a complete point becomes skipped.
- An incomplete or malformed plan can never leave a successful run. Every
  infrastructure failure invalidates the entire selected plan, including
  points that were provisionally published as passing.
- Test status uses concise named states. The FoundryScript Testing output and
  TestRun output carry detailed classified diagnostics.
- Testing failures and testing shutdown never stop the LSP, clear diagnostics,
  or affect ordinary CLI tasks.

## Chosen architecture

Use a small refresh coordinator and strengthen the current runtime, process,
and executor ownership seams. This preserves the independently tested protocol
units and avoids coupling VS Code file-watcher behavior to generation and child
process state.

Two alternatives were rejected:

1. Embedding debounce, watcher filtering, generation changes, and cancellation
   directly in `extension.ts` and `runtime.ts` would reduce file count but make
   deterministic lifecycle testing brittle.
2. Replacing the testing stack with one general-purpose operation supervisor
   would unify lifecycle APIs at the cost of disproportionate churn across the
   verified issue #19/#20/#22 behavior.

## Refresh coordination

A pure `TestingRefreshCoordinator` owns only refresh scheduling policy. Timer
creation and cancellation are injected for fake-clock tests.

- `explicitRefresh(signal)` cancels a pending debounced refresh and invokes the
  runtime immediately with the caller's cancellation signal.
- `workspaceChanged(path)` schedules or resets a single 250 ms timer.
- `cancelPending()` invalidates the pending callback and clears its timer.
- Disposal is idempotent and permanently prevents new callbacks.

The extension watches create, change, and delete events in the active first
workspace for:

- `**/*.fs`; and
- `project.foundry`.

Paths with a relative component named `.git`, `.foundry`, `build`, or `dist`
are ignored. Paths under OS-temporary adapter directories whose basename begins
with `foundryscript-test-` are ignored as a defense in depth, even though normal
adapter artifacts are outside the workspace.

Testing disable, an active-workspace switch, and deactivation synchronously
cancel the pending timer. Configuration and workspace-folder changes continue
to reconfigure immediately rather than entering the debounce path.

## Runtime generations and retained discovery

The runtime remains the sole authority that may publish adapter state, discovery
models, and runnable ready context.

Every configure or refresh request receives a monotonically increasing
generation and its own abort controller. Installing a newer generation aborts
the older generation but does not wait for an abort-ignoring promise before the
new operation begins. All completion branches re-check that they are current
before they publish or mutate retained context.

The runtime separately tracks:

- the latest requested configuration and its stable key;
- the current generation;
- all outstanding operation promises for bounded shutdown; and
- the last complete ready context and the configuration key that produced it.

Configuration invalidation is synchronous. Before `configure()` yields or
starts asynchronous work, a changed configuration key invalidates runnable
ready context. This prevents a run request from observing a tree produced for
different engine, project, runner, arguments, or enabled state.

An explicit or workspace refresh with the same configuration keeps the last
ready context while the refresh is in progress. If that refresh fails or is
cancelled, the previous tree and ready context remain runnable. A successful
refresh atomically reconciles the model and installs the new ready context. A
failed changed-configuration operation may leave the old tree visible for
orientation but cannot make it runnable.

Cancellation classification depends on cause:

- a newer generation or shutdown makes the old completion inert;
- an explicit refresh token cancellation publishes `refresh_cancelled` only
  if that generation is still current; and
- process, parser, and timeout failures publish their classified failure only
  if current.

## Child process ownership and bounded shutdown

`FoundryTestAdapterProcess` remains dedicated to testing. It tracks every child
spawned by that instance and exposes an idempotent `stop()`.

- An operation abort sends `SIGTERM` only to that operation's child, escalates
  to `SIGKILL` after the existing 2-second grace, and resolves at the existing
  5-second hard shutdown deadline even if `close` never arrives.
- Process-wide testing stop aborts every child owned by that testing-process
  instance and waits only through the same hard deadline.
- LSP and task processes use separate owners and cannot be reached through this
  API.
- Child listeners, abort listeners, and timers are removed on the first
  terminal event. Late `close`, `error`, and timer callbacks are inert.

Runtime shutdown aborts all outstanding negotiation/discovery generations and
uses the same injected five-second lifecycle bound. Extension deactivation
awaits both runtime stop and testing-process stop. It never waits indefinitely
for an injected dependency that ignores abort.

An exit with `code === null` retains the termination signal in the process
result and is classified as `process_crash` when it was not extension-owned
cancellation. A nonzero process that produces no required artifact is also a
crash, not a legacy adapter. A capabilities command that exits successfully but
produces no capabilities artifact remains the actionable `legacy_runner`
unsupported-adapter case.

## Execution readiness and cancellation

The executor creates a run-local abort controller linked to the VS Code user
token. It passes only this controller to the owned child.

A first-report-byte readiness deadline begins when the run child starts. The
default is 30 seconds because no repository-wide readiness convention currently
exists; the deadline, monotonic clock, and polling wait are injected. The
deadline is disarmed as soon as any report byte is readable, so it does not cap
legitimate long-running tests.

When readiness expires, the executor marks timeout as the local cause, aborts
only the run child, performs the final read, and reports `readiness_timeout`.
If the user token was cancelled first, user cancellation wins even when the
deadline becomes observable in the same turn.

After process settlement the executor always performs a final artifact read to
close the tailing race. Parser completion receives cancelled context only for a
genuine user cancellation. A complete point is retained only after its closing
YAML delimiter and LF have been consumed. Partial UTF-8, partial lines, partial
points, and unsatisfied plan entries never become passing results.

The run profile appends a concise cancellation message, retains complete point
states, and marks every remaining selected item skipped. Any non-user
cancellation, timeout, crash, malformed TAP, bailout, exit mismatch, unknown
test ID, or other infrastructure failure appends classified diagnostics and
marks every selected item errored.

## Failure taxonomy and presentation

Stable failure kinds distinguish at least:

| Condition | Classification | Concise status |
| --- | --- | --- |
| successful command without capabilities | `legacy_runner` | Unsupported |
| no common protocol version | `incompatible_adapter` | Version mismatch |
| represented discovery records | ready with error count | Discovery warnings |
| invalid or incomplete JSONL | `malformed_discovery` / `incomplete_discovery` | Discovery failed |
| malformed or incomplete TAP | `malformed_report` / `incomplete_report` | Run errored |
| terminal TAP bailout | bailout completion | Run bailed out |
| abnormal child termination | `process_crash` | Process crashed |
| no first report byte in 30 seconds | `readiness_timeout` | Timed out |
| current explicit refresh cancellation | `refresh_cancelled` state | Refresh cancelled |
| current test-run token cancellation | cancelled completion | Remaining tests skipped |

Discovery diagnostics identify the one-based JSONL record. TAP diagnostics
identify the one-based report line or test point wherever the parser has that
context. Detailed output includes the stable kind or parser code, lifecycle
phase, exit code or signal when available, and captured stdout/stderr without
mixing application output into protocol artifacts.

Only actionable configuration and compatibility failures show a dialog:
missing/invalid engine, project, or runner; unsupported adapter; and version
mismatch. Dialogs are deduplicated by a stable failure fingerprint within the
current configuration epoch. Operational refresh and run failures use status,
Test Explorer, TestRun output, and the testing output channel, preventing popup
loops during file-change refresh bursts.

## Temporary artifacts

Capabilities, discovery, and execution retain one exact directory owner each.
The owner removes that exact directory recursively in `finally` after success,
failure, cancellation, timeout, crash, and stale completion. Cleanup failure is
a secondary output diagnostic and never replaces the primary result.

No artifact path is created inside the workspace. No broad path, glob, or
unresolved environment variable is ever passed to removal.

## Verification strategy

Implementation follows strict layered RED-to-GREEN TDD:

1. refresh coordinator fake-clock tests for burst coalescing, explicit-refresh
   precedence, relevance filtering, disable/workspace-switch cancellation, and
   disposal;
2. runtime deferred-promise tests for immediate synchronous invalidation,
   same-configuration retention, cancelled refresh retention, stale success,
   stale failure, stale cancellation, and bounded stop;
3. fake-child process tests for operation-local termination, concurrent owned
   children, TERM/KILL/deadline escalation, crash signals, late events, and
   idempotent stop;
4. executor fake-clock tests for first-byte readiness, timeout/user-cancel
   precedence, final-read races, complete cancellation prefixes, malformed
   points, bailouts, crashes, and cleanup after every outcome;
5. profile tests for a cancellation diagnostic, retention of complete points,
   consistent skipped remainder, and full-plan invalidation for every
   non-user-cancellation failure;
6. status and extension integration tests for named states, detailed output,
   actionable-dialog deduplication, watcher lifecycle, bounded deactivation,
   and unchanged LSP/diagnostics/tasks behavior; and
7. the complete unit, typecheck, lint, grammar, and build gates.

The final integration gate uses pinned FoundryLib commit
`6df2b4d7ff43c013a4c9e9033c01cdadbdeda19a` through the production
negotiation, discovery, execution, cancellation, and cleanup paths with a
verified Foundry binary containing Foundry#1428. Temporary external checkouts
are never modified or published and are removed after the merged PR is
verified.

## Deferred work

No Test Explorer Debug profile is added. It remains blocked on Foundry#1427's
runner-debug DAP contract.
