import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { DapClient } from "./client.js";
import { withTimeout } from "./protocol.js";

const FIXTURE_PATH = join(__dirname, "..", "fixtures", "dap-conformance");

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForReadiness(
  host: ChildProcess,
  output: () => string,
): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve, reject) => {
      const poll = (): void => {
        if (host.exitCode !== null) {
          reject(
            new Error(
              `Foundry tooling host exited with ${String(host.exitCode)}.`,
            ),
          );
          return;
        }
        const match = /FOUNDRY_TOOLING (\{[^\n]+\})/.exec(output());
        if (match !== null) {
          const readinessRecord = match[1];
          if (readinessRecord === undefined) {
            reject(new Error("Foundry tooling readiness record was empty."));
            return;
          }
          try {
            const readiness: unknown = JSON.parse(readinessRecord);
            if (
              typeof readiness === "object" &&
              readiness !== null &&
              "dap_port" in readiness &&
              typeof readiness.dap_port === "number"
            ) {
              resolve(readiness.dap_port);
              return;
            }
            reject(new Error(`Invalid readiness record: ${readinessRecord}`));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    }),
    180_000,
    "Foundry tooling readiness",
  );
}

async function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }),
    10_000,
    `loopback DAP connection on port ${String(port)}`,
  );
  return socket;
}

async function stopProcess(processValue: ChildProcess): Promise<void> {
  if (processValue.exitCode !== null) return;
  processValue.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => processValue.once("exit", () => resolve())),
    delay(10_000),
  ]);
  if (processValue.exitCode === null) {
    processValue.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) =>
        processValue.once("exit", () => resolve()),
      ),
      delay(5_000),
    ]);
  }
}

function terminateDebuggee(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

export class LiveConformanceHost {
  private constructor(
    client: DapClient,
    readonly projectPath: string,
    private readonly processValue: ChildProcess,
    private readonly outputValue: () => string,
    private readonly dapPort: number,
  ) {
    this.client = client;
    this.clients.push(client);
  }

  client: DapClient;
  private readonly clients: DapClient[] = [];

  static async run(
    enginePath: string,
    operation: (host: LiveConformanceHost) => Promise<void>,
    fixturePath = FIXTURE_PATH,
  ): Promise<void> {
    const projectPath = await mkdtemp(
      join(tmpdir(), "foundryscript-dap-conformance-"),
    );
    await cp(fixturePath, projectPath, { recursive: true });
    const hostProcess = spawn(
      enginePath,
      [
        "tooling",
        "serve",
        "--project",
        projectPath,
        "--lsp-port",
        "0",
        "--dap-port",
        "0",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    hostProcess.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    hostProcess.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    let client: DapClient | undefined;
    let liveHost: LiveConformanceHost | undefined;
    try {
      const dapPort = await waitForReadiness(hostProcess, () => output);
      const socket = await connect(dapPort);
      client = new DapClient(socket, {
        responseTimeoutMs: 30_000,
        eventTimeoutMs: 120_000,
      });
      liveHost = new LiveConformanceHost(
        client,
        projectPath,
        hostProcess,
        () => output,
        dapPort,
      );
      await operation(liveHost);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${detail}\n${liveHost?.diagnostics() ?? `Tooling host output:\n${output}\nDAP transcript:\n${client?.transcript() ?? "<not connected>"}`}`,
        { cause: error },
      );
    } finally {
      const debuggeePids =
        liveHost?.clients.flatMap((sessionClient) =>
          sessionClient.receivedMessages().flatMap(({ message }) => {
            const pid =
              message.type === "event" && message.event === "process"
                ? message.body?.systemProcessId
                : undefined;
            return typeof pid === "number" ? [pid] : [];
          }),
        ) ?? [];
      for (const sessionClient of liveHost?.clients ?? []) sessionClient.close();
      client?.close();
      await stopProcess(hostProcess);
      for (const pid of debuggeePids) terminateDebuggee(pid);
      await rm(projectPath, { recursive: true, force: true });
    }
  }

  async reconnect(): Promise<DapClient> {
    this.client.close();
    const socket = await connect(this.dapPort);
    this.client = new DapClient(socket, {
      responseTimeoutMs: 30_000,
      eventTimeoutMs: 120_000,
    });
    this.clients.push(this.client);
    return this.client;
  }

  diagnostics(): string {
    return (
      `Tooling host output:\n${this.outputValue()}\n` +
      this.clients
        .map(
          (client, index) =>
            `DAP session ${String(index + 1)} transcript:\n${client.transcript()}`,
        )
        .join("\n")
    );
  }

  hostPid(): number | undefined {
    return this.processValue.pid;
  }
}
