import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./check-corpus.mjs", import.meta.url));
const temporaryDirectories = [];

function commandEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.CI;
  delete environment.FOUNDRY_ENGINE_PATH;
  return { ...environment, ...overrides };
}

async function runCorpus(overrides = {}) {
  return execFileAsync(process.execPath, [scriptPath], {
    env: commandEnvironment(overrides),
  });
}

async function runFailure(overrides = {}) {
  try {
    await runCorpus(overrides);
  } catch (error) {
    return error;
  }
  throw new Error("Expected corpus check to fail");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("corpus command configuration", () => {
  it("skips explicitly outside CI when no engine path is configured", async () => {
    const result = await runCorpus();

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("FOUNDRY_ENGINE_PATH is not set");
    expect(result.stdout).toContain("skipping the corpus check");
  });

  it("fails in CI when no engine path is configured", async () => {
    const error = await runFailure({ CI: "true" });

    expect(error.stderr).toContain(
      "CI corpus check requires FOUNDRY_ENGINE_PATH",
    );
  });

  it("fails when a configured corpus contains no FoundryScript files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "foundry-empty-corpus-"));
    temporaryDirectories.push(directory);

    const error = await runFailure({ FOUNDRY_ENGINE_PATH: directory });

    expect(error.stdout).toContain("Scanned 0 .fs files.");
    expect(error.stderr).toContain(
      "Corpus check requires at least one .fs file",
    );
  });
});

describe("corpus CI configuration", () => {
  it("checks out the engine release commit and passes its workspace path", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("repository: cafecito-games/Foundry");
    expect(workflow).toContain(
      "ref: 7a86a1464be0699c81a8a5b5c849447b4a7707bf",
    );
    expect(workflow).toContain("path: foundry-engine");
    expect(workflow).toContain(
      "FOUNDRY_ENGINE_PATH: ${{ github.workspace }}/foundry-engine",
    );
  });
});
