import { once } from "node:events";
import * as net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, MessageTransports } from "vscode-languageclient/node";
import { createTcpServerOptions } from "./transport.js";

function encodeMessage(message: Message): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`),
    body,
  ]);
}

describe("TCP language-server transport", () => {
  const servers: net.Server[] = [];
  const sockets: net.Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    servers.length = 0;
    sockets.length = 0;
  });

  it("connects one socket to the requested host and port for both LSP streams", async () => {
    const server = net.createServer();
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP address");
    }

    const accepted = once(server, "connection");
    const output = { appendLine: vi.fn() };
    const serverOptions = createTcpServerOptions({
      host: "127.0.0.1",
      port: address.port,
      output,
    });

    const streams = await serverOptions();
    const clientSocket = streams.reader as net.Socket;
    const connected = clientSocket.connecting
      ? once(clientSocket, "connect")
      : Promise.resolve();
    const [serverSocket] = (await accepted) as [net.Socket];
    await connected;
    sockets.push(clientSocket, serverSocket);

    expect(streams.reader).toBe(streams.writer);
    expect(clientSocket.remotePort).toBe(address.port);
  });

  it("writes structured connection lifecycle records to the output channel", async () => {
    const server = net.createServer();
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP address");
    }

    const accepted = once(server, "connection");
    const output = { appendLine: vi.fn() };
    const streams = await createTcpServerOptions({
      host: "127.0.0.1",
      port: address.port,
      output,
    })();
    const [serverSocket] = (await accepted) as [net.Socket];
    sockets.push(streams.reader as net.Socket, serverSocket);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const records: unknown[] = output.appendLine.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as unknown,
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          event: "lsp.socket.connecting",
          host: "127.0.0.1",
          port: address.port,
        }),
        expect.objectContaining({
          level: "info",
          event: "lsp.socket.connected",
          host: "127.0.0.1",
          port: address.port,
        }),
      ]),
    );
  });

  it("writes structured error records when the server refuses the connection", async () => {
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP address");
    }
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const output = { appendLine: vi.fn() };
    const streams = await createTcpServerOptions({
      host: "127.0.0.1",
      port: address.port,
      output,
    })();
    const socket = streams.reader as net.Socket;
    sockets.push(socket);
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });

    const records: unknown[] = output.appendLine.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as unknown,
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          event: "lsp.socket.error",
          host: "127.0.0.1",
          port: address.port,
          code: "ECONNREFUSED",
        }),
        expect.objectContaining({
          level: "error",
          event: "lsp.socket.closed",
          host: "127.0.0.1",
          port: address.port,
          hadError: true,
        }),
      ]),
    );
  });

  it("intercepts decoded notifications without swallowing other framed messages", async () => {
    const server = net.createServer();
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP address");
    }
    const accepted = once(server, "connection");
    const interceptNotification = vi.fn(
      (method: string) => method === "fs_client/changeWorkspace",
    );
    const transport = (await createTcpServerOptions({
      host: "127.0.0.1",
      port: address.port,
      output: { appendLine: vi.fn() },
      interceptNotification,
    })()) as MessageTransports;
    const [serverSocket] = (await accepted) as [net.Socket];
    sockets.push(serverSocket);
    const forwarded: Message[] = [];
    const receivedAllFrames = new Promise<void>((resolve) => {
      transport.reader.listen((message) => {
        forwarded.push(message);
        if (forwarded.length === 2) resolve();
      });
    });
    const workspaceNotification = {
      jsonrpc: "2.0",
      method: "fs_client/changeWorkspace",
      params: { path: "/projects/server-project" },
    };
    const unrelatedNotification = {
      jsonrpc: "2.0",
      method: "telemetry/event",
      params: { ready: true },
    };
    const initializeResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: {} },
    };
    const frames = Buffer.concat([
      encodeMessage(workspaceNotification),
      encodeMessage(unrelatedNotification),
      encodeMessage(initializeResponse),
    ]);

    serverSocket.write(frames.subarray(0, 17));
    serverSocket.write(frames.subarray(17));
    await receivedAllFrames;

    expect(interceptNotification).toHaveBeenCalledTimes(2);
    expect(forwarded).toEqual([unrelatedNotification, initializeResponse]);

    transport.reader.dispose();
    transport.writer.end();
  });

  it("destroys a pending language-client socket when startup is aborted", async () => {
    const server = net.createServer();
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP address");
    }
    const accepted = once(server, "connection");
    const controller = new AbortController();
    const streams = await createTcpServerOptions({
      host: "127.0.0.1",
      port: address.port,
      output: { appendLine: vi.fn() },
      signal: controller.signal,
    })();
    const clientSocket = streams.reader as net.Socket;
    const [serverSocket] = (await accepted) as [net.Socket];
    sockets.push(clientSocket, serverSocket);

    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(clientSocket.destroyed).toBe(true);
  });
});
