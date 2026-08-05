import * as net from "node:net";
import {
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type {
  MessageTransports,
  StreamInfo,
} from "vscode-languageclient/node";
import { type LogOutput, writeLog } from "./logging.js";
import {
  createNotificationInterceptingReader,
  type NotificationInterceptor,
} from "./notification-reader.js";

export interface TcpEndpoint {
  host: string;
  port: number;
}

export interface TcpServerOptions extends TcpEndpoint {
  output: LogOutput;
  interceptNotification?: NotificationInterceptor;
  signal?: AbortSignal;
}

export type TcpServerOptionsFactory = () => Promise<
  StreamInfo | MessageTransports
>;

export function createTcpServerOptions({
  host,
  port,
  output,
  interceptNotification,
  signal,
}: TcpServerOptions): TcpServerOptionsFactory {
  return () => {
    writeLog(output, "info", "lsp.socket.connecting", { host, port });

    const socket = net.connect({ host, port });
    const abort = () => {
      const error = new Error("Foundry language server connection was cancelled.");
      error.name = "AbortError";
      socket.destroy(error);
    };
    socket.on("connect", () => {
      writeLog(output, "info", "lsp.socket.connected", { host, port });
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      writeLog(output, "error", "lsp.socket.error", {
        host,
        port,
        code: error.code,
        message: error.message,
      });
    });
    socket.on("close", (hadError) => {
      signal?.removeEventListener("abort", abort);
      writeLog(output, hadError ? "error" : "info", "lsp.socket.closed", {
        host,
        port,
        hadError,
      });
    });
    // Attach every listener before checking signal.aborted: when the signal is
    // already aborted on entry, abort() synchronously destroys the socket. If
    // the 'error' and 'close' listeners were attached afterwards, Node could
    // emit those events through process.nextTick before the handlers exist and
    // surface them as unhandled emits.
    if (signal?.aborted === true) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }

    if (interceptNotification === undefined) {
      return Promise.resolve({ reader: socket, writer: socket });
    }

    const reader = createNotificationInterceptingReader(
      new StreamMessageReader(socket),
      interceptNotification,
    );
    return Promise.resolve({
      reader,
      writer: new StreamMessageWriter(socket),
    });
  };
}
