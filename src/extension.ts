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
import { ConnectionLifecycle } from "./client/lifecycle.js";
import { writeLog } from "./client/logging.js";
import {
  ConnectionConfigurationFailure,
  validateConnectionSettings,
} from "./client/settings.js";
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
import type { TestAdapterCommand } from "./testing/command.js";
import { FoundryTestAdapterDiscoverer } from "./testing/discoverer.js";
import {
  FoundryTestDebugExecutor,
  supportsTestRunDebugOption,
  type FoundryTestDebugMessageEvent,
} from "./testing/debug-executor.js";
import { FoundryTestExecutor } from "./testing/executor.js";
import { FoundryTestExplorer } from "./testing/explorer.js";
import {
  FoundryTestAdapterProcess,
  type TestAdapterProcessResult,
} from "./testing/process.js";
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
import { classifyNativeWorkspaceEligibility } from "./workspace-support.js";

type ActiveConnectionLifecycle = ConnectionLifecycle<
  ConnectionManager,
  ToolingHostCoordinator
>;

let activeConnectionLifecycle: ActiveConnectionLifecycle | undefined;
let activeDebugRuntime: FoundryScriptDebugRuntime | undefined;
interface ActiveTestingLifecycle {
  readonly stop: () => Promise<void>;
}

let activeTestingLifecycle: ActiveTestingLifecycle | undefined;

interface ActiveNativeRuntimeGate {
  readonly startIfEligible: () => void;
  readonly whenRegistrationSettled: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

let activeNativeRuntimeGate: ActiveNativeRuntimeGate | undefined;

// Stop promises that the subscription disposers below fire-and-forget. When
// VS Code tears the extension down via deactivate() we flush them so the LSP
// child, tooling host, and test adapter processes are not orphaned mid-shutdown
// when deactivate is invoked (and not just on a hard reload/crash).
const pendingTeardownPromises = new Set<Promise<void>>();

function trackTeardown(promise: Promise<void>): void {
  pendingTeardownPromises.add(promise);
  void promise.finally(() => {
    pendingTeardownPromises.delete(promise);
  });
}

async function flushPendingTeardown(): Promise<void> {
  if (pendingTeardownPromises.size === 0) return;
  await Promise.allSettled([...pendingTeardownPromises]);
}

const TESTING_CONFIGURATION_SECTIONS = [
  "foundryScript.testing.enabled",
  "foundryScript.testing.runner",
  "foundryScript.testing.args",
  "foundryScript.enginePath",
  "foundryScript.projectPath",
] as const;

const CONNECTION_CONFIGURATION_SECTIONS = [
  "foundryScript.lsp.mode",
  "foundryScript.lsp.port",
  "foundryScript.dap.port",
  "foundryScript.enginePath",
  "foundryScript.projectPath",
] as const;

function currentNativeWorkspaceEligibility() {
  return classifyNativeWorkspaceEligibility(
    vscode.workspace.isTrusted,
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.scheme),
  );
}

function isNativeWorkspaceEligible(): boolean {
  return currentNativeWorkspaceEligibility().kind === "eligible";
}

function unsupportedTestingWorkspaceFailure(): TestAdapterFailure {
  const eligibility = currentNativeWorkspaceEligibility();
  const message =
    eligibility.kind === "restricted"
      ? "Foundry Test Explorer requires workspace trust."
      : eligibility.kind === "unsupported_scheme"
        ? `Workspace scheme "${eligibility.scheme}" is unsupported because native Foundry tooling requires a local file workspace.`
        : "Foundry Test Explorer is unavailable in the current workspace.";
  return new TestAdapterFailure("invalid_project", message);
}

function readConnectionSettings(): ConnectionSettings {
  const configuration = vscode.workspace.getConfiguration("foundryScript");
  return validateConnectionSettings({
    mode: configuration.get<unknown>("lsp.mode", "spawn"),
    port: configuration.get<unknown>("lsp.port", 6005),
    dapPort: configuration.get<unknown>("dap.port", 6006),
    enginePath: configuration.get<unknown>("enginePath", "foundry"),
  });
}

function readSafeConnectionMode(): ConnectionSettings["mode"] {
  try {
    return readConnectionSettings().mode;
  } catch (error) {
    if (error instanceof ConnectionConfigurationFailure) {
      return "off";
    }
    throw error;
  }
}

async function showSettingsFailure(
  failure: ConnectionConfigurationFailure,
): Promise<void> {
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

function registerTestingRuntime(
  context: vscode.ExtensionContext,
  resolveProject: ResolveWorkspaceProject,
): ActiveTestingLifecycle {
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
  const runProcess = (
    command: TestAdapterCommand,
    signal: AbortSignal,
    onOutput?: (text: string, stream: "stdout" | "stderr") => void,
  ): Promise<TestAdapterProcessResult> =>
    isNativeWorkspaceEligible()
      ? onOutput === undefined
        ? process.run(command, signal)
        : process.run(command, signal, onOutput)
      : Promise.reject(unsupportedTestingWorkspaceFailure());
  const onCleanupError = (error: unknown, directory: string): void => {
    output.appendLine(
      `Unable to remove test adapter temporary directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  };
  const negotiator = new FoundryTestAdapterNegotiator({
    runProcess,
    onCleanupError,
  });
  const discoverer = new FoundryTestAdapterDiscoverer({
    runProcess,
    onCleanupError,
  });
  const executor = new FoundryTestExecutor({
    runProcess,
    onCleanupError,
  });
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
        return {
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
        };
      },
    },
  );
  const debugExecutor = new FoundryTestDebugExecutor({
    startDebugging: (configuration, debugOptions) =>
      isNativeWorkspaceEligible()
        ? vscode.debug.startDebugging(undefined, configuration, debugOptions)
        : Promise.resolve(false),
    stopDebugging: (session) =>
      vscode.debug.stopDebugging(session as vscode.DebugSession),
    onDidStartDebugSession: (listener) =>
      vscode.debug.onDidStartDebugSession((session) => listener(session)),
    onDidTerminateDebugSession: (listener) =>
      vscode.debug.onDidTerminateDebugSession((session) => listener(session)),
    onDidDebugMessage: (listener) => subscribe(debugMessageListeners, listener),
    onCleanupError,
    supportsTestRunLinking: supportsTestRunDebugOption(vscode.version),
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
        void showTestingFailure(state.failure, output).catch((error: unknown) => {
          output.appendLine(
            `Unable to show testing failure action: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
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
  const readyContext = () =>
    isNativeWorkspaceEligible() ? runtime.readyContext() : undefined;
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
  let stopped = false;
  const configure = async (): Promise<void> => {
    if (stopped) return;
    const generation = ++configurationGeneration;
    const configuration = await readTestingConfiguration(resolveProject);
    if (stopped || generation !== configurationGeneration) return;
    const key = JSON.stringify(configuration);
    if (key !== failureConfigurationKey) {
      failureConfigurationKey = key;
      shownFailureFingerprint = undefined;
    }
    updateWatchers(configuration);
    await runtime.configure(configuration);
  };
  const queueConfiguration = (): void => {
    void configure().catch((error: unknown) => {
      output.appendLine(
        `Testing configuration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  const runProfile = new FoundryTestRunProfile({
    controller,
    readyContext,
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
    readyContext,
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
    const abortController = new AbortController();
    const cancellation = token.onCancellationRequested?.(
      () => abortController.abort(),
    );
    try {
      await refresh.explicitRefresh(abortController.signal);
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
      stopped = true;
      configurationGeneration += 1;
      refresh.dispose();
      disposeWatchers();
      stopPromise = Promise.allSettled([
        Promise.resolve().then(() => runtime.stop()),
        Promise.resolve().then(() => process.stop()),
      ]).then((results) => {
        const failures: unknown[] = [];
        for (const result of results) {
          if (result.status === "rejected") failures.push(result.reason);
        }
        if (failures.length === 0) return;
        const detail = failures
          .map((error: unknown) =>
            error instanceof Error ? error.message : String(error),
          )
          .join("; ");
        try {
          output.appendLine(`Testing shutdown failed: ${detail}`);
        } catch {
          // VS Code may dispose the channel while deactivation is still running.
        }
      });
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
        queueConfiguration();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(queueConfiguration),
    {
      dispose: () => {
        if (activeTestingLifecycle === lifecycle) {
          activeTestingLifecycle = undefined;
        }
        trackTeardown(lifecycle.stop());
      },
    },
  );
  queueConfiguration();
  return lifecycle;
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
  try {
    writeTestingStateToOpenChannel(output, state);
  } catch {
    // VS Code may dispose the channel while deactivation is still running.
  }
}

function writeTestingStateToOpenChannel(
  output: vscode.OutputChannel,
  state: TestingState,
): void {
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
  // Include exit code and signal so a flaky engine that fails with the same
  // message but a different cause (port-in-use vs. crash) keeps surfacing
  // rather than being suppressed after the first occurrence.
  return JSON.stringify([
    failure.kind,
    failure.setting ?? null,
    failure.message,
    failure.exitCode ?? null,
    failure.signal ?? null,
  ]);
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

function startNativeRuntime(context: vscode.ExtensionContext): void {
  const diagnostics = createDiagnosticsUnit(() =>
    vscode.languages.createDiagnosticCollection("foundryscript"),
  );
  context.subscriptions.push(diagnostics);
  const resolveProject = createWorkspaceProjectResolver();
  registerFoundryTaskProvider(context, diagnostics, resolveProject);
  const debugOutput = vscode.window.createOutputChannel("FoundryScript Debug");
  context.subscriptions.push(debugOutput);
  const outputChannel = vscode.window.createOutputChannel("FoundryScript LSP");
  context.subscriptions.push(outputChannel);
  setNativeRuntimeFailureSink(outputChannel);
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  const statusController = new ConnectionStatusController(statusItem, {
    showQuickPick: (items, options) =>
      vscode.window.showQuickPick(items, options),
    reconnectNow: async () => {
      const manager = activeConnectionLifecycle?.currentManager;
      if (manager !== undefined) {
        await manager.reconnectNow();
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
    statusController,
    vscode.commands.registerCommand(CONNECTION_ACTIONS_COMMAND, async () =>
      statusController.showActions(),
    ),
  );
  const lifecycle = new ConnectionLifecycle({
    readSettings: readConnectionSettings,
    resolveProject,
    createCoordinator: () => createToolingHostCoordinator(outputChannel),
    createManager: (project, coordinator) =>
      createConnectionManager(
        outputChannel,
        project,
        (state) => statusController.update(state),
        diagnostics,
        coordinator,
      ),
    publishState: (state) => {
      statusController.update(state);
      diagnostics.setLanguageServerConnected(state.kind === "connected");
      if (state.kind === "off") {
        writeLog(outputChannel, "info", "lsp.connection.off");
      }
    },
    reportProjectFailure: (failure) => {
      writeLog(outputChannel, "error", "lsp.project.resolution_failed", {
        kind: failure.kind,
        message: failure.message,
      });
      return showProjectResolutionFailure(failure);
    },
    reportSettingsFailure: (failure) => {
      writeLog(outputChannel, "error", "lsp.configuration.invalid", {
        setting: failure.setting,
        message: failure.message,
      });
      return showSettingsFailure(failure);
    },
    reportStartupFailure: (error, project) => {
      writeLog(outputChannel, "error", "lsp.connection.failed", {
        project,
        message: error instanceof Error ? error.message : String(error),
      });
      return showStartupError(error);
    },
    logBackgroundFailure: (event, error) => {
      writeLog(outputChannel, "error", event, {
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  activeConnectionLifecycle = lifecycle;
  activeDebugRuntime = registerFoundryScriptDebugRuntime(context, {
    resolveProject,
    getCoordinator: () => activeConnectionLifecycle?.currentCoordinator,
    getMode: readSafeConnectionMode,
    output: debugOutput,
  });
  registerTestingRuntime(context, resolveProject);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        CONNECTION_CONFIGURATION_SECTIONS.some((section) =>
          event.affectsConfiguration(section),
        )
      ) {
        void lifecycle.requestReconciliation();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void lifecycle.requestReconciliation();
    }),
    {
      dispose: () => {
        if (activeConnectionLifecycle === lifecycle) {
          activeConnectionLifecycle = undefined;
        }
        trackTeardown(lifecycle.stop());
      },
    },
  );
  statusController.update(
    readSafeConnectionMode() === "off"
      ? { kind: "off" }
      : { kind: "disconnected" },
  );
  void lifecycle.requestReconciliation();
}

type NativeRuntimeFailureSink = {
  readonly appendLine: (line: string) => void;
};

let nativeRuntimeFailureSink: NativeRuntimeFailureSink | undefined;

export function setNativeRuntimeFailureSink(
  sink: NativeRuntimeFailureSink | undefined,
): void {
  nativeRuntimeFailureSink = sink;
}

function logNativeRuntimeFailure(message: string, error: unknown): void {
  // Prefer the structured output channel so users (and support) can see why a
  // native runtime registration or shutdown failed; fall back to console.error
  // for cases that fire before any channel has been created (e.g. early
  // activation errors).
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  try {
    nativeRuntimeFailureSink?.appendLine(`${message} ${detail}`);
  } catch {
    // The channel may be disposed during teardown; fall through to console.
  }
  console.error(message, error);
}

async function rollbackNativeRuntimeStart(
  context: vscode.ExtensionContext,
  subscriptionStart: number,
): Promise<void> {
  try {
    await stopNativeRuntime();
  } catch (error) {
    logNativeRuntimeFailure(
      "FoundryScript native runtime rollback shutdown failed:",
      error,
    );
  }
  const subscriptions = context.subscriptions.splice(subscriptionStart);
  for (const subscription of subscriptions.reverse()) {
    try {
      await Promise.resolve(subscription.dispose());
    } catch (error) {
      logNativeRuntimeFailure(
        "FoundryScript native runtime rollback disposal failed:",
        error,
      );
    }
  }
}

function createNativeRuntimeGate(
  context: vscode.ExtensionContext,
): ActiveNativeRuntimeGate {
  let stopped = false;
  let startRequested = false;
  let startFinished = false;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const startIfEligible = (): void => {
    if (stopped || startRequested) return;
    if (!isNativeWorkspaceEligible()) return;

    startRequested = true;
    startFinished = false;
    startPromise = Promise.resolve()
      .then(() => {
        if (stopped) return;
        if (!isNativeWorkspaceEligible()) {
          startRequested = false;
          return;
        }
        const subscriptionStart = context.subscriptions.length;
        try {
          startNativeRuntime(context);
          return;
        } catch (error) {
          return rollbackNativeRuntimeStart(context, subscriptionStart).then(() => {
            startRequested = false;
            throw error;
          });
        }
      })
      .catch((error: unknown) => {
        logNativeRuntimeFailure(
          "FoundryScript native runtime registration failed:",
          error,
        );
      })
      .finally(() => {
        startFinished = true;
      });
  };
  return {
    startIfEligible,
    whenRegistrationSettled: () =>
      startPromise === undefined ? Promise.resolve() : startPromise,
    stop: () => {
      if (stopPromise !== undefined) return stopPromise;
      stopped = true;
      stopPromise = startFinished
        ? stopNativeRuntime()
        : (async () => {
            await startPromise;
            await stopNativeRuntime();
          })();
      return stopPromise;
    },
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const gate = createNativeRuntimeGate(context);
  activeNativeRuntimeGate = gate;
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(gate.startIfEligible),
    vscode.workspace.onDidChangeWorkspaceFolders(gate.startIfEligible),
    {
      dispose: () => {
        if (activeNativeRuntimeGate !== gate) return;
        activeNativeRuntimeGate = undefined;
        trackTeardown(
          gate.stop().catch((error: unknown) => {
            logNativeRuntimeFailure(
              "FoundryScript native runtime shutdown failed:",
              error,
            );
          }),
        );
      },
    },
  );
  gate.startIfEligible();
  // Settle synchronous provider registration (debug resolvers, task providers,
  // test controller) before activate() resolves, so VS Code never invokes a
  // provider that has not been wired up yet. The gate's start promise replaces
  // the brittle microtask-count race that previously lived here.
  await gate.whenRegistrationSettled();
}

async function stopNativeRuntime(): Promise<void> {
  const debugRuntime = activeDebugRuntime;
  const connectionLifecycle = activeConnectionLifecycle;
  const testingLifecycle = activeTestingLifecycle;
  activeDebugRuntime = undefined;
  activeConnectionLifecycle = undefined;
  activeTestingLifecycle = undefined;
  await debugRuntime?.shutdown();
  await Promise.all([connectionLifecycle?.stop(), testingLifecycle?.stop()]);
}

export async function deactivate(): Promise<void> {
  const gate = activeNativeRuntimeGate;
  activeNativeRuntimeGate = undefined;
  if (gate !== undefined) {
    await gate.stop();
    await flushPendingTeardown();
    return;
  }
  await stopNativeRuntime();
  await flushPendingTeardown();
}
