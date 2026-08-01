import { describe, expect, it, vi } from "vitest";
import type { TestAdapterCommand } from "./command.js";
import {
  FoundryTestExecutor,
  type TestExecutionRequest,
} from "./executor.js";
import type { TestAdapterProcessResult } from "./process.js";

const request: TestExecutionRequest = {
  enginePath: "/opt/foundry",
  project: "/workspace/game",
  runner: "res://tests/runner.fs",
  frameworkArgs: ["--path", "res://specs"],
  protocolVersion: 1,
  leaves: [
    { id: "test-a", skipped: false, skipReason: null },
    { id: "test-b", skipped: false, skipReason: null },
  ],
};

describe("Foundry test executor", () => {
  it("publishes a complete flushed point before the child exits", async () => {
    const child = deferred<TestAdapterProcessResult>();
    const polls: Array<ReturnType<typeof deferred<void>>> = [];
    let artifact: Buffer | undefined;
    let command: TestAdapterCommand | undefined;
    const points: string[] = [];
    const removeTemporaryDirectory = vi.fn().mockResolvedValue(undefined);
    const executor = new FoundryTestExecutor({
      makeTemporaryDirectory: vi
        .fn()
        .mockResolvedValue("/tmp/foundryscript-test-run-owned"),
      removeTemporaryDirectory,
      runProcess: (value) => {
        command = value;
        return child.promise;
      },
      readArtifact: () => {
        if (artifact === undefined) {
          return Promise.reject(missing());
        }
        return Promise.resolve(artifact);
      },
      waitForPoll: () => {
        const value = deferred<void>();
        polls.push(value);
        return value.promise;
      },
    });
    const execution = executor.execute(
      request,
      new AbortController().signal,
      {
        onPoint: (point) => points.push(point.testId),
        onOutput: vi.fn(),
      },
    );
    await vi.waitFor(() => expect(command).toBeDefined());

    artifact = Buffer.from(report(2, point(1, "test-a")));
    await vi.waitFor(() => expect(polls).toHaveLength(1));
    polls[0]?.resolve(undefined);
    await vi.waitFor(() => expect(points).toEqual(["test-a"]));
    expect(child.settled).toBe(false);

    artifact = Buffer.from(
      report(2, point(1, "test-a"), point(2, "test-b")),
    );
    child.resolve(exited(0));

    await expect(execution).resolves.toMatchObject({
      kind: "completed",
      completion: { valid: true, complete: true, classification: "conforming" },
    });
    expect(command?.args).toContain("/tmp/foundryscript-test-run-owned/report.tap");
    expect(command?.args).toEqual(
      expect.arrayContaining(["--select", "test-a", "--select", "test-b"]),
    );
    expect(removeTemporaryDirectory).toHaveBeenCalledWith(
      "/tmp/foundryscript-test-run-owned",
    );
  });

  it("keeps application stdout and stderr outside TAP parsing", async () => {
    const output = vi.fn();
    const executor = immediateExecutor(
      report(2, point(1, "test-a"), point(2, "test-b")),
      (_command, _signal, onOutput) => {
        onOutput?.('not TAP {"stdout":true}\n', "stdout");
        onOutput?.("Bail out! stderr is application data\n", "stderr");
        return Promise.resolve(exited(0, "stdout", "stderr"));
      },
    );

    await expect(
      executor.execute(request, new AbortController().signal, {
        onPoint: vi.fn(),
        onOutput: output,
      }),
    ).resolves.toMatchObject({ completion: { valid: true } });
    expect(output.mock.calls).toEqual([
      ['not TAP {"stdout":true}\n', "stdout"],
      ["Bail out! stderr is application data\n", "stderr"],
    ]);
  });

  it("performs a final artifact read after an immediate child exit", async () => {
    const readArtifact = vi
      .fn()
      .mockResolvedValue(
        Buffer.from(report(2, point(1, "test-a"), point(2, "test-b"))),
      );
    const executor = immediateExecutor(undefined, () => Promise.resolve(exited(0)), {
      readArtifact,
    });

    await expect(
      executor.execute(request, new AbortController().signal, observer()),
    ).resolves.toMatchObject({ completion: { valid: true } });
    expect(readArtifact).toHaveBeenCalled();
  });

  it("preserves only complete points for genuine cancellation", async () => {
    const seen: string[] = [];
    const executor = immediateExecutor(
      report(2, point(1, "test-a")) +
        'ok 2 - partial\n  ---\n  _foundry:\n    id: "test-b"',
      () => Promise.resolve({ kind: "cancelled", stdout: "", stderr: "" }),
    );

    await expect(
      executor.execute(request, new AbortController().signal, {
        onPoint: (value) => seen.push(value.testId),
        onOutput: vi.fn(),
      }),
    ).resolves.toMatchObject({
      kind: "cancelled",
      completion: { valid: true, classification: "cancelled" },
    });
    expect(seen).toEqual(["test-a"]);
  });

  it("classifies a missing final report as a read failure", async () => {
    const executor = immediateExecutor(undefined, () => Promise.resolve(exited(2)), {
      readArtifact: () => Promise.reject(missing()),
    });

    await expect(
      executor.execute(request, new AbortController().signal, observer()),
    ).rejects.toMatchObject({ kind: "report_read_failed" });
  });

  it("rejects a report whose consumed prefix changes", async () => {
    const child = deferred<TestAdapterProcessResult>();
    const polls: Array<ReturnType<typeof deferred<void>>> = [];
    let artifact = Buffer.from("TAP version 13\n");
    const executor = new FoundryTestExecutor({
      makeTemporaryDirectory: () => Promise.resolve("/tmp/run-mutated"),
      removeTemporaryDirectory: vi.fn().mockResolvedValue(undefined),
      runProcess: () => child.promise,
      readArtifact: () => Promise.resolve(artifact),
      waitForPoll: () => {
        const value = deferred<void>();
        polls.push(value);
        return value.promise;
      },
    });
    const execution = executor.execute(
      request,
      new AbortController().signal,
      observer(),
    );
    await vi.waitFor(() => expect(polls).toHaveLength(1));

    artifact = Buffer.from("TAP version 12\n");
    polls[0]?.resolve(undefined);

    await expect(execution).rejects.toMatchObject({ kind: "malformed_report" });
    child.resolve(exited(1));
  });

  it("keeps the primary result when exact temporary cleanup fails", async () => {
    const onCleanupError = vi.fn();
    const executor = immediateExecutor(
      report(2, point(1, "test-a"), point(2, "test-b")),
      () => Promise.resolve(exited(0)),
      {
        removeTemporaryDirectory: () => Promise.reject(new Error("denied")),
        onCleanupError,
      },
    );

    await expect(
      executor.execute(request, new AbortController().signal, observer()),
    ).resolves.toMatchObject({ completion: { valid: true } });
    expect(onCleanupError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "denied" }),
      "/tmp/foundryscript-test-run-immediate",
    );
  });
});

function immediateExecutor(
  artifact: string | undefined,
  runProcess: (
    command: TestAdapterCommand,
    signal: AbortSignal,
    onOutput?: (text: string, stream: "stdout" | "stderr") => void,
  ) => Promise<TestAdapterProcessResult>,
  overrides: Partial<ConstructorParameters<typeof FoundryTestExecutor>[0]> = {},
): FoundryTestExecutor {
  return new FoundryTestExecutor({
    makeTemporaryDirectory: () =>
      Promise.resolve("/tmp/foundryscript-test-run-immediate"),
    removeTemporaryDirectory: vi.fn().mockResolvedValue(undefined),
    runProcess,
    readArtifact: () =>
      artifact === undefined
        ? Promise.reject(missing())
        : Promise.resolve(Buffer.from(artifact)),
    waitForPoll: () => Promise.resolve(),
    ...overrides,
  });
}

function observer() {
  return { onPoint: vi.fn(), onOutput: vi.fn() };
}

function report(plan: number, ...points: string[]): string {
  return `TAP version 13\n# foundry-test-adapter: 1\n1..${plan}\n${points.join("")}`;
}

function point(number: number, id: string): string {
  return (
    `ok ${number} - label\n` +
    "  ---\n" +
    "  _foundry:\n" +
    `    id: ${JSON.stringify(id)}\n` +
    "    duration_ms: 1\n" +
    '    status_detail: ""\n' +
    "  ...\n"
  );
}

function exited(
  exitCode: number,
  stdout = "",
  stderr = "",
): TestAdapterProcessResult {
  return { kind: "exited", exitCode, stdout, stderr };
}

function missing(): Error {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = (value) => {
      settled = true;
      onResolve(value);
    };
    reject = (error: Error) => {
      settled = true;
      onReject(error);
    };
  });
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}
