import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const expectedScenarios = [
  "language-tasks",
  "test-explorer",
  "diagnostics",
  "reconfiguration",
  "cold-start-failure",
  "pending-start-shutdown",
  "normal-shutdown",
  "restricted",
  "virtual-workspace",
];
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("packaged VS Code integration runner contract", () => {
  it("pins the complete order-independent scenario inventory to VS Code 1.90.0", async () => {
    const runner = await import("./run-vscode-integration.mjs").catch(
      () => undefined,
    );

    expect(runner).toBeDefined();
    expect(runner?.VSCODE_VERSION).toBe("1.90.0");
    expect(runner?.INTEGRATION_SCENARIOS).toEqual(expectedScenarios);
    expect([...runner.INTEGRATION_SCENARIOS].reverse()).toEqual(
      [...expectedScenarios].reverse(),
    );
  });

  it("declares isolated profile, workspace, control, and log roots", async () => {
    const runner = await import("./run-vscode-integration.mjs").catch(
      () => undefined,
    );
    expect(runner?.createScenarioPaths).toBeTypeOf("function");
    if (runner?.createScenarioPaths === undefined) return;

    const first = runner.createScenarioPaths("/tmp/fs-e2e-a", "diagnostics");
    const second = runner.createScenarioPaths("/tmp/fs-e2e-b", "diagnostics");
    for (const key of [
      "userData",
      "extensions",
      "workspace",
      "control",
      "logs",
    ]) {
      expect(first[key]).not.toBe(second[key]);
      expect(first[key]).toContain("diagnostics");
    }
  });

  it("runs a packaged product with only the driver as a development extension", async () => {
    const runner = await import("./run-vscode-integration.mjs").catch(
      () => undefined,
    );
    expect(runner?.buildScenarioLaunch).toBeTypeOf("function");
    if (runner?.buildScenarioLaunch === undefined) return;

    const launch = runner.buildScenarioLaunch({
      scenario: "language-tasks",
      workspace: "/tmp/fs-e2e/language-tasks/workspace",
      userData: "/tmp/fs-e2e/language-tasks/user-data",
      extensions: "/tmp/fs-e2e/language-tasks/extensions",
      control: "/tmp/fs-e2e/language-tasks/control",
      logs: "/tmp/fs-e2e/language-tasks/logs",
    });
    expect(launch.version).toBe("1.90.0");
    expect(launch.extensionDevelopmentPath).toBe(
      path.join(repositoryRoot, "tests/extension-host/driver"),
    );
    expect(launch.extensionTestsPath).toBe(
      path.join(repositoryRoot, "tests/extension-host/driver/index.cjs"),
    );
    expect(launch.extensionDevelopmentPath).not.toBe(repositoryRoot);
    expect(launch.launchArgs).toEqual(
      expect.arrayContaining([
        "--disable-updates",
        "--skip-welcome",
        "--skip-release-notes",
        "--user-data-dir=/tmp/fs-e2e/language-tasks/user-data",
        "--extensions-dir=/tmp/fs-e2e/language-tasks/extensions",
        "--logsPath=/tmp/fs-e2e/language-tasks/logs",
      ]),
    );
    expect(launch.extensionTestsEnv).toMatchObject({
      FOUNDRY_E2E_SCENARIO: "language-tasks",
      FOUNDRY_E2E_CONTROL: "/tmp/fs-e2e/language-tasks/control",
    });
  });

  it("preserves genuine Restricted Mode and supplies only the virtual provider when required", async () => {
    const runner = await import("./run-vscode-integration.mjs");
    const base = {
      workspace: "/tmp/fs-e2e/workspace",
      userData: "/tmp/fs-e2e/user-data",
      extensions: "/tmp/fs-e2e/extensions",
      control: "/tmp/fs-e2e/control",
      logs: "/tmp/fs-e2e/logs",
    };
    const restricted = runner.buildScenarioLaunch({
      ...base,
      scenario: "restricted",
    });
    expect(restricted.launchArgs).not.toContain("--disable-workspace-trust");

    const virtual = runner.buildScenarioLaunch({
      ...base,
      scenario: "virtual-workspace",
    });
    expect(virtual.extensionDevelopmentPath).toEqual([
      path.join(repositoryRoot, "tests/extension-host/driver"),
      path.join(repositoryRoot, "tests/extension-host/virtual-provider"),
    ]);
    expect(virtual.launchArgs[0]).toBe(
      "--folder-uri=foundry-e2e:/tmp/fs-e2e/workspace",
    );
  });

  it("terminates recorded fake processes during failure cleanup", async () => {
    const runner = await import("./run-vscode-integration.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "fse2e-contract-"));
    temporaryDirectories.push(root);
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    expect(child.pid).toBeTypeOf("number");
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
    });
    const adapterDirectory = await mkdtemp(
      path.join(os.tmpdir(), "foundryscript-test-adapter-"),
    );
    temporaryDirectories.push(adapterDirectory);
    const artifact = path.join(adapterDirectory, "capabilities.json");
    await writeFile(artifact, "{}\n");
    await writeFile(
      path.join(root, "events.ndjson"),
      `${JSON.stringify({
        phase: "start",
        pid: child.pid,
        argv: ["adapter", "capabilities", "--output", artifact],
      })}\n`,
    );

    const closed = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 2_000);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    await runner.terminateRecordedProcesses(root, { terminationGraceMs: 100 });
    expect(await closed).toBe(true);
    await expect(access(adapterDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails postchecks on arbitrary Extension Host errors", async () => {
    const runner = await import("./run-vscode-integration.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "fse2e-contract-"));
    temporaryDirectories.push(root);
    const paths = runner.createScenarioPaths(root, "language-tasks");
    const extensionHostLogs = path.join(paths.logs, "window1", "exthost");
    await Promise.all([
      mkdir(paths.control, { recursive: true }),
      mkdir(paths.workspace, { recursive: true }),
      mkdir(extensionHostLogs, { recursive: true }),
    ]);
    await writeFile(
      path.join(extensionHostLogs, "exthost.log"),
      "2026-08-03 [error] arbitrary extension failure\n",
    );
    await writeFile(path.join(paths.logs, "vscode-stderr.log"), "");

    await expect(runner.assertPostScenario(paths)).rejects.toThrow(
      "asynchronous Extension Host failures",
    );
  });

  it("rejects unexpected captured stderr while allowing virtual-provider startup noise", async () => {
    const runner = await import("./run-vscode-integration.mjs");
    expect(
      runner.unexpectedVSCodeStderrLines(
        "Ignoring the error while validating workspace folder foundry-e2e:/project - ENOPRO\n" +
          "No search provider registered for scheme: foundry-e2e, waiting\n" +
          "[main] Blocked vscode-file request vscode-file://workerMain.js\n",
      ),
    ).toEqual([]);
    expect(
      runner.unexpectedVSCodeStderrLines("arbitrary extension stderr\n"),
    ).toEqual(["arbitrary extension stderr"]);
  });

  it("allows exact VS Code Electron Linux headless stderr", async () => {
    const runner = await import("./run-vscode-integration.mjs");
    expect(
      runner.unexpectedVSCodeStderrLines(
        '[2433:0803/234809.391641:ERROR:bus.cc(407)] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")\n' +
          "[2457:0803/234809.503860:ERROR:viz_main_impl.cc(196)] Exiting GPU process due to errors during initialization\n" +
          "[2513:0803/234809.902556:ERROR:command_buffer_proxy_impl.cc(131)] ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer.\n",
      ),
    ).toEqual([]);
  });

  it("rejects near-miss and arbitrary application stderr", async () => {
    const runner = await import("./run-vscode-integration.mjs");
    const stderr =
      "[2433:0803/234809.391641:ERROR:bus.cc(407)] Failed to connect to the bus: Permission denied\n" +
      "[2457:0803/234809.503860:ERROR:viz_main_impl.cc(196)] GPU process crashed unexpectedly\n" +
      "[2513:0803/234809.902556:ERROR:command_buffer_proxy_impl.cc(131)] ContextResult::kFatalFailure: Failed to send GpuControl.CreateCommandBuffer.\n" +
      "arbitrary extension D-Bus failure\n";

    expect(runner.unexpectedVSCodeStderrLines(stderr)).toEqual([
      "[2433:0803/234809.391641:ERROR:bus.cc(407)] Failed to connect to the bus: Permission denied",
      "[2457:0803/234809.503860:ERROR:viz_main_impl.cc(196)] GPU process crashed unexpectedly",
      "[2513:0803/234809.902556:ERROR:command_buffer_proxy_impl.cc(131)] ContextResult::kFatalFailure: Failed to send GpuControl.CreateCommandBuffer.",
      "arbitrary extension D-Bus failure",
    ]);
  });

  it("retains scenario logs when an isolated worker fails", async () => {
    const runner = await import("./run-vscode-integration.mjs");
    let suiteRoot;
    await expect(
      runner.runIntegrationSuite({
        scenarios: ["language-tasks"],
        keepArtifacts: false,
        packageSuite: async () => "/tmp/fake.vsix",
        downloadVSCode: async () => "/tmp/fake-code",
        runScenarioCommand: async ({ args }) => {
          suiteRoot = args[3];
          const logs = path.join(suiteRoot, "language-tasks", "logs");
          await mkdir(logs, { recursive: true });
          await writeFile(path.join(logs, "failure.log"), "retained\n");
          throw new Error("intentional worker failure");
        },
      }),
    ).rejects.toThrow("1 Extension Host scenario(s) failed");
    expect(suiteRoot).toBeTypeOf("string");
    temporaryDirectories.push(suiteRoot);
    await expect(
      readFile(
        path.join(suiteRoot, "language-tasks", "logs", "failure.log"),
        "utf8",
      ),
    ).resolves.toBe("retained\n");
  });

  it("exposes the suite and a required bounded CI job", async () => {
    const [manifestText, workflow] = await Promise.all([
      readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      readFile(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText);
    expect(manifest.scripts["test:vscode-integration"]).toBe(
      "node scripts/run-vscode-integration.mjs",
    );
    const job = workflow.slice(workflow.indexOf("  vscode-integration:"));
    expect(job).toContain("runs-on: ubuntu-22.04");
    expect(job).toContain("timeout-minutes:");
    expect(job).toContain('node-version: "20.9.0"');
    expect(job).toContain("xvfb-run -a npm run test:vscode-integration");
    expect(job).toContain("actions/upload-artifact@v7");
  });
});
