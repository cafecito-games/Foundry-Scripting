import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import packageManifest from "../package.json";
import {
  CONNECTION_ACTIONS_COMMAND,
  OPEN_LOG_ACTION,
  OPEN_SETTINGS_ACTION,
  RECONNECT_ACTION,
} from "./client/connection-status.js";
import { HostStartupFailure } from "./client/host-launcher.js";

const extensionMock = vi.hoisted(() => {
  const createWatcher = (pattern: unknown) => {
    const handlers = {
      create: [] as Array<(uri: { fsPath: string }) => void>,
      change: [] as Array<(uri: { fsPath: string }) => void>,
      delete: [] as Array<(uri: { fsPath: string }) => void>,
    };
    const watcher = {
      pattern,
      onDidCreate: vi.fn((handler: (uri: { fsPath: string }) => void) => {
        handlers.create.push(handler);
        return { dispose: vi.fn() };
      }),
      onDidChange: vi.fn((handler: (uri: { fsPath: string }) => void) => {
        handlers.change.push(handler);
        return { dispose: vi.fn() };
      }),
      onDidDelete: vi.fn((handler: (uri: { fsPath: string }) => void) => {
        handlers.delete.push(handler);
        return { dispose: vi.fn() };
      }),
      emit: (kind: keyof typeof handlers, fsPath: string) => {
        for (const handler of handlers[kind]) {
          handler({ fsPath });
        }
      },
      dispose: vi.fn(),
    };
    return watcher;
  };
  const createCollection = (owner: { id: string } | undefined) => {
    const values = new Map<string, Record<string, unknown>>();
    const collection = {
      values,
      get size() {
        return values.size;
      },
      replace: (items: Array<Record<string, unknown>>) => {
        for (const item of values.values()) {
          item.parent = undefined;
        }
        values.clear();
        for (const item of items) {
          values.set(String(item.id), item);
          item.parent = owner;
        }
      },
      forEach: (callback: (item: Record<string, unknown>, collection: unknown) => void) => {
        for (const item of values.values()) {
          callback(item, collection);
        }
      },
      add: (item: Record<string, unknown>) => {
        values.set(String(item.id), item);
        item.parent = owner;
      },
      delete: (id: string) => {
        const item = values.get(id);
        if (item !== undefined) {
          item.parent = undefined;
        }
        values.delete(id);
      },
      get: (id: string) => values.get(id),
      [Symbol.iterator]: () => values[Symbol.iterator](),
    };
    return collection;
  };
  const rootItems = createCollection(undefined);
  const createTestItem = vi.fn((id: string, label: string, uri?: unknown) => {
    const item: Record<string, unknown> = {
      id,
      label,
      uri,
      parent: undefined,
      tags: [],
      canResolveChildren: false,
      busy: false,
      range: undefined,
      error: undefined,
    };
    item.children = createCollection(item as { id: string });
    return item;
  });
  const testController = {
    id: "foundryScript.tests",
    label: "FoundryScript",
    items: rootItems,
    createTestItem,
    createRunProfile: vi.fn(),
    createTestRun: vi.fn(),
    invalidateTestResults: vi.fn(),
    refreshHandler: undefined as
      | ((token: {
          isCancellationRequested: boolean;
          onCancellationRequested?: (handler: () => void) => { dispose(): void };
        }) => Promise<void> | void)
      | undefined,
    dispose: vi.fn(),
  };
  return {
  configuration: new Map<string, unknown>(),
  isTrusted: true,
  workspaceFolders: [] as Array<{
    uri: { fsPath: string; scheme?: string };
  }>,
  outputChannel: {
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  },
  debugOutputChannel: {
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  },
  testingOutputChannel: {
    append: vi.fn(),
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  },
  statusItem: {
    text: "",
    tooltip: "",
    command: undefined as string | undefined,
    show: vi.fn(),
    dispose: vi.fn(),
  },
  testingStatusItem: {
    text: "",
    tooltip: "",
    show: vi.fn(),
    dispose: vi.fn(),
  },
  showErrorMessage: vi.fn(),
  showQuickPick: vi.fn(),
  executeCommand: vi.fn(),
  registeredCommands: new Map<string, () => Promise<void>>(),
  registerCommand: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  reconnectNow: vi.fn(),
  createConnectionManager: vi.fn(),
  coordinatorDispose: vi.fn(),
  dapPort: 6006,
  dapLeaseReleases: [] as Array<ReturnType<typeof vi.fn>>,
  toolingHostCoordinator: {
    dispose: vi.fn(),
    acquireDapLease: vi.fn(),
  },
  createToolingHostCoordinator: vi.fn(),
  diagnosticsUnit: {
    accept: vi.fn(),
    setLanguageServerConnected: vi.fn(),
    dispose: vi.fn(),
  },
  diagnosticCollection: { dispose: vi.fn() },
  createDiagnosticCollection: vi.fn(),
  createDiagnosticsUnit: vi.fn(),
  taskProviderDisposable: { dispose: vi.fn() },
  registerTaskProvider: vi.fn(),
  registerFoundryTaskProvider: vi.fn(),
  debugProviderDisposable: { dispose: vi.fn() },
  debugDescriptorDisposable: { dispose: vi.fn() },
  debugTrackerDisposable: { dispose: vi.fn() },
  debugStartDisposable: { dispose: vi.fn() },
  debugTerminationDisposable: { dispose: vi.fn() },
  registerDebugConfigurationProvider: vi.fn(),
  registerDebugAdapterDescriptorFactory: vi.fn(),
  registerDebugAdapterTrackerFactory: vi.fn(),
  onDidStartDebugSession: vi.fn(),
  onDidTerminateDebugSession: vi.fn(),
  startDebugging: vi.fn(),
  stopDebugging: vi.fn(),
  resolveProject: vi.fn(),
  configurationChangeHandler: undefined as
    | ((event: { affectsConfiguration(section: string): boolean }) => void)
    | undefined,
  configurationChangeHandlers: [] as Array<
    (event: { affectsConfiguration(section: string): boolean }) => void
  >,
  workspaceFoldersChangeHandler: undefined as (() => void) | undefined,
  workspaceFoldersChangeHandlers: [] as Array<() => void>,
  onDidChangeConfiguration: vi.fn(),
  workspaceTrustGrantHandler: undefined as (() => void) | undefined,
  onDidGrantWorkspaceTrust: vi.fn(),
  onDidChangeWorkspaceFolders: vi.fn(),
  watchers: [] as Array<ReturnType<typeof createWatcher>>,
  createFileSystemWatcher: vi.fn((pattern: unknown) => {
    const watcher = createWatcher(pattern);
    extensionMock.watchers.push(watcher);
    return watcher;
  }),
  testingProcessOptions: undefined as
    | { onOutput?: (text: string, stream: "stdout" | "stderr") => void }
    | undefined,
  testingProcessRun: vi.fn(),
  testingProcessStop: vi.fn(),
  testingNegotiatorOptions: undefined as
    | { runProcess?: (command: unknown, signal: AbortSignal) => Promise<unknown> }
    | undefined,
  testingNegotiate: vi.fn(),
  testingDiscovererOptions: undefined as
    | {
        runProcess?: (command: unknown, signal: AbortSignal) => Promise<unknown>;
        onCleanupError?: (error: unknown, directory: string) => void;
      }
    | undefined,
  testingDiscover: vi.fn(),
  testingExecutorOptions: undefined as
    | {
        runProcess?: (
          command: unknown,
          signal: AbortSignal,
          onOutput?: (text: string, stream: "stdout" | "stderr") => void,
        ) => Promise<unknown>;
        onCleanupError?: (error: unknown, directory: string) => void;
      }
    | undefined,
  testingExecute: vi.fn(),
  testingDebugExecutorOptions: undefined as
    | {
        startDebugging: (
          configuration: unknown,
          options: unknown,
        ) => PromiseLike<boolean>;
        onDidStartDebugSession: (listener: (session: unknown) => void) => unknown;
        onDidTerminateDebugSession: (listener: (session: unknown) => void) => unknown;
      }
    | undefined,
  testingDebugExecute: vi.fn(),
  testingRuntimeOptions: undefined as
    | {
        negotiate: (request: unknown, signal: AbortSignal) => Promise<unknown>;
        discover: (request: unknown, signal: AbortSignal) => Promise<unknown>;
        onDiscovery: (project: string, model: unknown) => void;
        onClear: () => void;
        onState: (state: unknown) => void;
      }
    | undefined,
  testingConfigure: vi.fn(),
  testingRefresh: vi.fn(),
  testingStop: vi.fn(),
  testingReadyContext: vi.fn(),
  testController,
  createTestController: vi.fn(() => testController),
  createOutputChannel: vi.fn(),
  createStatusBarItem: vi.fn(),
  };
});

vi.mock("vscode", () => ({
  version: "1.90.0",
  tests: {
    createTestController: extensionMock.createTestController,
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
  },
  Range: class {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };

    constructor(
      startLine: number,
      startCharacter: number,
      endLine: number,
      endCharacter: number,
    ) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
  workspace: {
    get isTrusted() {
      return extensionMock.isTrusted;
    },
    get workspaceFolders() {
      return extensionMock.workspaceFolders;
    },
    getConfiguration: () => ({
      get: (key: string, defaultValue: unknown) =>
        extensionMock.configuration.get(key) ?? defaultValue,
    }),
    onDidChangeConfiguration: extensionMock.onDidChangeConfiguration,
    onDidGrantWorkspaceTrust: extensionMock.onDidGrantWorkspaceTrust,
    onDidChangeWorkspaceFolders: extensionMock.onDidChangeWorkspaceFolders,
    createFileSystemWatcher: extensionMock.createFileSystemWatcher,
  },
  RelativePattern: class {
    readonly base: string;
    readonly pattern: string;

    constructor(base: string, pattern: string) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  window: {
    createOutputChannel: extensionMock.createOutputChannel,
    createStatusBarItem: extensionMock.createStatusBarItem,
    showErrorMessage: extensionMock.showErrorMessage,
    showQuickPick: extensionMock.showQuickPick,
  },
  commands: {
    executeCommand: extensionMock.executeCommand,
    registerCommand: extensionMock.registerCommand,
  },
  tasks: {
    registerTaskProvider: extensionMock.registerTaskProvider,
  },
  debug: {
    registerDebugConfigurationProvider:
      extensionMock.registerDebugConfigurationProvider,
    registerDebugAdapterDescriptorFactory:
      extensionMock.registerDebugAdapterDescriptorFactory,
    registerDebugAdapterTrackerFactory:
      extensionMock.registerDebugAdapterTrackerFactory,
    onDidStartDebugSession: extensionMock.onDidStartDebugSession,
    onDidTerminateDebugSession: extensionMock.onDidTerminateDebugSession,
    startDebugging: extensionMock.startDebugging,
    stopDebugging: extensionMock.stopDebugging,
  },
  DebugAdapterServer: class {
    constructor(
      readonly port: number,
      readonly host?: string,
    ) {}
  },
  StatusBarAlignment: { Left: 1 },
  TestRunProfileKind: { Run: 1, Debug: 2 },
  languages: {
    createDiagnosticCollection: extensionMock.createDiagnosticCollection,
  },
}));

vi.mock("./client/runtime.js", () => ({
  createConnectionManager: extensionMock.createConnectionManager,
  createToolingHostCoordinator: extensionMock.createToolingHostCoordinator,
}));

vi.mock("./diagnostics/index.js", () => ({
  createDiagnosticsUnit: extensionMock.createDiagnosticsUnit,
}));

vi.mock("./tasks/provider.js", () => ({
  registerFoundryTaskProvider: extensionMock.registerFoundryTaskProvider,
}));

vi.mock("./project/workspace.js", () => ({
  createWorkspaceProjectResolver: () => extensionMock.resolveProject,
}));

vi.mock("./testing/process.js", () => ({
  FoundryTestAdapterProcess: class {
    readonly run = extensionMock.testingProcessRun;
    readonly stop = extensionMock.testingProcessStop;

    constructor(options: unknown) {
      extensionMock.testingProcessOptions = options as never;
    }
  },
}));

vi.mock("./testing/adapter.js", () => ({
  TestAdapterFailure: class extends Error {
    readonly setting: string | undefined;

    constructor(
      readonly kind: string,
      message: string,
      options: { setting?: string; cause?: unknown } = {},
    ) {
      super(message, options);
      this.setting = options.setting;
    }
  },
  FoundryTestAdapterNegotiator: class {
    readonly negotiate = extensionMock.testingNegotiate;

    constructor(options: unknown) {
      extensionMock.testingNegotiatorOptions = options as never;
    }
  },
}));

vi.mock("./testing/discoverer.js", () => ({
  FoundryTestAdapterDiscoverer: class {
    readonly discover = extensionMock.testingDiscover;

    constructor(options: unknown) {
      extensionMock.testingDiscovererOptions = options as never;
    }
  },
}));

vi.mock("./testing/executor.js", () => ({
  FoundryTestExecutor: class {
    readonly execute = extensionMock.testingExecute;

    constructor(options: unknown) {
      extensionMock.testingExecutorOptions = options as never;
    }
  },
}));

vi.mock("./testing/debug-executor.js", () => ({
  supportsTestRunDebugOption: vi.fn(() => false),
  FoundryTestDebugExecutor: class {
    readonly execute = extensionMock.testingDebugExecute;

    constructor(options: unknown) {
      extensionMock.testingDebugExecutorOptions = options as never;
    }
  },
}));

vi.mock("./testing/runtime.js", () => ({
  TestingRuntime: class {
    readonly configure = extensionMock.testingConfigure;
    readonly refresh = extensionMock.testingRefresh;
    readonly stop = extensionMock.testingStop;
    readonly readyContext = extensionMock.testingReadyContext;

    constructor(options: unknown) {
      extensionMock.testingRuntimeOptions = options as never;
    }
  },
}));

import { activate, deactivate } from "./extension.js";

function createContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function createDebugSession(
  id: string,
  configuration: vscode.DebugConfiguration,
): vscode.DebugSession {
  return {
    id,
    name: configuration.name,
    type: configuration.type,
    configuration,
  } as unknown as vscode.DebugSession;
}

describe("extension entry point", () => {
  beforeEach(async () => {
    await deactivate();
    extensionMock.configuration.clear();
    extensionMock.isTrusted = true;
    extensionMock.workspaceFolders.length = 0;
    extensionMock.outputChannel.appendLine.mockClear();
    extensionMock.outputChannel.show.mockClear();
    extensionMock.outputChannel.dispose.mockClear();
    extensionMock.debugOutputChannel.appendLine.mockClear();
    extensionMock.debugOutputChannel.show.mockClear();
    extensionMock.debugOutputChannel.dispose.mockClear();
    extensionMock.testingOutputChannel.append.mockClear();
    extensionMock.testingOutputChannel.appendLine.mockClear();
    extensionMock.testingOutputChannel.show.mockClear();
    extensionMock.testingOutputChannel.dispose.mockClear();
    extensionMock.statusItem.text = "";
    extensionMock.statusItem.tooltip = "";
    extensionMock.statusItem.command = undefined;
    extensionMock.statusItem.show.mockClear();
    extensionMock.statusItem.dispose.mockClear();
    extensionMock.testingStatusItem.text = "";
    extensionMock.testingStatusItem.tooltip = "";
    extensionMock.testingStatusItem.show.mockClear();
    extensionMock.testingStatusItem.dispose.mockClear();
    extensionMock.showErrorMessage.mockReset();
    extensionMock.showQuickPick.mockReset();
    extensionMock.executeCommand.mockReset();
    extensionMock.registerTaskProvider.mockReset();
    extensionMock.registerTaskProvider.mockReturnValue(
      extensionMock.taskProviderDisposable,
    );
    extensionMock.registeredCommands.clear();
    extensionMock.registerCommand.mockReset();
    extensionMock.registerCommand.mockImplementation(
      (command: string, handler: () => Promise<void>) => {
        extensionMock.registeredCommands.set(command, handler);
        return { dispose: () => extensionMock.registeredCommands.delete(command) };
      },
    );
    extensionMock.registerFoundryTaskProvider.mockReset();
    extensionMock.debugProviderDisposable.dispose.mockReset();
    extensionMock.debugDescriptorDisposable.dispose.mockReset();
    extensionMock.debugTrackerDisposable.dispose.mockReset();
    extensionMock.debugStartDisposable.dispose.mockReset();
    extensionMock.debugTerminationDisposable.dispose.mockReset();
    extensionMock.registerDebugConfigurationProvider.mockReset();
    extensionMock.registerDebugConfigurationProvider.mockReturnValue(
      extensionMock.debugProviderDisposable,
    );
    extensionMock.registerDebugAdapterDescriptorFactory.mockReset();
    extensionMock.registerDebugAdapterDescriptorFactory.mockReturnValue(
      extensionMock.debugDescriptorDisposable,
    );
    extensionMock.registerDebugAdapterTrackerFactory.mockReset();
    extensionMock.registerDebugAdapterTrackerFactory.mockReturnValue(
      extensionMock.debugTrackerDisposable,
    );
    extensionMock.onDidStartDebugSession.mockReset();
    extensionMock.onDidStartDebugSession.mockReturnValue(
      extensionMock.debugStartDisposable,
    );
    extensionMock.onDidTerminateDebugSession.mockReset();
    extensionMock.onDidTerminateDebugSession.mockReturnValue(
      extensionMock.debugTerminationDisposable,
    );
    extensionMock.startDebugging.mockReset();
    extensionMock.startDebugging.mockResolvedValue(true);
    extensionMock.stopDebugging.mockReset();
    extensionMock.stopDebugging.mockResolvedValue(true);
    extensionMock.resolveProject.mockReset();
    extensionMock.resolveProject.mockImplementation(() =>
      Promise.resolve(
        extensionMock.workspaceFolders[0] === undefined
          ? {
              success: false,
              failure: {
                kind: "missing_workspace",
                message: "Open a workspace folder before using Foundry tooling.",
              },
            }
          : {
              success: true,
              project: extensionMock.workspaceFolders[0].uri.fsPath,
            },
      ),
    );
    extensionMock.configurationChangeHandler = undefined;
    extensionMock.configurationChangeHandlers.length = 0;
    extensionMock.workspaceTrustGrantHandler = undefined;
    extensionMock.workspaceFoldersChangeHandler = undefined;
    extensionMock.workspaceFoldersChangeHandlers.length = 0;
    extensionMock.onDidChangeConfiguration.mockReset();
    extensionMock.onDidChangeConfiguration.mockImplementation(
      (handler: (event: { affectsConfiguration(section: string): boolean }) => void) => {
      extensionMock.configurationChangeHandlers.push(handler);
      extensionMock.configurationChangeHandler = (event) => {
        for (const registered of extensionMock.configurationChangeHandlers) {
          registered(event);
        }
      };
      return { dispose: vi.fn() };
      },
    );
    extensionMock.onDidGrantWorkspaceTrust.mockReset();
    extensionMock.onDidGrantWorkspaceTrust.mockImplementation(
      (handler: () => void) => {
        extensionMock.workspaceTrustGrantHandler = handler;
        return { dispose: vi.fn() };
      },
    );
    extensionMock.onDidChangeWorkspaceFolders.mockReset();
    extensionMock.onDidChangeWorkspaceFolders.mockImplementation(
      (handler: () => void) => {
        extensionMock.workspaceFoldersChangeHandlers.push(handler);
        extensionMock.workspaceFoldersChangeHandler = () => {
          for (const registered of extensionMock.workspaceFoldersChangeHandlers) {
            registered();
          }
        };
        return { dispose: vi.fn() };
      },
    );
    extensionMock.testingProcessOptions = undefined;
    extensionMock.testingProcessRun.mockReset();
    extensionMock.testingProcessStop.mockReset();
    extensionMock.testingProcessStop.mockResolvedValue(undefined);
    extensionMock.watchers.length = 0;
    extensionMock.createFileSystemWatcher.mockClear();
    extensionMock.testingNegotiatorOptions = undefined;
    extensionMock.testingNegotiate.mockReset();
    extensionMock.testingDiscovererOptions = undefined;
    extensionMock.testingDiscover.mockReset();
    extensionMock.testingExecutorOptions = undefined;
    extensionMock.testingExecute.mockReset();
    extensionMock.testingDebugExecute.mockReset();
    extensionMock.testingRuntimeOptions = undefined;
    extensionMock.testingConfigure.mockReset();
    extensionMock.testingConfigure.mockResolvedValue(undefined);
    extensionMock.testingRefresh.mockReset();
    extensionMock.testingRefresh.mockResolvedValue(undefined);
    extensionMock.testingStop.mockReset();
    extensionMock.testingStop.mockResolvedValue(undefined);
    extensionMock.testingReadyContext.mockReset();
    extensionMock.createTestController.mockClear();
    extensionMock.testController.items.replace([]);
    extensionMock.testController.createTestItem.mockClear();
    extensionMock.testController.createRunProfile.mockClear();
    extensionMock.testController.createTestRun.mockReset();
    extensionMock.testController.refreshHandler = undefined;
    extensionMock.testController.dispose.mockClear();
    extensionMock.createDiagnosticCollection.mockReset();
    extensionMock.createDiagnosticCollection.mockReturnValue(
      extensionMock.diagnosticCollection,
    );
    extensionMock.createDiagnosticsUnit.mockReset();
    extensionMock.createDiagnosticsUnit.mockImplementation(
      (createCollection: () => unknown) => {
        createCollection();
        return extensionMock.diagnosticsUnit;
      },
    );
    extensionMock.diagnosticsUnit.dispose.mockClear();
    extensionMock.createOutputChannel.mockReset();
    extensionMock.createOutputChannel.mockImplementation((name: string) =>
      name === "FoundryScript Testing"
        ? extensionMock.testingOutputChannel
        : name === "FoundryScript Debug"
          ? extensionMock.debugOutputChannel
          : extensionMock.outputChannel,
    );
    extensionMock.createStatusBarItem.mockReset();
    extensionMock.createStatusBarItem.mockImplementation(
      (_alignment: unknown, priority: number) =>
        priority === 90
          ? extensionMock.testingStatusItem
          : extensionMock.statusItem,
    );
    extensionMock.start = vi.fn().mockResolvedValue(undefined);
    extensionMock.stop = vi.fn().mockResolvedValue(undefined);
    extensionMock.reconnectNow = vi.fn().mockResolvedValue(undefined);
    extensionMock.coordinatorDispose = vi.fn().mockResolvedValue(undefined);
    extensionMock.toolingHostCoordinator.dispose =
      extensionMock.coordinatorDispose;
    extensionMock.dapPort = 6006;
    extensionMock.dapLeaseReleases.length = 0;
    extensionMock.toolingHostCoordinator.acquireDapLease.mockReset();
    extensionMock.toolingHostCoordinator.acquireDapLease.mockImplementation((signal?: AbortSignal) => {
      if (signal?.aborted === true) {
        const error = new Error("cancelled");
        error.name = "AbortError";
        return Promise.reject(error);
      }
      const release = vi.fn();
      extensionMock.dapLeaseReleases.push(release);
      return Promise.resolve({
        endpoint: { host: "127.0.0.1", port: extensionMock.dapPort },
        released: false,
        release,
        dispose: release,
      });
    });
    extensionMock.createToolingHostCoordinator.mockReset();
    extensionMock.createToolingHostCoordinator.mockReturnValue(
      extensionMock.toolingHostCoordinator,
    );
    extensionMock.createConnectionManager.mockReset();
    extensionMock.createConnectionManager.mockImplementation(() => ({
      start: extensionMock.start,
      stop: extensionMock.stop,
      reconnectNow: extensionMock.reconnectNow,
    }));
  });

  it.each([
    ["an untrusted local workspace", false, "file"],
    ["a trusted virtual workspace", true, "vscode-vfs"],
  ])(
    "settles activation with zero native runtime registrations in %s",
    async (_name, isTrusted, scheme) => {
      extensionMock.isTrusted = isTrusted;
      extensionMock.workspaceFolders.push({
        uri: { fsPath: "/workspace/game", scheme },
      });
      const context = createContext();

      await activate(context);

      expect(extensionMock.onDidGrantWorkspaceTrust).toHaveBeenCalledOnce();
      expect(extensionMock.onDidChangeWorkspaceFolders).toHaveBeenCalledOnce();
      expect(extensionMock.createDiagnosticsUnit).not.toHaveBeenCalled();
      expect(extensionMock.createDiagnosticCollection).not.toHaveBeenCalled();
      expect(extensionMock.registerFoundryTaskProvider).not.toHaveBeenCalled();
      expect(extensionMock.registerTaskProvider).not.toHaveBeenCalled();
      expect(extensionMock.createOutputChannel).not.toHaveBeenCalled();
      expect(extensionMock.createStatusBarItem).not.toHaveBeenCalled();
      expect(extensionMock.registerCommand).not.toHaveBeenCalled();
      expect(extensionMock.registerDebugConfigurationProvider).not.toHaveBeenCalled();
      expect(extensionMock.registerDebugAdapterDescriptorFactory).not.toHaveBeenCalled();
      expect(extensionMock.registerDebugAdapterTrackerFactory).not.toHaveBeenCalled();
      expect(extensionMock.createTestController).not.toHaveBeenCalled();
      expect(extensionMock.createToolingHostCoordinator).not.toHaveBeenCalled();
      expect(extensionMock.createConnectionManager).not.toHaveBeenCalled();
      expect(extensionMock.start).not.toHaveBeenCalled();
      expect(extensionMock.testingConfigure).not.toHaveBeenCalled();
      expect(extensionMock.testingNegotiate).not.toHaveBeenCalled();
      expect(extensionMock.testingProcessRun).not.toHaveBeenCalled();
    },
  );

  it("starts every native subsystem exactly once after trust is granted", async () => {
    extensionMock.isTrusted = false;
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    await activate(createContext());

    extensionMock.isTrusted = true;
    extensionMock.workspaceTrustGrantHandler?.();
    extensionMock.workspaceTrustGrantHandler?.();
    extensionMock.workspaceFoldersChangeHandler?.();

    await expectNativeRuntimeStartedOnce();
  });

  it("starts every native subsystem exactly once after a virtual workspace becomes local", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "vscode-vfs" },
    });
    await activate(createContext());

    extensionMock.workspaceFolders.splice(0, 1, {
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    extensionMock.workspaceFoldersChangeHandler?.();
    extensionMock.workspaceFoldersChangeHandler?.();
    extensionMock.workspaceTrustGrantHandler?.();

    await expectNativeRuntimeStartedOnce();
  });

  it("rechecks workspace eligibility before a queued native runtime start", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });

    const activation = activate(createContext());
    extensionMock.workspaceFolders.splice(0, 1, {
      uri: { fsPath: "/workspace/game", scheme: "vscode-vfs" },
    });
    extensionMock.workspaceFoldersChangeHandler?.();

    await activation;
    expect(extensionMock.createDiagnosticsUnit).not.toHaveBeenCalled();
    expect(extensionMock.registerFoundryTaskProvider).not.toHaveBeenCalled();
    expect(extensionMock.createOutputChannel).not.toHaveBeenCalled();
    expect(extensionMock.registerCommand).not.toHaveBeenCalled();
    expect(extensionMock.registerDebugConfigurationProvider).not.toHaveBeenCalled();
    expect(extensionMock.registerDebugAdapterDescriptorFactory).not.toHaveBeenCalled();
    expect(extensionMock.registerDebugAdapterTrackerFactory).not.toHaveBeenCalled();
    expect(extensionMock.createTestController).not.toHaveBeenCalled();
    expect(extensionMock.createToolingHostCoordinator).not.toHaveBeenCalled();
    expect(extensionMock.createConnectionManager).not.toHaveBeenCalled();

    extensionMock.workspaceFolders.splice(0, 1, {
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    extensionMock.workspaceFoldersChangeHandler?.();

    await expectNativeRuntimeStartedOnce();
  });

  it("deactivates safely before the workspace becomes eligible", async () => {
    extensionMock.isTrusted = false;
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    await activate(createContext());

    await deactivate();
    await deactivate();
    extensionMock.isTrusted = true;
    extensionMock.workspaceTrustGrantHandler?.();
    await Promise.resolve();

    expect(extensionMock.createDiagnosticsUnit).not.toHaveBeenCalled();
    expect(extensionMock.registerFoundryTaskProvider).not.toHaveBeenCalled();
    expect(extensionMock.registerDebugConfigurationProvider).not.toHaveBeenCalled();
    expect(extensionMock.createTestController).not.toHaveBeenCalled();
    expect(extensionMock.createConnectionManager).not.toHaveBeenCalled();
    expect(extensionMock.start).not.toHaveBeenCalled();
    expect(extensionMock.testingStop).not.toHaveBeenCalled();
    expect(extensionMock.stop).not.toHaveBeenCalled();
  });

  it("deactivates safely while an eligible gate start is still queued", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });

    const activation = activate(createContext());
    const deactivation = deactivate();

    await expect(Promise.all([activation, deactivation])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(extensionMock.createDiagnosticsUnit).not.toHaveBeenCalled();
    expect(extensionMock.registerFoundryTaskProvider).not.toHaveBeenCalled();
    expect(extensionMock.registerDebugConfigurationProvider).not.toHaveBeenCalled();
    expect(extensionMock.createTestController).not.toHaveBeenCalled();
    expect(extensionMock.createConnectionManager).not.toHaveBeenCalled();
    expect(extensionMock.start).not.toHaveBeenCalled();
  });

  it("stops active work without replacement when a local workspace becomes virtual", async () => {
    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    await activate(createContext());
    await waitForConnectionStart();
    await vi.waitFor(() =>
      expect(extensionMock.testingConfigure).toHaveBeenCalledOnce(),
    );
    extensionMock.resolveProject.mockResolvedValue({
      success: false,
      failure: {
        kind: "unsupported_workspace",
        scheme: "vscode-vfs",
        message:
          "Workspace URI scheme 'vscode-vfs' is unsupported; native Foundry tooling requires a local file workspace.",
      },
    });

    extensionMock.workspaceFolders.splice(0, 1, {
      uri: { fsPath: "/workspace/game", scheme: "vscode-vfs" },
    });
    extensionMock.workspaceFoldersChangeHandler?.();

    await vi.waitFor(() => expect(extensionMock.stop).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(extensionMock.testingConfigure).toHaveBeenCalledTimes(2),
    );
    expect(extensionMock.createConnectionManager).toHaveBeenCalledOnce();
    expect(extensionMock.createToolingHostCoordinator).toHaveBeenCalledOnce();
    expect(extensionMock.start).toHaveBeenCalledOnce();
    expect(extensionMock.coordinatorDispose).toHaveBeenCalledOnce();
    const configured = extensionMock.testingConfigure.mock.calls.at(-1)?.[0] as
      | {
          enabled: boolean;
          project: string | undefined;
          projectFailure?: { kind: string };
        }
      | undefined;
    expect(configured).toMatchObject({
      enabled: true,
      project: undefined,
      projectFailure: { kind: "invalid_project" },
    });
    expect(extensionMock.testingProcessRun).not.toHaveBeenCalled();
    expect(extensionMock.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("vscode-vfs"),
    );
    expect(extensionMock.outputChannel.appendLine.mock.calls.some(([line]) => {
      const record = JSON.parse(line as string) as {
        event?: string;
        kind?: string;
      };
      return record.event === "lsp.project.resolution_failed" &&
        record.kind === "unsupported_workspace";
    })).toBe(true);
  });

  it("rolls back a partial native registration failure and retries", async () => {
    const failure = new Error("registration exploded");
    const failedTaskProvider = { dispose: vi.fn() };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    extensionMock.registerFoundryTaskProvider.mockImplementationOnce(
      (context: vscode.ExtensionContext) => {
        context.subscriptions.push(failedTaskProvider);
      },
    );
    extensionMock.isTrusted = false;
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    const context = createContext();
    await activate(context);
    extensionMock.registerDebugConfigurationProvider.mockImplementationOnce(() => {
      throw failure;
    });

    try {
      extensionMock.isTrusted = true;
      extensionMock.workspaceTrustGrantHandler?.();

      await vi.waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          "FoundryScript native runtime registration failed:",
          failure,
        ),
      );
      expect(context.subscriptions).toHaveLength(3);
      expect(extensionMock.diagnosticsUnit.dispose).toHaveBeenCalledOnce();
      expect(failedTaskProvider.dispose).toHaveBeenCalledOnce();
      expect(extensionMock.debugOutputChannel.dispose).toHaveBeenCalledOnce();
      expect(extensionMock.outputChannel.dispose).toHaveBeenCalledOnce();
      expect(extensionMock.statusItem.dispose).toHaveBeenCalledOnce();
      expect(
        extensionMock.registeredCommands.has(CONNECTION_ACTIONS_COMMAND),
      ).toBe(false);

      extensionMock.createDiagnosticsUnit.mockClear();
      extensionMock.createDiagnosticCollection.mockClear();
      extensionMock.registerFoundryTaskProvider.mockClear();
      extensionMock.createOutputChannel.mockClear();
      extensionMock.createStatusBarItem.mockClear();
      extensionMock.registerCommand.mockClear();
      extensionMock.registerDebugConfigurationProvider.mockClear();
      extensionMock.registerDebugAdapterDescriptorFactory.mockClear();
      extensionMock.registerDebugAdapterTrackerFactory.mockClear();

      extensionMock.workspaceFoldersChangeHandler?.();
      await expectNativeRuntimeStartedOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("catches and logs a native shutdown failure from context disposal", async () => {
    const failure = new Error("shutdown exploded");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    const context = createContext();
    await activate(context);
    extensionMock.debugProviderDisposable.dispose.mockImplementationOnce(() => {
      throw failure;
    });

    try {
      context.subscriptions[2]?.dispose();

      await vi.waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          "FoundryScript native runtime shutdown failed:",
          failure,
        ),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("starts the configured connection mode for the open project", async () => {
    extensionMock.configuration.set("lsp.mode", "attach");
    extensionMock.configuration.set("lsp.port", 7001);
    extensionMock.configuration.set("dap.port", 7002);
    extensionMock.configuration.set("enginePath", "/opt/foundry");
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    const context = createContext();

    await activate(context);

    expect(extensionMock.createConnectionManager).toHaveBeenCalledWith(
      extensionMock.outputChannel,
      "/workspace/game",
      expect.any(Function),
      extensionMock.diagnosticsUnit,
      extensionMock.toolingHostCoordinator,
    );
    expect(extensionMock.start).toHaveBeenCalledWith({
      settings: {
        mode: "attach",
        port: 7001,
        dapPort: 7002,
        enginePath: "/opt/foundry",
      },
      project: "/workspace/game",
    });
    expect(context.subscriptions).toContain(extensionMock.outputChannel);
    expect(context.subscriptions).toContain(extensionMock.statusItem);
  });

  it("reports manually edited invalid LSP settings without launching the connection", async () => {
    extensionMock.configuration.set("lsp.mode", "malformed");
    extensionMock.showErrorMessage.mockResolvedValue("Open Settings");

    await activate(createContext());

    await vi.waitFor(() =>
      expect(extensionMock.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("foundryScript.lsp.mode"),
        "Open Settings",
      ),
    );
    expect(extensionMock.resolveProject).not.toHaveBeenCalled();
    expect(extensionMock.createToolingHostCoordinator).not.toHaveBeenCalled();
    expect(extensionMock.createConnectionManager).not.toHaveBeenCalled();
    expect(extensionMock.start).not.toHaveBeenCalled();
    expect(extensionMock.outputChannel.appendLine.mock.calls.some(([line]) => {
      const record = JSON.parse(line as string) as { event?: string };
      return record.event === "lsp.configuration.invalid";
    })).toBe(true);
    expect(extensionMock.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "foundryScript.lsp.mode",
    );
  });

  it("settles activation while testing configuration and LSP startup remain deferred", async () => {
    const testing = deferred<void>();
    const lsp = deferred<void>();
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    extensionMock.testingConfigure.mockReturnValue(testing.promise);
    extensionMock.start.mockReturnValue(lsp.promise);
    let settled = false;
    const activation = activate(createContext()).then(() => {
      settled = true;
    });

    try {
      await vi.waitFor(() => {
        expect(extensionMock.testingConfigure).toHaveBeenCalledOnce();
        expect(extensionMock.start).toHaveBeenCalledOnce();
      }, { timeout: 100 });
      expect(settled).toBe(true);
      expect(extensionMock.createTestController).toHaveBeenCalledOnce();
    } finally {
      testing.resolve(undefined);
      lsp.resolve(undefined);
      await activation;
    }
  });

  it("does not await a deferred project-error notification choice", async () => {
    const notification = deferred<string | undefined>();
    extensionMock.showErrorMessage.mockReturnValue(notification.promise);
    let settled = false;
    const activation = activate(createContext()).then(() => {
      settled = true;
    });

    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
      expect(extensionMock.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Open a workspace folder"),
        "Open Folder",
      );
    } finally {
      notification.resolve(undefined);
      await activation;
    }
  });

  it("registers testing completely before initial project resolution settles", async () => {
    const resolution = deferred<{
      success: true;
      project: string;
    }>();
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.resolveProject.mockReturnValue(resolution.promise);
    let settled = false;
    const context = createContext();
    const activation = activate(context).then(() => {
      settled = true;
    });

    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
      expect(extensionMock.createTestController).toHaveBeenCalledOnce();
      expect(extensionMock.testController.createRunProfile).toHaveBeenCalledTimes(2);
      expect(extensionMock.configurationChangeHandlers.length).toBeGreaterThan(0);
      expect(context.subscriptions).toContain(extensionMock.testController);
      expect(extensionMock.testingConfigure).not.toHaveBeenCalled();
    } finally {
      resolution.resolve({ success: true, project: "/workspace/game" });
      await activation;
    }
  });

  it("invalidates a pending testing configuration read before deactivation cleanup", async () => {
    const resolution = deferred<{
      success: true;
      project: string;
    }>();
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.resolveProject.mockReturnValue(resolution.promise);
    const activation = activate(createContext());

    await activation;
    const deactivation = deactivate();
    resolution.resolve({ success: true, project: "/workspace/late" });
    await deactivation;
    await Promise.resolve();

    expect(extensionMock.createFileSystemWatcher).not.toHaveBeenCalled();
    expect(extensionMock.testingConfigure).not.toHaveBeenCalled();
    expect(extensionMock.testingStop).toHaveBeenCalledOnce();
  });

  it("reconciles every connection setting and workspace-folder change", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    await activate(createContext());
    await vi.waitFor(() => expect(extensionMock.start).toHaveBeenCalledOnce());

    const sections = [
      "foundryScript.lsp.mode",
      "foundryScript.lsp.port",
      "foundryScript.dap.port",
      "foundryScript.enginePath",
      "foundryScript.projectPath",
    ];
    for (const [index, section] of sections.entries()) {
      extensionMock.configuration.set("lsp.port", 7001 + index);
      extensionMock.configurationChangeHandler?.({
        affectsConfiguration: (candidate) => candidate === section,
      });
      await vi.waitFor(() =>
        expect(extensionMock.start).toHaveBeenCalledTimes(index + 2),
      );
    }

    extensionMock.workspaceFolders.splice(0, 1, {
      uri: { fsPath: "/workspace/changed" },
    });
    extensionMock.workspaceFoldersChangeHandler?.();
    await vi.waitFor(() => expect(extensionMock.start).toHaveBeenCalledTimes(7));
    expect(extensionMock.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: "/workspace/changed" }),
    );
    expect(extensionMock.stop).toHaveBeenCalledTimes(6);
  });

  it("returns diagnostic ownership to CLI when reconciliation turns LSP off", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    await activate(createContext());
    await vi.waitFor(() =>
      expect(extensionMock.createConnectionManager).toHaveBeenCalledOnce(),
    );
    extensionMock.diagnosticsUnit.setLanguageServerConnected.mockClear();

    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.configurationChangeHandler?.({
      affectsConfiguration: (section) =>
        section === "foundryScript.lsp.mode",
    });
    await vi.waitFor(() =>
      expect(
        extensionMock.diagnosticsUnit.setLanguageServerConnected,
      ).toHaveBeenLastCalledWith(false),
    );
  });

  it("routes reconnect and debug acquisition through the lifecycle's replacement resources", async () => {
    const firstReconnect = vi.fn().mockResolvedValue(undefined);
    const secondReconnect = vi.fn().mockResolvedValue(undefined);
    const firstStop = vi.fn().mockResolvedValue(undefined);
    const secondStop = vi.fn().mockResolvedValue(undefined);
    const firstAcquire = vi.fn();
    const release = vi.fn();
    const secondAcquire = vi.fn().mockResolvedValue({
      endpoint: { host: "127.0.0.1", port: 7002 },
      released: false,
      release,
      dispose: release,
    });
    const coordinators = [
      {
        dispose: vi.fn().mockResolvedValue(undefined),
        acquireDapLease: firstAcquire,
      },
      {
        dispose: vi.fn().mockResolvedValue(undefined),
        acquireDapLease: secondAcquire,
      },
    ];
    const managers = [
      { start: vi.fn().mockResolvedValue(undefined), stop: firstStop, reconnectNow: firstReconnect },
      { start: vi.fn().mockResolvedValue(undefined), stop: secondStop, reconnectNow: secondReconnect },
    ];
    extensionMock.createToolingHostCoordinator.mockImplementation(() =>
      coordinators.shift());
    extensionMock.createConnectionManager.mockImplementation(() =>
      managers.shift());
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    extensionMock.showQuickPick.mockResolvedValue(RECONNECT_ACTION);
    await activate(createContext());
    await vi.waitFor(() => expect(extensionMock.createConnectionManager).toHaveBeenCalledOnce());

    extensionMock.configuration.set("lsp.port", 7001);
    extensionMock.configurationChangeHandler?.({
      affectsConfiguration: (section) => section === "foundryScript.lsp.port",
    });
    await vi.waitFor(() => expect(extensionMock.createConnectionManager).toHaveBeenCalledTimes(2));

    await extensionMock.registeredCommands.get(CONNECTION_ACTIONS_COMMAND)?.();
    expect(firstReconnect).not.toHaveBeenCalled();
    expect(secondReconnect).toHaveBeenCalledOnce();

    const factory = extensionMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    await factory.createDebugAdapterDescriptor(
      createDebugSession("replacement-debug", {
        type: "foundryscript",
        request: "launch",
        name: "Replacement Debug",
        scene: "main",
        project: "/workspace/game",
      }),
      undefined,
    );
    expect(firstAcquire).not.toHaveBeenCalled();
    expect(secondAcquire).toHaveBeenCalledOnce();
  });

  it("starts the language client with the resolved nested project", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/repository" },
    });
    extensionMock.resolveProject.mockResolvedValue({
      success: true,
      project: "/workspace/repository/test_project",
    });

    await activate(createContext());

    expect(extensionMock.createConnectionManager).toHaveBeenCalledWith(
      extensionMock.outputChannel,
      "/workspace/repository/test_project",
      expect.any(Function),
      extensionMock.diagnosticsUnit,
      extensionMock.toolingHostCoordinator,
    );
    expect(extensionMock.start).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "/workspace/repository/test_project",
      }),
    );
  });

  it("off creates no connection manager and needs no workspace", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    const context = createContext();

    await activate(context);

    expect(extensionMock.createConnectionManager).not.toHaveBeenCalled();
    expect(extensionMock.start).not.toHaveBeenCalled();
    expect(extensionMock.registerFoundryTaskProvider).toHaveBeenCalledWith(
      context,
      extensionMock.diagnosticsUnit,
      extensionMock.resolveProject,
    );
    expect(extensionMock.statusItem.show).toHaveBeenCalledOnce();
    expect(extensionMock.statusItem.text).toContain("Off");
    expect(extensionMock.createDiagnosticCollection).toHaveBeenCalledWith(
      "foundryscript",
    );
    expect(context.subscriptions).toContain(extensionMock.diagnosticsUnit);
    expect(extensionMock.resolveProject).not.toHaveBeenCalled();
  });

  it("registers the complete FoundryScript debug runtime and dedicated output for the activation lifetime", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    const context = createContext();

    await activate(context);

    expect(
      extensionMock.registerDebugConfigurationProvider,
    ).toHaveBeenCalledOnce();
    expect(
      extensionMock.registerDebugConfigurationProvider,
    ).toHaveBeenCalledWith("foundryscript", expect.any(Object));
    expect(
      extensionMock.registerDebugAdapterDescriptorFactory,
    ).toHaveBeenCalledWith("foundryscript", expect.any(Object));
    expect(
      extensionMock.registerDebugAdapterTrackerFactory,
    ).toHaveBeenCalledWith("foundryscript", expect.any(Object));
    expect(extensionMock.onDidTerminateDebugSession).toHaveBeenCalledOnce();
    expect(context.subscriptions).toContain(extensionMock.debugOutputChannel);
  });

  it("drives an F5 default main launch through the spawn coordinator and retains its lease until stop", async () => {
    extensionMock.configuration.set("lsp.mode", "spawn");
    extensionMock.dapPort = 51002;
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    await activate(createContext());
    const provider = extensionMock.registerDebugConfigurationProvider.mock
      .calls[0][1] as vscode.DebugConfigurationProvider;
    const factory = extensionMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const trackerFactory = extensionMock.registerDebugAdapterTrackerFactory.mock
      .calls[0][1] as vscode.DebugAdapterTrackerFactory;

    const defaultConfiguration = await provider.resolveDebugConfiguration?.(
      undefined,
      {} as vscode.DebugConfiguration,
    );
    expect(defaultConfiguration).toMatchObject({
      type: "foundryscript",
      request: "launch",
      scene: "main",
    });
    const resolved = await provider.resolveDebugConfigurationWithSubstitutedVariables?.(
      undefined,
      defaultConfiguration!,
    );
    expect(resolved).toMatchObject({
      project: "/workspace/game",
      scene: "main",
      playArgs: [],
    });
    const session = createDebugSession("extension-f5-main", resolved!);
    const tracker = await trackerFactory.createDebugAdapterTracker(session);

    await expect(
      factory.createDebugAdapterDescriptor(session, undefined),
    ).resolves.toMatchObject({ host: "127.0.0.1", port: 51002 });
    tracker?.onWillStartSession?.call(tracker);
    tracker?.onWillStartSession?.call(tracker);
    expect(extensionMock.dapLeaseReleases[0]).not.toHaveBeenCalled();

    tracker?.onWillStopSession?.call(tracker);
    expect(extensionMock.dapLeaseReleases[0]).toHaveBeenCalledOnce();
    expect(extensionMock.coordinatorDispose).not.toHaveBeenCalled();
  });

  it("stops and restarts a fresh debug session through the preserved extension tooling host", async () => {
    extensionMock.configuration.set("lsp.mode", "spawn");
    extensionMock.dapPort = 51002;
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    await activate(createContext());
    const factory = extensionMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const trackerFactory = extensionMock.registerDebugAdapterTrackerFactory.mock
      .calls[0][1] as vscode.DebugAdapterTrackerFactory;
    const terminate = extensionMock.onDidTerminateDebugSession.mock
      .calls[0][0] as (session: vscode.DebugSession) => void;
    const configuration = {
      type: "foundryscript",
      request: "launch",
      name: "Debug Main",
      scene: "main",
      project: "/workspace/game",
      playArgs: [],
      noDebug: false,
    };
    const firstSession = createDebugSession("extension-stop", configuration);
    const firstTracker = await trackerFactory.createDebugAdapterTracker(
      firstSession,
    );

    await factory.createDebugAdapterDescriptor(firstSession, undefined);
    firstTracker?.onWillStartSession?.call(firstTracker);
    firstTracker?.onWillStopSession?.call(firstTracker);
    terminate(firstSession);

    const restartedSession = createDebugSession(
      "extension-restart",
      configuration,
    );
    const restartedTracker = await trackerFactory.createDebugAdapterTracker(
      restartedSession,
    );
    await factory.createDebugAdapterDescriptor(restartedSession, undefined);
    restartedTracker?.onWillStartSession?.call(restartedTracker);

    expect(extensionMock.dapLeaseReleases).toHaveLength(2);
    expect(extensionMock.dapLeaseReleases[0]).toHaveBeenCalledOnce();
    expect(extensionMock.dapLeaseReleases[1]).not.toHaveBeenCalled();
    expect(extensionMock.createToolingHostCoordinator).toHaveBeenCalledOnce();
    expect(extensionMock.coordinatorDispose).not.toHaveBeenCalled();
    expect(
      extensionMock.debugOutputChannel.appendLine.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("Launching")),
    ).toEqual([
      expect.stringContaining("[extension-stop] Launching main"),
      expect.stringContaining("[extension-restart] Launching main"),
    ]);
    expect(extensionMock.debugOutputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringMatching(
        /\[extension-stop\].*session ended.*released the DAP lease/i,
      ),
    );
  });

  it("keeps the active DAP session leased across isolated LSP loss and reconnect", async () => {
    extensionMock.configuration.set("lsp.mode", "spawn");
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    await activate(createContext());
    await waitForConnectionStart();
    const factory = extensionMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const session = createDebugSession("lsp-loss-with-dap", {
      type: "foundryscript",
      request: "launch",
      name: "Debug Main",
      scene: "main",
      project: "/workspace/game",
      playArgs: [],
      noDebug: false,
    });
    await factory.createDebugAdapterDescriptor(session, undefined);
    const onConnectionState = extensionMock.createConnectionManager.mock
      .calls[0][2] as (state: { kind: "retrying" | "connected" }) => void;

    onConnectionState({ kind: "retrying" });
    onConnectionState({ kind: "connected" });

    expect(extensionMock.dapLeaseReleases[0]).not.toHaveBeenCalled();
    expect(extensionMock.stopDebugging).not.toHaveBeenCalled();
    await expect(
      factory.createDebugAdapterDescriptor(
        createDebugSession("lsp-loss-second", session.configuration),
        undefined,
      ),
    ).rejects.toThrow("already active");
  });

  it("maps an explicit Run Without Debugging launch and uses the external attach DAP port", async () => {
    extensionMock.configuration.set("lsp.mode", "attach");
    extensionMock.configuration.set("dap.port", 7702);
    extensionMock.dapPort = 7702;
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    await activate(createContext());
    const provider = extensionMock.registerDebugConfigurationProvider.mock
      .calls[0][1] as vscode.DebugConfigurationProvider;
    const factory = extensionMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;

    const resolved = await provider.resolveDebugConfigurationWithSubstitutedVariables?.(
      undefined,
      {
        type: "foundryscript",
        request: "launch",
        name: "Run Forest",
        scene: "res://levels/forest.tscn",
        args: ["--seed", "42"],
        noDebug: true,
      },
    );
    expect(resolved).toEqual({
      type: "foundryscript",
      request: "launch",
      name: "Run Forest",
      scene: "res://levels/forest.tscn",
      project: "/workspace/game",
      playArgs: ["--seed", "42"],
      noDebug: true,
    });
    const session = createDebugSession("extension-explicit", resolved!);

    await expect(
      factory.createDebugAdapterDescriptor(session, undefined),
    ).resolves.toMatchObject({ host: "127.0.0.1", port: 7702 });
    expect(extensionMock.toolingHostCoordinator.acquireDapLease).toHaveBeenCalledWith(
      expect.any(AbortSignal),
    );

    const terminate = extensionMock.onDidTerminateDebugSession.mock
      .calls[0][0] as (session: vscode.DebugSession) => void;
    terminate(session);
    expect(extensionMock.dapLeaseReleases[0]).toHaveBeenCalledOnce();
  });

  it("uses the auto coordinator's selected endpoint without reimplementing branch selection", async () => {
    extensionMock.configuration.set("lsp.mode", "auto");
    extensionMock.dapPort = 62002;
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    await activate(createContext());
    await waitForConnectionStart();
    const factory = extensionMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const session = createDebugSession("extension-auto", {
      type: "foundryscript",
      request: "launch",
      name: "Debug Main",
      scene: "main",
      project: "/workspace/game",
      playArgs: [],
      noDebug: false,
    });

    await expect(
      factory.createDebugAdapterDescriptor(session, undefined),
    ).resolves.toMatchObject({ host: "127.0.0.1", port: 62002 });
  });

  it.each([
    ["disabled", "off"],
    ["malformed", "malformed"],
  ])("rejects F5 in %s mode with dedicated actionable diagnostics", async (_name, mode) => {
    extensionMock.configuration.set("lsp.mode", mode);
    await activate(createContext());
    const factory = extensionMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;

    await expect(
      factory.createDebugAdapterDescriptor(
        createDebugSession("extension-off", {
          type: "foundryscript",
          request: "launch",
          name: "Debug Main",
          scene: "main",
          project: "/workspace/game",
        }),
        undefined,
      ),
    ).rejects.toThrow("foundryScript.lsp.mode");
    expect(extensionMock.debugOutputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringMatching(/off.*foundryScript\.lsp\.mode/i),
    );
    expect(extensionMock.showErrorMessage).toHaveBeenCalled();
  });

  it("offers project settings and does not connect when selection is ambiguous", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/repository" },
    });
    extensionMock.resolveProject.mockResolvedValue({
      success: false,
      failure: {
        kind: "ambiguous_projects",
        message: "Multiple Foundry projects were found.",
        setting: "foundryScript.projectPath",
        candidates: ["a/project.foundry", "b/project.foundry"],
      },
    });
    extensionMock.showErrorMessage.mockResolvedValue("Open Settings");

    await activate(createContext());

    expect(extensionMock.createConnectionManager).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(extensionMock.executeCommand).toHaveBeenCalledWith(
        "workbench.action.openSettings",
        "foundryScript.projectPath",
      ),
    );
  });

  it("reports a missing project without attempting a connection", async () => {
    await activate(createContext());

    expect(extensionMock.createConnectionManager).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(extensionMock.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Open a workspace folder"),
        "Open Folder",
      ),
    );
  });

  it("offers to open settings when the engine path is invalid", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    extensionMock.start.mockRejectedValue(
      new HostStartupFailure({
        kind: "missing_engine",
        enginePath: "/missing/foundry",
        project: "/workspace/game",
      }),
    );
    extensionMock.showErrorMessage.mockResolvedValue("Open Settings");

    await activate(createContext());

    await vi.waitFor(() =>
      expect(extensionMock.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("/missing/foundry"),
        "Open Settings",
      ),
    );
    await vi.waitFor(() =>
      expect(extensionMock.executeCommand).toHaveBeenCalledWith(
        "workbench.action.openSettings",
        "foundryScript.enginePath",
      ),
    );
  });

  it("keeps reconnect available after initial startup fails", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    extensionMock.start.mockRejectedValue(new Error("connection refused"));
    extensionMock.showQuickPick.mockResolvedValue(RECONNECT_ACTION);

    await activate(createContext());
    await vi.waitFor(() =>
      expect(extensionMock.showErrorMessage).toHaveBeenCalledOnce(),
    );
    await extensionMock.registeredCommands.get(CONNECTION_ACTIONS_COMMAND)?.();

    expect(extensionMock.statusItem.text).toContain("Disconnected");
    expect(extensionMock.stop).not.toHaveBeenCalled();
    expect(extensionMock.reconnectNow).toHaveBeenCalledOnce();
  });

  it("opens a folder when reconnect is selected without a workspace", async () => {
    extensionMock.showQuickPick.mockResolvedValue(RECONNECT_ACTION);

    await activate(createContext());
    await extensionMock.registeredCommands.get(CONNECTION_ACTIONS_COMMAND)?.();

    expect(extensionMock.executeCommand).toHaveBeenCalledWith("vscode.openFolder");
  });

  it("deactivation stops only the active connection manager", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    await activate(createContext());

    await deactivate();
    await deactivate();

    expect(extensionMock.stop).toHaveBeenCalledOnce();
  });

  it("deactivation stops DAP before LSP and disposes the owned host last", async () => {
    extensionMock.configuration.set("lsp.mode", "spawn");
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    await activate(createContext());
    await waitForConnectionStart();
    const factory = extensionMock.registerDebugAdapterDescriptorFactory.mock
      .calls[0][1] as vscode.DebugAdapterDescriptorFactory;
    const session = createDebugSession("deactivation-order", {
      type: "foundryscript",
      request: "launch",
      name: "Debug Main",
      scene: "main",
      project: "/workspace/game",
      playArgs: [],
      noDebug: false,
    });
    await factory.createDebugAdapterDescriptor(session, undefined);

    await deactivate();

    expect(extensionMock.stopDebugging).toHaveBeenCalledWith(session);
    expect(extensionMock.stopDebugging.mock.invocationCallOrder[0]).toBeLessThan(
      extensionMock.stop.mock.invocationCallOrder[0],
    );
    expect(extensionMock.stop.mock.invocationCallOrder[0]).toBeLessThan(
      extensionMock.coordinatorDispose.mock.invocationCallOrder[0],
    );
    expect(extensionMock.dapLeaseReleases[0]).toHaveBeenCalledOnce();
  });

  it("configures testing independently while disabled", async () => {
    extensionMock.configuration.set("lsp.mode", "off");

    await activate(createContext());

    expect(extensionMock.testingConfigure).toHaveBeenCalledWith({
      enabled: false,
      enginePath: "foundry",
      project: undefined,
      runner: "",
      frameworkArgs: [],
    });
    expect(extensionMock.testingStatusItem.show).not.toHaveBeenCalled();
    expect(extensionMock.registerFoundryTaskProvider).toHaveBeenCalledOnce();
  });

  it("creates exactly one TestController with one Run and one Debug profile", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    const context = createContext();

    await activate(context);

    expect(extensionMock.createTestController).toHaveBeenCalledOnce();
    expect(extensionMock.createTestController).toHaveBeenCalledWith(
      "foundryScript.tests",
      "FoundryScript",
    );
    expect(extensionMock.testController.createRunProfile).toHaveBeenCalledTimes(2);
    expect(extensionMock.testController.createRunProfile).toHaveBeenNthCalledWith(
      1,
      "Run",
      1,
      expect.any(Function),
      true,
    );
    expect(extensionMock.testController.createRunProfile).toHaveBeenNthCalledWith(
      2,
      "Debug",
      2,
      expect.any(Function),
      true,
    );
    expect(context.subscriptions).toContain(extensionMock.testController);
    expect(context.subscriptions).toContain(extensionMock.testingOutputChannel);
  });

  it("wires negotiation, discovery, and authoritative hierarchy publication", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    const adapter = {
      protocolVersion: 1,
      framework: { id: "neutral", name: "Neutral", version: "1" },
      extensions: [],
    };
    const discovered = nestedDiscoveryModel();
    extensionMock.testingNegotiate.mockResolvedValue(adapter);
    extensionMock.testingDiscover.mockResolvedValue(discovered);

    await activate(createContext());
    const options = extensionMock.testingRuntimeOptions;
    const signal = new AbortController().signal;
    const request = {
      enginePath: "/opt/foundry",
      project: "/workspace/game",
      runner: "res://tests/runner.fs",
      frameworkArgs: [],
    };

    await expect(options?.negotiate(request, signal)).resolves.toBe(adapter);
    await expect(
      options?.discover({ ...request, protocolVersion: 1 }, signal),
    ).resolves.toBe(discovered);
    options?.onDiscovery("/workspace/game", discovered);

    expect(extensionMock.testingNegotiate).toHaveBeenCalledWith(request, signal);
    expect(extensionMock.testingDiscover).toHaveBeenCalledWith(
      { ...request, protocolVersion: 1 },
      signal,
    );
    expect(controllerChild("suite-a", "test-a")).toMatchObject({
      id: "test-a",
      label: "works",
      uri: { fsPath: "/workspace/game/tests/example.fs" },
    });
    expect(extensionMock.testController.createRunProfile).toHaveBeenCalledTimes(2);
  });

  it("runs the registered profile through current runtime and explorer state", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    const model = nestedDiscoveryModel();
    const adapter = {
      protocolVersion: 1,
      framework: { id: "neutral", name: "Neutral", version: "1" },
      extensions: [],
    };
    const run = {
      enqueued: vi.fn(),
      started: vi.fn(),
      passed: vi.fn(),
      skipped: vi.fn(),
      failed: vi.fn(),
      errored: vi.fn(),
      appendOutput: vi.fn(),
      end: vi.fn(),
    };
    extensionMock.testController.createTestRun.mockReturnValue(run);
    extensionMock.testingExecute.mockResolvedValue({
      kind: "completed",
      completion: {
        valid: true,
        complete: true,
        classification: "conforming",
        codes: [],
        diagnostics: [],
      },
      processResult: { kind: "exited", exitCode: 0, stdout: "", stderr: "" },
    });

    await activate(createContext());
    extensionMock.testingRuntimeOptions?.onDiscovery("/workspace/game", model);
    extensionMock.testingReadyContext.mockReturnValue({
      configuration: {
        enabled: true,
        enginePath: "/opt/foundry",
        project: "/workspace/game",
        runner: "res://tests/runner.fs",
        frameworkArgs: [],
      },
      adapter,
      model,
    });
    const handler = extensionMock.testController.createRunProfile.mock.calls[0]?.[2] as
      | ((request: unknown, token: unknown) => Promise<void>)
      | undefined;
    await handler?.(
      {},
      {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: vi.fn() }),
      },
    );

    expect(extensionMock.testingReadyContext).toHaveBeenCalled();
    expect(extensionMock.testingExecute).toHaveBeenCalledOnce();
    expect(run.end).toHaveBeenCalledOnce();
  });

  it.each([
    ["Run", 0, extensionMock.testingExecute],
    ["Debug", 1, extensionMock.testingDebugExecute],
  ])(
    "blocks the cached %s profile immediately after a local workspace becomes virtual",
    async (_name, profileIndex, execute) => {
      extensionMock.configuration.set("lsp.mode", "off");
      extensionMock.configuration.set("testing.enabled", true);
      extensionMock.workspaceFolders.push({
        uri: { fsPath: "/workspace/game", scheme: "file" },
      });
      const model = nestedDiscoveryModel();
      const adapter = {
        protocolVersion: 1,
        framework: { id: "neutral", name: "Neutral", version: "1" },
        extensions: [],
      };
      const run = {
        enqueued: vi.fn(),
        started: vi.fn(),
        passed: vi.fn(),
        skipped: vi.fn(),
        failed: vi.fn(),
        errored: vi.fn(),
        appendOutput: vi.fn(),
        end: vi.fn(),
      };
      extensionMock.testController.createTestRun.mockReturnValue(run);
      execute.mockResolvedValue({
        kind: "completed",
        completion: {
          valid: true,
          complete: true,
          classification: "conforming",
          codes: [],
          diagnostics: [],
        },
        processResult: { kind: "exited", exitCode: 0, stdout: "", stderr: "" },
      });

      await activate(createContext());
      extensionMock.testingRuntimeOptions?.onDiscovery("/workspace/game", model);
      extensionMock.testingReadyContext.mockReturnValue({
        configuration: {
          enabled: true,
          enginePath: "/opt/foundry",
          project: "/workspace/game",
          runner: "res://tests/runner.fs",
          frameworkArgs: [],
        },
        adapter,
        model,
      });
      const pendingResolution = deferred<{
        success: false;
        failure: {
          kind: "unsupported_workspace";
          message: string;
        };
      }>();
      extensionMock.resolveProject.mockReturnValue(pendingResolution.promise);
      extensionMock.workspaceFolders.splice(0, 1, {
        uri: { fsPath: "/workspace/game", scheme: "vscode-vfs" },
      });
      extensionMock.workspaceFoldersChangeHandler?.();
      const handler = extensionMock.testController.createRunProfile.mock.calls[
        profileIndex
      ]?.[2] as
        | ((request: unknown, token: unknown) => Promise<void>)
        | undefined;

      await handler?.(
        {},
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: vi.fn() }),
        },
      );

      expect(execute).not.toHaveBeenCalled();
      expect(run.appendOutput).toHaveBeenCalledWith(
        "Foundry test execution is not ready.\r\n",
      );
      expect(run.end).toHaveBeenCalledOnce();
      pendingResolution.resolve({
        success: false,
        failure: {
          kind: "unsupported_workspace",
          message:
            "Native Foundry tooling requires a local file workspace.",
        },
      });
      await Promise.resolve();
    },
  );

  it("rechecks workspace support at the Foundry test process boundary", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    extensionMock.testingProcessRun.mockResolvedValue({
      kind: "exited",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    await activate(createContext());
    const runProcesses = [
      extensionMock.testingNegotiatorOptions?.runProcess,
      extensionMock.testingDiscovererOptions?.runProcess,
      extensionMock.testingExecutorOptions?.runProcess,
    ];

    extensionMock.workspaceFolders.splice(0, 1, {
      uri: { fsPath: "/workspace/game", scheme: "vscode-vfs" },
    });

    for (const runProcess of runProcesses) {
      await expect(
        runProcess?.(
          {
            command: "foundry",
            args: ["project", "test"],
            cwd: "/workspace/game",
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ kind: "invalid_project" });
    }
    expect(extensionMock.testingProcessRun).not.toHaveBeenCalled();
  });

  it("rechecks workspace support at the Foundry test debug boundary", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    await activate(createContext());
    const startDebugging =
      extensionMock.testingDebugExecutorOptions?.startDebugging;

    extensionMock.workspaceFolders.splice(0, 1, {
      uri: { fsPath: "/workspace/game", scheme: "vscode-vfs" },
    });

    await expect(startDebugging?.({}, {})).resolves.toBe(false);
    expect(extensionMock.startDebugging).not.toHaveBeenCalled();
  });

  it("passes the original Debug request to one DAP execution without the ordinary executor", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    const model = nestedDiscoveryModel();
    const run = {
      enqueued: vi.fn(),
      started: vi.fn(),
      passed: vi.fn(),
      skipped: vi.fn(),
      failed: vi.fn(),
      errored: vi.fn(),
      appendOutput: vi.fn(),
      end: vi.fn(),
    };
    extensionMock.testController.createTestRun.mockReturnValue(run);
    extensionMock.testingDebugExecute.mockImplementation(
      async (
        _request: unknown,
        _signal: AbortSignal,
        observer: { onPoint(point: Record<string, unknown>): void },
      ) => {
        await Promise.resolve();
        observer.onPoint({
          number: 1,
          ok: true,
          label: "works",
          testId: "test-a",
          durationMs: 3,
          statusDetail: "",
        });
        return {
          kind: "completed",
          completion: {
            valid: true,
            complete: true,
            classification: "conforming",
            codes: [],
            diagnostics: [],
          },
          processResult: {
            kind: "exited",
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        };
      },
    );

    await activate(createContext());
    extensionMock.testingRuntimeOptions?.onDiscovery("/workspace/game", model);
    extensionMock.testingReadyContext.mockReturnValue({
      configuration: {
        enabled: true,
        enginePath: "/opt/foundry",
        project: "/workspace/game",
        runner: "res://tests/runner.fs",
        frameworkArgs: [],
      },
      adapter: {
        protocolVersion: 1,
        framework: { id: "neutral", name: "Neutral", version: "1" },
        extensions: [],
      },
      model,
    });
    const originalRequest = {
      include: [extensionMock.testController.items.get("suite-a")],
      exclude: [],
    };
    const handler = extensionMock.testController.createRunProfile.mock.calls[1]?.[2] as
      | ((request: unknown, token: unknown) => Promise<void>)
      | undefined;
    await handler?.(originalRequest, {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: vi.fn() }),
    });

    expect(extensionMock.testController.createTestRun).toHaveBeenCalledWith(
      originalRequest,
    );
    expect(extensionMock.testingDebugExecute).toHaveBeenCalledOnce();
    expect(extensionMock.testingDebugExecute.mock.calls[0]?.[0]).toMatchObject({
      project: "/workspace/game",
      runner: "res://tests/runner.fs",
      protocolVersion: 1,
      leaves: [{ id: "test-a" }],
    });
    expect(extensionMock.testingDebugExecute.mock.calls[0]?.[3]).toBe(run);
    expect(extensionMock.testingExecute).not.toHaveBeenCalled();
    expect(run.end).toHaveBeenCalledOnce();
  });

  it("tracks test-debug sessions through VS Code lifecycle events", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    await activate(createContext());
    const started = vi.fn();
    const terminated = vi.fn();
    const session = createDebugSession("test-debug-lifecycle", {
      type: "foundryscript",
      request: "launch",
      name: "Debug Foundry Tests",
    });

    // Activation eagerly registers only the runtime lease-drain listener.
    // The executor's lifecycle listeners are scoped lazily to an active run.
    expect(extensionMock.onDidStartDebugSession).not.toHaveBeenCalled();
    expect(extensionMock.onDidTerminateDebugSession).toHaveBeenCalledOnce();
    extensionMock.testingDebugExecutorOptions?.onDidStartDebugSession(started);
    extensionMock.testingDebugExecutorOptions?.onDidTerminateDebugSession(
      terminated,
    );
    const startListener = extensionMock.onDidStartDebugSession.mock.calls[0]?.[0] as
      | ((value: vscode.DebugSession) => void)
      | undefined;
    const terminateListener = extensionMock.onDidTerminateDebugSession.mock
      .calls[1]?.[0] as ((value: vscode.DebugSession) => void) | undefined;
    startListener?.(session);
    terminateListener?.(session);

    expect(extensionMock.onDidStartDebugSession).toHaveBeenCalledOnce();
    expect(extensionMock.onDidTerminateDebugSession).toHaveBeenCalledTimes(2);
    expect(started).toHaveBeenCalledWith(session);
    expect(terminated).toHaveBeenCalledWith(session);
  });

  it("shares the owned process and cleanup diagnostics with discovery and runs", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    await activate(createContext());
    const signal = new AbortController().signal;
    const command = { command: "foundry", args: [], cwd: "/workspace/game" };
    const onOutput = vi.fn();
    extensionMock.testingProcessRun.mockResolvedValue({
      kind: "exited",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    await extensionMock.testingDiscovererOptions?.runProcess?.(command, signal);
    await extensionMock.testingExecutorOptions?.runProcess?.(
      command,
      signal,
      onOutput,
    );
    extensionMock.testingDiscovererOptions?.onCleanupError?.(
      new Error("denied"),
      "/tmp/foundryscript-test-discovery-owned",
    );

    expect(extensionMock.testingProcessRun).toHaveBeenNthCalledWith(
      1,
      command,
      signal,
    );
    expect(extensionMock.testingProcessRun).toHaveBeenNthCalledWith(
      2,
      command,
      signal,
      onOutput,
    );
    expect(extensionMock.testingOutputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("foundryscript-test-discovery-owned"),
    );
  });

  it("awaits controller refresh and skips an already-cancelled request", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    const refresh = deferred<void>();
    extensionMock.testingRefresh.mockReturnValue(refresh.promise);
    await activate(createContext());

    let cancelRefresh: (() => void) | undefined;
    const refreshPromise = extensionMock.testController.refreshHandler?.({
      isCancellationRequested: false,
      onCancellationRequested: (handler) => {
        cancelRefresh = handler;
        return { dispose: vi.fn() };
      },
    });
    expect(extensionMock.testingRefresh).toHaveBeenCalledOnce();
    const refreshSignal = extensionMock.testingRefresh.mock.calls[0]?.[0] as
      | AbortSignal
      | undefined;
    expect(refreshSignal?.aborted).toBe(false);
    cancelRefresh?.();
    expect(refreshSignal?.aborted).toBe(true);
    refresh.resolve(undefined);
    await refreshPromise;

    extensionMock.testingRefresh.mockClear();
    await extensionMock.testController.refreshHandler?.({
      isCancellationRequested: true,
    });
    expect(extensionMock.testingRefresh).not.toHaveBeenCalled();
  });

  it("coalesces relevant workspace file events and filters generated paths", async () => {
    vi.useFakeTimers();
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });

    await activate(createContext());
    expect(extensionMock.createFileSystemWatcher).toHaveBeenCalledTimes(2);
    expect(
      extensionMock.watchers.map((watcher) => watcher.pattern),
    ).toEqual([
      expect.objectContaining({ base: "/workspace/game", pattern: "**/*.fs" }),
      expect.objectContaining({
        base: "/workspace/game",
        pattern: "project.foundry",
      }),
    ]);
    extensionMock.testingRefresh.mockClear();

    extensionMock.watchers[0]?.emit(
      "create",
      "/workspace/game/tests/first.fs",
    );
    await vi.advanceTimersByTimeAsync(200);
    extensionMock.watchers[0]?.emit(
      "change",
      "/workspace/game/tests/second.fs",
    );
    extensionMock.watchers[0]?.emit(
      "delete",
      "/workspace/game/dist/generated.fs",
    );
    await vi.advanceTimersByTimeAsync(249);
    expect(extensionMock.testingRefresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(extensionMock.testingRefresh).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("cancels pending file refresh and old watchers on disable or workspace switch", async () => {
    vi.useFakeTimers();
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    await activate(createContext());
    extensionMock.testingRefresh.mockClear();
    const oldWatchers = [...extensionMock.watchers];

    oldWatchers[0]?.emit("change", "/workspace/game/tests/changed.fs");
    extensionMock.configuration.set("testing.enabled", false);
    extensionMock.configurationChangeHandler?.({
      affectsConfiguration: (section) =>
        section === "foundryScript.testing.enabled",
    });
    await vi.waitFor(() =>
      expect(oldWatchers.every((watcher) => watcher.dispose.mock.calls.length === 1))
        .toBe(true),
    );
    await vi.runAllTimersAsync();

    expect(extensionMock.testingRefresh).not.toHaveBeenCalled();
    expect(oldWatchers.every((watcher) => watcher.dispose.mock.calls.length === 1))
      .toBe(true);

    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.workspaceFolders.splice(0, 1, {
      uri: { fsPath: "/workspace/changed" },
    });
    extensionMock.workspaceFoldersChangeHandler?.();
    await vi.waitFor(() =>
      expect(extensionMock.watchers.at(-1)?.pattern).toEqual(
        expect.objectContaining({ base: "/workspace/changed" }),
      ),
    );
    expect(extensionMock.watchers.at(-1)?.pattern).toEqual(
      expect.objectContaining({ base: "/workspace/changed" }),
    );
    vi.useRealTimers();
  });

  it("retains last-known-good items when a refresh reports malformed discovery", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    await activate(createContext());
    const options = extensionMock.testingRuntimeOptions;
    options?.onDiscovery("/workspace/game", nestedDiscoveryModel());
    const original = controllerChild("suite-a", "test-a");

    await extensionMock.testController.refreshHandler?.({
      isCancellationRequested: false,
    });
    options?.onState({
      kind: "error",
      failure: {
        kind: "malformed_discovery",
        message: "Malformed discovery artifact.",
      },
    });

    expect(
      controllerChild("suite-a", "test-a"),
    ).toBe(original);
    expect(extensionMock.testingStatusItem.text).toContain("Discovery failed");
    expect(extensionMock.testingOutputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("malformed_discovery"),
    );
  });

  it("authoritatively clears on valid empty discovery and explicit disable", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    await activate(createContext());
    const options = extensionMock.testingRuntimeOptions;
    options?.onDiscovery("/workspace/game", nestedDiscoveryModel());

    options?.onDiscovery("/workspace/game", emptyDiscoveryModel());
    expect(extensionMock.testController.items.size).toBe(0);

    options?.onDiscovery("/workspace/game", nestedDiscoveryModel());
    options?.onClear();
    expect(extensionMock.testController.items.size).toBe(0);
    expect(extensionMock.registerFoundryTaskProvider).toHaveBeenCalledOnce();
  });

  it("passes enabled adapter settings and the first workspace project exactly", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.configuration.set(
      "testing.runner",
      "res://addons/neutral/runner.fs",
    );
    extensionMock.configuration.set("testing.args", [
      "--path",
      "res://specs",
      "--output",
      "opaque",
    ]);
    extensionMock.configuration.set("enginePath", "/opt/foundry");
    extensionMock.workspaceFolders.push(
      { uri: { fsPath: "/workspace/first" } },
      { uri: { fsPath: "/workspace/second" } },
    );

    await activate(createContext());

    expect(extensionMock.testingConfigure).toHaveBeenCalledWith({
      enabled: true,
      enginePath: "/opt/foundry",
      project: "/workspace/first",
      runner: "res://addons/neutral/runner.fs",
      frameworkArgs: ["--path", "res://specs", "--output", "opaque"],
    });
    expect(extensionMock.createConnectionManager).not.toHaveBeenCalled();
  });

  it("configures testing and watchers with the resolved nested project", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/repository" },
    });
    extensionMock.resolveProject.mockResolvedValue({
      success: true,
      project: "/workspace/repository/test_project",
    });

    await activate(createContext());

    expect(extensionMock.testingConfigure).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        project: "/workspace/repository/test_project",
      }),
    );
    expect(extensionMock.watchers[0]?.pattern).toEqual(
      expect.objectContaining({ base: "/workspace/repository/test_project" }),
    );
  });

  it("preserves an ambiguous project failure before testing negotiation", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/repository" },
    });
    extensionMock.resolveProject.mockResolvedValue({
      success: false,
      failure: {
        kind: "ambiguous_projects",
        message: "Multiple Foundry projects were found.",
        setting: "foundryScript.projectPath",
        candidates: ["a/project.foundry", "b/project.foundry"],
      },
    });

    await activate(createContext());

    const configured = extensionMock.testingConfigure.mock.calls[0]?.[0] as
      | {
          enabled: boolean;
          project: string | undefined;
          projectFailure?: { kind: string; setting?: string };
        }
      | undefined;
    expect(configured).toMatchObject({
      enabled: true,
      project: undefined,
      projectFailure: {
        kind: "invalid_project",
        setting: "foundryScript.projectPath",
      },
    });
  });

  it("reconfigures only for relevant settings and workspace changes", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    await activate(createContext());
    extensionMock.testingConfigure.mockClear();

    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.configurationChangeHandler?.({
      affectsConfiguration: (section) =>
        section === "foundryScript.testing.enabled",
    });
    await vi.waitFor(() =>
      expect(extensionMock.testingConfigure).toHaveBeenCalledOnce(),
    );
    extensionMock.configurationChangeHandler?.({
      affectsConfiguration: () => false,
    });
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/changed" },
    });
    extensionMock.workspaceFoldersChangeHandler?.();

    await vi.waitFor(() =>
      expect(extensionMock.testingConfigure).toHaveBeenCalledTimes(2),
    );

    expect(extensionMock.testingConfigure).toHaveBeenCalledTimes(2);
    expect(extensionMock.testingConfigure).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        project: "/workspace/changed",
      }),
    );
  });

  it("re-resolves testing when projectPath changes", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.workspaceFolders.push({ uri: { fsPath: "/workspace/root" } });
    await activate(createContext());
    extensionMock.resolveProject.mockClear();

    extensionMock.configurationChangeHandler?.({
      affectsConfiguration: (section) =>
        section === "foundryScript.projectPath",
    });

    await vi.waitFor(() =>
      expect(extensionMock.resolveProject).toHaveBeenCalledOnce(),
    );
  });

  it("disabling testing does not stop LSP or ordinary tasks", async () => {
    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    await activate(createContext());

    extensionMock.configuration.set("testing.enabled", false);
    extensionMock.configurationChangeHandler?.({
      affectsConfiguration: (section) =>
        section === "foundryScript.testing.enabled",
    });

    await vi.waitFor(() =>
      expect(extensionMock.testingConfigure).toHaveBeenLastCalledWith(
        expect.objectContaining({ enabled: false }),
      ),
    );

    expect(extensionMock.testingConfigure).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(extensionMock.stop).not.toHaveBeenCalled();
    expect(extensionMock.registerFoundryTaskProvider).toHaveBeenCalledOnce();
  });

  it("deactivation stops testing and LSP exactly once", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    await activate(createContext());

    await deactivate();
    await deactivate();

    expect(extensionMock.testingStop).toHaveBeenCalledOnce();
    expect(extensionMock.testingProcessStop).toHaveBeenCalledOnce();
    expect(extensionMock.stop).toHaveBeenCalledOnce();
    expect(extensionMock.coordinatorDispose).toHaveBeenCalledOnce();
    expect(extensionMock.stop.mock.invocationCallOrder[0]).toBeLessThan(
      extensionMock.coordinatorDispose.mock.invocationCallOrder[0] ?? 0,
    );
    expect(extensionMock.testingStop.mock.invocationCallOrder[0]).toBeLessThan(
      extensionMock.coordinatorDispose.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("continues native cleanup when VS Code has already closed output channels", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    await activate(createContext());
    extensionMock.testingOutputChannel.appendLine.mockImplementationOnce(() => {
      throw new Error("Channel has been closed");
    });
    extensionMock.testingStop.mockImplementation(() => {
      extensionMock.testingRuntimeOptions?.onState({ kind: "disabled" });
      return Promise.resolve();
    });

    await expect(deactivate()).resolves.toBeUndefined();

    expect(extensionMock.testingProcessStop).toHaveBeenCalledOnce();
    expect(extensionMock.stop).toHaveBeenCalledOnce();
    expect(extensionMock.coordinatorDispose).toHaveBeenCalledOnce();
  });

  it("waits for testing process cleanup after runtime shutdown rejects", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game", scheme: "file" },
    });
    let resolveProcessStop!: () => void;
    extensionMock.testingStop.mockRejectedValue(
      new Error("runtime shutdown failed"),
    );
    extensionMock.testingProcessStop.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveProcessStop = resolve;
      }),
    );
    await activate(createContext());

    let settled = false;
    const deactivation = deactivate().then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(extensionMock.testingProcessStop).toHaveBeenCalledOnce();
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveProcessStop();
    await deactivation;
    expect(settled).toBe(true);
  });

  it("catches and logs background testing shutdown failures", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.testingStop.mockRejectedValue(
      new Error("testing shutdown exploded"),
    );
    await activate(createContext());

    await expect(deactivate()).resolves.toBeUndefined();

    expect(extensionMock.testingOutputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("testing shutdown exploded"),
    );
  });

  it("renders negotiated framework status and preserves process output", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    await activate(createContext());
    const options = extensionMock.testingRuntimeOptions;

    options?.onState({
      kind: "ready",
      adapter: {
        protocolVersion: 1,
        framework: {
          id: "neutral-spec",
          name: "Neutral Spec",
          version: "2.4.0",
        },
        extensions: ["neutral.coverage"],
      },
      discoveryErrorCount: 0,
    });
    extensionMock.testingProcessOptions?.onOutput?.(
      '{"application":"stdout"}\n',
      "stdout",
    );

    expect(extensionMock.testingStatusItem.text).toContain("Neutral Spec");
    expect(extensionMock.testingStatusItem.tooltip).toContain("neutral-spec");
    expect(extensionMock.testingOutputChannel.append).toHaveBeenCalledWith(
      '{"application":"stdout"}\n',
    );
  });

  it("opens the precise setting for testing configuration failures", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.showErrorMessage.mockResolvedValue("Open Settings");
    await activate(createContext());

    extensionMock.testingRuntimeOptions?.onState({
      kind: "error",
      failure: {
        kind: "missing_runner",
        setting: "foundryScript.testing.runner",
        message: "Configure a test adapter runner.",
      },
    });
    await Promise.resolve();

    expect(extensionMock.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "foundryScript.testing.runner",
    );
  });

  it("offers a workspace folder for testing missing-project failures", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.showErrorMessage.mockResolvedValue("Open Folder");
    await activate(createContext());

    extensionMock.testingRuntimeOptions?.onState({
      kind: "error",
      failure: {
        kind: "missing_project",
        message: "Open a Foundry project folder.",
      },
    });
    await Promise.resolve();

    expect(extensionMock.executeCommand).toHaveBeenCalledWith(
      "workbench.action.files.openFolder",
    );
  });

  it("offers the testing log for protocol and process failures", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.showErrorMessage.mockResolvedValue("Open Testing Log");
    await activate(createContext());

    extensionMock.testingRuntimeOptions?.onState({
      kind: "error",
      failure: {
        kind: "legacy_runner",
        message: "The runner does not implement adapter capabilities.",
      },
    });
    await Promise.resolve();

    expect(extensionMock.testingOutputChannel.show).toHaveBeenCalledOnce();
  });

  it("deduplicates actionable prompts and keeps operational failures in output", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    await activate(createContext());
    const legacy = {
      kind: "legacy_runner",
      message: "The runner does not implement adapter capabilities.",
    };

    extensionMock.testingRuntimeOptions?.onState({
      kind: "error",
      failure: legacy,
    });
    extensionMock.testingRuntimeOptions?.onState({
      kind: "error",
      failure: legacy,
    });
    extensionMock.testingRuntimeOptions?.onState({
      kind: "error",
      failure: {
        kind: "malformed_discovery",
        message: "Record 9 is not valid JSON.",
      },
    });
    await Promise.resolve();

    expect(extensionMock.showErrorMessage).toHaveBeenCalledOnce();
    expect(extensionMock.testingOutputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("Record 9"),
    );
  });

  it("writes structured lifecycle failure details to testing output", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    await activate(createContext());

    extensionMock.testingRuntimeOptions?.onState({
      kind: "error",
      failure: {
        kind: "process_crash",
        message: "Execution crashed.",
        phase: "execution",
        signal: "SIGSEGV",
        stdout: "ordinary output",
        stderr: "fatal detail",
      },
    });

    const lines = extensionMock.testingOutputChannel.appendLine.mock.calls.map(
      (call) => String(call[0]),
    );
    expect(lines.join("\n")).toContain("phase execution");
    expect(lines.join("\n")).toContain("signal SIGSEGV");
    expect(lines.join("\n")).toContain("stdout: ordinary output");
    expect(lines.join("\n")).toContain("stderr: fatal detail");
    expect(extensionMock.showErrorMessage).not.toHaveBeenCalled();
  });

  it("cleans up and forgets a connection manager after cancelled startup", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    const cancellation = new Error("cancelled");
    cancellation.name = "AbortError";
    extensionMock.start.mockRejectedValue(cancellation);

    await activate(createContext());
    await vi.waitFor(() => expect(extensionMock.stop).toHaveBeenCalledOnce());
    await deactivate();

    expect(extensionMock.stop).toHaveBeenCalledOnce();
    expect(extensionMock.showErrorMessage).not.toHaveBeenCalled();
  });

  it("renders manager states and reconnects immediately from the status command", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    extensionMock.showQuickPick.mockResolvedValue(RECONNECT_ACTION);
    await activate(createContext());
    const onStateChange = extensionMock.createConnectionManager.mock.calls[0]?.[2] as
      | ((state: { kind: string }) => void)
      | undefined;

    onStateChange?.({ kind: "connected" });
    await extensionMock.registeredCommands.get(CONNECTION_ACTIONS_COMMAND)?.();

    expect(extensionMock.statusItem.text).toContain("Connected");
    expect(extensionMock.reconnectNow).toHaveBeenCalledOnce();
  });

  it("opens the LSP log from the status command", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    extensionMock.showQuickPick.mockResolvedValue(OPEN_LOG_ACTION);
    await activate(createContext());

    await extensionMock.registeredCommands.get(CONNECTION_ACTIONS_COMMAND)?.();

    expect(extensionMock.outputChannel.show).toHaveBeenCalledOnce();
  });

  it("offers settings instead of reconnect while off", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    extensionMock.showQuickPick.mockResolvedValue(OPEN_SETTINGS_ACTION);
    await activate(createContext());

    await extensionMock.registeredCommands.get(CONNECTION_ACTIONS_COMMAND)?.();

    expect(extensionMock.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "foundryScript.lsp.mode",
    );
    expect(extensionMock.reconnectNow).not.toHaveBeenCalled();
  });
});

function emptyDiscoveryModel() {
  return {
    root: "res://tests",
    items: [],
    suiteCount: 0,
    testCount: 0,
    errorCount: 0,
  };
}

function controllerChild(parentId: string, childId: string) {
  const parent = extensionMock.testController.items.get(parentId);
  const children = parent?.children as
    | { get: (id: string) => Record<string, unknown> | undefined }
    | undefined;
  return children?.get(childId);
}

function nestedDiscoveryModel() {
  return {
    root: "res://tests",
    items: [
      {
        kind: "suite",
        id: "suite-a",
        label: "Suite",
        parentId: null,
        resourcePath: "res://tests/example.fs",
        range: null,
        runnable: true,
        skipped: false,
        skipReason: null,
      },
      {
        kind: "test",
        id: "test-a",
        label: "works",
        parentId: "suite-a",
        resourcePath: "res://tests/example.fs",
        range: {
          start: { line: 3, character: 2 },
          end: { line: 3, character: 30 },
        },
        runnable: true,
        skipped: false,
        skipReason: null,
        caseKey: null,
      },
    ],
    suiteCount: 1,
    testCount: 1,
    errorCount: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function waitForConnectionStart(): Promise<void> {
  await vi.waitFor(() => expect(extensionMock.start).toHaveBeenCalledOnce());
  await Promise.resolve();
  await Promise.resolve();
}

async function expectNativeRuntimeStartedOnce(): Promise<void> {
  await vi.waitFor(() => {
    expect(extensionMock.start).toHaveBeenCalledOnce();
    expect(extensionMock.testingConfigure).toHaveBeenCalledOnce();
  });
  expect(extensionMock.createDiagnosticsUnit).toHaveBeenCalledOnce();
  expect(extensionMock.createDiagnosticCollection).toHaveBeenCalledOnce();
  expect(extensionMock.registerFoundryTaskProvider).toHaveBeenCalledOnce();
  expect(extensionMock.createOutputChannel).toHaveBeenCalledTimes(3);
  expect(extensionMock.createStatusBarItem).toHaveBeenCalledOnce();
  expect(extensionMock.registerCommand).toHaveBeenCalledOnce();
  expect(extensionMock.registerDebugConfigurationProvider).toHaveBeenCalledOnce();
  expect(extensionMock.registerDebugAdapterDescriptorFactory).toHaveBeenCalledOnce();
  expect(extensionMock.registerDebugAdapterTrackerFactory).toHaveBeenCalledTimes(2);
  expect(extensionMock.createTestController).toHaveBeenCalledOnce();
  expect(extensionMock.createToolingHostCoordinator).toHaveBeenCalledOnce();
  expect(extensionMock.createConnectionManager).toHaveBeenCalledOnce();
  expect(extensionMock.onDidGrantWorkspaceTrust).toHaveBeenCalledOnce();
  expect(extensionMock.onDidChangeWorkspaceFolders).toHaveBeenCalledTimes(3);
}

describe("package.json manifest", () => {
  it("declares the foundryscript language for .fs files", () => {
    const [language] = packageManifest.contributes.languages;

    expect(language.id).toBe("foundryscript");
    expect(language.extensions).toContain(".fs");
  });

  it("registers a grammar scoped to source.foundryscript for the declared language", () => {
    const [language] = packageManifest.contributes.languages;
    const [grammar] = packageManifest.contributes.grammars;

    expect(grammar.scopeName).toBe("source.foundryscript");
    expect(grammar.language).toBe(language.id);
  });

  it("contributes only the custom final semantic token modifier", () => {
    const contributes = packageManifest.contributes as typeof packageManifest.contributes & {
      semanticTokenModifiers?: Array<{ id: string; description: string }>;
      semanticTokenTypes?: unknown;
    };

    expect(contributes.semanticTokenModifiers).toEqual([
      {
        id: "final",
        description: "Marks a final FoundryScript declaration.",
      },
    ]);
    expect(contributes.semanticTokenTypes).toBeUndefined();
  });

  it("contributes language server connection settings", () => {
    const properties = packageManifest.contributes.configuration.properties;

    expect(properties["foundryScript.lsp.mode"]).toMatchObject({
      type: "string",
      default: "spawn",
      enum: ["spawn", "attach", "auto", "off"],
    });
    expect(properties["foundryScript.lsp.port"]).toMatchObject({
      type: "integer",
      default: 6005,
      minimum: 1,
      maximum: 65535,
    });
    expect(properties["foundryScript.enginePath"]).toMatchObject({
      type: "string",
      default: "foundry",
    });
    expect(properties["foundryScript.projectPath"]).toMatchObject({
      type: "string",
      default: "",
    });
    expect(properties["foundryScript.test.runner"]).toMatchObject({
      type: "string",
      default: "",
    });
    expect(properties["foundryScript.testing.enabled"]).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(properties["foundryScript.testing.runner"]).toMatchObject({
      type: "string",
      default: "",
    });
    expect(properties["foundryScript.testing.args"]).toMatchObject({
      type: "array",
      default: [],
      items: { type: "string" },
    });
  });

  it("contributes tasks.json definitions for the five Foundry CLI verbs", () => {
    const [definition] = packageManifest.contributes.taskDefinitions;

    expect(definition.type).toBe("foundryscript");
    expect(definition.required).toEqual(["command"]);
    expect(definition.properties.command).toMatchObject({
      type: "string",
      enum: ["build", "lint", "test", "format", "run"],
    });
    expect(JSON.stringify(packageManifest.contributes)).not.toMatch(
      /problemMatchers?/,
    );
  });

  it("contributes the status bar connection command", () => {
    expect(packageManifest.contributes.commands).toContainEqual({
      command: CONNECTION_ACTIONS_COMMAND,
      title: "Show Language Server Connection Actions",
      category: "FoundryScript",
      enablement: "isWorkspaceTrusted && !virtualWorkspace",
    });
  });
});
