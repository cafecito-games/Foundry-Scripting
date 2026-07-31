import type * as vscode from "vscode";

export type DiagnosticSource = "lsp" | "cli";

export interface SourcedDiagnostics {
  readonly source: DiagnosticSource;
  readonly uri: vscode.Uri;
  readonly diagnostics: readonly vscode.Diagnostic[];
}

export interface DiagnosticsUnit {
  accept(update: SourcedDiagnostics): void;
  setLanguageServerConnected(connected: boolean): void;
  dispose(): void;
}

export function createDiagnosticsUnit(
  createCollection: () => vscode.DiagnosticCollection,
  initiallyConnected = false,
): DiagnosticsUnit {
  const collection = createCollection();
  let languageServerConnected = initiallyConnected;

  return {
    accept(update): void {
      const activeSource = languageServerConnected ? "lsp" : "cli";
      if (update.source !== activeSource) {
        return;
      }

      if (update.diagnostics.length === 0) {
        collection.delete(update.uri);
      } else {
        collection.set(update.uri, update.diagnostics);
      }
    },
    setLanguageServerConnected(connected): void {
      languageServerConnected = connected;
    },
    dispose(): void {
      collection.dispose();
    },
  };
}
