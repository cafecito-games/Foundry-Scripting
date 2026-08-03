import { execFile, spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";
import { runBoundedCommand } from "./run-vscode-minimum.mjs";

export const VSCODE_VERSION = "1.90.0";
export const INTEGRATION_SCENARIOS = Object.freeze([
  "language-tasks",
  "test-explorer",
  "diagnostics",
  "reconfiguration",
  "cold-start-failure",
  "pending-start-shutdown",
  "normal-shutdown",
  "restricted",
  "virtual-workspace",
]);

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const driverRoot = path.join(repositoryRoot, "tests/extension-host/driver");
const fakeFoundryPath = path.join(
  repositoryRoot,
  "tests/extension-host/fake-foundry/foundry.mjs",
);
const execFileAsync = promisify(execFile);

function shortRootParent() {
  return process.platform === "win32" ? os.tmpdir() : "/tmp";
}

export function createScenarioPaths(root, scenario) {
  const scenarioRoot = path.join(root, scenario);
  return {
    scenario,
    root: scenarioRoot,
    userData: path.join(scenarioRoot, "user-data"),
    extensions: path.join(scenarioRoot, "extensions"),
    workspace: path.join(scenarioRoot, "workspace"),
    control: path.join(scenarioRoot, "control"),
    logs: path.join(scenarioRoot, "logs"),
  };
}

export function buildScenarioLaunch(paths) {
  const workspaceTarget =
    paths.scenario === "virtual-workspace"
      ? "--folder-uri=foundry-e2e:/project"
      : paths.workspace;
  const launchArgs = [
    workspaceTarget,
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-telemetry",
    `--user-data-dir=${paths.userData}`,
    `--extensions-dir=${paths.extensions}`,
  ];
  if (paths.scenario !== "restricted") {
    launchArgs.push("--disable-workspace-trust");
  }
  return {
    version: VSCODE_VERSION,
    extensionDevelopmentPath:
      paths.scenario === "virtual-workspace"
        ? [driverRoot, path.join(repositoryRoot, "tests/extension-host/virtual-provider")]
        : driverRoot,
    extensionTestsPath: path.join(driverRoot, "index.cjs"),
    launchArgs,
    extensionTestsEnv: {
      FOUNDRY_E2E_SCENARIO: paths.scenario,
      FOUNDRY_E2E_CONTROL: paths.control,
      FOUNDRY_E2E_LOGS: paths.logs,
      FOUNDRY_E2E_WORKSPACE: paths.workspace,
      FOUNDRY_E2E_FAKE_FOUNDRY: fakeFoundryPath,
    },
  };
}

async function prepareWorkspace(paths) {
  await Promise.all([
    mkdir(paths.userData, { recursive: true }),
    mkdir(paths.extensions, { recursive: true }),
    mkdir(paths.workspace, { recursive: true }),
    mkdir(paths.control, { recursive: true }),
    mkdir(paths.logs, { recursive: true }),
  ]);
  const fixture = path.join(
    repositoryRoot,
    "tests/extension-host/fixtures",
    paths.scenario === "reconfiguration" ? "multi-root" : "local",
  );
  await cp(fixture, paths.workspace, { recursive: true });
  const settingsDirectory = path.join(paths.workspace, ".vscode");
  await mkdir(settingsDirectory, { recursive: true });
  const usesMissingExecutable = paths.scenario === "cold-start-failure";
  const settings = {
    "foundryScript.enginePath": usesMissingExecutable
      ? path.join(paths.root, "missing-foundry")
      : fakeFoundryPath,
    "foundryScript.lsp.mode":
      paths.scenario === "language-tasks" ||
      paths.scenario === "test-explorer" ||
      paths.scenario === "diagnostics"
        ? "off"
        : "spawn",
    "foundryScript.testing.enabled":
      paths.scenario === "test-explorer" ||
      paths.scenario === "reconfiguration" ||
      paths.scenario === "normal-shutdown" ||
      paths.scenario === "restricted" ||
      paths.scenario === "virtual-workspace",
    "foundryScript.testing.runner": "res://tests/runner.fs",
    "foundryScript.testing.args": [],
  };
  await writeFile(
    path.join(settingsDirectory, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
  await writeFile(
    path.join(paths.control, "state.json"),
    `${JSON.stringify({ mode: paths.scenario === "pending-start-shutdown" ? "never-ready" : "normal", generation: 1, lintMessage: "CLI diagnostic generation 1", lspMessage: "LSP diagnostic generation 1" })}\n`,
  );
}

async function findVsix() {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  return path.join(repositoryRoot, `${manifest.name}-${manifest.version}.vsix`);
}

async function packageOnce() {
  const vsix = await findVsix();
  await execFileAsync("npm", ["run", "package"], { cwd: repositoryRoot });
  await access(vsix);
  return vsix;
}

async function installVsix(vscodeExecutablePath, vsix, paths) {
  const [cli, ...baseArgs] = resolveCliArgsFromVSCodeExecutablePath(
    vscodeExecutablePath,
  );
  await execFileAsync(
    cli,
    [
      ...baseArgs.filter(
        (argument) =>
          !argument.startsWith("--extensions-dir=") &&
          !argument.startsWith("--user-data-dir="),
      ),
      `--extensions-dir=${paths.extensions}`,
      `--user-data-dir=${paths.userData}`,
      "--install-extension",
      vsix,
      "--force",
    ],
    { cwd: repositoryRoot },
  );
}

async function runRestrictedScenario(vscodeExecutablePath, launch) {
  const args = [
    ...launch.launchArgs,
    "--no-sandbox",
    "--disable-gpu-sandbox",
    `--extensionTestsPath=${launch.extensionTestsPath}`,
    `--extensionDevelopmentPath=${launch.extensionDevelopmentPath}`,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(vscodeExecutablePath, args, {
      env: { ...process.env, ...launch.extensionTestsEnv },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Restricted VS Code exited with ${code ?? signal}.`));
    });
  });
}

async function runScenario(vscodeExecutablePath, vsix, paths) {
  await prepareWorkspace(paths);
  await installVsix(vscodeExecutablePath, vsix, paths);
  const launch = buildScenarioLaunch(paths);
  if (paths.scenario === "restricted") {
    await runRestrictedScenario(vscodeExecutablePath, launch);
  } else {
    await runTests({ ...launch, vscodeExecutablePath });
  }
}

export async function runIntegrationSuite({
  scenarios = INTEGRATION_SCENARIOS,
  keepArtifacts = process.env.FOUNDRY_E2E_KEEP_ARTIFACTS === "1",
} = {}) {
  const suiteRoot = await mkdtemp(path.join(shortRootParent(), "fse2e-"));
  const failures = [];
  try {
    const vsix = await packageOnce();
    const vscodeExecutablePath = await downloadAndUnzipVSCode({
      version: VSCODE_VERSION,
    });
    for (const scenario of scenarios) {
      if (!INTEGRATION_SCENARIOS.includes(scenario)) {
        throw new Error(`Unknown integration scenario: ${scenario}`);
      }
      const paths = createScenarioPaths(suiteRoot, scenario);
      try {
        await runBoundedCommand({
          command: process.execPath,
          args: [
            fileURLToPath(import.meta.url),
            "--scenario-worker",
            scenario,
            suiteRoot,
            vscodeExecutablePath,
            vsix,
          ],
          timeoutMs: 180_000,
          terminationGraceMs: 5_000,
        });
        if (!keepArtifacts) {
          await rm(paths.root, { recursive: true, force: true });
        }
      } catch (error) {
        failures.push({ scenario, error });
        console.error(`Scenario ${scenario} artifacts retained at ${paths.root}`);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(({ error }) => error),
        `${failures.length} Extension Host scenario(s) failed: ${failures.map(({ scenario }) => scenario).join(", ")}`,
      );
    }
  } finally {
    if (!keepArtifacts && failures.length === 0) {
      await rm(suiteRoot, { recursive: true, force: true });
    } else {
      console.log(`Extension Host artifacts: ${suiteRoot}`);
    }
  }
}

async function main() {
  if (process.argv[2] === "--scenario-worker") {
    const [, , , scenario, suiteRoot, vscodeExecutablePath, vsix] = process.argv;
    if (!scenario || !suiteRoot || !vscodeExecutablePath || !vsix) {
      throw new Error("Scenario worker arguments are incomplete.");
    }
    await runScenario(
      vscodeExecutablePath,
      vsix,
      createScenarioPaths(suiteRoot, scenario),
    );
    return;
  }
  const selected = process.env.FOUNDRY_E2E_SCENARIOS?.split(",").filter(Boolean);
  await runIntegrationSuite({
    ...(selected === undefined ? {} : { scenarios: selected }),
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      "VS Code 1.90.0 integration suite failed:",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    process.exitCode = 1;
  }
}
