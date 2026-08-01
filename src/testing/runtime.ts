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
  private stopped = false;
  private stopPromise: Promise<void> | undefined;
  private currentStateKind: TestingState["kind"] | undefined;
  private ready: TestingReadyContext | undefined;

  constructor(private readonly options: TestingRuntimeOptions) {}

  async configure(configuration: TestingRuntimeConfiguration): Promise<void> {
    this.configuration = configuration;
    await this.start(configuration, false);
  }

  async refresh(): Promise<void> {
    const configuration = this.configuration;
    if (configuration === undefined || !configuration.enabled) {
      return;
    }
    await this.start(configuration, true);
  }

  private async start(
    configuration: TestingRuntimeConfiguration,
    force: boolean,
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    const key = configurationKey(configuration);
    if (!force && key === this.configurationKey) {
      return;
    }
    this.configurationKey = key;
    const generation = ++this.generation;
    this.ready = undefined;
    const previous = this.active;

    if (!configuration.enabled) {
      this.publish({ kind: "disabled" });
      this.options.onClear();
    }
    if (previous !== undefined) {
      previous.controller.abort();
      await previous.completion;
    }
    if (this.stopped || generation !== this.generation || !configuration.enabled) {
      return;
    }

    this.publish({ kind: "negotiating", runner: configuration.runner });
    const controller = new AbortController();
    const request: TestAdapterNegotiationRequest = {
      enginePath: configuration.enginePath,
      project: configuration.project,
      runner: configuration.runner,
      frameworkArgs: configuration.frameworkArgs,
    };
    const operation: ActiveOperation = {
      generation,
      controller,
      completion: this.completeGeneration(generation, request, controller.signal),
    };
    this.active = operation;
    await operation.completion;
    if (this.active === operation) {
      this.active = undefined;
    }
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
    const operation = this.active;
    operation?.controller.abort();
    this.stopPromise = (async () => {
      await operation?.completion;
      if (this.active === operation) {
        this.active = undefined;
      }
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
  ): Promise<void> {
    try {
      const adapter = await this.options.negotiate(request, signal);
      if (!this.isCurrent(generation)) {
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
      if (!this.isCurrent(generation)) {
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
      if (!this.isCurrent(generation) || isAbortError(error)) {
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
