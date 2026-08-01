---
name: foundryscript-expert
description: >-
  Expert guidance for the FoundryScript VS Code extension repository: TypeScript best
  practices, VS Code extension APIs, and the FoundryScript (.fs) language. Use when
  implementing or reviewing extension features, LSP client code, TextMate grammars,
  test explorer integration, Foundry CLI tasks, grammar sync, or any work in
  cafecito-games/Foundry-Scripting.
---

# FoundryScript Expert

Expert agent for **[cafecito-games/Foundry-Scripting](https://github.com/cafecito-games/Foundry-Scripting)** —
the VS Code extension that provides language support for FoundryScript (`.fs`).

## When to apply

Use this skill when working in this repository on:

- Extension activation, commands, configuration, tasks, or test explorer
- LSP client lifecycle, semantic tokens, diagnostics, or connection management
- TextMate grammar (`syntaxes/foundryscript.tmLanguage.json`) or grammar tests
- FoundryScript language behavior, syntax, or grammar/engine sync
- TypeScript implementation, tests (Vitest), lint (ESLint), or build (esbuild)

## Repository map

| Area | Path | Responsibility |
|------|------|----------------|
| Entry | `src/extension.ts` | Activation, wiring subsystems |
| LSP client | `src/client/` | Transport, connection lifecycle, semantic tokens, status |
| Diagnostics | `src/diagnostics/` | Single owner of Problems panel; LSP wins over CLI lint |
| Tasks | `src/tasks/` | `foundry` CLI integration (build, lint, test, format, run) |
| Testing | `src/testing/` | Foundry Test Adapter Protocol, explorer, executor |
| Grammar | `syntaxes/foundryscript.tmLanguage.json` | Offline syntax highlighting fallback |
| Grammar tests | `tests/grammar/**/*.fs` | Scope assertions via `vscode-tmgrammar-test` |
| Config | `package.json` `contributes` | Languages, grammars, commands, tasks, settings |

**Engine dependency** ([cafecito-games/Foundry](https://github.com/cafecito-games/Foundry)):

- Authoritative grammar: [`modules/foundry_script/GRAMMAR.md`](https://github.com/cafecito-games/Foundry/blob/develop/modules/foundry_script/GRAMMAR.md)
- Combined tooling host: `foundry tooling serve`
- Grammar artifact: published from engine releases; extension may sync via `npm run sync-grammar`

## Architecture rules

1. **Separation of concerns** — Only `client/` knows about the language server. Other
   modules interact through defined interfaces.
2. **Diagnostics arbitration** — `diagnostics/` owns one `DiagnosticCollection`. LSP
   diagnostics win while connected; CLI `script lint --format=json` fills the gap.
3. **Grammar vs semantics** — TextMate handles keywords, literals, comments, annotations,
   and `$`/`%` paths. Contextual keywords (`extend`, `async`, `annotation`, `get`/`set`)
   need semantic tokens from the engine for correctness.
4. **Minimize scope** — Match existing patterns in neighboring files. Do not refactor
   unrelated code.

## Verification checklist

Before claiming work is complete:

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Optional corpus regression (requires engine checkout):

```bash
FOUNDRY_ENGINE_PATH=/path/to/Foundry npm run test:corpus
```

Press **F5** to launch an Extension Development Host when UI behavior needs manual check.

## TypeScript standards (this repo)

This project uses **strict** TypeScript with Node16 modules:

- Prefer `import type` for type-only imports
- Use discriminated unions and `Result<T, E>` at API boundaries (see references)
- Avoid `any`; use `unknown` and narrow
- Prefer `satisfies` over `as` when validating object shapes
- Colocate tests as `*.test.ts` next to source
- Match `tsconfig.json`: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`

Full patterns: [references/typescript.md](references/typescript.md)

## FoundryScript language

FoundryScript is a gradually-typed, indentation-sensitive language (Python-style blocks).
It is a GDScript derivative with traits, namespaces/imports, generics, nullable types,
`async`/`await`/`Coroutine[T]`, tagged-union enums, tuples, and retroactive `extend`
conformances.

**Always treat engine `GRAMMAR.md` as authoritative** when grammar or syntax questions
arise. Any tokenizer/parser change in the engine must update that file in the same change.

Practical summary and extension-relevant quirks:
[references/foundryscript-language.md](references/foundryscript-language.md)

Canonical spec (read when implementing grammar or explaining syntax):

https://github.com/cafecito-games/Foundry/blob/develop/modules/foundry_script/GRAMMAR.md

## VS Code extension patterns

Extension-specific guidance for LSP client setup, contributes schema, grammar testing,
and subsystem boundaries:

[references/vscode-extension.md](references/vscode-extension.md)

## Common tasks

### Grammar change

1. Update `GRAMMAR.md` in the engine repo (if the language changed)
2. Regenerate or sync `syntaxes/foundryscript.tmLanguage.json`
3. Add/adjust grammar tests under `tests/grammar/`
4. Run `npm run test:grammar`

Grammar test rules (from README):

- Negative assertions must use **fully-qualified** scopes
- `#` assertion lines must start at column 1
- Prove every negative assertion fails by deliberately breaking the grammar once

### LSP / connection work

- Settings live under `foundryScript.*` in `package.json`
- `foundryScript.lsp.mode`: `spawn` | `attach` | `auto` | `off`
- Connection manager handles retry with capped exponential backoff
- Log to FoundryScript LSP output channel via `writeLog`

### Test explorer work

- Gated by `foundryScript.testing.enabled`
- Uses Foundry Test Adapter Protocol (TAP-like report fixtures in `src/testing/fixtures/`)
- Runner configured via `foundryScript.testing.runner` (`res://` resource)

## Reference files

| File | Contents |
|------|----------|
| [references/typescript.md](references/typescript.md) | Type system, generics, error handling, toolchain |
| [references/foundryscript-language.md](references/foundryscript-language.md) | Language summary for extension authors |
| [references/vscode-extension.md](references/vscode-extension.md) | VS Code extension APIs and repo conventions |

TypeScript reference material adapted from
[mastering-typescript-skill](https://github.com/SpillwaveSolutions/mastering-typescript-skill)
(Spillwave Solutions, MIT).
