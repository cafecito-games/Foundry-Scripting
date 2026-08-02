import type { Duplex } from "node:stream";
import {
  DapMessageStream,
  DapTranscript,
  encodeDapRequest,
  withTimeout,
  type DapEvent,
  type DapRequest,
  type DapResponse,
} from "./protocol.js";

interface DapClientOptions {
  readonly responseTimeoutMs: number;
  readonly eventTimeoutMs?: number;
}

interface ReceivedMessage {
  readonly index: number;
  readonly message: DapResponse | DapEvent;
}

export class DapClient {
  private readonly stream = new DapMessageStream();
  private readonly dapTranscript = new DapTranscript();
  private readonly sentRequests = new Map<number, DapRequest>();
  private readonly received: ReceivedMessage[] = [];
  private readonly consumed = new Set<number>();
  private nextSequence = 1;
  private transportError: Error | undefined;

  constructor(
    private readonly transport: Duplex,
    private readonly options: DapClientOptions,
  ) {
    transport.on("data", (chunk: Buffer) => this.accept(chunk));
    transport.on("error", (error: Error) => {
      this.transportError = error;
    });
    transport.on("end", () => {
      this.transportError ??= new Error("DAP transport ended unexpectedly.");
    });
  }

  request(command: string, argumentsValue: Record<string, unknown>): number {
    const request: DapRequest = {
      seq: this.nextSequence++,
      type: "request",
      command,
      arguments: argumentsValue,
    };
    this.sentRequests.set(request.seq, request);
    this.dapTranscript.record("send", request);
    this.transport.write(encodeDapRequest(request));
    return request.seq;
  }

  async response(
    sequence: number,
    timeoutMs = this.options.responseTimeoutMs,
  ): Promise<DapResponse> {
    const request = this.findSentRequest(sequence);
    return this.waitFor(
      () => {
        const found = this.take(
          ({ message }) =>
            message.type === "response" &&
            message.request_seq === sequence,
        );
        return found?.message.type === "response" ? found.message : undefined;
      },
      timeoutMs,
      `${request.command} response (request ${String(sequence)})`,
    );
  }

  async event(
    name: string,
    afterIndex = 0,
    timeoutMs = this.options.eventTimeoutMs ?? 120_000,
  ): Promise<DapEvent> {
    return this.waitFor(
      () => {
        const found = this.take(
          ({ index, message }) =>
            index >= afterIndex &&
            message.type === "event" &&
            message.event === name,
        );
        return found?.message.type === "event" ? found.message : undefined;
      },
      timeoutMs,
      `${name} event`,
    );
  }

  mark(): number {
    return this.received.length;
  }

  receivedMessages(): readonly ReceivedMessage[] {
    return this.received;
  }

  indexOf(message: DapResponse | DapEvent): number {
    return this.received.find((entry) => entry.message === message)?.index ?? -1;
  }

  transcript(): string {
    return this.dapTranscript.format();
  }

  close(): void {
    this.transport.destroy();
  }

  private accept(chunk: Buffer): void {
    try {
      for (const message of this.stream.accept(chunk)) {
        if (message.type === "request") {
          throw new Error(
            `The conformance client cannot service reverse request ${message.command}.`,
          );
        }
        this.dapTranscript.record("receive", message);
        this.received.push({ index: this.received.length, message });
      }
    } catch (error) {
      this.transportError =
        error instanceof Error ? error : new Error(String(error));
    }
  }

  private take(
    predicate: (message: ReceivedMessage) => boolean,
  ): ReceivedMessage | undefined {
    const found = this.received.find(
      (message) => !this.consumed.has(message.index) && predicate(message),
    );
    if (found !== undefined) this.consumed.add(found.index);
    return found;
  }

  private findSentRequest(sequence: number): DapRequest {
    const request = this.sentRequests.get(sequence);
    if (request === undefined) {
      throw new Error(`No DAP request has sequence ${String(sequence)}.`);
    }
    return request;
  }

  private async waitFor<T>(
    read: () => T | undefined,
    timeoutMs: number,
    description: string,
  ): Promise<T> {
    const operation = new Promise<T>((resolve, reject) => {
      const poll = (): void => {
        if (this.transportError !== undefined) {
          reject(this.transportError);
          return;
        }
        const value = read();
        if (value !== undefined) {
          resolve(value);
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    });
    try {
      return await withTimeout(operation, timeoutMs, description);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail}\nDAP transcript:\n${this.transcript()}`, {
        cause: error,
      });
    }
  }
}
