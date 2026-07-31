# Syntax Highlighting and Extension Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an installable VS Code extension that highlights FoundryScript `.fs` files correctly, with grammar correctness proven by tests rather than inspection.

**Architecture:** A TextMate grammar (`syntaxes/foundryscript.tmLanguage.json`) derived from the engine's `GRAMMAR.md`, plus a `language-configuration.json` for indentation and comment behavior. Grammar correctness is enforced by two layers: `vscode-tmgrammar-test` scope assertions for every construct, and a corpus check that tokenizes every `.fs` file in an engine checkout and asserts no valid code produces `invalid.illegal` scopes. No language-server or CLI dependency — everything here works offline.

**Tech Stack:** TypeScript, esbuild, Vitest, `vscode-tmgrammar-test`, `vscode-textmate` + `vscode-oniguruma`, `@vscode/vsce`.

**Covers:** [cafecito-games/Foundry-Scripting#14](https://github.com/cafecito-games/Foundry-Scripting/issues/14) — sub-issues #1, #2, #3, #4, #6.

**Excludes:** Issue #5 (consume the engine-published grammar artifact) is blocked on [cafecito-games/Foundry#1418](https://github.com/cafecito-games/Foundry/issues/1418) and gets its own plan once that lands.

---

## Deviations from the epic

Two deliberate departures from the issue text. Both are recorded here so they are reviewable rather than silent.

1. **Issue #1 says to stub all five unit directories.** This plan creates only `src/extension.ts`. Empty stubs for `client/`, `diagnostics/`, `tasks/`, and `debug/` would be dead code that lint flags and that epics #15 and #16 immediately rewrite. Those epics create their own directories.

2. **Issues #3 and #4 split "write the grammar" from "write the tests".** That ordering is incompatible with TDD. This plan interleaves them: Tasks 3–5 each add a slice of grammar test-first. Issue #4's corpus work becomes Task 6.

## Known constraint: the `.fs` extension collides with F#

`.fs` is F#'s conventional extension. Users with Ionide installed will see a conflict. This is resolved by the user with `files.associations`, and Task 7 documents it in the README. Do not try to solve it in the grammar.

## Negative scope assertions must be fully qualified

`vscode-tmgrammar-test`'s negative assertion form (`^^^ - some.scope`) does an **exact string match**, not a TextMate scope-selector prefix match. The implementation is a literal `excludedScopes.filter(s => token.scopes.includes(s))` in `node_modules/vscode-tmgrammar-test/dist/unit/index.js`.

Because this grammar always emits fully-qualified names, an assertion like `- constant.numeric` can **never fail** — the bare string `"constant.numeric"` is never an element of the scopes array, whether or not the bug it guards against is present. Such an assertion is silently vacuous and reads exactly like a passing test.

Verified: re-introducing the `tup.0` bug (dropping the integer pattern's nested lookbehind) left `- constant.numeric` green, while `- constant.numeric.integer.foundryscript` correctly failed.

**Every negative assertion must name the exact scope the buggy grammar would emit**, e.g. `- constant.numeric.integer.foundryscript`, `- storage.modifier.async.foundryscript`, `- keyword.declaration.extend.foundryscript`.

**And every negative assertion must be proven load-bearing** by temporarily breaking the grammar so the guarded property is violated, confirming the assertion fails, then restoring. A negative assertion nobody has seen fail is not evidence of anything.

Two further ways an assertion silently checks nothing, both found the hard way:

- **An indented `#` is not an assertion at all.** `isLineAssertion` requires `s.startsWith(commentToken)`, so a leading space makes the line parse as ordinary source. The `#` must be in column 1.
- **A pure-negative assertion selecting zero tokens passes silently.** The runner guards the empty-selection case with `if (xs.length === 0 && requiredScopes.length > 0)`, so a positive assertion with drifted carets fails loudly while a negative one is inert. Carets drifting past the end of the source line are the usual cause.

Task 6 adds a mechanical scan for the last of these.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Extension manifest, `contributes`, scripts, dependencies |
| `tsconfig.json` | TypeScript configuration |
| `esbuild.mjs` | Bundle `src/extension.ts` → `dist/extension.js` |
| `.vscodeignore` | Exclude tests and sources from the published package |
| `.github/workflows/ci.yml` | Build, lint, typecheck, test on push and PR |
| `src/extension.ts` | Activation entry point |
| `language-configuration.json` | Comments, brackets, auto-closing, indentation |
| `src/language-configuration.test.ts` | Unit tests for the indentation regexes |
| `syntaxes/foundryscript.tmLanguage.json` | The grammar |
| `tests/grammar/*.fs` | Scope assertions, one file per construct group |
| `scripts/check-corpus.mjs` | Tokenize an engine checkout, assert no `invalid.illegal` |

---

### Task 1: Scaffold the extension project

**Goal:** A buildable, testable, lintable extension that VS Code recognizes as contributing the `foundryscript` language.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `esbuild.mjs`
- Create: `src/extension.ts`
- Create: `.gitignore`
- Create: `.github/workflows/ci.yml`

**Acceptance Criteria:**
- [ ] `npm ci && npm run build && npm run typecheck && npm test` passes from a clean checkout
- [ ] `dist/extension.js` is produced by the build
- [ ] `package.json` contributes language id `foundryscript` for `.fs`
- [ ] CI runs the same commands on push and PR

**Verify:** `npm ci && npm run build && npm run typecheck && npm test` → all exit 0

**Steps:**

- [ ] **Step 1: Create `package.json`**

The `grammars` contribution points at a file created in Task 3. VS Code tolerates the missing file until then; `vscode-tmgrammar-test` does not, which is why no grammar tests exist until Task 3.

```json
{
  "name": "foundryscript",
  "displayName": "FoundryScript",
  "description": "FoundryScript language support for Visual Studio Code",
  "version": "0.1.0",
  "publisher": "cafecito-games",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/cafecito-games/Foundry-Scripting.git"
  },
  "engines": {
    "vscode": "^1.90.0"
  },
  "categories": [
    "Programming Languages"
  ],
  "main": "./dist/extension.js",
  "activationEvents": [],
  "contributes": {
    "languages": [
      {
        "id": "foundryscript",
        "aliases": [
          "FoundryScript",
          "foundryscript"
        ],
        "extensions": [
          ".fs"
        ],
        "configuration": "./language-configuration.json"
      }
    ],
    "grammars": [
      {
        "language": "foundryscript",
        "scopeName": "source.foundryscript",
        "path": "./syntaxes/foundryscript.tmLanguage.json"
      }
    ]
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "npm run test:unit && npm run test:grammar",
    "test:unit": "vitest run",
    "test:grammar": "vscode-tmgrammar-test \"tests/grammar/**/*.fs\"",
    "test:corpus": "node scripts/check-corpus.mjs",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/vscode": "^1.90.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@vscode/vsce": "^3.0.0",
    "esbuild": "^0.24.0",
    "eslint": "^9.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0",
    "vscode-oniguruma": "^2.0.1",
    "vscode-textmate": "^9.1.0",
    "vscode-tmgrammar-test": "^0.1.3"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "Node16",
    "moduleResolution": "Node16",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "dist",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `esbuild.mjs`**

```js
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
```

- [ ] **Step 4: Create `src/extension.ts`**

Activation is intentionally empty. Everything this epic delivers — grammar, language configuration — is declarative and needs no runtime code. Epics #15 and #16 add the runtime.

```ts
import type * as vscode from "vscode";

export function activate(_context: vscode.ExtensionContext): void {
  // Highlighting and language configuration are contributed declaratively via
  // package.json. Runtime behavior arrives with the language client (epic #15)
  // and diagnostics/tasks (epic #16).
}

export function deactivate(): void {
  // Nothing to tear down yet.
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
*.vsix
```

- [ ] **Step 6: Write a unit test proving the test runner works**

Create `src/extension.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { activate, deactivate } from "./extension.js";

describe("extension entry point", () => {
  it("activates without throwing", () => {
    expect(() => activate({} as never)).not.toThrow();
  });

  it("deactivates without throwing", () => {
    expect(() => deactivate()).not.toThrow();
  });
});
```

- [ ] **Step 7: Install dependencies and run the test**

Run: `npm install && npx vitest run`
Expected: PASS — 2 tests green.

This step verifies the toolchain, not behavior. A failure here means a configuration problem in Steps 1–4, not a missing feature. Fix it before continuing; TDD proper begins in Task 2.

- [ ] **Step 8: Adjust `test:grammar` so `npm test` passes before Task 3**

`vscode-tmgrammar-test` errors when no test files match. Until Task 3 creates them, point `npm test` at unit tests only. Edit `package.json`:

```json
    "test": "npm run test:unit",
```

Task 3 restores the full form.

- [ ] **Step 9: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
```

- [ ] **Step 10: Verify the full pipeline**

Run: `npm run build && npm run typecheck && npm test`
Expected: build writes `dist/extension.js`; typecheck silent; 2 tests pass.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json esbuild.mjs src .gitignore .github
git commit -m "feat: scaffold VS Code extension project

Closes #1"
```

---

### Task 2: Language configuration for `.fs` files

**Goal:** Correct comment toggling, bracket behavior, and indentation for an indentation-sensitive language, with the indentation regexes unit-tested.

**Files:**
- Create: `language-configuration.json`
- Create: `src/language-configuration.test.ts`

**Acceptance Criteria:**
- [ ] Pressing Enter after a line ending in `:` increases indent
- [ ] `#` toggles line comments
- [ ] Auto-closing pairs work for brackets and quotes
- [ ] `##` doc comment blocks continue on Enter
- [ ] Indentation regexes are covered by unit tests

**Verify:** `npx vitest run src/language-configuration.test.ts` → all tests pass

**Steps:**

- [ ] **Step 1: Write the failing test**

The indentation rules are regexes in a JSON file, which makes them directly testable without the VS Code host.

Note the plain default import rather than `with { type: "json" }`. Import attributes require `module` to be `esnext`/`node18`/`node20`/`nodenext`/`preserve`, and this project is on `Node16`; `resolveJsonModule` handles the plain form. This was established in Task 1.

Create `src/language-configuration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import configuration from "../language-configuration.json";

const increaseIndent = new RegExp(configuration.indentationRules.increaseIndentPattern);
const decreaseIndent = new RegExp(configuration.indentationRules.decreaseIndentPattern);

describe("increaseIndentPattern", () => {
  const increases = [
    "func take_damage(amount: int) -> void:",
    "class Inner:",
    "trait Damageable:",
    "if health <= 0:",
    "elif health < 10:",
    "else:",
    "for enemy in enemies:",
    "while running:",
    "match state:",
    "        nested_if_deeply_indented:",
    "extend int uses Describable:",
    "func f():  # trailing comment",
    // Match arms (GRAMMAR.md 6.1) - patterns are arbitrary expressions, which is
    // why increaseIndentPattern cannot be a keyword list.
    "    Idle:",
    "    1, 2, 3:",
    "    _:",
    "    [first, second]:",
    "    Message.Move(x, y) when x > 0:",
    // Property accessors (GRAMMAR.md 4.4) and whole-file enums (3.2).
    "    get:",
    "    set(value):",
    "enum Direction:",
    // Multi-line lambda (GRAMMAR.md 5.3).
    "var handler = func(x: int) -> int:",
  ];

  for (const line of increases) {
    it(`increases indent after: ${line.trim()}`, () => {
      expect(increaseIndent.test(line)).toBe(true);
    });
  }

  const doesNotIncrease = [
    "var mapping = { \"a\": 1 }",
    "var health: int = 100",
    "# a comment ending in a colon:",
    "return",
    "signal died(cause: String)",
    "var slice = items[1:2]",
    "var label = \"a:\"",
    "var choice = 1 if ready else 2",
    "var inline = func(x): return x * 2",
  ];

  for (const line of doesNotIncrease) {
    it(`does not increase indent after: ${line.trim()}`, () => {
      expect(increaseIndent.test(line)).toBe(false);
    });
  }
});

describe("decreaseIndentPattern", () => {
  it("decreases indent on else", () => {
    expect(decreaseIndent.test("    else:")).toBe(true);
  });

  it("decreases indent on elif", () => {
    expect(decreaseIndent.test("    elif ready:")).toBe(true);
  });

  it("does not decrease indent on an ordinary statement", () => {
    expect(decreaseIndent.test("    health -= 1")).toBe(false);
  });

  // Must stay symmetric with increaseIndentPattern. If only the increase side
  // allowed trailing comments, this line would indent its body but never dedent
  // itself, leaving the block a level too deep.
  it("decreases indent on else with a trailing comment", () => {
    expect(decreaseIndent.test("    else:  # handle default")).toBe(true);
  });

  it("decreases indent on elif with a trailing comment", () => {
    expect(decreaseIndent.test("    elif ready:  # nearly dead")).toBe(true);
  });

  // The trailing colon is required on purpose: without it, a wrapped ternary
  // such as `    else b)` would wrongly dedent.
  it("does not decrease indent before the colon is typed", () => {
    expect(decreaseIndent.test("    else")).toBe(false);
  });

  it("does not decrease indent on a wrapped ternary continuation", () => {
    expect(decreaseIndent.test("    else b)")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/language-configuration.test.ts`
Expected: FAIL — `Cannot find module '../language-configuration.json'`

- [ ] **Step 3: Create `language-configuration.json`**

Both indentation patterns require a `:` as the last non-comment character on the line. There is no brace awareness — what keeps `var mapping = { "a": 1 }` from matching is simply that its `:` is not at end of line.

`increaseIndentPattern` is deliberately **keyword-free**, unlike Python's or Ruby's configurations. A keyword list cannot express FoundryScript's match arms, whose patterns are arbitrary expressions (`GRAMMAR.md` §6.1) — `Message.Move(x, y) when x > 0:` has no leading keyword to match on. The same permissiveness covers property accessors (`get:`, `set(value):`), `enum Dir:`, and multi-line lambdas. Do not "tidy" this into a keyword list.

Both patterns allow the same trailing-comment suffix `(#.*)?`. They must stay symmetric: if only the increase pattern allowed comments, `else:  # note` would indent its body while never dedenting itself, putting the whole block one level too deep — and because `decreaseIndentPattern` also feeds *Reindent Lines* and indent-on-paste, that corrupts entire files rather than just live typing.

```json
{
  "comments": {
    "lineComment": "#"
  },
  "brackets": [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"]
  ],
  "autoClosingPairs": [
    { "open": "{", "close": "}" },
    { "open": "[", "close": "]" },
    { "open": "(", "close": ")" },
    { "open": "\"", "close": "\"", "notIn": ["string", "comment"] },
    { "open": "'", "close": "'", "notIn": ["string", "comment"] },
    { "open": "r\"", "close": "\"", "notIn": ["string", "comment"] },
    { "open": "r'", "close": "'", "notIn": ["string", "comment"] }
  ],
  "folding": {
    "offSide": true
  },
  "surroundingPairs": [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
    ["\"", "\""],
    ["'", "'"]
  ],
  "indentationRules": {
    "increaseIndentPattern": "^(?!\\s*#).*:\\s*(#.*)?$",
    "decreaseIndentPattern": "^\\s*(else|elif)\\b.*:\\s*(#.*)?$"
  },
  "onEnterRules": [
    {
      "beforeText": "^\\s*##.*$",
      "action": {
        "indent": "none",
        "appendText": "## "
      }
    }
  ],
  "wordPattern": "(-?\\d*\\.\\d\\w*)|([^\\`\\~\\!\\@\\#\\^\\&\\*\\(\\)\\-\\=\\+\\[\\{\\]\\}\\\\\\|\\;\\:\\'\\\"\\,\\.\\<\\>\\/\\?\\s]+)"
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/language-configuration.test.ts`
Expected: PASS — all cases green.

If `var mapping = { "a": 1 }` fails, the `increaseIndentPattern` is matching the `:` inside the braces. The trailing `\\s*(#.*)?$` anchor is what prevents this — the `:` must be the last non-comment character on the line. Verify the pattern was copied exactly.

- [ ] **Step 5: Verify manually in VS Code**

Run: `npm run build`, then press F5 to launch the Extension Development Host. In a `.fs` file, type `func f():` and press Enter. Expected: the cursor indents one level. Select a line and press `Cmd+/`. Expected: `# ` is prepended.

- [ ] **Step 6: Commit**

```bash
git add language-configuration.json src/language-configuration.test.ts
git commit -m "feat: add language configuration for .fs files

Closes #2"
```

---

### Task 3: Grammar test harness and lexical core

**Goal:** A working grammar covering comments, strings, and numbers, with the scope-assertion harness in place.

**Files:**
- Create: `syntaxes/foundryscript.tmLanguage.json`
- Create: `tests/grammar/comments.fs`
- Create: `tests/grammar/strings.fs`
- Create: `tests/grammar/numbers.fs`
- Modify: `package.json` (restore `test:grammar` in the `test` script)

**Acceptance Criteria:**
- [ ] `##` scopes distinctly from `#`
- [ ] All string forms scope: plain, `r`/`&`/`^` prefixed, single, double, triple-quoted
- [ ] Escape sequences scope inside non-raw strings and not inside raw strings
- [ ] Integer, float, hex, and binary literals scope, including `_` separators
- [ ] `1..2` scopes as two integers, not a float

**Verify:** `npx vscode-tmgrammar-test "tests/grammar/**/*.fs"` → all assertions pass

**Steps:**

- [ ] **Step 1: Write the failing scope tests**

Assertion lines begin with `#`, then carets aligned under the token being asserted. `# <-` asserts column 0.

Create `tests/grammar/comments.fs`:

```
# SYNTAX TEST "source.foundryscript"

## A documentation comment
# <- comment.line.documentation.foundryscript

# An ordinary comment
# <- comment.line.number-sign.foundryscript
```

Create `tests/grammar/strings.fs`:

```
# SYNTAX TEST "source.foundryscript"

var a = "hello\n"
#       ^ punctuation.definition.string.begin.foundryscript
#             ^^ constant.character.escape.foundryscript

var b = 'single'
#       ^^^^^^^^ string.quoted.foundryscript

var c = &"string_name"
#       ^ storage.type.string.foundryscript

var d = ^"Node/Path"
#       ^ storage.type.string.foundryscript

var e = r"raw\nnot_escape"
#       ^ storage.type.string.foundryscript
#             ^^ string.quoted.raw.foundryscript

var f = """triple quoted"""
#       ^^^ punctuation.definition.string.begin.foundryscript

var g = '''triple single'''
#       ^^^ punctuation.definition.string.begin.foundryscript

var h = "bad \q escape"
#            ^^ invalid.illegal.unknown-escape.foundryscript

var bad = "unterminated
var after = 1
#           ^ constant.numeric.integer.foundryscript

var cont = "a\
b"
# <- string.quoted.foundryscript

var rawc = r"a\
var after2 = 1
#            ^ constant.numeric.integer.foundryscript
```

The last two cases are a matched pair guarding the line-continuation carve-out in `#string-short`. A non-raw string with a trailing backslash **must** continue onto the next line (`GRAMMAR.md` §2.6.2 lists line continuation among the escapes valid in non-raw strings). A raw string with the same trailing backslash **must not** — that backslash is literal content, so the string still ends at the newline. Bounding short strings without this carve-out silently breaks every continued string in the corpus.

The triple-quoted case is deliberately kept on one line. An assertion line placed inside an open multiline string is ambiguous — it is both a scope assertion and string content — so multiline string behavior is left to the corpus check in Task 6 instead.

The `r"raw\nnot_escape"` assertion is the important one: in a raw string `\n` is literal text, so it must carry the string scope and **not** `constant.character.escape`.

Create `tests/grammar/numbers.fs`:

```
# SYNTAX TEST "source.foundryscript"

var a = 100
#       ^^^ constant.numeric.integer.foundryscript

var b = 1_000_000
#       ^^^^^^^^^ constant.numeric.integer.foundryscript

var c = 0xFF_00
#       ^^^^^^^ constant.numeric.hex.foundryscript

var d = 0b1010
#       ^^^^^^ constant.numeric.binary.foundryscript

var e = 3.14
#       ^^^^ constant.numeric.float.foundryscript

var f = 1e10
#       ^^^^ constant.numeric.float.foundryscript

var g = 1..2
#       ^ constant.numeric.integer.foundryscript
#          ^ constant.numeric.integer.foundryscript

var t = tup.0
#           ^ - constant.numeric.integer.foundryscript
```

The last two cases are a matched pair and must stay together. `1..2` pins that the range operator's second dot still permits an integer; `tup.0` pins, via a **negative** assertion, that single-dot member access does not. Together they are what stops someone simplifying the integer pattern's nested lookbehind back to `(?<!\w)` — which would keep the `1..2` case green while silently breaking tuple index access.

Three further assertions in `strings.fs` are load-bearing in the same way:

- `invalid.illegal.unknown-escape` is the exact scope Task 6's corpus gate keys on. Without an assertion, renaming or dropping it leaves every test green while the gate silently stops catching anything.
- The unterminated-string case pins that a short string is line-bounded. If it leaks, the following line's `1` scopes as string rather than a number. This matters beyond highlighting: a leaked string converts downstream code to `string.quoted`, which **suppresses** any genuine `invalid.illegal` below it, so Task 6 would pass vacuously on that file.
- `'''` covers the triple-single-quote form, which is otherwise untested.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vscode-tmgrammar-test "tests/grammar/**/*.fs"`
Expected: FAIL — the grammar file does not exist.

- [ ] **Step 3: Create the grammar with the lexical core**

Create `syntaxes/foundryscript.tmLanguage.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
  "name": "FoundryScript",
  "scopeName": "source.foundryscript",
  "patterns": [
    { "include": "#comments" },
    { "include": "#strings" },
    { "include": "#numbers" }
  ],
  "repository": {
    "comments": {
      "patterns": [
        {
          "name": "comment.line.documentation.foundryscript",
          "match": "##.*$"
        },
        {
          "name": "comment.line.number-sign.foundryscript",
          "match": "#.*$"
        }
      ]
    },
    "strings": {
      "comment": "GRAMMAR.md 2.6.2 splits short_string (single-line by construction) from long_string (triple-quoted, multiline). The two are separate rules here so an unterminated short string cannot swallow the rest of the file. ORDER IS LOAD-BEARING TWICE: raw before non-raw, or the r prefix falls outside the string scope; triple before short, or a \"\"\" opener is consumed as an empty \"\" followed by a stray quote.",
      "patterns": [
        { "include": "#string-raw-triple" },
        { "include": "#string-raw-short" },
        { "include": "#string-triple" },
        { "include": "#string-short" }
      ]
    },
    "string-raw-triple": {
      "comment": "GRAMMAR.md 2.6.2 long_string with the raw prefix. Backslash is literal except \\\" \\' \\\\.",
      "name": "string.quoted.raw.foundryscript",
      "begin": "\\b(r)(\"\"\"|''')",
      "beginCaptures": {
        "1": { "name": "storage.type.string.foundryscript" },
        "2": { "name": "punctuation.definition.string.begin.foundryscript" }
      },
      "end": "\\2",
      "endCaptures": {
        "0": { "name": "punctuation.definition.string.end.foundryscript" }
      },
      "patterns": [
        {
          "name": "constant.character.escape.foundryscript",
          "match": "\\\\[\"'\\\\]"
        }
      ]
    },
    "string-raw-short": {
      "comment": "GRAMMAR.md 2.6.2 short_string with the raw prefix. Ends at an explicit newline so an unterminated string cannot leak into following lines. Unlike #string-short there is NO line-continuation carve-out: 2.6.2 lists line continuation among the escapes valid in NON-raw strings only, so a trailing backslash in a raw string is literal content and the string still ends. The unterminated tail is deliberately left UNSCOPED rather than marked invalid.illegal, so that scope keeps a single unambiguous meaning for the Task 6 corpus gate.",
      "name": "string.quoted.raw.foundryscript",
      "begin": "\\b(r)(\"|')",
      "beginCaptures": {
        "1": { "name": "storage.type.string.foundryscript" },
        "2": { "name": "punctuation.definition.string.begin.foundryscript" }
      },
      "end": "(\\2)|\\n",
      "endCaptures": {
        "1": { "name": "punctuation.definition.string.end.foundryscript" }
      },
      "patterns": [
        {
          "name": "constant.character.escape.foundryscript",
          "match": "\\\\[\"'\\\\]"
        }
      ]
    },
    "string-triple": {
      "comment": "GRAMMAR.md 2.6.2 long_string. & is StringName, ^ is NodePath.",
      "name": "string.quoted.foundryscript",
      "begin": "(&|\\^)?(\"\"\"|''')",
      "beginCaptures": {
        "1": { "name": "storage.type.string.foundryscript" },
        "2": { "name": "punctuation.definition.string.begin.foundryscript" }
      },
      "end": "\\2",
      "endCaptures": {
        "0": { "name": "punctuation.definition.string.end.foundryscript" }
      },
      "patterns": [
        { "include": "#string-escapes" }
      ]
    },
    "string-short": {
      "comment": "GRAMMAR.md 2.6.2 short_string. Ends at an explicit newline, EXCEPT one preceded by a backslash - that is the line-continuation escape (2.6.2), so the string legitimately spans lines. Matching \\n literally rather than using $ is required: Oniguruma's $ also matches AFTER the trailing newline, where a (?<!\\\\) lookbehind sees the newline instead of the backslash and the carve-out silently fails.",
      "name": "string.quoted.foundryscript",
      "begin": "(&|\\^)?(\"|')",
      "beginCaptures": {
        "1": { "name": "storage.type.string.foundryscript" },
        "2": { "name": "punctuation.definition.string.begin.foundryscript" }
      },
      "end": "(\\2)|(?<!\\\\)\\n",
      "endCaptures": {
        "1": { "name": "punctuation.definition.string.end.foundryscript" }
      },
      "patterns": [
        { "include": "#string-escapes" }
      ]
    },
    "string-escapes": {
      "patterns": [
        {
          "name": "constant.character.escape.foundryscript",
          "match": "\\\\(?:[abfnrtv'\"\\\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{6}|$)"
        },
        {
          "name": "invalid.illegal.unknown-escape.foundryscript",
          "match": "\\\\."
        }
      ]
    },
    "numbers": {
      "comment": "GRAMMAR.md 2.6.1. The (?<![\\w.]) guard keeps tuple index access (t.0) and member chains from lexing as floats; the (?!\\.) guard keeps 1..2 from lexing 1. as a float.",
      "patterns": [
        {
          "comment": "The (?<!\\.) guard matches the integer pattern's: a digit after a PERIOD lexes as decimal integer only (GRAMMAR.md 2.6.1), so t.0x1 must not scope as hex.",
          "name": "constant.numeric.hex.foundryscript",
          "match": "(?<!\\.)\\b0[xX][0-9A-Fa-f](?:_?[0-9A-Fa-f])*\\b"
        },
        {
          "comment": "See the hex pattern's note on the (?<!\\.) guard.",
          "name": "constant.numeric.binary.foundryscript",
          "match": "(?<!\\.)\\b0[bB][01](?:_?[01])*\\b"
        },
        {
          "name": "constant.numeric.float.foundryscript",
          "match": "(?<![\\w.])(?:\\d(?:_?\\d)*\\.(?!\\.)(?:\\d(?:_?\\d)*)?(?:[eE][+-]?\\d(?:_?\\d)*)?|\\.(?!\\.)\\d(?:_?\\d)*(?:[eE][+-]?\\d(?:_?\\d)*)?|\\d(?:_?\\d)*[eE][+-]?\\d(?:_?\\d)*)"
        },
        {
          "comment": "The guard must reject a digit after a SINGLE dot (tuple index access `t.0`, GRAMMAR.md 2.6.1) while accepting one after the SECOND dot of a range operator (`1..2`). A plain (?<![\\w.]) rejects both, which wrongly leaves the 2 in 1..2 unscoped.",
          "name": "constant.numeric.integer.foundryscript",
          "match": "(?<!\\w)(?<!(?<!\\.)\\.)\\d(?:_?\\d)*\\b"
        }
      ]
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vscode-tmgrammar-test "tests/grammar/**/*.fs"`
Expected: PASS — all three files green.

If `1..2` fails, the `(?!\\.)` guard in the float pattern was dropped. If the raw-string escape assertion fails, `string-raw` is not ordered before `string-quoted` in the `strings` repository entry.

- [ ] **Step 5: Restore the full test script**

Edit `package.json`, reverting the Task 1 Step 8 change:

```json
    "test": "npm run test:unit && npm run test:grammar",
```

- [ ] **Step 6: Verify the whole suite**

Run: `npm test`
Expected: unit tests and grammar tests both pass.

- [ ] **Step 7: Commit**

```bash
git add syntaxes tests/grammar package.json
git commit -m "feat: add grammar test harness and lexical core

Comments, strings, and numbers per GRAMMAR.md 2.6."
```

---

### Task 4: Keywords, constants, and annotations

**Goal:** Every reserved keyword from `GRAMMAR.md` §2.5 scopes correctly, and the contextual keywords get documented heuristics.

**Files:**
- Modify: `syntaxes/foundryscript.tmLanguage.json`
- Create: `tests/grammar/keywords.fs`
- Create: `tests/grammar/contextual-keywords.fs`
- Create: `tests/grammar/annotations.fs`

**Acceptance Criteria:**
- [ ] Every keyword in `GRAMMAR.md` §2.5 scopes as a keyword
- [ ] No token scopes as a keyword that §2.5 does not list
- [ ] `yield` scopes as invalid — §2.5 states it is reserved but always an error
- [ ] `INF`, `NAN`, `PI`, `TAU` scope as language constants
- [ ] `extend` at root scopes as a keyword; `extend` elsewhere does not
- [ ] `async` before `func` scopes as a modifier; `async` elsewhere does not
- [ ] `@name` annotations scope

**Verify:** `npx vscode-tmgrammar-test "tests/grammar/**/*.fs"` → all assertions pass

**Steps:**

- [ ] **Step 1: Write the failing scope tests**

Create `tests/grammar/keywords.fs`:

```
# SYNTAX TEST "source.foundryscript"

if health <= 0:
# <- keyword.control.foundryscript

while running:
# <- keyword.control.foundryscript

await coroutine
# <- keyword.control.foundryscript

func take_damage():
# <- keyword.declaration.foundryscript

var health = 0
# <- keyword.declaration.foundryscript

static func helper():
# <- storage.modifier.foundryscript

var is_ready = a and b
#                ^^^ keyword.operator.word.foundryscript

var check = value is int
#                 ^^ keyword.operator.word.foundryscript

var t = true
#       ^^^^ constant.language.foundryscript

var i = INF
#       ^^^ constant.language.numeric.foundryscript

yield
# <- invalid.illegal.yield.foundryscript
```

Create `tests/grammar/contextual-keywords.fs`:

```
# SYNTAX TEST "source.foundryscript"

extend int uses Describable:
# <- keyword.declaration.extend.foundryscript
#      ^^^ entity.name.type.foundryscript

async func fetch() -> Coroutine[int]:
# <- storage.modifier.async.foundryscript

annotation my_marker targets CLASS, METHOD
# <- keyword.declaration.annotation.foundryscript
#                    ^^^^^^^ keyword.other.targets.foundryscript
#                            ^^^^^^^^^^^^^ support.constant.target.foundryscript

var extend = 1
#   ^^^^^^ - keyword.declaration.extend.foundryscript

var async = 2
#   ^^^^^ - storage.modifier.async.foundryscript

    get:
#   ^^^ storage.modifier.accessor.foundryscript

    get():
#   ^^^ storage.modifier.accessor.foundryscript

    set(value):
#   ^^^ storage.modifier.accessor.foundryscript

    get = get_health
#   ^^^ storage.modifier.accessor.foundryscript

var get = 5
#   ^^^ - storage.modifier.accessor.foundryscript

    dict = {get = 1}
#           ^^^ - storage.modifier.accessor.foundryscript

    obj.set = 3
#       ^^^ - storage.modifier.accessor.foundryscript
```

The accessor cases are a matched set. GRAMMAR.md §4.4 defines four accessor forms — `get:`, `get():`, `set(value):`, and the pointer style `get = method` — and all four must scope. The three negative cases pin the reason the pattern is anchored to line start: without that anchor it fires on any identifier named `get` or `set` followed by `=`, which is ordinary legal code.

The final two cases are the point of this file: `extend` and `async` are ordinary identifiers outside their declaration positions (`GRAMMAR.md` §2.5, §4.7, §4.8).

These use `vscode-tmgrammar-test`'s **negative** assertion form (`- scope`), which asserts the token does *not* carry that scope. A positive assertion would be useless here — every token carries the base `source.foundryscript` scope, so asserting it would pass even when the grammar wrongly also applied `keyword`.

Create `tests/grammar/annotations.fs`:

```
# SYNTAX TEST "source.foundryscript"

@export
# <- entity.name.function.decorator.foundryscript

@onready var node = null
# <- entity.name.function.decorator.foundryscript

@my_custom(1, 2)
# <- entity.name.function.decorator.foundryscript
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vscode-tmgrammar-test "tests/grammar/**/*.fs"`
Expected: FAIL on `keywords.fs`, `contextual-keywords.fs`, `annotations.fs`.

- [ ] **Step 3: Add the patterns to the grammar**

In `syntaxes/foundryscript.tmLanguage.json`, replace the top-level `patterns` array with:

```json
  "patterns": [
    { "include": "#comments" },
    { "include": "#strings" },
    { "include": "#numbers" },
    { "include": "#contextual-keywords" },
    { "include": "#annotations" },
    { "include": "#keywords" }
  ],
```

Order matters. `#contextual-keywords` must precede `#keywords` so that the multi-token `extend`/`annotation` forms win over any single-word match.

Then add these entries to `repository`:

```json
    "keywords": {
      "comment": "GRAMMAR.md 2.5. Keep this list in sync with the tokenizer keyword table.",
      "patterns": [
        {
          "name": "keyword.control.foundryscript",
          "match": "\\b(?:if|elif|else|for|while|match|when|break|breakpoint|continue|pass|return|await)\\b"
        },
        {
          "name": "keyword.declaration.foundryscript",
          "match": "\\b(?:class|class_name|trait|trait_name|enum|enum_name|tuple|tuple_name|func|var|const|signal|namespace|import)\\b"
        },
        {
          "name": "storage.modifier.foundryscript",
          "match": "\\b(?:static|final|abstract|extends|uses)\\b"
        },
        {
          "name": "keyword.operator.word.foundryscript",
          "match": "\\b(?:and|or|not|in|is|as)\\b"
        },
        {
          "name": "keyword.other.foundryscript",
          "match": "\\b(?:assert|preload|self|super|void)\\b"
        },
        {
          "comment": "GRAMMAR.md 2.5: yield is reserved but always an error - use await.",
          "name": "invalid.illegal.yield.foundryscript",
          "match": "\\byield\\b"
        },
        {
          "comment": "GRAMMAR.md 2.6.3: true/false/null are identifiers resolved during analysis, not keywords.",
          "name": "constant.language.foundryscript",
          "match": "\\b(?:true|false|null)\\b"
        },
        {
          "name": "constant.language.numeric.foundryscript",
          "match": "\\b(?:INF|NAN|PI|TAU)\\b"
        }
      ]
    },
    "contextual-keywords": {
      "comment": "GRAMMAR.md 2.5 contextual keywords. These are lexed as ordinary identifiers and given meaning by position, so every pattern here is a heuristic. Exact classification arrives with textDocument/semanticTokens (cafecito-games/Foundry#1418).",
      "patterns": [
        {
          "comment": "GRAMMAR.md 4.8. `extend` is root-only, so anchoring at column 0 doubles as the root check. LIMITATION: misses a conformance whose `uses` clause is on a line continuation.",
          "match": "^(extend)\\s+([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)\\s+(?=uses\\b)",
          "captures": {
            "1": { "name": "keyword.declaration.extend.foundryscript" },
            "2": { "name": "entity.name.type.foundryscript" }
          }
        },
        {
          "comment": "GRAMMAR.md 4.7. Root-only, same anchoring rationale as `extend`. LIMITATION: misses a declaration whose `targets` clause is on a line continuation.",
          "match": "^(annotation)\\s+([A-Za-z_]\\w*)",
          "captures": {
            "1": { "name": "keyword.declaration.annotation.foundryscript" },
            "2": { "name": "entity.name.function.annotation.foundryscript" }
          }
        },
        {
          "comment": "GRAMMAR.md 4.7 target list. Target names are uppercase identifiers, so this is safe to match anywhere a `targets` clause shape appears.",
          "match": "\\b(targets)\\s+((?:CLASS|METHOD|VARIABLE|SIGNAL|CONSTANT|PARAMETER)(?:\\s*,\\s*(?:CLASS|METHOD|VARIABLE|SIGNAL|CONSTANT|PARAMETER))*)",
          "captures": {
            "1": { "name": "keyword.other.targets.foundryscript" },
            "2": { "name": "support.constant.target.foundryscript" }
          }
        },
        {
          "comment": "GRAMMAR.md 4.5. `async` is a modifier only immediately before `func` or another modifier run ending in `func`. LIMITATION: an `async` separated from its `func` by a line continuation is missed.",
          "name": "storage.modifier.async.foundryscript",
          "match": "\\basync\\b(?=(?:\\s+(?:static|final|abstract))*\\s+func\\b)"
        },
        {
          "comment": "GRAMMAR.md 4.4 property accessors, covering all four forms: get:, get():, set(value):, and the pointer style get = method. Anchored to the start of the line because accessors occupy their own line in a property_block; without that anchor this fires on any identifier named get or set followed by = -- `var get = 5`, `func f(get = 1)`, `{get = 1}`, `obj.set = 3` all false-positive. LIMITATION: the single-line inline_property form (`var x: int = 1: get = a, set = b`) is missed, since those accessors are mid-line. A false negative is the safer direction.",
          "name": "storage.modifier.accessor.foundryscript",
          "match": "^\\s*(?:get|set)\\b(?=\\s*(?:\\([^)]*\\))?\\s*[:=])"
        }
      ]
    },
    "annotations": {
      "comment": "GRAMMAR.md 2.7 - @ plus identifier is a single ANNOTATION token.",
      "name": "entity.name.function.decorator.foundryscript",
      "match": "@[A-Za-z_]\\w*"
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vscode-tmgrammar-test "tests/grammar/**/*.fs"`
Expected: PASS — all six files green.

If `var extend = 1` fails by scoping `extend` as a keyword, the `^` anchor was dropped from the contextual pattern. If `async func` fails, check that `#contextual-keywords` precedes `#keywords` in the top-level `patterns` array.

- [ ] **Step 5: Cross-check the keyword list against the specification**

Open `~/CafecitoGames/Foundry/modules/foundry_script/GRAMMAR.md` §2.5 and confirm every keyword in the fenced block appears in exactly one alternation in `#keywords`, and that no word appears there which §2.5 does not list. This is the manual stand-in for the drift check that issue #5 automates.

Expected: **44** keywords accounted for across the `keyword.control` (13), `keyword.declaration` (14), `storage.modifier` (5), `keyword.operator.word` (6), `keyword.other` (5), and `invalid.illegal.yield` (1) patterns.

- [ ] **Step 6: Commit**

```bash
git add syntaxes tests/grammar
git commit -m "feat: add keyword, contextual keyword, and annotation scopes"
```

---

### Task 5: Declarations, types, and node paths

**Goal:** Declared names, type references, and get-node paths scope as entities rather than plain text.

**Files:**
- Modify: `syntaxes/foundryscript.tmLanguage.json`
- Create: `tests/grammar/declarations.fs`
- Create: `tests/grammar/node-paths.fs`

**Acceptance Criteria:**
- [ ] `func name` scopes `name` as a function entity
- [ ] `class_name`, `trait_name`, `enum_name`, `tuple_name`, `class`, `trait` scope the declared name as a type entity
- [ ] `namespace`/`import` scope the dotted name as a namespace entity
- [ ] `extends`/`uses` scope their operands as type entities
- [ ] Built-in types scope as `support.type`
- [ ] `$Node/Path`, `%Unique`, and `$"quoted/path"` scope

**Verify:** `npx vscode-tmgrammar-test "tests/grammar/**/*.fs"` → all assertions pass

**Steps:**

- [ ] **Step 1: Write the failing scope tests**

Create `tests/grammar/declarations.fs`:

```
# SYNTAX TEST "source.foundryscript"

namespace Game.Combat
#         ^^^^^^^^^^^ entity.name.namespace.foundryscript

import Game.Entities
#      ^^^^^^^^^^^^^ entity.name.namespace.foundryscript

class_name Player
#          ^^^^^^ entity.name.type.foundryscript

trait_name Damageable
#          ^^^^^^^^^^ entity.name.type.foundryscript

tuple_name Pair
#          ^^^^ entity.name.type.foundryscript

extends CharacterBody2D
#       ^^^^^^^^^^^^^^^ entity.name.type.foundryscript

uses Damageable
#    ^^^^^^^^^^ entity.name.type.foundryscript

func take_damage(amount: int) -> void:
#    ^^^^^^^^^^^ entity.name.function.foundryscript
#                        ^^^ support.type.builtin.foundryscript

var items: Array = []
#          ^^^^^ support.type.builtin.foundryscript
```

Create `tests/grammar/node-paths.fs`:

```
# SYNTAX TEST "source.foundryscript"

var sprite = $Sprite2D
#            ^ keyword.operator.getnode.foundryscript
#             ^^^^^^^^ variable.other.nodepath.foundryscript

var child = $Enemy/Health
#            ^^^^^^^^^^^^ variable.other.nodepath.foundryscript

var unique = %HealthBar
#            ^ keyword.operator.getnode.foundryscript

var quoted = $"Some Node/Child"
#            ^ keyword.operator.getnode.foundryscript
#             ^ punctuation.definition.string.begin.foundryscript
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vscode-tmgrammar-test "tests/grammar/**/*.fs"`
Expected: FAIL on `declarations.fs` and `node-paths.fs`.

- [ ] **Step 3: Add the patterns to the grammar**

Replace the top-level `patterns` array with:

```json
  "patterns": [
    { "include": "#comments" },
    { "include": "#node-paths" },
    { "include": "#strings" },
    { "include": "#numbers" },
    { "include": "#contextual-keywords" },
    { "include": "#declarations" },
    { "include": "#annotations" },
    { "include": "#builtin-types" },
    { "include": "#keywords" }
  ],
```

**Only one of these orderings is load-bearing: `#declarations` before `#keywords`.** Both match at the keyword's start position, so list order is what breaks the tie; swapping them costs `class Foo:`, `func f():`, and `extends Node2D` their entity scopes.

`#node-paths` before `#strings` looks load-bearing but is not. The quoted-path rule `([$%])(?=["'])` matches at the `$`, strictly left of the `"` where `#strings` would begin, so TextMate's leftmost rule decides regardless of list order. Verified by permuting the array: swapping those two changes nothing. Do not treat this as a constraint, and do not diagnose a broken `$"quoted/path"` by looking at it.

`#node-paths` must also match the **whole path as one unit**, not segment by segment. `GRAMMAR.md` §5.5 accepts a broad set of keywords as node names, so `$Player/for` is a legal path. Matching the full path from the `$` means TextMate's leftmost rule hands the entire span to `#node-paths` before `#keywords` can reach the `for`. Segment-wise matching would leave keyword highlighting bleeding into path components.

Add to `repository`:

```json
    "declarations": {
      "comment": "GRAMMAR.md 3.1, 3.2, 3.3, 4.2, 4.5. Two-token forms so the declared name scopes as an entity.",
      "patterns": [
        {
          "match": "\\b(namespace|import)\\s+([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)",
          "captures": {
            "1": { "name": "keyword.declaration.foundryscript" },
            "2": { "name": "entity.name.namespace.foundryscript" }
          }
        },
        {
          "match": "\\b(class_name|trait_name|enum_name|tuple_name|class|trait|enum)\\s+([A-Za-z_]\\w*)",
          "captures": {
            "1": { "name": "keyword.declaration.foundryscript" },
            "2": { "name": "entity.name.type.foundryscript" }
          }
        },
        {
          "comment": "GRAMMAR.md 3.3. The string form (extends \"res://base.fs\") is left to #strings.",
          "match": "\\b(extends|uses)\\s+([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)",
          "captures": {
            "1": { "name": "storage.modifier.foundryscript" },
            "2": { "name": "entity.name.type.foundryscript" }
          }
        },
        {
          "match": "\\b(func)\\s+([A-Za-z_]\\w*)",
          "captures": {
            "1": { "name": "keyword.declaration.foundryscript" },
            "2": { "name": "entity.name.function.foundryscript" }
          }
        }
      ]
    },
    "builtin-types": {
      "comment": "GRAMMAR.md 7 plus the engine's full Variant set (core/variant/variant.h). The boundary is deliberate: the 14 names GRAMMAR.md itself lists, plus every Variant type -- not an arbitrary subset, so a reader can predict what is here. Matched BY NAME rather than by position, because a general `identifier: Type` rule cannot be told apart from a dictionary literal or a match arm and false-positives constantly. ACCEPTED COST of name matching: a user-defined class or a local variable named Color, Type, or int is painted as a builtin. User-defined types in annotation position stay unscoped until semanticTokens lands (cafecito-games/Foundry#1418).",
      "name": "support.type.builtin.foundryscript",
      "match": "\\b(?:int|float|bool|String|StringName|NodePath|Array|Dictionary|Callable|AsyncCallable|Signal|Coroutine|Type|Variant|Object|RID|Vector2|Vector2i|Vector3|Vector3i|Vector4|Vector4i|Rect2|Rect2i|Transform2D|Transform3D|Projection|Basis|Quaternion|Plane|AABB|Color|PackedByteArray|PackedInt32Array|PackedInt64Array|PackedFloat32Array|PackedFloat64Array|PackedStringArray|PackedVector2Array|PackedVector3Array|PackedVector4Array|PackedColorArray)\\b"
    },
    "node-paths": {
      "comment": "GRAMMAR.md 5.5 get-node expressions.",
      "patterns": [
        {
          "comment": "Quoted form: scope the sigil, then let #strings handle the literal. Carries the same % left boundary as the bare form -- see its comment.",
          "match": "([$]|(?<![\\w)\\]])%)(?=[\"'])",
          "captures": {
            "1": { "name": "keyword.operator.getnode.foundryscript" }
          }
        },
        {
          "comment": "Bare form, including the leading-% unique-name marker on any segment. The whole path is matched as ONE unit, not segment by segment: 5.5 accepts keywords as node names, so `$Player/for` is legal, and matching the full span from the sigil lets TextMate's leftmost rule hand it to this rule before #keywords can reach the `for`. The % branch carries a left boundary because 2.8 gives % double duty as modulo -- without it `x%y`, `arr[0]%n` and `f(1)%n` all paint a node path onto valid arithmetic. LIMITATION: `x %y` (space before, none after) is still mis-scoped; distinguishing it needs variable-length lookbehind, which Oniguruma does not support.",
          "match": "([$]|(?<![\\w)\\]])%)(%?[A-Za-z_]\\w*(?:/%?[A-Za-z_]\\w*)*)",
          "captures": {
            "1": { "name": "keyword.operator.getnode.foundryscript" },
            "2": { "name": "variable.other.nodepath.foundryscript" }
          }
        }
      ]
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vscode-tmgrammar-test "tests/grammar/**/*.fs"`
Expected: PASS — all eight files green.

If `class_name Player` scopes `Player` as plain text, `#declarations` is not ordered before `#keywords` — that is the one top-level ordering that matters. A broken `$"quoted/path"` is NOT an ordering problem; look at the `#node-paths` quoted-form pattern itself.

- [ ] **Step 5: Verify visually**

Run: `npm run build`, press F5, and open a real `.fs` file from `~/CafecitoGames/Foundry/modules/foundry_script/tests/scripts/`. Confirm keywords, strings, comments, declared names, and node paths are all colored, and that nothing is conspicuously miscolored.

- [ ] **Step 6: Commit**

```bash
git add syntaxes tests/grammar
git commit -m "feat: add declaration, type, and node path scopes

Closes #3"
```

---

### Task 6: Corpus regression check

**Goal:** Catch grammar bugs that hand-written tests miss, by tokenizing every `.fs` file in an engine checkout and asserting that valid code never produces an `invalid.illegal` scope.

**Files:**
- Create: `scripts/check-corpus.mjs`
- Modify: `.github/workflows/ci.yml`

**Acceptance Criteria:**
- [ ] Tokenizes every `.fs` file under `$FOUNDRY_ENGINE_PATH`
- [ ] Fails with file and line when any token scopes `invalid.illegal.*`, except `invalid.illegal.yield` which is a correct classification
- [ ] Skips cleanly with a clear message when `FOUNDRY_ENGINE_PATH` is unset
- [ ] Runs in CI without an engine checkout and does not fail the build

**Verify:** `FOUNDRY_ENGINE_PATH=~/CafecitoGames/Foundry node scripts/check-corpus.mjs` → reports files scanned, exits 0

**Steps:**

- [ ] **Step 1: Write the check script**

This is a script rather than a Vitest test because it is a corpus sweep whose input is an external checkout, not a unit under test. It reports every offender rather than stopping at the first, so one run gives the full picture.

Create `scripts/check-corpus.mjs`:

```js
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// vscode-oniguruma and vscode-textmate are CommonJS. A namespace import yields a
// module wrapper whose members are not callable (`oniguruma.loadWASM is not a
// function`), so require them explicitly.
const require = createRequire(import.meta.url);
const oniguruma = require("vscode-oniguruma");
const textmate = require("vscode-textmate");

const enginePath = process.env.FOUNDRY_ENGINE_PATH;
if (!enginePath) {
  console.log(
    "FOUNDRY_ENGINE_PATH is not set - skipping the corpus check.\n" +
      "Set it to a Foundry engine checkout to run this locally:\n" +
      "  FOUNDRY_ENGINE_PATH=~/CafecitoGames/Foundry npm run test:corpus",
  );
  process.exit(0);
}

// `yield` is reserved but always an error (GRAMMAR.md 2.5), so scoping it
// invalid is correct rather than a grammar bug.
const ALLOWED_INVALID = ["invalid.illegal.yield"];

async function makeRegistry() {
  const wasmPath = require.resolve("vscode-oniguruma/release/onig.wasm");
  await oniguruma.loadWASM(await readFile(wasmPath));

  const grammarSource = await readFile(
    new URL("../syntaxes/foundryscript.tmLanguage.json", import.meta.url),
    "utf8",
  );

  return new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (source) => new oniguruma.OnigString(source),
    }),
    loadGrammar: async (scopeName) =>
      scopeName === "source.foundryscript"
        ? textmate.parseRawGrammar(grammarSource, "foundryscript.tmLanguage.json")
        : null,
  });
}

async function* findScripts(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "bin" || entry.name === "thirdparty") {
        continue;
      }
      yield* findScripts(full);
    } else if (entry.name.endsWith(".fs")) {
      yield full;
    }
  }
}

const registry = await makeRegistry();
const grammar = await registry.loadGrammar("source.foundryscript");
if (!grammar) {
  console.error("Failed to load source.foundryscript");
  process.exit(1);
}

const failures = [];
let scanned = 0;

for await (const file of findScripts(enginePath)) {
  const source = await readFile(file, "utf8");
  let ruleStack = textmate.INITIAL;
  let lineNumber = 0;

  // The \r? is load-bearing, not cosmetic. A CR surviving into the line text
  // turns a line-continuation backslash into invalid.illegal.unknown-escape and
  // cascades into the following line, so a CRLF checkout would fail this gate on
  // valid engine code. Real VS Code is unaffected -- getLineContent() strips the
  // full EOL -- so this only bites tooling that splits a file itself.
  for (const line of source.split(/\r?\n/)) {
    lineNumber += 1;
    const result = grammar.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;

    for (const token of result.tokens) {
      for (const scope of token.scopes) {
        if (
          scope.startsWith("invalid.illegal") &&
          !ALLOWED_INVALID.some((allowed) => scope.startsWith(allowed))
        ) {
          failures.push(
            `${path.relative(enginePath, file)}:${lineNumber} ` +
              `"${line.slice(token.startIndex, token.endIndex)}" scoped ${scope}`,
          );
        }
      }
    }
  }

  scanned += 1;
}

console.log(`Scanned ${scanned} .fs files.`);

if (failures.length > 0) {
  console.error(`\n${failures.length} unexpected invalid scope(s):\n`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log("No unexpected invalid scopes.");
```

- [ ] **Step 2: Run it against the engine checkout**

Run: `FOUNDRY_ENGINE_PATH=~/CafecitoGames/Foundry node scripts/check-corpus.mjs`
Expected: `Scanned <N> .fs files.` followed by `No unexpected invalid scopes.`, exit 0.

The engine has roughly 2,135 `.fs` files outside worktrees, so expect a count in that range.

**Settled question — escapes inside triple-quoted strings.** `GRAMMAR.md` §2.6.2 is ambiguous here: its EBNF gives `long_string` a content production admitting any character with no escape rule, while its prose says escapes apply to "non-raw strings" (which a long string is). This matters because if escapes did *not* apply, every engine docstring containing a stray backslash would scope `invalid.illegal.unknown-escape` and false-fail this gate.

Resolved against the reference implementation: in `modules/foundry_script/fs_tokenizer.cpp` the escape branch is gated on `is_raw` **only**, never on `is_multiline`. Escapes therefore do apply inside triple-quoted strings, `#string-triple` correctly includes `#string-escapes`, and an invalid escape in a docstring is a genuine lexer error — so flagging it here is a true positive. Do not "fix" it by dropping the include.

- [ ] **Step 3: Fix any grammar bugs the corpus surfaces**

If the run reports failures, each one is a real grammar bug — the corpus is valid FoundryScript. The most likely cause is the `invalid.illegal.unknown-escape` pattern firing on a legitimate escape sequence that `GRAMMAR.md` §2.6.2 permits but the grammar's escape alternation omits.

For each distinct failure, add a scope assertion to the relevant file in `tests/grammar/` reproducing it, watch it fail, then fix the grammar. Do not fix a corpus failure without first capturing it as a scope test.

- [ ] **Step 4: Verify the skip path**

Run: `node scripts/check-corpus.mjs`
Expected: the skip message, exit 0.

- [ ] **Step 4b: Add the negative-assertion vacuity scan**

Create `scripts/check-assertions.mjs`. It replicates the runner's own token-selection filter and fails if any negative assertion selects zero tokens — the silent-pass case described in the negative-assertion policy section above.

```js
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Mirrors vscode-tmgrammar-test's own parsing: an assertion line must start
// with the comment token in column 1, and its carets index the line above.
const ASSERTION = /^#\s*(?:(<-)|(\^+))\s*(.*)$/;

const directory = new URL("../tests/grammar/", import.meta.url);
const failures = [];

for (const name of (await readdir(directory)).filter((f) => f.endsWith(".fs"))) {
  const lines = (await readFile(new URL(name, directory), "utf8")).split(/\r?\n/);
  let previousSource = "";

  for (const [index, line] of lines.entries()) {
    const match = ASSERTION.exec(line);
    if (!match) {
      if (!line.startsWith("#")) previousSource = line;
      continue;
    }

    const [, arrow, carets, scopes] = match;
    if (!scopes.trim().split(/\s+/).every((s) => s.startsWith("-"))) continue;

    const from = arrow ? 0 : line.indexOf("^");
    const to = arrow ? 1 : from + carets.length;
    if (from >= previousSource.length) {
      failures.push(
        `${name}:${index + 1} negative assertion selects no tokens ` +
          `(columns ${from}-${to}, source line is ${previousSource.length} chars)`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} inert negative assertion(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log("All negative assertions select at least one token.");
```

Wire it into `package.json`:

```json
    "test:grammar": "vscode-tmgrammar-test \"tests/grammar/**/*.fs\" && node scripts/check-assertions.mjs",
```

Verify it works by temporarily pushing one negative assertion's carets past the end of its source line, confirming the scan fails, then restoring.

- [ ] **Step 5: Add to CI**

In `.github/workflows/ci.yml`, add after the `npm test` step:

```yaml
      - run: npm run test:corpus
```

Without `FOUNDRY_ENGINE_PATH` set in CI this takes the skip path and passes. It becomes a real gate for anyone running it locally with a checkout, and for CI later if the engine is ever made available there.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-corpus.mjs .github/workflows/ci.yml
git commit -m "test: add corpus regression check over engine .fs files

Closes #4"
```

---

### Task 7: Packaging and distribution

**Goal:** An installable `.vsix` produced by CI on every PR, with a README that sets accurate expectations.

**Files:**
- Create: `.vscodeignore`
- Create: `README.md`
- Create: `LICENSE`
- Modify: `.github/workflows/ci.yml`

**Acceptance Criteria:**
- [ ] `npm run package` produces a `.vsix`
- [ ] The `.vsix` excludes tests, sources, and scripts
- [ ] Installing the `.vsix` into a clean VS Code gives working highlighting
- [ ] CI uploads the `.vsix` as a build artifact on every PR
- [ ] README documents the `.fs`/F# conflict and its workaround

**Verify:** `npm run package && npx vsce ls` → lists only runtime files

**Steps:**

- [ ] **Step 1: Create `.vscodeignore`**

```
.github/**
.vscode/**
docs/**
scripts/**
src/**
tests/**
node_modules/**
.gitignore
esbuild.mjs
tsconfig.json
**/*.map
**/*.test.ts
```

`dist/`, `syntaxes/`, `language-configuration.json`, `package.json`, `README.md`, and `LICENSE` are what remain, which is exactly the runtime set.

- [ ] **Step 2: Create `LICENSE`**

Use the MIT license text, copyright `Cafecito Games`, year `2026`, matching the `"license": "MIT"` field set in Task 1.

- [ ] **Step 3: Create `README.md`**

```markdown
# FoundryScript for Visual Studio Code

Language support for [FoundryScript](https://github.com/cafecito-games/Foundry) (`.fs`),
the gradually-typed scripting language of the Foundry engine.

## Features

- Syntax highlighting for the full FoundryScript grammar, including namespaces, traits,
  tuples, generics, nullable types, `async`/`await`, retroactive conformances (`extend`),
  and custom annotation declarations.
- Comment toggling, bracket matching, and indentation for FoundryScript's
  indentation-sensitive block structure.

Language intelligence (completion, hover, go-to-definition, diagnostics) arrives in a
later release and will require the `foundry` binary. Nothing in this release does.

## Installation

Download the `.vsix` from a release or a CI build artifact, then:

```
code --install-extension foundryscript-<version>.vsix
```

## Known conflict: `.fs` and F#

`.fs` is also F#'s conventional extension. If you have an F# extension such as Ionide
installed, VS Code may pick the wrong language for your files. Force the association per
workspace in `.vscode/settings.json`:

```json
{
  "files.associations": {
    "*.fs": "foundryscript"
  }
}
```

## Highlighting accuracy

FoundryScript has several contextual keywords — `extend`, `async`, `annotation`,
`targets`, `get`/`set` — that are ordinary identifiers except in specific positions.
A TextMate grammar classifies these by pattern, so a small number of cases are
highlighted incorrectly. Each such case is documented in
[`syntaxes/foundryscript.tmLanguage.json`](syntaxes/foundryscript.tmLanguage.json).

These resolve once the engine's language server implements `textDocument/semanticTokens`
([cafecito-games/Foundry#1418](https://github.com/cafecito-games/Foundry/issues/1418)),
which lets the real parser correct the highlighting.

## Development

```
npm ci
npm run build
npm test
```

To run the corpus regression check against an engine checkout:

```
FOUNDRY_ENGINE_PATH=/path/to/Foundry npm run test:corpus
```

Press F5 in VS Code to launch an Extension Development Host.
```

- [ ] **Step 4: Verify packaging**

Run: `npm run build && npm run package`
Expected: `foundryscript-0.1.0.vsix` is written.

Run: `npx vsce ls`
Expected: `dist/extension.js`, `syntaxes/foundryscript.tmLanguage.json`, `language-configuration.json`, `package.json`, `README.md`, `LICENSE`. No `src/`, `tests/`, or `scripts/` entries.

- [ ] **Step 5: Verify a real install**

Run: `code --install-extension foundryscript-0.1.0.vsix`

Open a `.fs` file from the engine checkout in a fresh window. Expected: keywords, strings, comments, declared names, and node paths are highlighted.

Then run: `code --uninstall-extension cafecito-games.foundryscript`

- [ ] **Step 6: Upload the `.vsix` from CI**

In `.github/workflows/ci.yml`, add after the `npm run test:corpus` step:

```yaml
      - run: npm run package
      - uses: actions/upload-artifact@v4
        with:
          name: foundryscript-vsix
          path: "*.vsix"
```

- [ ] **Step 7: Commit**

```bash
git add .vscodeignore README.md LICENSE .github/workflows/ci.yml
git commit -m "feat: package the extension and publish CI build artifacts

Closes #6"
```

---

## Deferred to a later plan

- **Issue #5** — consume the engine-published grammar artifact. Blocked on [cafecito-games/Foundry#1418](https://github.com/cafecito-games/Foundry/issues/1418) deliverable 1. When it lands, `#keywords` in the grammar is replaced by the generated alternations and the manual cross-check in Task 4 Step 5 is replaced by the CI drift check.
- **Marketplace publication** — this plan distributes `.vsix` files from CI only. Revisit when someone asks for the marketplace.
