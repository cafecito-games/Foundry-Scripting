import { TextDecoder } from "node:util";

export type TestAdapterCapabilitiesErrorKind =
  | "malformed_capabilities"
  | "incompatible_adapter";

export class TestAdapterCapabilitiesError extends Error {
  constructor(
    readonly kind: TestAdapterCapabilitiesErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TestAdapterCapabilitiesError";
  }
}

export interface TestFrameworkMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

export interface NegotiatedTestAdapter {
  readonly protocolVersion: number;
  readonly framework: TestFrameworkMetadata;
  readonly extensions: readonly string[];
}

export function parseAndNegotiateCapabilities(
  bytes: Uint8Array,
  clientVersions: readonly number[],
): NegotiatedTestAdapter {
  const text = decodeCapabilities(bytes);
  const document = parseDocument(text);
  const versions = parseVersions(document.supported_versions);
  const framework = parseFramework(document.framework);
  const extensions = parseExtensions(document.extensions);

  if (document.protocol !== "foundry-test-adapter") {
    malformed('"protocol" must equal "foundry-test-adapter".');
  }

  const protocolVersion = [...clientVersions]
    .filter((version) => versions.includes(version))
    .sort((left, right) => right - left)[0];
  if (protocolVersion === undefined) {
    throw new TestAdapterCapabilitiesError(
      "incompatible_adapter",
      "The configured runner does not advertise a client-supported protocol version.",
    );
  }

  return { protocolVersion, framework, extensions };
}

function decodeCapabilities(bytes: Uint8Array): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    malformed("Capabilities must not contain a UTF-8 byte-order mark.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TestAdapterCapabilitiesError(
      "malformed_capabilities",
      "Capabilities must contain valid UTF-8.",
      { cause: error },
    );
  }
  if (!text.endsWith("\n")) {
    malformed("Capabilities must end with a terminal LF.");
  }
  if (text.includes("\r")) {
    malformed("Capabilities must use LF line endings without carriage returns.");
  }
  return text;
}

function parseDocument(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TestAdapterCapabilitiesError(
      "malformed_capabilities",
      "Capabilities must contain exactly one valid JSON value.",
      { cause: error },
    );
  }
  if (!isJsonObject(value)) {
    malformed("Capabilities top level must be a JSON object.");
  }
  return value;
}

function parseVersions(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    malformed('"supported_versions" must be a non-empty array.');
  }
  if (!value.every((version) => Number.isInteger(version) && version > 0)) {
    malformed('"supported_versions" must contain positive integers.');
  }
  const versions = value as number[];
  for (let index = 1; index < versions.length; index += 1) {
    if (versions[index] <= versions[index - 1]) {
      malformed('"supported_versions" must be unique and strictly ascending.');
    }
  }
  return versions;
}

function parseFramework(value: unknown): TestFrameworkMetadata {
  if (!isJsonObject(value)) {
    malformed('"framework" must be a JSON object.');
  }
  return {
    id: requiredProtocolString(value.id, "framework.id"),
    name: requiredProtocolString(value.name, "framework.name"),
    version: requiredProtocolString(value.version, "framework.version"),
  };
}

function parseExtensions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    malformed('"extensions" must be an array.');
  }
  const extensions = value.map((extension, index) =>
    requiredProtocolString(extension, `extensions[${index}]`),
  );
  if (new Set(extensions).size !== extensions.length) {
    malformed('"extensions" entries must be unique.');
  }
  return extensions;
}

function requiredProtocolString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    malformed(`"${field}" must be a non-empty string without control characters.`);
  }
  return value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(message: string): never {
  throw new TestAdapterCapabilitiesError("malformed_capabilities", message);
}
