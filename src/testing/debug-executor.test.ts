/* eslint-disable @typescript-eslint/require-await -- Promise-returning test doubles mirror VS Code and filesystem APIs. */
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TestExecutionObserver, TestExecutionRequest } from "./executor.js";

type DebugExecutorModule = typeof import("./debug-executor.js");
interface SessionValue {
  readonly id: string;
  configuration: Record<string, unknown>;
}

async function loadModule(): Promise<DebugExecutorModule | undefined> {
  return import("./debug-executor.js").catch(() => undefined);
}

describe("Foundry test debug executor", () => {
  it("builds the exact project_test contract without CLI-only framework args", async () => {
    const module = await loadModule();
    expect(module).toBeDefined();
    const report = path.join(
      path.parse(process.cwd()).root,
      "tmp",
      "foundryscript-test-debug",
      "report.tap",
    );

    expect(
      module?.createFoundryTestDebugConfiguration(
        {
          enginePath: "/opt/foundry",
          project: "/workspace/game",
          runner: "res://tests/runner.fs",
          frameworkArgs: ["--framework-option"],
          protocolVersion: 1,
          leaves: [
            { id: "test-a", skipped: false, skipReason: null },
            { id: "test-b", skipped: true, skipReason: "pending" },
          ],
        },
        report,
      ),
    ).toEqual({
      type: "foundryscript",
      request: "launch",
      name: "Debug Foundry Tests",
      project: "/workspace/game",
      noDebug: false,
      "foundry/launch": {
        kind: "project_test",
        runner: "res://tests/runner.fs",
        adapter: {
          protocolVersion: 1,
          report,
          testIds: ["test-a", "test-b"],
        },
      },
    });
  });

  it("starts one DAP-owned session linked to the TestRun and consumes its TAP", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const reportPath = "/tmp/foundryscript-test-debug-unique/report.tap";
    const session: SessionValue = {
      id: "test-debug-session",
      configuration: projectTestConfiguration(reportPath),
    };
    const startListeners = new Set<(session: SessionValue) => void>();
    const terminateListeners = new Set<(session: SessionValue) => void>();
    const messageListeners = new Set<
      (event: {
        direction: "adapter" | "client";
        session: SessionValue;
        message: unknown;
      }) => void
    >();
    const startDebugging = vi.fn(async (
      configuration: Record<string, unknown>,
      _options: unknown,
    ) => {
      session.configuration = configuration;
      for (const listener of startListeners) listener(session);
      for (const listener of messageListeners) {
        listener({
          direction: "adapter",
          session,
          message: { type: "event", event: "exited", body: { exitCode: 0 } },
        });
      }
      for (const listener of terminateListeners) listener(session);
      return true;
    });
    const removeTemporaryDirectory = vi.fn(async () => undefined);
    const observer: TestExecutionObserver = {
      onPoint: vi.fn(),
      onOutput: vi.fn(),
    };
    const testRun = { name: "linked run" };
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging,
      stopDebugging: vi.fn(async () => undefined),
      onDidStartDebugSession: (listener) => disposableListener(startListeners, listener),
      onDidTerminateDebugSession: (listener) =>
        disposableListener(terminateListeners, listener),
      onDidDebugMessage: (listener) => disposableListener(messageListeners, listener),
      makeTemporaryDirectory: async () => path.dirname(reportPath),
      removeTemporaryDirectory,
      readArtifact: async () => Buffer.from(report(1, point(1, "test-a"))),
    });

    const result = await executor.execute(
      executionRequest(),
      new AbortController().signal,
      observer,
      testRun as never,
    );

    expect(startDebugging).toHaveBeenCalledWith(
      projectTestConfiguration(reportPath),
      { noDebug: false, testRun },
    );
    expect(observer.onPoint).toHaveBeenCalledOnce();
    expect(observer.onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ testId: "test-a", ok: true }),
    );
    expect(result).toMatchObject({
      kind: "completed",
      completion: { valid: true, classification: "conforming" },
      processResult: { kind: "exited", exitCode: 0 },
    });
    expect(removeTemporaryDirectory).toHaveBeenCalledWith(
      path.dirname(reportPath),
    );
  });

  it("waits boundedly for VS Code to publish the matching debug session", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const reportPath = "/tmp/foundryscript-test-debug-delayed/report.tap";
    const session: SessionValue = {
      id: "delayed-session",
      configuration: projectTestConfiguration(reportPath),
    };
    const startListeners = new Set<(session: SessionValue) => void>();
    const terminateListeners = new Set<(session: SessionValue) => void>();
    const messageListeners = new Set<(event: DebugMessageValue) => void>();
    let now = 0;
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging: async (configuration) => {
        session.configuration = configuration;
        return true;
      },
      stopDebugging: vi.fn(async () => undefined),
      onDidStartDebugSession: (listener) => disposableListener(startListeners, listener),
      onDidTerminateDebugSession: (listener) =>
        disposableListener(terminateListeners, listener),
      onDidDebugMessage: (listener) => disposableListener(messageListeners, listener),
      makeTemporaryDirectory: async () => path.dirname(reportPath),
      removeTemporaryDirectory: async () => undefined,
      readArtifact: async () => Buffer.from(report(1, point(1, "test-a"))),
      now: () => now,
      sessionStartTimeoutMs: 100,
      waitForPoll: async () => {
        now += 10;
        for (const listener of startListeners) listener(session);
        for (const listener of messageListeners) {
          listener({
            direction: "adapter",
            session,
            message: { type: "event", event: "exited", body: { exitCode: 0 } },
          });
        }
        for (const listener of terminateListeners) listener(session);
      },
    });

    await expect(
      executor.execute(
        executionRequest(),
        new AbortController().signal,
        { onPoint: vi.fn(), onOutput: vi.fn() },
        {} as never,
      ),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(now).toBe(10);
  });

  it("does not launch a DAP session when the TestRun is already cancelled", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const cancellation = new AbortController();
    cancellation.abort();
    const startDebugging = vi.fn(async () => true);
    const makeTemporaryDirectory = vi.fn(async () => "/tmp/unused");
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging,
      stopDebugging: vi.fn(async () => undefined),
      onDidStartDebugSession: () => ({ dispose: vi.fn() }),
      onDidTerminateDebugSession: () => ({ dispose: vi.fn() }),
      onDidDebugMessage: () => ({ dispose: vi.fn() }),
      makeTemporaryDirectory,
    });

    await expect(
      executor.execute(
        executionRequest(),
        cancellation.signal,
        { onPoint: vi.fn(), onOutput: vi.fn() },
        {} as never,
      ),
    ).resolves.toMatchObject({
      kind: "cancelled",
      completion: { valid: true, classification: "cancelled" },
      processResult: { kind: "cancelled" },
    });
    expect(startDebugging).not.toHaveBeenCalled();
    expect(makeTemporaryDirectory).not.toHaveBeenCalled();
  });

  it("bounds cancellation while VS Code has not published the debug session", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const reportPath = "/tmp/foundryscript-test-debug-unpublished/report.tap";
    const cancellation = new AbortController();
    const removeTemporaryDirectory = vi.fn(async () => undefined);
    let now = 0;
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging: async () => true,
      stopDebugging: vi.fn(async () => undefined),
      onDidStartDebugSession: () => ({ dispose: vi.fn() }),
      onDidTerminateDebugSession: () => ({ dispose: vi.fn() }),
      onDidDebugMessage: () => ({ dispose: vi.fn() }),
      makeTemporaryDirectory: async () => path.dirname(reportPath),
      removeTemporaryDirectory,
      now: () => now,
      sessionStartTimeoutMs: 1_000,
      terminationTimeoutMs: 20,
      waitForPoll: async () => {
        now += 10;
        cancellation.abort();
        if (now > 30) throw new Error("unbounded session publication wait");
      },
    });

    await expect(
      executor.execute(
        executionRequest(),
        cancellation.signal,
        { onPoint: vi.fn(), onOutput: vi.fn() },
        {} as never,
      ),
    ).rejects.toMatchObject({
      kind: "readiness_timeout",
    });
    expect(now).toBe(30);
    expect(removeTemporaryDirectory).not.toHaveBeenCalled();
  });

  it("retains the report directory when a started session is never published", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const reportPath = "/tmp/foundryscript-test-debug-lost/report.tap";
    const removeTemporaryDirectory = vi.fn(async () => undefined);
    let now = 0;
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging: async () => true,
      stopDebugging: vi.fn(async () => undefined),
      onDidStartDebugSession: () => ({ dispose: vi.fn() }),
      onDidTerminateDebugSession: () => ({ dispose: vi.fn() }),
      onDidDebugMessage: () => ({ dispose: vi.fn() }),
      makeTemporaryDirectory: async () => path.dirname(reportPath),
      removeTemporaryDirectory,
      now: () => now,
      sessionStartTimeoutMs: 20,
      waitForPoll: async () => {
        now += 10;
      },
    });

    await expect(
      executor.execute(
        executionRequest(),
        new AbortController().signal,
        { onPoint: vi.fn(), onOutput: vi.fn() },
        {} as never,
      ),
    ).rejects.toMatchObject({
      kind: "readiness_timeout",
    });
    expect(removeTemporaryDirectory).not.toHaveBeenCalled();
  });

  it("streams complete flushed points while the debuggee remains active", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const reportPath = "/tmp/foundryscript-test-debug-stream/report.tap";
    const session: SessionValue = {
      id: "stream-session",
      configuration: projectTestConfiguration(reportPath),
    };
    const startListeners = new Set<(session: SessionValue) => void>();
    const terminateListeners = new Set<(session: SessionValue) => void>();
    const messageListeners = new Set<(event: DebugMessageValue) => void>();
    let artifact = report(1);
    let polls = 0;
    const onPoint = vi.fn();
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging: async (configuration) => {
        session.configuration = configuration;
        for (const listener of startListeners) listener(session);
        return true;
      },
      stopDebugging: vi.fn(async () => undefined),
      onDidStartDebugSession: (listener) => disposableListener(startListeners, listener),
      onDidTerminateDebugSession: (listener) =>
        disposableListener(terminateListeners, listener),
      onDidDebugMessage: (listener) => disposableListener(messageListeners, listener),
      makeTemporaryDirectory: async () => path.dirname(reportPath),
      removeTemporaryDirectory: async () => undefined,
      readArtifact: async () => Buffer.from(artifact),
      waitForPoll: async () => {
        polls += 1;
        if (polls === 1) {
          artifact += point(1, "test-a");
        } else {
          for (const listener of messageListeners) {
            listener({
              direction: "adapter",
              session,
              message: {
                type: "event",
                event: "exited",
                body: { exitCode: 0 },
              },
            });
          }
          for (const listener of terminateListeners) listener(session);
        }
      },
    });

    await expect(
      executor.execute(
        executionRequest(),
        new AbortController().signal,
        { onPoint, onOutput: vi.fn() },
        {} as never,
      ),
    ).resolves.toMatchObject({
      kind: "completed",
      completion: { valid: true, classification: "conforming" },
    });
    expect(onPoint).toHaveBeenCalledOnce();
    expect(polls).toBe(2);
  });

  it("bounds first-report readiness and includes DAP output in the failure", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const reportPath = "/tmp/foundryscript-test-debug-timeout/report.tap";
    const session: SessionValue = {
      id: "timeout-session",
      configuration: projectTestConfiguration(reportPath),
    };
    const startListeners = new Set<(session: SessionValue) => void>();
    const terminateListeners = new Set<(session: SessionValue) => void>();
    const messageListeners = new Set<(event: DebugMessageValue) => void>();
    let now = 0;
    const stopDebugging = vi.fn(async () => {
      for (const listener of terminateListeners) listener(session);
    });
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging: async (configuration) => {
        session.configuration = configuration;
        for (const listener of startListeners) listener(session);
        for (const listener of messageListeners) {
          listener({
            direction: "adapter",
            session,
            message: {
              type: "event",
              event: "output",
              body: { category: "stderr", output: "engine diagnostic\n" },
            },
          });
        }
        return true;
      },
      stopDebugging,
      onDidStartDebugSession: (listener) => disposableListener(startListeners, listener),
      onDidTerminateDebugSession: (listener) =>
        disposableListener(terminateListeners, listener),
      onDidDebugMessage: (listener) => disposableListener(messageListeners, listener),
      makeTemporaryDirectory: async () => path.dirname(reportPath),
      removeTemporaryDirectory: async () => undefined,
      readArtifact: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      now: () => now,
      reportReadinessTimeoutMs: 20,
      waitForPoll: async () => {
        now += 10;
        if (now > 20) throw new Error("unbounded wait");
      },
    });

    await expect(
      executor.execute(
        executionRequest(),
        new AbortController().signal,
        { onPoint: vi.fn(), onOutput: vi.fn() },
        {} as never,
      ),
    ).rejects.toMatchObject({
      kind: "readiness_timeout",
      stderr: "engine diagnostic\n",
    });
    expect(stopDebugging).toHaveBeenCalledWith(session);
  });

  it("includes DAP diagnostics when an engine failure produces no report", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const reportPath = "/tmp/foundryscript-test-debug-engine-failure/report.tap";
    const session: SessionValue = {
      id: "engine-failure-session",
      configuration: projectTestConfiguration(reportPath),
    };
    const startListeners = new Set<(session: SessionValue) => void>();
    const terminateListeners = new Set<(session: SessionValue) => void>();
    const messageListeners = new Set<(event: DebugMessageValue) => void>();
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging: async (configuration) => {
        session.configuration = configuration;
        for (const listener of startListeners) listener(session);
        for (const listener of messageListeners) {
          listener({
            direction: "adapter",
            session,
            message: {
              type: "event",
              event: "output",
              body: { category: "stderr", output: "runner could not start\n" },
            },
          });
          listener({
            direction: "adapter",
            session,
            message: { type: "event", event: "exited", body: { exitCode: 2 } },
          });
        }
        for (const listener of terminateListeners) listener(session);
        return true;
      },
      stopDebugging: vi.fn(async () => undefined),
      onDidStartDebugSession: (listener) => disposableListener(startListeners, listener),
      onDidTerminateDebugSession: (listener) =>
        disposableListener(terminateListeners, listener),
      onDidDebugMessage: (listener) => disposableListener(messageListeners, listener),
      makeTemporaryDirectory: async () => path.dirname(reportPath),
      removeTemporaryDirectory: async () => undefined,
      readArtifact: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });

    await expect(
      executor.execute(
        executionRequest(),
        new AbortController().signal,
        { onPoint: vi.fn(), onOutput: vi.fn() },
        {} as never,
      ),
    ).rejects.toMatchObject({
      kind: "report_read_failed",
      exitCode: 2,
      stderr: "runner could not start\n",
    });
  });

  it("bounds cancellation when the DAP-owned process does not terminate", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const reportPath = "/tmp/foundryscript-test-debug-cancel-timeout/report.tap";
    const session: SessionValue = {
      id: "cancel-timeout-session",
      configuration: projectTestConfiguration(reportPath),
    };
    const startListeners = new Set<(session: SessionValue) => void>();
    const terminateListeners = new Set<(session: SessionValue) => void>();
    const messageListeners = new Set<(event: DebugMessageValue) => void>();
    const cancellation = new AbortController();
    const stopDebugging = vi.fn(async () => undefined);
    let now = 0;
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging: async (configuration) => {
        session.configuration = configuration;
        for (const listener of startListeners) listener(session);
        return true;
      },
      stopDebugging,
      onDidStartDebugSession: (listener) => disposableListener(startListeners, listener),
      onDidTerminateDebugSession: (listener) =>
        disposableListener(terminateListeners, listener),
      onDidDebugMessage: (listener) => disposableListener(messageListeners, listener),
      makeTemporaryDirectory: async () => path.dirname(reportPath),
      removeTemporaryDirectory: async () => undefined,
      readArtifact: async () => Buffer.from(report(2, point(1, "test-a"))),
      now: () => now,
      terminationTimeoutMs: 20,
      waitForPoll: async () => {
        now += 10;
        if (now === 10) cancellation.abort();
        if (now > 30) throw new Error("unbounded cancellation");
      },
    });

    await expect(
      executor.execute(
        executionRequest(["test-a", "test-b"]),
        cancellation.signal,
        { onPoint: vi.fn(), onOutput: vi.fn() },
        {} as never,
      ),
    ).rejects.toMatchObject({ kind: "readiness_timeout" });
    expect(stopDebugging).toHaveBeenCalledWith(session);
  });

  it("stops the DAP session and preserves complete TAP points on cancellation", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const reportPath = "/tmp/foundryscript-test-debug-cancel/report.tap";
    const session: SessionValue = {
      id: "cancel-session",
      configuration: projectTestConfiguration(reportPath, ["test-a", "test-b"]),
    };
    const startListeners = new Set<(session: SessionValue) => void>();
    const terminateListeners = new Set<(session: SessionValue) => void>();
    const messageListeners = new Set<(event: DebugMessageValue) => void>();
    const cancellation = new AbortController();
    const stopDebugging = vi.fn(async () => {
      for (const listener of terminateListeners) listener(session);
    });
    const onPoint = vi.fn();
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging: async (configuration) => {
        session.configuration = configuration;
        for (const listener of startListeners) listener(session);
        return true;
      },
      stopDebugging,
      onDidStartDebugSession: (listener) => disposableListener(startListeners, listener),
      onDidTerminateDebugSession: (listener) =>
        disposableListener(terminateListeners, listener),
      onDidDebugMessage: (listener) => disposableListener(messageListeners, listener),
      makeTemporaryDirectory: async () => path.dirname(reportPath),
      removeTemporaryDirectory: async () => undefined,
      readArtifact: async () => Buffer.from(report(2, point(1, "test-a"))),
      waitForPoll: async () => cancellation.abort(),
    });

    await expect(
      executor.execute(
        executionRequest(["test-a", "test-b"]),
        cancellation.signal,
        { onPoint, onOutput: vi.fn() },
        {} as never,
      ),
    ).resolves.toMatchObject({
      kind: "cancelled",
      completion: {
        valid: true,
        complete: false,
        classification: "cancelled",
      },
      processResult: { kind: "cancelled" },
    });
    expect(onPoint).toHaveBeenCalledOnce();
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ testId: "test-a" }),
    );
    expect(stopDebugging).toHaveBeenCalledWith(session);
  });

  it("resets TAP consumption on restart without publishing duplicate results", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const reportPath = "/tmp/foundryscript-test-debug-restart/report.tap";
    const session: SessionValue = {
      id: "restart-session",
      configuration: projectTestConfiguration(reportPath, ["test-a", "test-b"]),
    };
    const startListeners = new Set<(session: SessionValue) => void>();
    const terminateListeners = new Set<(session: SessionValue) => void>();
    const messageListeners = new Set<(event: DebugMessageValue) => void>();
    let artifact = report(2, point(1, "test-a"));
    let polls = 0;
    const onPoint = vi.fn();
    const send = (direction: "adapter" | "client", message: unknown): void => {
      for (const listener of messageListeners) {
        listener({ direction, session, message });
      }
    };
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging: async (configuration) => {
        session.configuration = configuration;
        for (const listener of startListeners) listener(session);
        send("adapter", { type: "event", event: "process", body: {} });
        return true;
      },
      stopDebugging: vi.fn(async () => undefined),
      onDidStartDebugSession: (listener) => disposableListener(startListeners, listener),
      onDidTerminateDebugSession: (listener) =>
        disposableListener(terminateListeners, listener),
      onDidDebugMessage: (listener) => disposableListener(messageListeners, listener),
      makeTemporaryDirectory: async () => path.dirname(reportPath),
      removeTemporaryDirectory: async () => undefined,
      readArtifact: async () => Buffer.from(artifact),
      waitForPoll: async () => {
        polls += 1;
        if (polls === 1) {
          send("client", { type: "request", command: "restart" });
          artifact = report(2);
          send("adapter", { type: "event", event: "process", body: {} });
        } else if (polls === 2) {
          artifact = report(2, point(1, "test-a"), point(2, "test-b"));
        } else {
          send("adapter", {
            type: "event",
            event: "exited",
            body: { exitCode: 0 },
          });
          for (const listener of terminateListeners) listener(session);
        }
      },
    });

    await expect(
      executor.execute(
        executionRequest(["test-a", "test-b"]),
        new AbortController().signal,
        { onPoint, onOutput: vi.fn() },
        {} as never,
      ),
    ).resolves.toMatchObject({
      kind: "completed",
      completion: { valid: true, classification: "conforming" },
    });
    const publishedIds = onPoint.mock.calls.map(
      ([value]) => (value as { testId: string }).testId,
    );
    expect(publishedIds).toEqual([
      "test-a",
      "test-b",
    ]);
  });

  it("starts a fresh report-readiness window for a late restart", async () => {
    const module = await loadModule();
    expect(module?.FoundryTestDebugExecutor).toBeDefined();
    const reportPath = "/tmp/foundryscript-test-debug-late-restart/report.tap";
    const session: SessionValue = {
      id: "late-restart-session",
      configuration: projectTestConfiguration(reportPath),
    };
    const startListeners = new Set<(session: SessionValue) => void>();
    const terminateListeners = new Set<(session: SessionValue) => void>();
    const messageListeners = new Set<(event: DebugMessageValue) => void>();
    let artifact = report(1);
    let polls = 0;
    let now = 0;
    const send = (direction: "adapter" | "client", message: unknown): void => {
      for (const listener of messageListeners) {
        listener({ direction, session, message });
      }
    };
    const executor = new module!.FoundryTestDebugExecutor({
      startDebugging: async (configuration) => {
        session.configuration = configuration;
        for (const listener of startListeners) listener(session);
        send("adapter", { type: "event", event: "process", body: {} });
        return true;
      },
      stopDebugging: vi.fn(async () => undefined),
      onDidStartDebugSession: (listener) => disposableListener(startListeners, listener),
      onDidTerminateDebugSession: (listener) =>
        disposableListener(terminateListeners, listener),
      onDidDebugMessage: (listener) => disposableListener(messageListeners, listener),
      makeTemporaryDirectory: async () => path.dirname(reportPath),
      removeTemporaryDirectory: async () => undefined,
      readArtifact: async () => Buffer.from(artifact),
      now: () => now,
      reportReadinessTimeoutMs: 30_000,
      waitForPoll: async () => {
        polls += 1;
        if (polls === 1) {
          now = 40_000;
          send("client", { type: "request", command: "restart" });
          artifact = "";
          send("adapter", { type: "event", event: "process", body: {} });
        } else if (polls === 2) {
          now = 40_010;
          artifact = report(1, point(1, "test-a"));
        } else {
          send("adapter", {
            type: "event",
            event: "exited",
            body: { exitCode: 0 },
          });
          for (const listener of terminateListeners) listener(session);
        }
      },
    });

    await expect(
      executor.execute(
        executionRequest(),
        new AbortController().signal,
        { onPoint: vi.fn(), onOutput: vi.fn() },
        {} as never,
      ),
    ).resolves.toMatchObject({
      kind: "completed",
      completion: { valid: true, classification: "conforming" },
    });
  });
});

interface DebugMessageValue {
  readonly direction: "adapter" | "client";
  readonly session: SessionValue;
  readonly message: unknown;
}

function executionRequest(ids: readonly string[] = ["test-a"]): TestExecutionRequest {
  return {
    enginePath: "/opt/foundry",
    project: "/workspace/game",
    runner: "res://tests/runner.fs",
    frameworkArgs: [],
    protocolVersion: 1,
    leaves: ids.map((id) => ({ id, skipped: false, skipReason: null })),
  };
}

function projectTestConfiguration(
  reportPath: string,
  ids: readonly string[] = ["test-a"],
): Record<string, unknown> {
  return {
    type: "foundryscript",
    request: "launch",
    name: "Debug Foundry Tests",
    project: "/workspace/game",
    noDebug: false,
    "foundry/launch": {
      kind: "project_test",
      runner: "res://tests/runner.fs",
      adapter: {
        protocolVersion: 1,
        report: reportPath,
        testIds: [...ids],
      },
    },
  };
}

function disposableListener<T>(listeners: Set<T>, listener: T): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

function report(plan: number, ...points: string[]): string {
  return `TAP version 13\n# foundry-test-adapter: 1\n1..${String(plan)}\n${points.join("")}`;
}

function point(number: number, id: string): string {
  return (
    `ok ${String(number)} - ${id}\n` +
    "  ---\n" +
    "  _foundry:\n" +
    `    id: ${id}\n` +
    "    duration_ms: 1\n" +
    '    status_detail: ""\n' +
    "  ...\n"
  );
}
