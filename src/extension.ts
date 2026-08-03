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
import {
  createConnectionManager,
  createToolingHostCoordinator,
} from "./client/runtime.js";
import { createDiagnosticsUnit } from "./diagnostics/index.js";
import {
  registerFoundryScriptDebugRuntime,
  type FoundryScriptDebugRuntime,
} from "./debug/runtime.js";
import type { ProjectResolutionFailure } from "./project/resolver.js";
import {
  createWorkspaceProjectResolver,
  type ResolveWorkspaceProject,
} from "./project/workspace.js";
import { registerFoundryTaskProvider } from "./tasks/provider.js";
import {
  FoundryTestAdapterNegotiator,
  TestAdapterFailure,
} from "./testing/adapter.js";
import { FoundryTestAdapterDiscoverer } from "./testing/discoverer.js";
import {
  FoundryTestDebugExecutor,
  type FoundryTestDebugMessageEvent,
  type FoundryTestDebugSession,
} from "./testing/debug-executor.js";
import { FoundryTestExecutor } from "./testing/executor.js";
import { FoundryTestExplorer } from "./testing/explorer.js";
import { FoundryTestAdapterProcess } from "./testing/process.js";
import { FoundryTestRunProfile } from "./testing/profile.js";
import {
  TestingRefreshCoordinator,
  isRelevantTestingWorkspacePath,
} from "./testing/refresh.js";
import {
  TestingRuntime,
  type TestingRuntimeConfiguration,
} from "./testing/runtime.js";
import {
  TestingStatusController,
  type TestingState,
} from "./testing/status.js";
import type { ToolingHostCoordinator } from "./tooling/coordinator.js";

let activeConnectionManager: ConnectionManager | undefined;
let activeToolingHostCoordinator: ToolingHostCoordinator | undefined;
let activeDebugRuntime: FoundryScriptDebugRuntime | undefined;
interface ActiveTestingLifecycle {
  readonly stop: () => Promise<void>;
}

let activeTestingLifecycle: ActiveTestingLifecycle | undefined;

const TESTING_CONFIGURATION_SECTIONS = [
  "foundryScript.testing.enabled",
  "foundryScript.testing.runner",
  "foundryScript.testing.args",
  "foundryScript.enginePath",
  "foundryScript.projectPath",
] as const;

function readConnectionSettings(): ConnectionSettings {
  const configuration = vscode.workspace.getConfiguration("foundryScript");
  return {
    mode: configuration.get("lsp.mode", "spawn"),
    port: configuration.get("lsp.port", 6005),
    dapPort: configuration.get("dap.port", 6006),
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

async function readTestingConfiguration(
  resolveProject: ResolveWorkspaceProject,
): Promise<TestingRuntimeConfiguration> {
  const configuration = vscode.workspace.getConfiguration("foundryScript");
  const enabled = configuration.get("testing.enabled", false);
  const base = {
    enabled,
    enginePath: configuration.get("enginePath", "foundry"),
    runner: configuration.get("testing.runner", ""),
    frameworkArgs: configuration.get("testing.args", []),
  };
  if (!enabled) return { ...base, project: undefined };

  const resolution = await resolveProject();
  if (resolution.success) return { ...base, project: resolution.project };
  const failure = resolution.failure;
  return {
    ...base,
    project: undefined,
    projectFailure: new TestAdapterFailure(
      failure.kind === "missing_workspace"
        ? "missing_project"
        : "invalid_project",
      failure.message,
      {
        ...(failure.setting === undefined ? {} : { setting: failure.setting }),
        ...(failure.cause === undefined ? {} : { cause: failure.cause }),
      },
    ),
  };
}

async function registerTestingRuntime(
  context: vscode.ExtensionContext,
  resolveProject: ResolveWorkspaceProject,
): Promise<void> {
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
  const executor = new FoundryTestExecutor({
    runProcess: (command, signal, onOutput) =>
      process.run(command, signal, onOutput),
    onCleanupError,
  });
  const debugStartListeners = new Set<
    (session: FoundryTestDebugSession) => void
  >();
  const debugTerminationListeners = new Set<
    (session: FoundryTestDebugSession) => void
  >();
  const debugMessageListeners = new Set<
    (event: FoundryTestDebugMessageEvent) => void
  >();
  const subscribe = <T>(listeners: Set<T>, listener: T): vscode.Disposable => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  };
  const debugTracker = vscode.debug.registerDebugAdapterTrackerFactory(
    "foundryscript",
    {
      createDebugAdapterTracker: (session) => {
        let terminated = false;
        const terminate = (): void => {
          if (terminated) return;
          terminated = true;
          for (const listener of debugTerminationListeners) listener(session);
        };
        return {
          onWillStartSession: () => {
            for (const listener of debugStartListeners) listener(session);
          },
          onWillReceiveMessage: (message) => {
            for (const listener of debugMessageListeners) {
              listener({ direction: "client", session, message });
            }
          },
          onDidSendMessage: (message) => {
            for (const listener of debugMessageListeners) {
              listener({ direction: "adapter", session, message });
            }
          },
          onWillStopSession: terminate,
          onExit: terminate,
        };
      },
    },
  );
  const debugExecutor = new FoundryTestDebugExecutor({
    startDebugging: (configuration, debugOptions) =>
      vscode.debug.startDebugging(undefined, configuration, debugOptions),
    stopDebugging: (session) =>
      vscode.debug.stopDebugging(session as vscode.DebugSession),
    onDidStartDebugSession: (listener) =>
      subscribe(debugStartListeners, listener),
    onDidTerminateDebugSession: (listener) =>
      subscribe(debugTerminationListeners, listener),
    onDidDebugMessage: (listener) => subscribe(debugMessageListeners, listener),
    onCleanupError,
  });
  let shownFailureFingerprint: string | undefined;
  let failureConfigurationKey: string | undefined;
  const runtime = new TestingRuntime({
    negotiate: (request, signal) => negotiator.negotiate(request, signal),
    discover: (request, signal) => discoverer.discover(request, signal),
    onDiscovery: (project, model) => explorer.reconcile(project, model),
    onClear: () => explorer.clear(),
    onState: (state) => {
      status.update(state);
      writeTestingState(output, state);
      if (
        state.kind === "error" &&
        isActionableTestingFailure(state.failure)
      ) {
        const fingerprint = testingFailureFingerprint(state.failure);
        if (fingerprint === shownFailureFingerprint) {
          return;
        }
        shownFailureFingerprint = fingerprint;
        void showTestingFailure(state.failure, output);
      }
    },
  });
  const refresh = new TestingRefreshCoordinator({
    refresh: (signal) => runtime.refresh(signal),
    onError: (error) => {
      output.appendLine(
        `Scheduled test refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  let watcherProject: string | undefined;
  let watcherDisposables: vscode.Disposable[] = [];
  const disposeWatchers = (): void => {
    for (const disposable of watcherDisposables) {
      disposable.dispose();
    }
    watcherDisposables = [];
    watcherProject = undefined;
  };
  const updateWatchers = (
    configuration: TestingRuntimeConfiguration,
  ): void => {
    refresh.cancelPending();
    const project = configuration.enabled ? configuration.project : undefined;
    if (project === watcherProject) {
      return;
    }
    disposeWatchers();
    if (project === undefined) {
      return;
    }
    watcherProject = project;
    const onWorkspacePath = (uri: vscode.Uri): void => {
      if (isRelevantTestingWorkspacePath(project, uri.fsPath)) {
        refresh.workspaceChanged();
      }
    };
    for (const pattern of ["**/*.fs", "project.foundry"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(project, pattern),
      );
      watcherDisposables.push(
        watcher,
        watcher.onDidCreate(onWorkspacePath),
        watcher.onDidChange(onWorkspacePath),
        watcher.onDidDelete(onWorkspacePath),
      );
    }
  };
  let configurationGeneration = 0;
  const configure = async (): Promise<void> => {
    const generation = ++configurationGeneration;
    const configuration = await readTestingConfiguration(resolveProject);
    if (generation !== configurationGeneration) return;
    const key = JSON.stringify(configuration);
    if (key !== failureConfigurationKey) {
      failureConfigurationKey = key;
      shownFailureFingerprint = undefined;
    }
    updateWatchers(configuration);
    await runtime.configure(configuration);
  };
  const runProfile = new FoundryTestRunProfile({
    controller,
    readyContext: () => runtime.readyContext(),
    snapshot: () => explorer.snapshot(),
    execute: (request, signal, observer) =>
      executor.execute(request, signal, observer),
    createMessage: (message) => new vscode.TestMessage(message),
    createLocation: (nativePath, line, character) =>
      new vscode.Location(
        vscode.Uri.file(nativePath),
        new vscode.Position(line, character),
      ),
  });
  controller.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    async (request, token) => runProfile.run(request, token),
    true,
  );
  const debugProfile = new FoundryTestRunProfile({
    controller,
    readyContext: () => runtime.readyContext(),
    snapshot: () => explorer.snapshot(),
    execute: (request, signal, observer, run) =>
      debugExecutor.execute(request, signal, observer, run),
    createMessage: (message) => new vscode.TestMessage(message),
    createLocation: (nativePath, line, character) =>
      new vscode.Location(
        vscode.Uri.file(nativePath),
        new vscode.Position(line, character),
      ),
  });
  controller.createRunProfile(
    "Debug",
    vscode.TestRunProfileKind.Debug,
    async (request, token) => debugProfile.run(request, token),
    true,
  );
  controller.refreshHandler = async (token) => {
    if (token.isCancellationRequested) {
      return;
    }
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested?.(
      () => controller.abort(),
    );
    try {
      await refresh.explicitRefresh(controller.signal);
    } finally {
      cancellation?.dispose();
    }
  };
  let stopPromise: Promise<void> | undefined;
  const lifecycle: ActiveTestingLifecycle = {
    stop: () => {
      if (stopPromise !== undefined) {
        return stopPromise;
      }
      refresh.dispose();
      disposeWatchers();
      stopPromise = Promise.all([runtime.stop(), process.stop()]).then(
        () => undefined,
      );
      return stopPromise;
    },
  };
  activeTestingLifecycle = lifecycle;
  context.subscriptions.push(
    output,
    status,
    controller,
    debugTracker,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        TESTING_CONFIGURATION_SECTIONS.some((section) =>
          event.affectsConfiguration(section),
        )
      ) {
        void configure();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void configure()),
    {
      dispose: () => {
        if (activeTestingLifecycle === lifecycle) {
          activeTestingLifecycle = undefined;
        }
        void lifecycle.stop();
      },
    },
  );
  await configure();
}

async function showProjectResolutionFailure(
  failure: ProjectResolutionFailure,
): Promise<void> {
  if (failure.kind === "missing_workspace") {
    const selection = await vscode.window.showErrorMessage(
      failure.message,
      "Open Folder",
    );
    if (selection === "Open Folder") {
      await vscode.commands.executeCommand("workbench.action.files.openFolder");
    }
    return;
  }
  if (failure.setting !== undefined) {
    const selection = await vscode.window.showErrorMessage(
      failure.message,
      "Open Settings",
    );
    if (selection === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        failure.setting,
      );
    }
    return;
  }
  await vscode.window.showErrorMessage(failure.message);
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
    case "refresh_cancelled":
      output.appendLine("Test discovery refresh cancelled; prior results retained.");
      return;
    case "error":
      output.appendLine(
        `Test adapter unavailable [${state.failure.kind}]: ${state.failure.message}${testingFailureLifecycleSuffix(state.failure)}`,
      );
      if (state.failure.stdout !== undefined && state.failure.stdout !== "") {
        output.appendLine(`stdout: ${state.failure.stdout.trimEnd()}`);
      }
      if (state.failure.stderr !== undefined && state.failure.stderr !== "") {
        output.appendLine(`stderr: ${state.failure.stderr.trimEnd()}`);
      }
  }
}

function testingFailureLifecycleSuffix(failure: TestAdapterFailure): string {
  const details = [
    failure.phase === undefined ? undefined : `phase ${failure.phase}`,
    failure.exitCode === undefined
      ? undefined
      : `exit code ${failure.exitCode}`,
    failure.signal === undefined ? undefined : `signal ${failure.signal}`,
  ].filter((value): value is string => value !== undefined);
  return details.length === 0 ? "" : ` (${details.join(", ")})`;
}

function isActionableTestingFailure(failure: TestAdapterFailure): boolean {
  return (
    failure.setting !== undefined ||
    failure.kind === "missing_project" ||
    failure.kind === "legacy_runner" ||
    failure.kind === "incompatible_adapter"
  );
}

function testingFailureFingerprint(failure: TestAdapterFailure): string {
  return JSON.stringify([failure.kind, failure.setting ?? null, failure.message]);
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
  const resolveProject = createWorkspaceProjectResolver();
  registerFoundryTaskProvider(context, diagnostics, resolveProject);
  const settings = readConnectionSettings();
  const debugOutput = vscode.window.createOutputChannel("FoundryScript Debug");
  context.subscriptions.push(debugOutput);
  activeDebugRuntime = registerFoundryScriptDebugRuntime(context, {
    resolveProject,
    getCoordinator: () => activeToolingHostCoordinator,
    getMode: () => readConnectionSettings().mode,
    output: debugOutput,
  });
  const outputChannel = vscode.window.createOutputChannel("FoundryScript LSP");
  context.subscriptions.push(outputChannel);
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
  await registerTestingRuntime(context, resolveProject);
  if (settings.mode === "off") {
    statusController.update({ kind: "off" });
    writeLog(outputChannel, "info", "lsp.connection.off");
    return;
  }
  statusController.update({ kind: "disconnected" });

  const resolution = await resolveProject();
  if (!resolution.success) {
    writeLog(outputChannel, "error", "lsp.project.resolution_failed", {
      kind: resolution.failure.kind,
      message: resolution.failure.message,
    });
    await showProjectResolutionFailure(resolution.failure);
    return;
  }
  const project = resolution.project;

  const coordinator = createToolingHostCoordinator(outputChannel);
  const manager = createConnectionManager(
    outputChannel,
    project,
    (state) => statusController.update(state),
    diagnostics,
    coordinator,
  );
  activeToolingHostCoordinator = coordinator;
  activeConnectionManager = manager;
  context.subscriptions.push({
    dispose: () => {
      void manager.stop().finally(() => coordinator.dispose());
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
  const debugRuntime = activeDebugRuntime;
  const manager = activeConnectionManager;
  const coordinator = activeToolingHostCoordinator;
  const testingLifecycle = activeTestingLifecycle;
  activeDebugRuntime = undefined;
  activeConnectionManager = undefined;
  activeToolingHostCoordinator = undefined;
  activeTestingLifecycle = undefined;
  try {
    await debugRuntime?.shutdown();
    await Promise.all([manager?.stop(), testingLifecycle?.stop()]);
  } finally {
    await coordinator?.dispose();
  }
}
