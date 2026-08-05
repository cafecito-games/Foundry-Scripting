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
  const findManifests = async (workspace: string): Promise<readonly string[]> => {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspace, "**/project.foundry"),
      PROJECT_SEARCH_EXCLUDE,
    );
    return uris.map((uri) => uri.fsPath);
  };
  return async () => {
    const fileWorkspaceFolders =
      vscode.workspace.workspaceFolders?.filter(
        (folder) => folder.uri.scheme === "file",
      ) ?? [];
    if (fileWorkspaceFolders.length === 0) {
      // Either no workspace folders at all, or only non-file schemes.
      if (vscode.workspace.workspaceFolders !== undefined) {
        const firstScheme = vscode.workspace.workspaceFolders[0]?.uri.scheme;
        if (firstScheme !== undefined) {
          return resolveFoundryProject({
            workspacePath: undefined,
            workspaceScheme: firstScheme,
            configuredPath: "",
            manifestExists,
            findManifests,
          });
        }
      }
      return resolveFoundryProject({
        workspacePath: undefined,
        configuredPath: "",
        manifestExists,
        findManifests,
      });
    }

    const firstFolder = fileWorkspaceFolders[0];
    if (firstFolder === undefined) {
      return resolveFoundryProject({
        workspacePath: undefined,
        configuredPath: "",
        manifestExists,
        findManifests,
      });
    }
    const workspacePath = firstFolder.uri.fsPath;
    const workspaceScheme: string | undefined = firstFolder.uri.scheme;
    const configuredPath = vscode.workspace
      .getConfiguration("foundryScript")
      .get("projectPath", "");

    // When a path is configured, resolve it from the first folder (the
    // documented behavior). Otherwise scan every file-scheme folder so that
    // multi-root workspaces discover a project in any folder, and surface
    // ambiguity when more than one folder contains a project.foundry.
    if (configuredPath.trim() !== "" || fileWorkspaceFolders.length === 1) {
      return resolveFoundryProject({
        workspacePath,
        ...(workspaceScheme === undefined ? {} : { workspaceScheme }),
        configuredPath,
        manifestExists,
        findManifests,
      });
    }

    const foldersWithProjects = await collectFoldersWithProjects(
      fileWorkspaceFolders.map((folder) => folder.uri.fsPath),
      manifestExists,
      findManifests,
    );
    if (foldersWithProjects.length === 0) {
      return resolveFoundryProject({
        workspacePath,
        configuredPath: "",
        manifestExists,
        findManifests,
      });
    }
    if (foldersWithProjects.length === 1) {
      const project = foldersWithProjects[0];
      if (project !== undefined) {
        return { success: true, project };
      }
    }
    const candidates = foldersWithProjects
      .map((project) => path.basename(path.dirname(project)))
      .sort((left, right) => left.localeCompare(right));
    return {
      success: false,
      failure: {
        kind: "ambiguous_projects",
        message:
          `Multiple Foundry projects were found across workspace folders: ${candidates.join(", ")}. ` +
          "Configure foundryScript.projectPath to disambiguate.",
        setting: "foundryScript.projectPath",
        candidates,
      },
    };
  };
}

async function collectFoldersWithProjects(
  folderPaths: readonly string[],
  manifestExists: (project: string) => Promise<boolean>,
  findManifests: (workspace: string) => Promise<readonly string[]>,
): Promise<string[]> {
  const found: string[] = [];
  for (const folder of folderPaths) {
    const resolution = await resolveFoundryProject({
      workspacePath: folder,
      configuredPath: "",
      manifestExists,
      findManifests,
    });
    if (resolution.success) {
      found.push(resolution.project);
    }
  }
  return found;
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
