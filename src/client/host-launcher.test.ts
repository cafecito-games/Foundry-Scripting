import { EventEmitter, once } from "node:events";
import * as net from "node:net";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildToolingHostCommand,
  FoundryHostLauncher,
  HostStartupFailure,
  allocateLoopbackPort,
  parseToolingReadinessLine,
} from "./host-launcher.js";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4321;
  exitCode: number | null = null;
  readonly kill = vi.fn((signal?: NodeJS.Signals | number) => {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, signal ?? null));
    return true;
  });

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

describe("host launch abstraction", () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    servers.length = 0;
  });

  it("builds the canonical combined tooling-host invocation", () => {
    expect(
      buildToolingHostCommand({
        enginePath: "/opt/foundry",
        project: "/workspace/game",
      }),
    ).toEqual({
      command: "/opt/foundry",
      args: [
        "tooling",
        "serve",
        "--project",
        "/workspace/game",
        "--lsp-port",
        "0",
        "--dap-port",
        "0",
      ],
    });
  });

  it("parses the future combined tooling-host readiness record", () => {
    expect(
      parseToolingReadinessLine(
        'FOUNDRY_TOOLING {"project":"/workspace/game","pid":99,"local_only":true,"services":["lsp","dap"],"lsp_port":49152,"dap_port":49153}',
      ),
    ).toEqual({
      project: "/workspace/game",
      pid: 99,
      localOnly: true,
      services: ["lsp", "dap"],
      lspPort: 49152,
      dapPort: 49153,
    });
    expect(parseToolingReadinessLine("ordinary log output")).toBeUndefined();
    expect(
      parseToolingReadinessLine(
        'FOUNDRY_TOOLING {"project":"/workspace/game","pid":99,"local_only":true,"services":["dap"],"lsp_port":49152,"dap_port":49153}',
      ),
    ).toBeUndefined();
  });

  it("allocates and releases a loopback ephemeral port", async () => {
    const port = await allocateLoopbackPort();
    const server = net.createServer();
    servers.push(server);

    server.listen(port, "127.0.0.1");
    await once(server, "listening");

    expect(server.address()).toMatchObject({ port });
  });

  it("waits for TCP readiness and returns one owned host", async () => {
    const server = net.createServer();
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP address");
    }
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child.asChildProcess());
    const output = { appendLine: vi.fn() };
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(address.port),
      spawnProcess,
      output,
      inactivityTimeoutMs: 100,
      absoluteTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    const host = await launcher.launch({
      enginePath: "/opt/foundry",
      project: "/workspace/game",
    });

    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/foundry",
      [
        "lsp",
        "serve",
        "--port",
        String(address.port),
        "--project",
        "/workspace/game",
      ],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(host.readiness).toMatchObject({
      project: "/workspace/game",
      pid: 4321,
      localOnly: true,
      services: ["lsp"],
      lspPort: address.port,
    });
    const records: unknown[] = output.appendLine.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as unknown,
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "lsp.host.launching",
          project: "/workspace/game",
          port: address.port,
        }),
        expect.objectContaining({
          event: "lsp.host.ready",
          project: "/workspace/game",
          port: address.port,
        }),
      ]),
    );

    await host.stop();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses a future readiness record without changing connection orchestration", async () => {
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49152),
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.write(
            'FOUNDRY_TOOLING {"project":"/canonical/game","pid":4321,"local_only":true,"services":["lsp","dap"],"lsp_port":50100,"dap_port":50101}\n',
          );
        });
        return child.asChildProcess();
      },
      inactivityTimeoutMs: 100,
      absoluteTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    const host = await launcher.launch({
      enginePath: "foundry",
      project: "/workspace/game",
    });

    expect(host.readiness).toMatchObject({
      project: "/canonical/game",
      services: ["lsp", "dap"],
      lspPort: 50100,
      dapPort: 50101,
    });
  });

  it("turns a missing executable into an actionable startup failure", async () => {
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49152),
      spawnProcess: () => {
        queueMicrotask(() => {
          child.emit(
            "error",
            Object.assign(new Error("spawn /missing/foundry ENOENT"), {
              code: "ENOENT",
            }),
          );
        });
        return child.asChildProcess();
      },
      inactivityTimeoutMs: 100,
      absoluteTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    const failure = await launcher
      .launch({ enginePath: "/missing/foundry", project: "/workspace/game" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HostStartupFailure);
    expect(failure).toMatchObject({
      kind: "missing_engine",
      enginePath: "/missing/foundry",
      project: "/workspace/game",
      port: 49152,
    });
    expect((failure as Error).message).toContain("foundryScript.enginePath");
  });

  it("turns a synchronously rejected engine path into the same actionable failure", async () => {
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49152),
      spawnProcess: () => {
        throw Object.assign(new Error("The argument 'file' cannot be empty"), {
          code: "ERR_INVALID_ARG_VALUE",
        });
      },
      inactivityTimeoutMs: 100,
      absoluteTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    await expect(
      launcher.launch({ enginePath: "", project: "/workspace/game" }),
    ).rejects.toMatchObject({
      kind: "missing_engine",
      enginePath: "",
      project: "/workspace/game",
      port: 49152,
    });
  });

  it("treats a non-executable engine path as an engine setting failure", async () => {
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49152),
      spawnProcess: () => {
        queueMicrotask(() => {
          child.emit(
            "error",
            Object.assign(new Error("spawn /opt/foundry EACCES"), {
              code: "EACCES",
            }),
          );
        });
        return child.asChildProcess();
      },
      inactivityTimeoutMs: 100,
      absoluteTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    await expect(
      launcher.launch({
        enginePath: "/opt/foundry",
        project: "/workspace/game",
      }),
    ).rejects.toMatchObject({ kind: "missing_engine" });
  });

  it("reports a non-path spawn error without inventing an exit code", async () => {
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49152),
      spawnProcess: () => {
        queueMicrotask(() => {
          child.emit(
            "error",
            Object.assign(new Error("spawn foundry EMFILE"), { code: "EMFILE" }),
          );
        });
        return child.asChildProcess();
      },
      inactivityTimeoutMs: 100,
      absoluteTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    const failure = await launcher
      .launch({ enginePath: "foundry", project: "/workspace/game" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind: "spawn_failed" });
    expect((failure as Error).message).toContain("EMFILE");
    expect((failure as Error).message).not.toContain("undefined");
  });

  it("distinguishes process exit before readiness", async () => {
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49152),
      spawnProcess: () => {
        queueMicrotask(() => {
          child.exitCode = 23;
          child.emit("exit", 23, null);
        });
        return child.asChildProcess();
      },
      inactivityTimeoutMs: 100,
      absoluteTimeoutMs: 200,
      pollIntervalMs: 5,
    });

    await expect(
      launcher.launch({ enginePath: "foundry", project: "/workspace/game" }),
    ).rejects.toMatchObject({
      kind: "process_exit",
      project: "/workspace/game",
      port: 49152,
      exitCode: 23,
    });
  });

  it("distinguishes a bind conflict from a generic readiness timeout", async () => {
    const conflictChild = new FakeChildProcess();
    const timeoutChild = new FakeChildProcess();
    const conflictLauncher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49152),
      spawnProcess: () => {
        queueMicrotask(() =>
          conflictChild.stderr.write("bind failed: Address already in use\n"),
        );
        return conflictChild.asChildProcess();
      },
      inactivityTimeoutMs: 20,
      absoluteTimeoutMs: 100,
      pollIntervalMs: 5,
    });
    const timeoutLauncher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49153),
      spawnProcess: () => timeoutChild.asChildProcess(),
      inactivityTimeoutMs: 20,
      absoluteTimeoutMs: 100,
      pollIntervalMs: 5,
    });

    await expect(
      conflictLauncher.launch({
        enginePath: "foundry",
        project: "/workspace/game",
      }),
    ).rejects.toMatchObject({ kind: "port_conflict", port: 49152 });
    await expect(
      timeoutLauncher.launch({
        enginePath: "foundry",
        project: "/workspace/game",
      }),
    ).rejects.toMatchObject({ kind: "readiness_timeout", port: 49153 });
  });

  it("reports inactivity when a silent host does not become ready", async () => {
    const child = new FakeChildProcess();
    const output = { appendLine: vi.fn() };
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49153),
      spawnProcess: () => child.asChildProcess(),
      output,
      inactivityTimeoutMs: 20,
      absoluteTimeoutMs: 100,
      pollIntervalMs: 5,
    });

    const failure = await launcher
      .launch({ enginePath: "foundry", project: "/workspace/game" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      kind: "readiness_timeout",
      timeoutReason: "inactivity",
      timeoutMs: 20,
    });
    expect((failure as Error).message).toContain(
      "produced no startup output for 20 milliseconds",
    );
    const records = output.appendLine.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          event: "lsp.host.timeout",
          project: "/workspace/game",
          port: 49153,
          reason: "inactivity",
          timeoutMs: 20,
        }),
      ]),
    );
  });

  it.each(["stdout", "stderr"] as const)(
    "extends the inactivity window when %s output arrives",
    async (stream) => {
      const child = new FakeChildProcess();
      const launcher = new FoundryHostLauncher({
        allocatePort: () => Promise.resolve(49154),
        spawnProcess: () => {
          setTimeout(() => child[stream].write("still importing"), 10);
          if (stream === "stdout") {
            setTimeout(() => child.stdout.write("\n"), 15);
          }
          setTimeout(() => {
            child.stdout.write(
              'FOUNDRY_TOOLING {"project":"/workspace/game","pid":4321,"local_only":true,"services":["lsp"],"lsp_port":50100}\n',
            );
          }, 25);
          return child.asChildProcess();
        },
        inactivityTimeoutMs: 20,
        absoluteTimeoutMs: 100,
        pollIntervalMs: 5,
      });

      const host = await launcher.launch({
        enginePath: "foundry",
        project: "/workspace/game",
      });

      expect(host.readiness.lspPort).toBe(50100);
      await host.stop();
    },
  );

  it("enforces the absolute limit while output continues", async () => {
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49155),
      spawnProcess: () => {
        const activity = setInterval(() => child.stdout.write("working\n"), 5);
        child.once("exit", () => clearInterval(activity));
        return child.asChildProcess();
      },
      inactivityTimeoutMs: 20,
      absoluteTimeoutMs: 40,
      pollIntervalMs: 5,
    });

    const failure = await launcher
      .launch({ enginePath: "foundry", project: "/workspace/game" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      kind: "readiness_timeout",
      timeoutReason: "absolute",
      timeoutMs: 40,
    });
    expect((failure as Error).message).toContain(
      "did not become ready within 40 milliseconds",
    );
  });

  it("logs complete startup lines and flushes unterminated tails once", async () => {
    const child = new FakeChildProcess();
    const output = { appendLine: vi.fn() };
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49156),
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.write("scan started\nscan complete\n");
          child.stderr.write("warning tail");
          child.stdout.write(
            'FOUNDRY_TOOLING {"project":"/workspace/game","pid":4321,"local_only":true,"services":["lsp"],"lsp_port":50100}\n',
          );
        });
        return child.asChildProcess();
      },
      output,
      inactivityTimeoutMs: 50,
      absoluteTimeoutMs: 100,
      pollIntervalMs: 5,
    });

    const host = await launcher.launch({
      enginePath: "foundry",
      project: "/workspace/game",
    });
    await host.stop();

    const records = output.appendLine.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "lsp.host.output",
          stream: "stdout",
          message: "scan started",
        }),
        expect.objectContaining({
          event: "lsp.host.output",
          stream: "stdout",
          message: "scan complete",
        }),
        expect.objectContaining({
          event: "lsp.host.output",
          stream: "stderr",
          message: "warning tail",
        }),
      ]),
    );
    expect(
      records.filter((record) => record.message === "warning tail"),
    ).toHaveLength(1);
  });

  it("flushes an unterminated tail when startup exits", async () => {
    const child = new FakeChildProcess();
    const output = { appendLine: vi.fn() };
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49157),
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stderr.write("fatal tail");
          child.exitCode = 23;
          child.emit("exit", 23, null);
        });
        return child.asChildProcess();
      },
      output,
      inactivityTimeoutMs: 50,
      absoluteTimeoutMs: 100,
      pollIntervalMs: 5,
    });

    await expect(
      launcher.launch({ enginePath: "foundry", project: "/workspace/game" }),
    ).rejects.toMatchObject({ kind: "process_exit", exitCode: 23 });

    const records = output.appendLine.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "lsp.host.output",
          stream: "stderr",
          message: "fatal tail",
        }),
      ]),
    );
  });

  it("terminates a child when startup is aborted during readiness", async () => {
    const child = new FakeChildProcess();
    const controller = new AbortController();
    const launcher = new FoundryHostLauncher({
      allocatePort: () => Promise.resolve(49152),
      spawnProcess: () => child.asChildProcess(),
      inactivityTimeoutMs: 50,
      absoluteTimeoutMs: 100,
      pollIntervalMs: 5,
    });

    const launching = launcher.launch({
      enginePath: "foundry",
      project: "/workspace/game",
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(launching).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
