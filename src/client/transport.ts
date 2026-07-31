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
}

export type TcpServerOptionsFactory = () => Promise<
  StreamInfo | MessageTransports
>;

export function createTcpServerOptions({
  host,
  port,
  output,
  interceptNotification,
}: TcpServerOptions): TcpServerOptionsFactory {
  return () => {
    writeLog(output, "info", "lsp.socket.connecting", { host, port });

    const socket = net.connect({ host, port });
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
      writeLog(output, hadError ? "error" : "info", "lsp.socket.closed", {
        host,
        port,
        hadError,
      });
    });

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
