import * as vscode from "vscode";
import {
  type ConnectionManager,
  type ConnectionSettings,
} from "./client/connection-manager.js";
import {
  CONNECTION_ACTIONS_COMMAND,
  ConnectionStatusController,
} from "./client/connection-status.js";
import { HostStartupFailure } from "./client/host-launcher.js";
import { writeLog } from "./client/logging.js";
import { createConnectionManager } from "./client/runtime.js";
import { createDiagnosticsUnit } from "./diagnostics/index.js";
import { registerFoundryTaskProvider } from "./tasks/provider.js";
import {
  FoundryTestAdapterNegotiator,
  type TestAdapterFailure,
} from "./testing/adapter.js";
import { FoundryTestAdapterDiscoverer } from "./testing/discoverer.js";
import { FoundryTestExplorer } from "./testing/explorer.js";
import { FoundryTestAdapterProcess } from "./testing/process.js";
import {
  TestingRuntime,
  type TestingRuntimeConfiguration,
} from "./testing/runtime.js";
import {
  TestingStatusController,
  type TestingState,
} from "./testing/status.js";

let activeConnectionManager: ConnectionManager | undefined;
let activeTestingRuntime: TestingRuntime | undefined;

const TESTING_CONFIGURATION_SECTIONS = [
  "foundryScript.testing.enabled",
  "foundryScript.testing.runner",
  "foundryScript.testing.args",
  "foundryScript.enginePath",
] as const;

function readConnectionSettings(): ConnectionSettings {
  const configuration = vscode.workspace.getConfiguration("foundryScript");
  return {
    mode: configuration.get("lsp.mode", "spawn"),
    port: configuration.get("lsp.port", 6005),
    enginePath: configuration.get("enginePath", "foundry"),
  };
}

async function showStartupError(error: unknown): Promise<void> {
  const message =
    error instanceof Error
      ? error.message
      : `Foundry language server startup failed: ${String(error)}`;
  if (error instanceof HostStartupFailure && error.kind === "missing_engine") {
    const selection = await vscode.window.showErrorMessage(
      message,
      "Open Settings",
    );
    if (selection === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "foundryScript.enginePath",
      );
    }
    return;
  }
  await vscode.window.showErrorMessage(message);
}

function readTestingConfiguration(): TestingRuntimeConfiguration {
  const configuration = vscode.workspace.getConfiguration("foundryScript");
  return {
    enabled: configuration.get("testing.enabled", false),
    enginePath: configuration.get("enginePath", "foundry"),
    project: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    runner: configuration.get("testing.runner", ""),
    frameworkArgs: configuration.get("testing.args", []),
  };
}

function configureTesting(runtime: TestingRuntime): void {
  void runtime.configure(readTestingConfiguration());
}

function registerTestingRuntime(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("FoundryScript Testing");
  const controller = vscode.tests.createTestController(
    "foundryScript.tests",
    "FoundryScript",
  );
  const explorer = new FoundryTestExplorer(controller, {
    createUri: (nativePath) => vscode.Uri.file(nativePath),
    createRange: (range) =>
      new vscode.Range(
        range.start.line,
        range.start.character,
        range.end.line,
        range.end.character,
      ),
  });
  const status = new TestingStatusController(() =>
    vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90),
  );
  const process = new FoundryTestAdapterProcess({
    onOutput: (text) => output.append(text),
  });
  const onCleanupError = (error: unknown, directory: string): void => {
    output.appendLine(
      `Unable to remove test adapter temporary directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  };
  const negotiator = new FoundryTestAdapterNegotiator({
    runProcess: (command, signal) => process.run(command, signal),
    onCleanupError,
  });
  const discoverer = new FoundryTestAdapterDiscoverer({
    runProcess: (command, signal) => process.run(command, signal),
    onCleanupError,
  });
  const runtime = new TestingRuntime({
    negotiate: (request, signal) => negotiator.negotiate(request, signal),
    discover: (request, signal) => discoverer.discover(request, signal),
    onDiscovery: (project, model) => explorer.reconcile(project, model),
    onClear: () => explorer.clear(),
    onState: (state) => {
      status.update(state);
      writeTestingState(output, state);
      if (state.kind === "error") {
        void showTestingFailure(state.failure, output);
      }
    },
  });
  controller.refreshHandler = async (token) => {
    if (token.isCancellationRequested) {
      return;
    }
    await runtime.refresh();
  };
  activeTestingRuntime = runtime;
  context.subscriptions.push(
    output,
    status,
    controller,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        TESTING_CONFIGURATION_SECTIONS.some((section) =>
          event.affectsConfiguration(section),
        )
      ) {
        configureTesting(runtime);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => configureTesting(runtime)),
    {
      dispose: () => {
        if (activeTestingRuntime === runtime) {
          activeTestingRuntime = undefined;
        }
        void runtime.stop();
      },
    },
  );
  configureTesting(runtime);
}

function writeTestingState(output: vscode.OutputChannel, state: TestingState): void {
  switch (state.kind) {
    case "disabled":
      output.appendLine("Testing adapter negotiation disabled.");
      return;
    case "negotiating":
      output.appendLine(`Negotiating test adapter ${state.runner}.`);
      return;
    case "discovering":
      output.appendLine(
        `Discovering tests with ${state.adapter.framework.name}, ` +
          `protocol ${state.adapter.protocolVersion}.`,
      );
      return;
    case "ready":
      output.appendLine(
        `Test adapter ready: ${state.adapter.framework.name} ` +
          `(${state.adapter.framework.id} ${state.adapter.framework.version}), ` +
          `protocol ${state.adapter.protocolVersion}, ` +
          `discovery errors ${state.discoveryErrorCount}.`,
      );
      return;
    case "error":
      output.appendLine(
        `Test adapter unavailable [${state.failure.kind}]: ${state.failure.message}`,
      );
  }
}

async function showTestingFailure(
  failure: TestAdapterFailure,
  output: vscode.OutputChannel,
): Promise<void> {
  if (failure.setting !== undefined) {
    const selection = await vscode.window.showErrorMessage(
      failure.message,
      "Open Settings",
      "Open Testing Log",
    );
    if (selection === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        failure.setting,
      );
    } else if (selection === "Open Testing Log") {
      output.show();
    }
    return;
  }
  if (failure.kind === "missing_project") {
    const selection = await vscode.window.showErrorMessage(
      failure.message,
      "Open Folder",
      "Open Testing Log",
    );
    if (selection === "Open Folder") {
      await vscode.commands.executeCommand(
        "workbench.action.files.openFolder",
      );
    } else if (selection === "Open Testing Log") {
      output.show();
    }
    return;
  }
  const selection = await vscode.window.showErrorMessage(
    failure.message,
    "Open Testing Log",
  );
  if (selection === "Open Testing Log") {
    output.show();
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const diagnostics = createDiagnosticsUnit(() =>
    vscode.languages.createDiagnosticCollection("foundryscript"),
  );
  context.subscriptions.push(diagnostics);
  registerFoundryTaskProvider(context, diagnostics);
  const outputChannel = vscode.window.createOutputChannel("FoundryScript LSP");
  context.subscriptions.push(outputChannel);
  const settings = readConnectionSettings();
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  const statusController = new ConnectionStatusController(statusItem, {
    showQuickPick: (items, options) =>
      vscode.window.showQuickPick(items, options),
    reconnectNow: async () => {
      if (activeConnectionManager !== undefined) {
        await activeConnectionManager.reconnectNow();
      } else {
        await vscode.commands.executeCommand("vscode.openFolder");
      }
    },
    openLog: () => outputChannel.show(),
    openSettings: async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "foundryScript.lsp.mode",
      );
    },
  });
  statusItem.show();
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand(CONNECTION_ACTIONS_COMMAND, async () =>
      statusController.showActions(),
    ),
  );
  registerTestingRuntime(context);
  if (settings.mode === "off") {
    statusController.update({ kind: "off" });
    writeLog(outputChannel, "info", "lsp.connection.off");
    return;
  }
  statusController.update({ kind: "disconnected" });

  const project = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (project === undefined) {
    await vscode.window.showErrorMessage(
      "Open a Foundry project folder before starting the language server.",
    );
    return;
  }

  const manager = createConnectionManager(
    outputChannel,
    project,
    (state) => statusController.update(state),
    diagnostics,
  );
  activeConnectionManager = manager;
  context.subscriptions.push({
    dispose: () => {
      void manager.stop();
    },
  });

  try {
    await manager.start({ settings, project });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      statusController.update({ kind: "disconnected" });
      if (activeConnectionManager === manager) {
        activeConnectionManager = undefined;
      }
      await manager.stop();
      return;
    }
    writeLog(outputChannel, "error", "lsp.connection.failed", {
      project,
      message: error instanceof Error ? error.message : String(error),
    });
    statusController.update({ kind: "disconnected" });
    await showStartupError(error);
  }
}

export async function deactivate(): Promise<void> {
  const manager = activeConnectionManager;
  const testingRuntime = activeTestingRuntime;
  activeConnectionManager = undefined;
  activeTestingRuntime = undefined;
  await Promise.all([manager?.stop(), testingRuntime?.stop()]);
}
