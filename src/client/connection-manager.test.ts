import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionFailure,
  ConnectionManager,
  type LanguageClientHandle,
  type OwnedToolingHost,
  type ToolingHostLauncher,
} from "./connection-manager.js";
import type { TcpEndpoint } from "./transport.js";

function createClient(startError?: unknown): LanguageClientHandle & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn().mockRejectedValueOnce(startError).mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function createSuccessfulClient(): LanguageClientHandle & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function createHost(lspPort = 49152): OwnedToolingHost & {
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    readiness: {
      project: "/workspace/game",
      pid: 1234,
      localOnly: true,
      services: ["lsp"],
      lspPort,
    },
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe("connection modes", () => {
  const endpoints: TcpEndpoint[] = [];
  const clients: LanguageClientHandle[] = [];
  let launchHost: ReturnType<typeof vi.fn>;
  let launcher: ToolingHostLauncher;

  beforeEach(() => {
    endpoints.length = 0;
    clients.length = 0;
    launchHost = vi.fn();
    launcher = { launch: launchHost };
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

    expect(launchHost).toHaveBeenCalledWith({
      enginePath: "/opt/foundry",
      project: "/workspace/game",
    });
    expect(endpoints).toEqual([{ host: "127.0.0.1", port: 49152 }]);
    expect(manager.ownedToolingHost).toEqual(host.readiness);

    await manager.stop();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(host.stop).toHaveBeenCalledOnce();
  });

  it("exposes an isolated owned-host snapshot for future DAP reuse", async () => {
    const client = createSuccessfulClient();
    const host = createHost(49152);
    host.readiness.services = ["lsp", "dap"];
    host.readiness.dapPort = 49153;
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
});
