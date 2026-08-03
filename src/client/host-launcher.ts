import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  type HostLaunchRequest,
  type OwnedToolingHost,
  type ToolingHostLauncher,
  type ToolingHostReadiness,
} from "../tooling/coordinator.js";
import { type LogOutput, writeLog } from "./logging.js";

export interface HostCommand {
  command: string;
  args: string[];
}

export function buildToolingHostCommand({
  enginePath,
  project,
}: HostLaunchRequest): HostCommand {
  return {
    command: enginePath,
    args: [
      "tooling",
      "serve",
      "--project",
      project,
      "--lsp-port",
      "0",
      "--dap-port",
      "0",
    ],
  };
}

interface ToolingReadinessRecord {
  project?: unknown;
  pid?: unknown;
  local_only?: unknown;
  services?: unknown;
  lsp_port?: unknown;
  dap_port?: unknown;
}

interface ToolingErrorRecord {
  error: string;
  message?: string;
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;
}

export function parseToolingReadinessLine(
  line: string,
  expectedProject: string,
): ToolingHostReadiness | undefined {
  const prefix = "FOUNDRY_TOOLING ";
  if (!line.startsWith(prefix)) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(line.slice(prefix.length));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as ToolingReadinessRecord;

  if (
    record.project !== expectedProject ||
    !Number.isInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    record.local_only !== true ||
    !Array.isArray(record.services) ||
    !record.services.every((service) => typeof service === "string") ||
    !record.services.includes("lsp") ||
    !record.services.includes("dap") ||
    !isPort(record.lsp_port) ||
    !isPort(record.dap_port) ||
    record.lsp_port === record.dap_port
  ) {
    return undefined;
  }

  return {
    project: record.project,
    pid: Number(record.pid),
    localOnly: true,
    services: record.services,
    lspPort: record.lsp_port,
    dapPort: record.dap_port,
  };
}

function parseToolingErrorLine(line: string): ToolingErrorRecord | undefined {
  const prefix = "FOUNDRY_TOOLING_ERROR ";
  if (!line.startsWith(prefix)) {
    return undefined;
  }

  try {
    const record = JSON.parse(line.slice(prefix.length)) as {
      error?: unknown;
      message?: unknown;
    };
    if (
      typeof record.error !== "string" ||
      record.error === "" ||
      (record.message !== undefined && typeof record.message !== "string")
    ) {
      return undefined;
    }
    return {
      error: record.error,
      ...(record.message === undefined ? {} : { message: record.message }),
    };
  } catch {
    return undefined;
  }
}

export type HostStartupFailureKind =
  | "missing_engine"
  | "spawn_failed"
  | "process_exit"
  | "readiness_timeout"
  | "port_conflict"
  | "invalid_project";

export type HostStartupTimeoutReason = "inactivity" | "absolute";

export interface HostStartupFailureDetails extends HostLaunchRequest {
  kind: HostStartupFailureKind;
  exitCode?: number | null;
  timeoutReason?: HostStartupTimeoutReason;
  timeoutMs?: number;
  toolingMessage?: string;
  cause?: unknown;
}

function startupFailureMessage(details: HostStartupFailureDetails): string {
  const target = `project "${details.project}"`;
  if (details.toolingMessage !== undefined) {
    return `Foundry tooling host failed for ${target}: ${details.toolingMessage}`;
  }
  switch (details.kind) {
    case "missing_engine":
      return (
        `Foundry executable "${details.enginePath}" was not found while ` +
        `starting ${target}. Check foundryScript.enginePath.`
      );
    case "spawn_failed": {
      const spawnError = details.cause as NodeJS.ErrnoException | undefined;
      const reason = [spawnError?.code, spawnError?.message]
        .filter((value): value is string => Boolean(value))
        .join(": ");
      return `Could not start Foundry for ${target}${reason === "" ? "." : `: ${reason}.`}`;
    }
    case "process_exit":
      return (
        `Foundry exited with code ${String(details.exitCode)} before the ` +
        `language server for ${target} became ready.`
      );
    case "port_conflict":
      return `Foundry could not bind the tooling host for ${target} because a requested port is already in use.`;
    case "invalid_project":
      return `Foundry could not start the tooling host because ${target} is invalid.`;
    case "readiness_timeout": {
      if (
        details.timeoutReason === "inactivity" &&
        details.timeoutMs !== undefined
      ) {
        return (
          `Foundry produced no startup output for ${details.timeoutMs} milliseconds ` +
          `while starting the language server for ${target}.`
        );
      }
      if (
        details.timeoutReason === "absolute" &&
        details.timeoutMs !== undefined
      ) {
        return (
          `Foundry did not become ready within ${details.timeoutMs} milliseconds ` +
          `while starting the language server for ${target}.`
        );
      }
      return `Timed out waiting for the Foundry language server for ${target}.`;
    }
  }
}

export class HostStartupFailure extends Error {
  readonly kind: HostStartupFailureKind;
  readonly enginePath: string;
  readonly project: string;
  readonly exitCode: number | null | undefined;
  readonly timeoutReason: HostStartupTimeoutReason | undefined;
  readonly timeoutMs: number | undefined;

  constructor(details: HostStartupFailureDetails) {
    super(startupFailureMessage(details), { cause: details.cause });
    this.name = "HostStartupFailure";
    this.kind = details.kind;
    this.enginePath = details.enginePath;
    this.project = details.project;
    this.exitCode = details.exitCode;
    this.timeoutReason = details.timeoutReason;
    this.timeoutMs = details.timeoutMs;
  }
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface FoundryHostLauncherOptions {
  spawnProcess?: SpawnProcess;
  buildCommand?: (request: HostLaunchRequest) => HostCommand;
  inactivityTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  pollIntervalMs?: number;
  output?: LogOutput;
}

interface StartupState {
  spawnError?: NodeJS.ErrnoException;
  exit?: { code: number | null };
  readiness?: ToolingHostReadiness;
  toolingError?: ToolingErrorRecord;
  stderr: string;
  lastActivityAt: number;
}

type HostOutputStream = "stdout" | "stderr";

interface StartupOutputObserver {
  flush(): void;
}

function observeOutput(
  child: ChildProcess,
  state: StartupState,
  expectedProject: string,
  now: () => number,
  onLine: (stream: HostOutputStream, line: string) => void,
): StartupOutputObserver {
  const buffers: Record<HostOutputStream, string> = {
    stdout: "",
    stderr: "",
  };

  const acceptLine = (stream: HostOutputStream, line: string): void => {
    state.toolingError ??= parseToolingErrorLine(line);
    if (stream === "stdout") {
      state.readiness ??= parseToolingReadinessLine(line, expectedProject);
    }
    if (line !== "") onLine(stream, line);
  };

  const acceptChunk = (
    stream: HostOutputStream,
    chunk: Buffer | string,
  ): void => {
    const text = chunk.toString();
    if (text.length === 0) return;
    state.lastActivityAt = now();
    if (stream === "stderr") state.stderr += text;
    buffers[stream] += text;
    const lines = buffers[stream].split(/\r?\n/);
    buffers[stream] = lines.pop() ?? "";
    for (const line of lines) acceptLine(stream, line);
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    acceptChunk("stdout", chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    acceptChunk("stderr", chunk);
  });

  return {
    flush: () => {
      for (const stream of ["stdout", "stderr"] as const) {
        const tail = buffers[stream];
        buffers[stream] = "";
        if (tail !== "") acceptLine(stream, tail);
      }
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isBindFailure(state: StartupState): boolean {
  return /EADDRINUSE|address already in use|bind (?:failed|error)/i.test(
    state.stderr,
  );
}

function isEnginePathError(code: string | undefined): boolean {
  return code === "ENOENT" || code === "EACCES" || code === "ENOTDIR";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) {
    return;
  }
  const error = new Error("Foundry tooling host startup was cancelled.");
  error.name = "AbortError";
  throw error;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  if (!child.kill("SIGTERM")) {
    return;
  }
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

export class FoundryHostLauncher implements ToolingHostLauncher {
  private readonly spawnProcess: SpawnProcess;
  private readonly buildCommand: (request: HostLaunchRequest) => HostCommand;
  private readonly inactivityTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly output: LogOutput | undefined;

  constructor(options: FoundryHostLauncherOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.buildCommand = options.buildCommand ?? buildToolingHostCommand;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 15_000;
    this.absoluteTimeoutMs = options.absoluteTimeoutMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.output = options.output;
  }

  async launch(request: HostLaunchRequest): Promise<OwnedToolingHost> {
    throwIfAborted(request.signal);
    const command = this.buildCommand(request);
    this.log("info", "lsp.host.launching", {
      project: request.project,
      command: command.command,
      args: command.args,
    });

    let child: ChildProcess;
    try {
      child = this.spawnProcess(command.command, command.args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new HostStartupFailure({
        ...request,
        kind:
          isEnginePathError((error as NodeJS.ErrnoException).code) ||
          (error as NodeJS.ErrnoException).code === "ERR_INVALID_ARG_VALUE"
            ? "missing_engine"
            : "spawn_failed",
        cause: error,
      });
    }
    const startedAt = Date.now();
    const state: StartupState = {
      stderr: "",
      lastActivityAt: startedAt,
    };
    const exitListeners = new Set<(code: number | null) => void>();
    child.once("error", (error: NodeJS.ErrnoException) => {
      state.spawnError = error;
    });
    child.once("exit", (code) => {
      state.exit = { code };
      for (const listener of exitListeners) listener(code);
    });
    const outputObserver = observeOutput(
      child,
      state,
      request.project,
      Date.now,
      (stream, message) => {
        this.log("info", "lsp.host.output", {
          project: request.project,
          stream,
          message,
        });
      },
    );

    try {
      const readiness = await this.waitForReadiness(
        request,
        state,
        startedAt,
        request.signal,
      );
      this.log("info", "lsp.host.ready", {
        project: readiness.project,
        port: readiness.lspPort,
        pid: readiness.pid,
        services: readiness.services,
      });
      let stopped = false;
      return {
        readiness,
        onExit: (listener) => {
          let disposed = false;
          if (state.exit !== undefined) {
            queueMicrotask(() => {
              if (!disposed) listener(state.exit?.code ?? null);
            });
          } else {
            exitListeners.add(listener);
          }
          return {
            dispose: () => {
              disposed = true;
              exitListeners.delete(listener);
            },
          };
        },
        stop: async () => {
          if (stopped) return;
          stopped = true;
          await stopChild(child);
          outputObserver.flush();
        },
      };
    } catch (error) {
      await stopChild(child);
      outputObserver.flush();
      throw error;
    }
  }

  private async waitForReadiness(
    request: HostLaunchRequest,
    state: StartupState,
    startedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<ToolingHostReadiness> {
    while (true) {
      throwIfAborted(signal);
      if (state.toolingError !== undefined) {
        const kind: HostStartupFailureKind =
          state.toolingError.error === "bind_failed"
            ? "port_conflict"
            : state.toolingError.error === "invalid_project"
              ? "invalid_project"
              : "spawn_failed";
        throw new HostStartupFailure({
          ...request,
          kind,
          ...(state.toolingError.message === undefined
            ? {}
            : { toolingMessage: state.toolingError.message }),
        });
      }
      if (state.readiness !== undefined) {
        return state.readiness;
      }
      if (state.spawnError !== undefined) {
        throw new HostStartupFailure({
          ...request,
          kind:
            isEnginePathError(state.spawnError.code)
              ? "missing_engine"
              : "spawn_failed",
          cause: state.spawnError,
        });
      }
      if (state.exit !== undefined) {
        throw new HostStartupFailure({
          ...request,
          kind: isBindFailure(state) ? "port_conflict" : "process_exit",
          exitCode: state.exit.code,
        });
      }

      const now = Date.now();
      const absoluteElapsedMs = now - startedAt;
      const inactiveElapsedMs = now - state.lastActivityAt;
      const timeoutReason: HostStartupTimeoutReason | undefined =
        absoluteElapsedMs >= this.absoluteTimeoutMs
          ? "absolute"
          : inactiveElapsedMs >= this.inactivityTimeoutMs
            ? "inactivity"
            : undefined;
      if (timeoutReason !== undefined) {
        const timeoutMs =
          timeoutReason === "absolute"
            ? this.absoluteTimeoutMs
            : this.inactivityTimeoutMs;
        this.log("error", "lsp.host.timeout", {
          project: request.project,
          reason: timeoutReason,
          timeoutMs,
        });
        throw new HostStartupFailure({
          ...request,
          kind: isBindFailure(state) ? "port_conflict" : "readiness_timeout",
          timeoutReason,
          timeoutMs,
        });
      }
      await delay(
        Math.max(
          1,
          Math.min(
            this.pollIntervalMs,
            this.absoluteTimeoutMs - absoluteElapsedMs,
            this.inactivityTimeoutMs - inactiveElapsedMs,
          ),
        ),
      );
    }
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    if (this.output !== undefined) {
      writeLog(this.output, level, event, fields);
    }
  }
}
