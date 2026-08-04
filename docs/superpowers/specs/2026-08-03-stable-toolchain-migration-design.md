# Stable Toolchain Migration Design

## Goal

Move FoundryScript from its retired Node 20 / VS Code 1.90 development baseline to
the latest mutually supported stable toolchain. The migration must preserve strict
type safety, the minimum-host smoke coverage, reproducible packaging, and the
existing extension architecture.

## Supported Baseline

The migrated project will declare and test these minimum platforms:

- Node.js 24 LTS, with `@types/node` 24.13.3
- Visual Studio Code 1.125, with `@types/vscode` 1.125.0
- TypeScript 6.0.3

`package.json` will add a Node engine declaration of `>=24` and raise
`engines.vscode` to `^1.125.0`. All GitHub Actions jobs will use Node 24. The
minimum-host and packaged integration runners will download VS Code 1.125.0.

Node 26 and TypeScript 7 are intentionally excluded from this migration. Node 26
is not yet LTS, and the latest stable typescript-eslint release does not support
TypeScript 7.

## Dependency Graph

The migration will update the coupled direct dependencies together:

| Dependency | Target |
| --- | --- |
| `@types/node` | `24.13.3` |
| `@types/vscode` | `1.125.0` |
| `typescript` | `6.0.3` |
| `@typescript-eslint/eslint-plugin` | `8.66.0` |
| `@typescript-eslint/parser` | `8.66.0` |
| `@vscode/test-electron` | `3.1.0` |
| `vite` | `8.2.0` |
| `vscode-languageclient` | `10.1.0` |
| `vscode-jsonrpc` | `9.0.1` |

Already-current direct tools such as ESLint 10.8.0, esbuild 0.28.1, Vitest
4.1.10, and YAML 2.9.0 will remain at their current versions. Other ranged direct
dependencies will be resolved to their newest versions allowed by the manifest,
and the generated npm lockfile will record the complete reproducible graph.

No peer dependency will be bypassed with `--force`, `--legacy-peer-deps`, an npm
override, or a suppression. If the declared stable graph cannot install normally,
the incompatibility is a blocker to investigate rather than something to hide.

## Implementation Boundaries

The migration is a tooling and compatibility change, not an extension feature.
Edits will stay within these boundaries:

- Runtime and package declarations in `package.json` and `package-lock.json`
- Compiler configuration in `tsconfig*.json` only when TypeScript 6 requires it
- CI runtime versions in `.github/workflows/ci.yml`
- Runtime-contract and Extension Host runner assertions under `scripts/`
- Compatibility fixes in existing TypeScript modules and tests
- LSP API adaptations within `src/client/`; transport details will not leak into
  other subsystems

The implementation will not change FoundryScript grammar, diagnostics ownership,
user-facing features, or engine protocol behavior. Compiler suppressions,
non-null assertions added only to silence migration diagnostics, and unrelated
refactors are out of scope.

## Migration Sequence

1. Update the runtime contract tests first so they fail against the old Node,
   VS Code, compiler, test harness, and CI declarations.
2. Update the manifest and regenerate the lockfile as one compatible dependency
   graph.
3. Raise the CI and Extension Host baselines.
4. Run TypeScript 6 typechecking and group diagnostics by root cause. Fix shared
   boundary types before call sites, preserving runtime behavior.
5. Adapt `vscode-languageclient` and `vscode-jsonrpc` API changes inside the client
   subsystem and add focused regressions for any behavior-sensitive change.
6. Run the complete local verification suite, audits, packaging checks, minimum
   VS Code smoke, and the GitHub Actions matrix.

Each behavior-sensitive fix follows red-green TDD. Mechanical declaration changes
are proven by the runtime contract tests, which must fail before the manifest and
workflow are updated and pass afterward.

## Failure Handling

Installation failures will be traced to the exact engine or peer constraint.
Compiler failures will be categorized by declaration mismatch, TypeScript 6
semantic change, or upstream API change before code is edited. Integration failures
will be reproduced in the focused runner before changing launch behavior.

The migration will not silently lower the selected baseline or substitute an
unsupported prerelease. A genuine upstream blocker will be documented on the draft
pull request with the failing command and dependency constraint.

## Verification

The branch must pass all repository-required checks:

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

It must also pass the expanded migration checks:

```bash
npm run audit:production
npm run audit:development
npm run test:vscode-minimum
npm run test:vscode-integration
npm run package
npm run check:package-files
```

The required GitHub Actions jobs, including corpus and real-engine DAP conformance,
must be green on the final head before the pull request is made ready or merged.

## Delivery

The work will be delivered as one draft pull request from
`agent/stable-toolchain-migration` into `main`. It supersedes closed Dependabot PRs
#79, #80, #82, and #83, whose individual updates could not form a valid intermediate
dependency graph. The pull request will be squash-merged only after local and remote
verification pass.
