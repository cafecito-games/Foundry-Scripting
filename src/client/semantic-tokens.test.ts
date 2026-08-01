import { describe, expect, it, vi } from "vitest";
import type {
  ClientCapabilities,
  ServerCapabilities,
} from "vscode-languageclient/node";
import {
  FoundrySemanticTokensFeature,
  inspectSemanticTokensProvider,
  validateSemanticTokensResponse,
} from "./semantic-tokens.js";

const fullOnlyProvider = {
  legend: {
    tokenTypes: ["keyword", "class"],
    tokenModifiers: ["readonly", "final"],
  },
  full: true,
  range: false,
};

describe("semantic token provider contract", () => {
  it("accepts the server-advertised full-only provider without reordering it", () => {
    expect(inspectSemanticTokensProvider(fullOnlyProvider)).toEqual({
      kind: "supported",
      legend: fullOnlyProvider.legend,
    });
  });

  it.each([undefined, false])(
    "accepts %s as no range support",
    (range) => {
      expect(
        inspectSemanticTokensProvider({ ...fullOnlyProvider, range }),
      ).toMatchObject({ kind: "supported" });
    },
  );

  it("returns a defensive copy of the advertised legend", () => {
    const provider = {
      ...fullOnlyProvider,
      legend: {
        tokenTypes: [...fullOnlyProvider.legend.tokenTypes],
        tokenModifiers: [...fullOnlyProvider.legend.tokenModifiers],
      },
    };
    const inspection = inspectSemanticTokensProvider(provider);
    if (inspection.kind !== "supported") {
      throw new Error("test provider was not accepted");
    }

    provider.legend.tokenTypes[0] = "mutated";
    provider.legend.tokenModifiers[0] = "mutated";

    expect(inspection.legend).toEqual({
      tokenTypes: ["keyword", "class"],
      tokenModifiers: ["readonly", "final"],
    });
  });

  it("treats an absent provider as TextMate fallback", () => {
    expect(inspectSemanticTokensProvider(undefined)).toEqual({
      kind: "missing",
    });
  });

  it.each([
    [null, "provider_not_object"],
    ["semantic tokens", "provider_not_object"],
    [{ full: true }, "legend_not_object"],
    [
      { ...fullOnlyProvider, legend: { ...fullOnlyProvider.legend, tokenTypes: [] } },
      "token_types_invalid",
    ],
    [
      {
        ...fullOnlyProvider,
        legend: { ...fullOnlyProvider.legend, tokenModifiers: ["final", 7] },
      },
      "token_modifiers_invalid",
    ],
    [
      {
        ...fullOnlyProvider,
        legend: { tokenTypes: ["class", "class"], tokenModifiers: ["final"] },
      },
      "legend_duplicates",
    ],
    [
      {
        ...fullOnlyProvider,
        legend: {
          tokenTypes: ["class"],
          tokenModifiers: Array.from({ length: 32 }, (_, index) =>
            index === 0 ? "final" : `modifier${index}`,
          ),
        },
      },
      "too_many_modifiers",
    ],
  ] as const)("rejects malformed provider %# with %s", (provider, reason) => {
    expect(inspectSemanticTokensProvider(provider)).toEqual({
      kind: "malformed",
      reason,
    });
  });

  it.each([
    [
      {
        ...fullOnlyProvider,
        legend: { ...fullOnlyProvider.legend, tokenModifiers: ["readonly"] },
      },
      "final_modifier_missing",
    ],
    [{ ...fullOnlyProvider, full: { delta: false } }, "full_not_plain_true"],
    [{ ...fullOnlyProvider, range: true }, "range_supported"],
  ] as const)("rejects provider contract mismatch %# with %s", (provider, reason) => {
    expect(inspectSemanticTokensProvider(provider)).toEqual({
      kind: "mismatch",
      reason,
    });
  });
});

describe("semantic token full response contract", () => {
  const legend = {
    tokenTypes: ["keyword", "class"],
    tokenModifiers: ["readonly", "final"],
  };

  it("accepts null as an empty semantic token result", () => {
    expect(validateSemanticTokensResponse(null, legend)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("accepts records without translating the server data", () => {
    const response = {
      data: [0, 0, 3, 0, 1, 1, 2, 4, 1, 2],
      resultId: "full-1",
    };

    expect(validateSemanticTokensResponse(response, legend)).toEqual({
      ok: true,
      value: response,
    });
  });

  it.each([
    [undefined, "response_not_object"],
    ["tokens", "response_not_object"],
    [{ resultId: "full-1" }, "data_not_array"],
    [{ data: [0, 0] }, "record_width_invalid"],
    [{ data: [0, 0, 3.5, 0, 0] }, "record_value_invalid"],
    [{ data: [0, -1, 3, 0, 0] }, "record_value_invalid"],
    [{ data: [0, 0, 2_147_483_648, 0, 0] }, "record_value_invalid"],
    [{ data: [0, 0, 0, 0, 0] }, "token_length_zero"],
    [{ data: [0, 0, 3, 2, 0] }, "token_type_out_of_range"],
    [{ data: [0, 0, 3, 0, 4] }, "token_modifiers_out_of_range"],
    [{ data: [], resultId: 17 }, "result_id_invalid"],
  ] as const)("rejects malformed full response %# with %s", (response, reason) => {
    expect(validateSemanticTokensResponse(response, legend)).toEqual({
      ok: false,
      reason,
    });
  });
});

describe("Foundry semantic token client feature", () => {
  function createFeature() {
    const output = { appendLine: vi.fn() };
    return {
      feature: new FoundrySemanticTokensFeature(output),
      output,
    };
  }

  it("adds final once to the library modifier list without changing token types", () => {
    const { feature } = createFeature();
    const capabilities = {
      textDocument: {
        semanticTokens: {
          tokenTypes: ["class", "keyword"],
          tokenModifiers: ["declaration", "readonly"],
          formats: ["relative"],
          requests: { full: true },
        },
      },
    };

    feature.fillClientCapabilities(capabilities as ClientCapabilities);
    feature.fillClientCapabilities(capabilities as ClientCapabilities);

    expect(capabilities.textDocument.semanticTokens.tokenTypes).toEqual([
      "class",
      "keyword",
    ]);
    expect(capabilities.textDocument.semanticTokens.tokenModifiers).toEqual([
      "declaration",
      "readonly",
      "final",
    ]);
  });

  it("retains and logs a supported server-advertised legend", () => {
    const { feature, output } = createFeature();
    const capabilities = {
      completionProvider: {},
      semanticTokensProvider: fullOnlyProvider,
    };

    feature.preInitialize(capabilities);

    expect(capabilities.semanticTokensProvider).toBe(fullOnlyProvider);
    expect(output.appendLine).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.appendLine.mock.calls[0]?.[0]))).toMatchObject({
      level: "info",
      event: "lsp.semantic_tokens.enabled",
      tokenTypeCount: 2,
      tokenModifierCount: 2,
    });
  });

  it("logs a missing provider as an available TextMate fallback", () => {
    const { feature, output } = createFeature();
    const capabilities = { completionProvider: {} };

    feature.preInitialize(capabilities);

    expect(capabilities).toEqual({ completionProvider: {} });
    expect(JSON.parse(String(output.appendLine.mock.calls[0]?.[0]))).toMatchObject({
      level: "info",
      event: "lsp.semantic_tokens.unavailable",
    });
  });

  it.each([
    [
      {
        ...fullOnlyProvider,
        legend: { tokenTypes: [], tokenModifiers: ["final"] },
      },
      "lsp.semantic_tokens.capability_malformed",
      "token_types_invalid",
    ],
    [
      { ...fullOnlyProvider, range: true },
      "lsp.semantic_tokens.capability_mismatch",
      "range_supported",
    ],
  ] as const)(
    "removes only rejected semantic capability %#",
    (provider, event, reason) => {
      const { feature, output } = createFeature();
      const capabilities: {
        completionProvider: object;
        semanticTokensProvider?: unknown;
      } = {
        completionProvider: {},
        semanticTokensProvider: provider,
      };

      feature.preInitialize(capabilities as ServerCapabilities);

      expect(capabilities).toEqual({ completionProvider: {} });
      expect(JSON.parse(String(output.appendLine.mock.calls[0]?.[0]))).toMatchObject({
        level: "warn",
        event,
        reason,
      });
    },
  );

  it("exposes static feature lifecycle without active registrations", () => {
    const { feature } = createFeature();

    feature.initialize();
    expect(feature.getState()).toEqual({ kind: "static" });
    expect(() => feature.clear()).not.toThrow();
  });

  it("turns malformed full data into null and logs the document", async () => {
    const { feature, output } = createFeature();
    feature.preInitialize({ semanticTokensProvider: fullOnlyProvider });
    const sendRequest = feature.middleware.sendRequest;
    if (sendRequest === undefined) {
      throw new Error("semantic request middleware was not installed");
    }

    const result = await sendRequest(
      "textDocument/semanticTokens/full",
      { textDocument: { uri: "file:///workspace/player.fs" } },
      undefined,
      () => Promise.resolve({ data: [0, 0] }),
    );

    expect(result).toBeNull();
    expect(JSON.parse(String(output.appendLine.mock.calls.at(-1)?.[0]))).toMatchObject(
      {
        level: "warn",
        event: "lsp.semantic_tokens.response_malformed",
        reason: "record_width_invalid",
        uri: "file:///workspace/player.fs",
      },
    );
  });

  it("passes a later valid full response without translating it", async () => {
    const { feature } = createFeature();
    feature.preInitialize({ semanticTokensProvider: fullOnlyProvider });
    const sendRequest = feature.middleware.sendRequest;
    if (sendRequest === undefined) {
      throw new Error("semantic request middleware was not installed");
    }
    const response = { data: [0, 0, 3, 0, 1] };

    const result = await sendRequest(
      { method: "textDocument/semanticTokens/full" } as never,
      { textDocument: { uri: "file:///workspace/player.fs" } },
      undefined,
      () => Promise.resolve(response),
    );

    expect(result).toBe(response);
  });

  it("passes unrelated LSP responses unchanged", async () => {
    const { feature, output } = createFeature();
    const sendRequest = feature.middleware.sendRequest;
    if (sendRequest === undefined) {
      throw new Error("semantic request middleware was not installed");
    }
    const hover = { contents: "still alive" };

    const result = await sendRequest(
      "textDocument/hover",
      {
        textDocument: { uri: "file:///workspace/player.fs" },
        position: { line: 0, character: 0 },
      },
      undefined,
      () => Promise.resolve(hover),
    );

    expect(result).toBe(hover);
    expect(output.appendLine).not.toHaveBeenCalled();
  });
});
