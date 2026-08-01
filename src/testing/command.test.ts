import { describe, expect, it } from "vitest";
import {
  TestAdapterConfigurationError,
  createTestAdapterCapabilitiesCommand,
  createTestAdapterDiscoveryCommand,
  createTestAdapterRunCommand,
} from "./command.js";

const baseRequest = {
  enginePath: "/opt/foundry",
  project: "/workspace/game",
  runner: "res://tests/runner.fs",
  frameworkArgs: [] as readonly string[],
  outputPath: "/tmp/capabilities.json",
};

describe("test adapter capabilities command", () => {
  it("places opaque framework arguments after both required boundaries", () => {
    const command = createTestAdapterCapabilitiesCommand({
      ...baseRequest,
      frameworkArgs: ["--path", "res://specs", "--output", "opaque"],
    });

    expect(command).toEqual({
      command: "/opt/foundry",
      cwd: "/workspace/game",
      args: [
        "--headless",
        "--no-header",
        "project",
        "test",
        "--project",
        "/workspace/game",
        "--runner",
        "res://tests/runner.fs",
        "--",
        "adapter",
        "capabilities",
        "--output",
        "/tmp/capabilities.json",
        "--",
        "--path",
        "res://specs",
        "--output",
        "opaque",
      ],
    });
  });

  it("omits only the adapter-level boundary when framework arguments are empty", () => {
    const command = createTestAdapterCapabilitiesCommand(baseRequest);

    expect(command.args).toEqual([
      "--headless",
      "--no-header",
      "project",
      "test",
      "--project",
      "/workspace/game",
      "--runner",
      "res://tests/runner.fs",
      "--",
      "adapter",
      "capabilities",
      "--output",
      "/tmp/capabilities.json",
    ]);
  });

  it("preserves empty and option-looking framework values exactly", () => {
    const command = createTestAdapterCapabilitiesCommand({
      ...baseRequest,
      frameworkArgs: ["", "--", "--protocol-version", "99"],
    });

    expect(command.args.slice(-5)).toEqual([
      "--",
      "",
      "--",
      "--protocol-version",
      "99",
    ]);
  });

  it.each([
    {
      name: "engine",
      request: { ...baseRequest, enginePath: "  " },
      kind: "missing_engine",
      setting: "foundryScript.enginePath",
    },
    {
      name: "project",
      request: { ...baseRequest, project: undefined },
      kind: "missing_project",
      setting: undefined,
    },
    {
      name: "runner",
      request: { ...baseRequest, runner: "" },
      kind: "missing_runner",
      setting: "foundryScript.testing.runner",
    },
  ])("reports an actionable missing $name", ({ request, kind, setting }) => {
    const error = captureConfigurationError(() =>
      createTestAdapterCapabilitiesCommand(request),
    );

    expect(error).toMatchObject({ kind, setting });
  });

  it.each([
    "/workspace/runner.fs",
    "tests/runner.fs",
    "res://",
    "res://tests\\runner.fs",
    "res://tests/./runner.fs",
    "res://tests/../runner.fs",
    "res://tests//runner.fs",
    "res://tests/",
  ])("rejects noncanonical runner resource %s", (runner) => {
    const error = captureConfigurationError(() =>
      createTestAdapterCapabilitiesCommand({ ...baseRequest, runner }),
    );

    expect(error).toMatchObject({
      kind: "invalid_runner",
      setting: "foundryScript.testing.runner",
    });
    expect(error.message).toContain("canonical res://");
  });

  it.each([
    "--path",
    ["--path", 42],
  ])("rejects malformed framework arguments %#", (frameworkArgs) => {
    const error = captureConfigurationError(() =>
      createTestAdapterCapabilitiesCommand({
        ...baseRequest,
        frameworkArgs: frameworkArgs as unknown as readonly string[],
      }),
    );

    expect(error).toMatchObject({
      kind: "invalid_args",
      setting: "foundryScript.testing.args",
    });
    expect(error.message).toContain("array of strings");
  });
});

describe("test adapter discovery command", () => {
  const discoveryRequest = {
    ...baseRequest,
    protocolVersion: 1,
    outputPath: "/tmp/discovery.jsonl",
  };

  it("places the negotiated version and opaque arguments after reserved options", () => {
    const command = createTestAdapterDiscoveryCommand({
      ...discoveryRequest,
      frameworkArgs: ["--path", "res://specs", "--output", "opaque"],
    });

    expect(command).toEqual({
      command: "/opt/foundry",
      cwd: "/workspace/game",
      args: [
        "--headless",
        "--no-header",
        "project",
        "test",
        "--project",
        "/workspace/game",
        "--runner",
        "res://tests/runner.fs",
        "--",
        "adapter",
        "discover",
        "--protocol-version",
        "1",
        "--output",
        "/tmp/discovery.jsonl",
        "--",
        "--path",
        "res://specs",
        "--output",
        "opaque",
      ],
    });
  });

  it("omits only the adapter-level boundary when framework arguments are empty", () => {
    const command = createTestAdapterDiscoveryCommand(discoveryRequest);

    expect(command.args).toEqual([
      "--headless",
      "--no-header",
      "project",
      "test",
      "--project",
      "/workspace/game",
      "--runner",
      "res://tests/runner.fs",
      "--",
      "adapter",
      "discover",
      "--protocol-version",
      "1",
      "--output",
      "/tmp/discovery.jsonl",
    ]);
  });

  it("preserves empty and option-looking framework values exactly", () => {
    const command = createTestAdapterDiscoveryCommand({
      ...discoveryRequest,
      frameworkArgs: ["", "--", "--protocol-version", "99"],
    });

    expect(command.args.slice(-5)).toEqual([
      "--",
      "",
      "--",
      "--protocol-version",
      "99",
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid protocol version %s",
    (protocolVersion) => {
      const error = captureConfigurationError(() =>
        createTestAdapterDiscoveryCommand({
          ...discoveryRequest,
          protocolVersion,
        }),
      );

      expect(error).toMatchObject({
        kind: "invalid_protocol_version",
        setting: undefined,
      });
      expect(error.message).toBe(
        "Use a negotiated positive integer Foundry test adapter protocol version.",
      );
    },
  );
});

describe("test adapter run command", () => {
  const runRequest = {
    ...baseRequest,
    protocolVersion: 1,
    reportPath: "/tmp/report.tap",
    selections: ["test-b", "--"] as readonly string[],
  };

  it("places repeatable exact selections before opaque framework arguments", () => {
    const command = createTestAdapterRunCommand({
      ...runRequest,
      frameworkArgs: ["--select", "framework-value"],
    });

    expect(command).toEqual({
      command: "/opt/foundry",
      cwd: "/workspace/game",
      args: [
        "--headless",
        "--no-header",
        "project",
        "test",
        "--project",
        "/workspace/game",
        "--runner",
        "res://tests/runner.fs",
        "--",
        "adapter",
        "run",
        "--protocol-version",
        "1",
        "--report",
        "/tmp/report.tap",
        "--select",
        "test-b",
        "--select",
        "--",
        "--",
        "--select",
        "framework-value",
      ],
    });
  });

  it("omits only the adapter-level boundary for empty framework arguments", () => {
    expect(createTestAdapterRunCommand(runRequest).args.slice(-9)).toEqual([
      "run",
      "--protocol-version",
      "1",
      "--report",
      "/tmp/report.tap",
      "--select",
      "test-b",
      "--select",
      "--",
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid protocol version %s",
    (protocolVersion) => {
      expect(
        captureConfigurationError(() =>
          createTestAdapterRunCommand({ ...runRequest, protocolVersion }),
        ),
      ).toMatchObject({ kind: "invalid_protocol_version" });
    },
  );
});

function captureConfigurationError(
  callback: () => unknown,
): TestAdapterConfigurationError {
  try {
    callback();
  } catch (error) {
    if (error instanceof TestAdapterConfigurationError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a test adapter configuration error.");
}
