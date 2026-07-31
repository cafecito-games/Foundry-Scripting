import * as vscode from "vscode";
import {
  ConnectionManager,
  type ConnectionState,
} from "./connection-manager.js";
import { FoundryHostLauncher } from "./host-launcher.js";
import { FoundryScriptLanguageClient } from "./language-client.js";
import { createWorkspaceMismatchHandler } from "./workspace-mismatch.js";
import type { DiagnosticsUnit } from "../diagnostics/index.js";

export function createConnectionManager(
  outputChannel: vscode.OutputChannel,
  workspacePath: string,
  onStateChange: (state: ConnectionState) => void,
  diagnostics: DiagnosticsUnit,
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
    launcher: new FoundryHostLauncher({ output: outputChannel }),
    onStateChange: (state) => {
      diagnostics.setLanguageServerConnected(state.kind === "connected");
      onStateChange(state);
    },
    output: outputChannel,
  });
}
