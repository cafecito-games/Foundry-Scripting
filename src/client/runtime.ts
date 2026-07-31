import type * as vscode from "vscode";
import { ConnectionManager } from "./connection-manager.js";
import { FoundryHostLauncher } from "./host-launcher.js";
import { FoundryScriptLanguageClient } from "./language-client.js";

export function createConnectionManager(
  outputChannel: vscode.OutputChannel,
): ConnectionManager {
  return new ConnectionManager({
    createClient: (endpoint, signal) =>
      new FoundryScriptLanguageClient({ endpoint, outputChannel, signal }),
    launcher: new FoundryHostLauncher({ output: outputChannel }),
  });
}
