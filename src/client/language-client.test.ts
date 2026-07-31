import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const languageClientMock = vi.hoisted(() => ({
  constructorCalls: [] as unknown[][],
  notificationHandlers: new Map<string, (params: unknown) => void>(),
}));

vi.mock("vscode-languageclient/node", () => ({
  NotificationType: class {
    constructor(public readonly method: string) {}
  },
  LanguageClient: class {
    constructor(...args: unknown[]) {
      languageClientMock.constructorCalls.push(args);
    }

    onNotification(
      type: string | { method: string },
      handler: (params: unknown) => void,
    ) {
      const method = typeof type === "string" ? type : type.method;
      languageClientMock.notificationHandlers.set(method, handler);
      return { dispose: () => undefined };
    }
  },
}));

import {
  FoundryScriptLanguageClient,
  type FoundryCapabilities,
} from "./language-client.js";

describe("FoundryScript language client", () => {
  beforeEach(() => {
    languageClientMock.constructorCalls.length = 0;
    languageClientMock.notificationHandlers.clear();
  });

  it("registers standard language features for FoundryScript documents", () => {
    const outputChannel = {
      appendLine: vi.fn(),
    } as unknown as vscode.OutputChannel;

    new FoundryScriptLanguageClient({
      endpoint: { host: "127.0.0.1", port: 6005 },
      outputChannel,
    });

    expect(languageClientMock.constructorCalls).toHaveLength(1);
    const [id, name, serverOptions, clientOptions] =
      languageClientMock.constructorCalls[0];
    expect(id).toBe("foundryScript");
    expect(name).toBe("FoundryScript Language Server");
    expect(serverOptions).toBeTypeOf("function");
    expect(clientOptions).toMatchObject({
      documentSelector: [
        { scheme: "file", language: "foundryscript" },
        { scheme: "untitled", language: "foundryscript" },
      ],
      outputChannel,
    });
  });

  it("records native class capabilities and forwards the notification", () => {
    const outputChannel = {
      appendLine: vi.fn(),
    } as unknown as vscode.OutputChannel;
    const onCapabilities = vi.fn();
    const client = new FoundryScriptLanguageClient({
      endpoint: { host: "127.0.0.1", port: 6005 },
      outputChannel,
      onCapabilities,
    });
    const capabilities: FoundryCapabilities = {
      native_classes: [
        { name: "Node", inherits: "Object" },
        { name: "Object", inherits: "" },
      ],
    };

    languageClientMock.notificationHandlers.get(
      "foundry_script/capabilities",
    )?.(capabilities);

    expect(client.capabilities).toEqual(capabilities);
    expect(onCapabilities).toHaveBeenCalledWith(capabilities);
  });

  it("does not expose mutable native class state to consumers", () => {
    const outputChannel = {
      appendLine: vi.fn(),
    } as unknown as vscode.OutputChannel;
    const client = new FoundryScriptLanguageClient({
      endpoint: { host: "127.0.0.1", port: 6005 },
      outputChannel,
    });
    const capabilities: FoundryCapabilities = {
      native_classes: [{ name: "Node", inherits: "Object" }],
    };
    languageClientMock.notificationHandlers.get(
      "foundry_script/capabilities",
    )?.(capabilities);

    client.capabilities.native_classes.push({ name: "Injected", inherits: "" });

    expect(client.capabilities.native_classes).toEqual([
      { name: "Node", inherits: "Object" },
    ]);
  });

  it("records the requested server workspace and forwards the notification", () => {
    const outputChannel = {
      appendLine: vi.fn(),
    } as unknown as vscode.OutputChannel;
    const onChangeWorkspace = vi.fn();
    const client = new FoundryScriptLanguageClient({
      endpoint: { host: "127.0.0.1", port: 6005 },
      outputChannel,
      onChangeWorkspace,
    });

    languageClientMock.notificationHandlers.get("fs_client/changeWorkspace")?.({
      path: "/projects/server-project",
    });

    expect(client.serverWorkspacePath).toBe("/projects/server-project");
    expect(onChangeWorkspace).toHaveBeenCalledWith({
      path: "/projects/server-project",
    });
  });
});
