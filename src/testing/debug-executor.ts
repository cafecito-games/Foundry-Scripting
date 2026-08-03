import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import { TestAdapterFailure } from "./adapter.js";
import type {
  TestExecutionObserver,
  TestExecutionRequest,
  TestExecutionResult,
} from "./executor.js";
import { FoundryTap13Parser } from "./report.js";

export interface FoundryTestDebugSession {
  readonly id: string;
  readonly configuration: vscode.DebugConfiguration;
}

export interface FoundryTestDebugMessageEvent {
  readonly direction: "adapter" | "client";
  readonly session: FoundryTestDebugSession;
  readonly message: unknown;
}

interface DisposableHandle {
  dispose(): void;
}

export interface FoundryTestDebugExecutorOptions {
  readonly startDebugging: (
    configuration: vscode.DebugConfiguration,
    options: vscode.DebugSessionOptions,
  ) => PromiseLike<boolean>;
  readonly stopDebugging: (session: FoundryTestDebugSession) => PromiseLike<void>;
  readonly onDidStartDebugSession: (
    listener: (session: FoundryTestDebugSession) => void,
  ) => DisposableHandle;
  readonly onDidTerminateDebugSession: (
    listener: (session: FoundryTestDebugSession) => void,
  ) => DisposableHandle;
  readonly onDidDebugMessage: (
    listener: (event: FoundryTestDebugMessageEvent) => void,
  ) => DisposableHandle;
  readonly readArtifact?: (artifactPath: string) => Promise<Buffer>;
  readonly makeTemporaryDirectory?: (prefix: string) => Promise<string>;
  readonly removeTemporaryDirectory?: (directory: string) => Promise<void>;
  readonly waitForPoll?: () => Promise<void>;
  readonly temporaryRoot?: string;
  readonly onCleanupError?: (error: unknown, directory: string) => void;
  readonly maxReportBytes?: number;
  readonly now?: () => number;
  readonly sessionStartTimeoutMs?: number;
  readonly reportReadinessTimeoutMs?: number;
  readonly terminationTimeoutMs?: number;
}

export class FoundryTestDebugExecutor {
  private readonly readArtifact;
  private readonly makeTemporaryDirectory;
  private readonly removeTemporaryDirectory;
  private readonly temporaryRoot;
  private readonly onCleanupError;
  private readonly waitForPoll;
  private readonly maxReportBytes;
  private readonly now;
  private readonly sessionStartTimeoutMs;
  private readonly reportReadinessTimeoutMs;
  private readonly terminationTimeoutMs;

  constructor(private readonly options: FoundryTestDebugExecutorOptions) {
    this.readArtifact = options.readArtifact ?? readFile;
    this.makeTemporaryDirectory = options.makeTemporaryDirectory ?? mkdtemp;
    this.removeTemporaryDirectory =
      options.removeTemporaryDirectory ??
      ((directory: string) => rm(directory, { recursive: true, force: true }));
    this.temporaryRoot = options.temporaryRoot ?? os.tmpdir();
    this.onCleanupError = options.onCleanupError;
    this.waitForPoll =
      options.waitForPoll ??
      (() => new Promise((resolve) => setTimeout(resolve, 20)));
    this.maxReportBytes = options.maxReportBytes ?? 16 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    this.sessionStartTimeoutMs = options.sessionStartTimeoutMs ?? 30_000;
    this.reportReadinessTimeoutMs =
      options.reportReadinessTimeoutMs ?? 30_000;
    this.terminationTimeoutMs = options.terminationTimeoutMs ?? 5_000;
  }

  async execute(
    request: TestExecutionRequest,
    signal: AbortSignal,
    observer: TestExecutionObserver,
    testRun: vscode.TestRun,
  ): Promise<TestExecutionResult> {
    const temporaryDirectory = await this.makeTemporaryDirectory(
      path.join(this.temporaryRoot, "foundryscript-test-debug-"),
    );
    const reportPath = path.join(temporaryDirectory, "report.tap");
    const configuration = createFoundryTestDebugConfiguration(request, reportPath);
    let session: FoundryTestDebugSession | undefined;
    let terminated = false;
    let exitCode: number | undefined;
    let cancellationRequested = signal.aborted;
    let cancellationRequestedAt = signal.aborted ? this.now() : undefined;
    let stopPromise: Promise<void> | undefined;
    let stdout = "";
    let stderr = "";
    let launchFailure: string | undefined;
    let restartGeneration = 0;
    let processCount = 0;
    const stopSession = (): Promise<void> => {
      if (session === undefined || terminated) return Promise.resolve();
      if (stopPromise !== undefined) return stopPromise;
      stopPromise = Promise.resolve(this.options.stopDebugging(session)).catch(
        (error: unknown) => {
          stderr += `Unable to stop FoundryScript test debugging: ${errorMessage(error)}\n`;
        },
      );
      return stopPromise;
    };
    const onAbort = (): void => {
      cancellationRequested = true;
      cancellationRequestedAt ??= this.now();
      void stopSession();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const matches = (candidate: FoundryTestDebugSession): boolean =>
      reportPathFor(candidate.configuration) === reportPath;
    const subscriptions = [
      this.options.onDidStartDebugSession((candidate) => {
        if (!matches(candidate)) return;
        session = candidate;
        if (cancellationRequested) void stopSession();
      }),
      this.options.onDidTerminateDebugSession((candidate) => {
        if (matches(candidate)) terminated = true;
      }),
      this.options.onDidDebugMessage((event) => {
        if (!matches(event.session)) return;
        const message = event.message;
        if (
          event.direction === "client" &&
          isRecord(message) &&
          message.type === "request" &&
          (message.command === "disconnect" || message.command === "terminate")
        ) {
          cancellationRequested = true;
          cancellationRequestedAt ??= this.now();
        }
        if (
          event.direction === "client" &&
          isRecord(message) &&
          message.type === "request" &&
          message.command === "restart"
        ) {
          restartGeneration += 1;
        }
        if (
          event.direction === "adapter" &&
          isRecord(message) &&
          message.type === "event" &&
          message.event === "process"
        ) {
          processCount += 1;
          if (processCount > 1) restartGeneration += 1;
          exitCode = undefined;
        }
        if (
          event.direction === "adapter" &&
          isRecord(message) &&
          message.type === "event" &&
          message.event === "exited" &&
          isRecord(message.body) &&
          typeof message.body.exitCode === "number"
        ) {
          exitCode = message.body.exitCode;
        }
        if (
          event.direction === "adapter" &&
          isRecord(message) &&
          message.type === "event" &&
          message.event === "output" &&
          isRecord(message.body) &&
          typeof message.body.output === "string"
        ) {
          const stream = message.body.category === "stderr" ? "stderr" : "stdout";
          if (stream === "stderr") stderr += message.body.output;
          else stdout += message.body.output;
          observer.onOutput(message.body.output, stream);
        }
        if (
          event.direction === "adapter" &&
          isRecord(message) &&
          message.type === "response" &&
          message.command === "launch" &&
          message.success === false
        ) {
          launchFailure =
            typeof message.message === "string"
              ? message.message
              : "The debug adapter rejected the structured test launch.";
        }
      }),
    ];
    try {
      const started = await this.options.startDebugging(configuration, {
        noDebug: false,
        testRun,
      });
      if (!started) {
        throw new TestAdapterFailure(
          "spawn_failed",
          "VS Code did not start the FoundryScript test debug session.",
        );
      }
      const sessionStartedAt = this.now();
      while (session === undefined) {
        if (this.now() - sessionStartedAt >= this.sessionStartTimeoutMs) {
          throw new TestAdapterFailure(
            "readiness_timeout",
            `VS Code did not publish the FoundryScript test debug session within ${String(this.sessionStartTimeoutMs)} ms.`,
            { phase: "execution", stdout, stderr },
          );
        }
        await this.waitForPoll();
      }
      const published = new Set<string>();
      const createParser = (): FoundryTap13Parser =>
        new FoundryTap13Parser(request.leaves, (point) => {
          if (published.has(point.testId)) return;
          published.add(point.testId);
          observer.onPoint(point);
        });
      let parser = createParser();
      let consumed: Buffer = Buffer.alloc(0);
      let consumedGeneration = restartGeneration;
      const resetForRestart = (): void => {
        if (consumedGeneration === restartGeneration) return;
        parser = createParser();
        consumed = Buffer.alloc(0);
        consumedGeneration = restartGeneration;
      };
      const reportReadinessStartedAt = this.now();
      while (!terminated) {
        resetForRestart();
        consumed = await this.readNewBytes(reportPath, consumed, parser, true);
        if (
          consumed.length === 0 &&
          this.now() - reportReadinessStartedAt >=
            this.reportReadinessTimeoutMs
        ) {
          await stopSession();
          throw new TestAdapterFailure(
            "readiness_timeout",
            `The FoundryScript test debug session produced no TAP report bytes within ${String(this.reportReadinessTimeoutMs)} ms.`,
            { phase: "execution", stdout, stderr },
          );
        }
        if (
          cancellationRequestedAt !== undefined &&
          this.now() - cancellationRequestedAt >= this.terminationTimeoutMs
        ) {
          await stopPromise;
          throw new TestAdapterFailure(
            "readiness_timeout",
            `The DAP-owned FoundryScript test process did not terminate within ${String(this.terminationTimeoutMs)} ms after cancellation.`,
            { phase: "execution", stdout, stderr },
          );
        }
        await this.waitForPoll();
      }
      resetForRestart();
      consumed = await this.readNewBytes(
        reportPath,
        consumed,
        parser,
        cancellationRequested || launchFailure !== undefined,
      );
      if (launchFailure !== undefined) {
        throw new TestAdapterFailure(
          "spawn_failed",
          `The FoundryScript debug adapter rejected the test launch: ${launchFailure}`,
          { phase: "execution", stdout, stderr },
        );
      }
      const cancelled = cancellationRequested && exitCode === undefined;
      const completion = parser.finish(
        cancelled
          ? { kind: "cancelled" }
          : { kind: "exited", exitCode: exitCode ?? 1 },
      );
      return {
        kind: cancelled ? "cancelled" : "completed",
        completion,
        processResult: cancelled
          ? { kind: "cancelled", stdout, stderr }
          : {
              kind: "exited",
              exitCode: exitCode ?? 1,
              stdout,
              stderr,
            },
      };
    } catch (error) {
      if (!(error instanceof TestAdapterFailure)) throw error;
      throw new TestAdapterFailure(error.kind, error.message, {
        ...(error.setting === undefined ? {} : { setting: error.setting }),
        phase: error.phase ?? "execution",
        stdout: error.stdout ?? stdout,
        stderr: error.stderr ?? stderr,
        ...(error.exitCode === undefined
          ? exitCode === undefined
            ? {}
            : { exitCode }
          : { exitCode: error.exitCode }),
        ...(error.signal === undefined ? {} : { signal: error.signal }),
        cause: error,
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
      for (const subscription of subscriptions) subscription.dispose();
      try {
        await this.removeTemporaryDirectory(temporaryDirectory);
      } catch (error) {
        this.onCleanupError?.(error, temporaryDirectory);
      }
    }
  }

  private async readNewBytes(
    reportPath: string,
    consumed: Buffer,
    parser: FoundryTap13Parser,
    allowMissing: boolean,
  ): Promise<Buffer> {
    let bytes: Buffer;
    try {
      bytes = await this.readArtifact(reportPath);
    } catch (error) {
      if (allowMissing && errorCode(error) === "ENOENT") return consumed;
      throw new TestAdapterFailure(
        "report_read_failed",
        errorCode(error) === "ENOENT"
          ? "The Foundry test debug report does not exist."
          : "Unable to read the Foundry test debug report.",
        { phase: "execution", cause: error },
      );
    }
    if (bytes.length > this.maxReportBytes) {
      throw new TestAdapterFailure(
        "malformed_report",
        `The Foundry test debug report exceeded ${String(this.maxReportBytes)} bytes.`,
        { phase: "execution" },
      );
    }
    if (
      bytes.length < consumed.length ||
      !bytes.subarray(0, consumed.length).equals(consumed)
    ) {
      throw new TestAdapterFailure(
        "malformed_report",
        "The Foundry test debug report changed previously consumed bytes.",
        { phase: "execution" },
      );
    }
    if (bytes.length > consumed.length) {
      parser.push(bytes.subarray(consumed.length));
    }
    return Buffer.from(bytes);
  }
}

export function createFoundryTestDebugConfiguration(
  request: TestExecutionRequest,
  reportPath: string,
): vscode.DebugConfiguration {
  return {
    type: "foundryscript",
    request: "launch",
    name: "Debug Foundry Tests",
    project: request.project,
    noDebug: false,
    "foundry/launch": {
      kind: "project_test",
      runner: request.runner,
      adapter: {
        protocolVersion: request.protocolVersion,
        report: reportPath,
        testIds: request.leaves.map((leaf) => leaf.id),
      },
    },
  };
}

function reportPathFor(configuration: vscode.DebugConfiguration): string | undefined {
  const launch: unknown = configuration["foundry/launch"];
  if (!isRecord(launch) || !isRecord(launch.adapter)) return undefined;
  return typeof launch.adapter.report === "string"
    ? launch.adapter.report
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && "code" in error ? String(error.code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
