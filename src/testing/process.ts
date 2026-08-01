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
  readonly stdout: string;
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
}

export class FoundryTestAdapterProcess {
  private readonly spawnProcess;
  private readonly onOutput;
  private readonly terminationGraceMs;
  private readonly shutdownDeadlineMs;

  constructor(options: FoundryTestAdapterProcessOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.onOutput = options.onOutput;
    this.terminationGraceMs = options.terminationGraceMs ?? 2_000;
    this.shutdownDeadlineMs = options.shutdownDeadlineMs ?? 5_000;
  }

  run(
    command: TestAdapterCommand,
    signal: AbortSignal,
    onOutput?: (text: string, stream: "stdout" | "stderr") => void,
  ): Promise<TestAdapterProcessResult> {
    if (signal.aborted) {
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

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let cancelled = false;
      let settled = false;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;

      const onStdout = (data: Buffer | string): void => {
        const text = data.toString();
        stdout += text;
        this.onOutput?.(text, "stdout");
        onOutput?.(text, "stdout");
      };
      const onStderr = (data: Buffer | string): void => {
        const text = data.toString();
        stderr += text;
        this.onOutput?.(text, "stderr");
        onOutput?.(text, "stderr");
      };
      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        child.stdout?.off("data", onStdout);
        child.stderr?.off("data", onStderr);
        child.off("error", onError);
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
          finish(cancelledResult(stdout, stderr));
        } else {
          fail(error);
        }
      };
      const onClose = (code: number | null): void => {
        finish(
          cancelled
            ? cancelledResult(stdout, stderr)
            : {
                kind: "exited",
                exitCode: code ?? 1,
                stdout,
                stderr,
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
          finish(cancelledResult(stdout, stderr));
        }, this.shutdownDeadlineMs);
        terminationTimer.unref?.();
        shutdownTimer.unref?.();
      };

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
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
