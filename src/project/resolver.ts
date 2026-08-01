import path from "node:path";

export const PROJECT_PATH_SETTING = "foundryScript.projectPath";

export type ProjectResolutionFailureKind =
  | "missing_workspace"
  | "invalid_configured_project"
  | "project_not_found"
  | "ambiguous_projects"
  | "filesystem_error";

export interface ProjectResolutionFailure {
  readonly kind: ProjectResolutionFailureKind;
  readonly message: string;
  readonly setting?: typeof PROJECT_PATH_SETTING;
  readonly candidates?: readonly string[];
  readonly cause?: unknown;
}

export type ProjectResolution =
  | { readonly success: true; readonly project: string }
  | { readonly success: false; readonly failure: ProjectResolutionFailure };

export interface FoundryProjectResolutionRequest {
  readonly workspacePath: string | undefined;
  readonly configuredPath: string;
  readonly manifestExists: (project: string) => Promise<boolean>;
  readonly findManifests: (workspace: string) => Promise<readonly string[]>;
}

export async function resolveFoundryProject(
  request: FoundryProjectResolutionRequest,
): Promise<ProjectResolution> {
  if (request.workspacePath === undefined) {
    return failure(
      "missing_workspace",
      "Open a workspace folder before using Foundry tooling.",
    );
  }

  const workspace = path.resolve(request.workspacePath);
  const configured = request.configuredPath.trim();
  if (configured !== "") {
    const project = path.isAbsolute(configured)
      ? path.resolve(configured)
      : path.resolve(workspace, configured);
    const exists = await checkManifest(request, project);
    if (!exists.success) return exists;
    return exists.present
      ? { success: true, project }
      : failure(
          "invalid_configured_project",
          `Configured Foundry project "${project}" does not contain project.foundry.`,
          { setting: PROJECT_PATH_SETTING },
        );
  }

  const rootManifest = await checkManifest(request, workspace);
  if (!rootManifest.success) return rootManifest;
  if (rootManifest.present) return { success: true, project: workspace };

  let manifests: readonly string[];
  try {
    manifests = await request.findManifests(workspace);
  } catch (cause) {
    return failure(
      "filesystem_error",
      `Unable to search "${workspace}" for Foundry projects.`,
      { cause },
    );
  }

  const projects = [
    ...new Set(manifests.map((manifest) => path.resolve(path.dirname(manifest)))),
  ];
  if (projects.length === 1) {
    return { success: true, project: projects[0] };
  }
  if (projects.length === 0) {
    return failure(
      "project_not_found",
      `No project.foundry was found under "${workspace}".`,
      { setting: PROJECT_PATH_SETTING },
    );
  }

  const candidates = projects
    .map((project) => path.join(path.relative(workspace, project), "project.foundry"))
    .sort((left, right) => left.localeCompare(right));
  return failure(
    "ambiguous_projects",
    `Multiple Foundry projects were found: ${candidates.join(", ")}. Configure ${PROJECT_PATH_SETTING}.`,
    { setting: PROJECT_PATH_SETTING, candidates },
  );
}

type ManifestCheck =
  | { readonly success: true; readonly present: boolean }
  | { readonly success: false; readonly failure: ProjectResolutionFailure };

async function checkManifest(
  request: FoundryProjectResolutionRequest,
  project: string,
): Promise<ManifestCheck> {
  try {
    return { success: true, present: await request.manifestExists(project) };
  } catch (cause) {
    return failure(
      "filesystem_error",
      `Unable to check "${project}" for project.foundry.`,
      { cause },
    );
  }
}

function failure(
  kind: ProjectResolutionFailureKind,
  message: string,
  details: Omit<ProjectResolutionFailure, "kind" | "message"> = {},
): { readonly success: false; readonly failure: ProjectResolutionFailure } {
  return { success: false, failure: { kind, message, ...details } };
}
