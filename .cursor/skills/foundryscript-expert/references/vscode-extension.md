# VS Code Extension Reference (FoundryScript)

> Patterns and APIs for working in
> **[cafecito-games/Foundry-Scripting](https://github.com/cafecito-games/Foundry-Scripting)**.

## Extension manifest (`package.json`)

Key `contributes` sections:

| Section | Purpose |
|---------|---------|
| `languages` | `foundryscript` id, `.fs` extension, `language-configuration.json` |
| `grammars` | TextMate grammar `source.foundryscript` |
| `semanticTokenModifiers` | e.g. `final` |
| `commands` | `foundryScript.connectionActions` |
| `taskDefinitions` | `foundryscript` tasks: build, lint, test, format, run |
| `configuration` | `foundryScript.*` settings |

`engines.vscode`: `^1.125.0`. Contributor tooling requires Node.js 24 or newer.
Main entry: `./dist/extension.js` (esbuild CJS bundle).

`activationEvents` is empty — the extension uses workspaceContains or default activation
via language/id (verify against current `package.json` when changing activation).

## Settings

| Key | Default | Purpose |
|-----|---------|---------|
| `foundryScript.lsp.mode` | `spawn` | `spawn` \| `attach` \| `auto` \| `off` |
| `foundryScript.lsp.port` | `6005` | TCP port for attach/auto |
| `foundryScript.enginePath` | `foundry` | Path to Foundry executable |
| `foundryScript.test.runner` | `""` | Runner for `foundry project test` task |
| `foundryScript.testing.enabled` | `false` | Test Adapter Protocol negotiation |
| `foundryScript.testing.runner` | `""` | `res://` test adapter resource |
| `foundryScript.testing.args` | `[]` | Extra test framework args |

## Architecture

```
grammar/ (syntaxes/)   TextMate JSON + tests — no runtime
client/                LSP transport, lifecycle, semantic tokens
diagnostics/           Single DiagnosticCollection owner
tasks/                 foundry CLI shell-out
testing/               Test explorer + adapter protocol
```

**Rule:** Only `client/` imports `vscode-languageclient` transport details. Other
subsystems receive narrow interfaces.

### Diagnostics arbitration

```
LSP connected  → publishDiagnostics from language client
LSP disconnected → script lint --format=json → diagnostics/
Never both for the same document simultaneously
```

### Connection lifecycle

- `createConnectionManager()` in `client/runtime.ts` wires spawn/attach/auto/off
- Retry with capped exponential backoff on disconnect; status bar shows state
- `HostStartupFailure` with `missing_engine` offers "Open Settings"
- Extension-spawned hosts stop on deactivate; external hosts are never killed

## LSP client

Dependencies: `vscode-languageclient`, `vscode-jsonrpc`.

Capabilities consumed from Foundry language server:

- completion (+ resolve), hover, definition, references, rename
- codeAction, documentSymbol, foldingRange, codeLens, documentLink
- signatureHelp, formatting, willSaveWaitUntil
- publishDiagnostics
- semanticTokens (full document; delta out of scope)

Register semantic token legend from server `initialize` response. Fall back to TextMate
when server lacks semantic token support or mode is `off`.

Log via `writeLog()` to the **FoundryScript LSP** output channel.

## Language configuration

`language-configuration.json` provides:

- Comment toggling (`#`)
- Bracket matching and auto-closing
- **Off-side** folding and indentation rules for `:`-introduced blocks

Match FoundryScript's indentation semantics (spaces or tabs, not mixed; default tab width 4).

## TextMate grammar

Path: `syntaxes/foundryscript.tmLanguage.json`

Scope prefix: `*.foundryscript` (e.g. `keyword.control.foundryscript`).

Document known false positives in `comment` fields on patterns (see README). Do not try to
fix contextual keywords purely in TextMate — that belongs in semantic tokens.

### Grammar testing

```bash
npm run test:grammar
# vscode-tmgrammar-test "tests/grammar/**/*.fs"
# + scripts/check-assertions.mjs
```

Assertion rules:

- `#` at column 1 only
- Negative scopes must be fully qualified: `- constant.numeric.integer.foundryscript`
- Every negative assertion must be proven to fail once before trusting it

## Tasks (`src/tasks/`)

`FoundryTaskProvider` runs `foundry` CLI commands from `taskDefinitions`:

- `build`, `lint`, `test`, `format`, `run`
- Lint JSON parsed into diagnostics when LSP is offline

## Test explorer (`src/testing/`)

Enabled when `foundryScript.testing.enabled` is true.

Components:

| Module | Role |
|--------|------|
| `adapter.ts` | Protocol negotiation with Foundry test runner |
| `discoverer.ts` | Test discovery |
| `executor.ts` | Run selected tests |
| `explorer.ts` | VS Code TestController integration |
| `report.ts` | TAP-like report parsing |
| `fixtures/protocol-v1/` | Valid/invalid report conformance fixtures |

Refresh coordinator watches relevant workspace paths and config changes.

## Development workflow

```bash
npm ci
npm run watch     # esbuild watch
npm test          # vitest + grammar
```

**F5** — Extension Development Host with `launch.json` (if present) or default extension debug.

Package: `npm run package` → `.vsix` via `@vscode/vsce`.

## `.fs` / F# conflict

Users with Ionide/F# extensions may need workspace `files.associations`:

```json
{ "files.associations": { "*.fs": "foundryscript" } }
```

Document this in README when touching onboarding or file-type detection.

## VS Code API patterns used in this repo

### Configuration

```typescript
const config = vscode.workspace.getConfiguration("foundryScript");
const mode = config.get<LspMode>("lsp.mode", "spawn");
```

Listen for changes:

```typescript
vscode.workspace.onDidChangeConfiguration((e) => {
  if (e.affectsConfiguration("foundryScript.lsp.mode")) {
    // restart connection
  }
});
```

### Disposables

Collect all subscriptions in `context.subscriptions`:

```typescript
export function activate(context: vscode.ExtensionContext): void {
  const manager = createConnectionManager(settings);
  context.subscriptions.push(manager);
}
```

### Output channel

```typescript
const channel = vscode.window.createOutputChannel("FoundryScript LSP");
channel.appendLine(message);
```

### Status bar

Connection and testing status controllers update a status bar item; click opens actions
or log.

### TestController (Testing API)

`FoundryTestExplorer` registers a `TestController`, profiles, and run handlers.
Use `vscode.TestRun`, `TestItem`, and cancellation tokens from `TestRunRequest`.

## Adding a new feature — checklist

1. Identify subsystem (`client/`, `tasks/`, `testing/`, etc.)
2. Add settings to `package.json` `contributes.configuration` if user-facing
3. Wire in `extension.ts` with proper disposal
4. Colocate `*.test.ts` with Vitest
5. Update README if user-visible
6. Run full verification (`build`, `typecheck`, `lint`, `test`)

## Common pitfalls

| Pitfall | Fix |
|---------|-----|
| Importing LSP client outside `client/` | Pass interfaces/callbacks |
| Duplicate diagnostics | Route through `diagnostics/` only |
| Forgetting `.js` import suffix | Required for Node16 |
| Bundling `vscode` module | Keep `external: ["vscode"]` in esbuild |
| Grammar scope drift | Sync from engine artifact; run corpus test |
| Unqualified grammar assertions | Use full scope names in tests |
