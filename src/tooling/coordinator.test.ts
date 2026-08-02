import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DapSessionLeaseUnavailable,
  ToolingHostCoordinator,
  type OwnedToolingHost,
  type ToolingHostCoordinatorState,
  type ToolingHostLauncher,
} from "./coordinator.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
    reject: (error) => rejectPromise?.(error),
  };
}

function createOwnedHost(
  lspPort = 49152,
  dapPort = 49153,
): OwnedToolingHost & {
  stop: ReturnType<typeof vi.fn>;
  exit: (code?: number | null) => void;
} {
  const listeners = new Set<(code: number | null) => void>();
  return {
    readiness: {
      project: "/workspace/game",
      pid: 1234,
      localOnly: true,
      services: ["lsp", "dap"],
      lspPort,
      dapPort,
    },
    stop: vi.fn().mockResolvedValue(undefined),
    onExit: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    exit: (code = 1) => {
      for (const listener of listeners) listener(code);
    },
  };
}

const spawnRequest = {
  mode: "spawn",
  enginePath: "/opt/foundry",
  project: "/workspace/game",
  lspPort: 6005,
  dapPort: 6006,
} as const;

describe("ToolingHostCoordinator modes and state", () => {
  const states: ToolingHostCoordinatorState[] = [];
  let launch: ReturnType<typeof vi.fn>;
  let launcher: ToolingHostLauncher;

  beforeEach(() => {
    states.length = 0;
    launch = vi.fn();
    launcher = { launch };
  });

  it("starts idle and resolves off without endpoints", async () => {
    const coordinator = new ToolingHostCoordinator({
      launcher,
      onStateChange: (state) => states.push(state),
    });

    await expect(
      coordinator.start({ ...spawnRequest, mode: "off" }),
    ).resolves.toBeUndefined();

    expect(coordinator.state).toEqual({ kind: "idle" });
    expect(states).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("represents attach endpoints without owning a process", async () => {
    const coordinator = new ToolingHostCoordinator({
      launcher,
      onStateChange: (state) => states.push(state),
    });

    const snapshot = await coordinator.start({
      ...spawnRequest,
      mode: "attach",
      lspPort: 7001,
      dapPort: 7002,
    });
    await coordinator.dispose();

    expect(snapshot).toEqual({
      ownership: "external",
      project: "/workspace/game",
      lsp: { host: "127.0.0.1", port: 7001 },
      dap: { host: "127.0.0.1", port: 7002 },
    });
    expect(states.map((state) => state.kind)).toEqual([
      "starting",
      "ready-external",
      "stopping",
      "idle",
    ]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("labels DAP leases with the selected host ownership", async () => {
    const external = new ToolingHostCoordinator({ launcher });
    await external.start({ ...spawnRequest, mode: "attach" });
    const externalLease = await external.acquireDapLease();

    expect(externalLease.ownership).toBe("external");
    externalLease.release();

    const host = createOwnedHost();
    launch.mockResolvedValue(host);
    const owned = new ToolingHostCoordinator({ launcher });
    await owned.start(spawnRequest);

    await expect(owned.acquireDapLease()).resolves.toMatchObject({
      ownership: "owned",
    });
  });

  it("retains the complete readiness record for an owned host", async () => {
    const host = createOwnedHost();
    launch.mockResolvedValue(host);
    const coordinator = new ToolingHostCoordinator({
      launcher,
      onStateChange: (state) => states.push(state),
    });

    const snapshot = await coordinator.start(spawnRequest);

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      enginePath: "/opt/foundry",
      project: "/workspace/game",
    }));
    expect(snapshot).toMatchObject({
      ownership: "owned",
      project: "/workspace/game",
      pid: 1234,
      services: ["lsp", "dap"],
      lsp: { host: "127.0.0.1", port: 49152 },
      dap: { host: "127.0.0.1", port: 49153 },
    });
    expect(states.map((state) => state.kind)).toEqual([
      "starting",
      "ready-owned",
    ]);

    await coordinator.dispose();
    expect(host.stop).toHaveBeenCalledOnce();
  });

  it("publishes failure and can recover with a fresh owned host", async () => {
    const failure = new Error("malformed readiness");
    const host = createOwnedHost(50100, 50101);
    launch.mockRejectedValueOnce(failure).mockResolvedValueOnce(host);
    const coordinator = new ToolingHostCoordinator({
      launcher,
      onStateChange: (state) => states.push(state),
    });

    await expect(coordinator.start(spawnRequest)).rejects.toBe(failure);
    await expect(coordinator.start(spawnRequest)).resolves.toMatchObject({
      ownership: "owned",
      lsp: { port: 50100 },
      dap: { port: 50101 },
    });

    expect(states.map((state) => state.kind)).toEqual([
      "starting",
      "failed",
      "starting",
      "ready-owned",
    ]);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("finishes the stopping transition when owned-host shutdown fails", async () => {
    const shutdownFailure = new Error("SIGTERM failed");
    const host = createOwnedHost();
    host.stop.mockRejectedValue(shutdownFailure);
    launch.mockResolvedValue(host);
    const coordinator = new ToolingHostCoordinator({
      launcher,
      onStateChange: (state) => states.push(state),
    });
    await coordinator.start(spawnRequest);

    await expect(coordinator.dispose()).rejects.toBe(shutdownFailure);

    expect(coordinator.state).toEqual({ kind: "idle" });
    expect(states.slice(-2).map((state) => state.kind)).toEqual([
      "stopping",
      "idle",
    ]);
  });

  it("makes overlapping disposal callers await the same owned-host shutdown", async () => {
    const stopped = deferred<void>();
    const host = createOwnedHost();
    host.stop.mockReturnValue(stopped.promise);
    launch.mockResolvedValue(host);
    const coordinator = new ToolingHostCoordinator({ launcher });
    await coordinator.start(spawnRequest);

    const first = coordinator.dispose();
    const second = coordinator.dispose();
    let secondFinished = false;
    void second.then(() => {
      secondFinished = true;
    });
    await Promise.resolve();

    expect(secondFinished).toBe(false);
    expect(host.stop).toHaveBeenCalledOnce();
    stopped.resolve(undefined);
    await Promise.all([first, second]);
    expect(coordinator.state).toEqual({ kind: "idle" });
  });
});

describe("ToolingHostCoordinator serialized readiness", () => {
  it("shares one owned launch between simultaneous LSP and DAP readiness", async () => {
    const pendingHost = deferred<OwnedToolingHost>();
    const launch = vi.fn().mockReturnValue(pendingHost.promise);
    const coordinator = new ToolingHostCoordinator({ launcher: { launch } });

    const lspReadiness = coordinator.start(spawnRequest);
    const dapReadiness = coordinator.acquireDapLease();
    pendingHost.resolve(createOwnedHost());

    await expect(lspReadiness).resolves.toMatchObject({
      lsp: { port: 49152 },
    });
    await expect(dapReadiness).resolves.toMatchObject({
      endpoint: { host: "127.0.0.1", port: 49153 },
    });
    expect(launch).toHaveBeenCalledOnce();
  });

  it("cancels one readiness waiter without aborting another", async () => {
    const pendingHost = deferred<OwnedToolingHost>();
    let launchSignal: AbortSignal | undefined;
    const launch = vi.fn().mockImplementation(
      ({ signal }: { signal?: AbortSignal }) => {
        launchSignal = signal;
        return pendingHost.promise;
      },
    );
    const coordinator = new ToolingHostCoordinator({ launcher: { launch } });
    const cancelled = new AbortController();

    const first = coordinator.start(spawnRequest, {
      signal: cancelled.signal,
    });
    const second = coordinator.start(spawnRequest);
    cancelled.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(launchSignal?.aborted).toBe(false);
    pendingHost.resolve(createOwnedHost());
    await expect(second).resolves.toMatchObject({ ownership: "owned" });
  });

  it("aborts startup and returns idle when every waiter cancels", async () => {
    const launch = vi.fn().mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<OwnedToolingHost>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("launcher cancelled");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const coordinator = new ToolingHostCoordinator({ launcher: { launch } });
    const cancelled = new AbortController();

    const readiness = coordinator.start(spawnRequest, {
      signal: cancelled.signal,
    });
    cancelled.abort();

    await expect(readiness).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(coordinator.state).toEqual({ kind: "idle" }));
  });

  it("keeps auto external when its LSP endpoint is reachable", async () => {
    const tryExternal = vi.fn().mockResolvedValue(true);
    const launch = vi.fn();
    const coordinator = new ToolingHostCoordinator({ launcher: { launch } });

    const snapshot = await coordinator.start(
      { ...spawnRequest, mode: "auto", lspPort: 7101, dapPort: 7102 },
      { tryExternal },
    );

    expect(tryExternal).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 7101,
    });
    expect(snapshot).toMatchObject({
      ownership: "external",
      dap: { port: 7102 },
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects auto readiness when no external probe is supplied", async () => {
    const launch = vi.fn();
    const coordinator = new ToolingHostCoordinator({ launcher: { launch } });

    await expect(
      coordinator.start({ ...spawnRequest, mode: "auto" }),
    ).rejects.toThrow("requires an external endpoint probe");
    expect(coordinator.state).toMatchObject({ kind: "failed" });
    expect(launch).not.toHaveBeenCalled();
  });

  it("falls back from auto to one owned host when external LSP is unavailable", async () => {
    const host = createOwnedHost(52000, 52001);
    const launch = vi.fn().mockResolvedValue(host);
    const coordinator = new ToolingHostCoordinator({ launcher: { launch } });

    const snapshot = await coordinator.start(
      { ...spawnRequest, mode: "auto" },
      { tryExternal: vi.fn().mockResolvedValue(false) },
    );

    expect(snapshot).toMatchObject({
      ownership: "owned",
      lsp: { port: 52000 },
      dap: { port: 52001 },
    });
    expect(launch).toHaveBeenCalledOnce();
  });

  it("does not publish an external endpoint when auto readiness is cancelled", async () => {
    const probe = deferred<boolean>();
    const coordinator = new ToolingHostCoordinator({
      launcher: { launch: vi.fn() },
    });
    const cancelled = new AbortController();
    const readiness = coordinator.start(
      { ...spawnRequest, mode: "auto" },
      {
        signal: cancelled.signal,
        tryExternal: () => probe.promise,
      },
    );

    cancelled.abort();
    probe.resolve(true);

    await expect(readiness).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(coordinator.state).toEqual({ kind: "idle" }));
  });

  it("rejects a conflicting readiness request while one is in flight", async () => {
    const pendingHost = deferred<OwnedToolingHost>();
    const coordinator = new ToolingHostCoordinator({
      launcher: { launch: vi.fn().mockReturnValue(pendingHost.promise) },
    });
    const first = coordinator.start(spawnRequest);

    await expect(
      coordinator.start({ ...spawnRequest, project: "/workspace/other" }),
    ).rejects.toThrow("different tooling host");

    pendingHost.resolve(createOwnedHost());
    await first;
  });
});

describe("ToolingHostCoordinator DAP lease and process exit", () => {
  it("notifies lifecycle observers when an owned host invalidates active endpoints", async () => {
    const host = createOwnedHost(52900, 52901);
    const coordinator = new ToolingHostCoordinator({
      launcher: { launch: vi.fn().mockResolvedValue(host) },
    });
    const observed: ToolingHostCoordinatorState[] = [];
    const subscription = coordinator.onStateChange((state) => observed.push(state));
    await coordinator.start(spawnRequest);
    const lease = await coordinator.acquireDapLease();

    host.exit(19);

    const failure = observed.at(-1);
    expect(failure?.kind).toBe("failed");
    if (failure?.kind !== "failed") {
      throw new Error("owned host exit did not publish failure");
    }
    expect(failure.error).toBeInstanceOf(Error);
    expect((failure.error as Error).message).toContain("code 19");
    expect(lease.released).toBe(true);
    subscription.dispose();
  });

  it("rejects a second DAP lease without changing the first", async () => {
    const coordinator = new ToolingHostCoordinator({
      launcher: { launch: vi.fn() },
    });
    await coordinator.start({ ...spawnRequest, mode: "attach" });

    const first = await coordinator.acquireDapLease();
    await expect(coordinator.acquireDapLease()).rejects.toBeInstanceOf(
      DapSessionLeaseUnavailable,
    );
    expect(first.released).toBe(false);
    first.release();
    expect(first.released).toBe(true);
    await expect(coordinator.acquireDapLease()).resolves.toMatchObject({
      endpoint: { port: 6006 },
      released: false,
    });
  });

  it("atomically grants exactly one of two concurrent DAP lease requests", async () => {
    const coordinator = new ToolingHostCoordinator({
      launcher: { launch: vi.fn() },
    });
    await coordinator.start({ ...spawnRequest, mode: "attach" });

    const results = await Promise.allSettled([
      coordinator.acquireDapLease(),
      coordinator.acquireDapLease(),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status !== "rejected") {
      throw new Error("concurrent lease test did not observe a rejection");
    }
    expect(rejection.reason).toBeInstanceOf(DapSessionLeaseUnavailable);
  });

  it("does not create a lease when cancellation wins during startup", async () => {
    const pendingHost = deferred<OwnedToolingHost>();
    const coordinator = new ToolingHostCoordinator({
      launcher: { launch: vi.fn().mockReturnValue(pendingHost.promise) },
    });
    const startup = coordinator.start(spawnRequest);
    const cancelled = new AbortController();
    const lease = coordinator.acquireDapLease(cancelled.signal);
    cancelled.abort();

    await expect(lease).rejects.toMatchObject({ name: "AbortError" });
    pendingHost.resolve(createOwnedHost());
    await startup;
    await expect(coordinator.acquireDapLease()).resolves.toMatchObject({
      released: false,
    });
  });

  it("does not create a lease when a ready-host request is already cancelled", async () => {
    const coordinator = new ToolingHostCoordinator({
      launcher: { launch: vi.fn() },
    });
    await coordinator.start({ ...spawnRequest, mode: "attach" });
    const cancelled = new AbortController();
    const lease = coordinator.acquireDapLease(cancelled.signal);
    cancelled.abort();

    await expect(lease).rejects.toMatchObject({ name: "AbortError" });
    await expect(coordinator.acquireDapLease()).resolves.toMatchObject({
      released: false,
    });
  });

  it("invalidates owned endpoints on process exit and relaunches on recovery", async () => {
    const firstHost = createOwnedHost(53000, 53001);
    const secondHost = createOwnedHost(54000, 54001);
    const launch = vi
      .fn()
      .mockResolvedValueOnce(firstHost)
      .mockResolvedValueOnce(secondHost);
    const coordinator = new ToolingHostCoordinator({ launcher: { launch } });
    await coordinator.start(spawnRequest);
    const lease = await coordinator.acquireDapLease();

    firstHost.exit(17);

    expect(coordinator.state).toMatchObject({ kind: "failed" });
    expect(lease.released).toBe(true);
    await expect(coordinator.acquireDapLease()).rejects.toThrow(
      "exited unexpectedly",
    );
    await expect(coordinator.start(spawnRequest)).resolves.toMatchObject({
      lsp: { port: 54000 },
      dap: { port: 54001 },
    });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("rejects a lease when host exit wins after readiness but before lease grant", async () => {
    const host = createOwnedHost(55000, 55001);
    const coordinator = new ToolingHostCoordinator({
      launcher: { launch: vi.fn().mockResolvedValue(host) },
    });
    await coordinator.start(spawnRequest);

    const lease = coordinator.acquireDapLease();
    host.exit(41);

    await expect(lease).rejects.toThrow("became stale");
    expect(coordinator.state).toMatchObject({ kind: "failed" });
  });
});
