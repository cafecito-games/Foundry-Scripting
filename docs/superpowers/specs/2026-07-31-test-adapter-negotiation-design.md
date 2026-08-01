# Foundry Test Adapter Negotiation Design

**Status:** Approved implementation specification

**Date:** 2026-07-31

**Issue:** [cafecito-games/Foundry-Scripting#19](https://github.com/cafecito-games/Foundry-Scripting/issues/19)

## Summary

The extension will configure and negotiate a framework-neutral Foundry Test Adapter Protocol implementation without yet creating VS Code Test Explorer items. A dedicated testing unit will build the exact capabilities command, own the adapter subprocess and temporary artifact, validate the complete capabilities document, select the highest mutually supported protocol version, and expose framework metadata through testing status.

This lifecycle remains independent from the existing human-facing Foundry task provider, language client, diagnostics arbitration, and future Test Explorer presentation. Disabling testing cancels only an adapter negotiation, removes testing status, and leaves ordinary tasks and LSP behavior unchanged.

## Settings and Compatibility

The extension contributes these settings:

- `foundryScript.testing.enabled`: boolean, default `false`.
- `foundryScript.testing.runner`: string, default empty. The value must be a canonical, non-root `res://` resource path.
- `foundryScript.testing.args`: array of strings, default empty. These are opaque framework arguments.

The existing `foundryScript.test.runner` setting and ordinary `Foundry: Test` task remain unchanged. That task is the human-facing command surface locked by epic #18 and does not start, stop, or depend on adapter negotiation.

Adapter negotiation reuses the existing `foundryScript.enginePath` setting and the first open workspace folder as the project path, matching the project and engine resolution established by issue #8.

## Architecture

The new `src/testing/` unit has five focused boundaries:

1. `command.ts` validates configuration and constructs the exact capabilities command. It has no process or VS Code dependencies.
2. `capabilities.ts` decodes and validates one capabilities artifact and negotiates a supported version. It has no process or filesystem dependencies.
3. `process.ts` owns one child process, captures stdout and stderr separately for diagnostics, responds to cancellation, and reports process lifecycle outcomes. It does not interpret protocol artifacts.
4. `adapter.ts` creates a unique OS-temporary directory, invokes the process, reads and validates the artifact, classifies failures, and removes the directory in `finally`. It exposes an operation handle with bounded cancellation.
5. `status.ts` renders disabled, negotiating, ready, and error states. Ready status includes negotiated protocol and framework ID, name, and version. Error status exposes a concise actionable diagnostic.

`runtime.ts` coordinates configuration generations. It starts negotiation only while testing is enabled, makes stale completions inert, and owns disable/deactivation shutdown. `extension.ts` adapts VS Code settings, workspace, output, status bar, and configuration events to that runtime.

No `vscode.tests` API, test controller, discovery parser, TAP parser, or run profile is introduced in this issue.

## Command Contract

The command is constructed as an argument array with `shell: false`:

```text
<engine> --headless --no-header project test
  --project <project>
  --runner <runner> --
  adapter capabilities --output <absolute-temporary-file>
  [-- <testing.args>...]
```

The first `--` after the runner belongs to Foundry and begins runner arguments. The second `--` appears only when `testing.args` is non-empty; it belongs to the adapter and places every configured argument outside reserved adapter options. Argument spelling, order, empty strings, and option-looking values are preserved exactly.

The temporary output path is absolute and its parent already exists. The path is unique for every operation and never points inside the workspace.

## Capabilities Validation and Negotiation

The client supports protocol versions `[1]`. Validation follows Foundry's normative protocol v1 contract completely for the capabilities operation:

- bytes are valid UTF-8 without a byte-order mark;
- the document ends in LF, contains no CRLF, and contains exactly one JSON value;
- the top-level value is an object;
- `protocol` is exactly `"foundry-test-adapter"`;
- `supported_versions` is a non-empty, strictly ascending array of unique positive integers;
- `framework` is an object with non-empty, control-free string `id`, `name`, and `version` fields;
- `extensions` is an array of unique, non-empty, control-free strings;
- all required fields are present with their exact JSON types.

Unknown additive top-level fields, framework fields, and extension names are accepted. They do not alter core v1 meaning. The parsed result records framework metadata and the advertised extensions for status and future diagnostics.

After structural and semantic validation, the negotiator chooses the numerically highest version present in both the adapter list and client list. An empty intersection is an incompatible-adapter failure rather than malformed JSON.

## Failure Model

`TestAdapterFailure` uses stable kinds and setting references so UI and later Test Explorer code can remain presentation-only:

- `missing_runner`: the runner setting is empty; opens `foundryScript.testing.runner`.
- `invalid_runner`: the runner is not a canonical non-root `res://` resource; opens `foundryScript.testing.runner`.
- `missing_project`: no workspace project is open; offers Open Folder.
- `missing_engine`: the engine setting is empty or process creation reports an executable/path error; opens `foundryScript.enginePath`.
- `malformed_capabilities`: an artifact exists but violates encoding, line-ending, JSON, structure, or semantic rules.
- `incompatible_adapter`: a valid document has no client-supported protocol version.
- `process_failed`: a valid capabilities artifact exists but the child exits nonzero.
- `legacy_runner`: no capabilities artifact exists after the child completes, regardless of its exit code. The message explains that the configured runner does not implement Foundry Test Adapter Protocol capabilities.
- `spawn_failed`: the engine process could not start for another reason.
- `read_failed`: the artifact exists but cannot be read.
- `cancelled`: internal control flow only; it is never presented as an adapter error.

Artifact validity takes precedence over process exit, as required by the protocol. A malformed artifact remains unsupported even when the child exits zero. A valid artifact with a nonzero exit is a process lifecycle violation. Captured stdout and stderr are diagnostic context only and are never parsed as protocol data.

## Lifecycle, Cancellation, and Generation Safety

Each settings generation owns at most one operation. Starting a newer generation first invalidates the prior generation, then cancels it. Completion handlers compare their generation token before publishing status, framework metadata, or errors, so a stale success or failure is inert.

Cancellation sends `SIGTERM`, waits a short bounded grace interval, then sends `SIGKILL` if the child remains alive. The operation resolves only after the child closes or the bounded shutdown deadline expires. Cleanup always runs in `finally`, using recursive removal only on the exact directory returned by `mkdtemp`.

Disabling testing or deactivating the extension invalidates the current generation immediately, hides and disposes testing status, and awaits bounded operation shutdown. It does not dispose task providers, the shared diagnostics collection, or the LSP manager.

Configuration changes to `testing.enabled`, `testing.runner`, `testing.args`, or `enginePath`, and changes to the first workspace project, begin a new negotiation generation when enabled. Repeated unchanged settings do not restart an operation.

## Status and Diagnostics

Testing status is lazy: it is not shown while testing is disabled. The enabled states are:

- negotiating: spinner text and the configured runner in the tooltip;
- ready: framework name in text; tooltip includes framework ID, framework version, negotiated protocol version, and extensions;
- error: warning text and the actionable failure message in the tooltip.

The testing output channel records process stdout/stderr and structured lifecycle messages. Ready and failure records include available framework metadata and protocol version. User-facing error actions open the relevant setting or workspace folder only for configuration failures; protocol/process failures offer the testing output channel. No Problems diagnostics are emitted because capabilities negotiation has no source file or range.

## Testing Strategy

Every production behavior is implemented through strict RED→GREEN TDD.

Unit tests use framework-neutral synthetic fixtures for minimal, additive, multi-version, malformed, incompatible, and invalid-semantic documents. Command tests prove both separators, exact argument order, and opaque argument preservation. Process and adapter tests use controlled child-process doubles and real temporary filesystem operations to prove stdout/stderr isolation, exit precedence, cancellation, uniqueness, generation guards, and unconditional cleanup. Extension tests prove settings registration, enable/disable behavior, status removal, and non-interference with tasks and LSP.

The real-process gate uses isolated temporary checkouts:

- Foundry at `af7af3946a9c554b6f35285ee59b8411b5c3f4d0`, which contains Foundry #1428.
- FoundryLib at merge `6df2b4d7ff43c013a4c9e9033c01cdadbdeda19a`, which contains the reference adapter.

An exact-commit Foundry binary invokes the FoundryLib runner through the same negotiated command. The gate verifies exit zero, framework `foundrylib-testlib`, version `1.0.0`, negotiated protocol `1`, output isolation, and removal of every temporary artifact. These external repositories are never modified or published; builds and checkouts live only under temporary directories.

## Publication Gates

Before publication, the branch must pass focused testing tests, `npm test`, typecheck, lint, build, VSIX packaging, and `git diff --check`. All intended changes are committed and reviewed read-only by Cursor against current `origin/main`. Any main advance is rebased, fully reverified, and re-reviewed before auto-merge is enabled.
