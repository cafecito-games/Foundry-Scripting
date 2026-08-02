# Enforced CI Corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GitHub Actions corpus job scan a nonempty, immutable Foundry engine corpus while preserving an explicit optional skip for local runs.

**Architecture:** The corpus script will treat CI and local configuration differently, failing when CI lacks an engine path and whenever a configured checkout yields zero scripts. The workflow will check out the Foundry commit behind the grammar's pinned release into a dedicated path and pass that path to the script; command-level tests will cover both behavior and workflow wiring.

**Tech Stack:** Node.js ESM, Vitest, GitHub Actions YAML, Markdown

---

### Task 1: Enforce the corpus command's configuration contract

**Files:**
- Create: `scripts/check-corpus.test.mjs`
- Modify: `scripts/check-corpus.mjs:12-21`
- Modify: `scripts/check-corpus.mjs:78-112`

- [ ] **Step 1: Write failing subprocess tests for local skip and CI failure**

Create `scripts/check-corpus.test.mjs` with helpers that remove inherited corpus-related
variables before each subprocess:

```js
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./check-corpus.mjs", import.meta.url));
const temporaryDirectories = [];

function commandEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.CI;
  delete environment.FOUNDRY_ENGINE_PATH;
  return { ...environment, ...overrides };
}

async function runCorpus(overrides = {}) {
  return execFileAsync(process.execPath, [scriptPath], {
    env: commandEnvironment(overrides),
  });
}

async function runFailure(overrides = {}) {
  try {
    await runCorpus(overrides);
  } catch (error) {
    return error;
  }
  throw new Error("Expected corpus check to fail");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("corpus command configuration", () => {
  it("skips explicitly outside CI when no engine path is configured", async () => {
    const result = await runCorpus();

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("FOUNDRY_ENGINE_PATH is not set");
    expect(result.stdout).toContain("skipping the corpus check");
  });

  it("fails in CI when no engine path is configured", async () => {
    const error = await runFailure({ CI: "true" });

    expect(error.stderr).toContain(
      "CI corpus check requires FOUNDRY_ENGINE_PATH",
    );
  });

  it("fails when a configured corpus contains no FoundryScript files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "foundry-empty-corpus-"));
    temporaryDirectories.push(directory);

    const error = await runFailure({ FOUNDRY_ENGINE_PATH: directory });

    expect(error.stdout).toContain("Scanned 0 .fs files.");
    expect(error.stderr).toContain(
      "Corpus check requires at least one .fs file",
    );
  });
});
```

- [ ] **Step 2: Run the tests and verify the two enforcement cases fail**

Run: `npx vitest run scripts/check-corpus.test.mjs`

Expected: the local-skip test passes; the CI-misconfiguration and empty-corpus tests
fail because the current script exits zero.

- [ ] **Step 3: Fail when CI lacks an engine path**

Replace the initial missing-path branch in `scripts/check-corpus.mjs` with:

```js
const enginePath = process.env.FOUNDRY_ENGINE_PATH;
if (!enginePath) {
  if (process.env.CI) {
    console.error(
      "CI corpus check requires FOUNDRY_ENGINE_PATH to point to a Foundry checkout.",
    );
    process.exit(1);
  }

  console.log(
    "FOUNDRY_ENGINE_PATH is not set - skipping the corpus check.\n" +
      "Set it to a Foundry engine checkout to run this locally:\n" +
      "  FOUNDRY_ENGINE_PATH=~/CafecitoGames/Foundry npm run test:corpus",
  );
  process.exit(0);
}
```

- [ ] **Step 4: Fail after a zero-file scan**

Immediately after `console.log(`Scanned ${scanned} .fs files.`);`, add:

```js
if (scanned === 0) {
  console.error(
    "Corpus check requires at least one .fs file; verify FOUNDRY_ENGINE_PATH.",
  );
  process.exit(1);
}
```

- [ ] **Step 5: Run the focused tests and verify they pass**

Run: `npx vitest run scripts/check-corpus.test.mjs`

Expected: 3 tests pass, with the failure assertions observing nonzero subprocess exits.

- [ ] **Step 6: Commit the command contract**

```bash
git add scripts/check-corpus.mjs scripts/check-corpus.test.mjs
git commit -m "test: enforce corpus configuration"
```

### Task 2: Wire CI to an immutable, nonempty engine corpus

**Files:**
- Modify: `scripts/check-corpus.test.mjs`
- Modify: `.github/workflows/ci.yml:76-91`
- Modify: `README.md:155-177`

- [ ] **Step 1: Add a failing workflow configuration test**

Extend the imports in `scripts/check-corpus.test.mjs` to include `readFile`:

```js
import { mkdtemp, readFile, rm } from "node:fs/promises";
```

Then append this test:

```js
describe("corpus CI configuration", () => {
  it("checks out the engine release commit and passes its workspace path", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("repository: cafecito-games/Foundry");
    expect(workflow).toContain(
      "ref: 7a86a1464be0699c81a8a5b5c849447b4a7707bf",
    );
    expect(workflow).toContain("path: foundry-engine");
    expect(workflow).toContain(
      "FOUNDRY_ENGINE_PATH: ${{ github.workspace }}/foundry-engine",
    );
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the workflow test fails**

Run: `npx vitest run scripts/check-corpus.test.mjs`

Expected: 3 configuration tests pass and the new workflow test fails because the
engine checkout is absent.

- [ ] **Step 3: Add the pinned engine checkout and environment variable**

Change the `corpus` job in `.github/workflows/ci.yml` to:

```yaml
  corpus:
    name: corpus
    runs-on: ubuntu-latest
    env:
      FOUNDRY_ENGINE_PATH: ${{ github.workspace }}/foundry-engine
    steps:
      - uses: actions/checkout@v4
      - name: Check out Foundry engine corpus
        uses: actions/checkout@v4
        with:
          repository: cafecito-games/Foundry
          # Foundry v0.1.0-alpha.19, matching foundry-grammar.json.
          ref: 7a86a1464be0699c81a8a5b5c849447b4a7707bf
          path: foundry-engine
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
      - run: npm ci
      - run: npm run test:corpus
```

- [ ] **Step 4: Document optional local use and enforced CI behavior**

Replace the final paragraph of the README corpus section with:

```markdown
This tokenizes roughly 1,326 valid `.fs` files from the engine checkout and fails on any
unexpected `invalid.illegal` scope. Local runs without `FOUNDRY_ENGINE_PATH` skip
cleanly with an explanatory message.

CI does not skip this check. Its `corpus` job checks out an immutable Foundry commit for
the same release pinned in `foundry-grammar.json`, sets `FOUNDRY_ENGINE_PATH`, and fails
if the checkout yields zero `.fs` files. When updating the grammar release, update the
corpus checkout SHA in `.github/workflows/ci.yml` to the commit behind that release.
```

- [ ] **Step 5: Run the focused tests and inspect the workflow diff**

Run: `npx vitest run scripts/check-corpus.test.mjs && git diff --check`

Expected: 4 tests pass and `git diff --check` reports no errors.

- [ ] **Step 6: Commit the CI and documentation changes**

```bash
git add .github/workflows/ci.yml README.md scripts/check-corpus.test.mjs
git commit -m "ci: run pinned Foundry corpus"
```

### Task 3: Verify the pinned corpus and repository gates

**Files:**
- No source changes expected

- [ ] **Step 1: Obtain the exact pinned engine revision in a disposable checkout**

```bash
corpus_checkout=$(mktemp -d)
git clone --depth 1 --branch v0.1.0-alpha.19 \
  https://github.com/cafecito-games/Foundry.git "$corpus_checkout/Foundry"
git -C "$corpus_checkout/Foundry" rev-parse HEAD
```

Expected: `7a86a1464be0699c81a8a5b5c849447b4a7707bf`.

- [ ] **Step 2: Run the real pinned corpus gate**

Run: `FOUNDRY_ENGINE_PATH="$corpus_checkout/Foundry" npm run test:corpus`

Expected: output reports a nonzero `.fs` file count and `No unexpected invalid scopes.`

- [ ] **Step 3: Run all required repository checks**

Run each command separately:

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Expected: every command exits zero; Vitest includes the four new corpus tests.

- [ ] **Step 4: Review the final branch state**

Run:

```bash
git diff --check main...HEAD
git status --short --branch
git log --oneline main..HEAD
```

Expected: no whitespace errors, a clean `issue-58-corpus-ci` branch, and focused design,
command-contract, and CI commits after the worktree housekeeping commit.

- [ ] **Step 5: Remove the disposable engine checkout**

After confirming `corpus_checkout` begins with the system temporary-directory prefix,
remove only that exact directory:

```bash
rm -rf "$corpus_checkout"
```

Expected: the disposable pinned engine checkout is removed; the issue worktree remains.
