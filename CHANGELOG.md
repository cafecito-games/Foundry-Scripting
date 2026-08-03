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
- A required real-engine DAP conformance CI job pinned to the verified engine commit.

### Fixed

- Activate the extension before VS Code requests initial FoundryScript debug
  configurations or resolves a FoundryScript debug session.

### Compatibility and release gate

- Debugger validation uses Foundry commit
  `a2d9f6df06fb545c8106f24c7445466d6355085b`
  (`0.1.dev.custom_build.a2d9f6df0`).
- No published engine release contains the required fixes yet.
  `v0.1.0-alpha.20` predates them and is not debugger-compatible.
- Replace the pending compatibility note with the first containing engine release
  before publishing this extension release.

### Pre-release validation finding

- A normally stopped or naturally completed session currently raises a false
  `connection closed` adapter-failure notification after the DAP lease is released.
  The debuggee does stop, and an external tooling host remains alive, but release
  validation is not clean until the pending sibling runtime fix is integrated and the
  matrix is rerun. This is not an accepted release limitation.
- Selected-test debugging is a later integration phase; this release covers scene
  debugging only.
