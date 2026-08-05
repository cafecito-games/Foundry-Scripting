import { realpathSync } from "node:fs";
import * as path from "node:path";

// Pinned verbatim from the Foundry engine's language-server bootstrap. The
// engine emits this through `window/showMessage` when its active project
// differs from the workspace the editor opened. Suppression is hard-matched by
// exact string equality so the extension can replace the raw, non-actionable
// engine notice with its own "Open Server Project" prompt. Any change on the
// engine side must be mirrored here and in the regression test below.
export const RAW_WORKSPACE_MISMATCH_WARNING =
  "The FoundryScript Language Server might not work correctly with other projects than the one opened in Foundry.";
export const OPEN_SERVER_WORKSPACE_ACTION = "Open Server Project";

export interface ServerShowMessage {
  readonly type: number;
  readonly message: string;
}

export interface WorkspacePathComparisonOptions {
  readonly platform?: NodeJS.Platform;
  readonly realpath?: (path: string) => string;
}

export interface WorkspaceMismatchHandlerOptions {
  readonly workspacePath: string;
  readonly showWarningMessage: (
    message: string,
    action: string,
  ) => PromiseLike<string | undefined>;
  readonly openFolder: (path: string) => PromiseLike<unknown>;
  readonly pathComparison?: WorkspacePathComparisonOptions;
}

export interface WorkspaceMismatchHandler {
  shouldSuppressServerMessage(message: ServerShowMessage): boolean;
  handleServerWorkspace(path: string): Promise<void>;
}

export function workspacePathsMatch(
  workspacePath: string,
  serverPath: string,
  options: WorkspacePathComparisonOptions = {},
): boolean {
  const normalizedWorkspace = normalizeWorkspacePath(workspacePath, options);
  const normalizedServer = normalizeWorkspacePath(serverPath, options);

  return (
    normalizedWorkspace !== undefined &&
    normalizedServer !== undefined &&
    normalizedWorkspace === normalizedServer
  );
}

export function createWorkspaceMismatchHandler(
  options: WorkspaceMismatchHandlerOptions,
): WorkspaceMismatchHandler {
  let promptState: "idle" | "pending" | "acknowledged" = "idle";

  return {
    shouldSuppressServerMessage: (message) =>
      message.type === 2 && message.message === RAW_WORKSPACE_MISMATCH_WARNING,
    async handleServerWorkspace(serverPath): Promise<void> {
      if (
        promptState !== "idle" ||
        workspacePathsMatch(
          options.workspacePath,
          serverPath,
          options.pathComparison,
        )
      ) {
        return;
      }

      promptState = "pending";
      const message =
        `VS Code has "${options.workspacePath}" open, but the Foundry ` +
        `language server is serving "${serverPath}". Open the server project ` +
        "to avoid incorrect diagnostics and language results.";

      let choice: string | undefined;
      try {
        choice = await options.showWarningMessage(
          message,
          OPEN_SERVER_WORKSPACE_ACTION,
        );
      } catch {
        promptState = "idle";
        return;
      }

      promptState = "acknowledged";
      if (choice === OPEN_SERVER_WORKSPACE_ACTION) {
        try {
          await options.openFolder(serverPath);
        } catch {
          // The prompt was acknowledged even if VS Code could not open the folder.
        }
      }
    },
  };
}

function normalizeWorkspacePath(
  value: string,
  options: WorkspacePathComparisonOptions,
): string | undefined {
  if (value.length === 0) {
    return undefined;
  }

  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const resolveCanonicalPath = options.realpath ?? realpathSync.native;
  let normalized = pathApi.resolve(value);

  try {
    normalized = resolveCanonicalPath(normalized);
  } catch {
    // Paths supplied by a remote or starting server may not exist yet. The
    // lexical normalization remains safe and deterministic in that case.
  }

  normalized = pathApi.normalize(normalized);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
