import type { TcpEndpoint } from "./transport.js";
import {
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs,
} from "./retry-policy.js";
import { type LogOutput, writeLog } from "./logging.js";

export type LspMode = "spawn" | "attach" | "auto" | "off";

export interface ConnectionSettings {
  mode: LspMode;
  port: number;
  enginePath: string;
}

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

export interface ToolingHostReadiness {
  project: string;
  pid: number;
  localOnly: boolean;
  services: string[];
  lspPort: number;
  dapPort?: number;
}

export interface OwnedToolingHost {
  readiness: ToolingHostReadiness;
  stop: () => Promise<void>;
}

export interface HostLaunchRequest {
  enginePath: string;
  project: string;
  signal?: AbortSignal;
}

export interface ToolingHostLauncher {
  launch(request: HostLaunchRequest): Promise<OwnedToolingHost>;
}

export type ConnectionFailureKind = "tcp_refused";

export class ConnectionFailure extends Error {
  constructor(
    readonly kind: ConnectionFailureKind,
    readonly project: string,
    readonly port: number,
    cause?: unknown,
  ) {
    super(
      `Could not connect to the Foundry language server for "${project}" ` +
        `on 127.0.0.1:${port} (connection refused).`,
      { cause },
    );
    this.name = "ConnectionFailure";
  }
}

export interface ConnectionManagerOptions {
  createClient(endpoint: TcpEndpoint, signal: AbortSignal): LanguageClientHandle;
  launcher: ToolingHostLauncher;
  scheduler?: RetryScheduler;
  onStateChange?: (state: ConnectionState) => void;
  output?: LogOutput;
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

export class ConnectionManager {
  private activeClient: LanguageClientHandle | undefined;
  private activeClientStopSubscription: DisposableHandle | undefined;
  private activeHost: OwnedToolingHost | undefined;
  private pendingStart: PendingStart | undefined;
  private startOptions: StartConnectionOptions | undefined;
  private generation = 0;
  private retryTimer: DisposableHandle | undefined;
  private pendingCleanup: Promise<void> = Promise.resolve();
  private readonly scheduler: RetryScheduler;

  constructor(private readonly options: ConnectionManagerOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get ownedToolingHost(): ToolingHostReadiness | undefined {
    const readiness = this.activeHost?.readiness;
    return readiness === undefined
      ? undefined
      : { ...readiness, services: [...readiness.services] };
  }

  async start({ settings, project }: StartConnectionOptions): Promise<void> {
    if (
      this.pendingStart !== undefined ||
      this.activeClient !== undefined ||
      this.activeHost !== undefined
    ) {
      throw new Error("A Foundry language server connection is already active.");
    }
    this.startOptions = { settings, project };
    const generation = ++this.generation;
    if (settings.mode === "off") {
      this.publish({ kind: "off" });
    }
    const controller = new AbortController();
    const promise = this.startConnection(settings, project, controller.signal);
    const pending = { controller, promise };
    this.pendingStart = pending;
    try {
      await promise;
      if (generation === this.generation && settings.mode !== "off") {
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
    if (settings.mode === "off") {
      return;
    }
    if (settings.mode === "attach") {
      await this.attach(settings.port, project, signal);
      return;
    }
    if (settings.mode === "spawn") {
      await this.spawn(settings.enginePath, project, signal);
      return;
    }

    try {
      await this.attach(settings.port, project, signal);
    } catch (error) {
      throwIfAborted(signal);
      if (!(error instanceof ConnectionFailure) || error.kind !== "tcp_refused") {
        throw error;
      }
      await this.spawn(settings.enginePath, project, signal);
    }
  }

  async stop(): Promise<void> {
    ++this.generation;
    this.startOptions = undefined;
    this.retryTimer?.dispose();
    this.retryTimer = undefined;
    const pending = this.pendingStart;
    pending?.controller.abort();
    if (pending !== undefined) {
      await pending.promise.catch(() => undefined);
    }
    await this.pendingCleanup.catch(() => undefined);

    const client = this.activeClient;
    const host = this.activeHost;
    this.activeClientStopSubscription?.dispose();
    this.activeClientStopSubscription = undefined;
    this.activeClient = undefined;
    this.activeHost = undefined;

    try {
      if (client !== undefined) {
        await client.stop();
      }
    } finally {
      if (host !== undefined) {
        await host.stop();
      }
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

    try {
      await this.runConnectionAttempt(startOptions, generation);
      if (generation === this.generation) {
        this.publish({ kind: "connected" });
      }
    } catch {
      if (generation === this.generation) {
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
    const client = this.options.createClient({ host: "127.0.0.1", port }, signal);
    try {
      await client.start();
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
    }
  }

  private async spawn(
    enginePath: string,
    project: string,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    this.publish({ kind: "spawning" });
    const host = await this.options.launcher.launch({
      enginePath,
      project,
      signal,
    });
    try {
      throwIfAborted(signal);
      await this.attach(host.readiness.lspPort, project, signal);
      this.activeHost = host;
    } catch (error) {
      await host.stop();
      throw error;
    }
  }

  private handleUnexpectedStop(client: LanguageClientHandle): void {
    const startOptions = this.startOptions;
    if (client !== this.activeClient || startOptions === undefined) {
      return;
    }
    const generation = ++this.generation;
    const cleanup = this.releaseActiveResources().catch((error: unknown) => {
      this.log("warn", "lsp.connection.cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.pendingCleanup = cleanup;
    this.scheduleRetry(1, generation, startOptions, cleanup);
  }

  private scheduleRetry(
    attempt: number,
    generation: number,
    startOptions: StartConnectionOptions,
    cleanup: Promise<void> = Promise.resolve(),
  ): void {
    const delayMs = reconnectDelayMs(attempt);
    if (delayMs === undefined) {
      this.publish({ kind: "disconnected" });
      this.log("warn", "lsp.connection.retry_exhausted", {
        attempt: MAX_RECONNECT_ATTEMPTS,
      });
      return;
    }
    this.publish({
      kind: "retrying",
      attempt,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      delayMs,
    });
    this.log("info", "lsp.connection.retry_scheduled", {
      attempt,
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      delayMs,
    });
    this.retryTimer = this.scheduler.schedule(delayMs, () => {
      this.retryTimer = undefined;
      void cleanup.then(async () => {
        if (generation !== this.generation) {
          return;
        }
        try {
          await this.runConnectionAttempt(startOptions, generation);
          if (generation === this.generation) {
            this.publish({ kind: "connected" });
          }
        } catch {
          if (generation === this.generation) {
            this.scheduleRetry(attempt + 1, generation, startOptions);
          }
        }
      });
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
    const host = this.activeHost;
    this.activeClientStopSubscription?.dispose();
    this.activeClientStopSubscription = undefined;
    this.activeClient = undefined;
    this.activeHost = undefined;
    try {
      await client?.stop();
    } finally {
      await host?.stop();
    }
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
