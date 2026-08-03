import { execFile, spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
      ? `--folder-uri=foundry-e2e:${paths.workspace}`
      : paths.scenario === "reconfiguration"
        ? path.join(paths.workspace, "e2e.code-workspace")
      : paths.workspace;
  const launchArgs = [
    workspaceTarget,
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-telemetry",
    `--logsPath=${paths.logs}`,
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
      FOUNDRY_E2E_VIRTUAL_URI: `foundry-e2e:${paths.workspace}`,
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
  if (paths.scenario !== "virtual-workspace") {
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
        paths.scenario === "restricted",
      "foundryScript.testing.runner": "res://tests/runner.fs",
      "foundryScript.testing.args": [],
    };
    await writeFile(
      path.join(settingsDirectory, "settings.json"),
      `${JSON.stringify(settings, null, 2)}\n`,
    );
    if (paths.scenario === "reconfiguration") {
      await writeFile(
        path.join(paths.workspace, "e2e.code-workspace"),
        `${JSON.stringify(
          {
            folders: [{ path: "first" }, { path: "second" }],
            settings,
          },
          null,
          2,
        )}\n`,
      );
    }
  }
  if (paths.scenario === "restricted") {
    const userSettingsDirectory = path.join(paths.userData, "User");
    await mkdir(userSettingsDirectory, { recursive: true });
    await writeFile(
      path.join(userSettingsDirectory, "settings.json"),
      `${JSON.stringify({
        "security.workspace.trust.enabled": true,
        "security.workspace.trust.startupPrompt": "never",
        "security.workspace.trust.banner": "never",
      })}\n`,
    );
  }
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
  if (process.env.FOUNDRY_E2E_VSIX !== undefined) {
    const suppliedVsix = path.resolve(process.env.FOUNDRY_E2E_VSIX);
    await access(suppliedVsix);
    return suppliedVsix;
  }
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

async function runVSCodeScenario(vscodeExecutablePath, launch, paths) {
  const developmentPaths = Array.isArray(launch.extensionDevelopmentPath)
    ? launch.extensionDevelopmentPath
    : [launch.extensionDevelopmentPath];
  const args = [
    ...launch.launchArgs,
    "--no-sandbox",
    "--disable-gpu-sandbox",
    `--extensionTestsPath=${launch.extensionTestsPath}`,
    ...developmentPaths.map(
      (developmentPath) => `--extensionDevelopmentPath=${developmentPath}`,
    ),
  ];
  const { stdout, stderr, code, signal } = await new Promise((resolve, reject) => {
    const child = spawn(vscodeExecutablePath, args, {
      env: { ...process.env, ...launch.extensionTestsEnv },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ stdout, stderr, code, signal });
    });
  });
  await Promise.all([
    writeFile(path.join(paths.logs, "vscode-stdout.log"), stdout),
    writeFile(path.join(paths.logs, "vscode-stderr.log"), stderr),
  ]);
  if (code !== 0) {
    throw new Error(`VS Code exited with ${code ?? signal}.\n${stderr}`);
  }
}

async function runScenario(vscodeExecutablePath, vsix, paths) {
  await prepareWorkspace(paths);
  await installVsix(vscodeExecutablePath, vsix, paths);
  const launch = buildScenarioLaunch(paths);
  await runVSCodeScenario(vscodeExecutablePath, launch, paths);
  await assertPostScenario(paths);
}

async function readEvents(control) {
  try {
    return (await readFile(path.join(control, "events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function assertPostScenario(paths) {
  const events = await readEvents(paths.control);
  if (
    [
      "language-tasks",
      "restricted",
      "virtual-workspace",
      "cold-start-failure",
    ].includes(paths.scenario)
  ) {
    if (events.length !== 0) {
      throw new Error(`${paths.scenario} unexpectedly invoked fake Foundry.`);
    }
  }
  const starts = events.filter((event) => event.phase === "start");
  for (const start of starts) {
    if (
      !events.some(
        (event) =>
          event.invocationId === start.invocationId && event.phase === "exit",
      )
    ) {
      throw new Error(
        `${paths.scenario} left invocation ${start.invocationId} unsettled.`,
      );
    }
    if (isProcessAlive(start.pid)) {
      throw new Error(`${paths.scenario} left PID ${start.pid} alive.`);
    }
  }
  const artifactPaths = starts
    .map((event) => {
      const outputIndex = event.argv.indexOf("--output");
      return outputIndex < 0 ? undefined : event.argv[outputIndex + 1];
    })
    .filter((value) => typeof value === "string");
  for (const artifact of artifactPaths) {
    try {
      await access(path.dirname(artifact));
      throw new Error(
        `${paths.scenario} retained adapter directory ${path.dirname(artifact)}.`,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (paths.scenario === "pending-start-shutdown") {
    const toolingStarts = starts.filter((event) =>
      event.argv[0] === "tooling" && event.argv[1] === "serve",
    );
    if (
      toolingStarts.length !== 1 ||
      !events.some(
        (event) =>
          event.invocationId === toolingStarts[0].invocationId &&
          event.phase === "signal" &&
          event.signal === "SIGTERM",
      )
    ) {
      throw new Error(
        "pending-start-shutdown did not terminate its never-ready host with SIGTERM.",
      );
    }
  }
  if (paths.scenario === "virtual-workspace") {
    const localEntries = await readdir(paths.workspace);
    if (localEntries.length !== 0) {
      throw new Error(
        `virtual-workspace unexpectedly exposed local fixture entries: ${localEntries.join(", ")}`,
      );
    }
  }
  await assertCleanExtensionHostLogs(paths);
}

async function assertCleanExtensionHostLogs(paths) {
  const files = await listFiles(paths.logs);
  const failures = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const normalizedFile = file.replaceAll("\\", "/");
    const markers = [
      "rejected promise not handled",
      "UnhandledPromiseRejection",
      "unhandled rejection",
      "Channel has been closed",
    ];
    if (
      normalizedFile.endsWith("/exthost/exthost.log") ||
      normalizedFile.endsWith("/renderer.log")
    ) {
      markers.push("[error]");
    }
    for (const marker of markers) {
      if (content.includes(marker)) failures.push(`${file}: ${marker}`);
    }
  }
  const stderrPath = path.join(paths.logs, "vscode-stderr.log");
  const stderr = await readFile(stderrPath, "utf8");
  failures.push(
    ...unexpectedVSCodeStderrLines(stderr).map(
      (line) => `${stderrPath}: unexpected stderr: ${line}`,
    ),
  );
  if (failures.length > 0) {
    throw new Error(
      `${paths.scenario} logged asynchronous Extension Host failures:\n${failures.join("\n")}`,
    );
  }
}

export function unexpectedVSCodeStderrLines(stderr) {
  const allowed = [
    /^Ignoring the error while validating workspace folder foundry-e2e:/,
    /^No search provider registered for scheme: foundry-e2e, waiting$/,
    /^Failed to fetch chat participant registry\b/,
    /Blocked vscode-file request\b/,
    /^\[\d+:\d{4}\/\d{6}\.\d{6}:ERROR:bus\.cc\(407\)\] Failed to connect to the bus: Could not parse server address: Unknown address type \(examples of valid types are "tcp" and on UNIX "unix"\)$/,
    /^\[\d+:\d{4}\/\d{6}\.\d{6}:ERROR:viz_main_impl\.cc\(196\)\] Exiting GPU process due to errors during initialization$/,
    /^\[\d+:\d{4}\/\d{6}\.\d{6}:ERROR:command_buffer_proxy_impl\.cc\(131\)\] ContextResult::kTransientFailure: Failed to send GpuControl\.CreateCommandBuffer\.$/,
  ];
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) => line !== "" && !allowed.some((pattern) => pattern.test(line)),
    );
}

async function listFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(candidate)));
    else if (entry.isFile() && candidate.endsWith(".log")) files.push(candidate);
  }
  return files;
}

export async function terminateRecordedProcesses(
  control,
  { terminationGraceMs = 2_000 } = {},
) {
  const starts = (await readEvents(control)).filter(
    (event) => event.phase === "start" && Number.isSafeInteger(event.pid),
  );
  const live = [...new Set(starts.map((event) => event.pid))].filter(
    isProcessAlive,
  );
  for (const pid of live) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + terminationGraceMs;
  let remaining = live.filter(isProcessAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    remaining = remaining.filter(isProcessAlive);
  }
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const forceDeadline = Date.now() + terminationGraceMs;
  remaining = remaining.filter(isProcessAlive);
  while (remaining.length > 0 && Date.now() < forceDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    remaining = remaining.filter(isProcessAlive);
  }
  if (remaining.length > 0) {
    throw new Error(
      `Failure cleanup left fake Foundry PIDs alive: ${remaining.join(", ")}.`,
    );
  }
  const adapterDirectories = starts
    .map((event) => {
      const outputIndex = event.argv?.indexOf("--output") ?? -1;
      if (outputIndex < 0) return undefined;
      const output = event.argv[outputIndex + 1];
      if (typeof output !== "string") return undefined;
      const directory = path.dirname(output);
      const basename = path.basename(directory);
      return basename.startsWith("foundryscript-test-adapter-") ||
        basename.startsWith("foundryscript-test-discovery-")
        ? directory
        : undefined;
    })
    .filter((directory) => typeof directory === "string");
  await Promise.all(
    [...new Set(adapterDirectories)].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
}

export async function runIntegrationSuite({
  scenarios = INTEGRATION_SCENARIOS,
  keepArtifacts = process.env.FOUNDRY_E2E_KEEP_ARTIFACTS === "1",
  packageSuite = packageOnce,
  downloadVSCode = () =>
    downloadAndUnzipVSCode({ version: VSCODE_VERSION }),
  runScenarioCommand = runBoundedCommand,
} = {}) {
  const suiteRoot = await mkdtemp(path.join(shortRootParent(), "fse2e-"));
  const failures = [];
  try {
    const vsix = await packageSuite();
    const vscodeExecutablePath = await downloadVSCode();
    for (const scenario of scenarios) {
      if (!INTEGRATION_SCENARIOS.includes(scenario)) {
        throw new Error(`Unknown integration scenario: ${scenario}`);
      }
      const paths = createScenarioPaths(suiteRoot, scenario);
      try {
        await runScenarioCommand({
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
        let failure = error;
        try {
          await terminateRecordedProcesses(paths.control);
        } catch (cleanupError) {
          failure = new AggregateError(
            [error, cleanupError],
            `${scenario} failed and process cleanup also failed.`,
          );
        }
        failures.push({ scenario, error: failure });
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
