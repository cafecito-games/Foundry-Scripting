import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
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
  it("launches exact VS Code 1.125.0 from the repository root and committed fixture", async () => {
    const runner = await loadRunner();
    expect(runner).toBeDefined();
    if (runner === undefined) return;

    const runTests = vi.fn(async () => 0);
    const profileRoot = await mkdtemp(
      path.join(os.tmpdir(), "foundryscript-vscode-minimum-profile-"),
    );
    try {
      await runner.runMinimumVSCodeSmoke({
        runTests,
        timeoutMs: 1_000,
        profileRoot,
      });

      expect(runTests).toHaveBeenCalledOnce();
      expect(runTests).toHaveBeenCalledWith({
        version: "1.125.0",
        extensionDevelopmentPath: repositoryRoot,
        extensionTestsPath: path.join(
          repositoryRoot,
          "tests/vscode-minimum/suite/index.cjs",
        ),
        extensionTestsEnv: { NODE_OPTIONS: "" },
        launchArgs: [
          path.join(repositoryRoot, "tests/vscode-minimum/fixture"),
          "--disable-extensions",
          "--disable-updates",
          "--disable-workspace-trust",
          `--user-data-dir=${path.join(profileRoot, "user-data")}`,
          `--extensions-dir=${path.join(profileRoot, "extensions")}`,
        ],
      });
      await expect(
        readFile(
          path.join(profileRoot, "user-data/User/settings.json"),
          "utf8",
        ),
      ).resolves.toBe('{"chat.disableAIFeatures":true}\n');
    } finally {
      await rm(profileRoot, { recursive: true, force: true });
    }
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

  it.runIf(process.platform !== "win32")(
    "keeps the VS Code IPC socket below the Unix-domain path limit",
    async () => {
      const runner = await loadRunner();
      expect(runner).toBeDefined();
      if (runner === undefined) return;

      const runTests = vi.fn(async () => 0);
      await runner.runMinimumVSCodeSmoke({ runTests, timeoutMs: 1_000 });

      const options = runTests.mock.calls[0]?.[0];
      const userDataArgument = options?.launchArgs.find((argument) =>
        argument.startsWith("--user-data-dir="),
      );
      expect(userDataArgument).toBeDefined();
      if (userDataArgument === undefined) return;
      const userDataPath = userDataArgument.slice("--user-data-dir=".length);
      expect(
        path.join(userDataPath, "1.125-main.sock").length,
      ).toBeLessThanOrEqual(103);
    },
  );

  it("terminates a real child process that never exits", async () => {
    const runner = await loadRunner();
    expect(runner).toBeDefined();
    if (runner === undefined) return;

    expect(runner.runBoundedCommand).toBeTypeOf("function");
    if (runner.runBoundedCommand === undefined) return;
    const startedAt = Date.now();
    await expect(
      runner.runBoundedCommand({
        command: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1_000)"],
        timeoutMs: 25,
        terminationGraceMs: 100,
        stdio: "ignore",
      }),
    ).rejects.toThrow("did not finish within 25 ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.runIf(process.platform !== "win32")(
    "force-kills a SIGTERM-resistant descendant before returning",
    async () => {
      const runner = await loadRunner();
      expect(runner?.runBoundedCommand).toBeTypeOf("function");
      if (runner?.runBoundedCommand === undefined) return;

      const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "foundryscript-runner-test-"),
      );
      const pidFile = path.join(temporaryDirectory, "grandchild.pid");
      let grandchildPid;
      try {
        const leader = [
          'const { spawn } = require("node:child_process");',
          'const { writeFileSync } = require("node:fs");',
          "const child = spawn(process.execPath, [\"-e\", \"process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1_000)\"], { stdio: 'ignore' });",
          "writeFileSync(process.argv[1], String(child.pid));",
          "setInterval(() => undefined, 1_000);",
        ].join(" ");
        await expect(
          runner.runBoundedCommand({
            command: process.execPath,
            args: ["-e", leader, pidFile],
            timeoutMs: 200,
            terminationGraceMs: 100,
            stdio: "ignore",
          }),
        ).rejects.toThrow("did not finish within 200 ms");

        grandchildPid = Number(await readFile(pidFile, "utf8"));
        expect(() => process.kill(grandchildPid, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        if (Number.isInteger(grandchildPid)) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch (error) {
            if (error?.code !== "ESRCH") throw error;
          }
        }
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );
});
