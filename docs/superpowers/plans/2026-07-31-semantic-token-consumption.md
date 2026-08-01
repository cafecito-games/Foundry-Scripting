# Semantic Token Consumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume Foundry's server-advertised full-document semantic tokens through `vscode-languageclient`, contribute only the custom `final` modifier, and degrade safely to TextMate on incompatible capabilities or malformed data.

**Architecture:** A focused semantic-token contract unit implements a `vscode-languageclient` static feature and raw-response middleware. The feature augments the library's client modifier list, validates the actual server capability before the built-in semantic-token feature initializes, and retains that advertised legend only for response validation. `vscode-languageclient` continues to own document synchronization, provider registration, requests, conversion, and the VS Code-facing provider.

**Tech Stack:** TypeScript, VS Code Extension API 1.90, `vscode-languageclient` 9, LSP 3.17 semantic tokens, Vitest, deterministic JSON protocol fixtures, Node TCP/JSON-RPC acceptance harness, ESLint, esbuild, vsce.

---

## File structure

- Create `src/client/semantic-tokens.ts`: capability inspection, custom static feature, response validation, and request middleware.
- Create `src/client/semantic-tokens.test.ts`: focused contract, logging, degradation, isolation, and deterministic fixture assertions.
- Create `src/client/fixtures/semantic-tokens.json`: captured-style server initialize/full-response fixture; the sole ordered legend is server input data.
- Modify `src/client/language-client.ts`: register the contract feature and compose its raw-response middleware with diagnostics.
- Modify `src/client/language-client.test.ts`: prove the real client registers and uses the feature without replacing the built-in provider.
- Modify `src/extension.test.ts`: assert the manifest contributes only the custom `final` modifier and retains the grammar fallback.
- Modify `package.json`: add `contributes.semanticTokenModifiers.final`.
- Modify `README.md`: document analyzer-backed semantic highlighting and TextMate fallback.

### Task 1: Pure provider and response contract

**Files:**
- Create: `src/client/semantic-tokens.ts`
- Create: `src/client/semantic-tokens.test.ts`

- [ ] **Step 1: Write failing capability-inspection tests**

Define test-local provider fixtures and write one-behavior tests for supported full-only providers,
absent/false range, missing provider, malformed legends, duplicate legend names, missing `final`,
range support, and object-valued full support:

```ts
it("accepts the server-advertised full-only provider without copying its order", () => {
  const provider = {
    legend: {
      tokenTypes: ["keyword", "class"],
      tokenModifiers: ["readonly", "final"],
    },
    full: true,
    range: false,
  };

  expect(inspectSemanticTokensProvider(provider)).toEqual({
    kind: "supported",
    legend: provider.legend,
  });
});

it.each([undefined, false])("accepts %s as no range support", (range) => {
  expect(inspectSemanticTokensProvider({ ...provider, range }).kind).toBe(
    "supported",
  );
});

it("rejects delta-shaped full support as a contract mismatch", () => {
  expect(
    inspectSemanticTokensProvider({ ...provider, full: { delta: false } }),
  ).toMatchObject({ kind: "mismatch", reason: "full_not_plain_true" });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test:unit -- --run src/client/semantic-tokens.test.ts`

Expected: FAIL because `semantic-tokens.ts` does not exist.

- [ ] **Step 3: Implement minimal pure capability inspection**

Add these public contract types and pure function:

```ts
export interface AdvertisedSemanticTokensLegend {
  readonly tokenTypes: readonly string[];
  readonly tokenModifiers: readonly string[];
}

export type ProviderInspection =
  | { readonly kind: "missing" }
  | { readonly kind: "supported"; readonly legend: AdvertisedSemanticTokensLegend }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "mismatch"; readonly reason: string };

export function inspectSemanticTokensProvider(value: unknown): ProviderInspection {
  if (value === undefined) return { kind: "missing" };
  if (typeof value !== "object" || value === null) {
    return { kind: "malformed", reason: "provider_not_object" };
  }
  const provider = value as Record<string, unknown>;
  if (typeof provider.legend !== "object" || provider.legend === null) {
    return { kind: "malformed", reason: "legend_not_object" };
  }
  const legend = provider.legend as Record<string, unknown>;
  const validNames = (names: unknown): names is string[] =>
    Array.isArray(names) && names.length > 0 &&
    names.every((name) => typeof name === "string" && name.length > 0);
  if (!validNames(legend.tokenTypes)) {
    return { kind: "malformed", reason: "token_types_invalid" };
  }
  if (!validNames(legend.tokenModifiers)) {
    return { kind: "malformed", reason: "token_modifiers_invalid" };
  }
  if (
    new Set(legend.tokenTypes).size !== legend.tokenTypes.length ||
    new Set(legend.tokenModifiers).size !== legend.tokenModifiers.length
  ) {
    return { kind: "malformed", reason: "legend_duplicates" };
  }
  if (legend.tokenModifiers.length > 31) {
    return { kind: "malformed", reason: "too_many_modifiers" };
  }
  if (!legend.tokenModifiers.includes("final")) {
    return { kind: "mismatch", reason: "final_modifier_missing" };
  }
  if (provider.full !== true) {
    return { kind: "mismatch", reason: "full_not_plain_true" };
  }
  if (provider.range !== undefined && provider.range !== false) {
    return { kind: "mismatch", reason: "range_supported" };
  }
  return {
    kind: "supported",
    legend: {
      tokenTypes: [...legend.tokenTypes],
      tokenModifiers: [...legend.tokenModifiers],
    },
  };
}
```

Return defensive legend copies from the supported result. Use stable reason values such as
`provider_not_object`, `legend_not_object`, `token_types_invalid`, `token_modifiers_invalid`,
`legend_duplicates`, `too_many_modifiers`, `final_modifier_missing`, `full_not_plain_true`, and
`range_supported`.

- [ ] **Step 4: Verify capability GREEN**

Run: `npm run test:unit -- --run src/client/semantic-tokens.test.ts`

Expected: all capability tests pass.

- [ ] **Step 5: Write failing raw-response validation tests**

Cover valid `null`, valid data, optional string `resultId`, non-object/non-array data, record width,
non-integer/negative fields, zero token length, out-of-range token type, modifier mask outside the
advertised legend, and invalid result ID:

```ts
it("rejects a token type outside the advertised legend", () => {
  expect(validateSemanticTokensResponse({ data: [0, 0, 3, 2, 0] }, legend)).toEqual({
    ok: false,
    reason: "token_type_out_of_range",
  });
});

it("accepts records against the advertised legend without translating them", () => {
  const response = { data: [0, 0, 3, 0, 1], resultId: "full-1" };
  expect(validateSemanticTokensResponse(response, legend)).toEqual({
    ok: true,
    value: response,
  });
});
```

- [ ] **Step 6: Run response tests and verify RED**

Run: `npm run test:unit -- --run src/client/semantic-tokens.test.ts`

Expected: FAIL because `validateSemanticTokensResponse` is missing.

- [ ] **Step 7: Implement minimal response validation**

```ts
export type SemanticTokensValidation =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

export function validateSemanticTokensResponse(
  value: unknown,
  legend: AdvertisedSemanticTokensLegend,
): SemanticTokensValidation {
  if (value === null) return { ok: true, value };
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "response_not_object" };
  }
  const response = value as { data?: unknown; resultId?: unknown };
  if (response.resultId !== undefined && typeof response.resultId !== "string") {
    return { ok: false, reason: "result_id_invalid" };
  }
  if (!Array.isArray(response.data)) {
    return { ok: false, reason: "data_not_array" };
  }
  if (response.data.length % 5 !== 0) {
    return { ok: false, reason: "record_width_invalid" };
  }
  const modifierMask = 2 ** legend.tokenModifiers.length - 1;
  for (let index = 0; index < response.data.length; index += 5) {
    const record = response.data.slice(index, index + 5);
    if (!record.every((field) => Number.isSafeInteger(field) && Number(field) >= 0)) {
      return { ok: false, reason: "record_value_invalid" };
    }
    if (Number(record[2]) === 0) return { ok: false, reason: "token_length_zero" };
    if (Number(record[3]) >= legend.tokenTypes.length) {
      return { ok: false, reason: "token_type_out_of_range" };
    }
    if (Number(record[4]) > modifierMask) {
      return { ok: false, reason: "token_modifiers_out_of_range" };
    }
  }
  return { ok: true, value };
}
```

Do not inspect source text or decode classifications.

- [ ] **Step 8: Verify contract GREEN and commit**

Run: `npm run test:unit -- --run src/client/semantic-tokens.test.ts && npm run typecheck && npm run lint`

Expected: focused tests, typecheck, and lint pass.

```bash
git add src/client/semantic-tokens.ts src/client/semantic-tokens.test.ts
git commit -m "feat: validate semantic token protocol contract"
```

### Task 2: Static feature and malformed-response isolation

**Files:**
- Modify: `src/client/semantic-tokens.ts`
- Modify: `src/client/semantic-tokens.test.ts`

- [ ] **Step 1: Write failing static-feature tests**

Use a real feature instance with a structural output double. Verify that it appends `final` once to
the modifier array already produced by the library, leaves token types/order unchanged, logs and
retains supported server legends, logs missing capability without mutation, and clears only the
semantic provider on malformed or mismatched capability:

```ts
it("adds final idempotently to the library modifier list", () => {
  const capabilities = semanticClientCapabilities(["declaration"]);
  feature.fillClientCapabilities(capabilities);
  feature.fillClientCapabilities(capabilities);
  expect(capabilities.textDocument?.semanticTokens?.tokenModifiers).toEqual([
    "declaration",
    "final",
  ]);
});

it("removes only a mismatched provider before built-in initialization", () => {
  const capabilities = { completionProvider: {}, semanticTokensProvider: badProvider };
  feature.preInitialize(capabilities, selector);
  expect(capabilities).toMatchObject({ completionProvider: {} });
  expect(capabilities.semanticTokensProvider).toBeUndefined();
});
```

- [ ] **Step 2: Run and verify static-feature RED**

Run: `npm run test:unit -- --run src/client/semantic-tokens.test.ts`

Expected: FAIL because the feature class is missing.

- [ ] **Step 3: Implement the static feature**

```ts
export class FoundrySemanticTokensFeature implements StaticFeature {
  private legend: AdvertisedSemanticTokensLegend | undefined;

  constructor(private readonly output: LogOutput) {}

  fillClientCapabilities(capabilities: ClientCapabilities): void {
    const modifiers = capabilities.textDocument?.semanticTokens?.tokenModifiers;
    if (modifiers !== undefined && !modifiers.includes("final")) modifiers.push("final");
  }
  preInitialize(capabilities: ServerCapabilities): void {
    const inspection = inspectSemanticTokensProvider(
      capabilities.semanticTokensProvider,
    );
    if (inspection.kind === "supported") {
      this.legend = inspection.legend;
      writeLog(this.output, "info", "lsp.semantic_tokens.enabled", {
        tokenTypeCount: inspection.legend.tokenTypes.length,
        tokenModifierCount: inspection.legend.tokenModifiers.length,
      });
      return;
    }
    this.legend = undefined;
    if (inspection.kind === "missing") {
      writeLog(this.output, "info", "lsp.semantic_tokens.unavailable");
      return;
    }
    writeLog(
      this.output,
      "warn",
      inspection.kind === "malformed"
        ? "lsp.semantic_tokens.capability_malformed"
        : "lsp.semantic_tokens.capability_mismatch",
      { reason: inspection.reason },
    );
    capabilities.semanticTokensProvider = undefined;
  }
  initialize(): void {}
  getState(): FeatureState { return { kind: "static" }; }
  clear(): void { this.legend = undefined; }
}
```

Use `writeLog` events and stable reason fields from the design. Never throw on server input.

- [ ] **Step 4: Verify feature GREEN**

Run: `npm run test:unit -- --run src/client/semantic-tokens.test.ts`

Expected: all feature tests pass.

- [ ] **Step 5: Write failing middleware isolation tests**

Test the concrete general middleware method with protocol request objects. A malformed full response
must become `null` and log its URI/reason; a later valid full response must pass; hover/completion
responses must remain reference-identical:

```ts
it("isolates malformed full data without changing unrelated requests", async () => {
  feature.preInitialize(validCapabilities, selector);
  const middleware = feature.middleware;
  const malformed = await middleware.sendRequest?.(
    SemanticTokensRequest.type,
    { textDocument: { uri: "file:///game.fs" } },
    undefined,
    async () => ({ data: [0, 0] }),
  );
  const hover = { contents: "still alive" };
  const unrelated = await middleware.sendRequest?.(
    HoverRequest.type,
    hoverParams,
    undefined,
    async () => hover,
  );
  expect(malformed).toBeNull();
  expect(unrelated).toBe(hover);
});
```

- [ ] **Step 6: Run and verify middleware RED**

Run: `npm run test:unit -- --run src/client/semantic-tokens.test.ts`

Expected: FAIL because raw-response middleware is missing.

- [ ] **Step 7: Implement minimal middleware**

Expose a `middleware` getter or `createMiddleware()` method returning only `sendRequest`. Resolve the
method from either a string or message signature, always call `next`, and validate only
`textDocument/semanticTokens/full`. Return `null` on validation failure and log
`lsp.semantic_tokens.response_malformed`; pass all other values unchanged.

- [ ] **Step 8: Verify GREEN and commit**

Run: `npm run test:unit -- --run src/client/semantic-tokens.test.ts && npm run typecheck && npm run lint`

Expected: focused tests, typecheck, and lint pass.

```bash
git add src/client/semantic-tokens.ts src/client/semantic-tokens.test.ts
git commit -m "feat: guard semantic token capability and responses"
```

### Task 3: Compose with the real language client

**Files:**
- Modify: `src/client/language-client.ts`
- Modify: `src/client/language-client.test.ts`

- [ ] **Step 1: Extend the base-client test double and write failing wiring tests**

Add `registerFeature` capture to the existing `LanguageClient` mock. Assert one
`FoundrySemanticTokensFeature` is registered after construction and that `clientOptions.middleware`
contains both existing diagnostics handling (when supplied) and semantic `sendRequest` handling.
Drive the captured feature through fill/pre-initialize and the captured middleware through a valid
fixture response.

- [ ] **Step 2: Run and verify wiring RED**

Run: `npm run test:unit -- --run src/client/language-client.test.ts`

Expected: FAIL because the language client does not register or compose the semantic contract.

- [ ] **Step 3: Register and compose the feature**

After `super(...)`, construct `FoundrySemanticTokensFeature(outputChannel)`, call
`this.registerFeature(feature)`, and supply its general `sendRequest` middleware in the existing
client options. Preserve `handleDiagnostics` exactly when present:

```ts
middleware: {
  ...semanticTokens.middleware,
  ...(onDiagnostics === undefined
    ? {}
    : { handleDiagnostics: (uri, diagnostics) => onDiagnostics(uri, diagnostics) }),
},
```

Because client options must be passed to `super`, create the contract object before `super` only if
it has no dependency on `this`, or use a small factory that returns the feature and middleware.
Register the same feature instance immediately after `super` and before `start()` can run.

- [ ] **Step 4: Verify client GREEN and nearby lifecycle behavior**

Run:
`npm run test:unit -- --run src/client/language-client.test.ts src/client/connection-manager.test.ts src/client/runtime.test.ts`

Expected: all language-client, manager, and runtime tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/language-client.ts src/client/language-client.test.ts
git commit -m "feat: consume server semantic tokens through language client"
```

### Task 4: Deterministic server protocol fixture

**Files:**
- Create: `src/client/fixtures/semantic-tokens.json`
- Modify: `src/client/semantic-tokens.test.ts`

- [ ] **Step 1: Add the server fixture and failing dynamic-decoding assertions**

The JSON fixture begins with the exact server-advertised initialize capability and at least one
fully specified document exchange:

```json
{
  "initializeResult": {
    "capabilities": {
      "semanticTokensProvider": {
        "legend": {
          "tokenTypes": ["namespace", "class", "interface", "struct", "enum", "enumMember", "event", "type", "typeParameter", "function", "method", "property", "variable", "parameter", "decorator", "keyword"],
          "tokenModifiers": ["declaration", "static", "abstract", "final", "async", "readonly", "defaultLibrary"]
        },
        "full": true,
        "range": false
      }
    }
  },
  "documents": [
    {
      "uri": "file:///fixture/contextual.fs",
      "opened": {
        "text": "extend int:\n\tvar extend := 1\n",
        "response": { "data": [0, 0, 6, 15, 0, 0, 7, 3, 7, 64, 1, 5, 6, 12, 1] },
        "expect": [
          { "lexeme": "extend", "line": 0, "start": 0, "length": 6, "type": "keyword", "modifiers": [] },
          { "lexeme": "int", "line": 0, "start": 7, "length": 3, "type": "type", "modifiers": ["defaultLibrary"] },
          { "lexeme": "extend", "line": 1, "start": 5, "length": 6, "type": "variable", "modifiers": ["declaration"] }
        ]
      }
    }
  ]
}
```

Extend this exact schema with responses from the merged server contract rather than a production
client constant. Each document records source text, flat full-response data, and expectations by lexeme,
absolute UTF-16 line/start/length, type name, and modifier names. Include:

- contextual roles and same-spelled locals for `extend`, `async`, `annotation`, `targets`, `get`,
  and `set`;
- every required symbol type and all modifiers;
- astral-before-token and astral-within-token records; and
- an opened response plus changed response for the same URI.

In the test only, decode five-field relative records and resolve names dynamically through
`provider.legend`. Assert every fixture expectation and assert the opened/changed decoded streams
differ. Do not export this decoder or legend to production.

- [ ] **Step 2: Run and verify fixture RED**

Run: `npm run test:unit -- --run src/client/semantic-tokens.test.ts`

Expected: FAIL until the fixture data and dynamic assertions agree with the server contract.

- [ ] **Step 3: Add all required deterministic fixture cases and verify GREEN**

Run: `npm run test:unit -- --run src/client/semantic-tokens.test.ts`

Expected: fixture classification, UTF-16, and managed-buffer assertions pass.

- [ ] **Step 4: Commit**

```bash
git add src/client/fixtures/semantic-tokens.json src/client/semantic-tokens.test.ts
git commit -m "test: cover Foundry semantic token protocol fixtures"
```

### Task 5: Manifest and fallback documentation

**Files:**
- Modify: `package.json`
- Modify: `src/extension.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing manifest/fallback tests**

```ts
it("contributes only the custom final semantic token modifier", () => {
  expect(packageManifest.contributes.semanticTokenModifiers).toEqual([
    {
      id: "final",
      description: "Marks a final FoundryScript declaration.",
    },
  ]);
  expect("semanticTokenTypes" in packageManifest.contributes).toBe(false);
});

it("retains the TextMate grammar fallback", () => {
  expect(packageManifest.contributes.grammars).toContainEqual(
    expect.objectContaining({
      language: "foundryscript",
      scopeName: "source.foundryscript",
      path: "./syntaxes/foundryscript.tmLanguage.json",
    }),
  );
});
```

- [ ] **Step 2: Run and verify manifest RED**

Run: `npm run test:unit -- --run src/extension.test.ts`

Expected: FAIL because `semanticTokenModifiers` is absent.

- [ ] **Step 3: Add the single contribution and documentation**

Add exactly one `contributes.semanticTokenModifiers` entry for `final`. Update README highlighting
documentation with analyzer-backed semantics, server dependency, TextMate immediate/disabled/
unavailable fallback, and full-only behavior. Do not change the grammar.

- [ ] **Step 4: Verify GREEN, grammar fallback, package validation, and commit**

Run:
`npm run test:unit -- --run src/extension.test.ts && npm run test:grammar && npm run package`

Expected: manifest tests, all 8 grammar fixtures, and VSIX packaging pass.

```bash
git add package.json src/extension.test.ts README.md
git commit -m "docs: enable semantic highlighting with TextMate fallback"
```

### Task 6: Real Foundry TCP acceptance

**Files:**
- No Foundry engine source modifications.
- Optional temporary files only under a `mktemp -d` directory.

- [ ] **Step 1: Resolve a verifiable engine source and binary**

Create a temporary/shared clone from `/Users/christian/CafecitoGames/Foundry`, fetch merge commit
`bd801d667e9c6118fc4617cc53dc0e08175adeaa` directly from GitHub into the clone, and detach at that
commit. Do not touch the dirty primary engine checkout or its `.claude/` files.

- [ ] **Step 2: Reuse or build a revision-matched binary**

If no binary can be proven to contain the commit, build in the temporary checkout following its
`AGENTS.md`, with macOS editor, `dev_mode=yes`, and tests enabled. Reuse the documented SCons cache;
do not clean shared caches or publish engine refs/code.

- [ ] **Step 3: Drive the TCP sequence**

Use a temporary project and ephemeral loopback port. Spawn:

```bash
<binary> lsp serve --port <port> --project <temp-project>
```

Use `vscode-jsonrpc/node` from this repository to send `initialize`, `initialized`, `didOpen`,
`textDocument/semanticTokens/full`, `didChange`, and a second full request. Shut down/exit and stop
the owned process in `finally`.

- [ ] **Step 4: Assert observable server behavior**

Validate full plain true, absent/false range, no delta shape, and dynamic advertised legend. Decode
responses by that legend and assert contextual vs local names, representative symbol types/all
modifiers, UTF-16 astral positions, and changed-buffer output. Record revision, binary path, command,
and assertion counts for the final report.

- [ ] **Step 5: Run full local publish gate**

Run:

```bash
npm run test:unit -- --run src/client/semantic-tokens.test.ts src/client/language-client.test.ts src/extension.test.ts
npm test
npm run typecheck
npm run lint
npm run build
npm run package
git diff --check origin/main...HEAD
```

Expected: all focused/full tests, grammar fixtures, typecheck, lint, build, package, and diff check
pass.

### Task 7: Review, publish, merge, and cleanup

**Files:**
- Modify only files required by validated review findings, each under a fresh RED-to-GREEN cycle.

- [ ] **Step 1: Commit any remaining intended files and verify clean status**

Run: `git status --short --untracked-files=all`

Expected: no output.

- [ ] **Step 2: Fetch and integrate advanced main if needed**

Run: `git fetch origin main && git rev-list --left-right --count origin/main...HEAD`

If main advanced, rebase/integrate it, rerun Task 6 Step 5, and commit conflict resolutions before
review.

- [ ] **Step 3: Run read-only Cursor review against `origin/main`**

Use `/Users/christian/.agents/skills/cursor-review/SKILL.md` exactly: one foreground plan-mode
review, mutation guard, valid structured output, and no parsing before process exit.

- [ ] **Step 4: Converge on clean**

Apply receiving-code-review and systematic-debugging to every finding. For each real issue, write a
focused failing regression, verify RED, implement, verify GREEN/broader suite, commit, and run a new
Cursor round. Do not publish a final HEAD without valid `RESULT: clean`.

- [ ] **Step 5: Repeat the fresh publish gate and publish**

Run Task 6 Step 5 again on final reviewed HEAD. Push `issue-17`, open a ready PR to `main` ending
`Closes #17`, and only then enable squash auto-merge.

- [ ] **Step 6: Monitor through actual merge and clean up**

Watch every CI check. If CI or main changes require a new HEAD, fix/integrate, rerun verification and
Cursor, push, then restore auto-merge. After GitHub reports merged and issue #17 closed, verify the
merge in `origin/main`, delete the remote/local `issue-17` branch, and remove only the issue-17
worktree.
