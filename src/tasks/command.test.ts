import { describe, expect, it } from "vitest";
import {
  FoundryTaskConfigurationError,
  createFoundryTaskCommand,
  type FoundryTaskKind,
} from "./command.js";

describe("Foundry task commands", () => {
  const expectedArguments: Record<FoundryTaskKind, string[]> = {
    build: ["project", "import", "--project", "/workspace/game"],
    lint: [
      "script",
      "lint",
      "--project",
      "/workspace/game",
      "--format=json",
    ],
    test: [
      "project",
      "test",
      "--project",
      "/workspace/game",
      "--runner",
      "res://tests/runner.fs",
    ],
    format: ["script", "format", "--project", "/workspace/game"],
    run: ["project", "run", "--project", "/workspace/game"],
  };

  for (const kind of Object.keys(expectedArguments) as FoundryTaskKind[]) {
    it(`builds the supported command-first ${kind} invocation`, () => {
      const command = createFoundryTaskCommand({
        kind,
        enginePath: "/opt/foundry",
        project: "/workspace/game",
        testRunner: "res://tests/runner.fs",
      });

      expect(command).toEqual({
        command: "/opt/foundry",
        args: expectedArguments[kind],
        cwd: "/workspace/game",
      });
      expect(command.args).not.toContain("--path");
    });
  }

  it("reports an actionable missing engine setting", () => {
    const error = captureConfigurationError(() =>
      createFoundryTaskCommand({
        kind: "build",
        enginePath: "  ",
        project: "/workspace/game",
      }),
    );

    expect(error).toMatchObject({
      kind: "missing_engine",
      setting: "foundryScript.enginePath",
    });
  });

  it("reports an actionable missing project", () => {
    const error = captureConfigurationError(() =>
      createFoundryTaskCommand({
        kind: "run",
        enginePath: "foundry",
        project: undefined,
      }),
    );

    expect(error).toMatchObject({ kind: "missing_project" });
  });

  it("requires a configured runner only for the test task", () => {
    const error = captureConfigurationError(() =>
      createFoundryTaskCommand({
        kind: "test",
        enginePath: "foundry",
        project: "/workspace/game",
        testRunner: "",
      }),
    );

    expect(error).toMatchObject({
      kind: "missing_runner",
      setting: "foundryScript.test.runner",
    });

    expect(() =>
      createFoundryTaskCommand({
        kind: "build",
        enginePath: "foundry",
        project: "/workspace/game",
        testRunner: "",
      }),
    ).not.toThrow();
  });
});

function captureConfigurationError(
  action: () => unknown,
): FoundryTaskConfigurationError {
  try {
    action();
  } catch (error) {
    if (error instanceof FoundryTaskConfigurationError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a Foundry task configuration error.");
}
