import { describe, expect, it } from "vitest";
import {
  TestAdapterConfigurationError,
  createTestAdapterCapabilitiesCommand,
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
