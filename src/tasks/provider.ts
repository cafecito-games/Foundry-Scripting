import * as vscode from "vscode";
import type { DiagnosticsUnit } from "../diagnostics/index.js";
import type { ProjectResolutionFailure } from "../project/resolver.js";
import {
  createWorkspaceProjectResolver,
  type ResolveWorkspaceProject,
} from "../project/workspace.js";
import {
  FOUNDRY_TASK_KINDS,
  FoundryTaskConfigurationError,
  createFoundryTaskCommand,
  type FoundryTaskKind,
} from "./command.js";
import {
  FoundryTaskProcess,
  type FoundryTaskProcessError,
  type FoundryTaskProcessOptions,
} from "./process.js";
import {
  FoundryLintDiagnosticsPublisher,
  type FoundryLintRun,
} from "./lint-diagnostics.js";
import { LintReportError } from "./lint-report.js";

export const FOUNDRY_TASK_TYPE = "foundryscript";

export interface FoundryTaskProviderOptions extends FoundryTaskProcessOptions {
  readonly diagnostics?: DiagnosticsUnit;
  readonly resolveProject?: ResolveWorkspaceProject;
}

export class FoundryTaskProvider implements vscode.TaskProvider {
  private readonly lintPublisher: FoundryLintDiagnosticsPublisher | undefined;
  private readonly resolveProject: ResolveWorkspaceProject;

  constructor(
    private readonly processOptions: FoundryTaskProviderOptions = {},
  ) {
    this.resolveProject =
      processOptions.resolveProject ?? createWorkspaceProjectResolver();
    this.lintPublisher =
      processOptions.diagnostics === undefined
        ? undefined
        : new FoundryLintDiagnosticsPublisher(processOptions.diagnostics);
  }

  provideTasks(): vscode.Task[] {
    return FOUNDRY_TASK_KINDS.map((kind) =>
      this.createTask({ type: FOUNDRY_TASK_TYPE, command: kind }, kind),
    );
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const kind: unknown = task.definition.command;
    if (!isFoundryTaskKind(kind)) {
      return undefined;
    }
    return this.createTask(task.definition, kind);
  }

  private createTask(
    definition: vscode.TaskDefinition,
    kind: FoundryTaskKind,
  ): vscode.Task {
    const execution = new vscode.CustomExecution(
      () =>
        Promise.resolve(
          new FoundryTaskTerminal(
            kind,
            this.processOptions,
            this.lintPublisher,
            this.resolveProject,
          ),
        ),
    );
    const task = new vscode.Task(
      definition,
      vscode.TaskScope.Workspace,
      `Foundry: ${taskLabel(kind)}`,
      "FoundryScript",
      execution,
      [],
    );
    if (kind === "build") {
      task.group = vscode.TaskGroup.Build;
    } else if (kind === "test") {
      task.group = vscode.TaskGroup.Test;
    }
    return task;
  }
}

export function registerFoundryTaskProvider(
  context: vscode.ExtensionContext,
  diagnostics?: DiagnosticsUnit,
  resolveProject?: ResolveWorkspaceProject,
): void {
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(
      FOUNDRY_TASK_TYPE,
      new FoundryTaskProvider({ diagnostics, resolveProject }),
    ),
  );
}

class FoundryTaskTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private process: FoundryTaskProcess | undefined;
  private lintRun: FoundryLintRun | undefined;
  private closed = false;

  constructor(
    private readonly kind: FoundryTaskKind,
    private readonly processOptions: FoundryTaskProcessOptions,
    private readonly lintPublisher: FoundryLintDiagnosticsPublisher | undefined,
    private readonly resolveProject: ResolveWorkspaceProject,
  ) {}

  open(): void {
    void this.start();
  }

  private async start(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("foundryScript");
    try {
      const resolution = await this.resolveProject();
      if (this.closed) return;
      if (!resolution.success) {
        this.reportProjectFailure(resolution.failure);
        this.closeEmitter.fire(1);
        return;
      }
      const command = createFoundryTaskCommand({
        kind: this.kind,
        enginePath: configuration.get("enginePath", "foundry"),
        project: resolution.project,
        testRunner: configuration.get("test.runner", ""),
      });
      this.lintRun =
        this.kind === "lint"
          ? this.lintPublisher?.beginRun(command.cwd)
          : undefined;
      this.process = new FoundryTaskProcess(
        command,
        {
          write: (text, stream) => {
            this.writeEmitter.fire(text);
            if (stream === "stdout") {
              this.lintRun?.appendStdout(text);
            }
          },
          fail: (error) => {
            this.lintRun = undefined;
            this.reportProcessError(error);
          },
          close: (exitCode) => {
            this.closeEmitter.fire(this.completeLintRun(exitCode));
          },
        },
        this.processOptions,
      );
      this.process.start();
    } catch (error) {
      if (error instanceof FoundryTaskConfigurationError) {
        this.reportConfigurationError(error);
        this.closeEmitter.fire(1);
        return;
      }
      const message = `Unable to resolve the Foundry project: ${error instanceof Error ? error.message : String(error)}`;
      this.writeEmitter.fire(`Error: ${message}\r\n`);
      void vscode.window.showErrorMessage(message);
      this.closeEmitter.fire(1);
    }
  }

  close(): void {
    this.closed = true;
    this.process?.cancel();
  }

  private reportConfigurationError(
    error: FoundryTaskConfigurationError,
  ): void {
    this.writeEmitter.fire(`Error: ${error.message}\r\n`);
    if (error.kind === "missing_project") {
      void showOpenFolderError(error.message);
      return;
    }
    void showOpenSettingsError(error.message, error.setting);
  }

  private reportProjectFailure(failure: ProjectResolutionFailure): void {
    this.writeEmitter.fire(`Error: ${failure.message}\r\n`);
    if (failure.kind === "missing_workspace") {
      void showOpenFolderError(failure.message);
    } else if (failure.setting !== undefined) {
      void showOpenSettingsError(failure.message, failure.setting);
    } else {
      void vscode.window.showErrorMessage(failure.message);
    }
  }

  private reportProcessError(error: FoundryTaskProcessError): void {
    this.writeEmitter.fire(`Error: ${error.message}\r\n`);
    if (error.kind === "missing_engine") {
      void showOpenSettingsError(error.message, error.setting);
      return;
    }
    void vscode.window.showErrorMessage(error.message);
  }

  private completeLintRun(exitCode: number | undefined): number | undefined {
    try {
      this.lintRun?.complete(exitCode);
      return exitCode;
    } catch (error) {
      if (!(error instanceof LintReportError)) {
        throw error;
      }
      const message = `Could not ingest Foundry lint JSON: ${error.message}`;
      this.writeEmitter.fire(`Error: ${message}\r\n`);
      void vscode.window.showErrorMessage(message);
      return 1;
    }
  }
}

function isFoundryTaskKind(value: unknown): value is FoundryTaskKind {
  return (
    typeof value === "string" &&
    FOUNDRY_TASK_KINDS.some((kind) => kind === value)
  );
}

function taskLabel(kind: FoundryTaskKind): string {
  return kind[0].toUpperCase() + kind.slice(1);
}

async function showOpenSettingsError(
  message: string,
  setting: string | undefined,
): Promise<void> {
  const selection = await vscode.window.showErrorMessage(
    message,
    "Open Settings",
  );
  if (selection === "Open Settings") {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      setting,
    );
  }
}

async function showOpenFolderError(message: string): Promise<void> {
  const selection = await vscode.window.showErrorMessage(message, "Open Folder");
  if (selection === "Open Folder") {
    await vscode.commands.executeCommand("workbench.action.files.openFolder");
  }
}
