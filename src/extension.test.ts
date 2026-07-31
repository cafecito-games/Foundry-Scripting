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

const extensionMock = vi.hoisted(() => ({
  configuration: new Map<string, unknown>(),
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  outputChannel: {
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
  showErrorMessage: vi.fn(),
  showQuickPick: vi.fn(),
  executeCommand: vi.fn(),
  registeredCommands: new Map<string, () => Promise<void>>(),
  registerCommand: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  reconnectNow: vi.fn(),
  createConnectionManager: vi.fn(),
  taskProviderDisposable: { dispose: vi.fn() },
  registerTaskProvider: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return extensionMock.workspaceFolders;
    },
    getConfiguration: () => ({
      get: (key: string, defaultValue: unknown) =>
        extensionMock.configuration.get(key) ?? defaultValue,
    }),
  },
  window: {
    createOutputChannel: vi.fn(() => extensionMock.outputChannel),
    createStatusBarItem: vi.fn(() => extensionMock.statusItem),
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
}));

vi.mock("./client/runtime.js", () => ({
  createConnectionManager: extensionMock.createConnectionManager,
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
    extensionMock.statusItem.text = "";
    extensionMock.statusItem.tooltip = "";
    extensionMock.statusItem.command = undefined;
    extensionMock.statusItem.show.mockClear();
    extensionMock.statusItem.dispose.mockClear();
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
    expect(extensionMock.registerTaskProvider).toHaveBeenCalledWith(
      "foundryscript",
      expect.anything(),
    );
    expect(context.subscriptions).toContain(extensionMock.taskProviderDisposable);
    expect(extensionMock.statusItem.show).toHaveBeenCalledOnce();
    expect(extensionMock.statusItem.text).toContain("Off");
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
  });

  it("contributes tasks.json definitions for the five Foundry CLI verbs", () => {
    const [definition] = packageManifest.contributes.taskDefinitions;

    expect(definition.type).toBe("foundryscript");
    expect(definition.required).toEqual(["command"]);
    expect(definition.properties.command).toMatchObject({
      type: "string",
      enum: ["build", "lint", "test", "format", "run"],
    });
  });

  it("contributes the status bar connection command", () => {
    expect(packageManifest.contributes.commands).toContainEqual({
      command: CONNECTION_ACTIONS_COMMAND,
      title: "Show Language Server Connection Actions",
      category: "FoundryScript",
    });
  });
});
