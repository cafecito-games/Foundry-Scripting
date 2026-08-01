import { describe, expect, it } from "vitest";
import additiveFixture from "./fixtures/capabilities-additive.json";
import minimalFixture from "./fixtures/capabilities-minimal.json";
import multiVersionFixture from "./fixtures/capabilities-multi-version.json";
import {
  TestAdapterCapabilitiesError,
  parseAndNegotiateCapabilities,
} from "./capabilities.js";

const fixtures: Record<string, unknown> = {
  "capabilities-additive.json": additiveFixture,
  "capabilities-minimal.json": minimalFixture,
  "capabilities-multi-version.json": multiVersionFixture,
};

describe("Foundry test adapter capabilities", () => {
  it("parses the complete framework-neutral minimal fixture", () => {
    expect(
      parseAndNegotiateCapabilities(fixture("capabilities-minimal.json"), [1]),
    ).toEqual({
      protocolVersion: 1,
      framework: {
        id: "neutral-spec",
        name: "Neutral Spec",
        version: "2.4.0",
      },
      extensions: [],
    });
  });

  it("ignores unknown additive top-level and framework fields", () => {
    expect(
      parseAndNegotiateCapabilities(fixture("capabilities-additive.json"), [1]),
    ).toEqual({
      protocolVersion: 1,
      framework: {
        id: "neutral-spec",
        name: "Neutral Spec",
        version: "2.4.0",
      },
      extensions: ["neutral.coverage"],
    });
  });

  it("selects the highest mutually supported version", () => {
    expect(
      parseAndNegotiateCapabilities(
        fixture("capabilities-multi-version.json"),
        [1, 2, 3],
      ).protocolVersion,
    ).toBe(2);
  });

  it("reports a valid document with no shared version as incompatible", () => {
    const error = captureCapabilitiesError(() =>
      parseAndNegotiateCapabilities(
        jsonBytes(validCapabilities({ supported_versions: [2, 4] })),
        [1, 3],
      ),
    );

    expect(error).toMatchObject({ kind: "incompatible_adapter" });
    expect(error.message).toContain("supported protocol version");
  });

  it.each([
    {
      name: "UTF-8 byte-order mark",
      bytes: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        jsonBytes(validCapabilities()),
      ]),
      message: "byte-order mark",
    },
    {
      name: "invalid UTF-8",
      bytes: Buffer.from([0xc3, 0x28, 0x0a]),
      message: "UTF-8",
    },
    {
      name: "missing terminal LF",
      bytes: Buffer.from(JSON.stringify(validCapabilities())),
      message: "terminal LF",
    },
    {
      name: "CRLF",
      bytes: Buffer.from(`${JSON.stringify(validCapabilities())}\r\n`),
      message: "carriage returns",
    },
    {
      name: "malformed JSON",
      bytes: Buffer.from("{\n"),
      message: "JSON",
    },
    {
      name: "multiple JSON values",
      bytes: Buffer.from("{}\n{}\n"),
      message: "JSON",
    },
    {
      name: "array root",
      bytes: jsonBytes([]),
      message: "top level",
    },
  ])("rejects $name", ({ bytes, message }) => {
    const error = captureCapabilitiesError(() =>
      parseAndNegotiateCapabilities(bytes, [1]),
    );

    expect(error).toMatchObject({ kind: "malformed_capabilities" });
    expect(error.message).toContain(message);
  });

  it.each([
    {
      name: "missing protocol",
      document: validCapabilities({ protocol: undefined }),
      message: "protocol",
    },
    {
      name: "wrong protocol",
      document: validCapabilities({ protocol: "another-protocol" }),
      message: "protocol",
    },
    {
      name: "missing versions",
      document: validCapabilities({ supported_versions: undefined }),
      message: "supported_versions",
    },
    {
      name: "non-array versions",
      document: validCapabilities({ supported_versions: 1 }),
      message: "supported_versions",
    },
    {
      name: "empty versions",
      document: validCapabilities({ supported_versions: [] }),
      message: "supported_versions",
    },
    {
      name: "duplicate versions",
      document: validCapabilities({ supported_versions: [1, 1] }),
      message: "ascending",
    },
    {
      name: "unsorted versions",
      document: validCapabilities({ supported_versions: [2, 1] }),
      message: "ascending",
    },
    {
      name: "fractional version",
      document: validCapabilities({ supported_versions: [1.5] }),
      message: "positive integers",
    },
    {
      name: "zero version",
      document: validCapabilities({ supported_versions: [0] }),
      message: "positive integers",
    },
    {
      name: "missing framework",
      document: validCapabilities({ framework: undefined }),
      message: "framework",
    },
    {
      name: "array framework",
      document: validCapabilities({ framework: [] }),
      message: "framework",
    },
    {
      name: "empty framework id",
      document: validCapabilities({
        framework: { id: "", name: "Neutral", version: "1" },
      }),
      message: "framework.id",
    },
    {
      name: "control character in framework name",
      document: validCapabilities({
        framework: { id: "neutral", name: "Bad\u0007Name", version: "1" },
      }),
      message: "framework.name",
    },
    {
      name: "missing framework version",
      document: validCapabilities({
        framework: { id: "neutral", name: "Neutral" },
      }),
      message: "framework.version",
    },
    {
      name: "missing extensions",
      document: validCapabilities({ extensions: undefined }),
      message: "extensions",
    },
    {
      name: "non-array extensions",
      document: validCapabilities({ extensions: {} }),
      message: "extensions",
    },
    {
      name: "empty extension",
      document: validCapabilities({ extensions: [""] }),
      message: "extensions[0]",
    },
    {
      name: "control character in extension",
      document: validCapabilities({ extensions: ["bad\u007fextension"] }),
      message: "extensions[0]",
    },
    {
      name: "duplicate extension",
      document: validCapabilities({ extensions: ["coverage", "coverage"] }),
      message: "unique",
    },
  ])("rejects a document with $name", ({ document, message }) => {
    const error = captureCapabilitiesError(() =>
      parseAndNegotiateCapabilities(jsonBytes(document), [1]),
    );

    expect(error).toMatchObject({ kind: "malformed_capabilities" });
    expect(error.message).toContain(message);
  });
});

function fixture(name: string): Buffer {
  return jsonBytes(fixtures[name]);
}

function validCapabilities(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    protocol: "foundry-test-adapter",
    supported_versions: [1],
    framework: { id: "neutral", name: "Neutral", version: "1.0.0" },
    extensions: [],
    ...overrides,
  };
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined) {
      delete document[key];
    }
  }
  return document;
}

function jsonBytes(document: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(document)}\n`);
}

function captureCapabilitiesError(callback: () => unknown): TestAdapterCapabilitiesError {
  try {
    callback();
  } catch (error) {
    if (error instanceof TestAdapterCapabilitiesError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a test adapter capabilities error.");
}
