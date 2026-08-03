# Issue #60: Runtime Declarations and Toolchain Alignment Plan

> **For implementation:** Follow the repository FoundryScript expert skill and strict TDD. The current GitHub issue #60 Mechanical implementation contract is authoritative.

**Goal:** Make compilation, tests, audits, and the minimum Extension Host smoke enforce the actual VS Code 1.90 / Node 20.9 support boundary.

**Architecture:** Pin the platform declarations and compatible test/build graph, add a production-only stricter compiler pass, then introduce one small VS Code 1.90 smoke runner. Keep the smoke intentionally shallow so #62 can extend the same runner into isolated packaged lifecycle scenarios.

**Tech stack:** TypeScript, npm lockfile, Vitest/Vite, esbuild, `@vscode/test-electron`, GitHub Actions.

---

## Task 1: Capture the dependency/runtime contract in failing tests

**Files:**
- Add or modify one focused Node/Vitest contract test under `scripts/` or `tests/`
- Inspect: `package.json`, `package-lock.json`, `tsconfig.json`, `.github/workflows/ci.yml`

1. Run the current exact clean baseline and record unit/grammar counts.
2. Add failing assertions for the exact six dev-dependency pins, `engines.vscode`, strict compiler scripts/config, both audit scripts, the minimum runner version, CI job/Node/`xvfb-run`, and Dependabot ecosystems.
3. Run only the new contract suite and observe failures against the old graph.
4. Keep assertions structural (parse JSON/YAML/text narrowly); do not snapshot unrelated package or workflow content.

## Task 2: Pin and upgrade the supported dependency graph

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify tests only where Vitest 4 has a real compatibility change

1. Use `npm install --save-dev --save-exact` for `@types/node@20.9.0`, `@types/vscode@1.90.0`, `@vscode/test-electron@2.5.2`, `vitest@4.1.10`, `vite@6.4.3`, and `esbuild@0.28.1` so the lock is generated rather than hand-edited.
2. Run the focused contract test, current unit suite, build, and ordinary typecheck.
3. Fix only upgrade incompatibilities; do not skip or weaken existing tests.
4. Run `npm audit --omit=dev` and `npm audit --audit-level=moderate`; both must report zero vulnerabilities.
5. Commit: `build: align declarations and development tooling`.

## Task 3: Add the production-strict compiler pass and fix findings

**Files:**
- Modify: `tsconfig.json`
- Add: `tsconfig.production-strict.json`
- Modify production `src/**/*.ts` files with reported findings
- Add focused regressions for behavior-sensitive guards

1. Enable `noImplicitOverride` globally.
2. Add the production config extending the main config, excluding `src/**/*.test.ts`, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled.
3. Add `typecheck:strict-production`; make `typecheck` run both the ordinary whole-source compiler and production-strict compiler.
4. Run the new strict command RED and inventory every production diagnostic by module.
5. Fix diagnostics in small module groups using guards, accurate optional-property construction, and narrowed types. Add a failing behavior regression before any non-mechanical runtime change.
6. Do not introduce `any`, non-null assertions, TypeScript suppression comments, or relax another compiler option.
7. Run both typechecks, lint, build, and the full unit/grammar suite.
8. Commit: `refactor: enforce strict production TypeScript`.

## Task 4: Add the exact VS Code 1.90 smoke harness

**Files:**
- Add: shared runner/helper under `scripts/`
- Add: smoke suite and committed local-file fixture under `tests/vscode-minimum/`
- Modify: `package.json`
- Modify focused contract tests

1. Add a failing runner contract test for exact version `1.90.0`, repository-root `extensionDevelopmentPath`, committed fixture, update/extension-disabling launch flags, and bounded failure propagation.
2. Add a CommonJS Extension Host suite using only VS Code 1.90 APIs. The fixture contains `project.foundry`, `.vscode/settings.json` with LSP off/testing disabled, and a `.fs` file.
3. Assert language ID, extension activation, connection command registration, and exactly the five FoundryScript task kinds. Do not start Foundry or any network service.
4. Expose `test:vscode-minimum`. Keep download/cache behavior reusable by #62 and avoid a second dependency or runner framework.
5. Run the Node contract tests, build, then the real VS Code 1.90 smoke locally. If the local environment cannot launch Electron, retain the exact failure evidence and make CI authoritative; do not silently skip.
6. Commit: `test: exercise minimum VS Code extension host`.

## Task 5: Automate audits and dependency maintenance

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Add: `.github/dependabot.yml`
- Modify focused contract tests

1. Add exact `audit:production` and `audit:development` scripts.
2. Add a required dependency-audit job after `npm ci` running both scripts.
3. Add the required `vscode-minimum` Ubuntu 22.04 / Node 20.9.0 / build / `xvfb-run -a` job.
4. Add monthly npm and GitHub Actions Dependabot entries.
5. Preserve every existing CI job and DAP/corpus pin exactly.
6. Run focused contract tests and parse the workflow/Dependabot files to prove the contract.
7. Commit: `ci: enforce runtime and dependency compatibility`.

## Task 6: Whole-branch audit and exact verification

1. Audit issue #60 line by line, including exact direct and lockfile versions, no declaration ranges, no compiler suppressions, fixture/package exclusion, and unchanged `engines.vscode`.
2. Run:

   ```bash
   npm ci
   npm run build
   npm run typecheck
   npm run lint
   npm test
   npm run audit:production
   npm run audit:development
   npm run test:vscode-minimum
   npm run package
   npm run check:package-files
   ```

3. Independently review specification compliance and code quality; fix every Important/Critical finding test-first and repeat affected checks.
4. Leave the worktree clean. Do not push or open a PR; return commits and verification evidence to the primary agent.
