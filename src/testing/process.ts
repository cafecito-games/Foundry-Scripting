import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import type { TestAdapterCommand } from "./command.js";

export type TestAdapterProcessFailureKind =
  | "missing_engine"
  | "spawn_failed";

export class TestAdapterProcessFailure extends Error {
  constructor(
    readonly kind: TestAdapterProcessFailureKind,
    readonly setting: string | undefined,
    options?: ErrorOptions,
  ) {
    super(processFailureMessage(kind), options);
    this.name = "TestAdapterProcessFailure";
  }
}

export interface TestAdapterProcessResult {
  readonly kind: "exited" | "cancelled";
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  /** Newest bounded diagnostic tail, not a complete process transcript. */
  readonly stdout: string;
  /** Newest bounded diagnostic tail, not a complete process transcript. */
  readonly stderr: string;
}

export interface FoundryTestAdapterProcessOptions {
  readonly spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly onOutput?: (text: string, stream: "stdout" | "stderr") => void;
  readonly terminationGraceMs?: number;
  readonly shutdownDeadlineMs?: number;
  readonly outputTailLimit?: number;
}

interface ActiveTestAdapterProcess {
  readonly controller: AbortController;
  readonly completion: Promise<TestAdapterProcessResult>;
}

export class FoundryTestAdapterProcess {
  private readonly spawnProcess;
  private readonly onOutput;
  private readonly terminationGraceMs;
  private readonly shutdownDeadlineMs;
  private readonly outputTailLimit;
  private readonly active = new Set<ActiveTestAdapterProcess>();
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  constructor(options: FoundryTestAdapterProcessOptions = {}) {
    const outputTailLimit = options.outputTailLimit ?? 65_536;
    if (!Number.isInteger(outputTailLimit) || outputTailLimit <= 0) {
      throw new TypeError("outputTailLimit must be a positive integer.");
    }
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.onOutput = options.onOutput;
    this.terminationGraceMs = options.terminationGraceMs ?? 2_000;
    this.shutdownDeadlineMs = options.shutdownDeadlineMs ?? 5_000;
    this.outputTailLimit = outputTailLimit;
  }

  run(
    command: TestAdapterCommand,
    signal: AbortSignal,
    onOutput?: (text: string, stream: "stdout" | "stderr") => void,
  ): Promise<TestAdapterProcessResult> {
    if (this.stopped || signal.aborted) {
      return Promise.resolve(cancelledResult("", ""));
    }

    let child: ChildProcess;
    try {
      child = this.spawnProcess(command.command, command.args, {
        cwd: command.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return Promise.reject(toProcessFailure(error));
    }

    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    signal.addEventListener("abort", onCallerAbort, { once: true });
    if (signal.aborted) {
      controller.abort();
    }
    const operationSignal = controller.signal;
    const completion = new Promise<TestAdapterProcessResult>((resolve, reject) => {
      const stdout = new ChunkedTextTail(this.outputTailLimit);
      const stderr = new ChunkedTextTail(this.outputTailLimit);
      let cancelled = false;
      let settled = false;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;

      const onStdout = (data: Buffer | string): void => {
        const text = data.toString();
        stdout.append(text);
        this.onOutput?.(text, "stdout");
        onOutput?.(text, "stdout");
      };
      const onStderr = (data: Buffer | string): void => {
        const text = data.toString();
        stderr.append(text);
        this.onOutput?.(text, "stderr");
        onOutput?.(text, "stderr");
      };
      const ignoreLateError = (): void => undefined;
      const cleanup = (): void => {
        signal.removeEventListener("abort", onCallerAbort);
        operationSignal.removeEventListener("abort", onAbort);
        child.stdout?.off("data", onStdout);
        child.stderr?.off("data", onStderr);
        child.off("error", onError);
        child.once("error", ignoreLateError);
        child.off("close", onClose);
        if (terminationTimer !== undefined) {
          clearTimeout(terminationTimer);
        }
        if (shutdownTimer !== undefined) {
          clearTimeout(shutdownTimer);
        }
      };
      const finish = (result: TestAdapterProcessResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(toProcessFailure(error));
      };
      const onError = (error: Error): void => {
        if (cancelled) {
          finish(cancelledResult(stdout.value(), stderr.value()));
        } else {
          fail(error);
        }
      };
      const onClose = (
        code: number | null,
        closeSignal: NodeJS.Signals | null,
      ): void => {
        finish(
          cancelled
            ? cancelledResult(stdout.value(), stderr.value())
            : {
                kind: "exited",
                ...(code === null ? {} : { exitCode: code }),
                ...(closeSignal === null ? {} : { signal: closeSignal }),
                stdout: stdout.value(),
                stderr: stderr.value(),
              },
        );
      };
      const onAbort = (): void => {
        if (settled || cancelled) {
          return;
        }
        cancelled = true;
        child.kill("SIGTERM");
        terminationTimer = setTimeout(() => {
          if (!settled && child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }, this.terminationGraceMs);
        shutdownTimer = setTimeout(() => {
          finish(cancelledResult(stdout.value(), stderr.value()));
        }, this.shutdownDeadlineMs);
        terminationTimer.unref?.();
        shutdownTimer.unref?.();
      };

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);
      operationSignal.addEventListener("abort", onAbort, { once: true });
      if (operationSignal.aborted) {
        onAbort();
      }
    });
    let operation: ActiveTestAdapterProcess;
    const trackedCompletion = completion.finally(() => {
      this.active.delete(operation);
    });
    operation = { controller, completion: trackedCompletion };
    this.active.add(operation);
    return trackedCompletion;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    this.stopped = true;
    const operations = [...this.active];
    for (const operation of operations) {
      operation.controller.abort();
    }
    this.stopPromise = Promise.allSettled(
      operations.map((operation) => operation.completion),
    ).then(() => undefined);
    return this.stopPromise;
  }
}

class ChunkedTextTail {
  private chunks: string[] = [];
  private head = 0;
  private headOffset = 0;
  private retainedLength = 0;

  constructor(private readonly limit: number) {}

  append(text: string): void {
    if (text.length === 0) {
      return;
    }
    if (text.length >= this.limit) {
      this.chunks = [text.slice(-this.limit)];
      this.head = 0;
      this.headOffset = 0;
      this.retainedLength = this.limit;
      return;
    }

    this.chunks.push(text);
    this.retainedLength += text.length;
    let discard = this.retainedLength - this.limit;
    while (discard > 0) {
      const chunk = this.chunks[this.head];
      if (chunk === undefined) {
        throw new Error("Output tail accounting became inconsistent.");
      }
      const available = chunk.length - this.headOffset;
      if (discard >= available) {
        discard -= available;
        this.retainedLength -= available;
        this.head += 1;
        this.headOffset = 0;
      } else {
        this.headOffset += discard;
        this.retainedLength -= discard;
        discard = 0;
      }
    }
    this.compactDiscardedChunks();
  }

  value(): string {
    if (this.retainedLength === 0) {
      return "";
    }
    const first = this.chunks[this.head];
    if (first === undefined) {
      throw new Error("Output tail accounting became inconsistent.");
    }
    if (this.head === this.chunks.length - 1) {
      return first.slice(this.headOffset);
    }
    return [
      first.slice(this.headOffset),
      ...this.chunks.slice(this.head + 1),
    ].join("");
  }

  private compactDiscardedChunks(): void {
    if (this.head < 64 || this.head * 2 < this.chunks.length) {
      return;
    }
    this.chunks = this.chunks.slice(this.head);
    this.head = 0;
  }
}

function cancelledResult(
  stdout: string,
  stderr: string,
): TestAdapterProcessResult {
  return { kind: "cancelled", stdout, stderr };
}

function toProcessFailure(error: unknown): TestAdapterProcessFailure {
  const kind = isMissingExecutableError(error)
    ? "missing_engine"
    : "spawn_failed";
  return new TestAdapterProcessFailure(
    kind,
    kind === "missing_engine" ? "foundryScript.enginePath" : undefined,
    { cause: error },
  );
}

function isMissingExecutableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return ["ENOENT", "EACCES", "ENOTDIR", "ERR_INVALID_ARG_VALUE"].includes(
    String(error.code),
  );
}

function processFailureMessage(kind: TestAdapterProcessFailureKind): string {
  switch (kind) {
    case "missing_engine":
      return "Unable to start the Foundry CLI. Configure foundryScript.enginePath and try again.";
    case "spawn_failed":
      return "Unable to start Foundry test adapter negotiation.";
  }
}
