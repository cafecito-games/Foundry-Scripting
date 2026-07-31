import type * as vscode from "vscode";

export function activate(_context: vscode.ExtensionContext): void {
  // Highlighting and language configuration are contributed declaratively via
  // package.json. Runtime behavior arrives with the language client (epic #15)
  // and diagnostics/tasks (epic #16).
}

export function deactivate(): void {
  // Nothing to tear down yet.
}
