import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  contextualizeDebugStartupFailure,
  probeLoopbackDebugAdapter,
} from "./lifecycle.js";

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.clear();
});

describe("debug adapter lifecycle probe", () => {
  it("adds mode, project, settings, output, and recovery action to startup failures", () => {
    const failure = contextualizeDebugStartupFailure(
      "spawn",
      "/workspace/game",
      new Error("readiness timed out"),
    );

    expect(failure.message).toMatch(
      /spawn mode.*\/workspace\/game.*readiness timed out.*FoundryScript Debug output.*foundryScript\.lsp\.mode.*retry/i,
    );
  });

  it("resolves only after a loopback DAP listener accepts a connection", async () => {
    const server = createServer((socket) => socket.end());
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }

    await expect(
      probeLoopbackDebugAdapter(
        { host: "127.0.0.1", port: address.port },
        new AbortController().signal,
        250,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a refused loopback port within the configured deadline", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(
      probeLoopbackDebugAdapter(
        { host: "127.0.0.1", port: address.port },
        new AbortController().signal,
        250,
      ),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("does not open a socket when cancellation already won", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      probeLoopbackDebugAdapter(
        { host: "127.0.0.1", port: 65000 },
        controller.signal,
        250,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
