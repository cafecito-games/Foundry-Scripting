import {
  TestAdapterFailure,
  type TestAdapterNegotiationRequest,
} from "./adapter.js";
import type { NegotiatedTestAdapter } from "./capabilities.js";
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
  readonly onState: (state: TestingState) => void;
}

interface ActiveOperation {
  readonly generation: number;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

export class TestingRuntime {
  private generation = 0;
  private configurationKey: string | undefined;
  private active: ActiveOperation | undefined;
  private stopped = false;
  private stopPromise: Promise<void> | undefined;
  private currentStateKind: TestingState["kind"] | undefined;

  constructor(private readonly options: TestingRuntimeOptions) {}

  async configure(configuration: TestingRuntimeConfiguration): Promise<void> {
    if (this.stopped) {
      return;
    }
    const key = configurationKey(configuration);
    if (key === this.configurationKey) {
      return;
    }
    this.configurationKey = key;
    const generation = ++this.generation;
    const previous = this.active;

    if (!configuration.enabled) {
      this.publish({ kind: "disabled" });
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

  private async completeGeneration(
    generation: number,
    request: TestAdapterNegotiationRequest,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const adapter = await this.options.negotiate(request, signal);
      if (this.isCurrent(generation)) {
        this.publish({ kind: "ready", adapter });
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
              `Foundry test adapter negotiation failed: ${errorMessage(error)}`,
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
