# Issue #62: Extension Development Host Integration Plan

> **For implementation:** Follow the repository FoundryScript expert skill, strict TDD, and the full GitHub issue #62 Mechanical implementation contract. That issue is authoritative when this plan is less specific.

**Goal:** Prove the packaged FoundryScript VSIX behaves correctly in a real VS Code 1.90 Extension Host across activation, native registrations, test discovery, diagnostics ownership, reconfiguration, shutdown, Restricted Mode, and virtual workspaces.

**Architecture:** Extend #60's bounded minimum-host runner into a scenario orchestrator. Each scenario installs the production VSIX into isolated temporary state and uses a minimal driver extension. A deterministic fake Foundry executable supplies only the real CLI/LSP/Test Adapter Protocol boundaries the extension already consumes; scenario assertions remain outside production code.

**Tech stack:** `@vscode/test-electron`, VSIX packaging/install, CommonJS Extension Host driver, Node fake process/TCP servers, Vitest infrastructure tests, GitHub Actions/Xvfb.

---

## Task 1: Capture scenario and isolation contracts in RED tests

**Files:**
- Add focused runner/inventory tests under `scripts/` or `tests/extension-host/`
- Inspect/refactor later: `scripts/run-vscode-minimum.mjs`

1. Run the exact current #60 clean baseline, both audits, minimum-host smoke, package, and package-file check.
2. Add failing structural tests for:
   - `test:vscode-integration` and the required CI job;
   - exact VS Code 1.90.0 only;
   - scenario inventory from issue #62;
   - fresh user-data/extensions/workspace/control/log directories per scenario;
   - installed-VSIX product plus driver-extension topology;
   - bounded child/process-tree cleanup and failure-log retention;
   - exclusion of all integration infrastructure from the VSIX.
3. Observe the focused RED failures before adding implementation infrastructure.

## Task 2: Generalize the runner for packaged, isolated scenarios

**Files:**
- Refactor: `scripts/run-vscode-minimum.mjs`
- Add: shared scenario orchestrator modules under `scripts/` or `tests/extension-host/`
- Add: `tests/extension-host/driver/package.json` and CommonJS suite entry
- Modify: `package.json`, `.vscodeignore`, package-content tests

1. Preserve `npm run test:vscode-minimum` and its exact existing behavior.
2. Package the VSIX once, install it into each scenario's isolated extensions directory, and use only the driver extension as `extensionDevelopmentPath`. The product extension must resolve by installed ID.
3. Run every scenario in a fresh bounded VS Code process with separate short-path profile, fixture, control, and log roots.
4. Dispatch one named scenario through an environment value; return structured result/log paths to the parent runner.
5. Clean successful profiles; retain/upload failure artifacts without leaving live children. Add real child/process-tree tests for both paths.
6. Prove integration files do not enter the VSIX.
7. Commit: `test: add isolated packaged extension-host runner`.

## Task 3: Build and directly test the fake Foundry boundary

**Files:**
- Add fake executable/wrapper, control schema, LSP framing, artifact helpers, and tests under `tests/extension-host/fake-foundry/`

1. Add direct failing tests for exact real argument shapes: `tooling serve`, `script lint`, and test-adapter capabilities/discovery.
2. Add atomic NDJSON lifecycle logging with invocation ID, PID, argv, project, phase, signal, and exit.
3. Implement loopback-only ephemeral LSP/DAP servers and exact `FOUNDRY_TOOLING` readiness output.
4. Implement the minimal Content-Length JSON-RPC state machine for initialize, initialized, didOpen/didChange, diagnostics, shutdown, and exit.
5. Generate valid version-1 lint/capabilities/discovery artifacts using the production parser contracts.
6. Add control modes for normal, never-ready, clean disconnect, and deterministic payload generations.
7. Add real-process tests proving signal handling, port closure, artifact validity, and no non-loopback/external activity.
8. Commit: `test: emulate Foundry extension-host boundaries`.

## Task 4: Cover language, task, and Test Explorer registration independently

**Files:**
- Add trusted-local fixture templates and driver scenarios

1. Language/tasks scenario: LSP off/testing disabled; assert file language ID, installed extension activation, connection command, and exactly five task kinds without a fake invocation.
2. Test Explorer scenario: LSP off/testing enabled; assert exactly one capabilities then discovery sequence and successful artifact consumption.
3. Change testing args and assert one ordered replacement negotiation/discovery with exact args and no duplicate active invocation.
4. Run each scenario alone and in reverse inventory order to prove order independence.
5. Use bounded observable polling/event hooks only; no fixed synchronization sleeps.
6. Commit: `test: cover real language task and testing registrations`.

## Task 5: Cover diagnostic ownership transitions

**Files:**
- Add diagnostics scenario and fake payload controls

1. Run the real contributed lint task with LSP off and wait for `onDidEndTaskProcess`; assert the CLI diagnostic through `vscode.languages.getDiagnostics`.
2. Enable spawned LSP, wait for readiness/published diagnostics, and assert the LSP message replaces CLI for the same URI.
3. Disable LSP and assert the last LSP result remains until a second lint run publishes a new CLI snapshot.
4. Assert the second CLI diagnostic replaces retained LSP and all fake invocation generations settle.
5. Commit: `test: verify diagnostics ownership in extension host`.

## Task 6: Cover configuration and multi-root reconciliation

**Files:**
- Add multi-root `.code-workspace` templates/scenario and event-log assertions

1. Start exactly one tooling host for the first local project.
2. Change a connection configuration section; assert old process termination and exactly one ready replacement.
3. Reorder two folders so another project becomes first; assert one further replacement uses the new project.
4. Change a testing configuration section; assert ordered re-negotiate/discover without duplicate native owners or task-provider replacement.
5. Commit: `test: verify extension-host reconfiguration`.

## Task 7: Cover cold failure, cancellation, and shutdown

**Files:**
- Add isolated failure/shutdown scenarios and outer-runner post-exit assertions

1. Missing executable cold start must activate within two seconds, retain declarative/native registrations allowed in the trusted local workspace, and emit no unhandled rejection.
2. Never-ready fake: wait for start record, finish driver, then assert deactivation SIGTERM/SIGKILL cleanup, no live recorded PID, and bounded VS Code exit.
3. Normal active LSP/testing shutdown: assert every fake process/socket exits and adapter temporary directories are removed.
4. Treat unexpected Extension Host stderr/unhandled rejections as failure while allowing explicitly asserted startup-error output.
5. Commit: `test: verify extension-host failure and shutdown bounds`.

## Task 8: Cover Restricted Mode and a real virtual workspace

**Files:**
- Add restricted scenario/profile preparation
- Add read-only `foundry-e2e:` FileSystemProvider fixture extension and virtual scenario

1. Restricted: fresh user data, trust enabled, prompts suppressed, deliberately untrusted local folder, LSP/testing pre-enabled. Assert `isTrusted === false`, declarative language/activation, absent native command/tasks, and zero fake invocation. Fail rather than skip if VS Code 1.90 is not actually restricted.
2. Virtual: load the companion provider, launch `foundry-e2e:/project`, expose manifest/settings/script, assert non-file scheme and language/activation, absent native command/tasks, and zero fake/local-path access.
3. Prove provider/test infrastructure is excluded from the product VSIX.
4. Commit: `test: verify restricted and virtual workspace policy`.

## Task 9: CI, whole-branch review, and exact verification

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify focused runner/contract tests

1. Add required `vscode-integration` on Ubuntu 22.04, Node 20.9.0, exact VS Code 1.90.0, `xvfb-run -a`, explicit timeout, and failure-log upload.
2. Build/package once per job, then run all isolated scenarios. Preserve every existing job including `vscode-minimum`, corpus, and DAP conformance.
3. Run the full exact gate:

   ```bash
   npm ci
   npm run build
   npm run typecheck
   npm run lint
   npm test
   npm run audit:production
   npm run audit:development
   npm run test:vscode-minimum
   npm run test:vscode-integration
   npm run package
   npm run check:package-files
   ```

4. Audit child PIDs, sockets, temporary profiles, adapter directories, failure artifacts, scenario order independence, and absence of arbitrary sleeps/external services.
5. Run independent specification and quality reviews. Fix every Critical/Important finding with a focused RED first; repeat affected real-host scenarios and the full gate.
6. Leave the branch clean. Do not push/open a PR; return commits, exact scenario evidence, review verdicts, and any platform limitation to the primary agent.

