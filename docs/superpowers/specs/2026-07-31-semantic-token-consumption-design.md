# Semantic Token Consumption Design

**Status:** Approved

## Goal

Consume the Foundry language server's advertised full-document semantic tokens through
`vscode-languageclient` so analyzer-backed classifications refine the existing TextMate grammar.
The extension owns protocol compatibility and graceful degradation; Foundry remains the only owner
of classification and of the ordered semantic-token legend.

## Boundaries

- Keep `vscode-languageclient` as the semantic-token provider, request sender, document synchronizer,
  and converter into VS Code semantic tokens.
- Do not register a second VS Code semantic-token provider.
- Do not classify FoundryScript source in TypeScript.
- Do not maintain an ordered production token-type or modifier legend. The client retains the legend
  received in the server's initialize response only for validating that connection's responses.
- Contribute only the custom `final` modifier in `package.json`; all token types and other modifiers
  are standard VS Code/LSP values.
- Support only the server's full-document response. Range, delta, and server-initiated refresh are
  outside this feature.
- Leave the checked-in TextMate grammar unchanged. It remains immediate highlighting while the
  server starts and the fallback when semantic highlighting is disabled or unavailable.

## Architecture

Add a focused `src/client/semantic-tokens.ts` protocol-contract unit. It supplies two integration
pieces to `FoundryScriptLanguageClient`:

1. A `StaticFeature` that augments and validates semantic-token capabilities.
2. General request middleware that validates raw full-document responses before
   `vscode-languageclient` converts them.

The existing language client still owns the provider registration, server-advertised legend,
document selector, `didOpen`/`didChange` synchronization, full request, cancellation, and result
conversion.

### Client capability augmentation

During client capability construction, the feature locates the modifier list created by
`vscode-languageclient` and appends `final` only when absent. It does not replace, reorder, or copy
the standard modifier list. Repeated invocation is idempotent.

The manifest contributes:

```json
{
  "id": "final",
  "description": "Marks a final FoundryScript declaration."
}
```

No custom semantic token type is contributed.

### Server capability validation

The feature's `preInitialize` hook runs before all built-in features initialize. It inspects
`semanticTokensProvider` from the actual initialize response:

- An absent provider is valid degradation. Log `lsp.semantic_tokens.unavailable` at info level and
  let TextMate remain the only highlighter.
- A supported provider is an object with a valid, unique, non-empty string legend, `full` equal to
  the plain boolean `true`, and `range` either absent or explicitly `false`. The legend must include
  `final` among its modifiers. Record a defensive copy of that advertised legend and log
  `lsp.semantic_tokens.enabled` with counts.
- A structurally invalid provider or legend is malformed. Log
  `lsp.semantic_tokens.capability_malformed` with a stable reason code.
- A structurally valid provider that advertises a different request shape is a contract mismatch.
  Log `lsp.semantic_tokens.capability_mismatch` with the advertised full/range shapes.

For malformed or mismatched capabilities, clear only `semanticTokensProvider` from the capability
object before the built-in semantic-token feature initializes. This prevents provider registration
for the bad contract without failing client startup or disabling completion, diagnostics, or other
LSP features.

An object-valued `full` capability is rejected even when `delta` is false because the approved
upstream contract advertises a plain boolean and the extension intentionally does not consume delta
registration. An absent or false `range` capability is accepted because both spell no range support.

### Response validation

General `sendRequest` middleware delegates every request to the existing next handler. It examines
the returned value only when the method is exactly `textDocument/semanticTokens/full`.

`null` is a valid empty result. A non-null response is accepted only when:

- it is an object whose `data` is an array;
- the array length is divisible by five;
- every field is a non-negative protocol integer;
- each token length is greater than zero;
- each token-type index exists in the current server-advertised legend; and
- each modifier bit fits the current server-advertised modifier legend.

An optional `resultId` must be a string. The validator does not inspect source text, recalculate
classifications, or translate token indices. On failure it logs
`lsp.semantic_tokens.response_malformed` with a stable reason and document URI, then returns `null`
to the built-in provider. Other requests and future successful semantic-token requests remain
usable.

## Data Flow

1. `vscode-languageclient` builds its normal semantic-token client capability.
2. The custom static feature adds `final` to the supported modifier names.
3. Foundry replies to initialize with its full-only provider and ordered legend.
4. The feature validates the response in `preInitialize`; the built-in feature then registers a
   full-document provider using that exact legend.
5. The built-in document synchronization features send open and change notifications.
6. VS Code asks the built-in provider for full semantic tokens.
7. Raw response middleware validates the five-integer records against the connection's advertised
   legend.
8. `vscode-languageclient` converts the accepted response for VS Code, which layers it over the
   TextMate result.

## Tests

Strict RED-to-GREEN cycles cover each behavior before implementation.

### Unit and deterministic protocol coverage

A checked-in protocol fixture represents server messages, not a client-owned legend. Its initialize
response carries the ordered legend exactly as a server does, and all assertions resolve type names
and modifier names dynamically through that advertised value. The fixture includes:

- contextual `extend`, `async`, `annotation`, `targets`, `get`, and `set`, plus the same spellings as
  ordinary identifiers;
- namespaces, native/project classes, traits, tuples, enums/members, signals, types/type parameters,
  functions/methods, properties, locals, parameters, constants, and annotations;
- declaration, static, abstract, final, async, readonly, and default-library modifiers;
- a token starting after an astral character and a token containing an astral character, expressed
  in UTF-16 columns and lengths; and
- full responses before and after a managed-buffer `didChange`, with observably different tokens.

Focused tests also cover:

- idempotent advertisement of only `final` beyond the library defaults;
- manifest contribution of `final` and no custom token types;
- accepted full-only capability with absent or false range and no delta;
- missing capability fallback;
- malformed/duplicate legend and mismatched range/delta capability degradation;
- malformed response shapes, record widths, values, token types, and modifier masks;
- an unrelated request returning unchanged after a malformed semantic-token response; and
- the existing TextMate grammar remaining packaged and useful without semantic tokens.

### Real-server acceptance

Use an isolated temporary/shared clone of the Foundry engine detached at or containing merge commit
`bd801d667e9c6118fc4617cc53dc0e08175adeaa`. Do not modify or publish engine code. Prefer a binary
whose source revision can be verified; otherwise build that isolated checkout with the repository's
documented development flags and shared cache.

Drive the real TCP language server through initialize, initialized, didOpen, full request,
didChange, and a second full request. Decode records through the server-advertised legend and verify
the full-only capability, requested contextual and symbol samples, modifier samples, UTF-16 astral
coordinates, and managed-buffer change. Capture the exact binary/revision, command, and observed
results in the final report. A build/environment failure is reported with exact evidence only after
safe build paths are exhausted; it does not weaken deterministic tests.

## Documentation

Update the README to explain that semantic highlighting is analyzer-backed when a compatible
Foundry server is connected, that TextMate remains the immediate/disabled/unavailable fallback, and
that range/delta/refresh are not consumed.

## Non-goals

- Reimplementing classification, parsing, or UTF-16 conversion in the extension.
- A client-owned production legend.
- Range requests, delta edits, or refresh notifications.
- Semantic-token theme rules or custom token types.
- Changes to the TextMate grammar or Foundry engine source.
