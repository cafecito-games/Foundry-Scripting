import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FoundryTestAdapterNegotiator } from "./adapter.js";
import { FoundryTestAdapterDiscoverer } from "./discoverer.js";
import { FoundryTestExecutor } from "./executor.js";
import { FoundryTestAdapterProcess } from "./process.js";
import { selectRunnableLeaves } from "./selection.js";

export interface LiveFoundryTestRunOptions {
  readonly foundry: string;
  readonly project: string;
  readonly runner: string;
  readonly root: string;
}

export interface LiveFoundryTestRunResult {
  readonly protocolVersion: number;
  readonly selectedIds: readonly string[];
  readonly pointIds: readonly string[];
  readonly pointBeforeExit: boolean;
  readonly applicationStdoutObserved: boolean;
  readonly completion: string;
  readonly temporaryArtifactsCleaned: boolean;
}

const cleanOutputRoot =
  "res://tests/testlib/adapter_fixtures/live/clean";
const continuationEnvironment = "FOUNDRYLIB_ADAPTER_CONTINUE_FILE";

export async function verifyLiveFoundryTestRun(
  options: LiveFoundryTestRunOptions,
): Promise<LiveFoundryTestRunResult> {
  const adapterProcess = new FoundryTestAdapterProcess();
  const request = {
    enginePath: options.foundry,
    project: options.project,
    runner: options.runner,
    frameworkArgs: ["--path", options.root],
  } as const;
  const adapter = await new FoundryTestAdapterNegotiator({
    runProcess: (command, signal) => adapterProcess.run(command, signal),
  }).negotiate(request, new AbortController().signal);
  requireCondition(adapter.protocolVersion === 1, "Expected negotiated protocol v1.");

  const discoverer = new FoundryTestAdapterDiscoverer({
    runProcess: (command, signal) => adapterProcess.run(command, signal),
  });
  const model = await discoverer.discover(
    { ...request, protocolVersion: adapter.protocolVersion },
    new AbortController().signal,
  );
  const suite = model.items.find((item) => item.kind === "suite");
  requireCondition(suite !== undefined, "Streaming discovery returned no suite.");
  const leaves = selectRunnableLeaves(model, [suite.id], []);
  requireCondition(leaves.length > 0, "Streaming suite selected no runnable leaves.");
  const discoveredIds = new Set(model.items.map((item) => item.id));
  requireCondition(
    leaves.every((leaf) => discoveredIds.has(leaf.id)),
    "A requested ID did not come from authoritative discovery.",
  );

  const continuationDirectory = await mkdtemp(
    path.join(os.tmpdir(), "foundryscript-live-continuation-"),
  );
  const continuationPath = path.join(continuationDirectory, "continue");
  const previousContinuation = process.env[continuationEnvironment];
  process.env[continuationEnvironment] = continuationPath;
  const executionDirectories: string[] = [];
  let executionExited = false;
  let pointBeforeExit = false;
  const pointIds: string[] = [];
  const output: Array<{ readonly text: string; readonly stream: "stdout" | "stderr" }> = [];

  try {
    const executor = new FoundryTestExecutor({
      runProcess: async (command, signal, onOutput) => {
        const result = await adapterProcess.run(command, signal, onOutput);
        executionExited = true;
        return result;
      },
      makeTemporaryDirectory: async (prefix) => {
        const directory = await mkdtemp(prefix);
        executionDirectories.push(directory);
        return directory;
      },
    });
    const streaming = await executor.execute(
      {
        ...request,
        protocolVersion: adapter.protocolVersion,
        leaves: leaves.map((leaf) => ({
          id: leaf.id,
          skipped: leaf.skipped,
          skipReason: leaf.skipReason,
        })),
      },
      new AbortController().signal,
      {
        onPoint: (point) => {
          pointIds.push(point.testId);
          if (pointIds.length === 1) {
            pointBeforeExit = !executionExited;
            writeFileSync(continuationPath, "continue\n", "utf8");
          }
        },
        onOutput: (text, stream) => output.push({ text, stream }),
      },
    );
    requireCondition(
      streaming.completion.valid &&
        streaming.completion.complete &&
        streaming.completion.classification === "conforming",
      `Streaming completion was ${streaming.completion.classification}: ${streaming.completion.diagnostics.join(" ")}`,
    );
    requireCondition(pointBeforeExit, "No complete point was observed before process exit.");
    requireCondition(
      same(pointIds, leaves.map((leaf) => leaf.id)),
      "Streaming point IDs did not match the selected discovery-order plan.",
    );

    const cleanRequest = {
      ...request,
      frameworkArgs: ["--path", cleanOutputRoot],
    };
    const cleanModel = await discoverer.discover(
      { ...cleanRequest, protocolVersion: adapter.protocolVersion },
      new AbortController().signal,
    );
    const cleanLeaves = selectRunnableLeaves(cleanModel, undefined, []);
    executionExited = false;
    const clean = await executor.execute(
      {
        ...cleanRequest,
        protocolVersion: adapter.protocolVersion,
        leaves: cleanLeaves.map((leaf) => ({
          id: leaf.id,
          skipped: leaf.skipped,
          skipReason: leaf.skipReason,
        })),
      },
      new AbortController().signal,
      {
        onPoint: () => undefined,
        onOutput: (text, stream) => output.push({ text, stream }),
      },
    );
    requireCondition(
      clean.completion.valid && clean.completion.classification === "conforming",
      "The application-output control run did not conform.",
    );
    const applicationStdoutObserved = output.some(
      (entry) =>
        entry.stream === "stdout" &&
        entry.text.includes("adapter fixture stdout noise"),
    );
    requireCondition(
      applicationStdoutObserved,
      "The run-scoped observer did not receive application stdout.",
    );
    const temporaryArtifactsCleaned = executionDirectories.every(
      (directory) => !existsSync(directory),
    );
    requireCondition(
      temporaryArtifactsCleaned,
      "An executor-owned temporary directory remains after completion.",
    );
    return {
      protocolVersion: adapter.protocolVersion,
      selectedIds: leaves.map((leaf) => leaf.id),
      pointIds,
      pointBeforeExit,
      applicationStdoutObserved,
      completion: streaming.completion.classification,
      temporaryArtifactsCleaned,
    };
  } finally {
    if (previousContinuation === undefined) {
      delete process.env[continuationEnvironment];
    } else {
      process.env[continuationEnvironment] = previousContinuation;
    }
    await rm(continuationDirectory, { recursive: true, force: true });
  }
}

function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
