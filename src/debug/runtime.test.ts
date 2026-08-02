import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ProjectResolution } from "../project/resolver.js";
import {
  ToolingHostCoordinator,
  type OwnedToolingHost,
} from "../tooling/coordinator.js";

const runtimeMock = vi.hoisted(() => ({
  registerDebugConfigurationProvider: vi.fn(),
  registerDebugAdapterDescriptorFactory: vi.fn(),
  registerDebugAdapterTrackerFactory: vi.fn(),
  onDidTerminateDebugSession: vi.fn(),
  showErrorMessage: vi.fn(),
  configurationDisposable: { dispose: vi.fn() },
  descriptorDisposable: { dispose: vi.fn() },
  trackerDisposable: { dispose: vi.fn() },
  terminationDisposable: { dispose: vi.fn() },
  debugAdapterServerFailure: undefined as Error | undefined,
}));

vi.mock("vscode", () => ({
  DebugAdapterServer: class {
    constructor(
      readonly port: number,
      readonly host?: string,
    ) {
      if (runtimeMock.debugAdapterServerFailure !== undefined) {
        throw runtimeMock.debugAdapterServerFailure;
      }
    }
  },
  debug: {
    registerDebugConfigurationProvider:
      runtimeMock.registerDebugConfigurationProvider,
    registerDebugAdapterDescriptorFactory:
      runtimeMock.registerDebugAdapterDescriptorFactory,
    registerDebugAdapterTrackerFactory:
      runtimeMock.registerDebugAdapterTrackerFactory,
    onDidTerminateDebugSession: runtimeMock.onDidTerminateDebugSession,
  },
  window: {
    showErrorMessage: runtimeMock.showErrorMessage,
  },
}));

type RuntimeModule = typeof import("./runtime.js");

async function loadRuntimeModule(): Promise<RuntimeModule | undefined> {
  return import("./runtime.js").catch(() => undefined);
}

function createSession(id: string): vscode.DebugSession {
  return {
    id,
    name: "Debug Forest",
    type: "foundryscript",
    configuration: {
      type: "foundryscript",
      request: "launch",
      name: "Debug Forest",
      project: "/workspace/game",
      scene: "res://levels/forest.tscn",
      playArgs: ["--seed", "42"],
      noDebug: false,
    },
  } as unknown as vscode.DebugSession;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

function createOwnedHost(dapPort: number): OwnedToolingHost {
  return {
    readiness: {
      project: "/workspace/game",
      pid: 4321,
      localOnly: true,
      services: ["lsp", "dap"],
      lspPort: dapPort - 1,
      dapPort,
    },
    stop: vi.fn().mockResolvedValue(undefined),
    onExit: () => ({ dispose: vi.fn() }),
  };
}

describe("FoundryScript debug runtime registration", () => {
  const resolveProject = vi.fn<() => Promise<ProjectResolution>>();

  beforeEach(() => {
    resolveProject.mockReset();
    resolveProject.mockResolvedValue({
      success: true,
      project: "/workspace/game",
    });
    runtimeMock.registerDebugConfigurationProvider.mockReset();
    runtimeMock.registerDebugConfigurationProvider.mockReturnValue(
      runtimeMock.configurationDisposable,
    );
    runtimeMock.registerDebugAdapterDescriptorFactory.mockReset();
    runtimeMock.registerDebugAdapterDescriptorFactory.mockReturnValue(
      runtimeMock.descriptorDisposable,
    );
    runtimeMock.registerDebugAdapterTrackerFactory.mockReset();
    runtimeMock.registerDebugAdapterTrackerFactory.mockReturnValue(
      runtimeMock.trackerDisposable,
    );
    runtimeMock.onDidTerminateDebugSession.mockReset();
    runtimeMock.onDidTerminateDebugSession.mockReturnValue(
      runtimeMock.terminationDisposable,
    );
    runtimeMock.showErrorMessage.mockReset();
    runtimeMock.configurationDisposable.dispose.mockReset();
    runtimeMock.descriptorDisposable.dispose.mockReset();
    runtimeMock.trackerDisposable.dispose.mockReset();
    runtimeMock.terminationDisposable.dispose.mockReset();
    runtimeMock.debugAdapterServerFailure = undefined;
  });

  it("registers one configuration provider, descriptor factory, tracker, and termination listener with owned disposal", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const appendLine = vi.fn();
    const output = { appendLine } as unknown as vscode.OutputChannel;

    runtime!.registerFoundryScriptDebugRuntime(
      context,
      {
        resolveProject,
        getCoordinator: () => undefined,
        getMode: () => "off",
        output,
      },
    );

    expect(
      runtimeMock.registerDebugConfigurationProvider,
    ).toHaveBeenCalledOnce();
    expect(
      runtimeMock.registerDebugConfigurationProvider,
    ).toHaveBeenCalledWith("foundryscript", expect.any(Object));
    expect(runtimeMock.registerDebugAdapterDescriptorFactory).toHaveBeenCalledWith(
      "foundryscript",
      expect.any(Object),
    );
    expect(runtimeMock.registerDebugAdapterTrackerFactory).toHaveBeenCalledWith(
      "foundryscript",
      expect.any(Object),
    );
    expect(runtimeMock.onDidTerminateDebugSession).toHaveBeenCalledWith(
      expect.any(Function),
    );
    expect(context.subscriptions).toHaveLength(1);

    context.subscriptions[0].dispose();
    expect(runtimeMock.configurationDisposable.dispose).toHaveBeenCalledOnce();
    expect(runtimeMock.descriptorDisposable.dispose).toHaveBeenCalledOnce();
    expect(runtimeMock.trackerDisposable.dispose).toHaveBeenCalledOnce();
    expect(runtimeMock.terminationDisposable.dispose).toHaveBeenCalledOnce();
  });

  it("acquires one coordinator lease and returns a direct loopback adapter server", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const appendLine = vi.fn();
    const output = { appendLine } as unknown as vscode.OutputChannel;
    const acquireDapLease = vi.fn().mockResolvedValue({
      endpoint: { host: "127.0.0.1", port: 50123 },
      released: false,
      release: vi.fn(),
      dispose: vi.fn(),
    });
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => ({ acquireDapLease }) as never,
      getMode: () => "spawn",
      output,
    });
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const session = createSession("session-1");

    await expect(
      factory.createDebugAdapterDescriptor(session, undefined),
    ).resolves.toMatchObject({ port: 50123, host: "127.0.0.1" });
    expect(acquireDapLease).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(appendLine).toHaveBeenCalledWith(
      expect.stringContaining("50123"),
    );
  });

  it("releases the acquired lease exactly once when VS Code terminates the session", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const release = vi.fn();
    const coordinator = {
      acquireDapLease: vi.fn().mockResolvedValue({
        endpoint: { host: "127.0.0.1", port: 50123 },
        released: false,
        release,
        dispose: release,
      }),
    };
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => coordinator as never,
      getMode: () => "spawn",
      output: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const session = createSession("session-terminal");
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const terminate = runtimeMock.onDidTerminateDebugSession.mock
      .calls[0][0] as (session: vscode.DebugSession) => void;

    await factory.createDebugAdapterDescriptor(session, undefined);
    terminate(session);
    terminate(session);

    expect(release).toHaveBeenCalledOnce();
    expect(coordinator.acquireDapLease).toHaveBeenCalledOnce();
  });

  it("releases the acquired lease when descriptor construction fails during startup", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const release = vi.fn();
    const appendLine = vi.fn();
    const acquireDapLease = vi.fn().mockResolvedValue({
      endpoint: { host: "127.0.0.1", port: 50123 },
      released: false,
      release,
      dispose: release,
    });
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => ({ acquireDapLease }) as never,
      getMode: () => "spawn",
      output: { appendLine } as unknown as vscode.OutputChannel,
    });
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    runtimeMock.debugAdapterServerFailure = new Error("descriptor unavailable");

    await expect(
      factory.createDebugAdapterDescriptor(
        createSession("descriptor-failure"),
        undefined,
      ),
    ).rejects.toThrow("descriptor unavailable");
    expect(release).toHaveBeenCalledOnce();
    expect(appendLine).toHaveBeenCalledWith(
      expect.stringContaining("descriptor unavailable"),
    );
    expect(runtimeMock.showErrorMessage).toHaveBeenCalledOnce();
  });

  it("aborts a lease acquisition that is pending when VS Code terminates the session", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    let acquisitionSignal: AbortSignal | undefined;
    const acquireDapLease = vi.fn((signal?: AbortSignal) => {
      acquisitionSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => ({ acquireDapLease }) as never,
      getMode: () => "spawn",
      output: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const terminate = runtimeMock.onDidTerminateDebugSession.mock
      .calls[0][0] as (session: vscode.DebugSession) => void;
    const session = createSession("pending-termination");

    const descriptor = factory.createDebugAdapterDescriptor(session, undefined);
    terminate(session);

    expect(acquisitionSignal?.aborted).toBe(true);
    await expect(descriptor).rejects.toMatchObject({ name: "AbortError" });
  });

  it("releases a lease that resolves across the termination-abort race", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const pendingLease = deferred<{
      endpoint: { host: "127.0.0.1"; port: number };
      released: boolean;
      release: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }>();
    const release = vi.fn();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => ({
        acquireDapLease: vi.fn().mockReturnValue(pendingLease.promise),
      }) as never,
      getMode: () => "spawn",
      output: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const terminate = runtimeMock.onDidTerminateDebugSession.mock
      .calls[0][0] as (session: vscode.DebugSession) => void;
    const session = createSession("crossed-race");

    const descriptor = factory.createDebugAdapterDescriptor(session, undefined);
    terminate(session);
    pendingLease.resolve({
      endpoint: { host: "127.0.0.1", port: 50124 },
      released: false,
      release,
      dispose: release,
    });

    await expect(descriptor).rejects.toMatchObject({ name: "AbortError" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("aborts and race-releases a pending lease when the runtime is disposed", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const pendingLease = deferred<{
      endpoint: { host: "127.0.0.1"; port: number };
      released: boolean;
      release: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
    }>();
    const release = vi.fn();
    let acquisitionSignal: AbortSignal | undefined;
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => ({
        acquireDapLease: vi.fn((signal?: AbortSignal) => {
          acquisitionSignal = signal;
          return pendingLease.promise;
        }),
      }) as never,
      getMode: () => "spawn",
      output: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;

    const descriptor = factory.createDebugAdapterDescriptor(
      createSession("disposed-pending"),
      undefined,
    );
    context.subscriptions[0].dispose();
    pendingLease.resolve({
      endpoint: { host: "127.0.0.1", port: 50125 },
      released: false,
      release,
      dispose: release,
    });

    expect(acquisitionSignal?.aborted).toBe(true);
    await expect(descriptor).rejects.toMatchObject({ name: "AbortError" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("creates lifecycle-only trackers for start, stop, transport error, and exit", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => undefined,
      getMode: () => "off",
      output: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const trackerFactory = runtimeMock.registerDebugAdapterTrackerFactory.mock
      .calls[0][1] as vscode.DebugAdapterTrackerFactory;

    const tracker = await trackerFactory.createDebugAdapterTracker(
      createSession("tracker-shape"),
    );

    expect(Object.keys(tracker ?? {}).sort()).toEqual([
      "onError",
      "onExit",
      "onWillStartSession",
      "onWillStopSession",
    ]);
  });

  it("retains the lease across in-session restart and releases it when the adapter stops", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const release = vi.fn();
    const appendLine = vi.fn();
    const output = { appendLine } as unknown as vscode.OutputChannel;
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => ({
        acquireDapLease: vi.fn().mockResolvedValue({
          endpoint: { host: "127.0.0.1", port: 50126 },
          released: false,
          release,
          dispose: release,
        }),
      }) as never,
      getMode: () => "spawn",
      output,
    });
    const session = createSession("restart-session");
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const trackerFactory = runtimeMock.registerDebugAdapterTrackerFactory.mock
      .calls[0][1] as vscode.DebugAdapterTrackerFactory;
    const tracker = await trackerFactory.createDebugAdapterTracker(session);

    await factory.createDebugAdapterDescriptor(session, undefined);
    tracker?.onWillStartSession?.call(tracker);
    tracker?.onWillStartSession?.call(tracker);
    expect(release).not.toHaveBeenCalled();
    expect(
      appendLine.mock.calls.filter(([line]) =>
        String(line).includes("Launching"),
      ),
    ).toEqual([
      [expect.stringMatching(
        /Launching.*res:\/\/levels\/forest\.tscn.*\/workspace\/game.*noDebug=false.*2 play arguments/,
      )],
    ]);

    tracker?.onWillStopSession?.call(tracker);
    tracker?.onWillStopSession?.call(tracker);
    expect(release).toHaveBeenCalledOnce();
    expect(appendLine).toHaveBeenCalledWith(
      expect.stringContaining("adapter stopping"),
    );
  });

  it("reports one actionable transport failure and releases once across duplicate terminal callbacks", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const release = vi.fn();
    const appendLine = vi.fn();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => ({
        acquireDapLease: vi.fn().mockResolvedValue({
          endpoint: { host: "127.0.0.1", port: 50127 },
          released: false,
          release,
          dispose: release,
        }),
      }) as never,
      getMode: () => "spawn",
      output: { appendLine } as unknown as vscode.OutputChannel,
    });
    const session = createSession("transport-failure");
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const trackerFactory = runtimeMock.registerDebugAdapterTrackerFactory.mock
      .calls[0][1] as vscode.DebugAdapterTrackerFactory;
    const tracker = await trackerFactory.createDebugAdapterTracker(session);
    const terminate = runtimeMock.onDidTerminateDebugSession.mock
      .calls[0][0] as (session: vscode.DebugSession) => void;

    await factory.createDebugAdapterDescriptor(session, undefined);
    tracker?.onError?.(new Error("socket reset"));
    tracker?.onError?.(new Error("socket reset"));
    tracker?.onExit?.(undefined, "SIGTERM");
    terminate(session);

    expect(release).toHaveBeenCalledOnce();
    expect(
      appendLine.mock.calls.filter(([line]) =>
        String(line).includes("socket reset"),
      ),
    ).toHaveLength(1);
    expect(runtimeMock.showErrorMessage).toHaveBeenCalledOnce();
    expect(runtimeMock.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("socket reset"),
    );
  });

  it("reports one transport failure when adapter exit arrives before its error", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const release = vi.fn();
    const appendLine = vi.fn();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => ({
        acquireDapLease: vi.fn().mockResolvedValue({
          endpoint: { host: "127.0.0.1", port: 50127 },
          released: false,
          release,
          dispose: release,
        }),
      }) as never,
      getMode: () => "spawn",
      output: { appendLine } as unknown as vscode.OutputChannel,
    });
    const session = createSession("exit-before-error");
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const trackerFactory = runtimeMock.registerDebugAdapterTrackerFactory.mock
      .calls[0][1] as vscode.DebugAdapterTrackerFactory;
    const tracker = await trackerFactory.createDebugAdapterTracker(session);

    await factory.createDebugAdapterDescriptor(session, undefined);
    tracker?.onExit?.(undefined, "SIGPIPE");
    tracker?.onError?.(new Error("socket reset after exit"));
    tracker?.onError?.(new Error("socket reset after exit"));

    expect(release).toHaveBeenCalledOnce();
    expect(
      appendLine.mock.calls.filter(([line]) =>
        String(line).includes("socket reset after exit"),
      ),
    ).toHaveLength(1);
    expect(runtimeMock.showErrorMessage).toHaveBeenCalledOnce();
  });

  it("releases the lease when the adapter transport exits naturally", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const release = vi.fn();
    const appendLine = vi.fn();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => ({
        acquireDapLease: vi.fn().mockResolvedValue({
          endpoint: { host: "127.0.0.1", port: 50128 },
          released: false,
          release,
          dispose: release,
        }),
      }) as never,
      getMode: () => "spawn",
      output: { appendLine } as unknown as vscode.OutputChannel,
    });
    const session = createSession("natural-exit");
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const trackerFactory = runtimeMock.registerDebugAdapterTrackerFactory.mock
      .calls[0][1] as vscode.DebugAdapterTrackerFactory;
    const tracker = await trackerFactory.createDebugAdapterTracker(session);

    await factory.createDebugAdapterDescriptor(session, undefined);
    tracker?.onExit?.(0, undefined);

    expect(release).toHaveBeenCalledOnce();
    expect(appendLine).toHaveBeenCalledWith(
      expect.stringContaining("adapter exit code 0"),
    );
  });

  it("rejects off mode with project, mode, and actionable setting diagnostics", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const appendLine = vi.fn();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => undefined,
      getMode: () => "off",
      output: { appendLine } as unknown as vscode.OutputChannel,
    });
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;

    await expect(
      factory.createDebugAdapterDescriptor(createSession("off-mode"), undefined),
    ).rejects.toThrow("foundryScript.lsp.mode");
    expect(appendLine).toHaveBeenCalledOnce();
    expect(appendLine).toHaveBeenCalledWith(
      expect.stringMatching(/off.*\/workspace\/game.*foundryScript\.lsp\.mode/i),
    );
    expect(runtimeMock.showErrorMessage).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "spawn", mode: "spawn" as const, externalReady: undefined, port: 51002 },
    { name: "attach", mode: "attach" as const, externalReady: undefined, port: 7002 },
    { name: "auto external", mode: "auto" as const, externalReady: true, port: 7002 },
    { name: "auto spawn", mode: "auto" as const, externalReady: false, port: 51002 },
  ])("uses the coordinator-selected DAP endpoint for $name mode", async ({
    mode,
    externalReady,
    port,
  }) => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const launch = vi.fn().mockResolvedValue(createOwnedHost(51002));
    const coordinator = new ToolingHostCoordinator({ launcher: { launch } });
    await coordinator.start(
      {
        mode,
        enginePath: "/opt/foundry",
        project: "/workspace/game",
        lspPort: 7001,
        dapPort: 7002,
      },
      externalReady === undefined
        ? {}
        : { tryExternal: vi.fn().mockResolvedValue(externalReady) },
    );
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => coordinator,
      getMode: () => mode,
      output: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls.at(-1)?.[1] as vscode.DebugAdapterDescriptorFactory;
    const terminate = runtimeMock.onDidTerminateDebugSession.mock
      .calls.at(-1)?.[0] as (session: vscode.DebugSession) => void;
    const session = createSession(`mode-${mode}-${String(externalReady)}`);

    await expect(
      factory.createDebugAdapterDescriptor(session, undefined),
    ).resolves.toMatchObject({ port, host: "127.0.0.1" });
    expect(launch).toHaveBeenCalledTimes(
      mode === "spawn" || externalReady === false ? 1 : 0,
    );

    terminate(session);
    context.subscriptions[0].dispose();
    await coordinator.dispose();
  });

  it("rejects a second concurrent session without changing the active lease", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const coordinator = new ToolingHostCoordinator({
      launcher: { launch: vi.fn() },
    });
    await coordinator.start({
      mode: "attach",
      enginePath: "/opt/foundry",
      project: "/workspace/game",
      lspPort: 7001,
      dapPort: 7002,
    });
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => coordinator,
      getMode: () => "attach",
      output: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls.at(-1)?.[1] as vscode.DebugAdapterDescriptorFactory;
    const terminate = runtimeMock.onDidTerminateDebugSession.mock
      .calls.at(-1)?.[0] as (session: vscode.DebugSession) => void;
    const first = createSession("first-session");
    const second = createSession("second-session");

    await expect(
      factory.createDebugAdapterDescriptor(first, undefined),
    ).resolves.toMatchObject({ port: 7002 });
    await expect(
      factory.createDebugAdapterDescriptor(second, undefined),
    ).rejects.toThrow("already active");
    expect(coordinator.state).toMatchObject({
      kind: "ready-external",
      snapshot: { dap: { port: 7002 } },
    });

    terminate(first);
    await expect(
      factory.createDebugAdapterDescriptor(
        createSession("third-session"),
        undefined,
      ),
    ).resolves.toMatchObject({ port: 7002 });
    context.subscriptions[0].dispose();
    await coordinator.dispose();
  });

  it("rejects duplicate descriptor creation for one session id without orphaning its lease", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const coordinator = new ToolingHostCoordinator({
      launcher: { launch: vi.fn() },
    });
    await coordinator.start({
      mode: "attach",
      enginePath: "/opt/foundry",
      project: "/workspace/game",
      lspPort: 7001,
      dapPort: 7002,
    });
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => coordinator,
      getMode: () => "attach",
      output: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls.at(-1)?.[1] as vscode.DebugAdapterDescriptorFactory;
    const terminate = runtimeMock.onDidTerminateDebugSession.mock
      .calls.at(-1)?.[0] as (session: vscode.DebugSession) => void;
    const session = createSession("duplicate-id");

    await factory.createDebugAdapterDescriptor(session, undefined);
    await expect(
      factory.createDebugAdapterDescriptor(session, undefined),
    ).rejects.toThrow("already has a debug adapter");
    terminate(session);
    await expect(
      factory.createDebugAdapterDescriptor(
        createSession("after-duplicate"),
        undefined,
      ),
    ).resolves.toMatchObject({ port: 7002 });

    context.subscriptions[0].dispose();
    await coordinator.dispose();
  });

  it("releases a stopped session without stopping its shared owned tooling host", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const host = createOwnedHost(51002);
    const coordinator = new ToolingHostCoordinator({
      launcher: { launch: vi.fn().mockResolvedValue(host) },
    });
    await coordinator.start({
      mode: "spawn",
      enginePath: "/opt/foundry",
      project: "/workspace/game",
      lspPort: 0,
      dapPort: 0,
    });
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => coordinator,
      getMode: () => "spawn",
      output: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const factory = runtimeMock.registerDebugAdapterDescriptorFactory.mock
      .calls.at(-1)?.[1] as vscode.DebugAdapterDescriptorFactory;
    const trackerFactory = runtimeMock.registerDebugAdapterTrackerFactory.mock
      .calls.at(-1)?.[1] as vscode.DebugAdapterTrackerFactory;
    const session = createSession("owned-host-stop");
    const tracker = await trackerFactory.createDebugAdapterTracker(session);

    await factory.createDebugAdapterDescriptor(session, undefined);
    tracker?.onWillStopSession?.call(tracker);

    expect(host.stop).not.toHaveBeenCalled();
    expect(coordinator.state).toMatchObject({
      kind: "ready-owned",
      snapshot: { dap: { port: 51002 } },
    });
    await expect(coordinator.acquireDapLease()).resolves.toMatchObject({
      endpoint: { port: 51002 },
    });

    context.subscriptions[0].dispose();
    await coordinator.dispose();
  });

  it("exercises registered provider resolution through the VS Code API shape", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const folder = {
      uri: { fsPath: "/workspace" },
      name: "workspace",
      index: 0,
    } as unknown as vscode.WorkspaceFolder;
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => undefined,
      getMode: () => "off",
      output: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const provider = runtimeMock.registerDebugConfigurationProvider.mock
      .calls[0][1] as vscode.DebugConfigurationProvider;

    await expect(
      provider.resolveDebugConfigurationWithSubstitutedVariables?.(
        folder,
        {
          type: "foundryscript",
          request: "launch",
          name: "Debug Forest",
          scene: "res://levels/forest.tscn",
          args: ["--seed", "42"],
          noDebug: true,
        },
      ),
    ).resolves.toMatchObject({
      project: "/workspace/game",
      playArgs: ["--seed", "42"],
      noDebug: true,
    });
  });

  it("reports provider validation errors through VS Code", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const appendLine = vi.fn();
    runtime!.registerFoundryScriptDebugRuntime(context, {
      resolveProject,
      getCoordinator: () => undefined,
      getMode: () => "off",
      output: { appendLine } as unknown as vscode.OutputChannel,
    });
    const provider = runtimeMock.registerDebugConfigurationProvider.mock
      .calls[0][1] as vscode.DebugConfigurationProvider;

    await expect(
      provider.resolveDebugConfigurationWithSubstitutedVariables?.(undefined, {
        type: "foundryscript",
        request: "attach",
        name: "Attach",
        scene: "main",
      }),
    ).resolves.toBeUndefined();
    expect(runtimeMock.showErrorMessage).toHaveBeenCalledWith(
      'FoundryScript debug configurations support only request "launch".',
    );
    expect(appendLine).toHaveBeenCalledOnce();
    expect(appendLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'FoundryScript debug configurations support only request "launch".',
      ),
    );
  });
});
