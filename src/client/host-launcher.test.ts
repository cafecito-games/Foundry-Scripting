import { EventEmitter, once } from "node:events";
import * as net from "node:net";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildToolingHostCommand,
  FoundryHostLauncher,
  HostStartupFailure,
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

const validReadiness = {
  project: "/workspace/game",
  pid: 99,
  local_only: true,
  services: ["lsp", "dap"],
  lsp_port: 49152,
  dap_port: 49153,
};

const toolingErrors = [
  {
    error: "bind_failed",
    service: "dap",
    requested_port: 6006,
    message: "port busy",
    expectedKind: "port_conflict",
  },
  {
    error: "invalid_project",
    reason: "missing_project_file",
    project: "/workspace/game",
    message:
      "Project directory does not contain project.foundry: /workspace/game",
    expectedKind: "invalid_project",
  },
  {
    error: "service_unavailable",
    service: "lsp",
    message: "language service unavailable",
    expectedKind: "spawn_failed",
  },
] as const;

const structuredErrorCases = (["stdout", "stderr"] as const).flatMap(
  (stream) => toolingErrors.map((record) => ({ stream, record })),
);

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

  it("parses a valid combined tooling-host readiness record", () => {
    expect(
      parseToolingReadinessLine(
        `FOUNDRY_TOOLING ${JSON.stringify(validReadiness)}`,
        "/workspace/game",
      ),
    ).toEqual({
      project: "/workspace/game",
      pid: 99,
      localOnly: true,
      services: ["lsp", "dap"],
      lspPort: 49152,
      dapPort: 49153,
    });
  });

  it.each([
    ["wrong marker", `OTHER ${JSON.stringify(validReadiness)}`],
    ["malformed JSON", "FOUNDRY_TOOLING {"],
    [
      "wrong project",
      `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, project: "/workspace/other" })}`,
    ],
    [
      "zero PID",
      `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, pid: 0 })}`,
    ],
    [
      "remote contract",
      `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, local_only: false })}`,
    ],
    [
      "missing DAP service",
      `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, services: ["lsp"] })}`,
    ],
    [
      "missing DAP port",
      `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, dap_port: undefined })}`,
    ],
    [
      "invalid LSP port",
      `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, lsp_port: 0 })}`,
    ],
    [
      "invalid DAP port",
      `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, dap_port: 65536 })}`,
    ],
    [
      "identical ports",
      `FOUNDRY_TOOLING ${JSON.stringify({ ...validReadiness, dap_port: 49152 })}`,
    ],
  ])("rejects %s readiness", (_name, line) => {
    expect(
      parseToolingReadinessLine(line, "/workspace/game"),
    ).toBeUndefined();
  });

  it.each(["complete", "split"] as const)(
    "starts only after a %s combined readiness record",
    async (delivery) => {
      const child = new FakeChildProcess();
      const spawnProcess = vi.fn(() => {
        queueMicrotask(() => {
          const line = `FOUNDRY_TOOLING ${JSON.stringify(validReadiness)}\n`;
          if (delivery === "split") {
            child.stdout.write(line.slice(0, 17));
            child.stdout.write(line.slice(17));
          } else {
            child.stdout.write(line);
          }
        });
        return child.asChildProcess();
      });
      const launcher = new FoundryHostLauncher({
        spawnProcess,
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
          "tooling",
          "serve",
          "--project",
          "/workspace/game",
          "--lsp-port",
          "0",
          "--dap-port",
          "0",
        ],
        expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
      );
      expect(host.readiness).toEqual({
        project: "/workspace/game",
        pid: 99,
        localOnly: true,
        services: ["lsp", "dap"],
        lspPort: 49152,
        dapPort: 49153,
      });

      await host.stop();
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    },
  );

  it("exposes owned-process exit without coupling it to an LSP client", async () => {
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.write(
            `FOUNDRY_TOOLING ${JSON.stringify(validReadiness)}\n`,
          );
        });
        return child.asChildProcess();
      },
      inactivityTimeoutMs: 100,
      absoluteTimeoutMs: 200,
      pollIntervalMs: 5,
    });
    const host = await launcher.launch({
      enginePath: "/opt/foundry",
      project: "/workspace/game",
    });
    const onExit = vi.fn();
    const subscription = host.onExit(onExit);

    child.exitCode = 17;
    child.emit("exit", 17, null);
    expect(onExit).toHaveBeenCalledWith(17);

    subscription.dispose();
    child.emit("exit", 18, null);
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("does not accept an open TCP listener without a readiness record", async () => {
    const server = net.createServer();
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
      spawnProcess: () => child.asChildProcess(),
      inactivityTimeoutMs: 20,
      absoluteTimeoutMs: 100,
      pollIntervalMs: 5,
    });

    await expect(
      launcher.launch({ enginePath: "foundry", project: "/workspace/game" }),
    ).rejects.toMatchObject({ kind: "readiness_timeout" });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("turns a missing executable into an actionable startup failure", async () => {
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
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
    });
    expect((failure as Error).message).toContain("foundryScript.enginePath");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("turns a synchronously rejected engine path into the same actionable failure", async () => {
    const launcher = new FoundryHostLauncher({
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
    });
  });

  it("treats a non-executable engine path as an engine setting failure", async () => {
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
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
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("reports a non-path spawn error without inventing an exit code", async () => {
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
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
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("distinguishes process exit before readiness", async () => {
    const child = new FakeChildProcess();
    const launcher = new FoundryHostLauncher({
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
      exitCode: 23,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("distinguishes a bind conflict from a generic readiness timeout", async () => {
    const conflictChild = new FakeChildProcess();
    const timeoutChild = new FakeChildProcess();
    const conflictLauncher = new FoundryHostLauncher({
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
    ).rejects.toMatchObject({ kind: "port_conflict" });
    expect(conflictChild.kill).toHaveBeenCalledOnce();
    await expect(
      timeoutLauncher.launch({
        enginePath: "foundry",
        project: "/workspace/game",
      }),
    ).rejects.toMatchObject({ kind: "readiness_timeout" });
  });

  it.each(structuredErrorCases)(
    "classifies $record.error tooling errors from $stream",
    async ({ stream, record }) => {
      const child = new FakeChildProcess();
      const output = { appendLine: vi.fn() };
      const launcher = new FoundryHostLauncher({
        spawnProcess: () => {
          queueMicrotask(() => {
            child[stream].write(
              `FOUNDRY_TOOLING_ERROR ${JSON.stringify({ error: record.error, message: record.message })}\n`,
            );
            child[stream].write(`${record.error} tail`);
          });
          return child.asChildProcess();
        },
        output,
        inactivityTimeoutMs: 20,
        absoluteTimeoutMs: 100,
        pollIntervalMs: 5,
      });

      const failure = await launcher
        .launch({ enginePath: "foundry", project: "/workspace/game" })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ kind: record.expectedKind });
      expect((failure as Error).message).toContain(record.message);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      const outputRecords = output.appendLine.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      );
      expect(
        outputRecords.filter(
          (outputRecord) => outputRecord.message === `${record.error} tail`,
        ),
      ).toHaveLength(1);
    },
  );

  it("keeps a structured failure when the child subsequently exits", async () => {
    const child = new FakeChildProcess();
    const record = toolingErrors[1];
    const launcher = new FoundryHostLauncher({
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.write(
            `FOUNDRY_TOOLING_ERROR ${JSON.stringify({ error: record.error, message: record.message })}\n`,
          );
          child.exitCode = 23;
          child.emit("exit", 23, null);
        });
        return child.asChildProcess();
      },
      inactivityTimeoutMs: 20,
      absoluteTimeoutMs: 100,
      pollIntervalMs: 5,
    });

    const failure = await launcher
      .launch({ enginePath: "foundry", project: "/workspace/game" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind: "invalid_project" });
    expect((failure as Error).message).toContain(record.message);
  });

  it("terminates a child after malformed readiness times out", async () => {
    const child = new FakeChildProcess();
    const output = { appendLine: vi.fn() };
    const launcher = new FoundryHostLauncher({
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.write("FOUNDRY_TOOLING {\n");
          child.stdout.write("malformed tail");
        });
        return child.asChildProcess();
      },
      output,
      inactivityTimeoutMs: 20,
      absoluteTimeoutMs: 100,
      pollIntervalMs: 5,
    });

    await expect(
      launcher.launch({ enginePath: "foundry", project: "/workspace/game" }),
    ).rejects.toMatchObject({ kind: "readiness_timeout" });
    expect(child.kill).toHaveBeenCalledOnce();
    const outputRecords = output.appendLine.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(
      outputRecords.filter(
        (outputRecord) => outputRecord.message === "malformed tail",
      ),
    ).toHaveLength(1);
  });

  it("reports inactivity when a silent host does not become ready", async () => {
    const child = new FakeChildProcess();
    const output = { appendLine: vi.fn() };
    const launcher = new FoundryHostLauncher({
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
    expect(child.kill).toHaveBeenCalledOnce();
    const records = output.appendLine.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          event: "lsp.host.timeout",
          project: "/workspace/game",
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
        spawnProcess: () => {
          setTimeout(() => child[stream].write("still importing"), 10);
          if (stream === "stdout") {
            setTimeout(() => child.stdout.write("\n"), 15);
          }
          setTimeout(() => {
            child.stdout.write(
              'FOUNDRY_TOOLING {"project":"/workspace/game","pid":4321,"local_only":true,"services":["lsp","dap"],"lsp_port":50100,"dap_port":50101}\n',
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
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("logs complete startup lines and flushes unterminated tails once", async () => {
    const child = new FakeChildProcess();
    const output = { appendLine: vi.fn() };
    const launcher = new FoundryHostLauncher({
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.write("scan started\nscan complete\n");
          child.stderr.write("warning tail");
          child.stdout.write(
            'FOUNDRY_TOOLING {"project":"/workspace/game","pid":4321,"local_only":true,"services":["lsp","dap"],"lsp_port":50100,"dap_port":50101}\n',
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
    const output = { appendLine: vi.fn() };
    const launcher = new FoundryHostLauncher({
      spawnProcess: () => child.asChildProcess(),
      output,
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
    child.stderr.write("cancel tail");
    controller.abort();

    await expect(launching).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    const outputRecords = output.appendLine.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(
      outputRecords.filter(
        (outputRecord) => outputRecord.message === "cancel tail",
      ),
    ).toHaveLength(1);
  });
});
