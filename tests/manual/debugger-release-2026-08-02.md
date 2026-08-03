# Scene debugger release validation — 2026-08-02

This is the hands-on release record for issue #50. It complements the automated DAP
conformance suite; it does not replace the engine-release compatibility gate.

This record captures the pre-publication development-build run. The published-engine
release record is `debugger-release-2026-08-03.md`; the pre-release findings below were
subsequently resolved by Foundry `v0.1.0-alpha.21` and the merged runtime lifecycle fix.

## Environment

- Extension branch: `run-epics/44-50-debugger-release`
- Base revision: `f349555d5c61841273f42185e7374f480007a857`
- VS Code: 1.131.0, Apple Silicon
- macOS: 26.5.2 (25F84)
- Foundry binary: `/Users/christian/bin/foundry`
- Foundry version:
  `0.1.dev.custom_build.a2d9f6df0`
- Verified engine commit:
  `a2d9f6df06fb545c8106f24c7445466d6355085b`
- Fixture: a temporary copy of `src/debug/fixtures/dap-conformance`
- UI: a real VS Code Extension Development Host controlled through the normal Run and
  Debug, Variables, Watch, Call Stack, Breakpoints, Debug Console, and Output views

## Manual matrix

| Scenario | Result | Evidence |
| --- | --- | --- |
| Debugger activation | Pass | Before the manifest fix, F5 failed with “Couldn't find a debug adapter descriptor.” After adding the debugger activation events, the extension host activated on `onDebugResolve:foundryscript` and F5 connected. |
| Restricted Mode | Pass | Both the extension workspace and fixture workspace showed VS Code's built-in workspace-trust warning before F5 could execute code. No extension-specific trust prompt was added. |
| Main-scene launch | Pass | `scene: "main"` connected to the owned host's reported ephemeral DAP port and stopped at `breakpoint_hit.fs:7`. |
| Explicit-scene launch | Pass | `scene: "res://main.tscn"` stopped at the same line breakpoint. |
| Play arguments | Pass | Debug output recorded one play argument for main, explicit, and idle launches. |
| Run Without Debugging | Pass with lifecycle blocker below | `Ctrl+F5` logged `noDebug=true`, preserved the explicit scene and one play argument, and did not stop at the enabled breakpoint. |
| Breakpoint and stack | Pass | VS Code showed `_ready breakpoint_hit.fs 7` in Call Stack. |
| Locals/Members/Globals | Pass | Locals showed `local_value = 7`; Members showed `member_value = 35`; the Globals scope was present. The required real-engine conformance test also requests and validates all three scope references. |
| Debug Console | Pass | `local_value + member_value` evaluated to `42`. |
| Watch | Pass | The same expression displayed `42` in Watch. |
| Step over | Pass | F10 moved from line 7 to line 8. |
| Step into | Pass | F11 entered `outer_step_target` at line 12; after stepping to its call, F11 entered `inner_step_target` at line 17. |
| Step out | Pass | Shift+F11 returned from `inner_step_target` to `outer_step_target` at line 14. |
| Restart | Pass | Shift+Command+F5 launched a fresh debuggee and stopped again at line 7. |
| Pause/continue | Pass | An idle explicit scene exposed Pause; F6 changed the UI to Paused, and F5 resumed it. |
| Stop | Functional, diagnostic blocker | Shift+F5 stopped the debuggee and released the DAP lease, but then emitted the false `connection closed` failure described below. |
| External host | Pass with lifecycle blocker below | Attach mode probed and connected to `127.0.0.1:6006`. After Stop, ports 6005 and 6006 remained listening in the same external Foundry process. |
| Actionable failure | Pass | With attach-mode DAP port 65000 unused, startup named the endpoint, `ECONNREFUSED`, `foundryScript.dap.port`, the Debug output channel, the connection mode, and the retry action. |
| Single-session/lifecycle automation | Pass | The runtime unit suite and real-engine DAP conformance suite cover rejection of concurrent sessions, sequential sessions, restart, disconnect, termination, and tooling-host ownership. |

Representative Debug output:

```text
Checking external FoundryScript DAP endpoint 127.0.0.1:6006 before launch.
Connecting to FoundryScript DAP at 127.0.0.1:6006.
Launching res://idle.tscn ... with noDebug=false and 1 play arguments.
FoundryScript debug session ended (adapter stopping); released the DAP lease.
```

Representative actionable failure:

```text
External FoundryScript DAP endpoint 127.0.0.1:65000 is unavailable.
Verify the external tooling host and foundryScript.dap.port, then retry.
connect ECONNREFUSED 127.0.0.1:65000
```

## Pre-release findings

1. After a normal VS Code Stop, Run Without Debugging completion, or natural completion
   of the short-lived main fixture, the tracker receives `connection closed` after it
   has already logged `adapter stopping` and released the lease. The extension reports
   that expected socket close as an adapter failure in both spawn and attach modes. The
   debuggee stops and external ownership is respected, but the false error prevents a
   clean release verdict. The runtime owner is addressing this with a sibling TDD fix;
   it is not an accepted release limitation.
2. The first compatible engine release has not been published. The latest prerelease,
   `v0.1.0-alpha.20`, does not contain the verified engine commit.

## Automated verification

All commands completed successfully in the issue worktree on 2026-08-02:

- `npm ci`
- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npm test`: 748 unit tests passed, 5 live-process tests skipped by their normal
  opt-in gates, and all grammar scope assertions passed.
- `FOUNDRY_ENGINE_PATH=/Users/christian/bin/foundry npm run test:dap-conformance`:
  the required real-engine conformance test passed.
- `npm run package`: the VSIX packaged successfully; the generated local artifact was
  removed after verification.

CI already includes non-optional `dap-conformance` and `package` jobs. The conformance
job checks out the full immutable engine SHA above and fails the pull request if the
real-engine matrix fails.

## Release decision

**Not release-ready.** Keep the extension PR in draft until the lifecycle diagnostic is
fixed and the first engine release containing
`a2d9f6df06fb545c8106f24c7445466d6355085b` is published. After publication, rerun
this matrix against the exact release binary and update README and CHANGELOG with its
tag. Selected-test debugging remains a separate later phase.
