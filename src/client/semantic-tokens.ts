export const CUSTOM_SEMANTIC_TOKEN_MODIFIER = "final";

export interface AdvertisedSemanticTokensLegend {
  readonly tokenTypes: readonly string[];
  readonly tokenModifiers: readonly string[];
}

export type ProviderInspection =
  | { readonly kind: "missing" }
  | {
      readonly kind: "supported";
      readonly legend: AdvertisedSemanticTokensLegend;
    }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "mismatch"; readonly reason: string };

export type SemanticTokensValidation =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

const LSP_MAX_UINTEGER = 2_147_483_647;

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export function inspectSemanticTokensProvider(
  value: unknown,
): ProviderInspection {
  if (value === undefined) {
    return { kind: "missing" };
  }
  if (typeof value !== "object" || value === null) {
    return { kind: "malformed", reason: "provider_not_object" };
  }

  const provider = value as Record<string, unknown>;
  if (typeof provider.legend !== "object" || provider.legend === null) {
    return { kind: "malformed", reason: "legend_not_object" };
  }
  const legend = provider.legend as Record<string, unknown>;
  if (!isNonEmptyStringArray(legend.tokenTypes)) {
    return { kind: "malformed", reason: "token_types_invalid" };
  }
  if (!isNonEmptyStringArray(legend.tokenModifiers)) {
    return { kind: "malformed", reason: "token_modifiers_invalid" };
  }
  if (hasDuplicates(legend.tokenTypes) || hasDuplicates(legend.tokenModifiers)) {
    return { kind: "malformed", reason: "legend_duplicates" };
  }
  if (legend.tokenModifiers.length > 31) {
    return { kind: "malformed", reason: "too_many_modifiers" };
  }
  if (!legend.tokenModifiers.includes(CUSTOM_SEMANTIC_TOKEN_MODIFIER)) {
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

function isUinteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= LSP_MAX_UINTEGER
  );
}

export function validateSemanticTokensResponse(
  value: unknown,
  legend: AdvertisedSemanticTokensLegend,
): SemanticTokensValidation {
  if (value === null) {
    return { ok: true, value };
  }
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "response_not_object" };
  }

  const response = value as { data?: unknown; resultId?: unknown };
  if (
    response.resultId !== undefined &&
    typeof response.resultId !== "string"
  ) {
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
    if (!record.every(isUinteger)) {
      return { ok: false, reason: "record_value_invalid" };
    }
    if (record[2] === 0) {
      return { ok: false, reason: "token_length_zero" };
    }
    if (record[3] >= legend.tokenTypes.length) {
      return { ok: false, reason: "token_type_out_of_range" };
    }
    if (record[4] > modifierMask) {
      return { ok: false, reason: "token_modifiers_out_of_range" };
    }
  }

  return { ok: true, value };
}
