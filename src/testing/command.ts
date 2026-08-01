export type TestAdapterConfigurationErrorKind =
  | "missing_engine"
  | "missing_project"
  | "missing_runner"
  | "invalid_runner"
  | "invalid_args"
  | "invalid_protocol_version";

export class TestAdapterConfigurationError extends Error {
  constructor(
    readonly kind: TestAdapterConfigurationErrorKind,
    readonly setting?: string,
  ) {
    super(configurationErrorMessage(kind));
    this.name = "TestAdapterConfigurationError";
  }
}

export interface TestAdapterCommandRequestFields {
  readonly enginePath: string;
  readonly project: string | undefined;
  readonly runner: string;
  readonly frameworkArgs: readonly string[];
}

export interface TestAdapterCapabilitiesCommandRequest
  extends TestAdapterCommandRequestFields {
  readonly outputPath: string;
}

export interface TestAdapterDiscoveryCommandRequest
  extends TestAdapterCommandRequestFields {
  readonly protocolVersion: number;
  readonly outputPath: string;
}

export interface TestAdapterCommand {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
}

export function createTestAdapterCapabilitiesCommand(
  request: TestAdapterCapabilitiesCommandRequest,
): TestAdapterCommand {
  const validated = validateCommandRequest(request);

  const args = [
    "--headless",
    "--no-header",
    "project",
    "test",
    "--project",
    validated.project,
    "--runner",
    request.runner,
    "--",
    "adapter",
    "capabilities",
    "--output",
    request.outputPath,
  ];
  appendFrameworkArguments(args, request.frameworkArgs);

  return {
    command: request.enginePath,
    args,
    cwd: validated.project,
  };
}

export function createTestAdapterDiscoveryCommand(
  request: TestAdapterDiscoveryCommandRequest,
): TestAdapterCommand {
  const validated = validateCommandRequest(request);
  if (!Number.isInteger(request.protocolVersion) || request.protocolVersion <= 0) {
    throw new TestAdapterConfigurationError("invalid_protocol_version");
  }

  const args = [
    "--headless",
    "--no-header",
    "project",
    "test",
    "--project",
    validated.project,
    "--runner",
    request.runner,
    "--",
    "adapter",
    "discover",
    "--protocol-version",
    String(request.protocolVersion),
    "--output",
    request.outputPath,
  ];
  appendFrameworkArguments(args, request.frameworkArgs);

  return {
    command: request.enginePath,
    args,
    cwd: validated.project,
  };
}

function validateCommandRequest(
  request: TestAdapterCommandRequestFields,
): { readonly project: string } {
  if (request.enginePath.trim() === "") {
    throw new TestAdapterConfigurationError(
      "missing_engine",
      "foundryScript.enginePath",
    );
  }
  if (request.project === undefined || request.project.trim() === "") {
    throw new TestAdapterConfigurationError("missing_project");
  }
  if (request.runner.trim() === "") {
    throw new TestAdapterConfigurationError(
      "missing_runner",
      "foundryScript.testing.runner",
    );
  }
  if (!isCanonicalRunnerResource(request.runner)) {
    throw new TestAdapterConfigurationError(
      "invalid_runner",
      "foundryScript.testing.runner",
    );
  }
  if (
    !Array.isArray(request.frameworkArgs) ||
    !request.frameworkArgs.every((argument: unknown) => typeof argument === "string")
  ) {
    throw new TestAdapterConfigurationError(
      "invalid_args",
      "foundryScript.testing.args",
    );
  }
  return { project: request.project };
}

function appendFrameworkArguments(
  args: string[],
  frameworkArgs: readonly string[],
): void {
  if (frameworkArgs.length > 0) {
    args.push("--", ...frameworkArgs);
  }
}

function isCanonicalRunnerResource(runner: string): boolean {
  if (!runner.startsWith("res://") || runner.includes("\\")) {
    return false;
  }
  const relative = runner.slice("res://".length);
  if (relative === "" || relative.endsWith("/")) {
    return false;
  }
  return relative
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function configurationErrorMessage(
  kind: TestAdapterConfigurationErrorKind,
): string {
  switch (kind) {
    case "missing_engine":
      return "Configure foundryScript.enginePath before starting test adapter negotiation.";
    case "missing_project":
      return "Open a Foundry project folder before starting test adapter negotiation.";
    case "missing_runner":
      return "Configure foundryScript.testing.runner before enabling Foundry testing.";
    case "invalid_runner":
      return "Configure foundryScript.testing.runner as a canonical res:// resource path.";
    case "invalid_args":
      return "Configure foundryScript.testing.args as an array of strings.";
    case "invalid_protocol_version":
      return "Use a negotiated positive integer Foundry test adapter protocol version.";
  }
}
