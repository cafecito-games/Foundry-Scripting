import type * as vscode from "vscode";
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  NotificationType,
  State,
  type StateChangeEvent,
} from "vscode-languageclient/node";
import { writeLog } from "./logging.js";
import { FoundrySemanticTokensFeature } from "./semantic-tokens.js";
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

const capabilitiesNotification = new NotificationType<unknown>(
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
      name: nativeClass.name,
      inherits: nativeClass.inherits,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseFoundryCapabilities(
  value: unknown,
): FoundryCapabilities | undefined {
  if (!isRecord(value) || !Array.isArray(value.native_classes)) {
    return undefined;
  }
  const nativeClasses: FoundryNativeClass[] = [];
  for (const nativeClass of value.native_classes) {
    if (
      !isRecord(nativeClass) ||
      typeof nativeClass.name !== "string" ||
      nativeClass.name.length === 0 ||
      typeof nativeClass.inherits !== "string"
    ) {
      return undefined;
    }
    nativeClasses.push({
      name: nativeClass.name,
      inherits: nativeClass.inherits,
    });
  }
  return { native_classes: nativeClasses };
}

export interface FoundryScriptLanguageClientOptions {
  endpoint: TcpEndpoint;
  outputChannel: vscode.OutputChannel;
  signal?: AbortSignal;
  onCapabilities?: (capabilities: FoundryCapabilities) => void;
  onChangeWorkspace?: (params: ChangeWorkspaceParams) => void;
  onDiagnostics?: (
    uri: vscode.Uri,
    diagnostics: readonly vscode.Diagnostic[],
  ) => void;
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
    onDiagnostics,
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
    const semanticTokens = new FoundrySemanticTokensFeature(outputChannel);

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
        errorHandler: {
          error: () => ({ action: ErrorAction.Continue, handled: true }),
          closed: () => ({ action: CloseAction.DoNotRestart, handled: true }),
        },
        middleware: {
          ...semanticTokens.middleware,
          ...(onDiagnostics === undefined
            ? {}
            : {
                handleDiagnostics: (uri, diagnostics): void => {
                  onDiagnostics(uri, diagnostics);
                },
              }),
        },
      },
    );
    this.registerFeature(semanticTokens);

    this.onNotification(capabilitiesNotification, (params) => {
      const capabilities = parseFoundryCapabilities(params);
      if (capabilities === undefined) {
        writeLog(outputChannel, "warn", "lsp.capabilities.invalid", {
          reason: "invalid_schema",
        });
        return;
      }
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

  onUnexpectedStop(listener: () => void): vscode.Disposable {
    return this.onDidChangeState(
      ({ oldState, newState }: StateChangeEvent): void => {
        if (oldState === State.Running && newState === State.Stopped) {
          listener();
        }
      },
    );
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
