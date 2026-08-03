import type {
  ClientCapabilities,
  FeatureState,
  Middleware,
  ServerCapabilities,
  StaticFeature,
} from "vscode-languageclient/node";
import { type LogOutput, writeLog } from "./logging.js";

export const CUSTOM_SEMANTIC_TOKEN_MODIFIER = "final";
const VS_CODE_FOUNDRY_SCRIPT_LANGUAGE_ID = "foundryscript";
const FOUNDRY_LSP_LANGUAGE_ID = "foundry_script";

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
  if (!isUnknownArray(response.data)) {
    return { ok: false, reason: "data_not_array" };
  }
  if (response.data.length % 5 !== 0) {
    return { ok: false, reason: "record_width_invalid" };
  }

  const modifierMask = 2 ** legend.tokenModifiers.length - 1;
  for (let index = 0; index < response.data.length; index += 5) {
    const deltaLine = response.data[index];
    const deltaStart = response.data[index + 1];
    const length = response.data[index + 2];
    const tokenType = response.data[index + 3];
    const tokenModifiers = response.data[index + 4];
    if (
      !isUinteger(deltaLine) ||
      !isUinteger(deltaStart) ||
      !isUinteger(length) ||
      !isUinteger(tokenType) ||
      !isUinteger(tokenModifiers)
    ) {
      return { ok: false, reason: "record_value_invalid" };
    }
    if (length === 0) {
      return { ok: false, reason: "token_length_zero" };
    }
    if (tokenType >= legend.tokenTypes.length) {
      return { ok: false, reason: "token_type_out_of_range" };
    }
    if (tokenModifiers > modifierMask) {
      return { ok: false, reason: "token_modifiers_out_of_range" };
    }
  }

  return { ok: true, value };
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function capabilityShape(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function requestMethod(type: unknown): string | undefined {
  if (typeof type === "string") return type;
  if (
    typeof type === "object" &&
    type !== null &&
    "method" in type &&
    typeof type.method === "string"
  ) {
    return type.method;
  }
  return undefined;
}

function semanticTokensUri(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const textDocument = (params as { textDocument?: unknown }).textDocument;
  if (typeof textDocument !== "object" || textDocument === null) {
    return undefined;
  }
  const uri = (textDocument as { uri?: unknown }).uri;
  return typeof uri === "string" ? uri : undefined;
}

function normalizeDidOpenParams(params: unknown): unknown {
  if (typeof params !== "object" || params === null) return params;
  const textDocument = (params as { textDocument?: unknown }).textDocument;
  if (typeof textDocument !== "object" || textDocument === null) return params;
  if (
    (textDocument as { languageId?: unknown }).languageId !==
    VS_CODE_FOUNDRY_SCRIPT_LANGUAGE_ID
  ) {
    return params;
  }
  return {
    ...params,
    textDocument: {
      ...textDocument,
      languageId: FOUNDRY_LSP_LANGUAGE_ID,
    },
  };
}

export class FoundrySemanticTokensFeature implements StaticFeature {
  private legend: AdvertisedSemanticTokensLegend | undefined;

  constructor(private readonly output: LogOutput) {}

  get middleware(): Pick<Middleware, "sendRequest" | "sendNotification"> {
    return {
      sendRequest: async (type, params, token, next) => {
        const result = await next(type, params, token);
        if (requestMethod(type) !== "textDocument/semanticTokens/full") {
          return result;
        }

        const validation =
          this.legend === undefined
            ? { ok: false as const, reason: "legend_unavailable" }
            : validateSemanticTokensResponse(result, this.legend);
        if (validation.ok) {
          return validation.value as typeof result;
        }

        writeLog(
          this.output,
          "warn",
          "lsp.semantic_tokens.response_malformed",
          {
            reason: validation.reason,
            uri: semanticTokensUri(params),
          },
        );
        return null as typeof result;
      },
      sendNotification: (type, next, params) =>
        next(
          type,
          (requestMethod(type) === "textDocument/didOpen"
            ? normalizeDidOpenParams(params)
            : params) as typeof params,
        ),
    };
  }

  fillClientCapabilities(capabilities: ClientCapabilities): void {
    const modifiers = capabilities.textDocument?.semanticTokens?.tokenModifiers;
    if (
      modifiers !== undefined &&
      !modifiers.includes(CUSTOM_SEMANTIC_TOKEN_MODIFIER)
    ) {
      modifiers.push(CUSTOM_SEMANTIC_TOKEN_MODIFIER);
    }
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

    const provider = capabilities.semanticTokensProvider as
      | Record<string, unknown>
      | undefined;
    writeLog(
      this.output,
      "warn",
      inspection.kind === "malformed"
        ? "lsp.semantic_tokens.capability_malformed"
        : "lsp.semantic_tokens.capability_mismatch",
      {
        reason: inspection.reason,
        full: capabilityShape(provider?.full),
        range: capabilityShape(provider?.range),
      },
    );
    delete capabilities.semanticTokensProvider;
  }

  initialize(): void {}

  getState(): FeatureState {
    return { kind: "static" };
  }

  clear(): void {
    this.legend = undefined;
  }
}
