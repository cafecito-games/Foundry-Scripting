import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL("./run-dap-conformance.mjs", import.meta.url),
);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function runFailure(environment) {
  try {
    await execFileAsync(process.execPath, [scriptPath], {
      cwd: path.dirname(path.dirname(scriptPath)),
      env: environment,
    });
  } catch (error) {
    return error;
  }
  throw new Error("Expected the conformance runner to fail.");
}

describe("required DAP conformance runner", () => {
  it("hard-fails when the required engine path is absent", async () => {
    const { FOUNDRY_ENGINE_PATH: _ignored, ...environment } = process.env;

    const error = await runFailure(environment);

    expect(error.stderr).toContain(
      "FOUNDRY_ENGINE_PATH is required; the real-engine suite cannot be skipped",
    );
  });

  it("rejects an engine that does not report the pinned commit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fake-foundry-"));
    temporaryDirectories.push(directory);
    const fakeEngine = path.join(directory, "foundry");
    await writeFile(fakeEngine, "#!/bin/sh\necho 0.1.dev.custom_build.deadbeef0\n");
    await chmod(fakeEngine, 0o755);

    const error = await runFailure({
      ...process.env,
      FOUNDRY_ENGINE_PATH: fakeEngine,
    });

    expect(error.stderr).toContain("requires Foundry commit e91ab07e6");
    expect(error.stderr).toContain("deadbeef0");
  });

  it("is exposed as a dedicated package command", () => {
    const require = createRequire(import.meta.url);
    const packageJson = require("../package.json");

    expect(packageJson.scripts["test:dap-conformance"]).toBe(
      "node scripts/run-dap-conformance.mjs",
    );
  });

  it("runs scene and selected-test DAP conformance as required suites", async () => {
    const runner = await readFile(scriptPath, "utf8");

    expect(runner).toContain("src/debug/conformance/live.test.ts");
    expect(runner).toContain(
      "src/debug/conformance/test-debugging-live.test.ts",
    );
    expect(runner).toContain('FOUNDRY_DAP_CONFORMANCE_REQUIRED: "1"');
    expect(runner).toContain(
      'FOUNDRY_TEST_DEBUG_CONFORMANCE_REQUIRED: "1"',
    );
  });

  it("has a required CI job that verifies the published alpha.24 engine asset", async () => {
    const workflow = await readFile(
      path.join(path.dirname(path.dirname(scriptPath)), ".github/workflows/ci.yml"),
      "utf8",
    );
    const dapJob = workflow.slice(
      workflow.indexOf("  dap-conformance:"),
      workflow.indexOf("\n  package:"),
    );

    expect(dapJob).toContain(
      "Foundry_v0.1.0-alpha.24_linux.x86_64.zip",
    );
    expect(dapJob).toContain(
      "5499f49a9aa298d97d98a025bb002c70816179e5fcf8a2104a622cfbf1e9e076",
    );
    expect(dapJob).toContain("sha256sum --check");
    expect(dapJob).toContain("foundry.linuxbsd.editor.x86_64");
    expect(dapJob).toContain("npm run test:dap-conformance");
    expect(dapJob).toContain("FOUNDRY_ENGINE_PATH:");
    expect(dapJob).not.toContain("repository: cafecito-games/Foundry");
    expect(dapJob).not.toContain("scons platform=linuxbsd");
    expect(dapJob).not.toMatch(/continue-on-error:\s*true/);
  });
});
