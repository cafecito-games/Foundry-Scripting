import * as vscode from "vscode";
import type { ResolveWorkspaceProject } from "../project/workspace.js";
import {
  FOUNDRYSCRIPT_DEBUG_TYPE,
  FoundryScriptDebugConfigurationProvider,
} from "./configuration.js";

export function registerFoundryScriptDebugConfigurationProvider(
  context: vscode.ExtensionContext,
  resolveProject: ResolveWorkspaceProject,
): void {
  const provider = new FoundryScriptDebugConfigurationProvider({
    resolveProject,
    reportError: (message) => {
      void vscode.window.showErrorMessage(message);
    },
  });
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      FOUNDRYSCRIPT_DEBUG_TYPE,
      provider,
    ),
  );
}
