import { createConnection } from "node:net";
import type {
  ToolingEndpoint,
  ToolingHostMode,
} from "../tooling/coordinator.js";

const DEFAULT_DAP_PROBE_TIMEOUT_MS = 2_000;

function abortError(): Error {
  const error = new Error("FoundryScript debug adapter connection was cancelled.");
  error.name = "AbortError";
  return error;
}

export function contextualizeDebugStartupFailure(
  mode: ToolingHostMode,
  project: unknown,
  error: unknown,
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `FoundryScript debug startup failed in ${mode} mode ` +
      `for project ${String(project)}: ${detail} ` +
      "Check FoundryScript Debug output, verify foundryScript.lsp.mode, " +
      "stop the active debug session if one is running, and retry.",
    { cause: error },
  );
}

export function probeLoopbackDebugAdapter(
  endpoint: ToolingEndpoint,
  signal: AbortSignal,
  timeoutMs = DEFAULT_DAP_PROBE_TIMEOUT_MS,
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(abortError());
    const timer = setTimeout(() => {
      const error = Object.assign(
        new Error(
          `Timed out connecting to FoundryScript DAP at ${endpoint.host}:${String(endpoint.port)} after ${String(timeoutMs)} milliseconds.`,
        ),
        { code: "ETIMEDOUT" },
      );
      finish(error);
    }, timeoutMs);

    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}
