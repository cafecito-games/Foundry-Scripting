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
      | ((token: { isCancellationRequested: boolean }) => Promise<void> | void)
      | undefined,
    dispose: vi.fn(),
  };
  return {
  configuration: new Map<string, unknown>(),
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  outputChannel: {
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
  configurationChangeHandler: undefined as
    | ((event: { affectsConfiguration(section: string): boolean }) => void)
    | undefined,
  workspaceFoldersChangeHandler: undefined as (() => void) | undefined,
  onDidChangeConfiguration: vi.fn(),
  onDidChangeWorkspaceFolders: vi.fn(),
  testingProcessOptions: undefined as
    | { onOutput?: (text: string, stream: "stdout" | "stderr") => void }
    | undefined,
  testingProcessRun: vi.fn(),
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
  };
});

vi.mock("vscode", () => ({
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
    get workspaceFolders() {
      return extensionMock.workspaceFolders;
    },
    getConfiguration: () => ({
      get: (key: string, defaultValue: unknown) =>
        extensionMock.configuration.get(key) ?? defaultValue,
    }),
    onDidChangeConfiguration: extensionMock.onDidChangeConfiguration,
    onDidChangeWorkspaceFolders: extensionMock.onDidChangeWorkspaceFolders,
  },
  window: {
    createOutputChannel: vi.fn((name: string) =>
      name === "FoundryScript Testing"
        ? extensionMock.testingOutputChannel
        : extensionMock.outputChannel,
    ),
    createStatusBarItem: vi.fn((_alignment: unknown, priority: number) =>
      priority === 90
        ? extensionMock.testingStatusItem
        : extensionMock.statusItem,
    ),
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
  StatusBarAlignment: { Left: 1 },
  TestRunProfileKind: { Run: 1, Debug: 2 },
  languages: {
    createDiagnosticCollection: extensionMock.createDiagnosticCollection,
  },
}));

vi.mock("./client/runtime.js", () => ({
  createConnectionManager: extensionMock.createConnectionManager,
}));

vi.mock("./diagnostics/index.js", () => ({
  createDiagnosticsUnit: extensionMock.createDiagnosticsUnit,
}));

vi.mock("./tasks/provider.js", () => ({
  registerFoundryTaskProvider: extensionMock.registerFoundryTaskProvider,
}));

vi.mock("./testing/process.js", () => ({
  FoundryTestAdapterProcess: class {
    readonly run = extensionMock.testingProcessRun;

    constructor(options: unknown) {
      extensionMock.testingProcessOptions = options as never;
    }
  },
}));

vi.mock("./testing/adapter.js", () => ({
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

describe("extension entry point", () => {
  beforeEach(async () => {
    await deactivate();
    extensionMock.configuration.clear();
    extensionMock.workspaceFolders.length = 0;
    extensionMock.outputChannel.appendLine.mockClear();
    extensionMock.outputChannel.show.mockClear();
    extensionMock.outputChannel.dispose.mockClear();
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
    extensionMock.configurationChangeHandler = undefined;
    extensionMock.workspaceFoldersChangeHandler = undefined;
    extensionMock.onDidChangeConfiguration.mockReset();
    extensionMock.onDidChangeConfiguration.mockImplementation(
      (handler: (event: { affectsConfiguration(section: string): boolean }) => void) => {
      extensionMock.configurationChangeHandler = handler;
      return { dispose: vi.fn() };
      },
    );
    extensionMock.onDidChangeWorkspaceFolders.mockReset();
    extensionMock.onDidChangeWorkspaceFolders.mockImplementation(
      (handler: () => void) => {
        extensionMock.workspaceFoldersChangeHandler = handler;
        return { dispose: vi.fn() };
      },
    );
    extensionMock.testingProcessOptions = undefined;
    extensionMock.testingProcessRun.mockReset();
    extensionMock.testingNegotiatorOptions = undefined;
    extensionMock.testingNegotiate.mockReset();
    extensionMock.testingDiscovererOptions = undefined;
    extensionMock.testingDiscover.mockReset();
    extensionMock.testingExecutorOptions = undefined;
    extensionMock.testingExecute.mockReset();
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
    extensionMock.start = vi.fn().mockResolvedValue(undefined);
    extensionMock.stop = vi.fn().mockResolvedValue(undefined);
    extensionMock.reconnectNow = vi.fn().mockResolvedValue(undefined);
    extensionMock.createConnectionManager.mockReset();
    extensionMock.createConnectionManager.mockImplementation(() => ({
      start: extensionMock.start,
      stop: extensionMock.stop,
      reconnectNow: extensionMock.reconnectNow,
    }));
  });

  it("starts the configured connection mode for the open project", async () => {
    extensionMock.configuration.set("lsp.mode", "attach");
    extensionMock.configuration.set("lsp.port", 7001);
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
    );
    expect(extensionMock.start).toHaveBeenCalledWith({
      settings: {
        mode: "attach",
        port: 7001,
        enginePath: "/opt/foundry",
      },
      project: "/workspace/game",
    });
    expect(context.subscriptions).toContain(extensionMock.outputChannel);
    expect(context.subscriptions).toContain(extensionMock.statusItem);
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
    );
    expect(extensionMock.statusItem.show).toHaveBeenCalledOnce();
    expect(extensionMock.statusItem.text).toContain("Off");
    expect(extensionMock.createDiagnosticCollection).toHaveBeenCalledWith(
      "foundryscript",
    );
    expect(context.subscriptions).toContain(extensionMock.diagnosticsUnit);
  });

  it("reports a missing project without attempting a connection", async () => {
    await activate(createContext());

    expect(extensionMock.createConnectionManager).not.toHaveBeenCalled();
    expect(extensionMock.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Open a Foundry project folder"),
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
        port: 49152,
      }),
    );
    extensionMock.showErrorMessage.mockResolvedValue("Open Settings");

    await activate(createContext());

    expect(extensionMock.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("/missing/foundry"),
      "Open Settings",
    );
    expect(extensionMock.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "foundryScript.enginePath",
    );
  });

  it("keeps reconnect available after initial startup fails", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    extensionMock.start.mockRejectedValue(new Error("connection refused"));
    extensionMock.showQuickPick.mockResolvedValue(RECONNECT_ACTION);

    await activate(createContext());
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

  it("creates exactly one TestController with one default Run profile", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    const context = createContext();

    await activate(context);

    expect(extensionMock.createTestController).toHaveBeenCalledOnce();
    expect(extensionMock.createTestController).toHaveBeenCalledWith(
      "foundryScript.tests",
      "FoundryScript",
    );
    expect(extensionMock.testController.createRunProfile).toHaveBeenCalledOnce();
    expect(extensionMock.testController.createRunProfile).toHaveBeenCalledWith(
      "Run",
      1,
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
    expect(extensionMock.testController.createRunProfile).toHaveBeenCalledOnce();
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

    const refreshPromise = extensionMock.testController.refreshHandler?.({
      isCancellationRequested: false,
    });
    expect(extensionMock.testingRefresh).toHaveBeenCalledOnce();
    refresh.resolve(undefined);
    await refreshPromise;

    extensionMock.testingRefresh.mockClear();
    await extensionMock.testController.refreshHandler?.({
      isCancellationRequested: true,
    });
    expect(extensionMock.testingRefresh).not.toHaveBeenCalled();
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
    expect(extensionMock.testingStatusItem.text).toContain("Unavailable");
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

  it("reconfigures only for relevant settings and workspace changes", async () => {
    extensionMock.configuration.set("lsp.mode", "off");
    await activate(createContext());
    extensionMock.testingConfigure.mockClear();

    extensionMock.configuration.set("testing.enabled", true);
    extensionMock.configurationChangeHandler?.({
      affectsConfiguration: (section) =>
        section === "foundryScript.testing.enabled",
    });
    extensionMock.configurationChangeHandler?.({
      affectsConfiguration: () => false,
    });
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/changed" },
    });
    extensionMock.workspaceFoldersChangeHandler?.();

    expect(extensionMock.testingConfigure).toHaveBeenCalledTimes(2);
    expect(extensionMock.testingConfigure).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        project: "/workspace/changed",
      }),
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
    expect(extensionMock.stop).toHaveBeenCalledOnce();
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

  it("cleans up and forgets a connection manager after cancelled startup", async () => {
    extensionMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    const cancellation = new Error("cancelled");
    cancellation.name = "AbortError";
    extensionMock.start.mockRejectedValue(cancellation);

    await activate(createContext());
    expect(extensionMock.stop).toHaveBeenCalledOnce();
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
      type: "number",
      default: 6005,
      minimum: 1,
      maximum: 65535,
    });
    expect(properties["foundryScript.enginePath"]).toMatchObject({
      type: "string",
      default: "foundry",
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
    });
  });
});
