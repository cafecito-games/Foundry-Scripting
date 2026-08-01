import { describe, expect, it, vi } from "vitest";
import { TestAdapterFailure } from "./adapter.js";
import type { TestDiscoveryModel } from "./discovery.js";
import {
  TestingRuntime,
  type TestingRuntimeConfiguration,
  type TestingRuntimeOptions,
} from "./runtime.js";
import type { TestingState } from "./status.js";

const enabledConfiguration: TestingRuntimeConfiguration = {
  enabled: true,
  enginePath: "/opt/foundry",
  project: "/workspace/game",
  runner: "res://tests/runner.fs",
  frameworkArgs: ["--path", "res://specs"],
};

const negotiatedAdapter = {
  protocolVersion: 1,
  framework: {
    id: "neutral-spec",
    name: "Neutral Spec",
    version: "2.4.0",
  },
  extensions: ["neutral.coverage"],
};

const cleanModel: TestDiscoveryModel = {
  root: "res://tests",
  items: [],
  suiteCount: 0,
  testCount: 0,
  errorCount: 0,
};

describe("testing runtime", () => {
  it("publishes disabled, clears once, and starts no adapter operation", async () => {
    const harness = createHarness();

    await harness.runtime.configure({ ...enabledConfiguration, enabled: false });

    expect(harness.negotiate).not.toHaveBeenCalled();
    expect(harness.discover).not.toHaveBeenCalled();
    expect(harness.onClear).toHaveBeenCalledOnce();
    expect(harness.states).toEqual([{ kind: "disabled" }]);
  });

  it("negotiates, discovers with the selected version, and publishes in order", async () => {
    const events: string[] = [];
    const onDiscovery = vi.fn((project: string) => events.push(`publish:${project}`));
    const harness = createHarness({
      negotiate: vi.fn(() => {
        events.push("negotiate");
        return Promise.resolve(negotiatedAdapter);
      }),
      discover: vi.fn(() => {
        events.push("discover");
        return Promise.resolve(cleanModel);
      }),
      onDiscovery,
      onState: (state) => events.push(`state:${state.kind}`),
    });

    await harness.runtime.configure(enabledConfiguration);

    expect(events).toEqual([
      "state:negotiating",
      "negotiate",
      "state:discovering",
      "discover",
      "publish:/workspace/game",
      "state:ready",
    ]);
    expect(harness.negotiate).toHaveBeenCalledWith(
      {
        enginePath: "/opt/foundry",
        project: "/workspace/game",
        runner: "res://tests/runner.fs",
        frameworkArgs: ["--path", "res://specs"],
      },
      expect.any(AbortSignal),
    );
    expect(harness.discover).toHaveBeenCalledWith(
      {
        enginePath: "/opt/foundry",
        project: "/workspace/game",
        runner: "res://tests/runner.fs",
        frameworkArgs: ["--path", "res://specs"],
        protocolVersion: 1,
      },
      expect.any(AbortSignal),
    );
    expect(onDiscovery).toHaveBeenCalledWith("/workspace/game", cleanModel);
    expect(harness.states).toEqual([]);
  });

  it("publishes a complete empty model authoritatively", async () => {
    const harness = createHarness();

    await harness.runtime.configure(enabledConfiguration);

    expect(harness.onDiscovery).toHaveBeenCalledWith(
      "/workspace/game",
      cleanModel,
    );
    expect(harness.states.at(-1)).toEqual({
      kind: "ready",
      adapter: negotiatedAdapter,
      discoveryErrorCount: 0,
    });
  });

  it("publishes complete discovery with represented errors as ready", async () => {
    const errorModel = { ...cleanModel, errorCount: 2 };
    const harness = createHarness({
      discover: vi.fn().mockResolvedValue(errorModel),
    });

    await harness.runtime.configure(enabledConfiguration);

    expect(harness.onDiscovery).toHaveBeenCalledWith(
      "/workspace/game",
      errorModel,
    );
    expect(harness.states.at(-1)).toEqual({
      kind: "ready",
      adapter: negotiatedAdapter,
      discoveryErrorCount: 2,
    });
  });

  it.each([
    "malformed_discovery",
    "incomplete_discovery",
    "discovery_exit_mismatch",
  ] as const)("retains the prior tree after %s", async (kind) => {
    const failure = new TestAdapterFailure(kind, `Discovery failed: ${kind}`);
    const harness = createHarness({
      discover: vi.fn().mockRejectedValue(failure),
    });

    await harness.runtime.configure(enabledConfiguration);

    expect(harness.onDiscovery).not.toHaveBeenCalled();
    expect(harness.onClear).not.toHaveBeenCalled();
    expect(harness.states.at(-1)).toEqual({ kind: "error", failure });
  });

  it("makes stale discovery success inert before starting the changed generation", async () => {
    const first = deferred<TestDiscoveryModel>();
    const second = deferred<TestDiscoveryModel>();
    const discoverySignals: AbortSignal[] = [];
    const discover = vi.fn((_request, signal: AbortSignal) => {
      discoverySignals.push(signal);
      return discoverySignals.length === 1 ? first.promise : second.promise;
    });
    const harness = createHarness({ discover });
    const firstConfigure = harness.runtime.configure(enabledConfiguration);
    await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());

    const secondConfigure = harness.runtime.configure({
      ...enabledConfiguration,
      runner: "res://tests/changed.fs",
    });
    expect(discoverySignals[0]?.aborted).toBe(true);
    first.resolve(cleanModel);
    await firstConfigure;
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    second.resolve(cleanModel);
    await secondConfigure;

    expect(harness.onDiscovery).toHaveBeenCalledOnce();
    expect(harness.onDiscovery).toHaveBeenCalledWith(
      "/workspace/game",
      cleanModel,
    );
    expect(harness.states.filter((state) => state.kind === "ready")).toHaveLength(1);
  });

  it("makes stale discovery failure inert", async () => {
    const first = deferred<TestDiscoveryModel>();
    const second = deferred<TestDiscoveryModel>();
    const discover = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const harness = createHarness({ discover });
    const firstConfigure = harness.runtime.configure(enabledConfiguration);
    await vi.waitFor(() => expect(discover).toHaveBeenCalledOnce());
    const secondConfigure = harness.runtime.configure({
      ...enabledConfiguration,
      frameworkArgs: ["--changed"],
    });

    first.reject(new TestAdapterFailure("process_failed", "stale"));
    await firstConfigure;
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    second.resolve(cleanModel);
    await secondConfigure;

    expect(harness.states.some((state) => state.kind === "error")).toBe(false);
    expect(harness.onDiscovery).toHaveBeenCalledOnce();
  });

  it("refreshes an unchanged enabled configuration", async () => {
    const harness = createHarness();
    await harness.runtime.configure(enabledConfiguration);

    await harness.runtime.refresh();

    expect(harness.negotiate).toHaveBeenCalledTimes(2);
    expect(harness.discover).toHaveBeenCalledTimes(2);
    expect(harness.onDiscovery).toHaveBeenCalledTimes(2);
  });

  it("does not refresh before configuration or while disabled", async () => {
    const harness = createHarness();
    await harness.runtime.refresh();
    await harness.runtime.configure({ ...enabledConfiguration, enabled: false });
    await harness.runtime.refresh();

    expect(harness.negotiate).not.toHaveBeenCalled();
    expect(harness.discover).not.toHaveBeenCalled();
  });

  it("does not restart identical configuration without an explicit refresh", async () => {
    const harness = createHarness();
    await harness.runtime.configure(enabledConfiguration);
    await harness.runtime.configure({
      ...enabledConfiguration,
      frameworkArgs: [...enabledConfiguration.frameworkArgs],
    });

    expect(harness.negotiate).toHaveBeenCalledOnce();
    expect(harness.discover).toHaveBeenCalledOnce();
  });

  it("disables immediately, clears once, and cancels active discovery", async () => {
    const operation = deferred<TestDiscoveryModel>();
    let discoverySignal: AbortSignal | undefined;
    const harness = createHarness({
      discover: (_request, signal) => {
        discoverySignal = signal;
        return operation.promise;
      },
    });
    const configure = harness.runtime.configure(enabledConfiguration);
    await vi.waitFor(() => expect(discoverySignal).toBeDefined());

    const disable = harness.runtime.configure({
      ...enabledConfiguration,
      enabled: false,
    });

    expect(harness.states.at(-1)).toEqual({ kind: "disabled" });
    expect(harness.onClear).toHaveBeenCalledOnce();
    expect(discoverySignal?.aborted).toBe(true);
    operation.reject(abortError());
    await Promise.all([configure, disable]);
    expect(harness.states.some((state) => state.kind === "error")).toBe(false);
  });

  it("does not present discovery cancellation as an adapter error", async () => {
    const harness = createHarness({
      discover: vi.fn().mockRejectedValue(abortError()),
    });

    await harness.runtime.configure(enabledConfiguration);

    expect(harness.onDiscovery).not.toHaveBeenCalled();
    expect(harness.states.map((state) => state.kind)).toEqual([
      "negotiating",
      "discovering",
    ]);
  });

  it("publishes negotiation failure without starting discovery", async () => {
    const failure = new TestAdapterFailure(
      "incompatible_adapter",
      "No shared version.",
    );
    const harness = createHarness({
      negotiate: vi.fn().mockRejectedValue(failure),
    });

    await harness.runtime.configure(enabledConfiguration);

    expect(harness.discover).not.toHaveBeenCalled();
    expect(harness.states.at(-1)).toEqual({ kind: "error", failure });
  });

  it("stops idempotently and leaves later completion inert", async () => {
    const operation = deferred<TestDiscoveryModel>();
    let discoverySignal: AbortSignal | undefined;
    const harness = createHarness({
      discover: (_request, signal) => {
        discoverySignal = signal;
        return operation.promise;
      },
    });
    const configure = harness.runtime.configure(enabledConfiguration);
    await vi.waitFor(() => expect(discoverySignal).toBeDefined());

    const firstStop = harness.runtime.stop();
    const secondStop = harness.runtime.stop();
    expect(firstStop).toBe(secondStop);
    expect(discoverySignal?.aborted).toBe(true);
    operation.resolve(cleanModel);
    await Promise.all([configure, firstStop, secondStop]);

    expect(harness.states.at(-1)).toEqual({ kind: "disabled" });
    expect(harness.states.filter((state) => state.kind === "disabled")).toHaveLength(1);
    expect(harness.onDiscovery).not.toHaveBeenCalled();
    await harness.runtime.configure(enabledConfiguration);
    expect(harness.negotiate).toHaveBeenCalledOnce();
  });
});

interface RuntimeHarness {
  readonly runtime: TestingRuntime;
  readonly negotiate: ReturnType<typeof vi.fn>;
  readonly discover: ReturnType<typeof vi.fn>;
  readonly onDiscovery: ReturnType<typeof vi.fn>;
  readonly onClear: ReturnType<typeof vi.fn>;
  readonly states: TestingState[];
}

function createHarness(overrides: Partial<TestingRuntimeOptions> = {}): RuntimeHarness {
  const states: TestingState[] = [];
  const negotiate = vi.fn().mockResolvedValue(negotiatedAdapter);
  const discover = vi.fn().mockResolvedValue(cleanModel);
  const onDiscovery = vi.fn();
  const onClear = vi.fn();
  const runtime = new TestingRuntime({
    negotiate,
    discover,
    onDiscovery,
    onClear,
    onState: (state) => states.push(state),
    ...overrides,
  });
  return {
    runtime,
    negotiate:
      overrides.negotiate === undefined
        ? negotiate
        : (overrides.negotiate as ReturnType<typeof vi.fn>),
    discover:
      overrides.discover === undefined
        ? discover
        : (overrides.discover as ReturnType<typeof vi.fn>),
    onDiscovery:
      overrides.onDiscovery === undefined
        ? onDiscovery
        : (overrides.onDiscovery as ReturnType<typeof vi.fn>),
    onClear:
      overrides.onClear === undefined
        ? onClear
        : (overrides.onClear as ReturnType<typeof vi.fn>),
    states,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  const error = new Error("cancelled");
  error.name = "AbortError";
  return error;
}
