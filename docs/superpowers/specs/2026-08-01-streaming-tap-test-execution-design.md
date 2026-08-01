# Streaming TAP Test Execution Design

**Status:** Approved implementation design

**Date:** 2026-08-01

**Issue:** [cafecito-games/Foundry-Scripting#22](https://github.com/cafecito-games/Foundry-Scripting/issues/22)

**Protocol authority:** Foundry Test Adapter Protocol v1 from Foundry merge commit `af7af3946a9c554b6f35285ee59b8411b5c3f4d0`

## Summary

FoundryScript will add exactly one default VS Code Run profile to the test hierarchy delivered by issues #19 and #20. A request is reduced to an ordered set of runnable discovered leaves, invoked through the negotiated Foundry Test Adapter Protocol version, and projected from a unique external streaming TAP13 report into VS Code test states.

The report consumer is an incremental strict-profile parser rather than a general TAP parser. It publishes a result only after the complete point and diagnostic mapping have been flushed through `  ...\n`, routes solely by `_foundry.id`, and validates the complete artifact/process lifecycle before ending the run. Genuine user cancellation preserves completed streamed results. Every other protocol or lifecycle inconsistency visibly errors the entire selected plan so no early pass remains falsely successful.

The implementation stays framework-neutral. FoundryLib commit `6df2b4d7ff43c013a4c9e9033c01cdadbdeda19a` is a real integration gate, not a runtime dependency.

## Goals

- Register one default `TestRunProfileKind.Run` profile and no Debug profile.
- Translate VS Code include and exclude requests into exact runnable leaf IDs in authoritative discovery order.
- Invoke `adapter run` with the negotiated version, a unique absolute report path, repeatable leaf selections, and opaque framework arguments after the adapter separator.
- Enqueue then start every selected leaf and stream complete flushed report points before process exit.
- Validate every structural, metadata, selection, ordering, lifecycle, exit, and cancellation rule in Foundry Test Adapter Protocol v1.
- Map pass, assertion failure, skip, discovery error, runtime error, timeout, abort, and setup error to the correct VS Code result state.
- Preserve duration, failure text, and one-based source navigation while ignoring TAP display labels for identity.
- Append application stdout and stderr to test output without ever parsing either stream as protocol data.
- Surface infrastructure failures and prevent valid-looking early points from remaining false successes.
- Verify every normative report fixture, focused synthetic streaming cases, and a live pinned FoundryLib run through a verified Foundry binary containing #1428.

## Non-goals

- No Debug profile or DAP runner contract.
- No file watching, continuous runs, refresh policy changes, automatic rediscovery, or broad concurrent-run lifecycle hardening from issue #21.
- No changes to ordinary human-facing Foundry tasks or `foundryScript.test.runner`.
- No parsing of FoundryLib ID, label, suite, or framework-argument conventions.
- No runtime invocation of Foundry's Python validator and no shipped Foundry or FoundryLib source.
- No general TAP13 compatibility beyond the strict Foundry v1 profile.

## Chosen Approach

The extension will use three focused pure or narrowly stateful units:

1. a discovery-order selection planner;
2. a byte-incremental Foundry TAP13 state machine; and
3. a run coordinator that owns the child, report tail, VS Code projection, cancellation, and cleanup.

The TAP structure is hand-written because Foundry v1 intentionally rejects many constructs that a general TAP library accepts: late plans, TODO, pragmas, nested TAP, unrelated top-level content, omitted YAML, non-contiguous points, and flexible directives. Diagnostic bodies use the maintained `yaml` package in strict mode because the protocol explicitly permits additive safe YAML mappings and a hand-written YAML subset would silently narrow the normative format.

Buffering the whole report after process exit is rejected because it cannot publish streaming results. Executing the Python conformance validator is rejected because normal extension users cannot be required to install Python, `uv`, PyYAML, or Foundry source, and a subprocess validator cannot naturally drive per-point early events.

## Selection Model

The explorer will retain its authoritative discovery model and expose a snapshot that pairs each adapter record with its current `TestItem`. Selection is computed entirely from this snapshot; IDs stay opaque.

The planner walks discovered test records in their original order. With `include === undefined`, the candidate set is every runnable test leaf. Otherwise each included runnable test contributes itself and each included suite contributes every runnable descendant test. Discovery-error records and non-runnable tests never contribute a leaf. Repeated items, overlapping suites, and suite-plus-child requests deduplicate by leaf ID.

Exclusions apply after inclusions. Excluding a test removes that leaf. Excluding a suite removes every descendant leaf, including nested descendants. Excluding an error or non-runnable item has no executable effect. The final plan is always the discovery-order filter of the chosen ID set.

The extension passes every final leaf explicitly as `--select <id>`. It does not pass suite IDs, derive IDs from labels, or rely on framework expansion after applying VS Code exclusions. A zero-leaf plan creates and ends a local TestRun without spawning an adapter process.

## Command Construction

The pure command builder accepts validated engine, project, runner, framework arguments, negotiated protocol version, absolute report path, and ordered leaf IDs. It constructs exactly:

```text
<engine> --headless --no-header project test
  --project <project>
  --runner <runner> --
  adapter run
  --protocol-version <version>
  --report <absolute-report>
  [--select <leaf-id>]...
  [-- <framework-args>...]
```

The protocol version must be the positive integer negotiated for the authoritative discovery. `--select` is repeatable and preserves plan order. The adapter-level separator appears only when framework arguments exist, and every argument after it is copied exactly, including reserved-looking values.

Each run creates its own OS-temporary directory and report filename outside the workspace. The caller never trusts a pre-existing artifact, and cleanup removes only that exact directory in `finally`. Cleanup failure is logged without replacing the primary run result.

## Strict Incremental TAP13 Parser

The parser consumes `Uint8Array` chunks and maintains a `TextDecoder("utf-8", { fatal: true })` across chunk boundaries. It rejects a UTF-8 byte-order mark and carriage returns, retains incomplete byte/code-point and line suffixes between pushes, and validates the decoder's final flush. Normal completion requires a terminal LF. This prevents a split multi-byte scalar from being rejected or corrupted and prevents a truncated final scalar from being accepted.

The line state machine accepts only:

```text
TAP version 13
# foundry-test-adapter: 1
1..N
<point>
  ---
  <two-space-indented YAML body>
  ...
```

It enforces the exact version and adapter comment, a leading plan with at most nine digits, `1..0` for an empty run, contiguous point numbers beginning at one, no points beyond the plan, a non-empty control-free label that cannot contain directive syntax, and only `# SKIP <non-empty reason>` on an `ok` point. A point becomes observable only when its explicitly opened, exactly two-space TAP-indented YAML block reaches `  ...\n`.

The strict YAML parse requires mapping top level and mapping `_foundry`. Every point requires a non-empty control-free string `_foundry.id`, non-boolean non-negative integer `duration_ms`, and `status_detail` from `""`, `discovery_error`, `runtime_error`, `timed_out`, `aborted`, or `setup_error`. Non-empty detail requires `not ok`; pass and skip require empty detail; every `not ok` requires a non-empty string `message`. Optional `at` must be a mapping with a canonical `res://` file and positive one-based integer line and column. Unknown additive YAML keys are ignored.

As each complete point arrives, the parser also checks that its ID is unique, equals the planned leaf ID at that point number, and has the discovered skip state and exact reason. This makes a complete flushed point safe to publish before process exit. The point label is retained only for diagnostics and never participates in lookup.

## Streaming and Process Lifecycle

The coordinator creates the VS Code TestRun before asynchronous execution, enqueues every planned leaf, then marks each leaf started in plan order. It starts the shell-free owned Foundry child and polls the unique report artifact while the child is alive. Each read verifies that the already-consumed byte prefix is unchanged and feeds only newly appended bytes to the parser. A missing artifact while the child is alive is allowed; after child completion it is an infrastructure failure.

After the process settles, the coordinator performs a final read before finalizing the parser. This closes the race between the final child write and the close event. It then reconciles:

- a satisfied all-pass-or-skip plan requires exit `0`;
- a satisfied plan containing any `not ok` requires exit `1`;
- a conforming bailout before plan satisfaction requires exit `2`;
- a missing, malformed, truncated, unsatisfied, invalidly trailed, or exit-inconsistent report is infrastructure failure; and
- a bailout after a satisfied plan or any content after bailout is invalid.

The parser allows a bailout before a plan only after the exact first two preamble lines and allows one bailout after an unsatisfied plan. A bailout requires a non-empty message and is terminal.

Stdout and stderr are appended as raw application output to the existing FoundryScript Testing output channel and to `TestRun.appendOutput`, with LF converted to VS Code's required CRLF. Neither stream is passed to the TAP parser.

## Cancellation

The profile bridges the VS Code cancellation token to one run-owned `AbortController`. Cancellation terminates and reaps the owned child using the existing bounded SIGTERM/SIGKILL process policy.

For cancellation only, the parser validates the longest completed protocol prefix. Bytes after the final LF and a trailing point/YAML candidate without `  ...\n` are discarded. Missing or empty output, a complete version line, a complete version-plus-comment preamble, or an unsatisfied-plan prefix containing zero or more valid complete points is a valid cancellation. A completed malformed unit, bailout, satisfied plan, or supplied child exit is not a valid cancellation.

Completed valid points already published before genuine cancellation remain unchanged. Planned leaves without a complete point are marked skipped, and the run ends. Cancellation never fabricates pass or failure results.

## VS Code Result Projection

All lookups use `_foundry.id` against the selected-plan map. Display labels may collide freely.

| Protocol point | VS Code state |
| --- | --- |
| `ok` without directive | `passed(test, duration_ms)` |
| `ok ... # SKIP reason` | `skipped(test)` |
| `not ok`, empty detail | `failed(test, message, duration_ms)` |
| `not ok`, `discovery_error` | `errored(test, message, duration_ms)` |
| `not ok`, `runtime_error` | `errored(test, message, duration_ms)` |
| `not ok`, `timed_out` | `errored(test, message, duration_ms)` |
| `not ok`, `aborted` | `errored(test, message, duration_ms)` |
| `not ok`, `setup_error` | `errored(test, message, duration_ms)` |

`failed` means the test executed and violated an assertion; `errored` means the leaf could not complete normal test execution. When `at` exists, the extension resolves its canonical `res://` path against the project and creates a `TestMessage.location` at zero-based `lineNumber - 1`, `columnNumber - 1`. The original message is preserved and status detail is rendered into useful context.

For every non-cancellation protocol, artifact, process, or lifecycle inconsistency, the coordinator appends a visible infrastructure diagnostic and calls `errored` for every selected leaf, including any leaf previously reported passed. This deliberately invalidates early results so a malformed or exit-inconsistent run cannot leave false passes. It then ends exactly once.

## Ready Context and Extension Integration

The testing runtime will retain an immutable ready context only after negotiation and authoritative discovery complete for the same generation. The context contains the exact configuration, negotiated adapter metadata, project, and discovery model used by the explorer. Starting a new generation clears run readiness until a new authoritative result succeeds, while the last-known-good tree may remain visible according to issue #20.

Activation creates the single default Run profile alongside the existing controller. Its handler always creates one TestRun for the request, obtains the current ready context and explorer snapshot, computes the plan, and delegates execution. If testing is not ready, it reports a visible infrastructure error and ends without a process. Profile disposal follows controller disposal through extension subscriptions. No Debug profile is created.

## Error Presentation

Parser and run failures use classified `TestAdapterFailure` kinds for malformed/incomplete reports, selection mismatch, lifecycle/exit inconsistency, missing/unreadable artifacts, and process startup. They are written to TestRun output and the testing log. Run-scoped failures do not replace the negotiated/discovery status or erase the explorer; issue #21 owns broader status and rediscovery policy.

Cleanup failures remain secondary diagnostics. A cancellation is internal control flow and does not show an infrastructure dialog.

## Testing Strategy

Development follows strict RED → GREEN TDD in layers:

1. exact run command grammar, repeatable selections, negotiated version, and framework separator;
2. pure include/exclude selection over nested suites, overlap, repeats, errors, non-runnable leaves, and discovery order;
3. incremental UTF-8 and exact preamble/plan/point/YAML parsing, including split scalars and final decoder flush;
4. all normative Foundry v1 report fixtures copied byte-for-byte from `af7af3946a9c554b6f35285ee59b8411b5c3f4d0` with their manifest lifecycle context;
5. point projection for every status detail, durations, colliding labels, exact ID routing, messages, and source locations;
6. report tailing before process exit, stdout/stderr isolation, final-read race closure, artifact mutation, bailout, exit reconciliation, cancellation prefixes, and exact cleanup;
7. extension integration for exactly one default Run profile, no Debug profile, ready-context capture, zero-plan handling, cancellation bridge, and unchanged refresh/tasks/LSP behavior; and
8. a live production-path run using pinned FoundryLib `6df2b4d7ff43c013a4c9e9033c01cdadbdeda19a` and a verified Foundry binary that contains Foundry #1428.

The normative fixture test derives report entries from the copied immutable manifest and asserts the consumer's conformance decision, completeness, and classification where they affect execution. Synthetic tests add streaming timing and VS Code behavior that artifact-only fixtures cannot express.

## Publication Gates

Before publication:

- run every focused selection, parser, runner, process, explorer, runtime, and extension test;
- run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run package`;
- run the live pinned FoundryLib streaming gate and prove a point is observable before the child exits;
- compare copied fixtures byte-for-byte with Foundry `af7af3946a9c554b6f35285ee59b8411b5c3f4d0`;
- fetch and integrate current `origin/main`, then repeat verification if it advanced;
- run Cursor's exact read-only review wrapper against `origin/main` until `RESULT: clean`; and
- push only the clean-reviewed head, open a ready PR whose body ends exactly `Closes #22`, enable squash auto-merge only after the final clean result, monitor all checks through actual merge, and remove only issue #22's branch, worktree, and task-specific temporary artifacts.
