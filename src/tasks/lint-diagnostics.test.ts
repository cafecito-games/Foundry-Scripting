import { beforeEach, describe, expect, it, vi } from "vitest";
import capturedFixtureJson from "./fixtures/lint-report.json";
import type { DiagnosticsUnit, SourcedDiagnostics } from "../diagnostics/index.js";

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
  const unit: DiagnosticsUnit = {
    accept: (update) => accept(update),
    setLanguageServerConnected: vi.fn(),
    dispose: vi.fn(),
  };
  return { unit, accept };
}

describe("Foundry lint diagnostics publisher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes captured diagnostics in per-file CLI batches", () => {
    const { unit, accept } = createHarness();
    const publisher = new FoundryLintDiagnosticsPublisher(unit);
    const run = publisher.beginRun("/workspace/game");

    run.appendStdout(capturedFixture);
    run.complete(1);

    expect(accept).toHaveBeenCalledTimes(2);
    const first = accept.mock.calls[0]?.[0];
    expect(first?.source).toBe("cli");
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
    const second = accept.mock.calls[1]?.[0];
    expect(second?.source).toBe("cli");
    expect(second?.uri.fsPath).toBe(
      "/workspace/game/tests/grammar/comments.fs",
    );
    expect(second?.diagnostics[0]).toMatchObject({
      severity: vscodeMock.DiagnosticSeverity.Warning,
      code: "EMPTY_FILE",
    });
  });

  it("groups diagnostics for the same file and maps note to information", () => {
    const { unit, accept } = createHarness();
    const run = new FoundryLintDiagnosticsPublisher(unit).beginRun("/game");
    run.appendStdout(report([
      diagnostic({ message: "first" }),
      diagnostic({ message: "second", severity: "note" }),
    ]));

    run.complete(0);

    expect(accept).toHaveBeenCalledOnce();
    const update = accept.mock.calls[0]?.[0];
    expect(update?.diagnostics).toHaveLength(2);
    expect(update?.diagnostics[1]?.severity).toBe(
      vscodeMock.DiagnosticSeverity.Information,
    );
  });

  it("clears every prior file absent from a successful rerun", () => {
    const { unit, accept } = createHarness();
    const publisher = new FoundryLintDiagnosticsPublisher(unit);
    const first = publisher.beginRun("/workspace/game");
    first.appendStdout(capturedFixture);
    first.complete(1);
    accept.mockClear();

    const clean = publisher.beginRun("/workspace/game");
    clean.appendStdout(report([]));
    clean.complete(0);

    expect(accept).toHaveBeenCalledTimes(2);
    expect(accept.mock.calls.map(([update]) => ({
      file: update.uri.fsPath,
      diagnostics: update.diagnostics,
    }))).toEqual([
      {
        file: "/workspace/game/tests/grammar/annotations.fs",
        diagnostics: [],
      },
      {
        file: "/workspace/game/tests/grammar/comments.fs",
        diagnostics: [],
      },
    ]);
  });

  it("preserves prior diagnostics after exit 2, cancellation, or malformed JSON", () => {
    const { unit, accept } = createHarness();
    const publisher = new FoundryLintDiagnosticsPublisher(unit);
    const first = publisher.beginRun("/workspace/game");
    first.appendStdout(capturedFixture);
    first.complete(1);
    accept.mockClear();

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

    const clean = publisher.beginRun("/workspace/game");
    clean.appendStdout(report([]));
    clean.complete(0);
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it("ignores an older run after a newer lint run starts", () => {
    const { unit, accept } = createHarness();
    const publisher = new FoundryLintDiagnosticsPublisher(unit);
    const older = publisher.beginRun("/workspace/game");
    older.appendStdout(capturedFixture);
    const newer = publisher.beginRun("/workspace/game");
    newer.appendStdout(report([]));

    newer.complete(0);
    older.complete(1);

    expect(accept).not.toHaveBeenCalled();
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
