import * as vscode from "vscode";
import {
  ConnectionManager,
  type ConnectionState,
} from "./connection-manager.js";
import { FoundryHostLauncher } from "./host-launcher.js";
import { FoundryScriptLanguageClient } from "./language-client.js";
import { writeLog } from "./logging.js";
import { createWorkspaceMismatchHandler } from "./workspace-mismatch.js";
import type { DiagnosticsUnit } from "../diagnostics/index.js";
import { ToolingHostCoordinator } from "../tooling/coordinator.js";

export function createToolingHostCoordinator(
  outputChannel: vscode.OutputChannel,
): ToolingHostCoordinator {
  return new ToolingHostCoordinator({
    launcher: new FoundryHostLauncher({ output: outputChannel }),
    onStateChange: (state) => {
      writeLog(outputChannel, "info", "tooling.host.state", {
        state: state.kind,
      });
    },
  });
}

export function createConnectionManager(
  outputChannel: vscode.OutputChannel,
  workspacePath: string,
  onStateChange: (state: ConnectionState) => void,
  diagnostics: DiagnosticsUnit,
  coordinator: ToolingHostCoordinator,
): ConnectionManager {
  const workspaceMismatchHandler = createWorkspaceMismatchHandler({
    workspacePath,
    showWarningMessage: (message, action) =>
      vscode.window.showWarningMessage(message, action),
    openFolder: (serverPath) =>
      vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(serverPath),
      ),
  });
  return new ConnectionManager({
    createClient: (endpoint, signal) =>
      new FoundryScriptLanguageClient({
        endpoint,
        outputChannel,
        signal,
        onDiagnostics: (uri, lspDiagnostics) => {
          diagnostics.accept({
            source: "lsp",
            uri,
            diagnostics: lspDiagnostics,
          });
        },
        workspaceMismatchHandler,
    }),
    coordinator,
    onStateChange: (state) => {
      diagnostics.setLanguageServerConnected(state.kind === "connected");
      onStateChange(state);
    },
    output: outputChannel,
  });
}
