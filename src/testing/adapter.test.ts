import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import minimalFixture from "./fixtures/capabilities-minimal.json";
import {
  FoundryTestAdapterNegotiator,
  TestAdapterFailure,
  type TestAdapterNegotiationRequest,
} from "./adapter.js";
import type { TestAdapterCommand } from "./command.js";
import {
  TestAdapterProcessFailure,
  type TestAdapterProcessResult,
} from "./process.js";

const baseRequest: TestAdapterNegotiationRequest = {
  enginePath: "/opt/foundry",
  project: "/workspace/game",
  runner: "res://tests/runner.fs",
  frameworkArgs: [],
};

describe("test adapter negotiation", () => {
  it("uses unique outside-workspace artifacts and negotiates a neutral adapter", async () => {
    const outputPaths: string[] = [];
    const runProcess = vi.fn(async (command: TestAdapterCommand) => {
      const outputPath = capabilitiesOutputPath(command);
      outputPaths.push(outputPath);
      await writeFile(outputPath, validBytes());
      return exited(0);
    });
    const negotiator = new FoundryTestAdapterNegotiator({ runProcess });

    const [first, second] = await Promise.all([
      negotiator.negotiate(baseRequest, new AbortController().signal),
      negotiator.negotiate(baseRequest, new AbortController().signal),
    ]);

    expect(first).toEqual({
      protocolVersion: 1,
      framework: {
        id: "neutral-spec",
        name: "Neutral Spec",
        version: "2.4.0",
      },
      extensions: [],
    });
    expect(second).toEqual(first);
    expect(outputPaths[0]).not.toBe(outputPaths[1]);
    for (const outputPath of outputPaths) {
      expect(path.isAbsolute(outputPath)).toBe(true);
      expect(outputPath.startsWith(`${baseRequest.project}/`)).toBe(false);
      await expect(pathExists(path.dirname(outputPath))).resolves.toBe(false);
    }
  });

  it("never parses application stdout or stderr as capabilities", async () => {
    const negotiator = new FoundryTestAdapterNegotiator({
      runProcess: async (command) => {
        await writeFile(capabilitiesOutputPath(command), validBytes());
        return exited(
          0,
          '{"protocol":"corrupt-stdout"}\n',
          '{"protocol":"corrupt-stderr"}\n',
        );
      },
    });

    await expect(
      negotiator.negotiate(baseRequest, new AbortController().signal),
    ).resolves.toMatchObject({
      protocolVersion: 1,
      framework: { id: "neutral-spec" },
    });
  });

  it("reports a valid artifact with a nonzero exit as process failure", async () => {
    let outputPath = "";
    const negotiator = new FoundryTestAdapterNegotiator({
      runProcess: async (command) => {
        outputPath = capabilitiesOutputPath(command);
        await writeFile(outputPath, validBytes());
        return exited(7, "ordinary output", "failure detail");
      },
    });

    const error = await captureFailure(
      negotiator.negotiate(baseRequest, new AbortController().signal),
    );

    expect(error).toMatchObject({
      kind: "process_failed",
      stdout: "ordinary output",
      stderr: "failure detail",
    });
    expect(error.message).toContain("exit code 7");
    await expect(pathExists(path.dirname(outputPath))).resolves.toBe(false);
  });

  it.each([0, 1, 2])(
    "reports a missing artifact after exit %s as a legacy runner",
    async (exitCode) => {
      let outputPath = "";
      const negotiator = new FoundryTestAdapterNegotiator({
        runProcess: (command) => {
          outputPath = capabilitiesOutputPath(command);
          return Promise.resolve(exited(exitCode, "legacy output", "legacy error"));
        },
      });

      const error = await captureFailure(
        negotiator.negotiate(baseRequest, new AbortController().signal),
      );

      expect(error).toMatchObject({
        kind: "legacy_runner",
        stdout: "legacy output",
        stderr: "legacy error",
      });
      expect(error.message).toContain("does not implement");
      await expect(pathExists(path.dirname(outputPath))).resolves.toBe(false);
    },
  );

  it.each([0, 2])(
    "gives malformed artifact precedence over exit %s",
    async (exitCode) => {
      const negotiator = new FoundryTestAdapterNegotiator({
        runProcess: async (command) => {
          await writeFile(capabilitiesOutputPath(command), "not-json\n");
          return exited(exitCode);
        },
      });

      await expect(
        captureFailure(
          negotiator.negotiate(baseRequest, new AbortController().signal),
        ),
      ).resolves.toMatchObject({ kind: "malformed_capabilities" });
    },
  );

  it("distinguishes a valid capabilities document with no shared version", async () => {
    const negotiator = new FoundryTestAdapterNegotiator({
      runProcess: async (command) => {
        await writeFile(
          capabilitiesOutputPath(command),
          validBytes({ supported_versions: [2] }),
        );
        return exited(0);
      },
    });

    await expect(
      captureFailure(
        negotiator.negotiate(baseRequest, new AbortController().signal),
      ),
    ).resolves.toMatchObject({ kind: "incompatible_adapter" });
  });

  it("distinguishes an artifact read failure", async () => {
    let outputPath = "";
    const negotiator = new FoundryTestAdapterNegotiator({
      runProcess: async (command) => {
        outputPath = capabilitiesOutputPath(command);
        await writeFile(outputPath, validBytes());
        return exited(0);
      },
      readArtifact: () =>
        Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" })),
    });

    await expect(
      captureFailure(
        negotiator.negotiate(baseRequest, new AbortController().signal),
      ),
    ).resolves.toMatchObject({ kind: "read_failed" });
    await expect(pathExists(path.dirname(outputPath))).resolves.toBe(false);
  });

  it.each([
    {
      request: { ...baseRequest, enginePath: "" },
      kind: "missing_engine",
      setting: "foundryScript.enginePath",
    },
    {
      request: { ...baseRequest, project: undefined },
      kind: "missing_project",
      setting: undefined,
    },
    {
      request: { ...baseRequest, runner: "" },
      kind: "missing_runner",
      setting: "foundryScript.testing.runner",
    },
    {
      request: { ...baseRequest, runner: "tests/runner.fs" },
      kind: "invalid_runner",
      setting: "foundryScript.testing.runner",
    },
    {
      request: {
        ...baseRequest,
        frameworkArgs: "--path" as unknown as readonly string[],
      },
      kind: "invalid_args",
      setting: "foundryScript.testing.args",
    },
  ])("retains actionable $kind configuration failures", async ({ request, kind, setting }) => {
    const runProcess = vi.fn();
    const negotiator = new FoundryTestAdapterNegotiator({ runProcess });

    const error = await captureFailure(
      negotiator.negotiate(request, new AbortController().signal),
    );

    expect(error).toMatchObject({ kind, setting });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it.each([
    { processKind: "missing_engine", adapterKind: "missing_engine" },
    { processKind: "spawn_failed", adapterKind: "spawn_failed" },
  ] as const)(
    "retains $processKind process startup failures",
    async ({ processKind, adapterKind }) => {
      const negotiator = new FoundryTestAdapterNegotiator({
        runProcess: () =>
          Promise.reject(
            new TestAdapterProcessFailure(
              processKind,
              processKind === "missing_engine"
                ? "foundryScript.enginePath"
                : undefined,
            ),
          ),
      });

      await expect(
        captureFailure(
          negotiator.negotiate(baseRequest, new AbortController().signal),
        ),
      ).resolves.toMatchObject({ kind: adapterKind });
    },
  );

  it("treats process cancellation as internal control flow and cleans up", async () => {
    let outputPath = "";
    const negotiator = new FoundryTestAdapterNegotiator({
      runProcess: (command) => {
        outputPath = capabilitiesOutputPath(command);
        return Promise.resolve({ kind: "cancelled", stdout: "", stderr: "" });
      },
    });

    const operation = negotiator.negotiate(
      baseRequest,
      new AbortController().signal,
    );

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await expect(pathExists(path.dirname(outputPath))).resolves.toBe(false);
  });

  it("preserves a successful negotiation when temporary cleanup fails", async () => {
    const cleanupError = new Error("cleanup denied");
    const onCleanupError = vi.fn();
    const negotiator = new FoundryTestAdapterNegotiator({
      runProcess: () => Promise.resolve(exited(0)),
      readArtifact: () => Promise.resolve(validBytes()),
      makeTemporaryDirectory: () => Promise.resolve("/virtual/cleanup-success"),
      removeTemporaryDirectory: () => Promise.reject(cleanupError),
      onCleanupError,
    });

    await expect(
      negotiator.negotiate(baseRequest, new AbortController().signal),
    ).resolves.toMatchObject({
      protocolVersion: 1,
      framework: { id: "neutral-spec" },
    });
    expect(onCleanupError).toHaveBeenCalledOnce();
    expect(onCleanupError).toHaveBeenCalledWith(cleanupError, expect.any(String));
  });

  it("preserves a classified failure when temporary cleanup also fails", async () => {
    const cleanupError = new Error("cleanup denied");
    const onCleanupError = vi.fn();
    const negotiator = new FoundryTestAdapterNegotiator({
      runProcess: () => Promise.resolve(exited(0)),
      readArtifact: () =>
        Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
      makeTemporaryDirectory: () => Promise.resolve("/virtual/cleanup-failure"),
      removeTemporaryDirectory: () => Promise.reject(cleanupError),
      onCleanupError,
    });

    await expect(
      captureFailure(
        negotiator.negotiate(baseRequest, new AbortController().signal),
      ),
    ).resolves.toMatchObject({ kind: "legacy_runner" });
    expect(onCleanupError).toHaveBeenCalledOnce();
    expect(onCleanupError).toHaveBeenCalledWith(cleanupError, expect.any(String));
  });
});

function capabilitiesOutputPath(command: TestAdapterCommand): string {
  const index = command.args.indexOf("--output");
  const outputPath = command.args[index + 1];
  if (index < 0 || outputPath === undefined) {
    throw new Error("Capabilities command did not contain --output.");
  }
  return outputPath;
}

function validBytes(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(`${JSON.stringify({ ...minimalFixture, ...overrides })}\n`);
}

function exited(
  exitCode: number,
  stdout = "",
  stderr = "",
): TestAdapterProcessResult {
  return { kind: "exited", exitCode, stdout, stderr };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function captureFailure(
  promise: Promise<unknown>,
): Promise<TestAdapterFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TestAdapterFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected test adapter negotiation to fail.");
}
