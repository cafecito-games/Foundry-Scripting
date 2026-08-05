import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { FoundryTaskCommand } from "./command.js";

export type FoundryTaskProcessErrorKind = "missing_engine" | "spawn_failed";
export type FoundryTaskProcessStream = "stdout" | "stderr";

export class FoundryTaskProcessError extends Error {
  constructor(
    readonly kind: FoundryTaskProcessErrorKind,
    readonly setting?: string,
    options?: ErrorOptions,
  ) {
    super(processErrorMessage(kind), options);
    this.name = "FoundryTaskProcessError";
  }
}

export interface FoundryTaskProcessSink {
  write(text: string, stream: FoundryTaskProcessStream): void;
  close(exitCode: number | undefined): void;
  fail(error: FoundryTaskProcessError): void;
}

export interface FoundryTaskProcessOptions {
  readonly spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  readonly terminationGraceMs?: number;
}

export class FoundryTaskProcess {
  private readonly spawnProcess;
  private readonly terminationGraceMs;
  private child: ChildProcess | undefined;
  private completed = false;
  private cancelled = false;
  private terminationTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stdoutText = new TerminalTextAdapter();
  private readonly stderrText = new TerminalTextAdapter();

  constructor(
    private readonly command: FoundryTaskCommand,
    private readonly sink: FoundryTaskProcessSink,
    options: FoundryTaskProcessOptions = {},
  ) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.terminationGraceMs = options.terminationGraceMs ?? 2_000;
  }

  start(): void {
    if (this.child !== undefined || this.completed) {
      return;
    }

    let child: ChildProcess;
    try {
      child = this.spawnProcess(this.command.command, this.command.args, {
        cwd: this.command.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.fail(error);
      return;
    }

    this.child = child;
    child.stdout?.on("data", (data: Buffer | string) => {
      this.sink.write(this.stdoutText.convert(data), "stdout");
    });
    child.stderr?.on("data", (data: Buffer | string) => {
      this.sink.write(this.stderrText.convert(data), "stderr");
    });
    child.once("error", (error) => {
      this.fail(error);
    });
    child.once("close", (code) => {
      this.finish(this.cancelled ? undefined : (code ?? 1));
    });
  }

  cancel(): void {
    if (this.cancelled || this.completed) {
      return;
    }
    this.cancelled = true;

    const child = this.child;
    if (child === undefined) {
      this.finish(undefined);
      return;
    }

    child.kill("SIGTERM");
    this.terminationTimer = setTimeout(() => {
      // A child killed by signal has exitCode === null and signalCode set.
      // Only escalate when the process is genuinely still alive.
      if (!this.completed && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, this.terminationGraceMs);
    // Don't let the escalation timer keep the extension host alive on
    // shutdown; explicit teardown still happens via the close listener or
    // dispose() below.
    this.terminationTimer.unref?.();
  }

  // Explicit teardown for extension shutdown paths that may discard the
  // terminal mid-task. Cancels the child if needed and clears the escalation
  // timer so the closure on `child` and the close listener are released
  // immediately rather than after terminationGraceMs.
  dispose(): void {
    if (!this.cancelled) {
      this.cancel();
    }
    if (this.terminationTimer !== undefined) {
      clearTimeout(this.terminationTimer);
      this.terminationTimer = undefined;
    }
  }

  private fail(error: unknown): void {
    if (this.completed) {
      return;
    }
    const kind = isMissingExecutableError(error)
      ? "missing_engine"
      : "spawn_failed";
    this.sink.fail(
      new FoundryTaskProcessError(
        kind,
        kind === "missing_engine" ? "foundryScript.enginePath" : undefined,
        { cause: error },
      ),
    );
    this.finish(1);
  }

  private finish(exitCode: number | undefined): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    if (this.terminationTimer !== undefined) {
      clearTimeout(this.terminationTimer);
      this.terminationTimer = undefined;
    }
    this.sink.close(exitCode);
  }
}

class TerminalTextAdapter {
  private previousEndedWithCarriageReturn = false;

  convert(data: Buffer | string): string {
    let converted = "";
    for (const character of data.toString()) {
      if (character === "\n" && !this.previousEndedWithCarriageReturn) {
        converted += "\r\n";
      } else {
        converted += character;
      }
      this.previousEndedWithCarriageReturn = character === "\r";
    }
    return converted;
  }
}

function isMissingExecutableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return ["ENOENT", "EACCES", "ENOTDIR", "ERR_INVALID_ARG_VALUE"].includes(
    String(error.code),
  );
}

function processErrorMessage(kind: FoundryTaskProcessErrorKind): string {
  switch (kind) {
    case "missing_engine":
      return "Unable to start the Foundry CLI. Configure foundryScript.enginePath and try again.";
    case "spawn_failed":
      return "Unable to start the Foundry CLI task.";
  }
}
