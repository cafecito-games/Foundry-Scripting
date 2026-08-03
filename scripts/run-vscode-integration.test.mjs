import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    expect(child.pid).toBeTypeOf("number");
    await writeFile(
      path.join(root, "events.ndjson"),
      `${JSON.stringify({ phase: "start", pid: child.pid })}\n`,
    );

    const closed = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 2_000);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    await runner.terminateRecordedProcesses(root);
    expect(await closed).toBe(true);
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
    expect(job).toContain("actions/upload-artifact@v4");
  });
});
