import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TestAdapterFailure,
  type TestAdapterNegotiationRequest,
} from "./adapter.js";
import type { TestAdapterCommand } from "./command.js";
import {
  FoundryTestAdapterDiscoverer,
  type TestAdapterDiscoveryRequest,
} from "./discoverer.js";
import {
  TestAdapterProcessFailure,
  type TestAdapterProcessResult,
} from "./process.js";

const negotiationRequest: TestAdapterNegotiationRequest = {
  enginePath: "/opt/foundry",
  project: "/workspace/game",
  runner: "res://tests/runner.fs",
  frameworkArgs: [],
};

const baseRequest: TestAdapterDiscoveryRequest = {
  ...negotiationRequest,
  protocolVersion: 1,
};

describe("test adapter discovery", () => {
  it("uses unique outside-workspace artifacts and the exact discovery command", async () => {
    const commands: TestAdapterCommand[] = [];
    const discoverer = new FoundryTestAdapterDiscoverer({
      runProcess: async (command) => {
        commands.push(command);
        await writeFile(
          discoveryOutputPath(command),
          await fixture("empty.jsonl"),
        );
        return exited(0);
      },
    });
    const request = {
      ...baseRequest,
      frameworkArgs: ["--path", "res://specs", "--output", "opaque"],
    };

    const [first, second] = await Promise.all([
      discoverer.discover(request, new AbortController().signal),
      discoverer.discover(request, new AbortController().signal),
    ]);

    expect(first).toMatchObject({ suiteCount: 0, testCount: 0, errorCount: 0 });
    expect(second).toEqual(first);
    expect(commands).toHaveLength(2);
    const outputPaths = commands.map(discoveryOutputPath);
    expect(outputPaths[0]).not.toBe(outputPaths[1]);
    for (const outputPath of outputPaths) {
      expect(path.isAbsolute(outputPath)).toBe(true);
      expect(outputPath.startsWith(`${baseRequest.project}/`)).toBe(false);
      expect(path.basename(outputPath)).toBe("discovery.jsonl");
      await expect(pathExists(path.dirname(outputPath))).resolves.toBe(false);
    }
    expect(commands[0]).toEqual({
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
        outputPaths[0],
        "--",
        "--path",
        "res://specs",
        "--output",
        "opaque",
      ],
    });
  });

  it("reads only the artifact and ignores JSON-looking application output", async () => {
    const discoverer = new FoundryTestAdapterDiscoverer({
      runProcess: async (command) => {
        await writeFile(
          discoveryOutputPath(command),
          await fixture("nested.jsonl"),
        );
        return exited(
          0,
          '{"event":"discovery_end","suite_count":99}\n',
          '{"event":"discovery_error"}\n',
        );
      },
    });

    await expect(
      discoverer.discover(baseRequest, new AbortController().signal),
    ).resolves.toMatchObject({ suiteCount: 2, testCount: 4, errorCount: 0 });
  });

  it.each([
    { fixtureName: "empty.jsonl", exitCode: 0, errorCount: 0 },
    { fixtureName: "with-errors.jsonl", exitCode: 1, errorCount: 1 },
  ])(
    "accepts $fixtureName with required exit $exitCode",
    async ({ fixtureName, exitCode, errorCount }) => {
      const discoverer = fixtureDiscoverer(fixtureName, exitCode);

      await expect(
        discoverer.discover(baseRequest, new AbortController().signal),
      ).resolves.toMatchObject({ errorCount });
    },
  );

  it.each([
    { fixtureName: "empty.jsonl", exitCode: 1 },
    { fixtureName: "with-errors.jsonl", exitCode: 0 },
    { fixtureName: "empty.jsonl", exitCode: 2 },
    { fixtureName: "with-errors.jsonl", exitCode: 2 },
  ])(
    "rejects $fixtureName with inconsistent exit $exitCode",
    async ({ fixtureName, exitCode }) => {
      const error = await captureFailure(
        fixtureDiscoverer(fixtureName, exitCode).discover(
          baseRequest,
          new AbortController().signal,
        ),
      );

      expect(error).toMatchObject({ kind: "discovery_exit_mismatch" });
      expect(error.message).toContain(`exit code ${exitCode}`);
    },
  );

  it.each([0, 1, 2])(
    "gives malformed discovery precedence over exit %s",
    async (exitCode) => {
      const error = await captureFailure(
        fixtureDiscoverer("malformed-line.jsonl", exitCode, "invalid").discover(
          baseRequest,
          new AbortController().signal,
        ),
      );

      expect(error).toMatchObject({ kind: "malformed_discovery" });
    },
  );

  it.each([0, 1, 2])(
    "gives incomplete discovery precedence over exit %s",
    async (exitCode) => {
      const error = await captureFailure(
        fixtureDiscoverer("truncated.jsonl", exitCode, "invalid").discover(
          baseRequest,
          new AbortController().signal,
        ),
      );

      expect(error).toMatchObject({ kind: "incomplete_discovery" });
    },
  );

  it.each([
    { code: "ENOENT", message: "does not exist" },
    { code: "EACCES", message: "unable to read" },
  ])("classifies a $code artifact read failure", async ({ code, message }) => {
    const discoverer = new FoundryTestAdapterDiscoverer({
      runProcess: () => Promise.resolve(exited(0, "ordinary", "diagnostic")),
      readArtifact: () =>
        Promise.reject(Object.assign(new Error(code), { code })),
    });

    const error = await captureFailure(
      discoverer.discover(baseRequest, new AbortController().signal),
    );

    expect(error).toMatchObject({
      kind: "read_failed",
      stdout: "ordinary",
      stderr: "diagnostic",
    });
    expect(error.message.toLowerCase()).toContain(message);
  });

  it.each([
    { processKind: "missing_engine", setting: "foundryScript.enginePath" },
    { processKind: "spawn_failed", setting: undefined },
  ] as const)("retains $processKind startup failures", async ({ processKind, setting }) => {
    const discoverer = new FoundryTestAdapterDiscoverer({
      runProcess: () =>
        Promise.reject(new TestAdapterProcessFailure(processKind, setting)),
    });

    await expect(
      captureFailure(
        discoverer.discover(baseRequest, new AbortController().signal),
      ),
    ).resolves.toMatchObject({ kind: processKind, setting });
  });

  it("treats cancellation as internal control flow and never reads an artifact", async () => {
    const readArtifact = vi.fn();
    const removeTemporaryDirectory = vi.fn(() => Promise.resolve());
    const discoverer = new FoundryTestAdapterDiscoverer({
      runProcess: () =>
        Promise.resolve({ kind: "cancelled", stdout: "", stderr: "" }),
      readArtifact,
      makeTemporaryDirectory: () => Promise.resolve("/virtual/cancelled"),
      removeTemporaryDirectory,
    });

    await expect(
      discoverer.discover(baseRequest, new AbortController().signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(readArtifact).not.toHaveBeenCalled();
    expect(removeTemporaryDirectory).toHaveBeenCalledWith("/virtual/cancelled");
  });

  it("contains cleanup diagnostics without masking a successful model", async () => {
    const cleanupError = new Error("cleanup denied");
    const onCleanupError = vi.fn();
    const discoverer = new FoundryTestAdapterDiscoverer({
      runProcess: () => Promise.resolve(exited(0)),
      readArtifact: () => fixture("empty.jsonl"),
      makeTemporaryDirectory: () => Promise.resolve("/virtual/cleanup-success"),
      removeTemporaryDirectory: () => Promise.reject(cleanupError),
      onCleanupError,
    });

    await expect(
      discoverer.discover(baseRequest, new AbortController().signal),
    ).resolves.toMatchObject({ errorCount: 0 });
    expect(onCleanupError).toHaveBeenCalledWith(
      cleanupError,
      "/virtual/cleanup-success",
    );
  });

  it("contains cleanup diagnostics without masking a classified failure", async () => {
    const cleanupError = new Error("cleanup denied");
    const onCleanupError = vi.fn();
    const discoverer = new FoundryTestAdapterDiscoverer({
      runProcess: () => Promise.resolve(exited(0)),
      readArtifact: () => fixture("malformed-line.jsonl", "invalid"),
      makeTemporaryDirectory: () => Promise.resolve("/virtual/cleanup-failure"),
      removeTemporaryDirectory: () => Promise.reject(cleanupError),
      onCleanupError,
    });

    await expect(
      captureFailure(
        discoverer.discover(baseRequest, new AbortController().signal),
      ),
    ).resolves.toMatchObject({ kind: "malformed_discovery" });
    expect(onCleanupError).toHaveBeenCalledWith(
      cleanupError,
      "/virtual/cleanup-failure",
    );
  });
});

function fixtureDiscoverer(
  fixtureName: string,
  exitCode: number,
  validity: "valid" | "invalid" = "valid",
): FoundryTestAdapterDiscoverer {
  return new FoundryTestAdapterDiscoverer({
    runProcess: async (command) => {
      await writeFile(
        discoveryOutputPath(command),
        await fixture(fixtureName, validity),
      );
      return exited(exitCode, "ordinary", "diagnostic");
    },
  });
}

function fixture(
  fixtureName: string,
  validity: "valid" | "invalid" = "valid",
): Promise<Buffer> {
  return readFile(
    path.join(
      process.cwd(),
      "src",
      "testing",
      "fixtures",
      "discovery",
      validity,
      fixtureName,
    ),
  );
}

function discoveryOutputPath(command: TestAdapterCommand): string {
  const index = command.args.indexOf("--output");
  const outputPath = command.args[index + 1];
  if (index < 0 || outputPath === undefined) {
    throw new Error("Discovery command did not contain --output.");
  }
  return outputPath;
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
  throw new Error("Expected test adapter discovery to fail.");
}
