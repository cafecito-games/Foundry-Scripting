# Engine-Published Grammar Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bootstrap TextMate grammar with one pinned, unmodified Foundry release asset and enforce exact release parity in CI.

**Architecture:** A dedicated JSON manifest owns the engine version. A Node sync command derives the official release URL, validates the downloaded grammar contract, and either atomically installs the raw bytes or compares them with the committed artifact. Existing TextMate and corpus tests continue to consume the committed file offline.

**Tech Stack:** Node.js 20, Vitest, VS Code TextMate/Oniguruma test tooling, GitHub Actions.

---

## File structure

| File | Responsibility |
|---|---|
| `foundry-grammar.json` | Single operational source of the pinned engine version. |
| `scripts/sync-grammar.mjs` | Download, validate, install, or compare the release grammar. |
| `scripts/sync-grammar.test.mjs` | Command-level tests against a local HTTP server and temporary checkout. |
| `syntaxes/foundryscript.tmLanguage.json` | Unmodified downloaded release artifact. |
| `tests/grammar/*.fs` | Exact assertions for the engine-published TextMate scopes. |
| `package.json` | Public npm commands for sync and parity checking. |
| `.github/workflows/ci.yml` | Online byte-parity gate. |
| `README.md` | Maintainer update workflow and offline-build guarantee. |

### Task 1: Pin and install a release grammar

**Files:**

- Create: `foundry-grammar.json`
- Create: `scripts/sync-grammar.mjs`
- Create: `scripts/sync-grammar.test.mjs`

- [ ] **Step 1: Write the failing successful-sync test**

Create `scripts/sync-grammar.test.mjs` with one command-level test. The fake version is
deliberately different from the real pin so the test proves URL construction comes from
the temporary manifest.

```js
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./sync-grammar.mjs", import.meta.url));
const version = "9.8.7-test.6";
const assetName = `foundryscript-tmlanguage-${version}.json`;
const validGrammar = Buffer.from(
  `${JSON.stringify(
    {
      name: "Foundry Script",
      scopeName: "source.foundryscript",
      fileTypes: ["fs"],
      patterns: [{ include: "#comments" }],
      repository: { comments: { match: "#.*" } },
    },
    null,
    2,
  )}\n`,
);

describe("sync-grammar command", () => {
  let root;
  let server;
  let releaseBaseUrl;
  let responseBody;
  let responseStatus;
  let requests;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "foundry-grammar-sync-"));
    await mkdir(path.join(root, "syntaxes"));
    await writeFile(
      path.join(root, "foundry-grammar.json"),
      `${JSON.stringify({ engineVersion: version }, null, 2)}\n`,
    );
    responseBody = validGrammar;
    responseStatus = 200;
    requests = [];
    server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(responseStatus, { "content-type": "application/json" });
      response.end(responseBody);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test server address");
    }
    releaseBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });

  async function runSync(args = []) {
    return execFileAsync(process.execPath, [scriptPath, ...args], {
      cwd: root,
      env: {
        ...process.env,
        FOUNDRY_GRAMMAR_RELEASE_BASE_URL: releaseBaseUrl,
      },
    });
  }

  async function runFailure(args = []) {
    try {
      await runSync(args);
    } catch (error) {
      return error;
    }
    throw new Error("Expected sync-grammar to fail");
  }

  it("downloads the pinned asset and preserves its exact bytes", async () => {
    const result = await runSync();

    expect(result.stderr).toBe("");
    expect(
      await readFile(path.join(root, "syntaxes/foundryscript.tmLanguage.json")),
    ).toEqual(validGrammar);
    expect(requests).toEqual([`/v${version}/${assetName}`]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run scripts/sync-grammar.test.mjs`

Expected: FAIL because `scripts/sync-grammar.mjs` does not exist.

- [ ] **Step 3: Add the real pin manifest**

Create `foundry-grammar.json`:

```json
{
  "engineVersion": "0.1.0-alpha.19"
}
```

- [ ] **Step 4: Implement only successful exact-byte synchronization**

Create `scripts/sync-grammar.mjs`:

```js
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "foundry-grammar.json");
const grammarPath = path.join(root, "syntaxes/foundryscript.tmLanguage.json");
const releaseBaseUrl =
  process.env.FOUNDRY_GRAMMAR_RELEASE_BASE_URL ??
  "https://github.com/cafecito-games/Foundry/releases/download";

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const version = manifest.engineVersion;
  const assetName = `foundryscript-tmlanguage-${version}.json`;
  const url = `${releaseBaseUrl.replace(/\/$/, "")}/v${version}/${assetName}`;
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const temporaryPath = path.join(
    path.dirname(grammarPath),
    `.${path.basename(grammarPath)}.${process.pid}.tmp`,
  );

  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, grammarPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  console.log(`Installed ${assetName}.`);
}

main().catch((error) => {
  console.error(`sync-grammar: ${error.message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `npx vitest run scripts/sync-grammar.test.mjs`

Expected: PASS, 1 test.

- [ ] **Step 6: Commit the first red-green slice**

```bash
git add foundry-grammar.json scripts/sync-grammar.mjs scripts/sync-grammar.test.mjs
git commit -m "feat: download pinned Foundry grammar"
```

### Task 2: Validate downloads and detect committed drift

**Files:**

- Modify: `scripts/sync-grammar.mjs`
- Modify: `scripts/sync-grammar.test.mjs`

- [ ] **Step 1: Add clean and drifting `--check` tests**

Append these tests inside the existing `describe` block:

```js
  it("passes check mode when the committed bytes match", async () => {
    await writeFile(
      path.join(root, "syntaxes/foundryscript.tmLanguage.json"),
      validGrammar,
    );

    const result = await runSync(["--check"]);

    expect(result.stdout).toContain("matches the pinned release asset");
  });

  it("fails check mode without changing a drifted grammar", async () => {
    const edited = Buffer.from("accidental edit\n");
    const grammarPath = path.join(root, "syntaxes/foundryscript.tmLanguage.json");
    await writeFile(grammarPath, edited);

    const error = await runFailure(["--check"]);

    expect(error.stderr).toContain("does not match the pinned release asset");
    expect(error.stderr).toContain("npm run sync-grammar");
    expect(await readFile(grammarPath)).toEqual(edited);
  });
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx vitest run scripts/sync-grammar.test.mjs`

Expected: both new tests fail because the command ignores `--check` and overwrites the
grammar.

- [ ] **Step 3: Implement check mode only**

Before fetching, add:

```js
  const check = process.argv.slice(2).includes("--check");
```

Replace the write block and success message with:

```js
  if (check) {
    const committed = await readFile(grammarPath);
    if (!committed.equals(bytes)) {
      throw new Error(
        "Committed grammar does not match the pinned release asset. " +
          "Run npm run sync-grammar and commit the result.",
      );
    }
    console.log("Committed grammar matches the pinned release asset.");
    return;
  }

  const temporaryPath = path.join(
    path.dirname(grammarPath),
    `.${path.basename(grammarPath)}.${process.pid}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, grammarPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  console.log(`Installed ${assetName}.`);
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `npx vitest run scripts/sync-grammar.test.mjs`

Expected: PASS, 3 tests.

- [ ] **Step 5: Add contract, HTTP, pin, and argument failure tests**

Append inside the `describe` block:

```js
  it("rejects a grammar with the wrong scope without touching the existing file", async () => {
    const grammarPath = path.join(root, "syntaxes/foundryscript.tmLanguage.json");
    const existing = Buffer.from("keep this grammar\n");
    await writeFile(grammarPath, existing);
    responseBody = Buffer.from(
      JSON.stringify({
        scopeName: "source.wrong",
        fileTypes: ["fs"],
        patterns: [{}],
        repository: { rule: {} },
      }),
    );

    const error = await runFailure();

    expect(error.stderr).toContain("scopeName must be source.foundryscript");
    expect(await readFile(grammarPath)).toEqual(existing);
  });

  it.each([
    ["invalid JSON", Buffer.from("{"), "valid JSON"],
    [
      "a missing fs file type",
      Buffer.from(
        JSON.stringify({
          scopeName: "source.foundryscript",
          fileTypes: [],
          patterns: [{}],
          repository: { rule: {} },
        }),
      ),
      "fileTypes",
    ],
    [
      "empty patterns",
      Buffer.from(
        JSON.stringify({
          scopeName: "source.foundryscript",
          fileTypes: ["fs"],
          patterns: [],
          repository: { rule: {} },
        }),
      ),
      "patterns",
    ],
    [
      "an empty repository",
      Buffer.from(
        JSON.stringify({
          scopeName: "source.foundryscript",
          fileTypes: ["fs"],
          patterns: [{}],
          repository: {},
        }),
      ),
      "repository",
    ],
  ])("rejects %s", async (_caseName, body, expectedMessage) => {
    const grammarPath = path.join(root, "syntaxes/foundryscript.tmLanguage.json");
    const existing = Buffer.from("keep this grammar\n");
    await writeFile(grammarPath, existing);
    responseBody = body;

    const error = await runFailure();

    expect(error.stderr).toContain(expectedMessage);
    expect(await readFile(grammarPath)).toEqual(existing);
  });

  it("reports a failed release request before validating or writing", async () => {
    responseStatus = 404;
    responseBody = Buffer.from("not found");

    const error = await runFailure();

    expect(error.stderr).toContain("HTTP 404");
  });

  it("rejects an unsafe engine version", async () => {
    await writeFile(
      path.join(root, "foundry-grammar.json"),
      `${JSON.stringify({ engineVersion: "../wrong" }, null, 2)}\n`,
    );

    const error = await runFailure();

    expect(error.stderr).toContain("engineVersion");
    expect(requests).toEqual([]);
  });

  it("rejects unsupported arguments", async () => {
    const error = await runFailure(["--write-somewhere-else"]);

    expect(error.stderr).toContain("Usage: node scripts/sync-grammar.mjs [--check]");
    expect(requests).toEqual([]);
  });
```

- [ ] **Step 6: Run the tests and verify RED**

Run: `npx vitest run scripts/sync-grammar.test.mjs`

Expected: FAIL because invalid assets are written, HTTP status is ignored, unsafe pins
reach the server, and unknown arguments are accepted.

- [ ] **Step 7: Replace the command with the final validated implementation**

Replace `scripts/sync-grammar.mjs` completely:

```js
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const OFFICIAL_RELEASE_BASE_URL =
  "https://github.com/cafecito-games/Foundry/releases/download";
const root = process.cwd();
const manifestPath = path.join(root, "foundry-grammar.json");
const grammarPath = path.join(root, "syntaxes/foundryscript.tmLanguage.json");

function parseMode(args) {
  if (args.length === 0) return { check: false };
  if (args.length === 1 && args[0] === "--check") return { check: true };
  throw new Error("Usage: node scripts/sync-grammar.mjs [--check]");
}

async function readPinnedVersion() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${path.basename(manifestPath)}: ${error.message}`);
  }

  const version = manifest?.engineVersion;
  if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) {
    throw new Error(
      `${path.basename(manifestPath)} engineVersion must contain only letters, ` +
        "digits, dots, and hyphens",
    );
  }
  return version;
}

function validateGrammar(bytes) {
  let grammar;
  try {
    grammar = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Release asset is not valid JSON: ${error.message}`);
  }

  if (!grammar || typeof grammar !== "object" || Array.isArray(grammar)) {
    throw new Error("Release asset root must be a JSON object");
  }
  if (grammar.scopeName !== "source.foundryscript") {
    throw new Error("Release asset scopeName must be source.foundryscript");
  }
  if (!Array.isArray(grammar.fileTypes) || !grammar.fileTypes.includes("fs")) {
    throw new Error("Release asset fileTypes must include fs");
  }
  if (!Array.isArray(grammar.patterns) || grammar.patterns.length === 0) {
    throw new Error("Release asset patterns must be a non-empty array");
  }
  if (
    !grammar.repository ||
    typeof grammar.repository !== "object" ||
    Array.isArray(grammar.repository) ||
    Object.keys(grammar.repository).length === 0
  ) {
    throw new Error("Release asset repository must be a non-empty object");
  }
}

async function downloadGrammar(version) {
  const assetName = `foundryscript-tmlanguage-${version}.json`;
  const baseUrl =
    process.env.FOUNDRY_GRAMMAR_RELEASE_BASE_URL ?? OFFICIAL_RELEASE_BASE_URL;
  const url = `${baseUrl.replace(/\/$/, "")}/v${version}/${assetName}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status} for ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  validateGrammar(bytes);
  return { assetName, bytes };
}

async function installGrammar(bytes) {
  const temporaryPath = path.join(
    path.dirname(grammarPath),
    `.${path.basename(grammarPath)}.${process.pid}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, grammarPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function main() {
  const { check } = parseMode(process.argv.slice(2));
  const version = await readPinnedVersion();
  const { assetName, bytes } = await downloadGrammar(version);

  if (check) {
    let committed;
    try {
      committed = await readFile(grammarPath);
    } catch (error) {
      throw new Error(`Unable to read committed grammar: ${error.message}`);
    }
    if (!committed.equals(bytes)) {
      throw new Error(
        "Committed grammar does not match the pinned release asset. " +
          "Run npm run sync-grammar and commit the result.",
      );
    }
    console.log("Committed grammar matches the pinned release asset.");
    return;
  }

  await installGrammar(bytes);
  console.log(`Installed ${assetName}.`);
}

main().catch((error) => {
  console.error(`sync-grammar: ${error.message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 8: Run the focused tests and verify GREEN**

Run: `npx vitest run scripts/sync-grammar.test.mjs`

Expected: PASS, 11 tests.

- [ ] **Step 9: Commit validated synchronization**

```bash
git add scripts/sync-grammar.mjs scripts/sync-grammar.test.mjs
git commit -m "feat: verify pinned grammar artifact"
```

### Task 3: Expose the maintainer and CI commands

**Files:**

- Modify: `package.json`
- Modify: `scripts/sync-grammar.test.mjs`

- [ ] **Step 1: Add a failing package-script contract test**

Add this import to `scripts/sync-grammar.test.mjs`:

```js
import { createRequire } from "node:module";
```

Then add this test outside the command `describe` block:

```js
describe("grammar package commands", () => {
  it("exposes explicit sync and check commands without a build lifecycle hook", () => {
    const require = createRequire(import.meta.url);
    const packageJson = require("../package.json");

    expect(packageJson.scripts["sync-grammar"]).toBe(
      "node scripts/sync-grammar.mjs",
    );
    expect(packageJson.scripts["check:grammar-sync"]).toBe(
      "node scripts/sync-grammar.mjs --check",
    );
    expect(packageJson.scripts.build).toBe("node esbuild.mjs");
    expect(packageJson.scripts.prepare).toBeUndefined();
    expect(packageJson.scripts.prebuild).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run scripts/sync-grammar.test.mjs`

Expected: FAIL because both package scripts are absent.

- [ ] **Step 3: Add the package scripts**

Add to the existing `scripts` object in `package.json`:

```json
"sync-grammar": "node scripts/sync-grammar.mjs",
"check:grammar-sync": "node scripts/sync-grammar.mjs --check"
```

Do not add either command to `build`, `prepare`, `prebuild`, or `postinstall`.

- [ ] **Step 4: Run unit tests and verify GREEN**

Run: `npm run test:unit`

Expected: PASS, including all 12 sync/package tests.

- [ ] **Step 5: Commit command wiring**

```bash
git add package.json scripts/sync-grammar.test.mjs
git commit -m "feat: expose grammar synchronization commands"
```

### Task 4: Move scope assertions to the authoritative grammar

**Files:**

- Modify: `tests/grammar/annotations.fs`
- Modify: `tests/grammar/comments.fs`
- Modify: `tests/grammar/contextual-keywords.fs`
- Modify: `tests/grammar/declarations.fs`
- Modify: `tests/grammar/keywords.fs`
- Modify: `tests/grammar/node-paths.fs`
- Modify: `tests/grammar/strings.fs`
- Modify: `syntaxes/foundryscript.tmLanguage.json`

- [ ] **Step 1: Change assertions to the engine-published scope vocabulary**

Apply these exact assertion changes while leaving source examples in place except for the
valid annotation declaration noted below:

| Fixture | Exact assertion change |
|---|---|
| `annotations.fs` | Assert `punctuation.definition.annotation.foundryscript` on `@`; assert `entity.name.function.annotation.foundryscript` on the identifier after `@`. |
| `comments.fs` | Replace `comment.line.documentation.foundryscript` with `comment.line.number-sign.documentation.foundryscript`. |
| `contextual-keywords.fs` | Replace `keyword.declaration.extend` with `storage.modifier.extend`; replace `keyword.declaration.annotation` with `storage.type.annotation`; change the declaration to `annotation my_marker() targets CLASS, METHOD`; retain `keyword.other.targets` on `targets`; remove the unsupported `support.constant.target` assertions; assert the nested `extend` and `annotation` heuristics positively; replace accessor scopes with `storage.type.accessor`; assert `get()` as `entity.name.function.call`; update every negative assertion to exclude the corresponding authoritative full scope. |
| `declarations.fs` | Assert namespace/import names as `entity.name.type`; assert `void` as `storage.type.void`; assert `Array`, `Dictionary`, and `Vector4` as `entity.name.type`; remove bootstrap-only builtin assertions on generic arguments `String` and `int`; replace the `extends` modifier assertion with `storage.modifier.extends`. |
| `keywords.fs` | Use `keyword.control.conditional`, `keyword.control.loop.while`, `keyword.control.flow.await`, `storage.type.function`, `storage.type.var`, `keyword.operator.logical`, and `keyword.operator.expression.is`; retain the unchanged static, literal, numeric constant, and illegal-yield assertions. |
| `node-paths.fs` | Assert node expressions with the parent `meta.node-path`; use `punctuation.definition.node` for `$`/`%`, `punctuation.definition.node.unique` for the inner `%`, `variable.other.node` for segments, `punctuation.separator.node` for `/`, and `string.quoted.node` for the quoted form. Update modulo negatives to exclude `punctuation.definition.node` and add positive `keyword.operator.arithmetic` assertions. |
| `strings.fs` | Use `string.quoted.single`, `string.quoted.double.raw`, and `string.quoted.double` in place of generic bootstrap scopes; retain punctuation and valid escape assertions; replace the bootstrap-only unknown-escape assertion with the authoritative enclosing `string.quoted.double` assertion; keep the unterminated-string and continuation regression assertions using authoritative scopes. |

All names above require the `.foundryscript` suffix in the fixture. Keep every pure
negative assertion fully qualified so `scripts/check-assertions.mjs` remains meaningful.

- [ ] **Step 2: Run the scope suite against the bootstrap grammar and verify RED**

Run: `npm run test:grammar`

Expected: FAIL with missing authoritative scopes, proving the updated assertions reject
the bootstrap grammar.

- [ ] **Step 3: Install the pinned release artifact through the new public command**

Run: `npm run sync-grammar`

Expected: `Installed foundryscript-tmlanguage-0.1.0-alpha.19.json.` and a full,
reviewable replacement of `syntaxes/foundryscript.tmLanguage.json`.

- [ ] **Step 4: Verify the committed file is the exact downloaded asset**

Run: `npm run check:grammar-sync`

Expected: `Committed grammar matches the pinned release asset.`

- [ ] **Step 5: Run the updated scope suite and verify GREEN**

Run: `npm run test:grammar`

Expected: all eight fixture files pass and the negative-assertion scan reports no inert
assertions.

- [ ] **Step 6: Prove a representative negative assertion is load-bearing**

Temporarily change the `%` arithmetic rule in the committed grammar so `x%y` receives
`punctuation.definition.node.foundryscript`, then run:

```bash
npm run test:grammar
```

Expected: `tests/grammar/node-paths.fs` FAILS on the fully-qualified negative assertion.
Restore the artifact exactly with `npm run sync-grammar`, then rerun the suite and expect
all fixtures to pass.

- [ ] **Step 7: Run the engine corpus gate**

Run:

```bash
FOUNDRY_ENGINE_PATH=/Users/christian/CafecitoGames/Foundry npm run test:corpus
```

Expected: `Scanned 1343 .fs files.` followed by `No unexpected invalid scopes.` The file
count is evidence for this run, not a value to encode in code or tests.

- [ ] **Step 8: Commit the authoritative artifact and assertions**

```bash
git add syntaxes/foundryscript.tmLanguage.json tests/grammar
git commit -m "feat: consume authoritative Foundry grammar"
```

### Task 5: Add CI drift verification and maintainer documentation

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

- [ ] **Step 1: Add a dedicated online parity job**

Add this job to `.github/workflows/ci.yml` alongside the existing grammar test job:

```yaml
  grammar-sync:
    name: grammar-sync
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
      - run: npm ci
      - run: npm run check:grammar-sync
```

Do not add the parity command to `build`, `package`, or `grammar-tests`; keeping it in a
separate job makes the network-dependent release check explicit.

- [ ] **Step 2: Document the update workflow**

Add this subsection under `## Development` in `README.md`, before the corpus instructions:

```markdown
### Updating the engine grammar

The committed TextMate grammar is the complete release artifact for the engine version
pinned in [`foundry-grammar.json`](foundry-grammar.json). That manifest is the only place
to change the version.

To update it:

1. Change `engineVersion` in `foundry-grammar.json`.
2. Run `npm run sync-grammar`.
3. Review the grammar and scope-assertion diffs.
4. Run `npm run test:grammar` and, when an engine checkout is available,
   `FOUNDRY_ENGINE_PATH=/path/to/Foundry npm run test:corpus`.

`npm run check:grammar-sync` downloads the pinned asset and verifies that its raw bytes
exactly match the committed grammar. CI runs this as an explicit online drift check.
Synchronization is not part of installation, building, packaging, or extension startup;
after `npm ci`, normal builds use only files already in the checkout.
```

- [ ] **Step 3: Verify workflow syntax and focused documentation references**

Run:

```bash
rg -n "sync-grammar|check:grammar-sync|foundry-grammar.json" README.md package.json .github/workflows/ci.yml
```

Expected: all three files reference the intended commands; no lifecycle hook invokes
`sync-grammar`.

- [ ] **Step 4: Commit CI and documentation**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci: verify published grammar parity"
```

### Task 6: Verify the complete issue acceptance criteria

**Files:**

- Verify only; modify files only if a command exposes a defect.

- [ ] **Step 1: Install from the lockfile**

Run: `npm ci`

Expected: exit 0 with dependencies restored from `package-lock.json`.

- [ ] **Step 2: Prove build and package do not invoke grammar networking**

Run:

```bash
FOUNDRY_GRAMMAR_RELEASE_BASE_URL=http://127.0.0.1:9 npm run build
FOUNDRY_GRAMMAR_RELEASE_BASE_URL=http://127.0.0.1:9 npm run package
```

Expected: both exit 0 despite the deliberately unreachable release origin, proving the
sync command is not part of either path.

- [ ] **Step 3: Run static and automated checks**

Run:

```bash
npm run lint
npm run typecheck
npm test
FOUNDRY_ENGINE_PATH=/Users/christian/CafecitoGames/Foundry npm run test:corpus
npm run check:grammar-sync
git diff --check origin/main...HEAD
```

Expected: every command exits 0; Vitest, all eight grammar fixtures, assertion validation,
the 1,343-file local corpus, and online byte parity all pass.

- [ ] **Step 4: Audit package metadata and pin uniqueness**

Run:

```bash
node -e 'const p=require("./package.json"); const g=p.contributes.grammars[0]; if(g.scopeName!=="source.foundryscript"||g.path!=="./syntaxes/foundryscript.tmLanguage.json") process.exit(1)'
rg -n "0\.1\.0-alpha\.19" package.json README.md scripts .github
```

Expected: the metadata command exits 0 and the version search produces no output. The
operational pin occurs only in the manifest; historical design and plan documents are
not runtime sources of truth.

- [ ] **Step 5: Review the branch diff against the issue**

Run:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- package.json foundry-grammar.json scripts/sync-grammar.mjs .github/workflows/ci.yml README.md
git status --short
```

Expected: only issue #5 files and the approved design/plan are present; the working tree
is clean.

- [ ] **Step 6: Request independent code review**

Use `superpowers:requesting-code-review` with base `origin/main` and current `HEAD`.
Fix all Critical and Important in-scope findings, rerun the full verification commands,
and repeat review if changes are material.

- [ ] **Step 7: Publish the issue branch**

After fresh verification and review convergence:

```bash
git push -u origin issue-5
gh pr create --repo cafecito-games/Foundry-Scripting --base main --head issue-5 \
  --title "Consume the engine-published grammar artifact" \
  --body-file /tmp/foundry-scripting-issue-5-pr.md
```

The PR body must summarize the pin/sync flow, authoritative scope migration, and tests;
it must end with `Closes #5`. Enable squash auto-merge only after required checks are
queued:

```bash
gh pr merge --repo cafecito-games/Foundry-Scripting --squash --auto
```
