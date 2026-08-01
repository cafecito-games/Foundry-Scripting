import { describe, expect, it } from "vitest";
import {
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
