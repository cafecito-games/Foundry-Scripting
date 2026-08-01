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
  createTestAdapterDiscoveryCommand,
} from "./command.js";
import {
  TestDiscoveryParseError,
  type TestDiscoveryModel,
  parseTestDiscovery,
} from "./discovery.js";
import {
  FoundryTestAdapterProcess,
  TestAdapterProcessFailure,
  type TestAdapterProcessResult,
} from "./process.js";

export interface TestAdapterDiscoveryRequest
  extends TestAdapterNegotiationRequest {
  readonly project: string;
  readonly protocolVersion: number;
}

export interface FoundryTestAdapterDiscovererOptions {
  readonly runProcess?: (
    command: TestAdapterCommand,
    signal: AbortSignal,
  ) => Promise<TestAdapterProcessResult>;
  readonly readArtifact?: (artifactPath: string) => Promise<Buffer>;
  readonly makeTemporaryDirectory?: (prefix: string) => Promise<string>;
  readonly removeTemporaryDirectory?: (directory: string) => Promise<void>;
  readonly onCleanupError?: (error: unknown, directory: string) => void;
  readonly temporaryRoot?: string;
}

export class FoundryTestAdapterDiscoverer {
  private readonly runProcess;
  private readonly readArtifact;
  private readonly makeTemporaryDirectory;
  private readonly removeTemporaryDirectory;
  private readonly onCleanupError;
  private readonly temporaryRoot;

  constructor(options: FoundryTestAdapterDiscovererOptions = {}) {
    if (options.runProcess === undefined) {
      const process = new FoundryTestAdapterProcess();
      this.runProcess = (command: TestAdapterCommand, signal: AbortSignal) =>
        process.run(command, signal);
    } else {
      this.runProcess = options.runProcess;
    }
    this.readArtifact = options.readArtifact ?? readFile;
    this.makeTemporaryDirectory = options.makeTemporaryDirectory ?? mkdtemp;
    this.removeTemporaryDirectory =
      options.removeTemporaryDirectory ??
      ((directory: string) => rm(directory, { recursive: true, force: true }));
    this.onCleanupError = options.onCleanupError;
    this.temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  }

  async discover(
    request: TestAdapterDiscoveryRequest,
    signal: AbortSignal,
  ): Promise<TestDiscoveryModel> {
    const temporaryDirectory = await this.makeTemporaryDirectory(
      path.join(this.temporaryRoot, "foundryscript-test-discovery-"),
    );
    const outputPath = path.join(temporaryDirectory, "discovery.jsonl");
    try {
      const command = this.createCommand(request, outputPath);
      const processResult = await this.run(command, signal);
      if (processResult.kind === "cancelled") {
        throw abortError();
      }
      if (isAbnormalProcessExit(processResult)) {
        throw createProcessCrashFailure("discovery", processResult);
      }

      const bytes = await this.readDiscovery(outputPath, processResult);
      const model = this.parseDiscovery(bytes, processResult);
      const expectedExit = model.errorCount > 0 ? 1 : 0;
      if (processResult.exitCode !== expectedExit) {
        throw new TestAdapterFailure(
          "discovery_exit_mismatch",
          `Foundry test adapter discovery exited with exit code ${String(processResult.exitCode)}; expected ${expectedExit}.`,
          {
            stdout: processResult.stdout,
            stderr: processResult.stderr,
          },
        );
      }
      return model;
    } finally {
      try {
        await this.removeTemporaryDirectory(temporaryDirectory);
      } catch (error) {
        try {
          this.onCleanupError?.(error, temporaryDirectory);
        } catch {
          // Cleanup diagnostics must never replace the discovery outcome.
        }
      }
    }
  }

  private createCommand(
    request: TestAdapterDiscoveryRequest,
    outputPath: string,
  ): TestAdapterCommand {
    try {
      return createTestAdapterDiscoveryCommand({ ...request, outputPath });
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
  ): Promise<TestAdapterProcessResult> {
    try {
      return await this.runProcess(command, signal);
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

  private async readDiscovery(
    outputPath: string,
    processResult: TestAdapterProcessResult,
  ): Promise<Buffer> {
    try {
      return await this.readArtifact(outputPath);
    } catch (error) {
      const missing = errorCode(error) === "ENOENT";
      if (missing && processResult.exitCode !== 0) {
        throw createProcessCrashFailure("discovery", processResult, error);
      }
      throw new TestAdapterFailure(
        "read_failed",
        missing
          ? "The Foundry test adapter discovery artifact does not exist."
          : "Unable to read the Foundry test adapter discovery artifact.",
        {
          stdout: processResult.stdout,
          stderr: processResult.stderr,
          cause: error,
        },
      );
    }
  }

  private parseDiscovery(
    bytes: Buffer,
    processResult: TestAdapterProcessResult,
  ): TestDiscoveryModel {
    try {
      return parseTestDiscovery(bytes);
    } catch (error) {
      if (!(error instanceof TestDiscoveryParseError)) {
        throw error;
      }
      throw new TestAdapterFailure(error.kind, error.message, {
        stdout: processResult.stdout,
        stderr: processResult.stderr,
        cause: error,
      });
    }
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String(error.code);
}

function abortError(): Error {
  const error = new Error("Foundry test adapter discovery was cancelled.");
  error.name = "AbortError";
  return error;
}
