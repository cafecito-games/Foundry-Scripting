# Engine-Published Grammar Sync — Design

**Date:** 2026-08-01
**Status:** Approved
**Issue:** [cafecito-games/Foundry-Scripting#5](https://github.com/cafecito-games/Foundry-Scripting/issues/5)

## Purpose

Replace the hand-written bootstrap TextMate grammar with the complete grammar published
by the Foundry engine. Pin one engine release, make updating the grammar a deliberate
command, and prove in CI that the committed file is byte-for-byte identical to the
release asset. Normal installs and builds remain independent of both the network and an
engine checkout.

The initial pin uses the release asset supplied with the issue. The manifest remains the
only operational source of its exact version string.

## Source of truth and artifact contract

`foundry-grammar.json` is the only location that contains the pinned engine version.
Documentation refers contributors to that file instead of copying the version into the
README or scripts.

The sync tool derives both the tag and asset name from the pin:

```text
tag:   v<engineVersion>
asset: foundryscript-tmlanguage-<engineVersion>.json
```

The downloaded bytes must decode as JSON whose root object has:

- `scopeName` equal to `source.foundryscript`;
- `fileTypes` containing `fs`;
- non-empty `patterns` and `repository` members.

These checks catch a wrong asset or malformed release without trying to reimplement the
engine generator's schema. The committed artifact remains unmodified; validation never
normalizes, reformats, augments, or reserializes it.

## Components

### Pin manifest

`foundry-grammar.json` contains the engine version in a small object. Keeping the pin in
a dedicated manifest makes it obvious what to change during an update and avoids adding
extension-unrelated metadata to `package.json`.

### Sync tool

`scripts/sync-grammar.mjs` is a cross-platform Node command with two modes:

- default mode downloads, validates, and atomically writes
  `syntaxes/foundryscript.tmLanguage.json`;
- `--check` mode downloads and validates the same asset, then compares its raw bytes to
  the committed file without changing the checkout.

`package.json` exposes these as `npm run sync-grammar` and
`npm run check:grammar-sync`. The release origin defaults to the official public Foundry
GitHub releases location. Tests may override the origin through an environment variable
so they can exercise the real command against a local HTTP server without depending on
GitHub.

The write path uses a temporary sibling file followed by rename. A failed or interrupted
download therefore cannot truncate the committed grammar. Temporary files are removed
on failure.

### Committed grammar

`syntaxes/foundryscript.tmLanguage.json` is replaced in full by the downloaded pinned
asset. `package.json` continues to contribute the same path and scope, so runtime
package layout and the TextMate fallback behavior do not change.

The engine's TextMate scope names are authoritative. Existing tests that assert the
bootstrap grammar's older, generic scope names are updated to assert the engine artifact's
more precise names. No compatibility rules are spliced into the downloaded grammar,
because that would violate exact artifact parity.

### CI and documentation

CI gains a dedicated grammar-sync check that runs the online `--check` command. This job
fails when the pin, committed bytes, and release asset disagree. Existing build, package,
scope, and corpus jobs continue to consume only the committed grammar and therefore do
not acquire a network dependency beyond `npm ci`.

The README documents the update workflow:

1. change the version in `foundry-grammar.json`;
2. run `npm run sync-grammar`;
3. review the grammar and assertion diffs;
4. run the grammar and corpus checks.

It also states that `sync-grammar` is a maintainer operation, not a build step.

## Data flow

```text
foundry-grammar.json
        |
        v
official release URL -----> downloaded raw bytes -----> contract validation
                                                        |               |
                                                        | default       | --check
                                                        v               v
                                              atomic committed write   byte comparison
                                                        |
                                                        v
                                         VS Code + scope/corpus tests
```

## Failure handling

The sync command exits nonzero with a concise, actionable message when:

- the pin manifest is missing, malformed, or does not contain a usable version;
- the release request fails or returns a non-success status;
- the response is not valid JSON or violates the grammar contract;
- atomic replacement fails;
- `--check` finds missing or different committed bytes;
- unsupported command-line arguments are supplied.

Download and contract failures leave the existing grammar untouched. Drift output names
both the pin and the command that intentionally resynchronizes the artifact.

## Testing strategy

The implementation follows two red-green paths.

1. **Sync behavior:** command-level tests start a local HTTP server and use a temporary
   checkout root. They first fail with no sync implementation, then cover a successful
   exact-byte write, clean check mode, drift detection, HTTP failure, and rejected grammar
   contracts. Tests verify the official filename/tag construction from the manifest pin.
2. **Grammar behavior:** scope assertions are changed to the authoritative engine scopes
   and observed failing against the bootstrap grammar. Installing the pinned artifact
   makes them pass. Negative contextual assertions remain load-bearing, preserving useful
   fallback heuristics when semantic tokens are unavailable.

Final verification includes:

- `npm run lint`;
- `npm run typecheck`;
- `npm test`;
- `FOUNDRY_ENGINE_PATH=/Users/christian/CafecitoGames/Foundry npm run test:corpus`;
- `npm run build`;
- `npm run package`;
- `npm run check:grammar-sync`.

The corpus test uses the locally installed engine checkout and the committed artifact. An
offline build check prevents accidentally wiring synchronization into `build`, `prepare`,
or another lifecycle hook.

## Out of scope

- Modifying the engine-generated grammar or its scope conventions.
- Reimplementing the engine grammar generator in this repository.
- Automatically selecting the installed Foundry binary's version.
- Fetching grammar assets during extension installation, build, or activation.
- Supporting multiple simultaneous engine grammar versions.
