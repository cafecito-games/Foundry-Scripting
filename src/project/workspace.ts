import { access } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  resolveFoundryProject,
  type ProjectResolution,
} from "./resolver.js";

const PROJECT_SEARCH_EXCLUDE =
  "**/{.git,.foundry,node_modules,build,dist,foundryscript-test-*}/**";

export type ResolveWorkspaceProject = () => Promise<ProjectResolution>;

export interface WorkspaceProjectResolverOptions {
  readonly manifestExists?: (project: string) => Promise<boolean>;
}

export function createWorkspaceProjectResolver(
  options: WorkspaceProjectResolverOptions = {},
): ResolveWorkspaceProject {
  const manifestExists = options.manifestExists ?? defaultManifestExists;
  return async () => {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const configuredPath = vscode.workspace
      .getConfiguration("foundryScript")
      .get("projectPath", "");
    return resolveFoundryProject({
      workspacePath,
      configuredPath,
      manifestExists,
      findManifests: async (workspace) => {
        const uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspace, "**/project.foundry"),
          PROJECT_SEARCH_EXCLUDE,
        );
        return uris.map((uri) => uri.fsPath);
      },
    });
  };
}

async function defaultManifestExists(project: string): Promise<boolean> {
  try {
    await access(path.join(project, "project.foundry"));
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
