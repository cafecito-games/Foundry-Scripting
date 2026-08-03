# Issue #56: Bounded Activation and Reconfiguration Plan

> **For implementation:** Follow the repository FoundryScript skill, strict TDD, and the issue's Mechanical implementation contract. Make each production change only after observing its focused test fail.

**Goal:** Make extension activation promptly register and return while owned background lifecycles safely reconfigure LSP/testing work, and bound every silent external readiness phase.

**Architecture:** Add a `ConnectionLifecycle` under `src/client/` as the sole owner of connection settings snapshots, project re-resolution, coordinators, managers, and serialized replacement. Keep `ConnectionManager` responsible for a single connection generation and add its per-client initialization deadline there. Keep `TestingRuntime` responsible for capability/discovery phase deadlines. `extension.ts` becomes synchronous wiring plus caught background scheduling.

**Tech stack:** TypeScript, VS Code extension API, Vitest, existing coordinator/manager/testing abstractions.

---

## Task 1: Bound a single language-client initialization

**Files:**
- Modify: `src/client/connection-manager.test.ts`
- Modify: `src/client/connection-manager.ts`

1. Add failing tests with an injected short initialization deadline and deferred `LanguageClientHandle.start()` proving:
   - external/spawn attachment rejects with `ConnectionFailure.kind === "initialization_timeout"`;
   - the message contains project, endpoint, and deadline;
   - timeout aborts startup and performs best-effort client cleanup;
   - a late `start()` resolution cannot install the client;
   - auto mode does not convert this failure into spawn fallback.
2. Run `npm test -- src/client/connection-manager.test.ts` and observe the expected failures.
3. Add `initializationTimeoutMs` (default 10,000 ms), the new failure kind/message, and a cancellation-aware deadline around `client.start()`. Always clear the timer/listener and preserve `tcp_refused` behavior.
4. Re-run the focused tests, then run typecheck/lint for the touched code.
5. Commit: `feat: bound LSP client initialization`.

## Task 2: Bound testing capability and discovery phases

**Files:**
- Modify: `src/testing/runtime.test.ts`
- Modify: `src/testing/runtime.ts`

1. Add failing tests using deferred negotiator/discoverer promises and an injected short per-phase deadline. Prove capabilities and discovery independently:
   - abort the phase child signal;
   - publish `TestAdapterFailure` kind `readiness_timeout` with the correct phase;
   - clean up deadline resources;
   - ignore late settlement after timeout, supersession, and shutdown.
2. Run `npm test -- src/testing/runtime.test.ts` and observe the expected failures.
3. Add `phaseTimeoutMs` (default 30,000 ms) and a helper that links a child controller to the generation signal, races the phase against its deadline, distinguishes parent cancellation from timeout, and disposes all timer/listener resources.
4. Re-run focused tests, typecheck, and lint.
5. Commit: `feat: bound testing readiness phases`.

## Task 3: Add the serialized connection lifecycle owner

**Files:**
- Create: `src/client/lifecycle.test.ts`
- Create: `src/client/lifecycle.ts`

1. Define narrow injected interfaces for reading current settings, resolving the current project, creating a coordinator/manager, publishing state, reporting project/startup failures, and logging background failures.
2. Write failing lifecycle tests for:
   - initial enabled startup;
   - `off` skips resolution/creation and publishes off;
   - `off` → enabled and enabled → `off`;
   - settings/project/workspace replacement releases the prior manager then coordinator before activating replacements;
   - rapid requests are serialized and last-write-wins;
   - stale resolution and stale manager-start completion never become current;
   - idempotent shutdown during resolution/start prevents replacement.
3. Run `npm test -- src/client/lifecycle.test.ts` and observe the expected failures.
4. Implement monotonic generation invalidation plus one serialized reconciliation queue. Requesting reconciliation must immediately invalidate/stop the current or in-flight manager; each awaited boundary must check currency and release stale resources. Expose read-only current manager/coordinator access for reconnect/debug consumers.
5. Ensure every public background operation has a caught/logged terminal path or returns a promise for the caller to observe. Re-run focused tests, typecheck, and lint.
6. Commit: `feat: own serialized connection reconfiguration`.

## Task 4: Wire non-blocking extension activation and testing registration

**Files:**
- Modify: `src/extension.test.ts`
- Modify: `src/extension.ts`
- Modify only if required by a focused type seam: `src/client/runtime.ts`

1. Add failing extension tests proving:
   - `activate()` settles while testing setup and LSP manager start remain deferred;
   - a deferred error-notification choice cannot hold activation open;
   - connection configuration sections and workspace-folder changes request reconciliation;
   - testing registration is complete before its initial asynchronous configuration settles;
   - deactivation invalidates a pending testing configuration read so it cannot recreate watchers/start discovery;
   - status reconnect and debug runtime obtain the lifecycle's current manager/coordinator.
2. Run `npm test -- src/extension.test.ts` and observe the expected failures.
3. Replace connection globals with the lifecycle owner. Register exact relevant configuration/workspace listeners and queue initial reconciliation without awaiting it. Detach notification interactions with caught/logged errors.
4. Make testing registration synchronous: install controller/profiles/listeners, publish its lifecycle, and queue the first configuration with a terminal logger. Add a stopped flag/generation invalidation before watcher/runtime/process cleanup.
5. Re-run extension tests plus all focused tests from Tasks 1–3.
6. Commit: `feat: activate and reconfigure tooling in background`.

## Task 5: Cross-feature regression and acceptance verification

**Files:**
- Modify production/tests only for concrete failures caused by this branch; retain TDD for every repair.

1. Run the required clean verification:

   ```bash
   npm ci
   npm run build
   npm run typecheck
   npm run lint
   npm test
   ```

2. Confirm no timer/open-handle leaks and no unhandled rejections in the full suite.
3. Review the diff against every issue checkbox and mechanical-contract bullet. Document any extra file touched and why.
4. Commit any focused regression repairs, leaving the branch clean.

## Manual smoke check (handoff)

In an Extension Development Host, verify prompt provider/Test Explorer visibility under a silent or missing tool host, `off` → `spawn` → `off` without reload, and project/workspace replacement releasing the previous connection. If UI automation is unavailable, state that explicitly in the PR while keeping the automated lifecycle coverage complete.
