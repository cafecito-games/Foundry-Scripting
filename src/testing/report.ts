import { parseDocument } from "yaml";

export type FoundryStatusDetail =
  | ""
  | "discovery_error"
  | "runtime_error"
  | "timed_out"
  | "aborted"
  | "setup_error";

export interface FoundryTapPlanLeaf {
  readonly id: string;
  readonly skipped: boolean;
  readonly skipReason: string | null;
}

export interface FoundryTapSourceLocation {
  readonly fileName: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

export interface FoundryTapPoint {
  readonly number: number;
  readonly ok: boolean;
  readonly label: string;
  readonly skipReason?: string;
  readonly testId: string;
  readonly durationMs: number;
  readonly statusDetail: FoundryStatusDetail;
  readonly message?: string;
  readonly location?: FoundryTapSourceLocation;
}

export type FoundryTapClassification =
  | "conforming"
  | "test_failures"
  | "infrastructure_failure"
  | "cancelled"
  | "invalid";

export interface FoundryTapCompletion {
  readonly valid: boolean;
  readonly complete: boolean;
  readonly classification: FoundryTapClassification;
  readonly codes: readonly string[];
  readonly diagnostics: readonly string[];
  readonly bailoutMessage?: string;
}

export type FoundryTapProcessContext =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "cancelled"; readonly exitCode?: number | null }
  | { readonly kind: "artifact" };

type ParserPhase =
  | "header"
  | "comment"
  | "plan"
  | "point"
  | "block-open"
  | "block"
  | "terminal"
  | "stopped";

interface PointCandidate {
  readonly number: number;
  readonly ok: boolean;
  readonly label: string;
  readonly skipReason: string | undefined;
  readonly diagnosticsStart: number;
}

const tapVersionLine = "TAP version 13";
const adapterCommentLine = "# foundry-test-adapter: 1";
const blockOpen = "  ---";
const blockClose = "  ...";
const bailoutPrefix = "Bail out!";
const planPattern = /^1\.\.(\d{1,9})$/u;
const pointPattern = /^(ok|not ok) (\d{1,9}) - (.*)$/u;
const statusDetails = new Set<FoundryStatusDetail>([
  "",
  "discovery_error",
  "runtime_error",
  "timed_out",
  "aborted",
  "setup_error",
]);
const controlCharacter = /[\u0000-\u001f\u007f]/u;

export class FoundryTap13Parser {
  private readonly decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  private phase: ParserPhase = "header";
  private textSuffix = "";
  private firstText = true;
  private terminalLf = false;
  private lineEndingValid = true;
  private encodingValid = true;
  private decoderFailed = false;
  private lineNumber = 0;
  private plan: number | undefined;
  private pointCount = 0;
  private failureCount = 0;
  private candidate: PointCandidate | undefined;
  private blockLines: string[] = [];
  private blockIndentationValid = true;
  private readonly seenIds = new Set<string>();
  private readonly reportedIds: string[] = [];
  private readonly diagnosticCodes: string[] = [];
  private readonly diagnosticMessages: string[] = [];
  private bailoutMessage: string | undefined;
  private stoppedEarly = false;

  constructor(
    private readonly expectedLeaves: readonly FoundryTapPlanLeaf[] | undefined,
    private readonly onPoint: (point: FoundryTapPoint) => void,
    selectionInvalid = false,
  ) {
    if (selectionInvalid) {
      this.add("report.selection", "The requested selection is invalid.");
    }
  }

  push(bytes: Uint8Array): void {
    if (this.decoderFailed || bytes.length === 0) {
      return;
    }
    let decoded: string;
    try {
      decoded = this.decoder.decode(bytes, { stream: true });
    } catch {
      this.decoderFailed = true;
      this.encodingValid = false;
      this.add("artifact.encoding", "The report is not valid UTF-8.");
      return;
    }
    this.acceptDecoded(decoded);
  }

  finish(context: FoundryTapProcessContext): FoundryTapCompletion {
    if (context.kind === "cancelled") {
      return this.finishCancellation(context.exitCode);
    }
    if (!this.decoderFailed) {
      let decoded: string;
      try {
        decoded = this.decoder.decode();
      } catch {
        this.decoderFailed = true;
        this.encodingValid = false;
        this.add("artifact.encoding", "The report ends inside a UTF-8 scalar.");
        decoded = "";
      }
      this.acceptDecoded(decoded);
    }

    if (!this.decoderFailed && this.textSuffix.length > 0) {
      const finalLine = this.textSuffix;
      this.textSuffix = "";
      this.lineNumber += 1;
      this.acceptLine(finalLine);
    }

    this.finishNormal(context.kind === "exited" ? context.exitCode : undefined);
    const complete = this.isComplete();
    const codes = unique(this.diagnosticCodes);
    if (codes.length === 0) {
      return {
        valid: true,
        complete,
        classification:
          this.bailoutMessage !== undefined
            ? "infrastructure_failure"
            : this.failureCount > 0
              ? "test_failures"
              : "conforming",
        codes,
        diagnostics: [...this.diagnosticMessages],
        ...(this.bailoutMessage === undefined
          ? {}
          : { bailoutMessage: this.bailoutMessage }),
      };
    }
    const infrastructureCodes = new Set([
      "artifact.encoding",
      "artifact.missing",
      "report.incomplete",
      "report.line_ending",
    ]);
    const infrastructure =
      !complete && codes.every((code) => infrastructureCodes.has(code));
    return {
      valid: false,
      complete,
      classification: infrastructure ? "infrastructure_failure" : "invalid",
      codes,
      diagnostics: [...this.diagnosticMessages],
      ...(this.bailoutMessage === undefined
        ? {}
        : { bailoutMessage: this.bailoutMessage }),
    };
  }

  private acceptDecoded(decoded: string): void {
    if (decoded.length === 0) {
      return;
    }
    let text = decoded;
    if (this.firstText) {
      this.firstText = false;
      if (text.startsWith("\uFEFF")) {
        this.encodingValid = false;
        this.add("artifact.encoding", "The report must not start with a byte-order mark.");
        text = text.slice(1);
      }
    }
    if (text.includes("\r")) {
      this.lineEndingValid = false;
      this.addOnce(
        "report.line_ending",
        "The report must use LF line endings without carriage returns.",
      );
    }
    this.terminalLf = text.endsWith("\n");
    this.textSuffix += text;
    while (true) {
      const newline = this.textSuffix.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = this.textSuffix.slice(0, newline);
      this.textSuffix = this.textSuffix.slice(newline + 1);
      this.lineNumber += 1;
      this.acceptLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  }

  private acceptLine(line: string): void {
    switch (this.phase) {
      case "header":
        if (line !== tapVersionLine) {
          this.add("report.header", `Line 1 must be ${JSON.stringify(tapVersionLine)}.`);
          this.stoppedEarly = true;
          this.phase = "stopped";
        } else {
          this.phase = "comment";
        }
        return;
      case "comment":
        if (line !== adapterCommentLine) {
          this.add(
            "report.adapter_version",
            `Line 2 must be ${JSON.stringify(adapterCommentLine)}.`,
          );
          this.stoppedEarly = true;
          this.phase = "stopped";
        } else {
          this.phase = "plan";
        }
        return;
      case "plan":
        if (line.startsWith(bailoutPrefix)) {
          this.acceptBailout(line);
          return;
        }
        this.acceptPlan(line);
        return;
      case "point":
        if (line.startsWith(bailoutPrefix)) {
          this.acceptBailout(line);
          return;
        }
        this.acceptPointLine(line);
        return;
      case "block-open":
        if (line !== blockOpen) {
          this.add("report.yaml", "Every point requires an immediately following YAML block.");
          this.candidate = undefined;
          this.phase = "point";
          this.acceptLine(line);
          return;
        }
        this.blockLines = [];
        this.blockIndentationValid = true;
        this.phase = "block";
        return;
      case "block":
        if (line === blockClose) {
          this.completePoint();
          this.phase = "point";
          return;
        }
        if (line.trim() !== "" && !line.startsWith("  ")) {
          this.blockIndentationValid = false;
        }
        this.blockLines.push(line);
        return;
      case "terminal":
        this.addOnce("report.bailout", "No output is allowed after terminal report content.");
        return;
      case "stopped":
        return;
    }
  }

  private acceptPlan(line: string): void {
    const match = planPattern.exec(line);
    if (match === null) {
      this.add("report.plan", "Line 3 must be a leading 1..N plan.");
      this.addOnce("report.incomplete", "The report declares no usable plan.");
      this.stoppedEarly = true;
      this.phase = "stopped";
      return;
    }
    this.plan = Number(match[1]);
    if (
      this.expectedLeaves !== undefined &&
      this.plan !== this.expectedLeaves.length
    ) {
      this.add(
        "report.selection",
        `The report plans ${this.plan} points; ${this.expectedLeaves.length} were selected.`,
      );
    }
    this.phase = "point";
  }

  private acceptPointLine(line: string): void {
    const diagnosticsStart = this.diagnosticCodes.length;
    const match = pointPattern.exec(line);
    if (match === null) {
      this.add("report.point", `Line ${this.lineNumber} is not a conforming test point.`);
      return;
    }
    const ok = match[1] === "ok";
    const number = Number(match[2]);
    const rest = match[3] ?? "";
    let label = rest;
    let skipReason: string | undefined;
    if (rest.includes(" # ")) {
      const separator = rest.indexOf(" # ");
      label = rest.slice(0, separator);
      const directive = rest.slice(separator + 3);
      if (!directive.startsWith("SKIP ") || directive.slice(5).length === 0) {
        this.add("report.directive", "Only # SKIP with a non-empty reason is allowed.");
      } else {
        skipReason = directive.slice(5);
        if (!ok) {
          this.add("report.status", "A skipped point must use ok.");
        }
      }
    }
    if (
      label.length === 0 ||
      label !== label.trim() ||
      label.includes("#") ||
      controlCharacter.test(label)
    ) {
      this.add("report.point", "A point label must be non-empty control-free text without #.");
    }
    const expectedNumber = this.pointCount + 1;
    if (number !== expectedNumber) {
      this.add(
        "report.point",
        `Expected point ${expectedNumber}, received point ${number}.`,
      );
    }
    if (this.plan !== undefined && expectedNumber > this.plan) {
      this.add("report.point", "The report emitted more points than its plan.");
    }
    this.candidate = {
      number,
      ok,
      label,
      skipReason,
      diagnosticsStart,
    };
    this.phase = "block-open";
  }

  private completePoint(): void {
    const candidate = this.candidate;
    this.candidate = undefined;
    if (candidate === undefined) {
      this.add("report.yaml", "A YAML block has no test point.");
      return;
    }
    this.pointCount += 1;
    if (!this.blockIndentationValid) {
      this.add("report.yaml", "Diagnostic lines require two-space TAP indentation.");
      return;
    }
    const body = this.blockLines
      .map((line) => (line.trim() === "" ? "" : line.slice(2)))
      .join("\n");
    let value: unknown;
    try {
      const document = parseDocument(body, { strict: true, uniqueKeys: true });
      if (document.errors.length > 0 || document.warnings.length > 0) {
        throw new Error(
          [...document.errors, ...document.warnings]
            .map((error) => error.message)
            .join("; "),
        );
      }
      value = document.toJS();
    } catch (error) {
      this.add(
        "report.yaml",
        `Malformed YAML diagnostic block: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!isMapping(value)) {
      this.add("report.yaml", "A diagnostic block must be a YAML mapping.");
      return;
    }
    const point = this.readPoint(candidate, value);
    if (
      point !== undefined &&
      this.diagnosticCodes.length === candidate.diagnosticsStart
    ) {
      this.onPoint(point);
    }
  }

  private readPoint(
    candidate: PointCandidate,
    document: Record<string, unknown>,
  ): FoundryTapPoint | undefined {
    const metadata = document._foundry;
    if (!isMapping(metadata)) {
      this.add("report.metadata", "A point requires a _foundry mapping.");
      return undefined;
    }
    const testId = metadata.id;
    const durationMs = metadata.duration_ms;
    const statusDetail = metadata.status_detail;
    if (
      typeof testId !== "string" ||
      testId.length === 0 ||
      controlCharacter.test(testId)
    ) {
      this.add("report.metadata", "_foundry.id must be a non-empty control-free string.");
    }
    if (
      typeof durationMs !== "number" ||
      !Number.isInteger(durationMs) ||
      durationMs < 0
    ) {
      this.add("report.metadata", "_foundry.duration_ms must be a non-negative integer.");
    }
    if (typeof statusDetail !== "string" || !statusDetails.has(statusDetail as FoundryStatusDetail)) {
      this.add("report.metadata", "_foundry.status_detail is outside the v1 closed set.");
    }
    const message = document.message;
    if (!candidate.ok && (typeof message !== "string" || message.length === 0)) {
      this.add("report.metadata", "A not ok point requires a non-empty message.");
    } else if (candidate.ok && message !== undefined && typeof message !== "string") {
      this.add("report.metadata", "message must be a string.");
    }
    if (typeof statusDetail === "string" && statusDetail.length > 0 && candidate.ok) {
      this.add("report.status", "A non-empty status detail requires not ok.");
    }
    if (candidate.skipReason !== undefined && !candidate.ok) {
      this.addOnce("report.status", "A skipped point must use ok.");
    }
    if (candidate.skipReason !== undefined && statusDetail !== "") {
      this.add("report.status", "A skipped point requires empty status detail.");
    }

    const expected = this.expectedLeaves?.[this.pointCount - 1];
    if (typeof testId === "string") {
      if (this.seenIds.has(testId)) {
        this.add("report.duplicate_id", `Duplicate report ID ${JSON.stringify(testId)}.`);
      }
      this.seenIds.add(testId);
      this.reportedIds.push(testId);
      if (expected !== undefined && expected.skipped !== (candidate.skipReason !== undefined)) {
        this.add("report.skip", "Reported skip state differs from discovery.");
      } else if (
        expected !== undefined &&
        candidate.skipReason !== undefined &&
        candidate.skipReason !== expected.skipReason
      ) {
        this.add("report.skip", "Reported skip reason differs from discovery.");
      }
    }

    let location: FoundryTapSourceLocation | undefined;
    if (document.at !== undefined) {
      location = this.readLocation(document.at);
    }
    if (!candidate.ok) {
      this.failureCount += 1;
    }
    if (
      typeof testId !== "string" ||
      typeof durationMs !== "number" ||
      !Number.isInteger(durationMs) ||
      typeof statusDetail !== "string" ||
      !statusDetails.has(statusDetail as FoundryStatusDetail)
    ) {
      return undefined;
    }
    return {
      number: candidate.number,
      ok: candidate.ok,
      label: candidate.label,
      ...(candidate.skipReason === undefined
        ? {}
        : { skipReason: candidate.skipReason }),
      testId,
      durationMs,
      statusDetail: statusDetail as FoundryStatusDetail,
      ...(typeof message === "string" ? { message } : {}),
      ...(location === undefined ? {} : { location }),
    };
  }

  private readLocation(value: unknown): FoundryTapSourceLocation | undefined {
    if (!isMapping(value)) {
      this.add("report.location", "at must be a mapping.");
      return undefined;
    }
    const fileName = value.fileName;
    const lineNumber = value.lineNumber;
    const columnNumber = value.columnNumber;
    if (typeof fileName !== "string" || !isCanonicalResourcePath(fileName)) {
      this.add("report.location", "at.fileName must be a canonical res:// path.");
      return undefined;
    }
    if (!isPositiveInteger(lineNumber) || !isPositiveInteger(columnNumber)) {
      this.add("report.location", "at positions must be positive one-based integers.");
      return undefined;
    }
    return { fileName, lineNumber, columnNumber };
  }

  private acceptBailout(line: string): void {
    const message = line.slice(bailoutPrefix.length).trim();
    if (message.length === 0) {
      this.add("report.bailout", "Bail out! requires a message.");
    }
    if (this.plan !== undefined && this.pointCount >= this.plan) {
      this.add("report.bailout", "A bailout after plan satisfaction is invalid.");
    }
    this.bailoutMessage = message;
    this.phase = "terminal";
  }

  private finishNormal(exitCode: number | undefined): void {
    if (this.decoderFailed) {
      return;
    }
    if (!this.lineEndingValid || !this.terminalLf || this.textSuffix.length > 0) {
      this.addOnce("report.line_ending", "The report must end with a terminal LF.");
      this.addOnce("report.incomplete", "The report is not completely flushed.");
    }
    switch (this.phase) {
      case "header":
        this.addOnce("report.header", "The report has no TAP version line.");
        break;
      case "comment":
        this.addOnce("report.adapter_version", "The report has no adapter comment.");
        break;
      case "plan":
        this.addOnce("report.plan", "The report has no leading plan.");
        this.addOnce("report.incomplete", "The report stops before its plan.");
        break;
      case "block-open":
      case "block":
        this.addOnce("report.yaml", "The final point has no complete YAML block.");
        this.addOnce("report.incomplete", "The report ends inside a point.");
        break;
      case "point":
        if (this.plan !== undefined && this.pointCount < this.plan) {
          this.addOnce(
            "report.incomplete",
            `The plan requires ${this.plan} points; ${this.pointCount} are complete.`,
          );
        }
        break;
      case "terminal":
      case "stopped":
        break;
    }
    this.checkSelection();
    if (this.diagnosticCodes.length === 0 && exitCode !== undefined) {
      const expectedExit =
        this.bailoutMessage !== undefined ? 2 : this.failureCount > 0 ? 1 : 0;
      if (exitCode !== expectedExit) {
        this.add(
          "report.exit",
          `Report lifecycle requires exit ${expectedExit}; received ${exitCode}.`,
        );
      }
    }
  }

  private finishCancellation(exitCode: number | null | undefined): FoundryTapCompletion {
    if (exitCode !== undefined && exitCode !== null) {
      this.add("report.cancellation", "A cancelled run has no portable exit code.");
    }
    const complete = this.isComplete();
    if (this.bailoutMessage !== undefined || complete) {
      this.add("report.cancellation", "A bailout or satisfied plan is not cancellation.");
    }
    if (
      this.diagnosticCodes.length > 0 &&
      !this.diagnosticCodes.includes("report.cancellation")
    ) {
      this.add("report.cancellation", "The completed prefix is malformed.");
    }
    const codes = unique(this.diagnosticCodes);
    const valid = codes.length === 0;
    return {
      valid,
      complete: false,
      classification: valid ? "cancelled" : "invalid",
      codes,
      diagnostics: [...this.diagnosticMessages],
    };
  }

  private isComplete(): boolean {
    return (
      !this.decoderFailed &&
      this.encodingValid &&
      this.lineEndingValid &&
      this.plan !== undefined &&
      this.terminalLf &&
      this.textSuffix.length === 0 &&
      !this.stoppedEarly &&
      this.pointCount >= this.plan
    );
  }

  private checkSelection(): void {
    if (this.expectedLeaves === undefined || this.plan === undefined) {
      return;
    }
    const expectedIds = this.expectedLeaves.map((leaf) => leaf.id);
    if (this.plan !== expectedIds.length || this.reportedIds.length !== this.pointCount) {
      return;
    }
    if (this.pointCount < this.plan) {
      const expectedPrefix = expectedIds.slice(0, this.reportedIds.length);
      if (!same(this.reportedIds, expectedPrefix)) {
        this.addOnce("report.selection", "Reported points are not a planned prefix.");
      }
      return;
    }
    if (!sameSorted(this.reportedIds, expectedIds)) {
      this.addOnce("report.selection", "Reported IDs do not match selected leaves.");
    } else if (!same(this.reportedIds, expectedIds)) {
      this.addOnce("report.order", "Reported points do not follow discovery order.");
    }
  }

  private add(code: string, message: string): void {
    this.diagnosticCodes.push(code);
    this.diagnosticMessages.push(message);
  }

  private addOnce(code: string, message: string): void {
    if (!this.diagnosticCodes.includes(code)) {
      this.add(code, message);
    }
  }
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
  );
}

function isCanonicalResourcePath(value: string): boolean {
  if (!value.startsWith("res://") || value.includes("\\")) {
    return false;
  }
  const relative = value.slice("res://".length);
  if (relative === "" || relative.endsWith("/")) {
    return false;
  }
  return relative
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameSorted(left: readonly string[], right: readonly string[]): boolean {
  return same([...left].sort(), [...right].sort());
}
