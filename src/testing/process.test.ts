import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestAdapterCommand } from "./command.js";
import {
  FoundryTestAdapterProcess,
  TestAdapterProcessFailure,
} from "./process.js";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly kill = vi.fn(() => true);

  complete(
    code: number | null,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.exitCode = code;
    this.emit("close", code, signal);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

const command: TestAdapterCommand = {
  command: "/opt/foundry",
  args: ["--headless", "project", "test"],
  cwd: "/workspace/game",
};

describe("Foundry test adapter child process", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns without a shell and keeps stdout and stderr separate", async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child.asChildProcess());
    const onOutput = vi.fn<(text: string, stream: "stdout" | "stderr") => void>();
    const process = new FoundryTestAdapterProcess({ spawnProcess, onOutput });
    const resultPromise = process.run(command, new AbortController().signal);

    child.stdout.write('application {"not":"capabilities"}\n');
    child.stderr.write("runner warning\n");
    await Promise.resolve();
    child.complete(23);

    await expect(resultPromise).resolves.toEqual({
      kind: "exited",
      exitCode: 23,
      stdout: 'application {"not":"capabilities"}\n',
      stderr: "runner warning\n",
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/foundry",
      command.args,
      {
        cwd: "/workspace/game",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(onOutput.mock.calls).toEqual([
      ['application {"not":"capabilities"}\n', "stdout"],
      ["runner warning\n", "stderr"],
    ]);
  });

  it("notifies constructor and run-scoped output observers without changing buffers", async () => {
    const child = new FakeChildProcess();
    const sharedOutput = vi.fn();
    const runOutput = vi.fn();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
      onOutput: sharedOutput,
    });
    const resultPromise = process.run(
      command,
      new AbortController().signal,
      runOutput,
    );

    child.stdout.write("application output\n");
    child.stderr.write("application error\n");
    await Promise.resolve();
    child.complete(0);

    await expect(resultPromise).resolves.toMatchObject({
      stdout: "application output\n",
      stderr: "application error\n",
    });
    expect(sharedOutput.mock.calls).toEqual(runOutput.mock.calls);
    expect(runOutput.mock.calls).toEqual([
      ["application output\n", "stdout"],
      ["application error\n", "stderr"],
    ]);
  });

  it.each([
    { output: "1234567", expected: "1234567" },
    { output: "12345678", expected: "12345678" },
    { output: "123456789", expected: "23456789" },
  ])("retains the exact newest suffix at and around the limit", async ({ output, expected }) => {
    const child = new FakeChildProcess();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
      outputTailLimit: 8,
    });
    const result = process.run(command, new AbortController().signal);

    child.stdout.write(output);
    await Promise.resolve();
    child.complete(0);

    await expect(result).resolves.toMatchObject({ stdout: expected });
  });

  it("bounds multi-megabyte stdout and stderr independently to default diagnostic tails", async () => {
    const child = new FakeChildProcess();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
    });
    const result = process.run(command, new AbortController().signal);
    const stdout = `${"a".repeat(2 * 1024 * 1024)}stdout-end`;
    const stderr = `${"b".repeat(3 * 1024 * 1024)}stderr-end`;

    child.stdout.write(stdout);
    child.stderr.write(stderr);
    await Promise.resolve();
    child.complete(0);

    await expect(result).resolves.toMatchObject({
      stdout: stdout.slice(-65_536),
      stderr: stderr.slice(-65_536),
    });
  });

  it("keeps many small chunks bounded while delivering every chunk to both observers", async () => {
    const child = new FakeChildProcess();
    const shared: string[] = [];
    const scoped: string[] = [];
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
      outputTailLimit: 127,
      onOutput: (text) => shared.push(text),
    });
    const result = process.run(
      command,
      new AbortController().signal,
      (text) => scoped.push(text),
    );
    const chunks = Array.from({ length: 20_000 }, (_, index) => `${index % 10}`);

    for (const chunk of chunks) child.stdout.write(chunk);
    await Promise.resolve();
    child.complete(0);

    const complete = chunks.join("");
    await expect(result).resolves.toMatchObject({
      stdout: complete.slice(-127),
    });
    expect(shared.join("")).toBe(complete);
    expect(scoped).toEqual(shared);
  });

  it("returns bounded independent tails when cancellation closes the child", async () => {
    const child = new FakeChildProcess();
    const controller = new AbortController();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
      outputTailLimit: 5,
    });
    const result = process.run(command, controller.signal);
    child.stdout.write("stdout-complete");
    child.stderr.write("stderr-complete");
    await Promise.resolve();

    controller.abort();
    child.complete(null);

    await expect(result).resolves.toEqual({
      kind: "cancelled",
      stdout: "plete",
      stderr: "plete",
    });
  });

  it("returns bounded tails at the cancellation hard deadline", async () => {
    const child = new FakeChildProcess();
    const controller = new AbortController();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
      outputTailLimit: 4,
      terminationGraceMs: 5,
      shutdownDeadlineMs: 10,
    });
    const result = process.run(command, controller.signal);
    child.stdout.write("123456");
    child.stderr.write("abcdef");
    await Promise.resolve();

    controller.abort();
    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toEqual({
      kind: "cancelled",
      stdout: "3456",
      stderr: "cdef",
    });
  });

  it("returns bounded tails when a cancelled child reports an error", async () => {
    const child = new FakeChildProcess();
    const controller = new AbortController();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
      outputTailLimit: 3,
    });
    const result = process.run(command, controller.signal);
    child.stdout.write("observer-still-receives-this");
    await Promise.resolve();

    controller.abort();
    child.emit("error", new Error("terminated"));

    await expect(result).resolves.toEqual({
      kind: "cancelled",
      stdout: "his",
      stderr: "",
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid output tail limit %s synchronously",
    (outputTailLimit) => {
      expect(
        () => new FoundryTestAdapterProcess({ outputTailLimit }),
      ).toThrow("outputTailLimit must be a positive integer");
    },
  );

  it.each(["ENOENT", "EACCES", "ENOTDIR", "ERR_INVALID_ARG_VALUE"])(
    "maps synchronous %s process creation errors to missing engine",
    async (code) => {
      const process = new FoundryTestAdapterProcess({
        spawnProcess: () => {
          throw Object.assign(new Error(code), { code });
        },
      });

      await expect(
        process.run(command, new AbortController().signal),
      ).rejects.toMatchObject({
        kind: "missing_engine",
        setting: "foundryScript.enginePath",
      });
    },
  );

  it("maps asynchronous engine errors and ignores later completion", async () => {
    const child = new FakeChildProcess();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
    });
    const resultPromise = process.run(command, new AbortController().signal);

    child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
    child.complete(0);

    await expect(resultPromise).rejects.toMatchObject({
      kind: "missing_engine",
    });
  });

  it("distinguishes other process creation failures", async () => {
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => {
        throw new Error("resource temporarily unavailable");
      },
    });

    const error = await captureProcessFailure(
      process.run(command, new AbortController().signal),
    );
    expect(error).toMatchObject({ kind: "spawn_failed" });
  });

  it("does not spawn when already cancelled", async () => {
    const spawnProcess = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      new FoundryTestAdapterProcess({ spawnProcess }).run(
        command,
        controller.signal,
      ),
    ).resolves.toEqual({
      kind: "cancelled",
      stdout: "",
      stderr: "",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("terminates, escalates, and resolves cancellation when the child closes", async () => {
    const child = new FakeChildProcess();
    const controller = new AbortController();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
      terminationGraceMs: 50,
      shutdownDeadlineMs: 100,
    });
    const resultPromise = process.run(command, controller.signal);

    controller.abort();
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    await vi.advanceTimersByTimeAsync(50);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    child.complete(null);

    await expect(resultPromise).resolves.toMatchObject({ kind: "cancelled" });
  });

  it("resolves cancellation at the hard deadline when close never arrives", async () => {
    const child = new FakeChildProcess();
    const controller = new AbortController();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
      terminationGraceMs: 25,
      shutdownDeadlineMs: 75,
    });
    const resultPromise = process.run(command, controller.signal);

    controller.abort();
    await vi.advanceTimersByTimeAsync(75);

    await expect(resultPromise).resolves.toMatchObject({ kind: "cancelled" });
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("does not escalate after a cancelled child exits", async () => {
    const child = new FakeChildProcess();
    const controller = new AbortController();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
      terminationGraceMs: 25,
      shutdownDeadlineMs: 75,
    });
    const resultPromise = process.run(command, controller.signal);

    controller.abort();
    child.complete(null);
    await vi.advanceTimersByTimeAsync(75);

    await expect(resultPromise).resolves.toMatchObject({ kind: "cancelled" });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("aborts only the child linked to an operation signal", async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    const children = [first, second];
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => children.shift()!.asChildProcess(),
      terminationGraceMs: 25,
      shutdownDeadlineMs: 75,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstResult = process.run(command, firstController.signal);
    const secondResult = process.run(command, secondController.signal);

    firstController.abort();
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    expect(second.kill).not.toHaveBeenCalled();
    first.complete(null);
    second.complete(0);

    await expect(firstResult).resolves.toMatchObject({ kind: "cancelled" });
    await expect(secondResult).resolves.toMatchObject({
      kind: "exited",
      exitCode: 0,
    });
  });

  it("stops every owned child within the hard deadline and becomes inert", async () => {
    const first = new FakeChildProcess();
    const second = new FakeChildProcess();
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(first.asChildProcess())
      .mockReturnValueOnce(second.asChildProcess());
    const process = new FoundryTestAdapterProcess({
      spawnProcess,
      terminationGraceMs: 25,
      shutdownDeadlineMs: 75,
    });
    const firstResult = process.run(command, new AbortController().signal);
    const secondResult = process.run(command, new AbortController().signal);

    const firstStop = process.stop();
    const secondStop = process.stop();
    expect(firstStop).toBe(secondStop);
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    expect(second.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(25);
    expect(first.kill).toHaveBeenLastCalledWith("SIGKILL");
    expect(second.kill).toHaveBeenLastCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(50);
    await firstStop;

    await expect(firstResult).resolves.toMatchObject({ kind: "cancelled" });
    await expect(secondResult).resolves.toMatchObject({ kind: "cancelled" });
    await expect(
      process.run(command, new AbortController().signal),
    ).resolves.toEqual({
      kind: "cancelled",
      stdout: "",
      stderr: "",
    });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("retains an unowned crash signal without inventing an exit code", async () => {
    const child = new FakeChildProcess();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
    });
    const result = process.run(command, new AbortController().signal);

    child.complete(null, "SIGSEGV");

    await expect(result).resolves.toEqual({
      kind: "exited",
      signal: "SIGSEGV",
      stdout: "",
      stderr: "",
    });
  });

  it("ignores late child events after process-wide deadline settlement", async () => {
    const child = new FakeChildProcess();
    const process = new FoundryTestAdapterProcess({
      spawnProcess: () => child.asChildProcess(),
      terminationGraceMs: 25,
      shutdownDeadlineMs: 75,
    });
    const result = process.run(command, new AbortController().signal);

    const stop = process.stop();
    await vi.advanceTimersByTimeAsync(75);
    child.complete(0);
    child.emit("error", new Error("late"));

    await expect(result).resolves.toMatchObject({ kind: "cancelled" });
    await expect(stop).resolves.toBeUndefined();
  });
});

async function captureProcessFailure(
  promise: Promise<unknown>,
): Promise<TestAdapterProcessFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TestAdapterProcessFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a test adapter process failure.");
}
