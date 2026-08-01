import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionFailure,
  ConnectionManager,
  type ConnectionState,
  type LanguageClientHandle,
  type OwnedToolingHost,
  type ToolingHostLauncher,
} from "./connection-manager.js";
import type { TcpEndpoint } from "./transport.js";

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
} {
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
  const clients: LanguageClientHandle[] = [];
  const states: ConnectionState[] = [];
  const output = { appendLine: vi.fn() };
  let launchHost: ReturnType<typeof vi.fn>;
  let launcher: ToolingHostLauncher;

  beforeEach(() => {
    endpoints.length = 0;
    clients.length = 0;
    states.length = 0;
    output.appendLine.mockClear();
    launchHost = vi.fn();
    launcher = { launch: launchHost };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function managerWith(clientQueue: LanguageClientHandle[]): ConnectionManager {
    return new ConnectionManager({
      createClient: (endpoint) => {
        endpoints.push(endpoint);
        const client = clientQueue.shift();
        if (client === undefined) {
          throw new Error("test did not provide enough clients");
        }
        clients.push(client);
        return client;
      },
      launcher,
      onStateChange: (state) => states.push(state),
      output,
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
    expect(manager.ownedToolingHost).toBeUndefined();
  });

  it("spawn connects to one owned host and terminates it on stop", async () => {
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
    expect(manager.ownedToolingHost).toEqual(host.readiness);
    expect(states).toEqual([{ kind: "spawning" }, { kind: "connected" }]);

    await manager.stop();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(host.stop).toHaveBeenCalledOnce();
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

    const snapshot = manager.ownedToolingHost;
    if (snapshot === undefined) {
      throw new Error("spawn did not expose its owned tooling host");
    }
    snapshot.services.splice(0, snapshot.services.length, "mutated");
    snapshot.dapPort = 1;

    expect(manager.ownedToolingHost).toMatchObject({
      services: ["lsp", "dap"],
      lspPort: 49152,
      dapPort: 49153,
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

  it("cleans up an owned host when its language client cannot start", async () => {
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
    expect(host.stop).toHaveBeenCalledOnce();
    expect(manager.ownedToolingHost).toBeUndefined();
  });

  it("still terminates an owned host when client shutdown fails", async () => {
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

    expect(host.stop).toHaveBeenCalledOnce();
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
    await Promise.resolve();
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

  it("replaces only its owned spawned host after server loss", async () => {
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

    firstClient.fireUnexpectedStop();
    await vi.advanceTimersByTimeAsync(500);

    expect(firstHost.stop).toHaveBeenCalledOnce();
    expect(launchHost).toHaveBeenCalledTimes(2);
    expect(manager.ownedToolingHost?.lspPort).toBe(49161);
    await manager.stop();
    expect(secondHost.stop).toHaveBeenCalledOnce();
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
