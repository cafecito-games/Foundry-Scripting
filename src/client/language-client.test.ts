import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { CloseAction, State } from "vscode-languageclient/node";

const languageClientMock = vi.hoisted(() => ({
  constructorCalls: [] as unknown[][],
  notificationHandlers: new Map<string, (params: unknown) => void>(),
  stateHandlers: new Set<
    (event: { oldState: State; newState: State }) => void
  >(),
}));
const transportMock = vi.hoisted(() => ({
  options: [] as Array<{
    interceptNotification?: (method: string, params: unknown) => boolean;
  }>,
}));

vi.mock("vscode-languageclient/node", () => ({
  CloseAction: { DoNotRestart: 1, Restart: 2 },
  ErrorAction: { Continue: 1, Shutdown: 2 },
  State: { Stopped: 1, Running: 2, Starting: 3 },
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

    onDidChangeState(
      handler: (event: { oldState: State; newState: State }) => void,
    ) {
      languageClientMock.stateHandlers.add(handler);
      return {
        dispose: () => languageClientMock.stateHandlers.delete(handler),
      };
    }
  },
}));

vi.mock("./transport.js", () => ({
  createTcpServerOptions: vi.fn(
    (options: {
      interceptNotification?: (method: string, params: unknown) => boolean;
    }) => {
      transportMock.options.push(options);
      return vi.fn();
    },
  ),
}));

import {
  FoundryScriptLanguageClient,
  type FoundryCapabilities,
} from "./language-client.js";
import type { WorkspaceMismatchHandler } from "./workspace-mismatch.js";

describe("FoundryScript language client", () => {
  beforeEach(() => {
    languageClientMock.constructorCalls.length = 0;
    languageClientMock.notificationHandlers.clear();
    languageClientMock.stateHandlers.clear();
    transportMock.options.length = 0;
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

  it("isolates capability state from notification and callback aliases", () => {
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
      native_classes: [{ name: "Node", inherits: "Object" }],
    };
    languageClientMock.notificationHandlers.get(
      "foundry_script/capabilities",
    )?.(capabilities);

    capabilities.native_classes[0].name = "Mutated input";
    const callbackCapabilities = onCapabilities.mock.calls[0]?.[0] as
      | FoundryCapabilities
      | undefined;
    if (callbackCapabilities === undefined) {
      throw new Error("capabilities callback was not invoked");
    }
    callbackCapabilities.native_classes[0].inherits = "Mutated callback";
    const returnedCapabilities = client.capabilities;
    returnedCapabilities.native_classes[0].name = "Mutated getter";

    expect(client.capabilities).toEqual({
      native_classes: [{ name: "Node", inherits: "Object" }],
    });
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

  it("routes an initialization-time workspace notification through the existing seam exactly once", () => {
    const onChangeWorkspace = vi.fn();
    const workspaceMismatchHandler = {
      shouldSuppressServerMessage: vi.fn(() => false),
      handleServerWorkspace: vi.fn().mockResolvedValue(undefined),
    } satisfies WorkspaceMismatchHandler;
    const client = new FoundryScriptLanguageClient({
      endpoint: { host: "127.0.0.1", port: 6005 },
      outputChannel: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
      onChangeWorkspace,
      workspaceMismatchHandler,
    });
    const interceptNotification = transportMock.options[0]?.interceptNotification;

    expect(
      interceptNotification?.("fs_client/changeWorkspace", {
        path: "/projects/server-project",
      }),
    ).toBe(true);
    expect(client.serverWorkspacePath).toBe("/projects/server-project");
    expect(onChangeWorkspace).toHaveBeenCalledOnce();
    expect(onChangeWorkspace).toHaveBeenCalledWith({
      path: "/projects/server-project",
    });
    expect(workspaceMismatchHandler.handleServerWorkspace).toHaveBeenCalledOnce();
    expect(
      workspaceMismatchHandler.handleServerWorkspace,
    ).toHaveBeenCalledWith("/projects/server-project");
  });

  it("suppresses only server messages accepted by the mismatch handler", () => {
    const workspaceMismatchHandler = {
      shouldSuppressServerMessage: vi.fn(
        (message: { message: string }) => message.message === "exact warning",
      ),
      handleServerWorkspace: vi.fn().mockResolvedValue(undefined),
    } satisfies WorkspaceMismatchHandler;
    new FoundryScriptLanguageClient({
      endpoint: { host: "127.0.0.1", port: 6005 },
      outputChannel: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
      workspaceMismatchHandler,
    });
    const interceptNotification = transportMock.options[0]?.interceptNotification;

    expect(
      interceptNotification?.("window/showMessage", {
        type: 2,
        message: "exact warning",
      }),
    ).toBe(true);
    expect(
      interceptNotification?.("window/showMessage", {
        type: 2,
        message: "unrelated warning",
      }),
    ).toBe(false);
    expect(
      interceptNotification?.("telemetry/event", { ready: true }),
    ).toBe(false);
  });

  it("passes malformed workspace notifications through without invoking callbacks", () => {
    const onChangeWorkspace = vi.fn();
    const workspaceMismatchHandler = {
      shouldSuppressServerMessage: vi.fn(() => false),
      handleServerWorkspace: vi.fn().mockResolvedValue(undefined),
    } satisfies WorkspaceMismatchHandler;
    new FoundryScriptLanguageClient({
      endpoint: { host: "127.0.0.1", port: 6005 },
      outputChannel: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
      onChangeWorkspace,
      workspaceMismatchHandler,
    });
    const interceptNotification = transportMock.options[0]?.interceptNotification;

    expect(
      interceptNotification?.("fs_client/changeWorkspace", { path: 42 }),
    ).toBe(false);
    expect(onChangeWorkspace).not.toHaveBeenCalled();
    expect(workspaceMismatchHandler.handleServerWorkspace).not.toHaveBeenCalled();
  });

  it("keeps the standard language-client notification handling when no mismatch handler is configured", () => {
    new FoundryScriptLanguageClient({
      endpoint: { host: "127.0.0.1", port: 6005 },
      outputChannel: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });

    expect(transportMock.options[0]?.interceptNotification).toBeUndefined();
  });

  it("disables the language client's implicit restart", async () => {
    new FoundryScriptLanguageClient({
      endpoint: { host: "127.0.0.1", port: 6005 },
      outputChannel: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const clientOptions = languageClientMock.constructorCalls[0]?.[3] as {
      errorHandler?: {
        closed: () =>
          | { action: number; handled?: boolean }
          | PromiseLike<{ action: number; handled?: boolean }>;
      };
    };

    expect(await clientOptions.errorHandler?.closed()).toMatchObject({
      action: CloseAction.DoNotRestart,
      handled: true,
    });
  });

  it("reports only an unexpected running-to-stopped transition", () => {
    const client = new FoundryScriptLanguageClient({
      endpoint: { host: "127.0.0.1", port: 6005 },
      outputChannel: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    });
    const stopped = vi.fn();

    const subscription = client.onUnexpectedStop(stopped);
    for (const handler of languageClientMock.stateHandlers) {
      handler({ oldState: State.Starting, newState: State.Stopped });
      handler({ oldState: State.Running, newState: State.Stopped });
    }
    expect(stopped).toHaveBeenCalledOnce();

    subscription.dispose();
    for (const handler of languageClientMock.stateHandlers) {
      handler({ oldState: State.Running, newState: State.Stopped });
    }
    expect(stopped).toHaveBeenCalledOnce();
  });
});
