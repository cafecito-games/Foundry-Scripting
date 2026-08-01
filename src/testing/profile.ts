import path from "node:path";
import type * as vscode from "vscode";
import type {
  TestExecutionObserver,
  TestExecutionRequest,
  TestExecutionResult,
} from "./executor.js";
import type { FoundryTestExplorerSnapshot } from "./explorer.js";
import type { FoundryTapPoint } from "./report.js";
import type { TestingReadyContext } from "./runtime.js";
import { selectRunnableLeaves } from "./selection.js";

interface TestMessageValue {
  message: string;
  location?: unknown;
}

export interface FoundryTestRunProfileOptions {
  readonly controller: Pick<vscode.TestController, "createTestRun">;
  readonly readyContext: () => TestingReadyContext | undefined;
  readonly snapshot: () => FoundryTestExplorerSnapshot | undefined;
  readonly execute: (
    request: TestExecutionRequest,
    signal: AbortSignal,
    observer: TestExecutionObserver,
  ) => Promise<TestExecutionResult>;
  readonly createMessage: (message: string) => TestMessageValue;
  readonly createLocation: (
    nativePath: string,
    line: number,
    character: number,
  ) => unknown;
}

export class FoundryTestRunProfile {
  constructor(private readonly options: FoundryTestRunProfileOptions) {}

  async run(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const run = this.options.controller.createTestRun(request);
    let selected: readonly vscode.TestItem[] = [];
    let cancellation: vscode.Disposable | undefined;

    try {
      const ready = this.options.readyContext();
      const snapshot = this.options.snapshot();
      if (
        ready === undefined ||
        ready.configuration.project === undefined ||
        snapshot === undefined ||
        snapshot.model !== ready.model
      ) {
        run.appendOutput("Foundry test execution is not ready.\r\n");
        return;
      }
      const project = ready.configuration.project;

      const leaves = selectRunnableLeaves(
        snapshot.model,
        request.include?.map((item) => item.id),
        request.exclude?.map((item) => item.id) ?? [],
      );
      const items = leaves.map((leaf) => snapshot.item(leaf.id));
      if (items.some((item) => item === undefined)) {
        selected = items.filter((item): item is vscode.TestItem => item !== undefined);
        this.invalidate(
          run,
          selected,
          "Foundry test infrastructure could not resolve the selected test items.",
        );
        return;
      }
      selected = items as readonly vscode.TestItem[];
      if (selected.length === 0) {
        return;
      }

      for (const item of selected) {
        run.enqueued(item);
      }
      for (const item of selected) {
        run.started(item);
      }

      const byId = new Map(selected.map((item) => [item.id, item] as const));
      const completed = new Set<string>();
      let routingFailure: string | undefined;
      const abortController = new AbortController();
      cancellation = token.onCancellationRequested(() => abortController.abort());
      if (token.isCancellationRequested) {
        abortController.abort();
      }

      const observer: TestExecutionObserver = {
        onOutput: (text) => run.appendOutput(toCrlf(text)),
        onPoint: (point) => {
          const item = byId.get(point.testId);
          if (item === undefined) {
            routingFailure = `Foundry test infrastructure reported an unknown test ID: ${point.testId}`;
            return;
          }
          completed.add(point.testId);
          this.publishPoint(run, project, item, point);
        },
      };
      const result = await this.options.execute(
        {
          enginePath: ready.configuration.enginePath,
          project,
          runner: ready.configuration.runner,
          frameworkArgs: ready.configuration.frameworkArgs,
          protocolVersion: ready.adapter.protocolVersion,
          leaves: leaves.map((leaf) => ({
            id: leaf.id,
            skipped: leaf.skipped,
            skipReason: leaf.skipReason,
          })),
        },
        abortController.signal,
        observer,
      );

      if (routingFailure !== undefined) {
        this.invalidate(run, selected, routingFailure);
        return;
      }
      if (isGenuineCancellation(result)) {
        for (const item of selected) {
          if (!completed.has(item.id)) {
            run.skipped(item);
          }
        }
        return;
      }
      if (!isSuccessfulCompletion(result)) {
        this.invalidate(run, selected, completionMessage(result));
      }
    } catch (error) {
      this.invalidate(
        run,
        selected,
        `Foundry test infrastructure failed: ${errorMessage(error)}`,
      );
    } finally {
      cancellation?.dispose();
      run.end();
    }
  }

  private publishPoint(
    run: vscode.TestRun,
    project: string,
    item: vscode.TestItem,
    point: FoundryTapPoint,
  ): void {
    if (point.skipReason !== undefined) {
      run.skipped(item);
      return;
    }
    if (point.ok) {
      run.passed(item, point.durationMs);
      return;
    }

    const message = this.options.createMessage(
      point.message ?? "Foundry test failed without a diagnostic message.",
    );
    if (point.location !== undefined) {
      message.location = this.options.createLocation(
        path.join(project, point.location.fileName.slice("res://".length)),
        point.location.lineNumber - 1,
        point.location.columnNumber - 1,
      );
    }
    if (point.statusDetail === "") {
      run.failed(item, message as vscode.TestMessage, point.durationMs);
    } else {
      run.errored(item, message as vscode.TestMessage, point.durationMs);
    }
  }

  private invalidate(
    run: vscode.TestRun,
    selected: readonly vscode.TestItem[],
    diagnostic: string,
  ): void {
    const message = diagnostic.toLowerCase().includes("infrastructure")
      ? diagnostic
      : `Foundry test infrastructure failed: ${diagnostic}`;
    run.appendOutput(`${toCrlf(message)}\r\n`);
    for (const item of selected) {
      run.errored(item, this.options.createMessage(message) as vscode.TestMessage);
    }
  }
}

function isGenuineCancellation(result: TestExecutionResult): boolean {
  return (
    result.kind === "cancelled" &&
    result.completion.valid &&
    result.completion.classification === "cancelled"
  );
}

function isSuccessfulCompletion(result: TestExecutionResult): boolean {
  return (
    result.kind === "completed" &&
    result.completion.valid &&
    (result.completion.classification === "conforming" ||
      result.completion.classification === "test_failures")
  );
}

function completionMessage(result: TestExecutionResult): string {
  const details = result.completion.diagnostics.join(" ").trim();
  if (details.length > 0) {
    return `Foundry test infrastructure failed: ${details}`;
  }
  return `Foundry test infrastructure failed with ${result.completion.classification}.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toCrlf(text: string): string {
  return text.replace(/\r?\n/gu, "\r\n");
}
