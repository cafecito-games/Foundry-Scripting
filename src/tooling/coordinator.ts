export type ToolingHostMode = "spawn" | "attach" | "auto" | "off";

export interface ToolingHostRequest {
  readonly mode: ToolingHostMode;
  readonly enginePath: string;
  readonly project: string;
  readonly lspPort: number;
  readonly dapPort: number;
}

export interface ToolingEndpoint {
  readonly host: "127.0.0.1";
  readonly port: number;
}

export interface ToolingHostReadiness {
  readonly project: string;
  readonly pid: number;
  readonly localOnly: true;
  readonly services: readonly string[];
  readonly lspPort: number;
  readonly dapPort: number;
}

export interface DisposableHandle {
  dispose(): void;
}

export interface OwnedToolingHost {
  readonly readiness: ToolingHostReadiness;
  readonly stop: () => Promise<void>;
  readonly onExit: (listener: (code: number | null) => void) => DisposableHandle;
}

export interface HostLaunchRequest {
  readonly enginePath: string;
  readonly project: string;
  readonly signal?: AbortSignal;
}

export interface ToolingHostLauncher {
  launch(request: HostLaunchRequest): Promise<OwnedToolingHost>;
}

export type OwnedToolingHostSnapshot = {
  readonly ownership: "owned";
  readonly project: string;
  readonly pid: number;
  readonly services: readonly string[];
  readonly lsp: ToolingEndpoint;
  readonly dap: ToolingEndpoint;
};

export type ExternalToolingHostSnapshot = {
  readonly ownership: "external";
  readonly project: string;
  readonly lsp: ToolingEndpoint;
  readonly dap: ToolingEndpoint;
};

export type ToolingHostSnapshot =
  | OwnedToolingHostSnapshot
  | ExternalToolingHostSnapshot;

export type ToolingHostCoordinatorState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly request: ToolingHostRequest }
  | {
      readonly kind: "ready-owned";
      readonly snapshot: OwnedToolingHostSnapshot;
    }
  | {
      readonly kind: "ready-external";
      readonly snapshot: ExternalToolingHostSnapshot;
    }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "stopping" };

export interface ToolingHostCoordinatorOptions {
  readonly launcher: ToolingHostLauncher;
  readonly onStateChange?: (state: ToolingHostCoordinatorState) => void;
}

export interface ToolingHostStartOptions {
  readonly signal?: AbortSignal;
  readonly tryExternal?: (endpoint: ToolingEndpoint) => Promise<boolean>;
}

export interface DapSessionLease {
  readonly endpoint: ToolingEndpoint;
  readonly released: boolean;
  release(): void;
  dispose(): void;
}

export class DapSessionLeaseUnavailable extends Error {
  constructor() {
    super(
      "A FoundryScript debug session is already active. Stop it before starting another.",
    );
    this.name = "DapSessionLeaseUnavailable";
  }
}

interface PendingAcquisition {
  readonly controller: AbortController;
  readonly promise: Promise<ToolingHostSnapshot>;
  readonly request: ToolingHostRequest;
  waiters: number;
}

function requestsMatch(
  left: ToolingHostRequest,
  right: ToolingHostRequest,
): boolean {
  return (
    left.mode === right.mode &&
    left.enginePath === right.enginePath &&
    left.project === right.project &&
    left.lspPort === right.lspPort &&
    left.dapPort === right.dapPort
  );
}

function cloneRequest(request: ToolingHostRequest): ToolingHostRequest {
  return { ...request };
}

function cloneSnapshot(snapshot: ToolingHostSnapshot): ToolingHostSnapshot {
  if (snapshot.ownership === "owned") {
    return {
      ...snapshot,
      services: [...snapshot.services],
      lsp: { ...snapshot.lsp },
      dap: { ...snapshot.dap },
    };
  }
  return {
    ...snapshot,
    lsp: { ...snapshot.lsp },
    dap: { ...snapshot.dap },
  };
}

function snapshotFromOwned(host: OwnedToolingHost): OwnedToolingHostSnapshot {
  const readiness = host.readiness;
  return {
    ownership: "owned",
    project: readiness.project,
    pid: readiness.pid,
    services: [...readiness.services],
    lsp: { host: "127.0.0.1", port: readiness.lspPort },
    dap: { host: "127.0.0.1", port: readiness.dapPort },
  };
}

function snapshotFromExternal(
  request: ToolingHostRequest,
): ExternalToolingHostSnapshot {
  return {
    ownership: "external",
    project: request.project,
    lsp: { host: "127.0.0.1", port: request.lspPort },
    dap: { host: "127.0.0.1", port: request.dapPort },
  };
}

export class ToolingHostCoordinator {
  private currentState: ToolingHostCoordinatorState = { kind: "idle" };
  private pending: PendingAcquisition | undefined;
  private host: OwnedToolingHost | undefined;
  private hostExitSubscription: DisposableHandle | undefined;
  private readyRequest: ToolingHostRequest | undefined;
  private activeDapLease:
    | { readonly token: symbol; readonly markReleased: () => void }
    | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(private readonly options: ToolingHostCoordinatorOptions) {}

  get state(): ToolingHostCoordinatorState {
    const state = this.currentState;
    if (state.kind === "starting") {
      return { kind: "starting", request: cloneRequest(state.request) };
    }
    if (state.kind === "ready-owned" || state.kind === "ready-external") {
      return { kind: state.kind, snapshot: cloneSnapshot(state.snapshot) } as
        ToolingHostCoordinatorState;
    }
    return { ...state };
  }

  async start(
    request: ToolingHostRequest,
    options: ToolingHostStartOptions = {},
  ): Promise<ToolingHostSnapshot | undefined> {
    if (this.disposed) {
      throw new Error("The Foundry tooling host coordinator is disposed.");
    }
    if (request.mode === "off") {
      return undefined;
    }
    if (this.pending !== undefined) {
      if (!requestsMatch(this.pending.request, request)) {
        throw new Error(
          "A different tooling host readiness request is already in progress.",
        );
      }
      return this.waitForPending(this.pending, options.signal);
    }
    if (
      this.currentState.kind === "ready-owned" ||
      this.currentState.kind === "ready-external"
    ) {
      if (
        this.readyRequest === undefined ||
        !requestsMatch(this.readyRequest, request)
      ) {
        throw new Error("A different tooling host is already ready.");
      }
      if (
        this.currentState.kind !== "ready-external" ||
        request.mode !== "auto" ||
        this.activeDapLease !== undefined
      ) {
        return cloneSnapshot(this.currentState.snapshot);
      }
    }

    const controller = new AbortController();
    this.publish({ kind: "starting", request: cloneRequest(request) });
    const promise = Promise.resolve().then(() =>
      this.acquire(request, controller.signal, options.tryExternal),
    );
    const pending = {
      controller,
      promise,
      request: cloneRequest(request),
      waiters: 0,
    };
    this.pending = pending;
    void promise.finally(() => {
      if (this.pending === pending) this.pending = undefined;
    }).catch(() => undefined);
    return this.waitForPending(pending, options.signal);
  }

  async acquireDapLease(signal?: AbortSignal): Promise<DapSessionLease> {
    const snapshot = await this.waitForReady(signal);
    if (signal?.aborted === true) throw abortError();
    if (this.activeDapLease !== undefined) {
      throw new DapSessionLeaseUnavailable();
    }
    const token = Symbol("dap-session");
    let released = false;
    const markReleased = (): void => {
      released = true;
    };
    const release = (): void => {
      if (released) return;
      released = true;
      if (this.activeDapLease?.token === token) {
        this.activeDapLease = undefined;
      }
    };
    const lease: DapSessionLease = {
      endpoint: { ...snapshot.dap },
      get released() {
        return released;
      },
      release,
      dispose: release,
    };
    this.activeDapLease = { token, markReleased };
    return lease;
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    const disposal = this.disposeOnce();
    this.disposal = disposal;
    return disposal;
  }

  private async disposeOnce(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.pending;
    pending?.controller.abort();
    await pending?.promise.catch(() => undefined);

    if (this.currentState.kind !== "idle") {
      this.publish({ kind: "stopping" });
    }
    const host = this.host;
    this.releaseActiveDapLease();
    this.host = undefined;
    this.readyRequest = undefined;
    this.hostExitSubscription?.dispose();
    this.hostExitSubscription = undefined;
    try {
      await host?.stop();
    } finally {
      if (this.currentState.kind !== "idle") {
        this.publish({ kind: "idle" });
      }
    }
  }

  private async acquire(
    request: ToolingHostRequest,
    signal: AbortSignal,
    tryExternal: ToolingHostStartOptions["tryExternal"],
  ): Promise<ToolingHostSnapshot> {
    try {
      if (request.mode === "attach") {
        const snapshot = snapshotFromExternal(request);
        this.readyRequest = cloneRequest(request);
        this.publish({ kind: "ready-external", snapshot });
        return cloneSnapshot(snapshot);
      }
      if (request.mode === "auto") {
        if (tryExternal === undefined) {
          throw new Error(
            "Foundry tooling host auto mode requires an external endpoint probe.",
          );
        }
        const external = snapshotFromExternal(request);
        const externalReady = await tryExternal(external.lsp);
        if (signal.aborted) throw abortError();
        if (externalReady) {
          const snapshot = snapshotFromExternal(request);
          this.readyRequest = cloneRequest(request);
          this.publish({ kind: "ready-external", snapshot });
          return cloneSnapshot(snapshot);
        }
      }
      const host = await this.options.launcher.launch({
        enginePath: request.enginePath,
        project: request.project,
        signal,
      });
      if (signal.aborted) {
        await host.stop();
        throw abortError();
      }
      this.host = host;
      this.readyRequest = cloneRequest(request);
      this.hostExitSubscription = host.onExit((code) => {
        if (this.host !== host) return;
        this.host = undefined;
        this.readyRequest = undefined;
        this.hostExitSubscription?.dispose();
        this.hostExitSubscription = undefined;
        this.releaseActiveDapLease();
        this.publish({
          kind: "failed",
          error: new Error(
            `Foundry tooling host exited unexpectedly with code ${String(code)}.`,
          ),
        });
      });
      const snapshot = snapshotFromOwned(host);
      this.publish({ kind: "ready-owned", snapshot });
      return cloneSnapshot(snapshot);
    } catch (error) {
      if (signal.aborted) {
        this.readyRequest = undefined;
        this.publish({ kind: "idle" });
        throw abortError();
      }
      this.readyRequest = undefined;
      this.publish({ kind: "failed", error });
      throw error;
    }
  }

  private async waitForPending(
    pending: PendingAcquisition,
    signal?: AbortSignal,
  ): Promise<ToolingHostSnapshot> {
    pending.waiters += 1;
    try {
      return await waitWithCancellation(pending.promise, signal);
    } finally {
      pending.waiters -= 1;
      if (pending.waiters === 0 && this.pending === pending) {
        pending.controller.abort();
      }
    }
  }

  private async waitForReady(
    signal?: AbortSignal,
  ): Promise<ToolingHostSnapshot> {
    const state = this.currentState;
    if (state.kind === "ready-owned" || state.kind === "ready-external") {
      if (signal?.aborted === true) throw abortError();
      return cloneSnapshot(state.snapshot);
    }
    if (this.pending !== undefined) {
      return this.waitForPending(this.pending, signal);
    }
    if (state.kind === "failed") {
      throw state.error;
    }
    throw new Error("The Foundry tooling host is not ready.");
  }

  private releaseActiveDapLease(): void {
    this.activeDapLease?.markReleased();
    this.activeDapLease = undefined;
  }

  private publish(state: ToolingHostCoordinatorState): void {
    this.currentState = state;
    this.options.onStateChange?.(this.state);
  }
}

function abortError(): Error {
  const error = new Error("Foundry tooling host readiness was cancelled.");
  error.name = "AbortError";
  return error;
}

function waitWithCancellation<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
