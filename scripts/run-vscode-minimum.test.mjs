import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function loadRunner() {
  return import("./run-vscode-minimum.mjs").catch(() => undefined);
}

describe("minimum VS Code runner", () => {
  it("launches exact VS Code 1.90.0 from the repository root and committed fixture", async () => {
    const runner = await loadRunner();
    expect(runner).toBeDefined();
    if (runner === undefined) return;

    const runTests = vi.fn(async () => 0);
    await runner.runMinimumVSCodeSmoke({ runTests, timeoutMs: 1_000 });

    expect(runTests).toHaveBeenCalledOnce();
    expect(runTests).toHaveBeenCalledWith({
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
    });
  });

  it("propagates a failed Extension Host exit", async () => {
    const runner = await loadRunner();
    expect(runner).toBeDefined();
    if (runner === undefined) return;

    const failure = new Error("Extension Host failed");
    await expect(
      runner.runMinimumVSCodeSmoke({
        runTests: async () => Promise.reject(failure),
        timeoutMs: 1_000,
      }),
    ).rejects.toBe(failure);
  });

  it("bounds an Extension Host that never exits", async () => {
    const runner = await loadRunner();
    expect(runner).toBeDefined();
    if (runner === undefined) return;

    await expect(
      runner.runMinimumVSCodeSmoke({
        runTests: () => new Promise(() => undefined),
        timeoutMs: 1,
      }),
    ).rejects.toThrow("did not finish within 1 ms");
  });
});
