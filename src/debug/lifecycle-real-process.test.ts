import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FoundryHostLauncher, HostStartupFailure } from "../client/host-launcher.js";
import { ToolingHostCoordinator } from "../tooling/coordinator.js";
import {
  contextualizeDebugStartupFailure,
  probeLoopbackDebugAdapter,
} from "./lifecycle.js";

const enginePath = process.env.FOUNDRY_LIFECYCLE_ENGINE;
const project = process.env.FOUNDRY_LIFECYCLE_PROJECT;
const realProcess = enginePath === undefined || project === undefined
  ? describe.skip
  : describe;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processExists(pid)) {
    throw new Error(`Foundry tooling host ${String(pid)} remained alive after ${String(timeoutMs)}ms.`);
  }
}

realProcess("FoundryScript real-process lifecycle", () => {
  it("serves both endpoints and leaves no owned host after coordinator disposal", async () => {
    const diagnostics: string[] = [];
    const coordinator = new ToolingHostCoordinator({
      launcher: new FoundryHostLauncher({
        output: { appendLine: (line) => diagnostics.push(line) },
        absoluteTimeoutMs: 30_000,
      }),
    });
    const snapshot = await coordinator.start({
      mode: "spawn",
      enginePath: enginePath!,
      project: project!,
      lspPort: 0,
      dapPort: 0,
    });
    if (snapshot?.ownership !== "owned") {
      throw new Error("real Foundry tooling host was not coordinator-owned");
    }
    const probeController = new AbortController();

    await Promise.all([
      probeLoopbackDebugAdapter(snapshot.lsp, probeController.signal, 2_000),
      probeLoopbackDebugAdapter(snapshot.dap, probeController.signal, 2_000),
    ]);
    expect(processExists(snapshot.pid)).toBe(true);

    await coordinator.dispose();
    await waitForProcessExit(snapshot.pid, 5_000);
    expect(coordinator.state).toEqual({ kind: "idle" });
    expect(diagnostics.some((line) => line.includes("lsp.host.ready"))).toBe(true);
  }, 40_000);

  it("reaps the child and captures diagnostics when startup fails before readiness", async () => {
    let childPid: number | undefined;
    const diagnostics: string[] = [];
    const launcher = new FoundryHostLauncher({
      spawnProcess: (command, args, options) => {
        const child = spawn(command, args, options);
        childPid = child.pid;
        return child;
      },
      output: { appendLine: (line) => diagnostics.push(line) },
      absoluteTimeoutMs: 15_000,
    });

    const missingProject = join(project!, "missing-lifecycle-project");
    const failure = await launcher.launch({
      enginePath: enginePath!,
      project: missingProject,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HostStartupFailure);
    expect(failure).toMatchObject({
      kind: "readiness_timeout",
      timeoutReason: "absolute",
      timeoutMs: 15_000,
    });
    const contextual = contextualizeDebugStartupFailure(
      "spawn",
      missingProject,
      failure,
    );
    expect(contextual.message).toMatch(
      /spawn mode.*missing-lifecycle-project.*foundryScript\.lsp\.mode.*retry/i,
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((line) => line.includes("lsp.host.timeout"))).toBe(true);
    if (childPid === undefined) {
      throw new Error("real Foundry child did not expose a pid");
    }
    await waitForProcessExit(childPid, 5_000);
  }, 25_000);
});
