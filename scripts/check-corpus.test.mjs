import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
