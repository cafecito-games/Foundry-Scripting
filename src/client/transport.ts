import * as net from "node:net";
import type { StreamInfo } from "vscode-languageclient/node";
import { type LogOutput, writeLog } from "./logging.js";

export interface TcpEndpoint {
  host: string;
  port: number;
}

export interface TcpServerOptions extends TcpEndpoint {
  output: LogOutput;
}

export type TcpServerOptionsFactory = () => Promise<StreamInfo>;

export function createTcpServerOptions({
  host,
  port,
  output,
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

    return Promise.resolve({ reader: socket, writer: socket });
  };
}
