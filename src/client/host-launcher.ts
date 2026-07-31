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
  | "process_exit"
  | "readiness_timeout"
  | "port_conflict";

export interface HostStartupFailureDetails extends LegacyLspCommandRequest {
  kind: HostStartupFailureKind;
  exitCode?: number | null;
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
    case "process_exit":
      return (
        `Foundry exited with code ${String(details.exitCode)} before the ` +
        `language server for ${target} became ready.`
      );
    case "port_conflict":
      return `Foundry could not bind the language server for ${target} because the port is already in use.`;
    case "readiness_timeout":
      return `Timed out waiting for the Foundry language server for ${target}.`;
  }
}

export class HostStartupFailure extends Error {
  readonly kind: HostStartupFailureKind;
  readonly enginePath: string;
  readonly project: string;
  readonly port: number;
  readonly exitCode: number | null | undefined;

  constructor(details: HostStartupFailureDetails) {
    super(startupFailureMessage(details), { cause: details.cause });
    this.name = "HostStartupFailure";
    this.kind = details.kind;
    this.enginePath = details.enginePath;
    this.project = details.project;
    this.port = details.port;
    this.exitCode = details.exitCode;
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
  timeoutMs?: number;
  pollIntervalMs?: number;
  output?: LogOutput;
}

interface StartupState {
  spawnError?: NodeJS.ErrnoException;
  exit?: { code: number | null };
  readiness?: ToolingHostReadiness;
  stderr: string;
  structuredBindFailure: boolean;
}

function observeOutput(child: ChildProcess, state: StartupState): void {
  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      state.readiness ??= parseToolingReadinessLine(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    state.stderr += text;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("FOUNDRY_TOOLING_ERROR ")) {
        continue;
      }
      try {
        const record = JSON.parse(line.slice("FOUNDRY_TOOLING_ERROR ".length)) as {
          error?: unknown;
        };
        state.structuredBindFailure ||= record.error === "bind_failed";
      } catch {
        // Human-readable stderr is classified below.
      }
    }
  });
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
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly output: LogOutput | undefined;

  constructor(options: FoundryHostLauncherOptions = {}) {
    this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.buildCommand = options.buildCommand ?? buildLegacyLspCommand;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.output = options.output;
  }

  async launch(request: HostLaunchRequest): Promise<OwnedToolingHost> {
    const port = await this.allocatePort();
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
        kind: "missing_engine",
        cause: error,
      });
    }
    const state: StartupState = {
      stderr: "",
      structuredBindFailure: false,
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      state.spawnError = error;
    });
    child.once("exit", (code) => {
      state.exit = { code };
    });
    observeOutput(child, state);

    try {
      const readiness = await this.waitForReadiness(
        child,
        commandRequest,
        state,
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
        },
      };
    } catch (error) {
      await stopChild(child);
      throw error;
    }
  }

  private async waitForReadiness(
    child: ChildProcess,
    request: LegacyLspCommandRequest,
    state: StartupState,
  ): Promise<ToolingHostReadiness> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (state.readiness !== undefined) {
        return state.readiness;
      }
      if (state.spawnError !== undefined) {
        throw new HostStartupFailure({
          ...request,
          kind:
            isEnginePathError(state.spawnError.code)
              ? "missing_engine"
              : "process_exit",
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
      if (await canConnect(request.port)) {
        return {
          project: request.project,
          pid: child.pid ?? 0,
          localOnly: true,
          services: ["lsp"],
          lspPort: request.port,
        };
      }
      await delay(this.pollIntervalMs);
    }

    throw new HostStartupFailure({
      ...request,
      kind: isBindFailure(state) ? "port_conflict" : "readiness_timeout",
    });
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
