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
  it("aborts only its run child when first-report readiness expires", async () => {
    let now = 0;
    let operationSignal: AbortSignal | undefined;
    const removeTemporaryDirectory = vi.fn().mockResolvedValue(undefined);
    const executor = new FoundryTestExecutor({
      makeTemporaryDirectory: () => Promise.resolve("/tmp/run-timeout"),
      removeTemporaryDirectory,
      runProcess: (_command, signal) => {
        operationSignal = signal;
        return new Promise<TestAdapterProcessResult>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ kind: "cancelled", stdout: "", stderr: "" }),
            { once: true },
          );
        });
      },
      readArtifact: () => Promise.reject(missing()),
      now: () => now,
      waitForPoll: () => {
        now = 30_000;
        return Promise.resolve();
      },
      readinessTimeoutMs: 30_000,
    });

    await expect(
      executor.execute(request, new AbortController().signal, observer()),
    ).rejects.toMatchObject({
      kind: "readiness_timeout",
      phase: "execution",
    });
    expect(operationSignal?.aborted).toBe(true);
    expect(removeTemporaryDirectory).toHaveBeenCalledWith("/tmp/run-timeout");
  });

  it("disarms readiness after the first artifact byte for a long run", async () => {
    let now = 0;
    let artifact = Buffer.from("T");
    const child = deferred<TestAdapterProcessResult>();
    let polls = 0;
    const executor = new FoundryTestExecutor({
      makeTemporaryDirectory: () => Promise.resolve("/tmp/run-ready"),
      removeTemporaryDirectory: vi.fn().mockResolvedValue(undefined),
      runProcess: () => child.promise,
      readArtifact: () => Promise.resolve(artifact),
      now: () => now,
      waitForPoll: () => {
        polls += 1;
        now = 90_000;
        artifact = Buffer.from(
          report(2, point(1, "test-a"), point(2, "test-b")),
        );
        child.resolve(exited(0));
        return Promise.resolve();
      },
      readinessTimeoutMs: 30_000,
    });

    await expect(
      executor.execute(request, new AbortController().signal, observer()),
    ).resolves.toMatchObject({
      kind: "completed",
      completion: { valid: true, complete: true },
    });
    expect(polls).toBe(1);
  });

  it("gives user cancellation precedence in the readiness polling turn", async () => {
    let now = 0;
    const user = new AbortController();
    const executor = new FoundryTestExecutor({
      makeTemporaryDirectory: () => Promise.resolve("/tmp/run-user-cancel"),
      removeTemporaryDirectory: vi.fn().mockResolvedValue(undefined),
      runProcess: (_command, signal) =>
        new Promise<TestAdapterProcessResult>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ kind: "cancelled", stdout: "", stderr: "" }),
            { once: true },
          );
        }),
      readArtifact: () => Promise.reject(missing()),
      now: () => now,
      waitForPoll: () => {
        now = 30_000;
        user.abort();
        return Promise.resolve();
      },
      readinessTimeoutMs: 30_000,
    });

    await expect(
      executor.execute(request, user.signal, observer()),
    ).resolves.toMatchObject({
      kind: "cancelled",
      completion: { valid: true, classification: "cancelled" },
    });
  });

  it("classifies an unowned execution signal as a process crash", async () => {
    const removeTemporaryDirectory = vi.fn().mockResolvedValue(undefined);
    const executor = immediateExecutor(
      report(2, point(1, "test-a"), point(2, "test-b")),
      () =>
        Promise.resolve({
          kind: "exited",
          signal: "SIGSEGV",
          stdout: "ordinary",
          stderr: "fatal detail",
        }),
      { removeTemporaryDirectory },
    );

    await expect(
      executor.execute(request, new AbortController().signal, observer()),
    ).rejects.toMatchObject({
      kind: "process_crash",
      phase: "execution",
      signal: "SIGSEGV",
      stdout: "ordinary",
      stderr: "fatal detail",
    });
    expect(removeTemporaryDirectory).toHaveBeenCalledWith(
      "/tmp/foundryscript-test-run-immediate",
    );
  });

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
    await vi.waitFor(() => expect(polls).toHaveLength(2));
    polls[1]?.resolve(undefined);
    await vi.waitFor(() => expect(points).toEqual(["test-a", "test-b"]));
    expect(child.settled).toBe(false);
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
    const user = new AbortController();
    user.abort();
    const executor = immediateExecutor(
      report(2, point(1, "test-a")) +
        'ok 2 - partial\n  ---\n  _foundry:\n    id: "test-b"',
      () => Promise.resolve({ kind: "cancelled", stdout: "", stderr: "" }),
    );

    await expect(
      executor.execute(request, user.signal, {
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
    let operationSignal: AbortSignal | undefined;
    const executor = new FoundryTestExecutor({
      makeTemporaryDirectory: () => Promise.resolve("/tmp/run-mutated"),
      removeTemporaryDirectory: vi.fn().mockResolvedValue(undefined),
      runProcess: (_command, signal) => {
        operationSignal = signal;
        signal.addEventListener(
          "abort",
          () => child.resolve({ kind: "cancelled", stdout: "", stderr: "" }),
          { once: true },
        );
        return child.promise;
      },
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
    expect(operationSignal?.aborted).toBe(true);
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
