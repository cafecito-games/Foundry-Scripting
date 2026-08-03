import { describe, expect, it, vi } from "vitest";
import type {
  ConnectionSettings,
  StartConnectionOptions,
} from "./connection-manager.js";
import { ConnectionLifecycle } from "./lifecycle.js";
import { ConnectionConfigurationFailure } from "./settings.js";
import type { ProjectResolution } from "../project/resolver.js";

const defaultSettings: ConnectionSettings = {
  mode: "attach",
  port: 6005,
  dapPort: 6006,
  enginePath: "foundry",
};

describe("connection lifecycle", () => {
  it("starts the initial enabled generation and exposes it only after readiness", async () => {
    const harness = createHarness();

    await harness.lifecycle.requestReconciliation();

    expect(harness.resolveProject).toHaveBeenCalledOnce();
    expect(harness.managers[0]?.start).toHaveBeenCalledWith({
      settings: defaultSettings,
      project: "/workspace/game",
    });
    expect(harness.lifecycle.currentManager).toBe(harness.managers[0]);
    expect(harness.lifecycle.currentCoordinator).toBe(harness.coordinators[0]);
    expect(harness.states).toEqual([{ kind: "disconnected" }]);
  });

  it("publishes off without resolving or creating resources", async () => {
    const harness = createHarness({
      settings: { ...defaultSettings, mode: "off" },
    });

    await harness.lifecycle.requestReconciliation();

    expect(harness.resolveProject).not.toHaveBeenCalled();
    expect(harness.createCoordinator).not.toHaveBeenCalled();
    expect(harness.createManager).not.toHaveBeenCalled();
    expect(harness.states).toEqual([{ kind: "off" }]);
  });

  it("reports settings failures without resolving a project or creating resources", async () => {
    const failure = new ConnectionConfigurationFailure(
      "foundryScript.lsp.port",
      "foundryScript.lsp.port must be a finite integer from 1-65535.",
    );
    const readSettings = vi.fn(() => {
      throw failure;
    });
    const harness = createHarness({ readSettings });

    await harness.lifecycle.requestReconciliation();

    expect(harness.reportSettingsFailure).toHaveBeenCalledWith(failure);
    expect(harness.resolveProject).not.toHaveBeenCalled();
    expect(harness.createCoordinator).not.toHaveBeenCalled();
    expect(harness.createManager).not.toHaveBeenCalled();
    expect(harness.reportStartupFailure).not.toHaveBeenCalled();
    expect(harness.logBackgroundFailure).not.toHaveBeenCalled();
    expect(harness.states).toEqual([]);
  });

  it("validates a malformed typed settings snapshot before project resolution", async () => {
    const harness = createHarness({
      settings: {
        ...defaultSettings,
        mode: "malformed",
      } as unknown as ConnectionSettings,
    });

    await harness.lifecycle.requestReconciliation();

    expect(harness.reportSettingsFailure).toHaveBeenCalledWith(
      expect.objectContaining({ setting: "foundryScript.lsp.mode" }),
    );
    expect(harness.resolveProject).not.toHaveBeenCalled();
    expect(harness.createCoordinator).not.toHaveBeenCalled();
    expect(harness.createManager).not.toHaveBeenCalled();
    expect(harness.states).toEqual([]);
  });

  it("supports off to enabled and enabled to off without replacement overlap", async () => {
    const harness = createHarness({
      settings: { ...defaultSettings, mode: "off" },
    });
    await harness.lifecycle.requestReconciliation();

    harness.settings = { ...defaultSettings, mode: "spawn" };
    await harness.lifecycle.requestReconciliation();
    expect(harness.lifecycle.currentManager).toBe(harness.managers[0]);

    harness.settings = { ...defaultSettings, mode: "off" };
    await harness.lifecycle.requestReconciliation();

    expect(harness.managers[0]?.stop).toHaveBeenCalledOnce();
    expect(harness.coordinators[0]?.dispose).toHaveBeenCalledOnce();
    expect(harness.events.indexOf("manager:0:stop"))
      .toBeLessThan(harness.events.indexOf("coordinator:0:dispose"));
    expect(harness.lifecycle.currentManager).toBeUndefined();
    expect(harness.lifecycle.currentCoordinator).toBeUndefined();
    expect(harness.states.at(-1)).toEqual({ kind: "off" });
  });

  it("releases manager then coordinator before activating replacement resources", async () => {
    const harness = createHarness();
    await harness.lifecycle.requestReconciliation();
    harness.project = "/workspace/other";

    await harness.lifecycle.requestReconciliation();

    expect(harness.managers).toHaveLength(2);
    expect(harness.events.indexOf("manager:0:stop"))
      .toBeLessThan(harness.events.indexOf("coordinator:0:dispose"));
    expect(harness.events.indexOf("coordinator:0:dispose"))
      .toBeLessThan(harness.events.indexOf("manager:1:start:/workspace/other:6005"));
    expect(harness.lifecycle.currentManager).toBe(harness.managers[1]);
    expect(harness.lifecycle.currentCoordinator).toBe(harness.coordinators[1]);
  });

  it("serializes rapid requests and applies only the final settings snapshot", async () => {
    const firstResolution = deferred<ProjectResolution>();
    const resolveProject = vi
      .fn()
      .mockReturnValueOnce(firstResolution.promise)
      .mockResolvedValue({ success: true, project: "/workspace/final" });
    const harness = createHarness({ resolveProject });
    const first = harness.lifecycle.requestReconciliation();
    await vi.waitFor(() => expect(resolveProject).toHaveBeenCalledOnce());

    harness.settings = { ...defaultSettings, port: 7001 };
    const second = harness.lifecycle.requestReconciliation();
    harness.settings = { ...defaultSettings, port: 7002 };
    const third = harness.lifecycle.requestReconciliation();
    firstResolution.resolve({ success: true, project: "/workspace/stale" });
    await Promise.all([first, second, third]);

    expect(resolveProject).toHaveBeenCalledTimes(2);
    expect(harness.managers).toHaveLength(1);
    expect(harness.managers[0]?.start).toHaveBeenCalledWith({
      settings: { ...defaultSettings, port: 7002 },
      project: "/workspace/final",
    });
  });

  it("stops an in-flight manager immediately and ignores its late start", async () => {
    const firstStart = deferred<void>();
    const harness = createHarness({ managerStarts: [firstStart.promise] });
    const first = harness.lifecycle.requestReconciliation();
    await vi.waitFor(() => expect(harness.managers).toHaveLength(1));

    harness.settings = { ...defaultSettings, port: 7002 };
    const replacement = harness.lifecycle.requestReconciliation();
    expect(harness.managers[0]?.stop).toHaveBeenCalledOnce();
    expect(harness.lifecycle.currentManager).toBeUndefined();
    firstStart.resolve(undefined);
    await Promise.all([first, replacement]);

    expect(harness.managers).toHaveLength(2);
    expect(harness.events.indexOf("manager:0:stop"))
      .toBeLessThan(harness.events.indexOf("coordinator:0:dispose"));
    expect(harness.events.indexOf("coordinator:0:dispose"))
      .toBeLessThan(harness.events.indexOf("manager:1:start:/workspace/game:7002"));
    expect(harness.lifecycle.currentManager).toBe(harness.managers[1]);
  });

  it("reports current project and startup failures without blocking reconciliation", async () => {
    const notification = deferred<void>();
    const failure = {
      kind: "missing_workspace" as const,
      message: "Open a workspace folder.",
    };
    const harness = createHarness({
      resolution: { success: false, failure },
      reportProjectFailure: vi.fn(() => notification.promise),
    });

    await harness.lifecycle.requestReconciliation();

    expect(harness.reportProjectFailure).toHaveBeenCalledWith(failure);
    expect(harness.lifecycle.currentManager).toBeUndefined();
    notification.resolve(undefined);
  });

  it("stops idempotently during project resolution and prevents replacement", async () => {
    const resolution = deferred<ProjectResolution>();
    const harness = createHarness({
      resolveProject: vi.fn(() => resolution.promise),
    });
    const reconciliation = harness.lifecycle.requestReconciliation();
    await vi.waitFor(() => expect(harness.resolveProject).toHaveBeenCalledOnce());

    const firstStop = harness.lifecycle.stop();
    const secondStop = harness.lifecycle.stop();
    expect(firstStop).toBe(secondStop);
    resolution.resolve({ success: true, project: "/workspace/stale" });
    await Promise.all([reconciliation, firstStop, secondStop]);

    expect(harness.createCoordinator).not.toHaveBeenCalled();
    await harness.lifecycle.requestReconciliation();
    expect(harness.resolveProject).toHaveBeenCalledOnce();
  });

  it("stops idempotently during manager startup and releases stale resources", async () => {
    const start = deferred<void>();
    const harness = createHarness({ managerStarts: [start.promise] });
    const reconciliation = harness.lifecycle.requestReconciliation();
    await vi.waitFor(() => expect(harness.managers).toHaveLength(1));

    const stopping = harness.lifecycle.stop();
    expect(harness.managers[0]?.stop).toHaveBeenCalledOnce();
    start.resolve(undefined);
    await Promise.all([reconciliation, stopping]);

    expect(harness.coordinators[0]?.dispose).toHaveBeenCalledOnce();
    expect(harness.lifecycle.currentManager).toBeUndefined();
    expect(harness.lifecycle.currentCoordinator).toBeUndefined();
  });
});

interface TestManager {
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly reconnectNow: ReturnType<typeof vi.fn>;
}

interface TestCoordinator {
  readonly dispose: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  readonly settings?: ConnectionSettings;
  readonly resolution?: ProjectResolution;
  readonly resolveProject?: ReturnType<typeof vi.fn>;
  readonly managerStarts?: readonly Promise<void>[];
  readonly reportProjectFailure?: ReturnType<typeof vi.fn>;
  readonly readSettings?: ReturnType<typeof vi.fn>;
}

function createHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const managers: TestManager[] = [];
  const coordinators: TestCoordinator[] = [];
  const states: Array<{ kind: string }> = [];
  const managerStarts = [...(options.managerStarts ?? [])];
  const harness = {
    settings: options.settings ?? defaultSettings,
    project: "/workspace/game",
  };
  const resolveProject = options.resolveProject ?? vi.fn(() =>
    Promise.resolve(options.resolution ?? {
      success: true as const,
      project: harness.project,
    }));
  const createCoordinator = vi.fn(() => {
    const id = coordinators.length;
    const coordinator: TestCoordinator = {
      dispose: vi.fn(() => {
        events.push(`coordinator:${id}:dispose`);
        return Promise.resolve();
      }),
    };
    coordinators.push(coordinator);
    return coordinator;
  });
  const createManager = vi.fn((project: string, _coordinator: TestCoordinator) => {
    const id = managers.length;
    const startResult = managerStarts.shift();
    const manager: TestManager = {
      start: vi.fn((startOptions: StartConnectionOptions) => {
        events.push(
          `manager:${id}:start:${project}:${startOptions.settings.port}`,
        );
        return startResult ?? Promise.resolve();
      }),
      stop: vi.fn(() => {
        events.push(`manager:${id}:stop`);
        return Promise.resolve();
      }),
      reconnectNow: vi.fn().mockResolvedValue(undefined),
    };
    managers.push(manager);
    return manager;
  });
  const reportProjectFailure = options.reportProjectFailure ?? vi.fn();
  const reportSettingsFailure = vi.fn();
  const reportStartupFailure = vi.fn();
  const logBackgroundFailure = vi.fn();
  const lifecycle = new ConnectionLifecycle({
    readSettings: options.readSettings ?? (() => harness.settings),
    resolveProject,
    createCoordinator,
    createManager,
    publishState: (state) => states.push(state),
    reportProjectFailure,
    reportSettingsFailure,
    reportStartupFailure,
    logBackgroundFailure,
  });
  return Object.assign(harness, {
    lifecycle,
    events,
    managers,
    coordinators,
    states,
    resolveProject,
    createCoordinator,
    createManager,
    reportProjectFailure,
    reportSettingsFailure,
    reportStartupFailure,
    logBackgroundFailure,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}
