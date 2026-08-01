import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  readonly readArtifact?: (artifactPath: string) => Promise<Buffer>;
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
  private readonly readArtifact;
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
    this.readArtifact = options.readArtifact ?? readFile;
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
    try {
      const command = this.createCommand(request, reportPath);
      const parser = new FoundryTap13Parser(request.leaves, observer.onPoint);
      let consumed: Buffer = Buffer.alloc(0);
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

      while (!settled) {
        consumed = await this.readNewBytes(reportPath, consumed, parser, false);
        reportReady ||= consumed.length > 0;
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
      consumed = await this.readNewBytes(
        reportPath,
        consumed,
        parser,
        true,
        processResult.kind === "cancelled" ||
          cause !== undefined ||
          isAbnormalProcessExit(processResult) ||
          (processResult.exitCode !== undefined && processResult.exitCode !== 0),
      );
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
        consumed.length === 0
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
        await this.removeTemporaryDirectory(temporaryDirectory);
      } catch (error) {
        try {
          this.onCleanupError?.(error, temporaryDirectory);
        } catch {
          // Cleanup diagnostics must not replace the execution outcome.
        }
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

  private async readNewBytes(
    reportPath: string,
    consumed: Buffer,
    parser: FoundryTap13Parser,
    final: boolean,
    allowMissing = false,
  ): Promise<Buffer> {
    let bytes: Buffer;
    try {
      bytes = await this.readArtifact(reportPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT" && (!final || allowMissing)) {
        return consumed;
      }
      throw new TestAdapterFailure(
        "report_read_failed",
        errorCode(error) === "ENOENT"
          ? "The Foundry test adapter execution report does not exist."
          : "Unable to read the Foundry test adapter execution report.",
        { cause: error },
      );
    }
    if (
      bytes.length < consumed.length ||
      !bytes.subarray(0, consumed.length).equals(consumed)
    ) {
      throw new TestAdapterFailure(
        "malformed_report",
        "The Foundry test adapter execution report changed previously consumed bytes.",
      );
    }
    if (bytes.length > consumed.length) {
      parser.push(bytes.subarray(consumed.length));
    }
    return Buffer.from(bytes);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String(error.code);
}
