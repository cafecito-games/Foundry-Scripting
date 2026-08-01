# Workspace Project Resolution Design

**Date:** 2026-08-01

**Related engine issue:** cafecito-games/Foundry#1502

## Goal

Let the FoundryScript extension operate from repository-wrapper workspaces whose
single Foundry project lives below the workspace root, while preserving a
deterministic single-project model for the language server, tasks, and Test
Explorer.

The extension must validate the selected project before starting Foundry. It
must never pass a directory without a direct `project.foundry` child to an LSP,
task, or testing command.

## User-visible contract

The extension adds `foundryScript.projectPath`, an optional string identifying
the Foundry project directory.

- An absolute configured path is used directly.
- A relative configured path is resolved from the first VS Code workspace
  folder.
- The configured directory must contain `project.foundry` directly.
- An empty setting enables automatic resolution.

Automatic resolution follows this order:

1. If the first workspace folder contains `project.foundry`, use that folder.
2. Otherwise search below that folder for `project.foundry` files.
3. If exactly one nested manifest exists, use its parent directory.
4. If no manifest exists, report that no Foundry project was found.
5. If multiple nested manifests exist, list their workspace-relative paths and
   require `foundryScript.projectPath`.

This feature continues to select one project for the extension. It does not run
one language server per workspace folder or switch projects based on the active
editor.

## Chosen architecture

Add a project-resolution module outside `client/`, `tasks/`, and `testing/`.
The module owns project selection only and has no knowledge of LSP transport,
task commands, or the test adapter.

The module exposes an asynchronous resolver returning either a native project
directory or a typed failure. Its filesystem and workspace operations are
injected so selection policy is covered by ordinary Vitest tests without a
VS Code host.

Every subsystem calls this same resolver at the point where it needs a project:

- extension activation resolves before spawning or attaching the LSP;
- a Foundry task resolves before building its command; and
- testing resolves before constructing a testing runtime configuration.

Resolving at the consumer boundary avoids an activation-time error for users
who only want grammar support with LSP and testing disabled. It also lets tasks
and testing observe a changed `foundryScript.projectPath` without maintaining a
second project-selection implementation.

Two alternatives were rejected:

1. Requiring `foundryScript.projectPath` for every nested project is simpler but
   adds unnecessary configuration for the common single-project wrapper repo.
2. Selecting the project nearest the active `.fs` file supports multiple
   simultaneous projects but makes task and testing behavior dependent on
   editor focus and conflicts with the extension's single-LSP architecture.

## Resolution boundaries

The VS Code adapter supplies:

- the first workspace folder path;
- the current `foundryScript.projectPath` value;
- direct-manifest existence checks; and
- nested manifest discovery scoped to that workspace folder.

Nested discovery excludes `.git`, `.foundry`, `node_modules`, `build`, `dist`,
and extension-owned temporary output. Results are normalized, deduplicated, and
sorted before ambiguity reporting so messages and tests are stable across
platforms.

Configured paths are normalized before validation. Absolute configured paths
may be outside the workspace because the user selected them explicitly.
Automatic discovery never escapes the first workspace folder.

The resolver produces stable failure kinds for:

| Condition | Failure kind | Action |
| --- | --- | --- |
| no workspace folder | `missing_workspace` | ask the user to open a folder |
| configured directory has no manifest | `invalid_configured_project` | open project-path settings |
| automatic search finds no manifest | `project_not_found` | explain the expected manifest |
| automatic search finds multiple manifests | `ambiguous_projects` | list candidates and open settings |

Expected resolution failures are values rather than untyped exceptions.
Unexpected filesystem failures retain their original cause and identify the
path or search operation that failed.

## Subsystem integration

### Language server

Resolve the project before creating the connection manager. Spawn and auto mode
must not start Foundry after a resolution failure. Attach mode still resolves
the local project because workspace-mismatch handling and document roots need
the selected directory. Off mode does not resolve or display a project error.

Resolution failures are written to the FoundryScript LSP output channel. Missing
workspace and missing-project failures are shown directly; invalid or ambiguous
configuration offers an **Open Settings** action for
`foundryScript.projectPath`.

### Tasks

The task pseudoterminal resolves asynchronously when opened, then builds the
existing command with the selected project as both `--project` and working
directory. A resolution failure writes one terminal error, presents the same
actionable setting option where applicable, exits with status 1, and never
constructs a Foundry child process.

### Test Explorer

Testing configuration resolves the project before negotiation or discovery.
Project-resolution failures enter the existing testing configuration-failure
path, preserve its dialog deduplication behavior, and never start a test adapter
process. Changes to `foundryScript.projectPath`, workspace folders, or
`project.foundry` files trigger the existing testing reconfiguration and refresh
flow.

All watchers and native-path calculations use the resolved project directory,
so `res://` paths continue to map to the actual Foundry project rather than the
repository wrapper.

## Configuration documentation

`package.json` contributes `foundryScript.projectPath` with an empty default.
Its description states the automatic-selection order and that relative paths
are resolved from the first workspace folder.

The README documents:

- the zero-configuration root and single-nested-project cases;
- a `FoundryObservability` example using `"test_project"`;
- the requirement to configure the setting when multiple projects exist; and
- that this release supports one active Foundry project per VS Code window.

## Verification strategy

Implementation follows RED-to-GREEN TDD in layers:

1. pure resolver tests for absolute and relative configuration, root priority,
   one nested project, no project, stable multiple-project reporting,
   deduplication, and filesystem failures;
2. extension tests proving LSP off mode skips resolution, spawn/auto/attach use
   the resolved directory, and failures prevent connection-manager startup;
3. task-provider tests proving resolution precedes command construction and
   failures never spawn a child;
4. testing lifecycle tests proving the resolved directory reaches negotiation,
   discovery, watchers, and native-path mapping, with existing failure-dialog
   deduplication retained;
5. manifest and README assertions for the new setting; and
6. the repository's complete `npm ci`, build, typecheck, lint, unit, and grammar
   verification gates.

A manual Extension Development Host check opens `FoundryObservability` at its
repository root and confirms that the LSP becomes ready for
`FoundryObservability/test_project` without a workspace-layout workaround.

## Deferred work

True multi-project windows, one LSP per workspace folder, active-file project
switching, and a project-selection picker are outside this change. They require
a broader connection-manager and subsystem-ownership design.
