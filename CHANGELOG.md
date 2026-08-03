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
- A required real-engine DAP conformance CI job pinned to the verified engine commit.

### Fixed

- Activate the extension before VS Code requests initial FoundryScript debug
  configurations or resolves a FoundryScript debug session.
- Suppress the expected late transport-close callback after a session has already
  stopped or exited, while continuing to report genuine adapter transport failures.

### Compatibility

- Foundry `v0.1.0-alpha.21` is the current debugger release candidate and resolves to
  commit `c11e3a080959af4ca8fbdd9b1a3d97a889b351b4`. The first compatible release
  declaration remains blocked on the Linux structured-test restart lifecycle fix in
  Foundry #1634 and a green pinned-engine conformance run.
- `v0.1.0-alpha.20` and earlier prereleases predate the required debugger fixes and
  are not compatible.

### Initial limitations

- Debugging is loopback-only and permits one scene or selected-test debug session per
  VS Code window.
- DAP `attach`, concurrent sessions, remote devices, conditional breakpoints, hit
  counts, logpoints, and editing variable values are not supported.
