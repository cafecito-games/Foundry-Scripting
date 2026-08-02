# Enforced CI Corpus — Design

**Date:** 2026-08-02
**Status:** Approved
**Issue:** [cafecito-games/Foundry-Scripting#58](https://github.com/cafecito-games/Foundry-Scripting/issues/58)

## Purpose

Turn the existing `corpus` CI job from a no-op success into a reproducible grammar
regression gate. CI will scan a real Foundry engine checkout pinned to the same release
as the committed TextMate grammar, while local contributors may still run the command
without an engine checkout and receive an explicit successful skip.

The initial corpus pin is Foundry release `v0.1.0-alpha.19`, matching
`foundry-grammar.json`. CI checks out the release's immutable commit
`7a86a1464be0699c81a8a5b5c849447b4a7707bf` so the inputs remain reviewable and cannot
move if a tag is changed.

## CI checkout and data flow

The `corpus` job keeps the extension checkout and adds a second
`actions/checkout@v4` step for `cafecito-games/Foundry`. The engine checkout uses the
full commit SHA and a dedicated `foundry-engine` path under the Actions workspace. A
nearby comment records the corresponding release tag so maintainers can review the
relationship to `foundry-grammar.json`.

The corpus command receives an absolute path through the job's
`FOUNDRY_ENGINE_PATH` environment variable:

```text
Foundry commit at <workspace>/foundry-engine
                    |
                    v
          FOUNDRY_ENGINE_PATH
                    |
                    v
       scripts/check-corpus.mjs
                    |
                    v
       nonzero scanned-file count
```

No engine build or dependency installation is required. The corpus script reads `.fs`
source files directly from the checkout and tokenizes them with the extension's
committed TextMate grammar.

## Corpus command behavior

`scripts/check-corpus.mjs` distinguishes three configurations:

- without `FOUNDRY_ENGINE_PATH` outside CI, print the existing explanatory local-skip
  message and exit successfully;
- without `FOUNDRY_ENGINE_PATH` when `CI` is set, print an actionable configuration
  error and exit nonzero;
- with `FOUNDRY_ENGINE_PATH`, scan the checkout and require at least one `.fs` file.

A configured path that is missing, unreadable, or contains no discoverable `.fs` files
therefore fails instead of reporting a misleading clean scan. Existing unexpected
`invalid.illegal` scope handling remains unchanged.

## Documentation

The README continues to describe `FOUNDRY_ENGINE_PATH` as optional for local
development. It separately states that CI checks out a pinned engine revision, supplies
the variable, and enforces both a nonzero scan and the existing invalid-scope gate. The
current inaccurate statement that CI intentionally skips the corpus is removed.

When the grammar release in `foundry-grammar.json` advances, maintainers must update the
corpus checkout SHA to the commit behind the same engine release. Keeping the full SHA
visible in the workflow makes that change explicit in review.

## Testing strategy

Command-level Vitest tests execute `check-corpus.mjs` in subprocesses and establish the
configuration contract before implementation:

- local invocation without `FOUNDRY_ENGINE_PATH` exits zero and explains the skip;
- CI invocation without `FOUNDRY_ENGINE_PATH` exits nonzero with a configuration error;
- an explicitly configured empty directory exits nonzero after reporting zero scanned
  files.

The successful full-corpus path is verified by running the command against a Foundry
checkout at the pinned revision and confirming the output reports a nonzero count. The
repository's required build, typecheck, lint, and test commands provide final regression
coverage.

## Out of scope

- Building or executing the Foundry engine in CI.
- Changing TextMate grammar behavior or the set of allowed invalid scopes.
- Automatically resolving moving branches or the latest engine release.
- Requiring every local contributor to maintain an engine checkout.
- Refactoring unrelated CI jobs or consolidating their repeated Node setup.
