import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import * as net from "node:net";
import {
  type HostLaunchRequest,
  type OwnedToolingHost,
  type ToolingHostLauncher,
  type ToolingHostReadiness,
} from "./connection-manager.js";
import { type LogOutput, writeLog } from "./logging.js";

export interface LegacyLspCommandRequest extends HostLaunchRequest {
  port: number;
}

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

export function buildLegacyLspCommand({
  enginePath,
  project,
  port,
}: LegacyLspCommandRequest): HostCommand {
  return {
    command: enginePath,
    args: [
      "lsp",
      "serve",
      "--port",
      String(port),
      "--project",
      project,
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

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;
}

export function parseToolingReadinessLine(
  line: string,
): ToolingHostReadiness | undefined {
  const prefix = "FOUNDRY_TOOLING ";
  if (!line.startsWith(prefix)) {
    return undefined;
  }

  let record: ToolingReadinessRecord;
  try {
    record = JSON.parse(line.slice(prefix.length)) as ToolingReadinessRecord;
  } catch {
    return undefined;
  }

  if (
    typeof record.project !== "string" ||
    !Number.isInteger(record.pid) ||
    record.local_only !== true ||
    !Array.isArray(record.services) ||
    !record.services.every((service) => typeof service === "string") ||
    !record.services.includes("lsp") ||
    !isPort(record.lsp_port) ||
    (record.dap_port !== undefined && !isPort(record.dap_port))
  ) {
    return undefined;
  }

  return {
    project: record.project,
    pid: Number(record.pid),
    localOnly: true,
    services: record.services,
    lspPort: record.lsp_port,
    ...(record.dap_port === undefined ? {} : { dapPort: record.dap_port }),
  };
}

export async function allocateLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("ephemeral TCP listener did not expose a port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

export type HostStartupFailureKind =
  | "missing_engine"
  | "spawn_failed"
  | "process_exit"
  | "readiness_timeout"
  | "port_conflict";

export type HostStartupTimeoutReason = "inactivity" | "absolute";

export interface HostStartupFailureDetails extends LegacyLspCommandRequest {
  kind: HostStartupFailureKind;
  exitCode?: number | null;
  timeoutReason?: HostStartupTimeoutReason;
  timeoutMs?: number;
  cause?: unknown;
}

function startupFailureMessage(details: HostStartupFailureDetails): string {
  const target = `project "${details.project}" on port ${details.port}`;
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
      return `Foundry could not bind the language server for ${target} because the port is already in use.`;
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
  readonly port: number;
  readonly exitCode: number | null | undefined;
  readonly timeoutReason: HostStartupTimeoutReason | undefined;
  readonly timeoutMs: number | undefined;

  constructor(details: HostStartupFailureDetails) {
    super(startupFailureMessage(details), { cause: details.cause });
    this.name = "HostStartupFailure";
    this.kind = details.kind;
    this.enginePath = details.enginePath;
    this.project = details.project;
    this.port = details.port;
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
  allocatePort?: () => Promise<number>;
  spawnProcess?: SpawnProcess;
  buildCommand?: (request: LegacyLspCommandRequest) => HostCommand;
  inactivityTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  pollIntervalMs?: number;
  output?: LogOutput;
}

interface StartupState {
  spawnError?: NodeJS.ErrnoException;
  exit?: { code: number | null };
  readiness?: ToolingHostReadiness;
  stderr: string;
  structuredBindFailure: boolean;
  lastActivityAt: number;
}

type HostOutputStream = "stdout" | "stderr";

interface StartupOutputObserver {
  flush(): void;
}

function observeOutput(
  child: ChildProcess,
  state: StartupState,
  now: () => number,
  onLine: (stream: HostOutputStream, line: string) => void,
): StartupOutputObserver {
  const buffers: Record<HostOutputStream, string> = {
    stdout: "",
    stderr: "",
  };

  const acceptLine = (stream: HostOutputStream, line: string): void => {
    if (stream === "stdout") {
      state.readiness ??= parseToolingReadinessLine(line);
    } else if (line.startsWith("FOUNDRY_TOOLING_ERROR ")) {
      try {
        const record = JSON.parse(
          line.slice("FOUNDRY_TOOLING_ERROR ".length),
        ) as { error?: unknown };
        state.structuredBindFailure ||= record.error === "bind_failed";
      } catch {
        // Human-readable stderr is classified below.
      }
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

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(connected);
    };
    const timer = setTimeout(() => finish(false), 100);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isBindFailure(state: StartupState): boolean {
  return (
    state.structuredBindFailure ||
    /EADDRINUSE|address already in use|bind (?:failed|error)/i.test(state.stderr)
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
  private readonly allocatePort: () => Promise<number>;
  private readonly spawnProcess: SpawnProcess;
  private readonly buildCommand: (
    request: LegacyLspCommandRequest,
  ) => HostCommand;
  private readonly inactivityTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly output: LogOutput | undefined;

  constructor(options: FoundryHostLauncherOptions = {}) {
    this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.buildCommand = options.buildCommand ?? buildLegacyLspCommand;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 15_000;
    this.absoluteTimeoutMs = options.absoluteTimeoutMs ?? 120_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.output = options.output;
  }

  async launch(request: HostLaunchRequest): Promise<OwnedToolingHost> {
    throwIfAborted(request.signal);
    const port = await this.allocatePort();
    throwIfAborted(request.signal);
    const commandRequest = { ...request, port };
    const command = this.buildCommand(commandRequest);
    this.log("info", "lsp.host.launching", {
      project: request.project,
      port,
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
        ...commandRequest,
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
      structuredBindFailure: false,
      lastActivityAt: startedAt,
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      state.spawnError = error;
    });
    child.once("exit", (code) => {
      state.exit = { code };
    });
    const outputObserver = observeOutput(
      child,
      state,
      Date.now,
      (stream, message) => {
        this.log("info", "lsp.host.output", {
          project: request.project,
          port,
          stream,
          message,
        });
      },
    );

    try {
      const readiness = await this.waitForReadiness(
        child,
        commandRequest,
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
    child: ChildProcess,
    request: LegacyLspCommandRequest,
    state: StartupState,
    startedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<ToolingHostReadiness> {
    while (true) {
      throwIfAborted(signal);
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
          port: request.port,
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
      if (await canConnect(request.port)) {
        return {
          project: request.project,
          pid: child.pid ?? 0,
          localOnly: true,
          services: ["lsp"],
          lspPort: request.port,
        };
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
