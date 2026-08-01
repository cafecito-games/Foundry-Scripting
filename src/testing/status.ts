import type {
  TestAdapterFailure,
} from "./adapter.js";
import type { NegotiatedTestAdapter } from "./capabilities.js";

export type TestingState =
  | { readonly kind: "disabled" }
  | { readonly kind: "negotiating"; readonly runner: string }
  | { readonly kind: "discovering"; readonly adapter: NegotiatedTestAdapter }
  | {
      readonly kind: "ready";
      readonly adapter: NegotiatedTestAdapter;
      readonly discoveryErrorCount: number;
    }
  | {
      readonly kind: "refresh_cancelled";
      readonly adapter?: NegotiatedTestAdapter;
    }
  | { readonly kind: "error"; readonly failure: TestAdapterFailure };

export interface TestingStatusPresentation {
  readonly text: string;
  readonly tooltip: string;
}

export interface TestingStatusItem {
  text: string;
  tooltip?: unknown;
  show: () => void;
  dispose: () => void;
}

export function renderTestingState(
  state: Exclude<TestingState, { kind: "disabled" }>,
): TestingStatusPresentation {
  switch (state.kind) {
    case "negotiating":
      return {
        text: "$(loading~spin) Tests: Negotiating",
        tooltip: `Negotiating Foundry test adapter ${state.runner}.`,
      };
    case "discovering":
      return {
        text: "$(loading~spin) Tests: Discovering",
        tooltip:
          `Discovering tests with ${state.adapter.framework.name} ` +
          `using protocol version ${state.adapter.protocolVersion}.`,
      };
    case "ready": {
      const { adapter } = state;
      const metadata =
        `Framework: ${adapter.framework.name}\n` +
        `Framework ID: ${adapter.framework.id}\n` +
        `Framework version: ${adapter.framework.version}\n` +
        `Protocol version: ${adapter.protocolVersion}\n` +
        `Extensions: ${adapter.extensions.join(", ") || "none"}`;
      if (state.discoveryErrorCount > 0) {
        const noun = state.discoveryErrorCount === 1 ? "error" : "errors";
        return {
          text:
            `$(warning) Tests: ${adapter.framework.name} ` +
            `(${state.discoveryErrorCount} discovery ${noun})`,
          tooltip:
            `${metadata}\nDiscovery errors: ${state.discoveryErrorCount}`,
        };
      }
      return {
        text: `$(beaker) Tests: ${adapter.framework.name}`,
        tooltip: metadata,
      };
    }
    case "refresh_cancelled":
      return {
        text: "$(circle-slash) Tests: Refresh cancelled",
        tooltip:
          state.adapter === undefined
            ? "Test discovery refresh was cancelled."
            : `Test discovery refresh was cancelled. Showing ${state.adapter.framework.name} results.`,
      };
    case "error":
      return {
        text: `$(warning) Tests: ${failureStatus(state.failure.kind)}`,
        tooltip: state.failure.message,
      };
  }
}

function failureStatus(kind: TestAdapterFailure["kind"]): string {
  switch (kind) {
    case "legacy_runner":
      return "Unsupported";
    case "incompatible_adapter":
      return "Version mismatch";
    case "malformed_discovery":
    case "incomplete_discovery":
    case "discovery_exit_mismatch":
      return "Discovery failed";
    case "process_crash":
      return "Process crashed";
    case "readiness_timeout":
      return "Timed out";
    default:
      return "Unavailable";
  }
}

export class TestingStatusController {
  private item: TestingStatusItem | undefined;

  constructor(private readonly createItem: () => TestingStatusItem) {}

  update(state: TestingState): void {
    if (state.kind === "disabled") {
      this.disposeItem();
      return;
    }
    const item = this.item ?? this.createItem();
    this.item = item;
    const presentation = renderTestingState(state);
    item.text = presentation.text;
    item.tooltip = presentation.tooltip;
    item.show();
  }

  dispose(): void {
    this.disposeItem();
  }

  private disposeItem(): void {
    this.item?.dispose();
    this.item = undefined;
  }
}
