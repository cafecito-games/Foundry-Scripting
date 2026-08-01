import {
  TestAdapterFailure,
  type TestAdapterNegotiationRequest,
} from "./adapter.js";
import type { NegotiatedTestAdapter } from "./capabilities.js";
import type {
  TestAdapterDiscoveryRequest,
} from "./discoverer.js";
import type { TestDiscoveryModel } from "./discovery.js";
import type { TestingState } from "./status.js";

export interface TestingRuntimeConfiguration
  extends TestAdapterNegotiationRequest {
  readonly enabled: boolean;
}

export interface TestingRuntimeOptions {
  readonly negotiate: (
    request: TestAdapterNegotiationRequest,
    signal: AbortSignal,
  ) => Promise<NegotiatedTestAdapter>;
  readonly discover: (
    request: TestAdapterDiscoveryRequest,
    signal: AbortSignal,
  ) => Promise<TestDiscoveryModel>;
  readonly onDiscovery: (project: string, model: TestDiscoveryModel) => void;
  readonly onClear: () => void;
  readonly onState: (state: TestingState) => void;
  readonly lifecycleTimeoutMs?: number;
}

export interface TestingReadyContext {
  readonly configuration: TestingRuntimeConfiguration;
  readonly adapter: NegotiatedTestAdapter;
  readonly model: TestDiscoveryModel;
}

interface ActiveOperation {
  readonly generation: number;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

export class TestingRuntime {
  private generation = 0;
  private configurationKey: string | undefined;
  private configuration: TestingRuntimeConfiguration | undefined;
  private active: ActiveOperation | undefined;
  private readonly operations = new Set<ActiveOperation>();
  private stopped = false;
  private stopPromise: Promise<void> | undefined;
  private currentStateKind: TestingState["kind"] | undefined;
  private ready: TestingReadyContext | undefined;
  private readonly lifecycleTimeoutMs: number;

  constructor(private readonly options: TestingRuntimeOptions) {
    this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? 5_000;
  }

  configure(configuration: TestingRuntimeConfiguration): Promise<void> {
    this.configuration = configuration;
    const key = configurationKey(configuration);
    if (key !== this.configurationKey) {
      this.ready = undefined;
    }
    return this.start(configuration, false);
  }

  refresh(signal?: AbortSignal): Promise<void> {
    const configuration = this.configuration;
    if (configuration === undefined || !configuration.enabled) {
      return Promise.resolve();
    }
    return this.start(configuration, true, signal);
  }

  private start(
    configuration: TestingRuntimeConfiguration,
    force: boolean,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    const key = configurationKey(configuration);
    if (!force && key === this.configurationKey) {
      return Promise.resolve();
    }
    this.configurationKey = key;
    const generation = ++this.generation;
    const previous = this.active;

    if (!configuration.enabled) {
      this.publish({ kind: "disabled" });
      this.options.onClear();
      previous?.controller.abort();
      this.active = undefined;
      return Promise.resolve();
    }

    previous?.controller.abort();
    this.publish({ kind: "negotiating", runner: configuration.runner });
    const controller = new AbortController();
    const disposeExternalSignal = linkAbortSignal(externalSignal, controller);
    const request: TestAdapterNegotiationRequest = {
      enginePath: configuration.enginePath,
      project: configuration.project,
      runner: configuration.runner,
      frameworkArgs: configuration.frameworkArgs,
    };
    const operation = {} as ActiveOperation;
    const completion = this.completeGeneration(
      generation,
      request,
      controller.signal,
      externalSignal,
    ).finally(() => {
      disposeExternalSignal();
      this.operations.delete(operation);
      if (this.active === operation) {
        this.active = undefined;
      }
    });
    Object.assign(operation, {
      generation,
      controller,
      completion,
    });
    this.operations.add(operation);
    this.active = operation;
    return operation.completion;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) {
      return this.stopPromise;
    }
    this.stopped = true;
    this.configurationKey = undefined;
    this.ready = undefined;
    this.generation += 1;
    this.publish({ kind: "disabled" });
    const operations = [...this.operations];
    this.active = undefined;
    for (const operation of operations) {
      operation.controller.abort();
    }
    this.stopPromise = (async () => {
      await settleWithin(
        operations.map((operation) => operation.completion),
        this.lifecycleTimeoutMs,
      );
    })();
    return this.stopPromise;
  }

  readyContext(): TestingReadyContext | undefined {
    return this.ready;
  }

  private async completeGeneration(
    generation: number,
    request: TestAdapterNegotiationRequest,
    signal: AbortSignal,
    externalSignal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      const adapter = await this.options.negotiate(request, signal);
      if (!this.isCurrent(generation) || signal.aborted) {
        this.publishExternalCancellation(generation, externalSignal);
        return;
      }
      this.publish({ kind: "discovering", adapter });
      if (request.project === undefined) {
        throw new TestAdapterFailure(
          "missing_project",
          "Open a Foundry project folder before starting test discovery.",
        );
      }
      const model = await this.options.discover(
        {
          ...request,
          project: request.project,
          protocolVersion: adapter.protocolVersion,
        },
        signal,
      );
      if (!this.isCurrent(generation) || signal.aborted) {
        this.publishExternalCancellation(generation, externalSignal);
        return;
      }
      this.options.onDiscovery(request.project, model);
      if (this.isCurrent(generation)) {
        this.ready = {
          configuration: {
            ...this.configurationFor(request),
            enabled: true,
          },
          adapter,
          model,
        };
        this.publish({
          kind: "ready",
          adapter,
          discoveryErrorCount: model.errorCount,
        });
      }
    } catch (error) {
      if (!this.isCurrent(generation)) {
        return;
      }
      if (isAbortError(error) || signal.aborted) {
        this.publishExternalCancellation(generation, externalSignal);
        return;
      }
      const failure =
        error instanceof TestAdapterFailure
          ? error
          : new TestAdapterFailure(
              "spawn_failed",
              `Foundry test adapter operation failed: ${errorMessage(error)}`,
              { cause: error },
            );
      this.publish({ kind: "error", failure });
    }
  }

  private publishExternalCancellation(
    generation: number,
    externalSignal: AbortSignal | undefined,
  ): void {
    if (
      this.isCurrent(generation) &&
      externalSignal !== undefined &&
      externalSignal.aborted
    ) {
      this.publish({
        kind: "refresh_cancelled",
        ...(this.ready === undefined ? {} : { adapter: this.ready.adapter }),
      });
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  private publish(state: TestingState): void {
    if (state.kind === "disabled" && this.currentStateKind === "disabled") {
      return;
    }
    this.currentStateKind = state.kind;
    this.options.onState(state);
  }

  private configurationFor(
    request: TestAdapterNegotiationRequest,
  ): TestingRuntimeConfiguration {
    return {
      enabled: true,
      enginePath: request.enginePath,
      project: request.project,
      runner: request.runner,
      frameworkArgs: [...request.frameworkArgs],
    };
  }
}

function configurationKey(configuration: TestingRuntimeConfiguration): string {
  return JSON.stringify([
    configuration.enabled,
    configuration.enginePath,
    configuration.project ?? null,
    configuration.runner,
    configuration.frameworkArgs,
  ]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function linkAbortSignal(
  external: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (external === undefined) {
    return () => undefined;
  }
  const onAbort = (): void => controller.abort();
  external.addEventListener("abort", onAbort, { once: true });
  if (external.aborted) {
    controller.abort();
  }
  return () => external.removeEventListener("abort", onAbort);
}

async function settleWithin(
  completions: readonly Promise<void>[],
  timeoutMs: number,
): Promise<void> {
  if (completions.length === 0) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([
    Promise.allSettled(completions).then(() => undefined),
    deadline,
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}
