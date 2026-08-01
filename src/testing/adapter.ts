import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TestAdapterCapabilitiesError,
  type NegotiatedTestAdapter,
  parseAndNegotiateCapabilities,
} from "./capabilities.js";
import {
  TestAdapterConfigurationError,
  type TestAdapterConfigurationErrorKind,
  type TestAdapterCommand,
  createTestAdapterCapabilitiesCommand,
} from "./command.js";
import {
  FoundryTestAdapterProcess,
  TestAdapterProcessFailure,
  type TestAdapterProcessResult,
} from "./process.js";

export interface TestAdapterNegotiationRequest {
  readonly enginePath: string;
  readonly project: string | undefined;
  readonly runner: string;
  readonly frameworkArgs: readonly string[];
}

export type TestAdapterFailureKind =
  | TestAdapterConfigurationErrorKind
  | "malformed_capabilities"
  | "incompatible_adapter"
  | "process_failed"
  | "legacy_runner"
  | "spawn_failed"
  | "read_failed";

interface TestAdapterFailureOptions extends ErrorOptions {
  readonly setting?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}

export class TestAdapterFailure extends Error {
  readonly setting: string | undefined;
  readonly stdout: string | undefined;
  readonly stderr: string | undefined;

  constructor(
    readonly kind: TestAdapterFailureKind,
    message: string,
    options: TestAdapterFailureOptions = {},
  ) {
    super(message, options);
    this.name = "TestAdapterFailure";
    this.setting = options.setting;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }
}

export interface FoundryTestAdapterNegotiatorOptions {
  readonly clientVersions?: readonly number[];
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

export class FoundryTestAdapterNegotiator {
  private readonly clientVersions;
  private readonly runProcess;
  private readonly readArtifact;
  private readonly makeTemporaryDirectory;
  private readonly removeTemporaryDirectory;
  private readonly onCleanupError;
  private readonly temporaryRoot;

  constructor(options: FoundryTestAdapterNegotiatorOptions = {}) {
    this.clientVersions = options.clientVersions ?? [1];
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

  async negotiate(
    request: TestAdapterNegotiationRequest,
    signal: AbortSignal,
  ): Promise<NegotiatedTestAdapter> {
    const temporaryDirectory = await this.makeTemporaryDirectory(
      path.join(this.temporaryRoot, "foundryscript-test-adapter-"),
    );
    const outputPath = path.join(temporaryDirectory, "capabilities.json");
    try {
      const command = this.createCommand(request, outputPath);
      const processResult = await this.run(command, signal);
      if (processResult.kind === "cancelled") {
        throw abortError();
      }

      const bytes = await this.readCapabilities(outputPath, processResult);
      const adapter = this.parseCapabilities(bytes, processResult);
      if (processResult.exitCode !== 0) {
        throw new TestAdapterFailure(
          "process_failed",
          `Foundry test adapter capabilities exited with exit code ${processResult.exitCode}.`,
          {
            stdout: processResult.stdout,
            stderr: processResult.stderr,
          },
        );
      }
      return adapter;
    } finally {
      try {
        await this.removeTemporaryDirectory(temporaryDirectory);
      } catch (error) {
        try {
          this.onCleanupError?.(error, temporaryDirectory);
        } catch {
          // Cleanup diagnostics must never replace the negotiation outcome.
        }
      }
    }
  }

  private createCommand(
    request: TestAdapterNegotiationRequest,
    outputPath: string,
  ): TestAdapterCommand {
    try {
      return createTestAdapterCapabilitiesCommand({ ...request, outputPath });
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

  private async readCapabilities(
    outputPath: string,
    processResult: TestAdapterProcessResult,
  ): Promise<Buffer> {
    try {
      return await this.readArtifact(outputPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new TestAdapterFailure(
          "legacy_runner",
          "The configured runner does not implement Foundry Test Adapter Protocol capabilities.",
          {
            stdout: processResult.stdout,
            stderr: processResult.stderr,
            cause: error,
          },
        );
      }
      throw new TestAdapterFailure(
        "read_failed",
        "Unable to read the Foundry test adapter capabilities artifact.",
        {
          stdout: processResult.stdout,
          stderr: processResult.stderr,
          cause: error,
        },
      );
    }
  }

  private parseCapabilities(
    bytes: Buffer,
    processResult: TestAdapterProcessResult,
  ): NegotiatedTestAdapter {
    try {
      return parseAndNegotiateCapabilities(bytes, this.clientVersions);
    } catch (error) {
      if (!(error instanceof TestAdapterCapabilitiesError)) {
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
  const error = new Error("Foundry test adapter negotiation was cancelled.");
  error.name = "AbortError";
  return error;
}
