import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
      ]),
    );
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
