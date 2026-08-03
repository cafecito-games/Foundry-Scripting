import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { createDiagnosticsUnit } from "./index.js";

interface VisibleDiagnostic {
  readonly label: string;
}

class FakeDiagnosticCollection {
  readonly visible = new Map<string, readonly vscode.Diagnostic[]>();
  readonly set = vi.fn(
    (uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[] | undefined) => {
      if (diagnostics === undefined || diagnostics.length === 0) {
        this.visible.delete(uri.toString());
      } else {
        this.visible.set(uri.toString(), diagnostics);
      }
    },
  );
  readonly delete = vi.fn((uri: vscode.Uri) => {
    this.visible.delete(uri.toString());
  });
  readonly clear = vi.fn(() => {
    this.visible.clear();
  });
  readonly dispose = vi.fn();
  readonly name = "foundryscript";

  forEach(
    callback: (
      uri: vscode.Uri,
      diagnostics: readonly vscode.Diagnostic[],
      collection: vscode.DiagnosticCollection,
    ) => unknown,
    thisArg?: unknown,
  ): void {
    for (const [uri, diagnostics] of this.visible) {
      callback.call(
        thisArg,
        fakeUri(uri),
        diagnostics,
        this as unknown as vscode.DiagnosticCollection,
      );
    }
  }

  get(uri: vscode.Uri): readonly vscode.Diagnostic[] | undefined {
    return this.visible.get(uri.toString());
  }

  has(uri: vscode.Uri): boolean {
    return this.visible.has(uri.toString());
  }
}

function fakeUri(value: string): vscode.Uri {
  return { toString: () => value } as vscode.Uri;
}

function fakeDiagnostic(label: string): vscode.Diagnostic {
  return { label } as unknown as vscode.Diagnostic;
}

function labelsAt(
  collection: FakeDiagnosticCollection,
  uri: vscode.Uri,
): string[] | undefined {
  return collection.get(uri)?.map(
    (diagnostic) => (diagnostic as unknown as VisibleDiagnostic).label,
  );
}

function createHarness(initiallyConnected = false): {
  readonly collection: FakeDiagnosticCollection;
  readonly unit: ReturnType<typeof createDiagnosticsUnit>;
  readonly createCollection: ReturnType<typeof vi.fn>;
} {
  const collection = new FakeDiagnosticCollection();
  const createCollection = vi.fn(
    () => collection as unknown as vscode.DiagnosticCollection,
  );

  return {
    collection,
    unit: createDiagnosticsUnit(createCollection, initiallyConnected),
    createCollection,
  };
}

describe("diagnostics arbitration", () => {
  it("shows only CLI diagnostics while the language server is absent", () => {
    const { collection, unit } = createHarness();
    const uri = fakeUri("file:///player.fs");

    unit.accept({ source: "lsp", uri, diagnostics: [fakeDiagnostic("lsp")] });
    unit.accept({ source: "cli", uri, diagnostics: [fakeDiagnostic("cli")] });

    expect(labelsAt(collection, uri)).toEqual(["cli"]);
  });

  it("shows only LSP diagnostics while the language server is connected", () => {
    const { collection, unit } = createHarness(true);
    const uri = fakeUri("file:///player.fs");

    unit.accept({ source: "cli", uri, diagnostics: [fakeDiagnostic("cli")] });
    unit.accept({ source: "lsp", uri, diagnostics: [fakeDiagnostic("lsp")] });

    expect(labelsAt(collection, uri)).toEqual(["lsp"]);
  });

  it("retains CLI diagnostics on connect until LSP covers each file", () => {
    const { collection, unit } = createHarness();
    const coveredUri = fakeUri("file:///covered.fs");
    const waitingUri = fakeUri("file:///waiting.fs");

    unit.accept({
      source: "cli",
      uri: coveredUri,
      diagnostics: [fakeDiagnostic("old-cli-covered")],
    });
    unit.accept({
      source: "cli",
      uri: waitingUri,
      diagnostics: [fakeDiagnostic("old-cli-waiting")],
    });

    unit.setLanguageServerConnected(true);

    expect(labelsAt(collection, coveredUri)).toEqual(["old-cli-covered"]);
    expect(labelsAt(collection, waitingUri)).toEqual(["old-cli-waiting"]);

    unit.accept({
      source: "lsp",
      uri: coveredUri,
      diagnostics: [fakeDiagnostic("new-lsp")],
    });

    expect(labelsAt(collection, coveredUri)).toEqual(["new-lsp"]);
    expect(labelsAt(collection, waitingUri)).toEqual(["old-cli-waiting"]);
  });

  it("retains LSP diagnostics on disconnect until CLI covers each file", () => {
    const { collection, unit } = createHarness(true);
    const uri = fakeUri("file:///player.fs");

    unit.accept({
      source: "lsp",
      uri,
      diagnostics: [fakeDiagnostic("last-known-lsp")],
    });
    unit.setLanguageServerConnected(false);

    expect(labelsAt(collection, uri)).toEqual(["last-known-lsp"]);

    unit.accept({
      source: "cli",
      uri,
      diagnostics: [fakeDiagnostic("new-cli")],
    });

    expect(labelsAt(collection, uri)).toEqual(["new-cli"]);
  });

  it("ignores stale updates from the inactive source across transitions", () => {
    const { collection, unit } = createHarness();
    const uri = fakeUri("file:///player.fs");

    unit.accept({ source: "cli", uri, diagnostics: [fakeDiagnostic("cli-1")] });
    unit.setLanguageServerConnected(true);
    unit.accept({
      source: "cli",
      uri,
      diagnostics: [fakeDiagnostic("stale-cli")],
    });
    unit.accept({ source: "lsp", uri, diagnostics: [fakeDiagnostic("lsp-1")] });
    unit.setLanguageServerConnected(false);
    unit.accept({
      source: "lsp",
      uri,
      diagnostics: [fakeDiagnostic("stale-lsp")],
    });

    expect(labelsAt(collection, uri)).toEqual(["lsp-1"]);
  });

  it("clears a file only when the active source reports no diagnostics", () => {
    const { collection, unit } = createHarness();
    const uri = fakeUri("file:///player.fs");

    unit.accept({ source: "cli", uri, diagnostics: [fakeDiagnostic("cli")] });
    unit.accept({ source: "lsp", uri, diagnostics: [] });
    expect(labelsAt(collection, uri)).toEqual(["cli"]);

    unit.accept({ source: "cli", uri, diagnostics: [] });
    expect(collection.has(uri)).toBe(false);
  });

  it("clears LSP-only output after a clean complete CLI snapshot arrives while connected", () => {
    const { collection, unit } = createHarness(true);
    const uri = fakeUri("file:///player.fs");

    unit.accept({ source: "lsp", uri, diagnostics: [fakeDiagnostic("lsp")] });
    unit.replace({ source: "cli", entries: [] });
    unit.setLanguageServerConnected(false);

    expect(collection.has(uri)).toBe(false);
  });

  it("retains last-known LSP output on disconnect until a complete CLI snapshot arrives", () => {
    const { collection, unit } = createHarness(true);
    const uri = fakeUri("file:///player.fs");

    unit.accept({ source: "lsp", uri, diagnostics: [fakeDiagnostic("lsp")] });
    unit.setLanguageServerConnected(false);
    expect(labelsAt(collection, uri)).toEqual(["lsp"]);

    unit.replace({ source: "cli", entries: [] });

    expect(collection.has(uri)).toBe(false);
  });

  it("does not restore a CLI snapshot captured before the connected LSP epoch", () => {
    const { collection, unit } = createHarness();
    const uri = fakeUri("file:///player.fs");

    unit.replace({
      source: "cli",
      entries: [{ uri, diagnostics: [fakeDiagnostic("cli-before-connect")] }],
    });
    unit.setLanguageServerConnected(true);
    unit.accept({
      source: "lsp",
      uri,
      diagnostics: [fakeDiagnostic("last-known-lsp")],
    });
    unit.setLanguageServerConnected(false);

    expect(labelsAt(collection, uri)).toEqual(["last-known-lsp"]);
    unit.replace({
      source: "cli",
      entries: [{ uri, diagnostics: [fakeDiagnostic("cli-after-disconnect")] }],
    });
    expect(labelsAt(collection, uri)).toEqual(["cli-after-disconnect"]);
  });

  it("keeps active LSP output through a clean CLI snapshot then projects it when disconnected", () => {
    const { collection, unit } = createHarness(true);
    const uri = fakeUri("file:///player.fs");

    unit.accept({ source: "lsp", uri, diagnostics: [fakeDiagnostic("lsp")] });
    unit.replace({ source: "cli", entries: [] });

    expect(labelsAt(collection, uri)).toEqual(["lsp"]);
    unit.setLanguageServerConnected(false);
    expect(collection.has(uri)).toBe(false);
  });

  it("replaces a nonempty CLI snapshot with a clean one without disturbing active LSP output", () => {
    const { collection, unit } = createHarness(true);
    const uri = fakeUri("file:///player.fs");

    unit.accept({ source: "lsp", uri, diagnostics: [fakeDiagnostic("lsp")] });
    unit.replace({
      source: "cli",
      entries: [{ uri, diagnostics: [fakeDiagnostic("cli")] }],
    });
    unit.replace({ source: "cli", entries: [] });

    expect(labelsAt(collection, uri)).toEqual(["lsp"]);
    unit.setLanguageServerConnected(false);
    expect(collection.has(uri)).toBe(false);
  });

  it("keeps pre-connect CLI output only where LSP has not covered a URI", () => {
    const { collection, unit } = createHarness();
    const coveredUri = fakeUri("file:///covered.fs");
    const waitingUri = fakeUri("file:///waiting.fs");

    unit.replace({
      source: "cli",
      entries: [
        { uri: coveredUri, diagnostics: [fakeDiagnostic("cli-covered")] },
        { uri: waitingUri, diagnostics: [fakeDiagnostic("cli-waiting")] },
      ],
    });
    unit.setLanguageServerConnected(true);
    unit.accept({
      source: "lsp",
      uri: coveredUri,
      diagnostics: [fakeDiagnostic("lsp-covered")],
    });

    expect(labelsAt(collection, coveredUri)).toEqual(["lsp-covered"]);
    expect(labelsAt(collection, waitingUri)).toEqual(["cli-waiting"]);

    unit.setLanguageServerConnected(false);

    expect(labelsAt(collection, coveredUri)).toEqual(["lsp-covered"]);
    expect(labelsAt(collection, waitingUri)).toEqual(["cli-waiting"]);
  });

  it("creates and disposes exactly one diagnostic collection", () => {
    const { collection, createCollection, unit } = createHarness();

    expect(createCollection).toHaveBeenCalledTimes(1);

    unit.dispose();

    expect(collection.dispose).toHaveBeenCalledTimes(1);
  });
});
