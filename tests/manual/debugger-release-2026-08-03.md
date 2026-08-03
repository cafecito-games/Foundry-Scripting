# Debugger release validation — 2026-08-03

This is the published-engine release record for issue #50. It complements the
required automated DAP conformance suite and records the hands-on Extension Development
Host gate without treating terminal automation as a substitute.

## Environment and release provenance

- Extension branch: `run-epics/44-50-debugger-release`
- Base revision integrated: `0a87ab60eaefabbe3fbdab3a7ebf6ee90dcd3674`
- VS Code available for the hands-on run: 1.131.0
  (`e4c7e7b1d6d060162f4aa7f8225271b67ce1df75`), Apple Silicon
- macOS: 26.5.2 (25F84), arm64
- Foundry release: `v0.1.0-alpha.24`, published 2026-08-03T17:44:11Z
- Annotated tag object: `0b1a9a7fab10da85259f05a2438f73532af6ad85`
- Tag commit: `e91ab07e63ce0a783778dc885bb11d9c65603256`
- Required #1634 fix merge:
  `2ea5dd7b4992abd1d2cbfed53543597dfa718f78` (tag commit is three commits ahead)
- Published macOS asset: `Foundry_v0.1.0-alpha.24_macos.universal.zip`
- macOS asset SHA-256:
  `6fd298061dfecbdaf619da6073dc0f7ff66344f16fb98554e46db826a5b62312`
- Published Linux asset: `Foundry_v0.1.0-alpha.24_linux.x86_64.zip`
- Linux asset SHA-256:
  `5499f49a9aa298d97d98a025bb002c70816179e5fcf8a2104a622cfbf1e9e076`
- Binary identity: `0.1.alpha24.gh.e91ab07e6`
- Engine release workflow:
  [run 30833539143](https://github.com/cafecito-games/Foundry/actions/runs/30833539143),
  completed successfully with all 38 jobs passing

GitHub release metadata and both downloaded engine-asset digests agree. No local
development build was substituted for either published binary.

## Automated verification

The following commands completed successfully in the issue worktree:

- `npm ci`
- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npm test`: 771 tests passed, 6 opt-in live-process tests skipped by the normal unit
  invocation, and all grammar scope assertions passed.
- `npm run package`: the VSIX packaged successfully.
- `FOUNDRY_ENGINE_PATH=<published-alpha.24-binary> npm run test:dap-conformance`:
  both required live tests passed with no skips:
  - the scene DAP breakpoint, inspection, evaluation, stepping, restart, pause,
    cancellation, and sequential-lifecycle matrix;
  - the structured selected-test DAP matrix, including one/many/failing/unknown
    selections, unsupported protocol rejection, breakpoint inspection, Watch/hover/REPL
    evaluation, restart, cancellation, and a project without `run/main_scene`.

The conformance runner verifies that the binary reports pinned commit `e91ab07e6` before
starting either live suite, and hard-fails when the engine path is absent or mismatched.

The prior alpha.21 candidate exposed a Linux/timing-sensitive lifecycle failure after a
structured `project_test` breakpoint stop, restart, replacement breakpoint stop, and
continue. [Foundry #1634](https://github.com/cafecito-games/Foundry/issues/1634) is now
closed by the payload-teardown fix merged as
`2ea5dd7b4992abd1d2cbfed53543597dfa718f78`. Alpha.24 contains that merge, and the
unchanged conformance assertion still requires the replacement run's natural `exited`
event with exit code `0` before `terminated`.

## Extension Development Host matrix

The hands-on matrix used VS Code 1.131.0 and the published alpha.21 binary in isolated,
temporary scene and no-main-scene test projects. Alpha.24 changes the engine lifecycle
boundary rather than the VS Code integration; its exact published binaries are covered
by the release and DAP conformance gates above.

| Scenario | Result | Evidence |
| --- | --- | --- |
| Workspace trust | Pass | Both temporary projects opened in Restricted Mode. VS Code's Workspace Trust view showed debugging, workspace settings, and affected extensions disabled until each folder was explicitly trusted. |
| Main and explicit scenes | Pass | F5 with `scene: "main"` and `scene: "res://main.tscn"` each reached the enabled source breakpoint. Debug output recorded the resolved scene and one play argument. |
| Breakpoint and inspection | Pass | The main launch stopped in `_ready` at `breakpoint_hit.fs:7`; Call Stack showed `_ready`, Locals showed `local_value = 7`, Members showed `member_value = 35`, and Globals was present. |
| Evaluation | Pass | `local_value + member_value` evaluated to `42` in both Watch and the Debug Console. |
| Stepping | Pass | Step Over moved line 7 to 8; Step Into entered `outer_step_target` at line 12 and `inner_step_target` at line 17; Step Out returned to `outer_step_target` at line 14. An initially ambiguous click was discarded and the full sequence was reproduced from a fresh breakpoint stop. |
| Restart | Pass | Restart launched a replacement debuggee, returned to line 7, and reevaluated the Watch expression to `42`. |
| Pause and continue | Pass | An idle explicit scene exposed Pause; Pause changed the session to paused and Continue resumed it. |
| Stop and normal close | Pass | Stop ended the session, released the DAP lease, kept language features connected, and emitted no false adapter-failure notification after the expected late transport close. |
| Run Without Debugging | Pass | The explicit-scene run completed without stopping at the enabled breakpoint; Debug output recorded `res://main.tscn`, `noDebug=true`, and one play argument. |
| Single-session rule | Pass | Starting a second idle-scene instance produced an actionable error naming the active session and directing the user to stop it before retrying. |
| External host | Pass | Attach mode connected to `127.0.0.1:6006`, launched `res://main.tscn`, and stopped the debuggee without terminating the external Foundry process; both ports 6005 and 6006 remained listening in that process. |
| Actionable failure | Pass | With attach-mode DAP port 65000 unused, startup named `127.0.0.1:65000`, `ECONNREFUSED`, `foundryScript.dap.port`, the Debug output, mode, and retry action. |
| Selected-test Debug | Pass | Test Explorer discovered three suites and five tests in a project with no main scene. Debugging the passing suite selected its two descendants and reported both passed. |
| Test cancellation and restart | Pass | Restarting the cancellation suite preserved the same selection. Stop retained `Reports before cancellation` as passed and marked `Cancelled before report` skipped. Unit tests additionally cover selection expansion and exclusion filtering; the pinned live suite covers structured selection IDs. |
| Cleanup | Pass | All scene and test sessions were stopped, the external host was interrupted, extension-owned hosts were terminated, and ports 6005, 6006, and 65000 had no listeners. Temporary fixtures, downloads, user data, and workspace settings were then removed. |

## Release decision

**Release-ready at Foundry v0.1.0-alpha.24.** The Extension Development Host matrix
passes, the published macOS binary passes both required live suites, Foundry's release
workflow is green, and CI now verifies and executes the published Linux asset rather than
substituting a local engine build. PR merge remains subject to that required Ubuntu job.
