import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const pinnedFoundryCommit = "a2d9f6df0";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function main() {
  const enginePath = process.env.FOUNDRY_ENGINE_PATH;
  if (!enginePath) {
    fail(
      "FOUNDRY_ENGINE_PATH is required; the real-engine suite cannot be skipped or reported as passing without its pinned engine binary.",
    );
    return;
  }

  const version = spawnSync(enginePath, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (version.error) {
    fail(`Unable to execute Foundry engine at ${enginePath}: ${version.error.message}`);
    return;
  }
  const identity = `${version.stdout}${version.stderr}`.trim();
  if (version.status !== 0) {
    fail(
      `Foundry version check exited ${String(version.status)} for ${enginePath}: ${identity}`,
    );
    return;
  }
  if (!identity.includes(pinnedFoundryCommit)) {
    fail(
      `DAP conformance requires Foundry commit ${pinnedFoundryCommit}; ${enginePath} reported ${identity || "no identity"}.`,
    );
    return;
  }

  const repositoryRoot = path.dirname(
    path.dirname(fileURLToPath(import.meta.url)),
  );
  const vitestPath = path.join(
    repositoryRoot,
    "node_modules",
    "vitest",
    "vitest.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [
      vitestPath,
      "run",
      "src/debug/conformance/live.test.ts",
      "--reporter=verbose",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        FOUNDRY_DAP_CONFORMANCE_REQUIRED: "1",
        FOUNDRY_ENGINE_PATH: enginePath,
      },
      stdio: "inherit",
      timeout: 600_000,
    },
  );
  if (result.error) {
    fail(`Unable to run DAP conformance: ${result.error.message}`);
    return;
  }
  process.exitCode = result.status ?? 1;
}

main();
