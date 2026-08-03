import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProcessCrashFailure,
  isAbnormalProcessExit,
  TestAdapterFailure,
  type TestAdapterNegotiationRequest,
} from "./adapter.js";
import {
  TestAdapterConfigurationError,
  type TestAdapterCommand,
  createTestAdapterRunCommand,
} from "./command.js";
import {
  FoundryTestAdapterProcess,
  TestAdapterProcessFailure,
  type TestAdapterProcessResult,
} from "./process.js";
import {
  FoundryTap13Parser,
  type FoundryTapCompletion,
  type FoundryTapPlanLeaf,
  type FoundryTapPoint,
} from "./report.js";
import {
  IncrementalReportReader,
  type ReportFileAccess,
} from "./report-reader.js";

export interface TestExecutionRequest extends TestAdapterNegotiationRequest {
  readonly project: string;
  readonly protocolVersion: number;
  readonly leaves: readonly FoundryTapPlanLeaf[];
}

export interface TestExecutionObserver {
  readonly onPoint: (point: FoundryTapPoint) => void;
  readonly onOutput: (text: string, stream: "stdout" | "stderr") => void;
}

export interface TestExecutionResult {
  readonly kind: "completed" | "cancelled";
  readonly completion: FoundryTapCompletion;
  readonly processResult: TestAdapterProcessResult;
}

export interface FoundryTestExecutorOptions {
  readonly runProcess?: (
    command: TestAdapterCommand,
    signal: AbortSignal,
    onOutput?: (text: string, stream: "stdout" | "stderr") => void,
  ) => Promise<TestAdapterProcessResult>;
  readonly reportFileAccess?: ReportFileAccess;
  readonly makeTemporaryDirectory?: (prefix: string) => Promise<string>;
  readonly removeTemporaryDirectory?: (directory: string) => Promise<void>;
  readonly waitForPoll?: () => Promise<void>;
  readonly now?: () => number;
  readonly readinessTimeoutMs?: number;
  readonly onCleanupError?: (error: unknown, directory: string) => void;
  readonly temporaryRoot?: string;
}

export class FoundryTestExecutor {
  private readonly runProcess;
  private readonly reportFileAccess;
  private readonly makeTemporaryDirectory;
  private readonly removeTemporaryDirectory;
  private readonly waitForPoll;
  private readonly now;
  private readonly readinessTimeoutMs;
  private readonly onCleanupError;
  private readonly temporaryRoot;

  constructor(options: FoundryTestExecutorOptions = {}) {
    if (options.runProcess === undefined) {
      const process = new FoundryTestAdapterProcess();
      this.runProcess = (
        command: TestAdapterCommand,
        signal: AbortSignal,
        onOutput?: (text: string, stream: "stdout" | "stderr") => void,
      ) => process.run(command, signal, onOutput);
    } else {
      this.runProcess = options.runProcess;
    }
    this.reportFileAccess = options.reportFileAccess;
    this.makeTemporaryDirectory = options.makeTemporaryDirectory ?? mkdtemp;
    this.removeTemporaryDirectory =
      options.removeTemporaryDirectory ??
      ((directory: string) => rm(directory, { recursive: true, force: true }));
    this.waitForPoll =
      options.waitForPoll ??
      (() => new Promise((resolve) => setTimeout(resolve, 20)));
    this.now = options.now ?? Date.now;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
    this.onCleanupError = options.onCleanupError;
    this.temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  }

  async execute(
    request: TestExecutionRequest,
    signal: AbortSignal,
    observer: TestExecutionObserver,
  ): Promise<TestExecutionResult> {
    const temporaryDirectory = await this.makeTemporaryDirectory(
      path.join(this.temporaryRoot, "foundryscript-test-run-"),
    );
    const reportPath = path.join(temporaryDirectory, "report.tap");
    const controller = new AbortController();
    let cause: "user" | "readiness_timeout" | undefined;
    const onUserCancellation = (): void => {
      if (cause === undefined) {
        cause = "user";
      }
      controller.abort();
    };
    signal.addEventListener("abort", onUserCancellation, { once: true });
    if (signal.aborted) {
      onUserCancellation();
    }
    let processPromise: Promise<TestAdapterProcessResult> | undefined;
    const reportReader = new IncrementalReportReader(
      reportPath,
      this.reportFileAccess,
    );
    try {
      const command = this.createCommand(request, reportPath);
      const parser = new FoundryTap13Parser(request.leaves, observer.onPoint);
      let consumedBytes = 0;
      let reportReady = false;
      let settled = false;
      const readinessStartedAt = this.now();
      processPromise = this.run(
        command,
        controller.signal,
        observer.onOutput,
      ).finally(() => {
        settled = true;
      });
      void processPromise.catch(() => undefined);

      while (!settled) {
        const read = await reportReader.readAvailable((chunk) => parser.push(chunk));
        consumedBytes = read.totalBytes;
        reportReady ||= consumedBytes > 0;
        if (
          !reportReady &&
          cause === undefined &&
          this.now() - readinessStartedAt >= this.readinessTimeoutMs
        ) {
          cause = "readiness_timeout";
          controller.abort();
        }
        if (!settled) {
          await Promise.race([
            processPromise.then(
              () => undefined,
              () => undefined,
            ),
            this.waitForPoll(),
          ]);
        }
      }

      const processResult = await processPromise;
      const allowMissing =
        processResult.kind === "cancelled" ||
          cause !== undefined ||
          isAbnormalProcessExit(processResult) ||
          (processResult.exitCode !== undefined && processResult.exitCode !== 0);
      const finalRead = await reportReader.readAvailable((chunk) => parser.push(chunk));
      consumedBytes = finalRead.totalBytes;
      if (!finalRead.present) {
        if (!allowMissing) {
          throw missingReportFailure();
        }
      } else {
        const verification = await reportReader.verifyFinal();
        if (!verification.present && !allowMissing) {
          throw missingReportFailure();
        }
      }
      if (cause === "readiness_timeout") {
        throw new TestAdapterFailure(
          "readiness_timeout",
          `Foundry test adapter execution produced no report bytes within ${this.readinessTimeoutMs} ms.`,
          {
            phase: "execution",
            stdout: processResult.stdout,
            stderr: processResult.stderr,
          },
        );
      }
      if (isAbnormalProcessExit(processResult)) {
        throw createProcessCrashFailure("execution", processResult);
      }
      if (
        processResult.kind === "exited" &&
        processResult.exitCode !== undefined &&
        processResult.exitCode !== 0 &&
        consumedBytes === 0
      ) {
        throw createProcessCrashFailure("execution", processResult);
      }
      if (processResult.kind === "cancelled" && cause !== "user") {
        throw createProcessCrashFailure("execution", processResult);
      }
      const completion = parser.finish(
        cause === "user"
          ? { kind: "cancelled" }
          : { kind: "exited", exitCode: processResult.exitCode ?? 1 },
      );
      return {
        kind: cause === "user" ? "cancelled" : "completed",
        completion,
        processResult,
      };
    } catch (error) {
      controller.abort();
      await processPromise?.catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener("abort", onUserCancellation);
      try {
        await reportReader.close();
      } catch (error) {
        this.reportCleanupError(error, temporaryDirectory);
      }
      try {
        await this.removeTemporaryDirectory(temporaryDirectory);
      } catch (error) {
        this.reportCleanupError(error, temporaryDirectory);
      }
    }
  }

  private createCommand(
    request: TestExecutionRequest,
    reportPath: string,
  ): TestAdapterCommand {
    try {
      return createTestAdapterRunCommand({
        ...request,
        reportPath,
        selections: request.leaves.map((leaf) => leaf.id),
      });
    } catch (error) {
      if (!(error instanceof TestAdapterConfigurationError)) {
        throw error;
      }
      throw new TestAdapterFailure(error.kind, error.message, {
        setting: error.setting,
        cause: error,
      });
    }
  }

  private async run(
    command: TestAdapterCommand,
    signal: AbortSignal,
    onOutput: (text: string, stream: "stdout" | "stderr") => void,
  ): Promise<TestAdapterProcessResult> {
    try {
      return await this.runProcess(command, signal, onOutput);
    } catch (error) {
      if (!(error instanceof TestAdapterProcessFailure)) {
        throw error;
      }
      throw new TestAdapterFailure(error.kind, error.message, {
        setting: error.setting,
        cause: error,
      });
    }
  }

  private reportCleanupError(error: unknown, directory: string): void {
    try {
      this.onCleanupError?.(error, directory);
    } catch {
      // Cleanup diagnostics must not replace the execution outcome.
    }
  }
}

function missingReportFailure(): TestAdapterFailure {
  return new TestAdapterFailure(
    "report_read_failed",
    "The Foundry test adapter execution report does not exist.",
  );
}
