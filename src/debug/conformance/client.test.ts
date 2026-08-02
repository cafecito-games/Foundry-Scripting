import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DapClient } from "./client.js";
import { DapMessageStream } from "./protocol.js";

function createTransportPair(): {
  readonly client: Duplex;
  readonly readClientRequest: () => Promise<unknown>;
  readonly sendToClient: (message: Record<string, unknown>) => void;
} {
  const fromClient = new PassThrough();
  const toClient = new PassThrough();
  const client = Duplex.from({ readable: toClient, writable: fromClient });
  const stream = new DapMessageStream();
  const readClientRequest = async (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      fromClient.once("data", (chunk: Buffer) => {
        try {
          resolve(stream.accept(chunk)[0]);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  const sendToClient = (message: Record<string, unknown>): void => {
    const body = Buffer.from(JSON.stringify(message));
    toClient.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`),
        body,
      ]),
    );
  };
  return { client, readClientRequest, sendToClient };
}

describe("DapClient", () => {
  it("correlates bounded responses while retaining intervening events", async () => {
    const pair = createTransportPair();
    const client = new DapClient(pair.client, { responseTimeoutMs: 500 });

    const sequence = client.request("threads", {});
    expect(await pair.readClientRequest()).toEqual({
      seq: sequence,
      type: "request",
      command: "threads",
      arguments: {},
    });
    pair.sendToClient({
      seq: 2,
      type: "event",
      event: "stopped",
      body: { reason: "pause", threadId: 1 },
    });
    pair.sendToClient({
      seq: 3,
      type: "response",
      request_seq: sequence,
      command: "threads",
      success: true,
      body: { threads: [{ id: 1, name: "Main Thread" }] },
    });

    await expect(client.response(sequence)).resolves.toMatchObject({
      request_seq: sequence,
      command: "threads",
      success: true,
    });
    await expect(client.event("stopped")).resolves.toMatchObject({
      event: "stopped",
      body: { reason: "pause", threadId: 1 },
    });
    expect(client.transcript()).toContain('[send] {"seq":1');
    expect(client.transcript()).toContain('[receive] {"seq":2');
    client.close();
  });

  it("adds the full transcript to bounded-wait failures", async () => {
    const pair = createTransportPair();
    const client = new DapClient(pair.client, { responseTimeoutMs: 10 });
    const sequence = client.request("evaluate", { expression: "value" });
    await pair.readClientRequest();

    await expect(client.response(sequence)).rejects.toThrow(
      /Timed out.*evaluate response.*DAP transcript:.*\[send\].*evaluate/s,
    );
    client.close();
  });
});
