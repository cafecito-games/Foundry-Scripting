export const FOUNDRY_TASK_KINDS = [
  "build",
  "lint",
  "test",
  "format",
  "run",
] as const;

export type FoundryTaskKind = (typeof FOUNDRY_TASK_KINDS)[number];

export type FoundryTaskConfigurationErrorKind =
  | "missing_engine"
  | "missing_project"
  | "missing_runner";

export class FoundryTaskConfigurationError extends Error {
  constructor(
    readonly kind: FoundryTaskConfigurationErrorKind,
    readonly setting?: string,
  ) {
    super(configurationErrorMessage(kind));
    this.name = "FoundryTaskConfigurationError";
  }
}

export interface FoundryTaskCommandRequest {
  readonly kind: FoundryTaskKind;
  readonly enginePath: string;
  readonly project: string | undefined;
  readonly testRunner?: string;
}

export interface FoundryTaskCommand {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
}

export function createFoundryTaskCommand(
  request: FoundryTaskCommandRequest,
): FoundryTaskCommand {
  if (request.enginePath.trim() === "") {
    throw new FoundryTaskConfigurationError(
      "missing_engine",
      "foundryScript.enginePath",
    );
  }
  if (request.project === undefined || request.project.trim() === "") {
    throw new FoundryTaskConfigurationError("missing_project");
  }
  if (
    request.kind === "test" &&
    (request.testRunner === undefined || request.testRunner.trim() === "")
  ) {
    throw new FoundryTaskConfigurationError(
      "missing_runner",
      "foundryScript.test.runner",
    );
  }

  return {
    command: request.enginePath,
    args: taskArguments(request.kind, request.project, request.testRunner),
    cwd: request.project,
  };
}

function taskArguments(
  kind: FoundryTaskKind,
  project: string,
  testRunner: string | undefined,
): string[] {
  switch (kind) {
    case "build":
      return ["project", "import", "--project", project];
    case "lint":
      return ["script", "lint", "--project", project, "--format=json"];
    case "test":
      if (testRunner === undefined) {
        throw new FoundryTaskConfigurationError(
          "missing_runner",
          "foundryScript.test.runner",
        );
      }
      return [
        "project",
        "test",
        "--project",
        project,
        "--runner",
        testRunner,
      ];
    case "format":
      return ["script", "format", "--project", project];
    case "run":
      return ["project", "run", "--project", project];
  }
}

function configurationErrorMessage(
  kind: FoundryTaskConfigurationErrorKind,
): string {
  switch (kind) {
    case "missing_engine":
      return "Configure foundryScript.enginePath before running FoundryScript tasks.";
    case "missing_project":
      return "Open a Foundry project folder before running FoundryScript tasks.";
    case "missing_runner":
      return "Configure foundryScript.test.runner before running the FoundryScript test task.";
  }
}
