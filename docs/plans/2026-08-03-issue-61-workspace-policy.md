# Issue #61: Workspace Trust and Virtual Workspace Policy Plan

> **For implementation:** Follow the FoundryScript repo skill and strict TDD. Read the current GitHub issue #61 Mechanical implementation contract in full; it is authoritative.

**Goal:** Preserve declarative FoundryScript editing in limited workspaces while guaranteeing that native filesystem/process tooling registers and runs only in a trusted local-file workspace.

**Architecture:** Add a pure native-runtime eligibility decision and make `activate()` an idempotent gate around the existing runtime wiring. Add an independent URI-scheme failure to project resolution so every launch path remains safe after workspace transitions. Declare the same policy in the extension manifest and add targeted project activation.

**Tech stack:** TypeScript, VS Code extension API/manifest, Vitest mocks.

---

## Task 1: Declare and test the manifest policy

**Files:**
- Modify: `package.json`
- Modify: `src/debug/manifest.test.ts` (or split a focused general manifest test if clearer)

1. Add failing assertions for the exact limited untrusted/virtual capability shapes, nine restricted configurations, `workspaceContains:**/project.foundry`, connection-command gating, and current testing description.
2. Run the focused manifest suite and observe failures.
3. Add only the specified manifest fields/event/gate; preserve all existing contribution defaults and bounds.
4. Re-run focused test, typecheck, and package build.
5. Commit: `feat: declare limited workspace capabilities`.

## Task 2: Reject non-file project workspaces before native access

**Files:**
- Modify: `src/project/resolver.test.ts`
- Modify: `src/project/resolver.ts`
- Modify: `src/project/workspace.test.ts`
- Modify: `src/project/workspace.ts`
- Modify one focused task/testing/debug test only if needed for launch-path proof

1. Add failing pure/workspace tests for `unsupported_workspace`, exact scheme message/detail, and zero reads of `fsPath`, configuration, `manifestExists`, `RelativePattern`, or `findFiles` for non-file first folders.
2. Add a focused consuming-subsystem test proving the normal failure is reported and no process owner is created.
3. Run focused tests and observe existing `fsPath` behavior/failure-kind gaps.
4. Add optional scheme input to pure resolution and check it before all path/config/filesystem work. Pass the actual first URI scheme from the VS Code adapter without touching `fsPath` first.
5. Preserve missing/file/configured/nested/ambiguous behavior; re-run tests/typecheck/lint.
6. Commit: `fix: reject non-file Foundry project workspaces`.

## Task 3: Add pure native-runtime eligibility

**Files:**
- Create: `src/workspace-support.test.ts`
- Create: `src/workspace-support.ts`

1. Add failing tests for untrusted local, trusted empty, trusted file, trusted non-file, and mixed/multi-root first-folder ownership.
2. Implement the narrow pure result (`eligible`, `restricted`, `unsupported_scheme`) without importing process/client modules or reading `fsPath`.
3. Re-run focused tests/typecheck/lint.
4. Commit: `feat: classify native workspace eligibility`.

## Task 4: Gate native extension runtime registration and transitions

**Files:**
- Modify: `src/extension.test.ts`
- Modify: `src/extension.ts`

1. Add failing tests proving:
   - untrusted/virtual activation settles with zero diagnostics/task/debug/status/TestController/LSP/testing registrations or startup calls;
   - trust grant and virtual→file transition register every existing subsystem once;
   - repeated events never duplicate registrations;
   - deactivation before eligibility and during deferred start is safe;
   - trusted local→virtual releases active lifecycle work and creates no replacement;
   - activation remains non-blocking and background start failures are observed/logged.
2. Run `npm test -- src/extension.test.ts` and observe failures against unconditional wiring.
3. Extract the existing native wiring into an idempotent start owner. `activate()` registers only trust/workspace eligibility listeners first, then starts native wiring if eligible. Keep existing #56 background lifecycle/cancellation semantics exactly.
4. Ensure globals and `deactivate()` handle never-started/starting/active states and repeated disposal.
5. Re-run extension plus project/subsystem focused suites, typecheck, and lint.
6. Commit: `feat: gate native tooling by workspace support`.

## Task 5: Full security/regression audit

1. Trace every process construction path (tooling host/LSP, task, testing negotiate/discover/execute, debug) and prove it depends on eligibility/project resolution. Add one focused guard if any bypass exists.
2. Run the exact clean gate:

   ```bash
   npm ci
   npm run build
   npm run typecheck
   npm run lint
   npm test
   ```

3. Confirm no unhandled rejections, duplicate registrations, leaked listeners, or changed trusted-file behavior.
4. Audit every issue contract bullet and commit any test-first repair separately.

No real trust prompt, virtual provider, engine, or manual UI run is required; issue #62 will add Extension Development Host coverage for the declared policy.
