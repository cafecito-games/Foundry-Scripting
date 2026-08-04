import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runTests as defaultRunTests } from "@vscode/test-electron";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const extensionHostFlag = "--run-extension-host";

function shortProfileParent() {
  return process.platform === "win32" ? os.tmpdir() : "/tmp";
}

async function createProfileRoot() {
  return mkdtemp(path.join(shortProfileParent(), "fsvm-"));
}

export async function runMinimumVSCodeSmoke({
  runTests = defaultRunTests,
  profileRoot,
} = {}) {
  const ownsProfile = profileRoot === undefined;
  const resolvedProfileRoot = profileRoot ?? (await createProfileRoot());
  const userDataRoot = path.join(resolvedProfileRoot, "user-data");
  try {
    const userSettingsDirectory = path.join(userDataRoot, "User");
    await mkdir(userSettingsDirectory, { recursive: true });
    await writeFile(
      path.join(userSettingsDirectory, "settings.json"),
      `${JSON.stringify({ "chat.disableAIFeatures": true })}\n`,
    );
    await runTests({
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
        `--user-data-dir=${userDataRoot}`,
        `--extensions-dir=${path.join(resolvedProfileRoot, "extensions")}`,
      ],
    });
  } finally {
    if (ownsProfile) {
      await rm(resolvedProfileRoot, { recursive: true, force: true });
    }
  }
}

function signalProcessTree(child, signal) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    const taskkill = spawn("taskkill", args, { stdio: "ignore" });
    taskkill.once("error", () => child.kill(signal));
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function waitForProcessGroupExit(pid, timeoutMs) {
  if (process.platform === "win32") {
    return Promise.resolve();
  }
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") {
          resolve();
          return;
        }
        reject(error);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve();
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

export function runBoundedCommand({
  command,
  args,
  timeoutMs,
  terminationGraceMs = 1_000,
  stdio = "inherit",
}) {
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    stdio,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let forceTimer;
    const timeoutMessage = `${command} did not finish within ${String(timeoutMs)} ms.`;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onError = (error) => finish(error);
    const onClose = (code, signal) => {
      if (timedOut) {
        return;
      } else if (code === 0) {
        finish();
      } else {
        finish(
          new Error(
            `${command} exited with ${code === null ? String(signal) : `code ${String(code)}`}.`,
          ),
        );
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, "SIGTERM");
      forceTimer = setTimeout(() => {
        try {
          signalProcessTree(child, "SIGKILL");
        } catch (error) {
          finish(error);
          return;
        }
        const pid = child.pid;
        if (pid === undefined) {
          finish(new Error(timeoutMessage));
          return;
        }
        void waitForProcessGroupExit(pid, terminationGraceMs).then(
          () => finish(new Error(timeoutMessage)),
          (error) => finish(error),
        );
      }, terminationGraceMs);
    }, timeoutMs);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function runMain() {
  if (process.argv[2] === extensionHostFlag) {
    const profileRoot = process.argv[3];
    if (profileRoot === undefined) {
      throw new Error("The Extension Host worker requires a profile directory.");
    }
    await runMinimumVSCodeSmoke({ profileRoot });
    return;
  }

  const profileRoot = await createProfileRoot();
  try {
    await runBoundedCommand({
      command: process.execPath,
      args: [fileURLToPath(import.meta.url), extensionHostFlag, profileRoot],
      timeoutMs: 180_000,
    });
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  try {
    await runMain();
  } catch (error) {
    console.error(
      "VS Code 1.125.0 Extension Host smoke failed:",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    process.exitCode = 1;
  }
}
