import type { TcpEndpoint } from "./transport.js";
import {
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs,
  reconnectDelayWithJitter,
} from "./retry-policy.js";
import { type LogOutput, writeLog } from "./logging.js";
import type {
  ToolingHostCoordinator,
  ToolingHostRequest,
} from "../tooling/coordinator.js";
import {
  validateConnectionSettings,
  type ConnectionSettings,
} from "./settings.js";

export type { ConnectionSettings, LspMode } from "./settings.js";

export interface LanguageClientHandle {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onUnexpectedStop: (listener: () => void) => DisposableHandle;
}

export interface DisposableHandle {
  dispose(): void;
}

export type ConnectionState =
  | { readonly kind: "connected" }
  | { readonly kind: "spawning" }
  | {
      readonly kind: "retrying";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
    }
  | { readonly kind: "disconnected" }
  | { readonly kind: "off" };

export interface RetryScheduler {
  schedule(delayMs: number, callback: () => void): DisposableHandle;
}

export type ConnectionFailureKind = "tcp_refused" | "initialization_timeout";

export class ConnectionFailure extends Error {
  constructor(
    readonly kind: ConnectionFailureKind,
    readonly project: string,
    readonly port: number,
    cause?: unknown,
    readonly initializationTimeoutMs?: number,
  ) {
    super(
      kind === "tcp_refused"
        ? `Could not connect to the Foundry language server for "${project}" ` +
            `on 127.0.0.1:${port} (connection refused).`
        : `Foundry language server initialization for "${project}" on ` +
            `127.0.0.1:${port} did not complete within ${initializationTimeoutMs} ms.`,
      { cause },
    );
    this.name = "ConnectionFailure";
  }
}

export interface ConnectionManagerOptions {
  createClient(endpoint: TcpEndpoint, signal: AbortSignal): LanguageClientHandle;
  coordinator: ToolingHostCoordinator;
  scheduler?: RetryScheduler;
  onStateChange?: (state: ConnectionState) => void;
  output?: LogOutput;
  initializationTimeoutMs?: number;
  // Override for jitter; production code leaves this undefined so retry
  // windows are decorrelated from concurrent restarters.
  random?: () => number;
}

export interface StartConnectionOptions {
  settings: ConnectionSettings;
  project: string;
}

function hasConnectionRefusedCode(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "ECONNREFUSED" ||
    (candidate.cause !== undefined &&
      hasConnectionRefusedCode(candidate.cause))
  );
}

async function stopAfterFailedStart(client: LanguageClientHandle): Promise<void> {
  try {
    await client.stop();
  } catch {
    // Preserve the connection failure that made startup fail.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  const error = new Error("Foundry language server startup was cancelled.");
  error.name = "AbortError";
  throw error;
}

function startupCancelledError(): Error {
  const error = new Error("Foundry language server startup was cancelled.");
  error.name = "AbortError";
  return error;
}

interface PendingStart {
  controller: AbortController;
  promise: Promise<void>;
}

const defaultScheduler: RetryScheduler = {
  schedule: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    return { dispose: () => clearTimeout(timer) };
  },
};

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;

export class ConnectionManager {
  private activeClient: LanguageClientHandle | undefined;
  private activeClientStopSubscription: DisposableHandle | undefined;
  private pendingStart: PendingStart | undefined;
  private startOptions: StartConnectionOptions | undefined;
  private generation = 0;
  private retryTimer: DisposableHandle | undefined;
  private pendingCleanup: Promise<void> = Promise.resolve();
  // Tracks the most recent attempt number used by the retry schedule. A
  // connection that drops before stabilization continues the backoff from
  // where it left off, instead of resetting to attempt 1 on every flap.
  private retryAttempt = 0;
  private lastConnectedAt: number | undefined;
  private readonly scheduler: RetryScheduler;
  private readonly initializationTimeoutMs: number;
  private readonly random: () => number;

  constructor(private readonly options: ConnectionManagerOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.initializationTimeoutMs =
      options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
    this.random = options.random ?? Math.random;
  }

  async start({ settings, project }: StartConnectionOptions): Promise<void> {
    if (
      this.pendingStart !== undefined ||
      this.activeClient !== undefined
    ) {
      throw new Error("A Foundry language server connection is already active.");
    }
    const validatedSettings = validateConnectionSettings(settings);
    this.startOptions = { settings: validatedSettings, project };
    const generation = ++this.generation;
    if (validatedSettings.mode === "off") {
      this.publish({ kind: "off" });
    }
    const controller = new AbortController();
    const promise = this.startConnection(
      validatedSettings,
      project,
      controller.signal,
    );
    const pending = { controller, promise };
    this.pendingStart = pending;
    try {
      await promise;
      if (generation === this.generation && validatedSettings.mode !== "off") {
        this.markConnected();
        this.publish({ kind: "connected" });
      }
    } catch (error) {
      if (generation === this.generation) {
        this.publish({ kind: "disconnected" });
      }
      throw error;
    } finally {
      if (this.pendingStart === pending) {
        this.pendingStart = undefined;
      }
    }
  }

  private async startConnection(
    settings: ConnectionSettings,
    project: string,
    signal: AbortSignal,
  ): Promise<void> {
    const request: ToolingHostRequest = {
      mode: settings.mode,
      enginePath: settings.enginePath,
      project,
      lspPort: settings.port,
      dapPort: settings.dapPort,
    };
    if (settings.mode === "off") {
      await this.options.coordinator.start(request, { signal });
      return;
    }
    if (settings.mode !== "auto") {
      if (settings.mode === "spawn") this.publish({ kind: "spawning" });
      const snapshot = await this.options.coordinator.start(request, { signal });
      if (snapshot === undefined) return;
      await this.attach(snapshot.lsp.port, project, signal);
      return;
    }

    let attachedExternal = false;
    const snapshot = await this.options.coordinator.start(request, {
      signal,
      tryExternal: async (endpoint) => {
        try {
          await this.attach(endpoint.port, project, signal);
          attachedExternal = true;
          return true;
        } catch (error) {
          throwIfAborted(signal);
          if (
            !(error instanceof ConnectionFailure) ||
            error.kind !== "tcp_refused"
          ) {
            throw error;
          }
          this.publish({ kind: "spawning" });
          return false;
        }
      },
    });
    if (!attachedExternal && snapshot !== undefined) {
      await this.attach(snapshot.lsp.port, project, signal);
    }
  }

  async stop(): Promise<void> {
    ++this.generation;
    this.startOptions = undefined;
    this.retryTimer?.dispose();
    this.retryTimer = undefined;
    this.retryAttempt = 0;
    this.lastConnectedAt = undefined;
    const pending = this.pendingStart;
    pending?.controller.abort();
    if (pending !== undefined) {
      await pending.promise.catch(() => undefined);
    }
    await this.pendingCleanup.catch(() => undefined);

    const client = this.activeClient;
    this.activeClientStopSubscription?.dispose();
    this.activeClientStopSubscription = undefined;
    this.activeClient = undefined;
    if (client !== undefined) {
      await client.stop();
    }
  }

  async reconnectNow(): Promise<void> {
    const startOptions = this.startOptions;
    if (startOptions === undefined || startOptions.settings.mode === "off") {
      return;
    }
    const generation = ++this.generation;
    this.retryTimer?.dispose();
    this.retryTimer = undefined;
    // Clear startOptions before awaiting so an unexpected stop on the active
    // client cannot demote this explicit "Reconnect Now" into a background
    // retry. handleUnexpectedStop observes startOptions === undefined and
    // skips its own scheduleRetry; we restore startOptions before invoking
    // runConnectionAttempt if the generation is still current.
    this.startOptions = undefined;
    this.publish({
      kind: "retrying",
      attempt: 1,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      delayMs: 0,
    });

    const pending = this.pendingStart;
    pending?.controller.abort();
    if (pending !== undefined) {
      await pending.promise.catch(() => undefined);
    }
    await this.pendingCleanup.catch(() => undefined);
    await this.releaseActiveResources().catch(() => undefined);
    if (generation !== this.generation) {
      return;
    }
    this.startOptions = startOptions;

    try {
      await this.runConnectionAttempt(startOptions, generation);
      if (generation === this.generation) {
        this.markConnected();
        this.publish({ kind: "connected" });
      }
    } catch (error) {
      if (generation === this.generation) {
        this.logRetryFailure(1, error);
        this.scheduleRetry(2, generation, startOptions);
      }
    }
  }

  private async attach(
    port: number,
    project: string,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const startupController = new AbortController();
    const cancelStartup = () => startupController.abort(signal.reason);
    const client = this.options.createClient(
      { host: "127.0.0.1", port },
      startupController.signal,
    );
    signal.addEventListener("abort", cancelStartup, { once: true });
    if (signal.aborted) {
      cancelStartup();
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectCancellation: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectCancellation = () => reject(startupCancelledError());
      if (signal.aborted) {
        rejectCancellation();
        return;
      }
      signal.addEventListener("abort", rejectCancellation, { once: true });
      timeout = setTimeout(() => {
        reject(
          new ConnectionFailure(
            "initialization_timeout",
            project,
            port,
            undefined,
            this.initializationTimeoutMs,
          ),
        );
        startupController.abort();
      }, this.initializationTimeoutMs);
    });
    try {
      await Promise.race([client.start(), interrupted]);
      throwIfAborted(signal);
      this.activeClient = client;
      this.activeClientStopSubscription = client.onUnexpectedStop(() => {
        this.handleUnexpectedStop(client);
      });
    } catch (error) {
      await stopAfterFailedStart(client);
      if (hasConnectionRefusedCode(error)) {
        throw new ConnectionFailure("tcp_refused", project, port, error);
      }
      throw error;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (rejectCancellation !== undefined) {
        signal.removeEventListener("abort", rejectCancellation);
      }
      signal.removeEventListener("abort", cancelStartup);
    }
  }

  private handleUnexpectedStop(client: LanguageClientHandle): void {
    const startOptions = this.startOptions;
    if (client !== this.activeClient || startOptions === undefined) {
      return;
    }
    const generation = ++this.generation;
    // If the previous connection stabilized, reset the backoff cadence. If it
    // never did (flapping server), continue from the prior attempt so the
    // schedule escalates instead of looping forever at attempt 1.
    const stabilized =
      this.lastConnectedAt !== undefined &&
      Date.now() - this.lastConnectedAt >= this.initializationTimeoutMs;
    const nextAttempt = stabilized ? 1 : Math.max(1, this.retryAttempt + 1);
    this.scheduleRetry(nextAttempt, generation, startOptions, () => {
      const cleanup = this.releaseActiveResources().catch((error: unknown) => {
        this.log("warn", "lsp.connection.cleanup_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      this.pendingCleanup = cleanup;
      return cleanup;
    });
  }

  private markConnected(): void {
    this.lastConnectedAt = Date.now();
    this.retryAttempt = 0;
  }

  private scheduleRetry(
    attempt: number,
    generation: number,
    startOptions: StartConnectionOptions,
    startCleanup?: () => Promise<void>,
  ): void {
    this.retryAttempt = attempt;
    const nominalDelayMs = reconnectDelayMs(attempt);
    if (nominalDelayMs === undefined) {
      this.publish({ kind: "disconnected" });
      this.log("warn", "lsp.connection.retry_exhausted", {
        attempt: MAX_RECONNECT_ATTEMPTS,
      });
      return;
    }
    // Publish the nominal delay so the tooltip stays readable and tests stay
    // deterministic, but schedule with jitter so concurrent VS Code windows
    // or supervisors do not stay in lockstep indefinitely.
    const scheduledDelayMs = reconnectDelayWithJitter(attempt, this.random);
    this.publish({
      kind: "retrying",
      attempt,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      delayMs: nominalDelayMs,
    });
    this.log("info", "lsp.connection.retry_scheduled", {
      attempt,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      delayMs: scheduledDelayMs,
    });
    const cleanup = startCleanup?.() ?? Promise.resolve();
    this.retryTimer = this.scheduler.schedule(scheduledDelayMs ?? nominalDelayMs, () => {
      this.retryTimer = undefined;
      void cleanup.then(async () => {
        if (generation !== this.generation) {
          return;
        }
        try {
          await this.runConnectionAttempt(startOptions, generation);
          if (generation === this.generation) {
            this.markConnected();
            this.publish({ kind: "connected" });
          }
        } catch (error) {
          if (generation === this.generation) {
            this.logRetryFailure(attempt, error);
            this.scheduleRetry(attempt + 1, generation, startOptions);
          }
        }
      });
    });
  }

  private logRetryFailure(attempt: number, error: unknown): void {
    this.log("warn", "lsp.connection.retry_failed", {
      attempt,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private async runConnectionAttempt(
    startOptions: StartConnectionOptions,
    generation: number,
  ): Promise<void> {
    if (generation !== this.generation) {
      return;
    }
    const controller = new AbortController();
    const promise = this.startConnection(
      startOptions.settings,
      startOptions.project,
      controller.signal,
    );
    const pending = { controller, promise };
    this.pendingStart = pending;
    try {
      await promise;
    } finally {
      if (this.pendingStart === pending) {
        this.pendingStart = undefined;
      }
    }
  }

  private async releaseActiveResources(): Promise<void> {
    const client = this.activeClient;
    this.activeClientStopSubscription?.dispose();
    this.activeClientStopSubscription = undefined;
    this.activeClient = undefined;
    await client?.stop();
  }

  private publish(state: ConnectionState): void {
    this.options.onStateChange?.({ ...state });
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    if (this.options.output !== undefined) {
      writeLog(this.options.output, level, event, fields);
    }
  }
}
