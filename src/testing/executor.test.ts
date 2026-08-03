import { describe, expect, it, vi } from "vitest";
import type { TestAdapterCommand } from "./command.js";
import {
  FoundryTestExecutor,
  type FoundryTestExecutorOptions,
  type TestExecutionRequest,
} from "./executor.js";
import type { TestAdapterProcessResult } from "./process.js";
import {
  REPORT_READ_CHUNK_SIZE,
  type ReportFileAccess,
  type ReportFileHandle,
  type ReportFileMetadata,
} from "./report-reader.js";

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
      reportFileAccess: new MemoryReportFiles(),
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
    const files = new MemoryReportFiles("T");
    const child = deferred<TestAdapterProcessResult>();
    let polls = 0;
    const executor = new FoundryTestExecutor({
      makeTemporaryDirectory: () => Promise.resolve("/tmp/run-ready"),
      removeTemporaryDirectory: vi.fn().mockResolvedValue(undefined),
      runProcess: () => child.promise,
      reportFileAccess: files,
      now: () => now,
      waitForPoll: () => {
        polls += 1;
        now = 90_000;
        files.write(
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
      reportFileAccess: new MemoryReportFiles(),
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
    const files = new MemoryReportFiles();
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
      reportFileAccess: files,
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

    files.write(report(2, point(1, "test-a")));
    await vi.waitFor(() => expect(polls).toHaveLength(1));
    polls[0]?.resolve(undefined);
    await vi.waitFor(() => expect(points).toEqual(["test-a"]));
    expect(child.settled).toBe(false);

    files.write(
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
    const files = new MemoryReportFiles(
      report(2, point(1, "test-a"), point(2, "test-b")),
    );
    const executor = immediateExecutor(undefined, () => Promise.resolve(exited(0)), {
      reportFileAccess: files,
    });

    await expect(
      executor.execute(request, new AbortController().signal, observer()),
    ).resolves.toMatchObject({ completion: { valid: true } });
    expect(files.reads.length).toBeGreaterThan(0);
  });

  it(
    "keeps 2 MiB across 256 growth steps within the linear report I/O bound",
    { timeout: 15_000 },
    async () => {
      const finalReport = Buffer.from(
        reportWithFirstLabel(
          "x".repeat(2 * 1024 * 1024),
          point(2, "test-b"),
        ),
      );
      const files = new MemoryReportFiles();
      const child = deferred<TestAdapterProcessResult>();
      const growthSteps = 256;
      let step = 0;
      let previousEnd = 0;
      const executor = new FoundryTestExecutor({
        makeTemporaryDirectory: () => Promise.resolve("/tmp/run-linear"),
        removeTemporaryDirectory: vi.fn().mockResolvedValue(undefined),
        reportFileAccess: files,
        runProcess: () => child.promise,
        waitForPoll: () => {
          step += 1;
          const end = Math.floor((finalReport.length * step) / growthSteps);
          files.append(finalReport.subarray(previousEnd, end));
          previousEnd = end;
          if (step === growthSteps) child.resolve(exited(0));
          return Promise.resolve();
        },
      });

      await expect(
        executor.execute(request, new AbortController().signal, observer()),
      ).resolves.toMatchObject({
        completion: { valid: true, complete: true },
      });

      expect(step).toBe(growthSteps);
      expect(finalReport.length).toBeGreaterThanOrEqual(2 * 1024 * 1024);
      expect(files.contentBytesRead).toBeLessThanOrEqual(
        2 * finalReport.length + REPORT_READ_CHUNK_SIZE,
      );
      expect(files.maxReturnedBuffer).toBeLessThanOrEqual(REPORT_READ_CHUNK_SIZE);
    },
  );

  it("does not reread report content during unchanged executor polls", async () => {
    const files = new MemoryReportFiles(
      report(2, point(1, "test-a"), point(2, "test-b")),
    );
    const child = deferred<TestAdapterProcessResult>();
    let polls = 0;
    const executor = new FoundryTestExecutor({
      makeTemporaryDirectory: () => Promise.resolve("/tmp/run-unchanged"),
      removeTemporaryDirectory: vi.fn().mockResolvedValue(undefined),
      reportFileAccess: files,
      runProcess: () => child.promise,
      waitForPoll: () => {
        polls += 1;
        if (polls === 3) child.resolve(exited(0));
        return Promise.resolve();
      },
    });
    const size = Buffer.byteLength(
      report(2, point(1, "test-a"), point(2, "test-b")),
    );

    await executor.execute(request, new AbortController().signal, observer());

    expect(polls).toBe(3);
    expect(files.contentBytesRead).toBe(2 * size);
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
    const executor = immediateExecutor(undefined, () => Promise.resolve(exited(0)));

    await expect(
      executor.execute(request, new AbortController().signal, observer()),
    ).rejects.toMatchObject({ kind: "report_read_failed" });
  });

  it("classifies a missing report after nonzero exit as a process crash", async () => {
    const executor = immediateExecutor(
      undefined,
      () => Promise.resolve(exited(2, "ordinary", "fatal detail")),
    );

    await expect(
      executor.execute(request, new AbortController().signal, observer()),
    ).rejects.toMatchObject({
      kind: "process_crash",
      phase: "execution",
      exitCode: 2,
      stdout: "ordinary",
      stderr: "fatal detail",
    });
  });

  it("rejects a report whose consumed prefix changes", async () => {
    const child = deferred<TestAdapterProcessResult>();
    const polls: Array<ReturnType<typeof deferred<void>>> = [];
    const files = new MemoryReportFiles("TAP version 13\n");
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
      reportFileAccess: files,
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

    files.write("TAP version 12\n");
    child.resolve(exited(0));

    await expect(execution).rejects.toMatchObject({ kind: "malformed_report" });
    expect(operationSignal?.aborted).toBe(true);
  });

  it("classifies streamed report truncation as malformed_report", async () => {
    const files = new MemoryReportFiles("TAP version 13\n");
    const child = deferred<TestAdapterProcessResult>();
    const polls: Array<ReturnType<typeof deferred<void>>> = [];
    const executor = pollingExecutor(files, child, polls);
    const execution = executor.execute(
      request,
      new AbortController().signal,
      observer(),
    );
    await vi.waitFor(() => expect(polls).toHaveLength(1));

    files.truncate(3);
    polls[0]?.resolve(undefined);

    await expect(execution).rejects.toMatchObject({ kind: "malformed_report" });
    expect(files.closes).toBe(1);
  });

  it("classifies streamed report replacement as malformed_report", async () => {
    const files = new MemoryReportFiles("TAP version 13\n");
    const child = deferred<TestAdapterProcessResult>();
    const polls: Array<ReturnType<typeof deferred<void>>> = [];
    const executor = pollingExecutor(files, child, polls);
    const execution = executor.execute(
      request,
      new AbortController().signal,
      observer(),
    );
    await vi.waitFor(() => expect(polls).toHaveLength(1));

    files.replace("TAP version 14\n");
    polls[0]?.resolve(undefined);

    await expect(execution).rejects.toMatchObject({ kind: "malformed_report" });
    expect(files.closes).toBe(1);
  });

  it.each([
    "success",
    "cancellation",
    "readiness timeout",
    "malformed parser result",
    "process failure",
    "read failure",
  ] as const)("closes the report handle before temporary cleanup on %s", async (scenario) => {
    const files = new MemoryReportFiles(
      scenario === "readiness timeout"
        ? Buffer.alloc(0)
        : report(2, point(1, "test-a"), point(2, "test-b")),
    );
    const events = files.events;
    const user = new AbortController();
    let now = 0;
    const runProcess: FoundryTestExecutorOptions["runProcess"] =
      scenario === "readiness timeout"
        ? (_command, signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => resolve({ kind: "cancelled", stdout: "", stderr: "" }),
                { once: true },
              );
            })
        : scenario === "process failure"
          ? () => Promise.reject(new Error("process failed"))
          : () =>
              Promise.resolve(
                scenario === "cancellation"
                  ? { kind: "cancelled", stdout: "", stderr: "" }
                  : exited(0),
              );
    if (scenario === "cancellation") user.abort();
    if (scenario === "malformed parser result") files.write("not TAP\n");
    if (scenario === "read failure") {
      files.readError = Object.assign(new Error("read failed"), { code: "EIO" });
    }
    const executor = new FoundryTestExecutor({
      makeTemporaryDirectory: () => Promise.resolve(`/tmp/run-${scenario}`),
      removeTemporaryDirectory: () => {
        events.push("remove");
        return Promise.resolve();
      },
      reportFileAccess: files,
      runProcess,
      now: () => now,
      waitForPoll: () => {
        now = 30_000;
        return Promise.resolve();
      },
      readinessTimeoutMs: 30_000,
    });

    await executor.execute(request, user.signal, observer()).catch(() => undefined);

    expect(events).toEqual(["close", "remove"]);
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
  overrides: Partial<FoundryTestExecutorOptions> = {},
): FoundryTestExecutor {
  return new FoundryTestExecutor({
    makeTemporaryDirectory: () =>
      Promise.resolve("/tmp/foundryscript-test-run-immediate"),
    removeTemporaryDirectory: vi.fn().mockResolvedValue(undefined),
    runProcess,
    reportFileAccess: new MemoryReportFiles(artifact),
    waitForPoll: () => Promise.resolve(),
    ...overrides,
  });
}

function pollingExecutor(
  files: MemoryReportFiles,
  child: ReturnType<typeof deferred<TestAdapterProcessResult>>,
  polls: Array<ReturnType<typeof deferred<void>>>,
): FoundryTestExecutor {
  return new FoundryTestExecutor({
    makeTemporaryDirectory: () => Promise.resolve("/tmp/run-polling"),
    removeTemporaryDirectory: vi.fn().mockResolvedValue(undefined),
    reportFileAccess: files,
    runProcess: (_command, signal) => {
      signal.addEventListener(
        "abort",
        () => child.resolve({ kind: "cancelled", stdout: "", stderr: "" }),
        { once: true },
      );
      return child.promise;
    },
    waitForPoll: () => {
      const poll = deferred<void>();
      polls.push(poll);
      return poll.promise;
    },
  });
}

function observer() {
  return { onPoint: vi.fn(), onOutput: vi.fn() };
}

function report(plan: number, ...points: string[]): string {
  return `TAP version 13\n# foundry-test-adapter: 1\n1..${plan}\n${points.join("")}`;
}

function reportWithFirstLabel(label: string, secondPoint: string): string {
  return (
    "TAP version 13\n" +
    "# foundry-test-adapter: 1\n" +
    "1..2\n" +
    `ok 1 - ${label}\n` +
    "  ---\n" +
    "  _foundry:\n" +
    '    id: "test-a"\n' +
    "    duration_ms: 1\n" +
    '    status_detail: ""\n' +
    "  ...\n" +
    secondPoint
  );
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

interface MemoryReadCall {
  readonly position: number;
  readonly length: number;
}

class MemoryReportFiles implements ReportFileAccess {
  private contents: Buffer | undefined;
  private identity = 0;
  readonly reads: MemoryReadCall[] = [];
  readonly events: string[] = [];
  contentBytesRead = 0;
  maxReturnedBuffer = 0;
  closes = 0;
  readError: Error | undefined;

  constructor(contents?: string | Buffer) {
    if (contents !== undefined) {
      this.replace(contents);
    }
  }

  write(contents: string | Buffer): void {
    const next = toBuffer(contents);
    if (this.contents === undefined) {
      this.identity += 1;
    }
    this.contents = next;
  }

  append(contents: string | Buffer): void {
    const next = toBuffer(contents);
    if (this.contents === undefined) {
      this.identity += 1;
      this.contents = next;
      return;
    }
    this.contents = Buffer.concat([this.contents, next]);
  }

  replace(contents: string | Buffer): void {
    this.identity += 1;
    this.contents = toBuffer(contents);
  }

  truncate(size: number): void {
    if (this.contents === undefined) throw new Error("Missing report.");
    this.contents = Buffer.from(this.contents.subarray(0, size));
  }

  mutate(position: number, contents: string | Buffer): void {
    if (this.contents === undefined) throw new Error("Missing report.");
    toBuffer(contents).copy(this.contents, position);
  }

  remove(): void {
    this.contents = undefined;
  }

  stat(_path: string): Promise<ReportFileMetadata> {
    return Promise.resolve(this.metadata(this.identity, this.contents));
  }

  open(_path: string): Promise<ReportFileHandle> {
    if (this.contents === undefined) return Promise.reject(missing());
    const openedIdentity = this.identity;
    const openedContents = this.contents;
    return Promise.resolve({
      stat: () => {
        const current =
          openedIdentity === this.identity ? this.contents : openedContents;
        return Promise.resolve(this.metadata(openedIdentity, current));
      },
      read: (buffer, offset, length, position) => {
        if (this.readError !== undefined) return Promise.reject(this.readError);
        const call = { position, length };
        this.reads.push(call);
        const current =
          openedIdentity === this.identity ? this.contents : openedContents;
        if (current === undefined) return Promise.resolve({ bytesRead: 0 });
        const bytesRead = Math.max(0, Math.min(length, current.length - position));
        current.copy(buffer, offset, position, position + bytesRead);
        this.contentBytesRead += bytesRead;
        this.maxReturnedBuffer = Math.max(this.maxReturnedBuffer, bytesRead);
        return Promise.resolve({ bytesRead });
      },
      close: () => {
        this.closes += 1;
        this.events.push("close");
        return Promise.resolve();
      },
    });
  }

  private metadata(
    identity: number,
    contents: Buffer | undefined,
  ): ReportFileMetadata {
    if (contents === undefined) throw missing();
    return {
      size: contents.length,
      device: 11,
      inode: identity,
      birthtimeMs: identity,
    };
  }
}

function toBuffer(value: string | Buffer): Buffer {
  return typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
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
