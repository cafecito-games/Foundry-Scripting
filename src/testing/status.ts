import type {
  TestAdapterFailure,
} from "./adapter.js";
import type { NegotiatedTestAdapter } from "./capabilities.js";

export type TestingState =
  | { readonly kind: "disabled" }
  | { readonly kind: "negotiating"; readonly runner: string }
  | { readonly kind: "ready"; readonly adapter: NegotiatedTestAdapter }
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
    case "ready": {
      const { adapter } = state;
      return {
        text: `$(beaker) Tests: ${adapter.framework.name}`,
        tooltip:
          `Framework: ${adapter.framework.name}\n` +
          `Framework ID: ${adapter.framework.id}\n` +
          `Framework version: ${adapter.framework.version}\n` +
          `Protocol version: ${adapter.protocolVersion}\n` +
          `Extensions: ${adapter.extensions.join(", ") || "none"}`,
      };
    }
    case "error":
      return {
        text: "$(warning) Tests: Unavailable",
        tooltip: state.failure.message,
      };
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
