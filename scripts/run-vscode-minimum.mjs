import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runTests as defaultRunTests } from "@vscode/test-electron";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function runMinimumVSCodeSmoke({
  runTests = defaultRunTests,
  timeoutMs = 180_000,
} = {}) {
  let timeout;
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `VS Code 1.90.0 Extension Host smoke did not finish within ${String(timeoutMs)} ms.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    await Promise.race([
      runTests({
        version: "1.90.0",
        extensionDevelopmentPath: repositoryRoot,
        extensionTestsPath: path.join(
          repositoryRoot,
          "tests/vscode-minimum/suite/index.cjs",
        ),
        launchArgs: [
          path.join(repositoryRoot, "tests/vscode-minimum/fixture"),
          "--disable-extensions",
          "--disable-updates",
          "--disable-workspace-trust",
        ],
      }),
      timedOut,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  try {
    await runMinimumVSCodeSmoke();
  } catch (error) {
    console.error(
      "VS Code 1.90.0 Extension Host smoke failed:",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    process.exitCode = 1;
  }
}
