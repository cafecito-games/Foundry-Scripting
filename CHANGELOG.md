# Changelog

All notable changes to the FoundryScript VS Code extension are documented here.

## Unreleased

### Added

- Scene debugging for a project's main scene or an explicit `res://.../*.tscn` scene.
- Source line breakpoints, stack frames, Locals/Members/Globals inspection, Watch and
  Debug Console evaluation, pause/continue, step over/in/out, restart, and stop.
- Run Without Debugging and string play arguments.
- Owned and external combined-tooling-host workflows, with a single debug session per
  VS Code window and actionable startup errors.
- Test Explorer debugging for selected tests and suites, including exclusions,
  cancellation, restart, and projects without a configured main scene.
- A required real-engine DAP conformance CI job that verifies and runs the
  published alpha.24 Linux release asset.
- The alpha.24 release TextMate grammar as the offline syntax-highlighting fallback.

### Fixed

- Activate the extension before VS Code requests initial FoundryScript debug
  configurations or resolves a FoundryScript debug session.
- Suppress the expected late transport-close callback after a session has already
  stopped or exited, while continuing to report genuine adapter transport failures.

### Compatibility

- Scene and selected-test debugging require Foundry `v0.1.0-alpha.24` or later.
  `v0.1.0-alpha.24` is the first verified compatible release and resolves to commit
  `e91ab07e63ce0a783778dc885bb11d9c65603256`, including the natural-exit lifecycle
  fix from Foundry #1634.
- `v0.1.0-alpha.23` and earlier prereleases predate at least one required debugger
  lifecycle fix and are not declared compatible.

### Initial limitations

- Debugging is loopback-only and permits one scene or selected-test debug session per
  VS Code window.
- DAP `attach`, concurrent sessions, remote devices, conditional breakpoints, hit
  counts, logpoints, and editing variable values are not supported.
