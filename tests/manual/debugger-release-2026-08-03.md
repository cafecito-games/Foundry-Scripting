# Debugger release validation — 2026-08-03

This is the published-engine release record for issue #50. It complements the required
automated DAP conformance suite and records the remaining hands-on Extension Development
Host gate without treating terminal automation as a substitute.

## Environment and release provenance

- Extension branch: `run-epics/44-50-debugger-release`
- Base revision integrated: `0a87ab60eaefabbe3fbdab3a7ebf6ee90dcd3674`
- VS Code available for the hands-on run: 1.131.0
  (`e4c7e7b1d6d060162f4aa7f8225271b67ce1df75`), Apple Silicon
- macOS: 26.5.2 (25F84), arm64
- Foundry release: `v0.1.0-alpha.21`, published 2026-08-03T01:07:12Z
- Annotated tag object: `b994cfe5b7b7bdd2060b95a1f332b65196c518c8`
- Tag commit: `c11e3a080959af4ca8fbdd9b1a3d97a889b351b4`
- Required native-fix ancestor:
  `a2d9f6df06fb545c8106f24c7445466d6355085b` (tag commit is four commits ahead)
- Published asset: `Foundry_v0.1.0-alpha.21_macos.universal.zip`
- Asset SHA-256: `1d40930d86c9faab7c492ae300508df5ec78dbe8ea68af1307008be104487bf1`
- Binary identity: `0.1.alpha21.gh.c11e3a080`

GitHub release metadata and the downloaded asset digest agree. No local development
build was substituted for the published binary.

## Automated verification

The following commands completed successfully in the issue worktree:

- `npm ci`
- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npm test`: 771 tests passed, 6 opt-in live-process tests skipped by the normal unit
  invocation, and all grammar scope assertions passed.
- `npm run package`: the VSIX packaged successfully.
- `FOUNDRY_ENGINE_PATH=<published-alpha.21-binary> npm run test:dap-conformance`:
  both required live tests passed with no skips:
  - the scene DAP breakpoint, inspection, evaluation, stepping, restart, pause,
    cancellation, and sequential-lifecycle matrix;
  - the structured selected-test DAP matrix, including one/many/failing/unknown
    selections, unsupported protocol rejection, breakpoint inspection, Watch/hover/REPL
    evaluation, restart, cancellation, and a project without `run/main_scene`.

The conformance runner verifies that the binary reports pinned commit `c11e3a080` before
starting either live suite, and hard-fails when the engine path is absent or mismatched.

## Extension Development Host matrix

The hands-on VS Code matrix is still required before this record can declare the release
ready. It must use the exact published binary above and cover:

- F5 main scene and an explicit scene;
- a line breakpoint, stack frames, variables, Watch, and Debug Console evaluation;
- pause, continue, step over, step into, and step out;
- restart, stop, and Run Without Debugging;
- an externally owned tooling host and one representative actionable failure;
- the post-terminal transport-close fix without a false failure notification;
- Test Explorer Debug for selected tests, selection/exclusion, cancellation, restart,
  the global one-session restriction, and a project with no main scene; and
- cleanup of sessions, external hosts, ports, temporary fixtures, and workspace settings.

**Current decision: pending hands-on Extension Development Host validation.** The
automated published-engine gates are complete, but they do not waive this UI matrix.
