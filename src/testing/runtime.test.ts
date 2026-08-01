import { describe, expect, it, vi } from "vitest";
import { TestAdapterFailure } from "./adapter.js";
import {
  TestingRuntime,
  type TestingRuntimeConfiguration,
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

describe("testing runtime", () => {
  it("publishes disabled without starting adapter operations", async () => {
    const negotiate = vi.fn();
    const onState = vi.fn<(state: TestingState) => void>();
    const runtime = new TestingRuntime({ negotiate, onState });

    await runtime.configure({ ...enabledConfiguration, enabled: false });

    expect(negotiate).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith({ kind: "disabled" });
  });

  it("publishes negotiating then complete framework metadata", async () => {
    const onState = vi.fn<(state: TestingState) => void>();
    const runtime = new TestingRuntime({
      negotiate: vi.fn().mockResolvedValue(negotiatedAdapter),
      onState,
    });

    await runtime.configure(enabledConfiguration);

    expect(onState.mock.calls.map(([state]) => state)).toEqual([
      { kind: "negotiating", runner: "res://tests/runner.fs" },
      { kind: "ready", adapter: negotiatedAdapter },
    ]);
  });

  it("makes a stale success inert before starting the changed generation", async () => {
    const first = deferred<typeof negotiatedAdapter>();
    const second = deferred<typeof negotiatedAdapter>();
    const signals: AbortSignal[] = [];
    const negotiate = vi.fn((_request, signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : second.promise;
    });
    const states: TestingState[] = [];
    const runtime = new TestingRuntime({
      negotiate,
      onState: (state) => states.push(state),
    });
    const firstConfigure = runtime.configure(enabledConfiguration);
    const secondConfigure = runtime.configure({
      ...enabledConfiguration,
      runner: "res://tests/changed.fs",
    });

    expect(signals[0]?.aborted).toBe(true);
    first.resolve(negotiatedAdapter);
    await firstConfigure;
    await Promise.resolve();
    expect(negotiate).toHaveBeenCalledTimes(2);
    second.resolve({
      ...negotiatedAdapter,
      framework: { ...negotiatedAdapter.framework, name: "Changed" },
    });
    await secondConfigure;

    expect(states.filter((state) => state.kind === "ready")).toEqual([
      {
        kind: "ready",
        adapter: {
          ...negotiatedAdapter,
          framework: { ...negotiatedAdapter.framework, name: "Changed" },
        },
      },
    ]);
  });

  it("makes a stale failure inert", async () => {
    const first = deferred<typeof negotiatedAdapter>();
    const second = deferred<typeof negotiatedAdapter>();
    let call = 0;
    const states: TestingState[] = [];
    const runtime = new TestingRuntime({
      negotiate: () => (call++ === 0 ? first.promise : second.promise),
      onState: (state) => states.push(state),
    });
    const firstConfigure = runtime.configure(enabledConfiguration);
    const secondConfigure = runtime.configure({
      ...enabledConfiguration,
      frameworkArgs: ["--changed"],
    });

    first.reject(new TestAdapterFailure("process_failed", "stale failure"));
    await firstConfigure;
    await Promise.resolve();
    second.resolve(negotiatedAdapter);
    await secondConfigure;

    expect(states.some((state) => state.kind === "error")).toBe(false);
    expect(states.at(-1)).toEqual({ kind: "ready", adapter: negotiatedAdapter });
  });

  it("does not restart identical completed configuration", async () => {
    const negotiate = vi.fn().mockResolvedValue(negotiatedAdapter);
    const onState = vi.fn<(state: TestingState) => void>();
    const runtime = new TestingRuntime({ negotiate, onState });

    await runtime.configure(enabledConfiguration);
    await runtime.configure({
      ...enabledConfiguration,
      frameworkArgs: [...enabledConfiguration.frameworkArgs],
    });

    expect(negotiate).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledTimes(2);
  });

  it("publishes disabled immediately and cancels the active generation", async () => {
    const operation = deferred<typeof negotiatedAdapter>();
    let signal: AbortSignal | undefined;
    const states: TestingState[] = [];
    const runtime = new TestingRuntime({
      negotiate: (_request, operationSignal) => {
        signal = operationSignal;
        return operation.promise;
      },
      onState: (state) => states.push(state),
    });
    const configure = runtime.configure(enabledConfiguration);

    const disable = runtime.configure({ ...enabledConfiguration, enabled: false });

    expect(states.at(-1)).toEqual({ kind: "disabled" });
    expect(signal?.aborted).toBe(true);
    operation.reject(abortError());
    await Promise.all([configure, disable]);
    expect(states.some((state) => state.kind === "error")).toBe(false);
  });

  it("publishes actionable negotiation failures", async () => {
    const failure = new TestAdapterFailure(
      "incompatible_adapter",
      "No shared version.",
    );
    const states: TestingState[] = [];
    const runtime = new TestingRuntime({
      negotiate: vi.fn().mockRejectedValue(failure),
      onState: (state) => states.push(state),
    });

    await runtime.configure(enabledConfiguration);

    expect(states.at(-1)).toEqual({ kind: "error", failure });
  });

  it("does not present internal cancellation as an adapter error", async () => {
    const states: TestingState[] = [];
    const runtime = new TestingRuntime({
      negotiate: vi.fn().mockRejectedValue(abortError()),
      onState: (state) => states.push(state),
    });

    await runtime.configure(enabledConfiguration);

    expect(states).toEqual([
      { kind: "negotiating", runner: "res://tests/runner.fs" },
    ]);
  });

  it("stops idempotently and leaves later completion inert", async () => {
    const operation = deferred<typeof negotiatedAdapter>();
    let signal: AbortSignal | undefined;
    const states: TestingState[] = [];
    const runtime = new TestingRuntime({
      negotiate: (_request, operationSignal) => {
        signal = operationSignal;
        return operation.promise;
      },
      onState: (state) => states.push(state),
    });
    const configure = runtime.configure(enabledConfiguration);

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    expect(signal?.aborted).toBe(true);
    operation.resolve(negotiatedAdapter);
    await Promise.all([configure, firstStop, secondStop]);

    expect(states.at(-1)).toEqual({ kind: "disabled" });
    expect(states.filter((state) => state.kind === "disabled")).toHaveLength(1);
    expect(states.some((state) => state.kind === "ready")).toBe(false);
    await runtime.configure(enabledConfiguration);
    expect(states.at(-1)).toEqual({ kind: "disabled" });
  });
});

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
