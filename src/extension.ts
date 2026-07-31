import type * as vscode from "vscode";

export function activate(_context: vscode.ExtensionContext): void {
  // Highlighting and language configuration are contributed declaratively via
  // package.json. Client endpoint selection and lifecycle wiring belong to #8;
  // #7 provides the endpoint-parameterized TCP client without choosing a server.
  // Diagnostics and tasks arrive with epic #16.
}

export function deactivate(): void {
  // Nothing to tear down yet.
}
