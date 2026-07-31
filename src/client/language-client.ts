import type * as vscode from "vscode";
import {
  LanguageClient,
  NotificationType,
} from "vscode-languageclient/node";
import { writeLog } from "./logging.js";
import {
  createTcpServerOptions,
  type TcpEndpoint,
} from "./transport.js";
import type {
  ServerShowMessage,
  WorkspaceMismatchHandler,
} from "./workspace-mismatch.js";

export const CAPABILITIES_NOTIFICATION = "foundry_script/capabilities";
export const CHANGE_WORKSPACE_NOTIFICATION = "fs_client/changeWorkspace";

export interface FoundryNativeClass {
  name: string;
  inherits: string;
}

export interface FoundryCapabilities {
  native_classes: FoundryNativeClass[];
}

export interface ChangeWorkspaceParams {
  path: string;
}

const capabilitiesNotification = new NotificationType<FoundryCapabilities>(
  CAPABILITIES_NOTIFICATION,
);
const changeWorkspaceNotification = new NotificationType<ChangeWorkspaceParams>(
  CHANGE_WORKSPACE_NOTIFICATION,
);

function copyCapabilities(
  capabilities: FoundryCapabilities,
): FoundryCapabilities {
  return {
    native_classes: capabilities.native_classes.map((nativeClass) => ({
      ...nativeClass,
    })),
  };
}

export interface FoundryScriptLanguageClientOptions {
  endpoint: TcpEndpoint;
  outputChannel: vscode.OutputChannel;
  signal?: AbortSignal;
  onCapabilities?: (capabilities: FoundryCapabilities) => void;
  onChangeWorkspace?: (params: ChangeWorkspaceParams) => void;
  workspaceMismatchHandler?: WorkspaceMismatchHandler;
}

export class FoundryScriptLanguageClient extends LanguageClient {
  private currentCapabilities: FoundryCapabilities = { native_classes: [] };
  private currentServerWorkspacePath: string | undefined;

  constructor({
    endpoint,
    outputChannel,
    signal,
    onCapabilities,
    onChangeWorkspace,
    workspaceMismatchHandler,
  }: FoundryScriptLanguageClientOptions) {
    let dispatchChangeWorkspace:
      | ((params: ChangeWorkspaceParams) => void)
      | undefined;
    const interceptNotification =
      workspaceMismatchHandler === undefined
        ? undefined
        : (method: string, params: unknown): boolean => {
            if (method === "window/showMessage") {
              return (
                isServerShowMessage(params) &&
                workspaceMismatchHandler.shouldSuppressServerMessage(params)
              );
            }
            if (method === CHANGE_WORKSPACE_NOTIFICATION) {
              if (!isChangeWorkspaceParams(params)) {
                return false;
              }
              dispatchChangeWorkspace?.(params);
              return true;
            }
            return false;
          };

    super(
      "foundryScript",
      "FoundryScript Language Server",
      createTcpServerOptions({
        ...endpoint,
        output: outputChannel,
        signal,
        ...(interceptNotification === undefined
          ? {}
          : { interceptNotification }),
      }),
      {
        documentSelector: [
          { scheme: "file", language: "foundryscript" },
          { scheme: "untitled", language: "foundryscript" },
        ],
        outputChannel,
      },
    );

    this.onNotification(capabilitiesNotification, (capabilities) => {
      this.currentCapabilities = copyCapabilities(capabilities);
      writeLog(outputChannel, "info", "lsp.capabilities.received", {
        nativeClassCount: capabilities.native_classes.length,
      });
      onCapabilities?.(copyCapabilities(this.currentCapabilities));
    });
    const handleChangeWorkspace = (params: ChangeWorkspaceParams): void => {
      this.currentServerWorkspacePath = params.path;
      writeLog(outputChannel, "warn", "lsp.workspace.change_requested", {
        path: params.path,
      });
      onChangeWorkspace?.(params);
      void workspaceMismatchHandler?.handleServerWorkspace(params.path);
    };
    dispatchChangeWorkspace = handleChangeWorkspace;
    this.onNotification(changeWorkspaceNotification, handleChangeWorkspace);
  }

  get capabilities(): FoundryCapabilities {
    return copyCapabilities(this.currentCapabilities);
  }

  get serverWorkspacePath(): string | undefined {
    return this.currentServerWorkspacePath;
  }
}

function isChangeWorkspaceParams(value: unknown): value is ChangeWorkspaceParams {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof value.path === "string" &&
    value.path.length > 0
  );
}

function isServerShowMessage(value: unknown): value is ServerShowMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "number" &&
    "message" in value &&
    typeof value.message === "string"
  );
}
