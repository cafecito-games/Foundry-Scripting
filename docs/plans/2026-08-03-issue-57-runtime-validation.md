# Issue #57: Runtime Boundary Validation Plan

> **For implementation:** Follow the repository FoundryScript skill and strict TDD. The current GitHub issue #57 Mechanical implementation contract is authoritative; observe each focused test fail before production changes.

**Goal:** Turn malformed tooling JSON, LSP capability notifications, and VS Code connection settings into safe rejected inputs with actionable diagnostics instead of extension-host exceptions or raw Node failures.

**Architecture:** Keep each untrusted boundary explicit. Parse readiness and capability wire data from `unknown`; introduce one pure connection-settings validator reused by extension configuration and `ConnectionManager`; route typed configuration failures through `ConnectionLifecycle` to detached VS Code notification/logging UI.

**Tech stack:** TypeScript, VS Code Language Client, VS Code extension API, Vitest.

---

## Task 1: Harden tooling readiness JSON parsing

**Files:**
- Modify: `src/client/host-launcher.test.ts`
- Modify: `src/client/host-launcher.ts`

1. Add failing table tests for `null`, boolean, number, string, array, and malformed payloads. Add a child stdout test that emits malformed readiness followed by a valid line and proves launch succeeds without an escaped callback exception.
2. Run `npm test -- src/client/host-launcher.test.ts` and observe the null/non-object failure.
3. Parse to `unknown`, require a non-null non-array record before property access, and retain every current field rule.
4. Re-run focused tests, typecheck, and lint.
5. Commit: `fix: validate tooling readiness records`.

## Task 2: Validate capability notifications before state mutation

**Files:**
- Modify: `src/client/language-client.test.ts`
- Modify: `src/client/language-client.ts`

1. Add failing hostile-input tests for every top-level and native-class schema case in the issue. Assert no throw, warning event, prior-state preservation, callback suppression, and valid recovery.
2. Run `npm test -- src/client/language-client.test.ts` and observe the callback exceptions/state failures.
3. Change the notification generic to `unknown`; add a pure parser that copies only validated `name`/`inherits` fields. Log `lsp.capabilities.invalid` with a stable reason and no payload on rejection.
4. Re-run focused tests, typecheck, and lint.
5. Commit: `fix: validate LSP capability notifications`.

## Task 3: Add and enforce connection-settings validation

**Files:**
- Create: `src/client/settings.test.ts`
- Create: `src/client/settings.ts`
- Modify: `src/client/connection-manager.test.ts`
- Modify: `src/client/connection-manager.ts`

1. Add failing pure-validator tests for all four valid modes and every invalid boundary: unknown mode, non-string/blank engine path, port strings, fractions, zero, 65536, `NaN`, infinity, and equal ports. Assert the exact actionable setting key/message.
2. Add a failing manager test that forces an invalid typed snapshot and proves coordinator/client/host work never begins.
3. Run both focused suites and observe failures.
4. Implement `ConnectionConfigurationFailure` and the exact issue rules. Reuse the validator at the start of `ConnectionManager.start()` before manager state or coordinator work.
5. Re-run focused tests, typecheck, and lint.
6. Commit: `feat: validate connection settings at runtime`.

## Task 4: Route configuration failures through lifecycle and extension UI

**Files:**
- Modify: `src/client/lifecycle.test.ts`
- Modify: `src/client/lifecycle.ts`
- Modify: `src/extension.test.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify the existing focused manifest test (currently `src/debug/manifest.test.ts` or the branch-equivalent owner)

1. Add failing lifecycle tests proving a thrown typed settings failure uses `reportSettingsFailure`, does not resolve a project/create resources, and does not become an unclassified background error.
2. Add failing extension tests with raw manually edited invalid configuration proving activation settles, logs `lsp.configuration.invalid`, offers `Open Settings` for the exact key, and launches nothing. Cover a malformed mode using safe non-launching mode behavior.
3. Extend the manifest test to fail until `foundryScript.lsp.port` is exactly integer/default 6005/minimum 1/maximum 65535.
4. Implement unknown-valued config reads, shared validation, the dedicated lifecycle seam, detached actionable notification, and safe mode access for initial status/debug wiring. Change the manifest type.
5. Re-run lifecycle, extension, settings, manager, and manifest suites.
6. Commit: `fix: report invalid connection configuration`.

## Task 5: Full regression verification

1. Run the exact clean gate:

   ```bash
   npm ci
   npm run build
   npm run typecheck
   npm run lint
   npm test
   ```

2. Confirm malformed callbacks emit no unhandled errors/rejections, validation logs do not serialize hostile values, and the branch is clean.
3. Audit every issue checkbox and mechanical-contract bullet. Repair concrete gaps test-first and commit them separately.

No manual UI or real-engine check is required for this boundary-validation issue.
