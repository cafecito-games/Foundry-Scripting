import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionFailure,
  ConnectionManager,
  type ConnectionState,
  type LanguageClientHandle,
} from "./connection-manager.js";
import type { TcpEndpoint } from "./transport.js";
import {
  ToolingHostCoordinator,
  type OwnedToolingHost,
  type ToolingHostLauncher,
} from "../tooling/coordinator.js";

interface TestClient extends LanguageClientHandle {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  fireUnexpectedStop: () => void;
}

function testClient(start: ReturnType<typeof vi.fn>): TestClient {
  const stopListeners = new Set<() => void>();
  return {
    start,
    stop: vi.fn().mockResolvedValue(undefined),
    onUnexpectedStop: (listener: () => void) => {
      stopListeners.add(listener);
      return { dispose: () => stopListeners.delete(listener) };
    },
    fireUnexpectedStop: () => {
      for (const listener of stopListeners) listener();
    },
  };
}

function createClient(startError?: unknown): TestClient {
  return testClient(
    vi.fn().mockRejectedValueOnce(startError).mockResolvedValue(undefined),
  );
}

function createSuccessfulClient(): TestClient {
  return testClient(vi.fn().mockResolvedValue(undefined));
}

function createHost(lspPort = 49152): OwnedToolingHost & {
  stop: ReturnType<typeof vi.fn>;
  exit: (code?: number | null) => void;
} {
  const exitListeners = new Set<(code: number | null) => void>();
  return {
    readiness: {
      project: "/workspace/game",
      pid: 1234,
      localOnly: true,
      services: ["lsp", "dap"],
      lspPort,
      dapPort: lspPort + 1,
    },
    stop: vi.fn().mockResolvedValue(undefined),
    onExit: (listener) => {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    exit: (code = 1) => {
      for (const listener of exitListeners) listener(code);
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

function connectionRefused(): Error & { code: string } {
  return Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
}

describe("connection modes", () => {
  const endpoints: TcpEndpoint[] = [];
  const signals: AbortSignal[] = [];
  const clients: LanguageClientHandle[] = [];
  const states: ConnectionState[] = [];
  const output = { appendLine: vi.fn() };
  let launchHost: ReturnType<typeof vi.fn>;
  let launcher: ToolingHostLauncher;
  let coordinator: ToolingHostCoordinator;

  beforeEach(() => {
    endpoints.length = 0;
    signals.length = 0;
    clients.length = 0;
    states.length = 0;
    output.appendLine.mockClear();
    launchHost = vi.fn();
    launcher = { launch: launchHost };
    coordinator = new ToolingHostCoordinator({ launcher });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function managerWith(
    clientQueue: LanguageClientHandle[],
    initializationTimeoutMs?: number,
  ): ConnectionManager {
    return new ConnectionManager({
      createClient: (endpoint, signal) => {
        endpoints.push(endpoint);
        signals.push(signal);
        const client = clientQueue.shift();
        if (client === undefined) {
          throw new Error("test did not provide enough clients");
        }
        clients.push(client);
        return client;
      },
      coordinator,
      onStateChange: (state) => states.push(state),
      output,
      initializationTimeoutMs,
    });
  }

  it("off starts no client and launches no host", async () => {
    const manager = managerWith([]);

    await manager.start({
      settings: { mode: "off", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    expect(endpoints).toEqual([]);
    expect(launchHost).not.toHaveBeenCalled();
    expect(states).toEqual([{ kind: "off" }]);
  });

  it("attach connects to the configured loopback port without owning a host", async () => {
    const client = createSuccessfulClient();
    const manager = managerWith([client]);

    await manager.start({
      settings: { mode: "attach", port: 7001, enginePath: "foundry" },
      project: "/workspace/game",
    });
    await manager.stop();

    expect(endpoints).toEqual([{ host: "127.0.0.1", port: 7001 }]);
    expect(client.start).toHaveBeenCalledOnce();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(launchHost).not.toHaveBeenCalled();
    expect(coordinator.state).toMatchObject({ kind: "ready-external" });
  });

  it("spawn connects to one coordinator-owned host without terminating it on LSP stop", async () => {
    const client = createSuccessfulClient();
    const host = createHost(49152);
    launchHost.mockResolvedValue(host);
    const manager = managerWith([client]);

    await manager.start({
      settings: {
        mode: "spawn",
        port: 7001,
        enginePath: "/opt/foundry",
      },
      project: "/workspace/game",
    });

    expect(launchHost).toHaveBeenCalledWith(expect.objectContaining({
      enginePath: "/opt/foundry",
      project: "/workspace/game",
    }));
    expect(endpoints).toEqual([{ host: "127.0.0.1", port: 49152 }]);
    expect(coordinator.state).toMatchObject({
      kind: "ready-owned",
      snapshot: { lsp: { port: 49152 }, dap: { port: 49153 } },
    });
    expect(states).toEqual([{ kind: "spawning" }, { kind: "connected" }]);

    await manager.stop();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(host.stop).not.toHaveBeenCalled();
    await coordinator.dispose();
    expect(host.stop).toHaveBeenCalledOnce();
  });

  it("launches one combined host when LSP and DAP become ready concurrently", async () => {
    const pendingHost = deferred<OwnedToolingHost>();
    const host = createHost(49200);
    launchHost.mockReturnValue(pendingHost.promise);
    const client = createSuccessfulClient();
    const manager = managerWith([client]);

    const lspReadiness = manager.start({
      settings: { mode: "spawn", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });
    const dapReadiness = coordinator.acquireDapLease();
    pendingHost.resolve(host);

    await lspReadiness;
    const lease = await dapReadiness;
    expect(launchHost).toHaveBeenCalledOnce();
    expect(client.start).toHaveBeenCalledOnce();
    expect(endpoints).toEqual([{ host: "127.0.0.1", port: 49200 }]);
    expect(lease.endpoint).toEqual({ host: "127.0.0.1", port: 49201 });
  });

  it("exposes an isolated owned-host snapshot for future DAP reuse", async () => {
    const client = createSuccessfulClient();
    const host = createHost(49152);
    launchHost.mockResolvedValue(host);
    const manager = managerWith([client]);
    await manager.start({
      settings: { mode: "spawn", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    const state = coordinator.state;
    if (state.kind !== "ready-owned") {
      throw new Error("spawn did not expose its owned tooling host");
    }
    const snapshot = state.snapshot;
    (snapshot.services as string[]).splice(0, snapshot.services.length, "mutated");
    (snapshot.dap as { port: number }).port = 1;

    expect(coordinator.state).toMatchObject({
      snapshot: {
        services: ["lsp", "dap"],
        lsp: { port: 49152 },
        dap: { port: 49153 },
      },
    });
    expect(launchHost).toHaveBeenCalledOnce();
  });

  it("auto keeps a successful external attachment", async () => {
    const client = createSuccessfulClient();
    const manager = managerWith([client]);

    await manager.start({
      settings: { mode: "auto", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    expect(endpoints).toEqual([{ host: "127.0.0.1", port: 6005 }]);
    expect(launchHost).not.toHaveBeenCalled();
  });

  it("auto falls back to a spawned host only after connection refusal", async () => {
    const refusal = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6005"), {
      code: "ECONNREFUSED",
    });
    const externalClient = createClient(refusal);
    const spawnedClient = createSuccessfulClient();
    const host = createHost(49153);
    launchHost.mockResolvedValue(host);
    const manager = managerWith([externalClient, spawnedClient]);

    await manager.start({
      settings: { mode: "auto", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    expect(endpoints).toEqual([
      { host: "127.0.0.1", port: 6005 },
      { host: "127.0.0.1", port: 49153 },
    ]);
    expect(externalClient.stop).toHaveBeenCalledOnce();
    expect(spawnedClient.start).toHaveBeenCalledOnce();
    expect(launchHost).toHaveBeenCalledOnce();
  });

  it("auto falls back to an owned host when a cached external endpoint disappears", async () => {
    vi.useFakeTimers();
    const externalClient = createSuccessfulClient();
    const refusedRetry = createClient(connectionRefused());
    const spawnedClient = createSuccessfulClient();
    const host = createHost(49300);
    launchHost.mockResolvedValue(host);
    const manager = managerWith([
      externalClient,
      refusedRetry,
      spawnedClient,
    ]);
    await manager.start({
      settings: { mode: "auto", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    externalClient.fireUnexpectedStop();
    await vi.advanceTimersByTimeAsync(500);

    expect(endpoints).toEqual([
      { host: "127.0.0.1", port: 6005 },
      { host: "127.0.0.1", port: 6005 },
      { host: "127.0.0.1", port: 49300 },
    ]);
    expect(launchHost).toHaveBeenCalledOnce();
    expect(states.at(-1)).toEqual({ kind: "connected" });
  });

  it("auto retries the external endpoint without spawning while its DAP lease remains active", async () => {
    vi.useFakeTimers();
    const externalClient = createSuccessfulClient();
    const refusedRetry = createClient(connectionRefused());
    const manager = managerWith([externalClient, refusedRetry]);
    await manager.start({
      settings: { mode: "auto", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });
    const lease = await coordinator.acquireDapLease();

    externalClient.fireUnexpectedStop();
    await vi.advanceTimersByTimeAsync(500);

    expect(endpoints).toEqual([
      { host: "127.0.0.1", port: 6005 },
      { host: "127.0.0.1", port: 6005 },
    ]);
    expect(launchHost).not.toHaveBeenCalled();
    expect(lease.endpoint).toEqual({ host: "127.0.0.1", port: 6006 });
    expect(lease.released).toBe(false);
    expect(coordinator.state).toMatchObject({ kind: "ready-external" });
    expect(states.at(-1)).toEqual({
      kind: "retrying",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 1000,
    });
  });

  it("auto does not hide non-refusal client failures", async () => {
    const protocolError = new Error("initialize response was invalid");
    const client = createClient(protocolError);
    const manager = managerWith([client]);

    await expect(
      manager.start({
        settings: { mode: "auto", port: 6005, enginePath: "foundry" },
        project: "/workspace/game",
      }),
    ).rejects.toBe(protocolError);
    expect(launchHost).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "attach" as const, endpoint: 6100 },
    { mode: "spawn" as const, endpoint: 49152 },
  ])(
    "$mode bounds language-client initialization and cleans up late settlement",
    async ({ mode, endpoint }) => {
      vi.useFakeTimers();
      const pendingStart = deferred<void>();
      const client = testClient(vi.fn().mockReturnValue(pendingStart.promise));
      if (mode === "spawn") {
        launchHost.mockResolvedValue(createHost(endpoint));
      }
      const manager = managerWith([client], 25);

      const starting = manager
        .start({
          settings: { mode, port: 6100, enginePath: "foundry" },
          project: "/workspace/game",
        })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(client.start).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(25);

      const failure = await starting;
      expect(failure).toBeInstanceOf(ConnectionFailure);
      expect(failure).toMatchObject({
        kind: "initialization_timeout",
        project: "/workspace/game",
        port: endpoint,
      });
      expect((failure as Error).message).toContain("/workspace/game");
      expect((failure as Error).message).toContain(`127.0.0.1:${endpoint}`);
      expect((failure as Error).message).toContain("25 ms");
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(client.stop).toHaveBeenCalledOnce();

      pendingStart.resolve(undefined);
      await vi.runAllTimersAsync();
      await manager.stop();
      expect(client.stop).toHaveBeenCalledOnce();
      expect(states.at(-1)).toEqual({ kind: "disconnected" });
    },
  );

  it("auto does not reinterpret an initialization timeout as spawn fallback", async () => {
    vi.useFakeTimers();
    const pendingStart = deferred<void>();
    const client = testClient(vi.fn().mockReturnValue(pendingStart.promise));
    const manager = managerWith([client], 25);

    const starting = manager
      .start({
        settings: { mode: "auto", port: 6005, enginePath: "foundry" },
        project: "/workspace/game",
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(client.start).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(25);

    await expect(starting).resolves.toMatchObject({
      kind: "initialization_timeout",
    });
    expect(launchHost).not.toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalledOnce();
    pendingStart.resolve(undefined);
  });

  it("reports timeout when abort makes the client reject synchronously", async () => {
    vi.useFakeTimers();
    const client = testClient(vi.fn(() =>
      new Promise<void>((_resolve, reject) => {
        const signal = signals[0];
        if (signal === undefined) {
          throw new Error("client startup signal was not captured");
        }
        signal.addEventListener("abort", () => {
          const error = new Error("client startup aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      })));
    const manager = managerWith([client], 25);

    const starting = manager
      .start({
        settings: { mode: "attach", port: 6005, enginePath: "foundry" },
        project: "/workspace/game",
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);

    await expect(starting).resolves.toMatchObject({
      kind: "initialization_timeout",
    });
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("reports attachment refusal with the project and port", async () => {
    const refusal = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const manager = managerWith([createClient(refusal)]);

    const failure = await manager
      .start({
        settings: { mode: "attach", port: 6100, enginePath: "foundry" },
        project: "/workspace/game",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConnectionFailure);
    expect(failure).toMatchObject({
      kind: "tcp_refused",
      project: "/workspace/game",
      port: 6100,
    });
    expect((failure as Error).message).toContain("/workspace/game");
    expect((failure as Error).message).toContain("6100");
    expect(states.at(-1)).toEqual({ kind: "disconnected" });
  });

  it("retains a living owned host when its language client cannot start", async () => {
    const host = createHost(49154);
    launchHost.mockResolvedValue(host);
    const refusal = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const manager = managerWith([createClient(refusal)]);

    await expect(
      manager.start({
        settings: { mode: "spawn", port: 6005, enginePath: "foundry" },
        project: "/workspace/game",
      }),
    ).rejects.toMatchObject({ kind: "tcp_refused" });
    expect(host.stop).not.toHaveBeenCalled();
    expect(coordinator.state).toMatchObject({ kind: "ready-owned" });
  });

  it("does not terminate an owned host when client shutdown fails", async () => {
    const shutdownError = new Error("client shutdown failed");
    const client = createSuccessfulClient();
    client.stop.mockRejectedValue(shutdownError);
    const host = createHost(49155);
    launchHost.mockResolvedValue(host);
    const manager = managerWith([client]);
    await manager.start({
      settings: { mode: "spawn", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    await expect(manager.stop()).rejects.toBe(shutdownError);

    expect(host.stop).not.toHaveBeenCalled();
  });

  it("cancels startup and terminates a host that becomes ready after stop", async () => {
    const pendingHost = deferred<OwnedToolingHost>();
    const host = createHost(49156);
    launchHost.mockReturnValue(pendingHost.promise);
    const manager = managerWith([createSuccessfulClient()]);

    const starting = manager
      .start({
        settings: { mode: "spawn", port: 6005, enginePath: "foundry" },
        project: "/workspace/game",
      })
      .catch((error: unknown) => error);
    const stopping = manager.stop();
    pendingHost.resolve(host);

    const startFailure = await starting;
    await stopping;
    expect(startFailure).toMatchObject({ name: "AbortError" });
    expect(host.stop).toHaveBeenCalledOnce();
    expect(endpoints).toEqual([]);
  });

  it("cancels a client that finishes starting after stop begins", async () => {
    const pendingStart = deferred<void>();
    const client = createSuccessfulClient();
    client.start.mockReturnValue(pendingStart.promise);
    const manager = managerWith([client]);

    const starting = manager
      .start({
        settings: { mode: "attach", port: 6005, enginePath: "foundry" },
        project: "/workspace/game",
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(client.start).toHaveBeenCalledOnce());
    const stopping = manager.stop();
    pendingStart.resolve(undefined);

    const startFailure = await starting;
    await stopping;
    expect(startFailure).toMatchObject({ name: "AbortError" });
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("rejects a second start instead of orphaning the active connection", async () => {
    const firstClient = createSuccessfulClient();
    const unusedClient = createSuccessfulClient();
    const manager = managerWith([firstClient, unusedClient]);
    await manager.start({
      settings: { mode: "attach", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    await expect(
      manager.start({
        settings: { mode: "attach", port: 6006, enginePath: "foundry" },
        project: "/workspace/other",
      }),
    ).rejects.toThrow("already active");

    expect(unusedClient.start).not.toHaveBeenCalled();
    await manager.stop();
    expect(firstClient.stop).toHaveBeenCalledOnce();
  });

  it("publishes loss immediately and reconnects on the exact first backoff", async () => {
    vi.useFakeTimers();
    const firstClient = createSuccessfulClient();
    const stateSeenWhenCleanupStarts: Array<ConnectionState["kind"] | "none"> =
      [];
    firstClient.stop.mockImplementation(() => {
      stateSeenWhenCleanupStarts.push(states.at(-1)?.kind ?? "none");
      return Promise.resolve();
    });
    const secondClient = createSuccessfulClient();
    const manager = managerWith([firstClient, secondClient]);
    await manager.start({
      settings: { mode: "attach", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    firstClient.fireUnexpectedStop();
    expect(states.at(-1)).toEqual({
      kind: "retrying",
      attempt: 1,
      maxAttempts: 5,
      delayMs: 500,
    });
    expect(stateSeenWhenCleanupStarts).toEqual(["retrying"]);
    await vi.advanceTimersByTimeAsync(499);
    expect(secondClient.start).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(secondClient.start).toHaveBeenCalledOnce();
    expect(states.at(-1)).toEqual({ kind: "connected" });
    await manager.stop();
  });

  it("exhausts five attempts and leaves no hidden retry", async () => {
    vi.useFakeTimers();
    const firstClient = createSuccessfulClient();
    const failedClients = Array.from({ length: 5 }, () =>
      createClient(connectionRefused()),
    );
    const manager = managerWith([firstClient, ...failedClients]);
    await manager.start({
      settings: { mode: "attach", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    firstClient.fireUnexpectedStop();
    await vi.advanceTimersByTimeAsync(15_500);

    expect(states.at(-1)).toEqual({ kind: "disconnected" });
    expect(clients).toHaveLength(6);
    const records = output.appendLine.mock.calls.map(
      ([line]) =>
        JSON.parse(String(line)) as {
          event?: string;
          attempt?: number;
          message?: string;
        },
    );
    expect(records.filter((record) => record.event === "lsp.connection.retry_scheduled"))
      .toHaveLength(5);
    expect(records.at(-1)).toMatchObject({
      event: "lsp.connection.retry_exhausted",
      attempt: 5,
    });
    const failures = records.filter(
      (record) => record.event === "lsp.connection.retry_failed",
    );
    expect(failures).toHaveLength(5);
    expect(failures[0]?.message).toContain("connection refused");
    await vi.runAllTimersAsync();
    expect(clients).toHaveLength(6);
    await manager.stop();
  });

  it("manual reconnect cancels the timer and starts immediately", async () => {
    vi.useFakeTimers();
    const firstClient = createSuccessfulClient();
    const secondClient = createSuccessfulClient();
    const manager = managerWith([firstClient, secondClient]);
    await manager.start({
      settings: { mode: "attach", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });
    firstClient.fireUnexpectedStop();

    await manager.reconnectNow();

    expect(secondClient.start).toHaveBeenCalledOnce();
    expect(states.at(-1)).toEqual({ kind: "connected" });
    await vi.advanceTimersByTimeAsync(500);
    expect(clients).toHaveLength(2);
    await manager.stop();
  });

  it("still retries when cleanup of the dead client fails", async () => {
    vi.useFakeTimers();
    const firstClient = createSuccessfulClient();
    firstClient.stop.mockRejectedValue(new Error("dead client cleanup failed"));
    const secondClient = createSuccessfulClient();
    const manager = managerWith([firstClient, secondClient]);
    await manager.start({
      settings: { mode: "attach", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    firstClient.fireUnexpectedStop();
    await vi.advanceTimersByTimeAsync(500);

    expect(secondClient.start).toHaveBeenCalledOnce();
    expect(states.at(-1)).toEqual({ kind: "connected" });
    await manager.stop();
  });

  it("reuses its living owned host after isolated LSP loss", async () => {
    vi.useFakeTimers();
    const firstClient = createSuccessfulClient();
    const secondClient = createSuccessfulClient();
    const firstHost = createHost(49160);
    const secondHost = createHost(49161);
    launchHost.mockResolvedValueOnce(firstHost).mockResolvedValueOnce(secondHost);
    const manager = managerWith([firstClient, secondClient]);
    await manager.start({
      settings: { mode: "spawn", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });
    const lease = await coordinator.acquireDapLease();

    firstClient.fireUnexpectedStop();
    await vi.advanceTimersByTimeAsync(500);

    expect(firstHost.stop).not.toHaveBeenCalled();
    expect(launchHost).toHaveBeenCalledOnce();
    expect(endpoints.at(-1)).toEqual({ host: "127.0.0.1", port: 49160 });
    expect(lease.endpoint).toEqual({ host: "127.0.0.1", port: 49161 });
    expect(lease.released).toBe(false);
    await manager.stop();
    expect(secondHost.stop).not.toHaveBeenCalled();
  });

  it("recovers a new owned endpoint after the coordinator observes host exit", async () => {
    vi.useFakeTimers();
    const firstClient = createSuccessfulClient();
    const secondClient = createSuccessfulClient();
    const firstHost = createHost(55100);
    const secondHost = createHost(55200);
    launchHost.mockResolvedValueOnce(firstHost).mockResolvedValueOnce(secondHost);
    const manager = managerWith([firstClient, secondClient]);
    await manager.start({
      settings: { mode: "spawn", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    firstHost.exit(17);
    firstClient.fireUnexpectedStop();
    await vi.advanceTimersByTimeAsync(500);

    expect(launchHost).toHaveBeenCalledTimes(2);
    expect(endpoints.at(-1)).toEqual({ host: "127.0.0.1", port: 55200 });
    expect(states.at(-1)).toEqual({ kind: "connected" });
  });

  it("cancels a pending reconnect when the manager stops", async () => {
    vi.useFakeTimers();
    const firstClient = createSuccessfulClient();
    const unusedClient = createSuccessfulClient();
    const manager = managerWith([firstClient, unusedClient]);
    await manager.start({
      settings: { mode: "attach", port: 6005, enginePath: "foundry" },
      project: "/workspace/game",
    });

    firstClient.fireUnexpectedStop();
    await manager.stop();
    await vi.runAllTimersAsync();

    expect(unusedClient.start).not.toHaveBeenCalled();
    expect(clients).toHaveLength(1);
  });
});
