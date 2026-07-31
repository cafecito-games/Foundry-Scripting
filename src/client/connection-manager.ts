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
  createClient(endpoint: TcpEndpoint): LanguageClientHandle;
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

export class ConnectionManager {
  private activeClient: LanguageClientHandle | undefined;
  private activeHost: OwnedToolingHost | undefined;

  constructor(private readonly options: ConnectionManagerOptions) {}

  get ownedToolingHost(): ToolingHostReadiness | undefined {
    const readiness = this.activeHost?.readiness;
    return readiness === undefined
      ? undefined
      : { ...readiness, services: [...readiness.services] };
  }

  async start({ settings, project }: StartConnectionOptions): Promise<void> {
    if (settings.mode === "off") {
      return;
    }
    if (settings.mode === "attach") {
      await this.attach(settings.port, project);
      return;
    }
    if (settings.mode === "spawn") {
      await this.spawn(settings.enginePath, project);
      return;
    }

    try {
      await this.attach(settings.port, project);
    } catch (error) {
      if (!(error instanceof ConnectionFailure) || error.kind !== "tcp_refused") {
        throw error;
      }
      await this.spawn(settings.enginePath, project);
    }
  }

  async stop(): Promise<void> {
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

  private async attach(port: number, project: string): Promise<void> {
    const client = this.options.createClient({ host: "127.0.0.1", port });
    try {
      await client.start();
      this.activeClient = client;
    } catch (error) {
      await stopAfterFailedStart(client);
      if (hasConnectionRefusedCode(error)) {
        throw new ConnectionFailure("tcp_refused", project, port, error);
      }
      throw error;
    }
  }

  private async spawn(enginePath: string, project: string): Promise<void> {
    const host = await this.options.launcher.launch({ enginePath, project });
    try {
      await this.attach(host.readiness.lspPort, project);
      this.activeHost = host;
    } catch (error) {
      await host.stop();
      throw error;
    }
  }
}
