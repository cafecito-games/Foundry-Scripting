import { beforeEach, describe, expect, it, vi } from "vitest";
import capturedFixtureJson from "./fixtures/lint-report.json";
import type {
  DiagnosticsUnit,
  SourcedDiagnostics,
  SourcedDiagnosticsSnapshot,
} from "../diagnostics/index.js";

const vscodeMock = vi.hoisted(() => ({
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
}));

vi.mock("vscode", () => {
  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }

  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }

  class Diagnostic {
    source: string | undefined;
    code: string | number | undefined;
    constructor(
      readonly range: Range,
      readonly message: string,
      readonly severity: number,
    ) {}
  }

  return {
    Position,
    Range,
    Diagnostic,
    DiagnosticSeverity: vscodeMock.DiagnosticSeverity,
    Uri: {
      file: (fsPath: string) => ({
        fsPath,
        toString: () => `file://${fsPath}`,
      }),
    },
  };
});

import { LintReportError } from "./lint-report.js";
import { FoundryLintDiagnosticsPublisher } from "./lint-diagnostics.js";

const capturedFixture = JSON.stringify(capturedFixtureJson);

function createHarness() {
  const accept = vi.fn<(update: SourcedDiagnostics) => void>();
  const replace = vi.fn<(snapshot: SourcedDiagnosticsSnapshot) => void>();
  const unit: DiagnosticsUnit = {
    accept: (update) => accept(update),
    replace: (snapshot) => replace(snapshot),
    setLanguageServerConnected: vi.fn(),
    dispose: vi.fn(),
  };
  return { unit, accept, replace };
}

describe("Foundry lint diagnostics publisher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces CLI diagnostics with one per-file snapshot", () => {
    const { unit, accept, replace } = createHarness();
    const publisher = new FoundryLintDiagnosticsPublisher(unit);
    const run = publisher.beginRun("/workspace/game");

    run.appendStdout(capturedFixture);
    run.complete(1);

    expect(accept).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledOnce();
    const snapshot = replace.mock.calls[0]?.[0];
    expect(snapshot?.source).toBe("cli");
    const first = snapshot?.entries[0];
    expect(first?.uri.fsPath).toBe(
      "/workspace/game/tests/grammar/annotations.fs",
    );
    expect(first?.diagnostics[0]).toMatchObject({
      message:
        'Annotation "@my_custom" does not precede a valid target, so it will have no effect.',
      severity: vscodeMock.DiagnosticSeverity.Error,
      source: "foundry_script",
      code: "parse-error",
      range: {
        start: { line: 8, character: 0 },
        end: { line: 8, character: 16 },
      },
    });
    const second = snapshot?.entries[1];
    expect(second?.uri.fsPath).toBe(
      "/workspace/game/tests/grammar/comments.fs",
    );
    expect(second?.diagnostics[0]).toMatchObject({
      severity: vscodeMock.DiagnosticSeverity.Warning,
      code: "EMPTY_FILE",
    });
  });

  it("groups diagnostics for the same file and maps note to information", () => {
    const { unit, replace } = createHarness();
    const run = new FoundryLintDiagnosticsPublisher(unit).beginRun("/game");
    run.appendStdout(report([
      diagnostic({ message: "first" }),
      diagnostic({ message: "second", severity: "note" }),
    ]));

    run.complete(0);

    expect(replace).toHaveBeenCalledOnce();
    const update = replace.mock.calls[0]?.[0]?.entries[0];
    expect(update?.diagnostics).toHaveLength(2);
    expect(update?.diagnostics[1]?.severity).toBe(
      vscodeMock.DiagnosticSeverity.Information,
    );
  });

  it("replaces a prior report with an empty clean snapshot", () => {
    const { unit, accept, replace } = createHarness();
    const publisher = new FoundryLintDiagnosticsPublisher(unit);
    const first = publisher.beginRun("/workspace/game");
    first.appendStdout(capturedFixture);
    first.complete(1);
    replace.mockClear();

    const clean = publisher.beginRun("/workspace/game");
    clean.appendStdout(report([]));
    clean.complete(0);

    expect(accept).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith({ source: "cli", entries: [] });
  });

  it("preserves prior diagnostics after exit 2, cancellation, or malformed JSON", () => {
    const { unit, accept, replace } = createHarness();
    const publisher = new FoundryLintDiagnosticsPublisher(unit);
    const first = publisher.beginRun("/workspace/game");
    first.appendStdout(capturedFixture);
    first.complete(1);
    replace.mockClear();

    const failed = publisher.beginRun("/workspace/game");
    failed.appendStdout(report([]));
    failed.complete(2);
    const cancelled = publisher.beginRun("/workspace/game");
    cancelled.appendStdout(report([]));
    cancelled.complete(undefined);
    const malformed = publisher.beginRun("/workspace/game");
    malformed.appendStdout("not JSON");

    expect(() => malformed.complete(1)).toThrow(LintReportError);
    expect(accept).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    const clean = publisher.beginRun("/workspace/game");
    clean.appendStdout(report([]));
    clean.complete(0);
    expect(replace).toHaveBeenCalledOnce();
  });

  it("ignores an older run after a newer lint run starts", () => {
    const { unit, accept, replace } = createHarness();
    const publisher = new FoundryLintDiagnosticsPublisher(unit);
    const older = publisher.beginRun("/workspace/game");
    older.appendStdout(capturedFixture);
    const newer = publisher.beginRun("/workspace/game");
    newer.appendStdout(report([]));

    newer.complete(0);
    older.complete(1);

    expect(accept).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith({ source: "cli", entries: [] });
  });
});

function report(diagnostics: unknown[]): string {
  return JSON.stringify({ version: 1, diagnostics });
}

function diagnostic(
  overrides: { message?: string; severity?: string } = {},
): Record<string, unknown> {
  return {
    path: "res://scripts/player.fs",
    range: {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 2,
    },
    severity: overrides.severity ?? "error",
    source: "foundry_script",
    ruleId: "example-rule",
    message: overrides.message ?? "example",
  };
}
