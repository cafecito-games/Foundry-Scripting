export interface DapRequest {
  readonly seq: number;
  readonly type: "request";
  readonly command: string;
  readonly arguments: Record<string, unknown>;
}

export interface DapResponse {
  readonly seq?: number;
  readonly type: "response";
  readonly request_seq: number;
  readonly success: boolean;
  readonly command: string;
  readonly message?: string;
  readonly body?: Record<string, unknown>;
}

export interface DapEvent {
  readonly seq?: number;
  readonly type: "event";
  readonly event: string;
  readonly body?: Record<string, unknown>;
}

export type DapMessage = DapRequest | DapResponse | DapEvent;
export type TranscriptDirection = "send" | "receive";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessage(text: string): DapMessage {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("DAP message is not an object.");
  if (
    parsed.type === "event" &&
    typeof parsed.event === "string"
  ) {
    return parsed as unknown as DapEvent;
  }
  if (
    parsed.type === "response" &&
    typeof parsed.request_seq === "number" &&
    typeof parsed.command === "string" &&
    typeof parsed.success === "boolean"
  ) {
    return parsed as unknown as DapResponse;
  }
  if (
    parsed.type === "request" &&
    typeof parsed.seq === "number" &&
    typeof parsed.command === "string" &&
    isRecord(parsed.arguments)
  ) {
    return parsed as unknown as DapRequest;
  }
  throw new Error(`Unsupported DAP message: ${text}`);
}

export function encodeDapRequest(request: DapRequest): Buffer {
  const body = Buffer.from(JSON.stringify(request));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`),
    body,
  ]);
}

export class DapMessageStream {
  private buffer = Buffer.alloc(0);

  accept(chunk: Buffer): DapMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: DapMessage[] = [];
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return messages;
      const header = this.buffer.subarray(0, headerEnd).toString();
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(
        header,
      );
      if (lengthMatch === null) {
        throw new Error(`DAP frame omitted Content-Length: ${header}`);
      }
      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) return messages;
      const body = this.buffer
        .subarray(bodyStart, bodyStart + contentLength)
        .toString();
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      messages.push(parseMessage(body));
    }
  }
}

export class DapTranscript {
  private readonly entries: Array<{
    readonly direction: TranscriptDirection;
    readonly message: DapMessage;
  }> = [];

  record(direction: TranscriptDirection, message: DapMessage): void {
    this.entries.push({ direction, message });
  }

  format(): string {
    return this.entries
      .map(
        ({ direction, message }) =>
          `[${direction}] ${JSON.stringify(message)}`,
      )
      .join("\n");
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out after ${String(timeoutMs)}ms waiting for ${description}.`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
