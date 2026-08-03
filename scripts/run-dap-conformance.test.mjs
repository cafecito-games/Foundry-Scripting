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

    expect(error.stderr).toContain("requires Foundry commit c11e3a080");
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

  it("has a required CI job that builds the pinned engine before running", async () => {
    const workflow = await readFile(
      path.join(path.dirname(path.dirname(scriptPath)), ".github/workflows/ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("repository: cafecito-games/Foundry");
    expect(workflow).toContain(
      "ref: c11e3a080959af4ca8fbdd9b1a3d97a889b351b4",
    );
    expect(workflow).toContain(
      "key: dap-conformance-foundry-c11e3a080-${{ runner.os }}-${{ runner.arch }}",
    );
    expect(workflow).toContain("npm run test:dap-conformance");
    expect(workflow).toContain("FOUNDRY_ENGINE_PATH:");
    expect(workflow).not.toMatch(/dap-conformance[\s\S]*continue-on-error:\s*true/);
  });
});
