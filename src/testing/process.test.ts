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

  complete(code: number | null): void {
    this.exitCode = code;
    this.emit("close", code, null);
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
