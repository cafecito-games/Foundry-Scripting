export type FoundryLintSeverity = "error" | "warning" | "note";

export interface FoundryLintPosition {
  readonly line: number;
  readonly character: number;
}

export interface FoundryLintDiagnostic {
  readonly filePath: string;
  readonly range: {
    readonly start: FoundryLintPosition;
    readonly end: FoundryLintPosition;
  };
  readonly severity: FoundryLintSeverity;
  readonly source: string;
  readonly ruleId: string;
  readonly message: string;
}

export interface FoundryLintReport {
  readonly diagnostics: readonly FoundryLintDiagnostic[];
}

export class LintReportError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`Invalid Foundry lint JSON: ${reason}`, options);
    this.name = "LintReportError";
  }
}

export function parseFoundryLintReport(
  text: string,
  projectPath: string,
): FoundryLintReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new LintReportError("the report is not valid JSON", { cause: error });
  }

  const root = record(value, "report");
  if (root.version !== 1) {
    throw new LintReportError("unsupported report version");
  }
  if (!Array.isArray(root.diagnostics)) {
    throw new LintReportError("diagnostics must be an array");
  }

  return {
    diagnostics: root.diagnostics.map((diagnostic, index) =>
      parseDiagnostic(diagnostic, index, projectPath),
    ),
  };
}

function parseDiagnostic(
  value: unknown,
  index: number,
  projectPath: string,
): FoundryLintDiagnostic {
  const label = `diagnostics[${index}]`;
  const diagnostic = record(value, label);
  const rawPath = nonEmptyString(diagnostic.path, `${label}.path`);
  const severity = parseSeverity(diagnostic.severity, `${label}.severity`);
  const range = parseRange(diagnostic.range, `${label}.range`);

  return {
    filePath: resolveReportPath(rawPath, projectPath),
    range,
    severity,
    source: nonEmptyString(diagnostic.source, `${label}.source`),
    ruleId: nonEmptyString(diagnostic.ruleId, `${label}.ruleId`),
    message: nonEmptyString(diagnostic.message, `${label}.message`),
  };
}

function parseRange(
  value: unknown,
  label: string,
): FoundryLintDiagnostic["range"] {
  const range = record(value, label);
  const start = {
    line: positiveInteger(range.startLine, `${label}.startLine`) - 1,
    character:
      positiveInteger(range.startColumn, `${label}.startColumn`) - 1,
  };
  const end = {
    line: positiveInteger(range.endLine, `${label}.endLine`) - 1,
    character: positiveInteger(range.endColumn, `${label}.endColumn`) - 1,
  };
  if (
    end.line < start.line ||
    (end.line === start.line && end.character < start.character)
  ) {
    throw new LintReportError(`${label} ends before it starts`);
  }
  return { start, end };
}

function parseSeverity(
  value: unknown,
  label: string,
): FoundryLintSeverity {
  if (value === "error" || value === "warning" || value === "note") {
    return value;
  }
  throw new LintReportError(`${label} is not a supported severity`);
}

function resolveReportPath(reportPath: string, projectPath: string): string {
  if (reportPath.startsWith("res://")) {
    return path.resolve(projectPath, reportPath.slice("res://".length));
  }
  return path.isAbsolute(reportPath)
    ? path.normalize(reportPath)
    : path.resolve(projectPath, reportPath);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LintReportError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LintReportError(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new LintReportError(`${label} must be a positive integer`);
  }
  return value;
}
import path from "node:path";
