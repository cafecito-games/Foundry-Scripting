import type * as vscode from "vscode";

export type DiagnosticSource = "lsp" | "cli";

export interface DiagnosticEntry {
  readonly uri: vscode.Uri;
  readonly diagnostics: readonly vscode.Diagnostic[];
}

export interface SourcedDiagnostics extends DiagnosticEntry {
  readonly source: DiagnosticSource;
}

export interface SourcedDiagnosticsSnapshot {
  readonly source: DiagnosticSource;
  readonly entries: readonly DiagnosticEntry[];
}

export interface DiagnosticsUnit {
  accept(update: SourcedDiagnostics): void;
  replace(snapshot: SourcedDiagnosticsSnapshot): void;
  setLanguageServerConnected(connected: boolean): void;
  dispose(): void;
}

export function createDiagnosticsUnit(
  createCollection: () => vscode.DiagnosticCollection,
  initiallyConnected = false,
): DiagnosticsUnit {
  const collection = createCollection();
  const lspDiagnostics = new Map<string, DiagnosticEntry>();
  const cliDiagnostics = new Map<string, DiagnosticEntry>();
  const visibleUris = new Map<string, vscode.Uri>();
  let languageServerConnected = initiallyConnected;
  let hasCompleteCliSnapshot = false;

  const activeSource = (): DiagnosticSource =>
    languageServerConnected ? "lsp" : "cli";
  const diagnosticsFor = (source: DiagnosticSource): Map<string, DiagnosticEntry> =>
    source === "lsp" ? lspDiagnostics : cliDiagnostics;
  const apply = (entry: DiagnosticEntry): void => {
    const key = entry.uri.toString();
    if (entry.diagnostics.length === 0) {
      collection.delete(entry.uri);
      visibleUris.delete(key);
      return;
    }
    collection.set(entry.uri, entry.diagnostics);
    visibleUris.set(key, entry.uri);
  };
  const project = (entries: ReadonlyMap<string, DiagnosticEntry>): void => {
    for (const [key, uri] of visibleUris) {
      const entry = entries.get(key);
      if (entry === undefined || entry.diagnostics.length === 0) {
        collection.delete(uri);
        visibleUris.delete(key);
      }
    }
    for (const entry of entries.values()) {
      if (entry.diagnostics.length > 0) {
        apply(entry);
      }
    }
  };

  return {
    accept(update): void {
      if (update.source === "lsp" && !languageServerConnected) {
        return;
      }

      diagnosticsFor(update.source).set(update.uri.toString(), update);
      if (update.source === activeSource()) {
        apply(update);
      }
    },
    replace(snapshot): void {
      const entries = new Map(
        snapshot.entries.map((entry) => [entry.uri.toString(), entry]),
      );
      if (snapshot.source === "lsp") {
        lspDiagnostics.clear();
        for (const [key, entry] of entries) {
          lspDiagnostics.set(key, entry);
        }
      } else {
        cliDiagnostics.clear();
        for (const [key, entry] of entries) {
          cliDiagnostics.set(key, entry);
        }
        hasCompleteCliSnapshot = true;
      }

      if (snapshot.source === activeSource()) {
        project(entries);
      }
    },
    setLanguageServerConnected(connected): void {
      if (connected === languageServerConnected) {
        return;
      }
      languageServerConnected = connected;
      if (connected) {
        lspDiagnostics.clear();
      } else if (hasCompleteCliSnapshot) {
        project(cliDiagnostics);
      }
    },
    dispose(): void {
      collection.dispose();
    },
  };
}
