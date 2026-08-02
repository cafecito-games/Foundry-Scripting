import type * as vscode from "vscode";
import type { ResolveWorkspaceProject } from "../project/workspace.js";

export const FOUNDRYSCRIPT_DEBUG_TYPE = "foundryscript";

export interface DebugConfigurationProviderOptions {
  readonly resolveProject: ResolveWorkspaceProject;
  readonly reportError: (message: string) => void;
}

export function createDefaultDebugConfiguration(): vscode.DebugConfiguration {
  return {
    type: FOUNDRYSCRIPT_DEBUG_TYPE,
    request: "launch",
    name: "Debug Foundry Project",
    scene: "main",
    args: [],
  };
}

export class FoundryScriptDebugConfigurationProvider
  implements vscode.DebugConfigurationProvider
{
  constructor(private readonly options: DebugConfigurationProviderOptions) {}

  provideDebugConfigurations(
    _folder: vscode.WorkspaceFolder | undefined,
  ): vscode.DebugConfiguration[] {
    return [createDefaultDebugConfiguration()];
  }

  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    configuration: vscode.DebugConfiguration,
  ): vscode.DebugConfiguration {
    if (
      configuration.type === undefined &&
      configuration.request === undefined &&
      configuration.name === undefined
    ) {
      return createDefaultDebugConfiguration();
    }
    return configuration;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    configuration: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (configuration.request !== "launch") {
      return this.reject(
        'FoundryScript debug configurations support only request "launch".',
      );
    }

    const scene: unknown = configuration.scene;
    if (!isSupportedScene(scene)) {
      return this.reject(
        'Set "scene" to "main" or a canonical res:// path ending in .tscn.',
      );
    }

    const args: unknown = configuration.args;
    if (
      args !== undefined &&
      (!Array.isArray(args) || !args.every((argument) => typeof argument === "string"))
    ) {
      return this.reject('Set "args" to an array containing only strings.');
    }

    try {
      const resolution = await this.options.resolveProject();
      if (!resolution.success) {
        return this.reject(resolution.failure.message);
      }

      const resolved: vscode.DebugConfiguration = {
        ...configuration,
        project: resolution.project,
        playArgs: args ?? [],
      };
      delete resolved.args;
      return resolved;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return this.reject(`Unable to resolve the Foundry project: ${detail}`);
    }
  }

  private reject(message: string): undefined {
    this.options.reportError(message);
    return undefined;
  }
}

export function isSupportedScene(value: unknown): value is string {
  if (value === "main") return true;
  if (
    typeof value !== "string" ||
    !value.startsWith("res://") ||
    !value.endsWith(".tscn") ||
    value.includes("\\")
  ) {
    return false;
  }

  const segments = value.slice("res://".length).split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}
