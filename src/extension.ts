import * as vscode from "vscode";
import {
  type ConnectionManager,
  type ConnectionSettings,
} from "./client/connection-manager.js";
import {
  CONNECTION_ACTIONS_COMMAND,
  ConnectionStatusController,
} from "./client/connection-status.js";
import { HostStartupFailure } from "./client/host-launcher.js";
import { writeLog } from "./client/logging.js";
import { createConnectionManager } from "./client/runtime.js";
import { registerFoundryTaskProvider } from "./tasks/provider.js";

let activeConnectionManager: ConnectionManager | undefined;

function readConnectionSettings(): ConnectionSettings {
  const configuration = vscode.workspace.getConfiguration("foundryScript");
  return {
    mode: configuration.get("lsp.mode", "spawn"),
    port: configuration.get("lsp.port", 6005),
    enginePath: configuration.get("enginePath", "foundry"),
  };
}

async function showStartupError(error: unknown): Promise<void> {
  const message =
    error instanceof Error
      ? error.message
      : `Foundry language server startup failed: ${String(error)}`;
  if (error instanceof HostStartupFailure && error.kind === "missing_engine") {
    const selection = await vscode.window.showErrorMessage(
      message,
      "Open Settings",
    );
    if (selection === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "foundryScript.enginePath",
      );
    }
    return;
  }
  await vscode.window.showErrorMessage(message);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerFoundryTaskProvider(context);
  const outputChannel = vscode.window.createOutputChannel("FoundryScript LSP");
  context.subscriptions.push(outputChannel);
  const settings = readConnectionSettings();
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  const statusController = new ConnectionStatusController(statusItem, {
    showQuickPick: (items, options) =>
      vscode.window.showQuickPick(items, options),
    reconnectNow: async () => {
      if (activeConnectionManager !== undefined) {
        await activeConnectionManager.reconnectNow();
      } else {
        await vscode.commands.executeCommand("vscode.openFolder");
      }
    },
    openLog: () => outputChannel.show(),
    openSettings: async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "foundryScript.lsp.mode",
      );
    },
  });
  statusItem.show();
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand(CONNECTION_ACTIONS_COMMAND, async () =>
      statusController.showActions(),
    ),
  );
  if (settings.mode === "off") {
    statusController.update({ kind: "off" });
    writeLog(outputChannel, "info", "lsp.connection.off");
    return;
  }
  statusController.update({ kind: "disconnected" });

  const project = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (project === undefined) {
    await vscode.window.showErrorMessage(
      "Open a Foundry project folder before starting the language server.",
    );
    return;
  }

  const manager = createConnectionManager(
    outputChannel,
    project,
    (state) => statusController.update(state),
  );
  activeConnectionManager = manager;
  context.subscriptions.push({
    dispose: () => {
      void manager.stop();
    },
  });

  try {
    await manager.start({ settings, project });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      statusController.update({ kind: "disconnected" });
      if (activeConnectionManager === manager) {
        activeConnectionManager = undefined;
      }
      await manager.stop();
      return;
    }
    writeLog(outputChannel, "error", "lsp.connection.failed", {
      project,
      message: error instanceof Error ? error.message : String(error),
    });
    statusController.update({ kind: "disconnected" });
    await showStartupError(error);
  }
}

export async function deactivate(): Promise<void> {
  const manager = activeConnectionManager;
  activeConnectionManager = undefined;
  await manager?.stop();
}
