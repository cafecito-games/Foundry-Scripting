# FoundryScript for VS Code — Design

**Date:** 2026-07-31
**Status:** Approved, pending implementation plan

## Purpose

Provide first-class FoundryScript (`.fs`) editing support in VS Code: syntax
highlighting, language intelligence, diagnostics, build tasks, debugging, and test
running.

The extension lives in `~/CafecitoGames/FoundryScript` as its own repository. It
depends on the Foundry engine repository (`~/CafecitoGames/Foundry`) for two things: a
generated TextMate grammar published as a release artifact, and the `foundry` CLI
binary at runtime.

## Engine capabilities this design builds on

Investigation of the engine established that most of the required server-side surface
already exists. This materially shrank the design; it is recorded here because the
design is only correct while these remain true.

| Capability | Location |
|---|---|
| Language server (TCP) | `modules/foundry_script/language_server/` |
| Headless LSP command | `foundry lsp serve --port N --path <project>` (`main/cli_parser.cpp:942`) |
| Structured lint output | `foundry script lint --format=json\|sarif` (`modules/foundry_script/fs_lint.cpp:185`) |
| Debug adapter | `editor/debugger/debug_adapter/` |
| Per-test result data | `ScriptTestExecutionResult` (`modules/foundry_script/fs_script_test_execution.h:43`) |
| Grammar specification | `modules/foundry_script/GRAMMAR.md` |

The language server already implements `completion` (+`completionItem/resolve`),
`hover`, `definition`, `declaration`, `references`, `rename`/`prepareRename`,
`codeAction` (+`codeAction/resolve`), `documentSymbol`, `foldingRange`, `codeLens`,
`documentLink`, `signatureHelp`, `formatting`, and `willSaveWaitUntil`, and pushes
`textDocument/publishDiagnostics`. It defines two custom messages:
`foundry_script/capabilities` (native class list, sent on `initialized`) and
`fs_client/changeWorkspace`.

It does **not** implement `semanticTokens`, `workspace/symbol`, or `inlayHint`.
Consequently syntax highlighting cannot come from the language server and must be
carried by a TextMate grammar.

## Architecture

Five units. Each has one responsibility, a defined interface, and can be understood and
tested without reading the others. Only `client/` knows a language server exists.

```
grammar/      generated .tmLanguage.json + scope tests; no runtime code
client/       LSP transport, connection lifecycle, status reporting
diagnostics/  owns the Problems panel; arbitrates between diagnostic sources
tasks/        shells out to the foundry CLI, parses structured output
debug/        DAP configuration provider
```

`diagnostics/` is a separate unit because diagnostics arrive from two independent
sources — `publishDiagnostics` while the language server is connected, and
`script lint --format=json` when it is not. Without a single owner they double-report.
It owns exactly one `vscode.DiagnosticCollection` and enforces one rule: **LSP
diagnostics win while the client is connected; CLI diagnostics fill the gap
otherwise.**

## 1. Grammar as a release artifact

### Generation (engine repository)

`modules/foundry_script/grammar/tmlanguage_builder.py` parses the fenced keyword block
in `GRAMMAR.md` §2.5 and emits `foundryscript.tmLanguage.json`. This follows the
existing `*_builders.py` convention (`glsl_builders.py`, `gles3_builders.py`,
`scu_builders.py`).

A second script, wired into `static_checks.yml`, asserts that the keyword list in
`GRAMMAR.md` §2.5 matches the tokenizer's keyword table in `fs_tokenizer.cpp`.

This check is load-bearing. Today "keep GRAMMAR.md in sync" is a documented promise in
`AGENTS.md`; the check makes it mechanically enforced, and the grammar then inherits a
guarantee rather than an intention. Without it, grammar drift is a matter of time.

### Distribution

`release.yml` publishes `foundryscript-tmlanguage-<version>.json` as a release
artifact. The extension pins a version; `npm run sync-grammar` fetches it; **the
fetched result is committed to the extension repository.** Extension builds therefore
require neither network access nor an engine checkout.

### Scope of the grammar

The grammar covers what regular expressions can handle correctly: reserved keywords,
literals, comments and documentation comments (`##`), strings, annotations, and
`$`/`%` node paths.

For contextual keywords — `extend`, `async`, `annotation`, `targets`, `get`/`set` — it
uses positional heuristics and is accepted to be occasionally wrong. Correctness for
these cases comes from semantic tokens (§2).

## 2. Semantic tokens (engine change)

Add `FSTextDocument::semanticTokens`, registered alongside the existing document
methods in `fs_language_protocol.cpp` and advertised in the `initialize` result. The
analyzer already computes every fact required; this is plumbing, not new analysis.

**Legend:** `namespace`, `class`, `interface` (traits), `struct` (tuples), `enum`,
`enumMember`, `type`, `typeParameter`, `function`, `method`, `property`, `variable`,
`parameter`, `decorator` (annotations), `keyword`.

**Modifiers:** `declaration`, `static`, `abstract`, `final`, `async`, `readonly`
(constants), `defaultLibrary` (native classes).

This makes the cases the TextMate grammar can only guess at exact: `extend` versus
`extends`, `async`, `annotation`/`targets`, generic argument lists versus comparison
operators, and namespace-qualified type references.

`semanticTokens/full/delta` is out of scope; full refresh is acceptable at
FoundryScript file sizes.

## 3. Connection lifecycle

### Settings

- `foundryScript.lsp.mode`: `spawn` (default) | `attach` | `auto` | `off`
- `foundryScript.lsp.port`: port used in `attach` mode
- `foundryScript.enginePath`: path to the `foundry` binary

### Modes

- **spawn** — launch `foundry lsp serve --port <ephemeral> --path <project>`, wait for
  the port to accept connections, then connect. `ServerOptions` is a function returning
  a `StreamInfo` built from `net.connect`, since the server speaks TCP rather than
  stdio.
- **attach** — connect to a running editor's language server on the configured port
  (editor setting `network/language_server/remote_port`).
- **auto** — attempt `attach`, fall back to `spawn` on `ECONNREFUSED`.

### Failure handling

Two failure modes are designed for explicitly, because they are where comparable
plugins degrade badly.

**The server can disappear.** In `attach` mode it dies whenever the user closes the
editor. The client reconnects with capped exponential backoff, and a status bar item
always reflects the true state: connected, spawning, retrying, or off. Silent
degradation to "no completions and no explanation" is the specific outcome this
prevents.

**Workspace root mismatch.** The server compares the client's root against the
currently open project and warns via `window/showMessage`; it separately sends the
custom `fs_client/changeWorkspace` notification. Both are translated into a single
actionable message naming both paths, rather than surfaced raw.

## 4. Tasks and diagnostics

A task provider contributes `build`, `lint`, `test`, `format`, and `import`, mapped to
the corresponding `foundry` CLI verbs.

Lint runs with `--format=json` and feeds `diagnostics/` directly. **No problem-matcher
regular expressions are used anywhere in the extension**, which removes an entire class
of brittleness — the structured output is parsed instead.

## 5. Debugging

A debug configuration provider contributing launch type `foundryscript`, with two
configurations: `launch` (start the project via `project run`, then attach) and
`attach`, both targeting the existing DAP server.

**Open risk:** the DAP server is editor-hosted, and no `dap serve` CLI command was
found analogous to `lsp serve`. If debugging proves to require a running editor, it is
editor-attached-only until a matching CLI command is added to the engine. **A spike
must resolve this before the launch configuration shape is committed to.**

## 6. Test Explorer

`project test --runner <runner>` invokes a user-supplied runner, and `test run` is the
engine's own doctest suite. Neither exposes per-test-case results over a stable
interface, although `ScriptTestExecutionResult` carries the required data internally
(status, message, timing).

Test Explorer integration therefore requires a structured-output flag on
`project test`, mirroring what `script lint --format=json` already does. This is an
engine change and is **in scope**.

This is the least-defined component in the design. It is scoped as a spike — determine
the output schema and the runner's reporting path — before implementation, unlike §§1–4
which are ready to plan directly.

## Testing strategy

- **grammar/** — scope assertions over `.fs` files drawn from the engine's ~2,135-file
  corpus, verifying that specific tokens receive specific scopes. Golden-file snapshots
  detect unintended change; explicit assertions detect incorrectness.
- **client/** — connection lifecycle tested against a stub TCP server: connect, server
  death, reconnect backoff, mode fallback.
- **diagnostics/** — source arbitration tested directly: LSP-connected, LSP-absent, and
  transition between them, asserting no duplicate entries.
- **tasks/** — CLI output parsing tested against captured `--format=json` fixtures.
- **Engine changes** — `semanticTokens` covered by the module's existing LSP test
  harness (`modules/foundry_script/tests/test_lsp.h`).

## Out of scope

- `workspace/symbol` and `inlayHint` support
- `semanticTokens/full/delta`
- Editor and scene integration (opening scenes, `$NodePath` completion against `.tscn`)
- Language support in editors other than VS Code

## Risks

| Risk | Mitigation |
|---|---|
| DAP requires a running editor (§5) | Spike before committing to launch config shape |
| `project test` structured output undefined (§6) | Spike to define schema and reporting path |
| Grammar drifts from the tokenizer | `static_checks.yml` check tying GRAMMAR.md §2.5 to `fs_tokenizer.cpp` |
| Language server dies mid-session | Backoff reconnect plus always-visible status bar state |
| Diagnostics double-reported | Single `DiagnosticCollection` owned by `diagnostics/` |
