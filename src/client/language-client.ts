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
  onCapabilities?: (capabilities: FoundryCapabilities) => void;
  onChangeWorkspace?: (params: ChangeWorkspaceParams) => void;
}

export class FoundryScriptLanguageClient extends LanguageClient {
  private currentCapabilities: FoundryCapabilities = { native_classes: [] };
  private currentServerWorkspacePath: string | undefined;

  constructor({
    endpoint,
    outputChannel,
    onCapabilities,
    onChangeWorkspace,
  }: FoundryScriptLanguageClientOptions) {
    super(
      "foundryScript",
      "FoundryScript Language Server",
      createTcpServerOptions({ ...endpoint, output: outputChannel }),
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
    this.onNotification(changeWorkspaceNotification, (params) => {
      this.currentServerWorkspacePath = params.path;
      writeLog(outputChannel, "warn", "lsp.workspace.change_requested", {
        path: params.path,
      });
      onChangeWorkspace?.(params);
    });
  }

  get capabilities(): FoundryCapabilities {
    return copyCapabilities(this.currentCapabilities);
  }

  get serverWorkspacePath(): string | undefined {
    return this.currentServerWorkspacePath;
  }
}
