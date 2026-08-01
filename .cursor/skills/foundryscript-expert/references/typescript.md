# TypeScript Reference (FoundryScript Extension)

> Adapted from [mastering-typescript-skill](https://github.com/SpillwaveSolutions/mastering-typescript-skill)
> references. Tailored for this repo's stack: strict TS, Node16, esbuild, Vitest, ESLint 9.

## This project's toolchain

| Tool | Config | Notes |
|------|--------|-------|
| TypeScript | `tsconfig.json` | `strict`, `noEmit`, Node16 resolution |
| Build | `esbuild.mjs` | Bundles `src/extension.ts` → `dist/extension.js`, CJS, `vscode` external |
| Test | Vitest | `npm run test:unit`; colocated `*.test.ts` |
| Lint | `eslint.config.mjs` | `@typescript-eslint` |
| Grammar test | `vscode-tmgrammar-test` | `npm run test:grammar` |

```bash
npm run build      # esbuild bundle
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src
npm test           # unit + grammar
```

## Type annotations

Prefer inference when obvious; annotate public APIs and non-obvious return types.

```typescript
// Explicit when it aids readers
function readConnectionSettings(): ConnectionSettings {
  const configuration = vscode.workspace.getConfiguration("foundryScript");
  return {
    mode: configuration.get("lsp.mode", "spawn"),
    port: configuration.get("lsp.port", 6005),
    enginePath: configuration.get("enginePath", "foundry"),
  };
}

// Import types separately (tree-shaking friendly)
import type { ConnectionSettings } from "./connection-manager.js";
```

Use `.js` extensions in relative imports — required by Node16 module resolution even
though source files are `.ts`.

## Interfaces vs type aliases

| Use case | Prefer |
|----------|--------|
| Object shapes, class contracts | `interface` |
| Union / discriminated union | `type` |
| Tuple types | `type` |
| Mapped / conditional types | `type` |

```typescript
// Discriminated union — use throughout client/testing code
type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

function ok<T>(data: T): Result<T, never> {
  return { success: true, data };
}

function err<E>(error: E): Result<never, E> {
  return { success: false, error };
}
```

## Type guards and narrowing

```typescript
function showStartupError(error: unknown): Promise<void> {
  const message =
    error instanceof Error
      ? error.message
      : `Foundry language server startup failed: ${String(error)}`;

  if (error instanceof HostStartupFailure && error.kind === "missing_engine") {
    // narrowed to HostStartupFailure
  }
}

// Custom type predicate
function isRelevantPath(path: string): path is string {
  return path.endsWith(".fs");
}
```

Prefer `unknown` over `any`. Narrow with `instanceof`, `typeof`, or custom predicates.

## The `satisfies` operator

Validates shape without widening literal types. Prefer over `as` for config objects.

```typescript
const rateLimits = {
  api: { windowMs: 60_000, maxRequests: 100 },
  auth: { windowMs: 300_000, maxRequests: 5 },
} as const satisfies Record<string, { windowMs: number; maxRequests: number }>;
```

## Generics essentials

```typescript
// Constrained generic
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

// Extract return type from async functions
type AwaitedReturn<T> = T extends (...args: never[]) => Promise<infer R> ? R : never;
```

### Utility types (frequent in extension code)

| Utility | Use in this repo |
|---------|------------------|
| `Readonly<T>` | Immutable config snapshots |
| `Pick<T, K>` / `Omit<T, K>` | Public API surface trimming |
| `Partial<T>` | Optional update payloads |
| `ReturnType<T>` | Infer handler return types |
| `Awaited<T>` | Unwrap Promise results from LSP calls |
| `NonNullable<T>` | After null checks |

## Error handling patterns

### Typed error classes

```typescript
abstract class AppError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

class HostStartupFailure extends AppError {
  readonly code = "HOST_STARTUP_FAILURE";
  constructor(
    readonly kind: "missing_engine" | "spawn_failed",
    message: string,
  ) {
    super(message);
  }
}
```

### Result at boundaries

Use `Result<T, E>` when a function can fail predictably without throwing — especially
parsers (TAP reports, lint JSON) and adapter negotiation.

```typescript
function parseReport(input: string): Result<Report, ParseError> {
  // ...
  if (!valid) return err({ kind: "malformed", line: n });
  return ok(report);
}
```

## Project organization

```
src/
├── extension.ts          # thin activation layer
├── client/               # LSP transport + lifecycle
├── diagnostics/          # diagnostic collection owner
├── tasks/                # foundry CLI task provider
└── testing/              # test adapter protocol + explorer
```

- One responsibility per module; export through index files only when it reduces coupling
- Colocate `*.test.ts` with source
- Keep `extension.ts` as wiring — push logic into subsystems

## ESLint / strictness

This repo enables strict compiler options. Match these habits:

- `@typescript-eslint/consistent-type-imports` — use `import type`
- Handle promises explicitly; no floating promises in activation paths
- Prefix intentionally unused params with `_`
- No `any` without a comment explaining why

## Testing with Vitest

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("retry policy", () => {
  it("caps backoff at the configured maximum", () => {
    const policy = createRetryPolicy({ maxDelayMs: 30_000 });
    expect(policy.nextDelay(10)).toBeLessThanOrEqual(30_000);
  });
});
```

- Mock `vscode` APIs when testing modules that import it
- Prefer testing pure functions (parsers, selectors, report builders) without VS Code
- Use fixture files under `src/testing/fixtures/` for protocol conformance

## Anti-patterns

| Avoid | Prefer |
|-------|--------|
| `any` | `unknown` + narrow |
| `as SomeType` without validation | `satisfies`, type guards, schema parse |
| Throwing for expected failures | `Result<T, E>` |
| Enums for string unions | Literal union types |
| Logic in `extension.ts` | Delegate to subsystem modules |
| Unhandled promise in `activate()` | `await` or explicit `.catch()` with user feedback |
