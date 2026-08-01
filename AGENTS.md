# FoundryScript VS Code Extension — Agent Guide

This repository is **[cafecito-games/Foundry-Scripting](https://github.com/cafecito-games/Foundry-Scripting)**:
the VS Code extension that provides language support for FoundryScript (`.fs`). It is
separate from the Foundry engine
**[cafecito-games/Foundry](https://github.com/cafecito-games/Foundry)**.

## Primary skill

**Read and follow** `.cursor/skills/foundryscript-expert/SKILL.md` before
implementing or reviewing work in this repo. It covers TypeScript best practices,
VS Code extension patterns, and the FoundryScript language.

Reference files (load when needed):

| File | Use for |
|------|---------|
| `.cursor/skills/foundryscript-expert/references/typescript.md` | Strict TS, Vitest, error handling |
| `.cursor/skills/foundryscript-expert/references/vscode-extension.md` | LSP client, contributes, grammar tests |
| `.cursor/skills/foundryscript-expert/references/foundryscript-language.md` | `.fs` syntax and grammar quirks |

## Authoritative FoundryScript grammar

When language or grammar behavior is in question, treat the engine spec as
normative:

[Foundry `modules/foundry_script/GRAMMAR.md`](https://github.com/cafecito-games/Foundry/blob/develop/modules/foundry_script/GRAMMAR.md)

Grammar changes in the engine must update that file in the same change. This
extension syncs its TextMate grammar from the engine release artifact.

## Repository layout

| Path | Role |
|------|------|
| `src/extension.ts` | Activation and subsystem wiring |
| `src/client/` | LSP transport and connection lifecycle |
| `src/diagnostics/` | Single owner of the Problems panel |
| `src/tasks/` | `foundry` CLI task provider |
| `src/testing/` | Test explorer and adapter protocol |
| `syntaxes/` | TextMate grammar (offline fallback) |
| `tests/grammar/` | Scope assertion fixtures |

Only `client/` should know LSP transport details. Diagnostics arbitration:
LSP wins while connected; CLI lint fills the gap when disconnected.

## Verification

Run before claiming work is complete:

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

Press **F5** in VS Code to exercise UI behavior in an Extension Development Host.

## Engine dependency

| Need | Location |
|------|----------|
| Engine repo | [cafecito-games/Foundry](https://github.com/cafecito-games/Foundry) |
| Grammar spec | [`modules/foundry_script/GRAMMAR.md`](https://github.com/cafecito-games/Foundry/blob/develop/modules/foundry_script/GRAMMAR.md) |
| Combined tooling host | `foundry tooling serve` |
| Grammar artifact | [Engine release](https://github.com/cafecito-games/Foundry/releases) `foundryscript-tmlanguage-<version>.json` |

Configure the Foundry binary with `foundryScript.enginePath` (default: `foundry` on `PATH`).
