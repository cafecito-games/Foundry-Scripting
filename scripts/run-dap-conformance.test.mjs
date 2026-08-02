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

    expect(error.stderr).toContain("requires Foundry commit 9e902f381");
    expect(error.stderr).toContain("deadbeef0");
  });

  it("is exposed as a dedicated package command", () => {
    const require = createRequire(import.meta.url);
    const packageJson = require("../package.json");

    expect(packageJson.scripts["test:dap-conformance"]).toBe(
      "node scripts/run-dap-conformance.mjs",
    );
  });

  it("has a required CI job that builds the pinned engine before running", async () => {
    const workflow = await readFile(
      path.join(path.dirname(path.dirname(scriptPath)), ".github/workflows/ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("repository: cafecito-games/Foundry");
    expect(workflow).toContain(
      "ref: 9e902f3815a62c95eec4f405b025e28b84b46b90",
    );
    expect(workflow).toContain("npm run test:dap-conformance");
    expect(workflow).toContain("FOUNDRY_ENGINE_PATH:");
    expect(workflow).not.toMatch(/dap-conformance[\s\S]*continue-on-error:\s*true/);
  });
});
