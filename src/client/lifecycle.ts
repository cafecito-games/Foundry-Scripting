import type {
  ConnectionSettings,
  ConnectionState,
  StartConnectionOptions,
} from "./connection-manager.js";
import type {
  ProjectResolution,
  ProjectResolutionFailure,
} from "../project/resolver.js";

export interface LifecycleConnectionManager {
  start(options: StartConnectionOptions): Promise<void>;
  stop(): Promise<void>;
  reconnectNow(): Promise<void>;
}

export interface LifecycleCoordinator {
  dispose(): Promise<void>;
}

export interface ConnectionLifecycleOptions<
  TManager extends LifecycleConnectionManager,
  TCoordinator extends LifecycleCoordinator,
> {
  readonly readSettings: () => ConnectionSettings;
  readonly resolveProject: () => Promise<ProjectResolution>;
  readonly createCoordinator: () => TCoordinator;
  readonly createManager: (
    project: string,
    coordinator: TCoordinator,
  ) => TManager;
  readonly publishState: (state: ConnectionState) => void;
  readonly reportProjectFailure: (
    failure: ProjectResolutionFailure,
  ) => void | Promise<void>;
  readonly reportStartupFailure: (
    error: unknown,
    project: string,
  ) => void | Promise<void>;
  readonly logBackgroundFailure: (event: string, error: unknown) => void;
}

export class ConnectionLifecycle<
  TManager extends LifecycleConnectionManager,
  TCoordinator extends LifecycleCoordinator,
> {
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private stopPromise: Promise<void> | undefined;
  private ownedManager: TManager | undefined;
  private ownedCoordinator: TCoordinator | undefined;
  private activeManager: TManager | undefined;
  private activeCoordinator: TCoordinator | undefined;
  private readonly managerStops = new WeakMap<TManager, Promise<void>>();
  private readonly coordinatorDisposals = new WeakMap<
    TCoordinator,
    Promise<void>
  >();

  constructor(
    private readonly options: ConnectionLifecycleOptions<
      TManager,
      TCoordinator
    >,
  ) {}

  get currentManager(): TManager | undefined {
    return this.activeManager;
  }

  get currentCoordinator(): TCoordinator | undefined {
    return this.activeCoordinator;
  }

  requestReconciliation(): Promise<void> {
    if (this.stopped) {
      return this.stopPromise ?? Promise.resolve();
    }
    const generation = ++this.generation;
    this.invalidateManager();
    const work = this.queue.then(() => this.reconcile(generation));
    const observed = work.catch((error: unknown) => {
      this.options.logBackgroundFailure("lsp.lifecycle.reconcile_failed", error);
    });
    this.queue = observed;
    return observed;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    this.stopped = true;
    this.generation += 1;
    this.invalidateManager();
    const stopping = this.queue
      .then(() => this.releaseOwnedResources())
      .catch((error: unknown) => {
        this.options.logBackgroundFailure("lsp.lifecycle.stop_failed", error);
      });
    this.queue = stopping;
    this.stopPromise = stopping;
    return stopping;
  }

  private async reconcile(generation: number): Promise<void> {
    await this.releaseOwnedResources();
    if (!this.isCurrent(generation)) {
      return;
    }

    const settings = { ...this.options.readSettings() };
    if (settings.mode === "off") {
      this.options.publishState({ kind: "off" });
      return;
    }
    this.options.publishState({ kind: "disconnected" });

    const resolution = await this.options.resolveProject();
    if (!this.isCurrent(generation)) {
      return;
    }
    if (!resolution.success) {
      this.notify(
        "lsp.lifecycle.project_notification_failed",
        () => this.options.reportProjectFailure(resolution.failure),
      );
      return;
    }

    const project = resolution.project;
    try {
      const coordinator = this.options.createCoordinator();
      this.ownedCoordinator = coordinator;
      if (!this.isCurrent(generation)) {
        await this.releaseOwnedResources();
        return;
      }
      const manager = this.options.createManager(project, coordinator);
      this.ownedManager = manager;
      if (!this.isCurrent(generation)) {
        await this.releaseOwnedResources();
        return;
      }
      await manager.start({ settings, project });
      if (!this.isCurrent(generation)) {
        await this.releaseOwnedResources();
        return;
      }
      this.activeManager = manager;
      this.activeCoordinator = coordinator;
    } catch (error) {
      await this.releaseOwnedResources();
      if (!this.isCurrent(generation) || isAbortError(error)) {
        return;
      }
      this.notify(
        "lsp.lifecycle.startup_notification_failed",
        () => this.options.reportStartupFailure(error, project),
      );
    }
  }

  private invalidateManager(): void {
    this.activeManager = undefined;
    this.activeCoordinator = undefined;
    const manager = this.ownedManager;
    if (manager !== undefined) {
      void this.stopManager(manager);
    }
  }

  private async releaseOwnedResources(): Promise<void> {
    const manager = this.ownedManager;
    const coordinator = this.ownedCoordinator;
    this.ownedManager = undefined;
    this.ownedCoordinator = undefined;
    this.activeManager = undefined;
    this.activeCoordinator = undefined;
    if (manager !== undefined) {
      await this.stopManager(manager);
    }
    if (coordinator !== undefined) {
      await this.disposeCoordinator(coordinator);
    }
  }

  private stopManager(manager: TManager): Promise<void> {
    const existing = this.managerStops.get(manager);
    if (existing !== undefined) {
      return existing;
    }
    let stopping: Promise<void>;
    try {
      stopping = manager.stop().catch((error: unknown) => {
        this.options.logBackgroundFailure(
          "lsp.lifecycle.manager_stop_failed",
          error,
        );
      });
    } catch (error) {
      this.options.logBackgroundFailure(
        "lsp.lifecycle.manager_stop_failed",
        error,
      );
      stopping = Promise.resolve();
    }
    this.managerStops.set(manager, stopping);
    return stopping;
  }

  private disposeCoordinator(coordinator: TCoordinator): Promise<void> {
    const existing = this.coordinatorDisposals.get(coordinator);
    if (existing !== undefined) {
      return existing;
    }
    const disposal = Promise.resolve()
      .then(() => coordinator.dispose())
      .catch((error: unknown) => {
        this.options.logBackgroundFailure(
          "lsp.lifecycle.coordinator_dispose_failed",
          error,
        );
      });
    this.coordinatorDisposals.set(coordinator, disposal);
    return disposal;
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private notify(event: string, task: () => void | Promise<void>): void {
    void Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        this.options.logBackgroundFailure(event, error);
      });
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
