# Reproducible VSIX Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every VSIX packaging path rebuild the extension and reject source, test, dependency, source-map, and nested-worktree files.

**Architecture:** VSCE remains the sole packaging owner and invokes the standard `vscode:prepublish` lifecycle to build `dist/extension.js`. A small Node verifier asks the repository-local VSCE installation for its exact file list, validates required runtime files plus prohibited paths, and is covered by focused Vitest tests. CI and Taskfile reuse those npm entry points instead of reproducing build logic.

**Tech Stack:** npm scripts, `@vscode/vsce`, Node.js ESM, Vitest, GitHub Actions, Taskfile.

---

### Task 1: Package-file policy and tests

**Files:**
- Create: `scripts/check-package-files.mjs`
- Create: `scripts/check-package-files.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing package-policy tests**

Create `scripts/check-package-files.test.mjs`. Import `validatePackageFiles` from `./check-package-files.mjs`. Define the valid listing as:

```js
const validFiles = [
  "package.json",
  "dist/extension.js",
  "language-configuration.json",
  "syntaxes/foundryscript.tmLanguage.json",
];
```

Add these assertions:

```js
it("accepts the required runtime package files", () => {
  expect(() => validatePackageFiles(validFiles)).not.toThrow();
});

it.each([
  ".worktrees/issue/node_modules/dependency/index.js",
  ".github/workflows/ci.yml",
  ".cursor/skills/example/SKILL.md",
  ".vscode/settings.json",
  "docs/internal.md",
  "scripts/check-package-files.mjs",
  "src/extension.ts",
  "tests/extension.test.ts",
  "node_modules/dependency/index.js",
  "dist/extension.js.map",
])("rejects prohibited package path %s", (file) => {
  expect(() => validatePackageFiles([...validFiles, file])).toThrow(file);
});

it.each(validFiles)("requires runtime package file %s", (requiredFile) => {
  expect(() =>
    validatePackageFiles(validFiles.filter((file) => file !== requiredFile)),
  ).toThrow(requiredFile);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run scripts/check-package-files.test.mjs`

Expected: FAIL because `scripts/check-package-files.mjs` does not exist.

- [ ] **Step 3: Implement the package-file checker**

Create `scripts/check-package-files.mjs` with:

```js
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requiredFiles = [
  "package.json",
  "dist/extension.js",
  "language-configuration.json",
  "syntaxes/foundryscript.tmLanguage.json",
];
const prohibitedPrefixes = [
  ".worktrees/",
  ".github/",
  ".cursor/",
  ".vscode/",
  "docs/",
  "scripts/",
  "src/",
  "tests/",
  "node_modules/",
];

export function validatePackageFiles(files) {
  const failures = [];
  const packaged = new Set(files);
  for (const required of requiredFiles) {
    if (!packaged.has(required)) failures.push(`Missing required package file: ${required}`);
  }
  for (const file of files) {
    if (prohibitedPrefixes.some((prefix) => file.startsWith(prefix)) || file.endsWith(".map")) {
      failures.push(`Prohibited package file: ${file}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

function main() {
  const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const vscePath = path.join(repositoryRoot, "node_modules", "@vscode", "vsce", "vsce");
  const listing = spawnSync(process.execPath, [vscePath, "ls"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (listing.error) throw listing.error;
  if (listing.status !== 0) throw new Error(listing.stderr || `vsce ls exited ${String(listing.status)}`);
  const files = listing.stdout.split(/\r?\n/).filter(Boolean);
  validatePackageFiles(files);
  process.stdout.write(`Validated ${String(files.length)} VSIX files.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
```

Add the exact npm script `"check:package-files": "node scripts/check-package-files.mjs"` to `package.json`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run scripts/check-package-files.test.mjs`

Expected: PASS with 15 tests.

- [ ] **Step 5: Commit the policy**

```bash
git add scripts/check-package-files.mjs scripts/check-package-files.test.mjs package.json
git commit -m "test: define VSIX package file policy"
```

### Task 2: Build lifecycle and nested-worktree exclusion

**Files:**
- Modify: `package.json`
- Modify: `.vscodeignore`

- [ ] **Step 1: Verify the reproduced failure**

Create an ignored leak fixture at `.worktrees/package-leak/marker.txt` using `apply_patch`, run `npm run build`, then run `npm run check:package-files`.

Expected: FAIL and name `.worktrees/package-leak/marker.txt` because the current ignore file does not exclude nested worktrees.

- [ ] **Step 2: Add the standard build lifecycle and exclusion**

In `package.json`, add the exact script:

```json
"vscode:prepublish": "npm run build"
```

Keep `"package": "vsce package"` unchanged. Add this exact line to `.vscodeignore`:

```text
.worktrees/**
```

- [ ] **Step 3: Verify the package policy passes**

Run: `npm run check:package-files`

Expected: PASS and report a small file count with no `.worktrees/`, source, test, dependency, or source-map files.

- [ ] **Step 4: Prove packaging rebuilds a missing bundle**

Move `dist/extension.js` temporarily to a temporary directory outside the checkout, run `npm run package -- --out dist/foundryscript.vsix`, and confirm VSCE's prepublish output runs `npm run build` and recreates `dist/extension.js`. Restore/delete only the temporary copy after the proof.

- [ ] **Step 5: Commit the lifecycle fix**

```bash
git add package.json .vscodeignore
git commit -m "fix: make VSIX packaging rebuild the bundle"
```

### Task 3: CI reuse and full verification

**Files:**
- Modify: `.github/workflows/ci.yml`
- Verify unchanged: `Taskfile.yml`

- [ ] **Step 1: Add a failing workflow assertion**

Add `import { readFile } from "node:fs/promises";` and this test to `scripts/check-package-files.test.mjs`:

```js
it("packages and verifies through one CI lifecycle", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const packageJob = workflow.slice(workflow.lastIndexOf("\n  package:\n"));
  const installIndex = packageJob.indexOf("npm ci");
  const packageIndex = packageJob.indexOf("npm run package");
  const verifyIndex = packageJob.indexOf("npm run check:package-files");

  expect(installIndex).toBeGreaterThanOrEqual(0);
  expect(packageIndex).toBeGreaterThan(installIndex);
  expect(verifyIndex).toBeGreaterThan(packageIndex);
  expect(packageJob).not.toContain("npm run build");
});
```

Run `npx vitest run scripts/check-package-files.test.mjs` and confirm this new test fails because the current package job contains `npm run build` and no package-file verification.

- [ ] **Step 2: Reuse the package lifecycle in CI**

In the `package` job of `.github/workflows/ci.yml`, replace:

```yaml
      - run: npm run build
      - run: npm run package
```

with:

```yaml
      - run: npm run package
      - run: npm run check:package-files
```

Leave `Taskfile.yml` unchanged because its `package` task already calls `npm run package` and `install` depends on that task.

- [ ] **Step 3: Run focused tests**

Run: `npx vitest run scripts/check-package-files.test.mjs`

Expected: PASS.

- [ ] **Step 4: Run required repository verification**

Run in order:

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
npm run check:package-files
npm run package -- --out dist/foundryscript.vsix
```

Expected: every command exits 0; package output contains only the required runtime/support files and no prohibited path; no pre-existing `dist/extension.js` is needed by the package command.

Delete the temporary `.worktrees/package-leak` fixture after the packaging proof; it is ignored and must not be committed.

- [ ] **Step 5: Commit CI integration**

```bash
git add .github/workflows/ci.yml scripts/check-package-files.test.mjs
git commit -m "ci: verify reproducible VSIX contents"
```

### Task 4: Self-review against issue #54

**Files:**
- Review all changes from `main...HEAD`

- [ ] **Step 1: Inspect scope**

Run: `git diff --check main...HEAD && git diff --stat main...HEAD && git status --short`

Expected: no whitespace errors, only issue #54 files changed, and the worktree is clean.

- [ ] **Step 2: Audit every acceptance criterion**

Confirm with command output that VSCE invoked `vscode:prepublish`, a missing/stale bundle was rebuilt, Taskfile uses the same npm package entry point, CI no longer performs a separate build, and VSCE lists none of the prohibited paths.

- [ ] **Step 3: Report DONE or DONE_WITH_CONCERNS**

Return commit SHAs, changed files, RED/GREEN evidence, full verification results, and any concern. Do not push or open a pull request.
