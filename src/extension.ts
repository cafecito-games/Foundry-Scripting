import * as vscode from "vscode";
import {
  type ConnectionManager,
  type ConnectionSettings,
} from "./client/connection-manager.js";
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
  if (settings.mode === "off") {
    writeLog(outputChannel, "info", "lsp.connection.off");
    return;
  }

  const project = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (project === undefined) {
    await vscode.window.showErrorMessage(
      "Open a Foundry project folder before starting the language server.",
    );
    return;
  }

  const manager = createConnectionManager(outputChannel, project);
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
    activeConnectionManager = undefined;
    await manager.stop();
    await showStartupError(error);
  }
}

export async function deactivate(): Promise<void> {
  const manager = activeConnectionManager;
  activeConnectionManager = undefined;
  await manager?.stop();
}
