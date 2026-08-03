import path from "node:path";
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

    if (configuration["foundry/launch"] !== undefined) {
      const failure = validateProjectTestConfiguration(configuration);
      return failure === undefined ? configuration : this.reject(failure);
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

function validateProjectTestConfiguration(
  configuration: vscode.DebugConfiguration,
): string | undefined {
  const project: unknown = configuration.project;
  if (typeof project !== "string" || !path.isAbsolute(project)) {
    return "The internal FoundryScript test debug launch requires an absolute project path.";
  }
  if (configuration.noDebug !== false) {
    return "The internal FoundryScript test debug launch requires noDebug=false.";
  }
  const launch: unknown = configuration["foundry/launch"];
  if (!isRecord(launch) || launch.kind !== "project_test") {
    return 'The internal FoundryScript test debug launch requires kind "project_test".';
  }
  if (typeof launch.runner !== "string" || !isCanonicalResourcePath(launch.runner)) {
    return "The internal FoundryScript test debug launch requires a canonical res:// runner path.";
  }
  const adapter = launch.adapter;
  if (!isRecord(adapter) || adapter.protocolVersion !== 1) {
    return "The internal FoundryScript test debug launch requires adapter protocol version 1.";
  }
  if (typeof adapter.report !== "string" || !path.isAbsolute(adapter.report)) {
    return "The internal FoundryScript test debug launch requires an absolute TAP report path.";
  }
  if (
    !Array.isArray(adapter.testIds) ||
    adapter.testIds.length === 0 ||
    !adapter.testIds.every(isTestId) ||
    new Set(adapter.testIds).size !== adapter.testIds.length
  ) {
    return "The internal FoundryScript test debug launch requires unique non-empty selected test IDs.";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isCanonicalResourcePath(value: string): boolean {
  if (!value.startsWith("res://") || value.includes("\\")) return false;
  const segments = value.slice("res://".length).split("/");
  return (
    segments.length > 0 &&
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    )
  );
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
