import type { TcpEndpoint } from "./transport.js";

export type LspMode = "spawn" | "attach" | "auto" | "off";

export interface ConnectionSettings {
  mode: LspMode;
  port: number;
  enginePath: string;
}

export interface LanguageClientHandle {
  start: () => Promise<void>;
  stop: () => Promise<void>;
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

export class ConnectionManager {
  private activeClient: LanguageClientHandle | undefined;
  private activeHost: OwnedToolingHost | undefined;
  private pendingStart: PendingStart | undefined;

  constructor(private readonly options: ConnectionManagerOptions) {}

  get ownedToolingHost(): ToolingHostReadiness | undefined {
    const readiness = this.activeHost?.readiness;
    return readiness === undefined
      ? undefined
      : { ...readiness, services: [...readiness.services] };
  }

  async start({ settings, project }: StartConnectionOptions): Promise<void> {
    const controller = new AbortController();
    const promise = this.startConnection(settings, project, controller.signal);
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
    const pending = this.pendingStart;
    pending?.controller.abort();
    if (pending !== undefined) {
      await pending.promise.catch(() => undefined);
    }

    const client = this.activeClient;
    const host = this.activeHost;
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
}
