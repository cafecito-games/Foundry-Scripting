import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoundryTaskCommand } from "./command.js";
import {
  FoundryTaskProcess,
  type FoundryTaskProcessError,
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

const command: FoundryTaskCommand = {
  command: "/opt/foundry",
  args: [
    "project",
    "test",
    "--project",
    "/workspace/game",
    "--runner",
    "res://tests/runner.fs",
  ],
  cwd: "/workspace/game",
};

function createSink() {
  return {
    write: vi.fn<(text: string) => void>(),
    close: vi.fn<(exitCode: number | undefined) => void>(),
    fail: vi.fn<(error: FoundryTaskProcessError) => void>(),
  };
}

describe("Foundry task child process", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns without a shell and preserves ordinary stdout and stderr", async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child.asChildProcess());
    const sink = createSink();
    const process = new FoundryTaskProcess(command, sink, { spawnProcess });

    process.start();
    child.stdout.write("plain runner output\n");
    child.stdout.write('TAP version 13\n{"status":"passed"}\n');
    child.stderr.write("runner warning\n");
    await Promise.resolve();

    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/foundry",
      command.args,
      {
        cwd: "/workspace/game",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(sink.write.mock.calls.map(([text]) => text).join("")).toBe(
      'plain runner output\r\nTAP version 13\r\n{"status":"passed"}\r\nrunner warning\r\n',
    );
  });

  it("preserves CRLF when a stream splits the pair across chunks", async () => {
    const child = new FakeChildProcess();
    const sink = createSink();
    const process = new FoundryTaskProcess(command, sink, {
      spawnProcess: () => child.asChildProcess(),
    });

    process.start();
    child.stdout.write("first\r");
    child.stdout.write("\nsecond\n");
    await Promise.resolve();

    expect(sink.write.mock.calls.map(([text]) => text).join("")).toBe(
      "first\r\nsecond\r\n",
    );
  });

  it("reports the child exit code once", () => {
    const child = new FakeChildProcess();
    const sink = createSink();
    const process = new FoundryTaskProcess(command, sink, {
      spawnProcess: () => child.asChildProcess(),
    });

    process.start();
    child.complete(23);
    child.emit("error", new Error("late error"));

    expect(sink.close).toHaveBeenCalledOnce();
    expect(sink.close).toHaveBeenCalledWith(23);
  });

  it("turns a missing executable into an actionable engine-setting error", () => {
    const child = new FakeChildProcess();
    const sink = createSink();
    const process = new FoundryTaskProcess(command, sink, {
      spawnProcess: () => child.asChildProcess(),
    });

    process.start();
    child.emit(
      "error",
      Object.assign(new Error("spawn /missing/foundry ENOENT"), {
        code: "ENOENT",
      }),
    );

    expect(sink.fail).toHaveBeenCalledWith(
      expect.objectContaining<Partial<FoundryTaskProcessError>>({
        kind: "missing_engine",
        setting: "foundryScript.enginePath",
      }),
    );
    expect(sink.close).toHaveBeenCalledWith(1);
  });

  it("maps a synchronously rejected executable path to the same error", () => {
    const sink = createSink();
    const process = new FoundryTaskProcess(command, sink, {
      spawnProcess: () => {
        throw Object.assign(new Error("file cannot be empty"), {
          code: "ERR_INVALID_ARG_VALUE",
        });
      },
    });

    process.start();

    expect(sink.fail).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "missing_engine" }),
    );
    expect(sink.close).toHaveBeenCalledWith(1);
  });

  it("cancellation terminates the child and escalates after the grace period", async () => {
    const child = new FakeChildProcess();
    const sink = createSink();
    const process = new FoundryTaskProcess(command, sink, {
      spawnProcess: () => child.asChildProcess(),
      terminationGraceMs: 2_000,
    });
    process.start();

    process.cancel();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(2_000);

    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

    child.complete(null);
    expect(sink.close).toHaveBeenCalledWith(undefined);
  });

  it("does not escalate after the cancelled child exits", async () => {
    const child = new FakeChildProcess();
    const process = new FoundryTaskProcess(command, createSink(), {
      spawnProcess: () => child.asChildProcess(),
      terminationGraceMs: 2_000,
    });
    process.start();

    process.cancel();
    child.complete(null);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
