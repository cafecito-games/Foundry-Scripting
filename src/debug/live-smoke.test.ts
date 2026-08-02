import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import { describe, expect, it } from "vitest";

const enginePath = process.env.FOUNDRY_ENGINE_PATH;
const liveIt = enginePath === undefined ? it.skip : it;

const PROJECT_FILE = `config_version=5

[application]

config/name="FoundryScript DAP Smoke"
config/features=PackedStringArray("0.1")
run/main_scene="res://main.tscn"

[rendering]

renderer/rendering_method="gl_compatibility"
`;

const MAIN_SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://quit.fs" id="1_quit"]

[node name="Main" type="Node"]
script = ExtResource("1_quit")
`;

const QUIT_SCRIPT = `extends Node

func _ready() -> void:
	get_tree().quit(3)
`;

interface DapResponse {
  readonly type: "response";
  readonly request_seq: number;
  readonly success: boolean;
  readonly command?: string;
  readonly message?: string;
  readonly body?: Record<string, unknown>;
}

interface DapEvent {
  readonly type: "event";
  readonly event: string;
  readonly body?: Record<string, unknown>;
}

type DapMessage = DapResponse | DapEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDapMessage(text: string): DapMessage {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("DAP message is not an object.");
  if (
    value.type === "response" &&
    typeof value.request_seq === "number" &&
    typeof value.success === "boolean"
  ) {
    return value as unknown as DapResponse;
  }
  if (value.type === "event" && typeof value.event === "string") {
    return value as unknown as DapEvent;
  }
  throw new Error(`Unsupported DAP message: ${text}`);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil<T>(
  read: () => T | undefined,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

class DapClient {
  private buffer = Buffer.alloc(0);
  private nextSequence = 1;
  private readonly responses: DapResponse[] = [];
  private readonly events: DapEvent[] = [];
  private transportError: Error | undefined;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => this.accept(chunk));
    socket.on("error", (error) => {
      this.transportError = error;
    });
  }

  request(command: string, argumentsValue: Record<string, unknown>): number {
    const sequence = this.nextSequence++;
    const body = Buffer.from(
      JSON.stringify({
        seq: sequence,
        type: "request",
        command,
        arguments: argumentsValue,
      }),
    );
    this.socket.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`),
        body,
      ]),
    );
    return sequence;
  }

  async response(sequence: number, timeoutMs = 60_000): Promise<DapResponse> {
    return waitUntil(() => {
      this.throwTransportError();
      const index = this.responses.findIndex(
        (response) => response.request_seq === sequence,
      );
      if (index < 0) return undefined;
      return this.responses.splice(index, 1)[0];
    }, timeoutMs, `DAP response ${String(sequence)}`);
  }

  async event(name: string, timeoutMs = 120_000): Promise<DapEvent> {
    return waitUntil(() => {
      this.throwTransportError();
      return this.events.find((event) => event.event === name);
    }, timeoutMs, `DAP event ${name}`);
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  lifecycle(): string[] {
    return this.events
      .map((event) => event.event)
      .filter((name) => ["process", "exited", "terminated"].includes(name));
  }

  exitCode(): number | undefined {
    const exited = this.events.find((event) => event.event === "exited");
    const exitCode = exited?.body?.exitCode;
    return typeof exitCode === "number" ? exitCode : undefined;
  }

  private accept(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString();
      const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
      if (lengthMatch === null) {
        this.transportError = new Error(`Missing Content-Length: ${header}`);
        return;
      }
      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) return;
      const body = this.buffer
        .subarray(bodyStart, bodyStart + contentLength)
        .toString();
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      try {
        const message = parseDapMessage(body);
        if (message.type === "response") this.responses.push(message);
        else this.events.push(message);
      } catch (error) {
        this.transportError =
          error instanceof Error ? error : new Error(String(error));
        return;
      }
    }
  }

  private throwTransportError(): void {
    if (this.transportError !== undefined) throw this.transportError;
  }
}

async function stageProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "foundryscript-dap-smoke-"));
  await Promise.all([
    writeFile(join(project, "project.foundry"), PROJECT_FILE),
    writeFile(join(project, "main.tscn"), MAIN_SCENE),
    writeFile(join(project, "quit.fs"), QUIT_SCRIPT),
  ]);
  return project;
}

async function waitForReadiness(
  output: () => string,
  host: ChildProcess,
): Promise<{ readonly dapPort: number }> {
  return waitUntil(() => {
    if (host.exitCode !== null) {
      throw new Error(
        `Foundry tooling host exited with ${String(host.exitCode)}:\n${output()}`,
      );
    }
    const match = /FOUNDRY_TOOLING (\{[^\n]+\})/.exec(output());
    if (match === null) return undefined;
    const parsed: unknown = JSON.parse(match[1]);
    if (!isRecord(parsed) || typeof parsed.dap_port !== "number") {
      throw new Error(`Invalid Foundry tooling readiness record: ${match[1]}`);
    }
    return { dapPort: parsed.dap_port };
  }, 180_000, "Foundry tooling readiness");
}

async function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function stopHost(host: ChildProcess): Promise<void> {
  if (host.exitCode !== null) return;
  host.kill("SIGTERM");
  const exited = new Promise<void>((resolve) => host.once("exit", () => resolve()));
  await Promise.race([exited, delay(10_000)]);
  if (host.exitCode === null) host.kill("SIGKILL");
}

async function runScene(
  client: DapClient,
  project: string,
  scene: "main" | "res://main.tscn",
): Promise<void> {
  client.clearEvents();
  const launch = client.request("launch", {
    project,
    noDebug: false,
    scene,
    playArgs: ["--foundryscript-smoke", scene],
  });
  const configurationDone = client.request("configurationDone", {});
  const [launchResponse, configurationResponse] = await Promise.all([
    client.response(launch),
    client.response(configurationDone, 30_000),
  ]);
  expect(launchResponse.success, JSON.stringify(launchResponse)).toBe(true);
  expect(configurationResponse.success, JSON.stringify(configurationResponse)).toBe(
    true,
  );
  await client.event("terminated");
  expect(client.lifecycle()).toEqual(["process", "exited", "terminated"]);
  expect(client.exitCode()).toBe(3);
}

describe("FoundryScript live scene debugging", () => {
  liveIt(
    "launches main and explicit scenes with ordered DAP lifecycle events",
    async () => {
      const project = await stageProject();
      const host = spawn(
        enginePath!,
        [
          "tooling",
          "serve",
          "--project",
          project,
          "--lsp-port",
          "0",
          "--dap-port",
          "0",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      host.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      host.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      let socket: Socket | undefined;
      try {
        const readiness = await waitForReadiness(() => output, host);
        socket = await connect(readiness.dapPort);
        const client = new DapClient(socket);
        const initialize = client.request("initialize", {
          adapterID: "foundry",
          linesStartAt1: true,
          columnsStartAt1: true,
          supportsVariableType: true,
        });
        expect((await client.response(initialize, 30_000)).success).toBe(true);
        await client.event("initialized", 30_000);

        await runScene(client, project, "main");
        await runScene(client, project, "res://main.tscn");
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nFoundry output:\n${output}`,
          { cause: error },
        );
      } finally {
        socket?.destroy();
        await stopHost(host);
        await rm(project, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
