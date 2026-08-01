# Foundry Test Discovery and Test Explorer Design

**Status:** Approved implementation design

**Date:** 2026-07-31

**Issue:** [cafecito-games/Foundry-Scripting#20](https://github.com/cafecito-games/Foundry-Scripting/issues/20)

**Protocol authority:** Foundry Test Adapter Protocol v1 from Foundry#1428

## Summary

FoundryScript will extend the independent testing lifecycle added by issue #19 from capability negotiation into protocol-v1 discovery. After negotiating a mutually supported adapter version, the extension will invoke the adapter's exact discovery operation, validate the complete JSONL artifact, and reconcile one VS Code `TestController` hierarchy from authoritative adapter IDs.

Discovery artifacts remain outside the workspace. A complete valid discovery is authoritative, including an empty discovery that removes every prior item. Invalid, truncated, cancelled, or exit-inconsistent operations never mutate the last-known-good Test Explorer tree. A complete discovery containing recoverable `discovery_error` records remains authoritative and visible, and requires process exit `1`.

The design remains framework-neutral. FoundryLib is a reference integration gate, not a runtime dependency or a source of identity conventions.

## Goals

- Invoke `adapter discover` with the negotiated protocol version and opaque framework arguments.
- Strictly validate all Foundry Test Adapter Protocol v1 discovery record and stream rules.
- Project valid suites, tests, and recoverable discovery errors into one stable hierarchical `TestController`.
- Preserve `TestItem` object identity for unchanged authoritative IDs so editor selection and persisted state survive refreshes.
- Reconcile additions, removals, label changes, ranges, skip state, and reparenting deterministically.
- Resolve canonical `res://` paths against the configured project and pass zero-based UTF-16 ranges directly to VS Code.
- Preserve runnable, skipped, skip reason, and parameterized `case_key` metadata for issue #22 without implementing execution.
- Retain the last-known-good tree when discovery is not a complete, valid, exit-consistent operation.
- Cover every normative Foundry v1 discovery fixture plus framework-neutral reconciliation cases and a real FoundryLib discovery.

## Non-goals

- No run profile, adapter `run` invocation, TAP parsing, or result projection; those belong to issue #22.
- No file watchers, continuous discovery, broad lifecycle hardening, or reconnect policy; those belong to issue #21.
- No human task changes. `foundryScript.test.runner` and ordinary Foundry tasks remain independent.
- No framework-specific parsing of FoundryLib IDs, labels, case keys, or arguments.
- No protocol diagnostics in the Problems collection because temporary artifact lines do not map to workspace source ranges.
- No runtime dependency on Foundry's Python conformance validator, schemas, or a Foundry source checkout.

## Chosen Approach

The extension will use a hand-written strict TypeScript parser plus a small protocol-neutral reconciler. JSON Schema alone cannot express ordering, parent, duplicate-ID, count, skip inheritance, completeness, or process-exit rules, so adding Ajv would still leave most of the implementation manual while increasing the shipped dependency surface. Calling Foundry's Python validator would make the extension depend on tools that normal users do not have.

The normative fixture bytes will be copied from immutable Foundry commit `bd801d667e9c6118fc4617cc53dc0e08175adeaa`. Those fixtures prove the consumer stays aligned with the schema and cross-record prose without shipping a validator subprocess.

## Architecture

### Discovery command construction

A new pure command builder will accept the same engine, project, runner, and opaque framework arguments as capability negotiation, plus the negotiated positive protocol version and an absolute output path. It will construct exactly:

```text
<engine> --headless --no-header project test
  --project <project>
  --runner <runner> --
  adapter discover
  --protocol-version <version>
  --output <absolute-file>
  [-- <framework-args>...]
```

The adapter-level `--` appears only when framework arguments are non-empty. Existing configuration validation remains the authority for engine, project, runner, and argument shape. Discovery additionally rejects a non-positive or non-integer negotiated version as an internal configuration failure.

### Discovery model and parser

The parser accepts bytes, not stdout or stderr, and returns one immutable model:

```text
DiscoveryModel
├── root: canonical res:// path
├── items: ordered suite | test | discovery_error records
├── suiteCount
├── testCount
└── errorCount
```

Each item retains its authoritative ID, label, parent ID, optional canonical resource path, optional zero-based UTF-16 range, and event-specific metadata. Tests also retain `caseKey`; suites and tests retain runnable/skip fields; discovery errors retain their message. Unknown additive fields are ignored.

Parsing is strict and complete:

- decode fatal UTF-8; reject a byte-order mark;
- require LF line endings, a terminal LF, no carriage returns, and no blank lines;
- parse exactly one JSON object per line;
- require `protocol: "foundry-test-adapter"`, `version: 1`, and a recognized event on every record;
- validate every required event field and JSON type;
- validate non-empty control-free strings, canonical `res://` paths, nullable field presence, range structure and ordering, runnable/skip consistency, and non-empty case keys;
- require exactly one `discovery_start` first and exactly one `discovery_end` last;
- require global ID uniqueness across suites, tests, and errors;
- require a non-null parent to identify a previously emitted suite;
- require runnable tests beneath a skipped suite ancestor to carry explicit skipped state and reason;
- reject records after the final event and unknown events; and
- require final suite, test, and error counts to match the accepted records.

The parser stops the consumer operation on the first violation and reports an artifact-focused error with the record number when applicable. It does not salvage a malformed stream into a partial model.

### Discovery process and artifact ownership

A `FoundryTestAdapterDiscoverer` will remain separate from capability negotiation and Test Explorer presentation. It will reuse issue #19's shell-free owned process implementation through dependency injection, create a unique OS-temporary directory, pass an artifact path inside it, read only that file after process exit, and remove the exact directory in `finally`.

Artifact validity takes precedence over process exit. A valid complete stream has exactly two valid exit combinations:

| Discovery artifact | Required process exit | Result |
| --- | ---: | --- |
| `error_count == 0` | `0` | authoritative discovery |
| `error_count > 0` | `1` | authoritative discovery with visible recoverable errors |

A valid artifact with any other exit is exit-inconsistent and is not published. A missing, unreadable, malformed, truncated, cancelled, or exit-inconsistent operation throws a classified testing failure and retains the prior tree. Stdout and stderr remain diagnostic output only. Cleanup failures are logged without replacing the primary result, matching issue #19.

### Testing runtime pipeline

`TestingRuntime` will evolve from one operation into a sequential generation-owned pipeline:

```text
configuration → capabilities negotiation → discovery → authoritative publish
```

The negotiated `protocolVersion` is passed unchanged into discovery. A generation may publish a tree only after both operations complete and it is still current. Configuration changes, disabling, refresh replacement, and deactivation continue to abort the owned process through issue #19's bounded cancellation.

The runtime stores the latest configuration and exposes one explicit `refresh()` entry point for VS Code's refresh button. Refresh forces a new negotiation and discovery even when configuration is unchanged. It does not add watchers or execution lifecycle behavior.

State rules are:

- disabling publishes `disabled`, cancels the current generation, and explicitly clears the Test Explorer;
- negotiating and discovering update testing status but do not clear the prior tree;
- a valid complete discovery publishes its model, including a zero-item model that authoritatively clears the prior tree;
- a valid discovery with represented errors publishes valid items and error records together;
- invalid, truncated, cancelled, stale, or exit-inconsistent discovery never calls the authoritative publish callback; and
- deactivation stops the runtime and disposes the single controller through extension subscriptions.

### Stable Test Explorer reconciliation

Activation creates exactly one controller with stable controller ID `foundryScript.tests`. Protocol records become items directly under the controller or their authoritative suite parent; the extension will not invent a framework or root `TestItem` with a derived ID.

The reconciler owns:

- a global `Map<adapterId, TestItem>`;
- a matching metadata map containing event kind, parent ID, resource path, runnable, skipped, skip reason, and case key;
- prior discovery order for deterministic detach and removal; and
- factories that convert native paths and ranges into VS Code values while keeping the reconciliation algorithm unit-testable.

For each authoritative model, reconciliation proceeds in phases:

1. Compute IDs that disappeared, changed immutable kind/path, or changed parent collection.
2. Detach affected prior items child-first from their old collections.
3. Remove absent items and recreate only items whose immutable URI or semantic kind changed.
4. Walk the new parent-before-child order, reusing all other `TestItem` objects by ID.
5. Update mutable label, range, error, description, sort order, and retained metadata.
6. Add each item to the controller root or its already-created suite parent.

Unchanged records retain the same object. Rename and range changes mutate in place. Reparenting detaches and re-adds the same object. Additions and removals follow artifact order. If the same ID changes event kind or native URI, VS Code's immutable item fields require recreation; this does not weaken the unchanged-item guarantee.

`sortText` records zero-padded discovery order so presentation is deterministic without using labels as identity. Parameter rows with identical labels remain distinct because their adapter IDs differ, and their opaque case keys remain metadata only.

### Paths, ranges, runnable state, and errors

A non-null canonical `res://path` resolves to `path.join(project, resourcePathAfterPrefix)` and becomes `vscode.Uri.file(...)`. The parser has already rejected traversal, empty segments, backslashes, and dot segments.

Protocol positions are already zero-based UTF-16 code units and end-exclusive, exactly matching `vscode.Range`. The extension constructs the range with the four integers unchanged. It must not inspect file text or convert Unicode scalar offsets; the astral fixture proves direct transport.

Runnable and parameter metadata are retained for issue #22. Until execution exists, skipped items display a concise skipped description, non-runnable items display a non-runnable description, and otherwise no derived execution semantics are added.

Every `discovery_error` is a normal authoritative-ID `TestItem` in its declared parent collection. Its `error` property contains the protocol message, and its optional URI/range remain navigable. A successful model with errors therefore replaces the prior tree while showing errors beside valid suites and tests.

### Extension integration

The existing independent testing registration will create and subscribe the controller and reconciler, inject discovery into the runtime, and connect the runtime's authoritative callback to reconciliation. The controller's `refreshHandler` awaits `runtime.refresh()` and avoids starting work when its cancellation token is already cancelled. Mid-refresh cancellation expansion is deferred to issue #21; configuration, disable, and deactivation cancellation remain bounded.

No run profile is registered. Ordinary tasks and every LSP activation/early-return path remain unchanged.

## Error Presentation

Protocol and process failures use the existing testing output channel and unavailable status path. Messages distinguish malformed/incomplete discovery, missing or unreadable artifacts, process startup, and exit inconsistency. The last-known-good Test Explorer stays present during these errors so a broken refresh does not erase useful navigation.

Recoverable `discovery_error` records are not operation failures. They produce visible Test Explorer error items, a ready status that includes the discovery error count, and testing-log context. They do not trigger the generic unavailable dialog.

## Testing Strategy

Development follows strict RED → GREEN TDD in layers:

1. command construction and exact separators/version transport;
2. parser structure and semantic validation against all 31 normative Foundry discovery fixtures copied byte-for-byte from `bd801d667`;
3. framework-neutral fixtures for nested suites, nullable locations, U+2028/U+2029 strings, and additive metadata;
4. temp artifact/process orchestration, exit matrix, stdout/stderr isolation, cancellation, and cleanup;
5. pure reconciliation for identity retention, selection proxy identity, add/remove/rename/reparent, authoritative empty replacement, path/range projection, astral offsets, colliding labels, skipped/runnable metadata, and visible errors;
6. generation-safe negotiate-then-discover runtime behavior, forced refresh, stale suppression, last-known-good retention, disable clearing, and stop idempotence;
7. extension integration for exactly one controller, refresh wiring, disposal, configuration independence, and unchanged tasks/LSP; and
8. a real production-pipeline gate using FoundryLib commit `6df2b4d7ff43c013a4c9e9033c01cdadbdeda19a` and a verified Foundry binary containing #1428.

The real gate uses a temporary clean FoundryLib checkout, the production command/process/parser path, and a unique OS-temporary artifact. It verifies navigable suite/test records, distinct parameterized IDs despite colliding labels, valid ranges, negotiated protocol 1, expected exit behavior, and complete cleanup. The Foundry and FoundryLib repositories are never modified or published.

## Publication Gates

Before publication:

- run every focused discovery and extension test;
- run `npm test`, typecheck, lint, build, and VSIX packaging;
- run the real FoundryLib discovery gate;
- fetch and integrate current `origin/main`, then repeat verification if it advanced;
- run Cursor's exact read-only review wrapper against `origin/main` until `RESULT: clean`; and
- push only the clean-reviewed head, open a ready PR ending `Closes #20`, monitor every CI check through squash merge, and remove only issue #20's branch, worktree, and task-specific temporary artifacts.

