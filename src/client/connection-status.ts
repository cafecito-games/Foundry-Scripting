import type { ConnectionState } from "./connection-manager.js";

export const CONNECTION_ACTIONS_COMMAND = "foundryScript.connectionActions";
export const RECONNECT_ACTION = "Reconnect Now";
export const OPEN_LOG_ACTION = "Open Log";
export const OPEN_SETTINGS_ACTION = "Open Settings";

export interface ConnectionStatusPresentation {
  text: string;
  tooltip: string;
}

export interface StatusBarItemHandle {
  text: string;
  tooltip?: string;
  command?: string;
}

export interface ConnectionStatusActions {
  showQuickPick(
    items: readonly string[],
    options: { placeHolder: string },
  ): PromiseLike<string | undefined>;
  reconnectNow(): PromiseLike<void>;
  openLog(): void;
  openSettings(): PromiseLike<void>;
}

function formatDelay(delayMs: number): string {
  const seconds = delayMs / 1_000;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

export function renderConnectionState(
  state: ConnectionState,
): ConnectionStatusPresentation {
  switch (state.kind) {
    case "connected":
      return {
        text: "$(plug) FoundryScript: Connected",
        tooltip: "The FoundryScript language server is connected.",
      };
    case "spawning":
      return {
        text: "$(loading~spin) FoundryScript: Spawning",
        tooltip: "Starting an extension-owned Foundry language server.",
      };
    case "retrying":
      return {
        text: `$(sync~spin) FoundryScript: Retrying ${state.attempt}/${state.maxAttempts}`,
        tooltip:
          `Reconnect attempt ${state.attempt} of ${state.maxAttempts} starts ` +
          `in ${formatDelay(state.delayMs)}.`,
      };
    case "disconnected":
      return {
        text: "$(debug-disconnect) FoundryScript: Disconnected",
        tooltip: "The language server is disconnected. Click to reconnect.",
      };
    case "off":
      return {
        text: "$(circle-slash) FoundryScript: Off",
        tooltip: "Language server connections are disabled in settings.",
      };
  }
}

export class ConnectionStatusController {
  private state: ConnectionState = { kind: "disconnected" };

  constructor(
    private readonly item: StatusBarItemHandle,
    private readonly actions: ConnectionStatusActions,
  ) {
    this.item.command = CONNECTION_ACTIONS_COMMAND;
  }

  update(state: ConnectionState): void {
    this.state = { ...state };
    const presentation = renderConnectionState(state);
    this.item.text = presentation.text;
    this.item.tooltip = presentation.tooltip;
  }

  async showActions(): Promise<void> {
    const choices =
      this.state.kind === "off"
        ? [OPEN_SETTINGS_ACTION, OPEN_LOG_ACTION]
        : [RECONNECT_ACTION, OPEN_LOG_ACTION];
    const choice = await this.actions.showQuickPick(choices, {
      placeHolder: "FoundryScript language server",
    });
    if (choice === RECONNECT_ACTION) {
      await this.actions.reconnectNow();
    } else if (choice === OPEN_LOG_ACTION) {
      this.actions.openLog();
    } else if (choice === OPEN_SETTINGS_ACTION) {
      await this.actions.openSettings();
    }
  }
}
