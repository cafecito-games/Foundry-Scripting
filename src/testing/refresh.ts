import path from "node:path";

const ignoredComponents = new Set([".git", ".foundry", "build", "dist"]);
const adapterTemporaryPrefix = "foundryscript-test-";

export function isRelevantTestingWorkspacePath(
  project: string,
  changedPath: string,
): boolean {
  const relative = path.relative(project, changedPath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  const components = relative.split(path.sep);
  if (
    components.some(
      (component) =>
        ignoredComponents.has(component) ||
        component.startsWith(adapterTemporaryPrefix),
    )
  ) {
    return false;
  }
  if (relative === "project.foundry") {
    return true;
  }
  return path.extname(relative) === ".fs";
}

export interface TestingRefreshCoordinatorOptions {
  readonly refresh: (signal: AbortSignal | undefined) => Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly debounceMs?: number;
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelTimer?: (timer: unknown) => void;
}

export class TestingRefreshCoordinator {
  private readonly refresh;
  private readonly onError;
  private readonly debounceMs;
  private readonly scheduleTimer;
  private readonly cancelTimer;
  private timer: unknown;
  private generation = 0;
  private inFlight: Promise<void> | undefined;
  private disposed = false;

  constructor(options: TestingRefreshCoordinatorOptions) {
    this.refresh = options.refresh;
    this.onError = options.onError;
    this.debounceMs = options.debounceMs ?? 250;
    this.scheduleTimer =
      options.scheduleTimer ??
      ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    this.cancelTimer =
      options.cancelTimer ??
      ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  workspaceChanged(): void {
    if (this.disposed) {
      return;
    }
    this.cancelPending();
    const generation = this.generation;
    this.timer = this.scheduleTimer(() => {
      void this.runScheduled(generation);
    }, this.debounceMs);
  }

  async explicitRefresh(signal?: AbortSignal): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.cancelPending();
    // Wait for an in-flight scheduled refresh so two refreshes do not run
    // concurrently against the runtime (state stays consistent, but onState
    // side effects and log lines would otherwise fire twice and interleave).
    if (this.inFlight !== undefined) {
      await this.inFlight.catch(() => undefined);
      if (this.disposed) return;
    }
    await this.refresh(signal);
  }

  cancelPending(): void {
    this.generation += 1;
    if (this.timer !== undefined) {
      this.cancelTimer(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelPending();
  }

  private async runScheduled(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) {
      return;
    }
    this.timer = undefined;
    // Wait for a previous in-flight refresh so scheduled runs stay serialized.
    if (this.inFlight !== undefined) {
      await this.inFlight.catch(() => undefined);
      if (this.disposed || generation !== this.generation) return;
    }
    const promise = this.refresh(undefined);
    this.inFlight = promise;
    try {
      await promise;
    } catch (error) {
      try {
        this.onError?.(error);
      } catch {
        // Refresh diagnostics must not create an unhandled rejection.
      }
    } finally {
      if (this.inFlight === promise) {
        this.inFlight = undefined;
      }
    }
  }
}
