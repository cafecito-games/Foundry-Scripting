import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import packageManifest from "../package.json";
import { HostStartupFailure } from "./client/host-launcher.js";

const extensionMock = vi.hoisted(() => ({
  configuration: new Map<string, unknown>(),
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  outputChannel: {
    appendLine: vi.fn(),
    dispose: vi.fn(),
  },
  showErrorMessage: vi.fn(),
  executeCommand: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
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
    showErrorMessage: extensionMock.showErrorMessage,
  },
  commands: {
    executeCommand: extensionMock.executeCommand,
  },
  tasks: {
    registerTaskProvider: extensionMock.registerTaskProvider,
  },
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
    extensionMock.outputChannel.dispose.mockClear();
    extensionMock.showErrorMessage.mockReset();
    extensionMock.executeCommand.mockReset();
    extensionMock.registerTaskProvider.mockReset();
    extensionMock.registerTaskProvider.mockReturnValue(
      extensionMock.taskProviderDisposable,
    );
    extensionMock.start = vi.fn().mockResolvedValue(undefined);
    extensionMock.stop = vi.fn().mockResolvedValue(undefined);
    extensionMock.createConnectionManager.mockReset();
    extensionMock.createConnectionManager.mockImplementation(() => ({
      start: extensionMock.start,
      stop: extensionMock.stop,
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
});
