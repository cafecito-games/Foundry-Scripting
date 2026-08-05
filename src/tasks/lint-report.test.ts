import { describe, expect, it } from "vitest";
import capturedFixtureJson from "./fixtures/lint-report.json";
import {
  LintReportError,
  parseFoundryLintReport,
} from "./lint-report.js";

const capturedFixture = JSON.stringify(capturedFixtureJson);

describe("Foundry lint JSON parser", () => {
  it("maps a captured version 1 report to absolute files and zero-based ranges", () => {
    const report = parseFoundryLintReport(capturedFixture, "/workspace/game");

    expect(report.diagnostics).toEqual([
      {
        filePath: "/workspace/game/tests/grammar/annotations.fs",
        message:
          'Annotation "@my_custom" does not precede a valid target, so it will have no effect.',
        range: {
          start: { line: 8, character: 0 },
          end: { line: 8, character: 16 },
        },
        ruleId: "parse-error",
        severity: "error",
        source: "foundry_script",
      },
      {
        filePath: "/workspace/game/tests/grammar/comments.fs",
        message: "Empty script file.",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 36 },
        },
        ruleId: "EMPTY_FILE",
        severity: "warning",
        source: "foundry_script",
      },
    ]);
  });

  it("maps note severity and resolves absolute and relative paths", () => {
    const report = parseFoundryLintReport(
      JSON.stringify({
        version: 1,
        diagnostics: [
          diagnostic({ path: "/workspace/game/shared/lib.fs", severity: "note" }),
          diagnostic({ path: "scripts/player.fs" }),
        ],
      }),
      "/workspace/game",
    );

    expect(report.diagnostics.map(({ filePath, severity }) => ({
      filePath,
      severity,
    }))).toEqual([
      { filePath: "/workspace/game/shared/lib.fs", severity: "note" },
      { filePath: "/workspace/game/scripts/player.fs", severity: "error" },
    ]);
  });

  it("rejects a lint report path that escapes the project", () => {
    expect(() =>
      parseFoundryLintReport(
        JSON.stringify({
          version: 1,
          diagnostics: [diagnostic({ path: "/etc/passwd" })],
        }),
        "/workspace/game",
      ),
    ).toThrow(LintReportError);
    expect(() =>
      parseFoundryLintReport(
        JSON.stringify({
          version: 1,
          diagnostics: [diagnostic({ path: "res://../../../../etc/passwd" })],
        }),
        "/workspace/game",
      ),
    ).toThrow(LintReportError);
  });

  it.each([
    ["malformed JSON", "{"],
    ["unsupported version", JSON.stringify({ version: 2, diagnostics: [] })],
    ["missing diagnostics", JSON.stringify({ version: 1 })],
    [
      "missing field",
      JSON.stringify({
        version: 1,
        diagnostics: [{ ...diagnostic(), ruleId: undefined }],
      }),
    ],
    [
      "unknown severity",
      JSON.stringify({
        version: 1,
        diagnostics: [diagnostic({ severity: "fatal" })],
      }),
    ],
    [
      "nonpositive coordinate",
      JSON.stringify({
        version: 1,
        diagnostics: [
          diagnostic({
            range: {
              startLine: 0,
              startColumn: 1,
              endLine: 1,
              endColumn: 2,
            },
          }),
        ],
      }),
    ],
    [
      "range ending before its start",
      JSON.stringify({
        version: 1,
        diagnostics: [
          diagnostic({
            range: {
              startLine: 3,
              startColumn: 4,
              endLine: 3,
              endColumn: 2,
            },
          }),
        ],
      }),
    ],
  ])("rejects %s without returning partial diagnostics", (_name, text) => {
    expect(() => parseFoundryLintReport(text, "/workspace/game")).toThrow(
      LintReportError,
    );
  });
});

interface DiagnosticOverrides {
  readonly path?: string;
  readonly severity?: string;
  readonly range?: {
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
  };
}

function diagnostic(overrides: DiagnosticOverrides = {}) {
  return {
    path: overrides.path ?? "res://scripts/player.fs",
    range: overrides.range ?? {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 2,
    },
    severity: overrides.severity ?? "error",
    source: "foundry_script",
    ruleId: "parse-error",
    message: "Example diagnostic.",
  };
}
