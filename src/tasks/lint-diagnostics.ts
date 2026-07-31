import * as vscode from "vscode";
import type { DiagnosticsUnit } from "../diagnostics/index.js";
import {
  parseFoundryLintReport,
  type FoundryLintDiagnostic,
  type FoundryLintSeverity,
} from "./lint-report.js";

export interface FoundryLintRun {
  appendStdout(text: string): void;
  complete(exitCode: number | undefined): void;
}

interface DiagnosticBatch {
  readonly uri: vscode.Uri;
  readonly diagnostics: vscode.Diagnostic[];
}

export class FoundryLintDiagnosticsPublisher {
  private generation = 0;
  private previousUris = new Map<string, vscode.Uri>();

  constructor(private readonly diagnostics: DiagnosticsUnit) {}

  beginRun(projectPath: string): FoundryLintRun {
    const generation = ++this.generation;
    let stdout = "";
    let completed = false;

    return {
      appendStdout(text): void {
        stdout += text;
      },
      complete: (exitCode): void => {
        if (completed) {
          return;
        }
        completed = true;
        if (
          generation !== this.generation ||
          (exitCode !== 0 && exitCode !== 1)
        ) {
          return;
        }
        this.applyReport(stdout, projectPath);
      },
    };
  }

  private applyReport(stdout: string, projectPath: string): void {
    const report = parseFoundryLintReport(stdout, projectPath);
    const batches = new Map<string, DiagnosticBatch>();
    for (const parsed of report.diagnostics) {
      const uri = vscode.Uri.file(parsed.filePath);
      const key = uri.toString();
      let batch = batches.get(key);
      if (batch === undefined) {
        batch = { uri, diagnostics: [] };
        batches.set(key, batch);
      }
      batch.diagnostics.push(toVscodeDiagnostic(parsed));
    }

    for (const batch of batches.values()) {
      this.diagnostics.accept({ source: "cli", ...batch });
    }
    for (const [key, uri] of this.previousUris) {
      if (!batches.has(key)) {
        this.diagnostics.accept({ source: "cli", uri, diagnostics: [] });
      }
    }
    this.previousUris = new Map(
      [...batches].map(([key, batch]) => [key, batch.uri]),
    );
  }
}

function toVscodeDiagnostic(
  parsed: FoundryLintDiagnostic,
): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(
      new vscode.Position(parsed.range.start.line, parsed.range.start.character),
      new vscode.Position(parsed.range.end.line, parsed.range.end.character),
    ),
    parsed.message,
    toVscodeSeverity(parsed.severity),
  );
  diagnostic.source = parsed.source;
  diagnostic.code = parsed.ruleId;
  return diagnostic;
}

function toVscodeSeverity(
  severity: FoundryLintSeverity,
): vscode.DiagnosticSeverity {
  switch (severity) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "note":
      return vscode.DiagnosticSeverity.Information;
  }
}
