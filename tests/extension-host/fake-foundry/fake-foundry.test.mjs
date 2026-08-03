import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fakePath = fileURLToPath(new URL("./foundry.mjs", import.meta.url));
const temporaryDirectories = [];

async function controlDirectory(state = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "foundry-fake-test-"));
  temporaryDirectories.push(directory);
  await writeFile(
    path.join(directory, "state.json"),
    `${JSON.stringify({ mode: "normal", generation: 1, ...state })}\n`,
  );
  return directory;
}

async function spawnFake(args, control) {
  const child = spawn(fakePath, args, {
    env: { ...process.env, FOUNDRY_E2E_CONTROL: control },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return child;
}

async function output(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { stdout, stderr, code, signal };
}

async function records(control) {
  return (await readFile(path.join(control, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("fake Foundry executable", () => {
  it("writes a valid lint version-1 report for the exact CLI shape", async () => {
    const control = await controlDirectory({ lintMessage: "lint from fake" });
    const project = path.join(control, "project");
    const result = await output(
      await spawnFake(
        ["script", "lint", "--project", project, "--format=json"],
        control,
      ),
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: 1,
      diagnostics: [{ message: "lint from fake", path: "res://smoke.fs" }],
    });
    expect(await records(control)).toEqual([
      expect.objectContaining({ argv: expect.any(Array), project, phase: "start" }),
      expect.objectContaining({ project, phase: "exit", exit: 0 }),
    ]);
  });

  it("writes capabilities and discovery artifacts for exact adapter arguments", async () => {
    const control = await controlDirectory();
    const project = path.join(control, "project");
    const capabilities = path.join(control, "capabilities.json");
    const discovery = path.join(control, "discovery.jsonl");
    const prefix = [
      "--headless",
      "--no-header",
      "project",
      "test",
      "--project",
      project,
      "--runner",
      "res://tests/runner.fs",
      "--",
      "adapter",
    ];
    expect(
      (await output(await spawnFake([...prefix, "capabilities", "--output", capabilities, "--", "--seed", "7"], control))).code,
    ).toBe(0);
    expect(
      (await output(await spawnFake([...prefix, "discover", "--protocol-version", "1", "--output", discovery, "--", "--seed", "7"], control))).code,
    ).toBe(0);

    expect(JSON.parse(await readFile(capabilities, "utf8"))).toMatchObject({
      protocol: "foundry-test-adapter",
      supported_versions: [1],
    });
    const discoveryText = await readFile(discovery, "utf8");
    expect(discoveryText.endsWith("\n")).toBe(true);
    expect(discoveryText).toContain('"event":"test"');
    expect(discoveryText).toContain('"id":"test-e2e"');
  });

  it("binds loopback-only tooling sockets, speaks LSP, and exits on SIGTERM", async () => {
    const control = await controlDirectory({ lspMessage: "server diagnostic" });
    const project = path.join(control, "project");
    const child = await spawnFake(
      ["tooling", "serve", "--project", project, "--lsp-port", "0", "--dap-port", "0"],
      control,
    );
    let buffered = "";
    const readiness = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("readiness timeout")), 2_000);
      child.stdout.on("data", (chunk) => {
        buffered += chunk;
        const line = buffered.split("\n").find((candidate) => candidate.startsWith("FOUNDRY_TOOLING "));
        if (line) {
          clearTimeout(timeout);
          resolve(JSON.parse(line.slice("FOUNDRY_TOOLING ".length)));
        }
      });
    });
    expect(readiness).toMatchObject({
      project,
      pid: child.pid,
      local_only: true,
      services: expect.arrayContaining(["lsp", "dap"]),
    });
    expect(readiness.lsp_port).not.toBe(readiness.dap_port);

    const socket = net.createConnection({ host: "127.0.0.1", port: readiness.lsp_port });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    socket.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`);
    const response = await new Promise((resolve, reject) => {
      let bytes = "";
      const timeout = setTimeout(() => reject(new Error("LSP response timeout")), 2_000);
      socket.on("data", (chunk) => {
        bytes += chunk.toString();
        if (bytes.includes('"id":1')) {
          clearTimeout(timeout);
          resolve(bytes);
        }
      });
    });
    expect(response).toContain('"capabilities"');
    const initialized = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });
    socket.write(
      `Content-Length: ${Buffer.byteLength(initialized)}\r\n\r\n${initialized}`,
    );
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("initialized event timeout")),
        2_000,
      );
      const poll = async () => {
        if ((await records(control)).some((event) => event.phase === "lsp-initialized")) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(poll, 10);
        }
      };
      void poll();
    });
    socket.destroy();
    child.kill("SIGTERM");
    const result = await output(child);
    expect([0, null]).toContain(result.code);
    expect(await records(control)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "ready" }),
        expect.objectContaining({ phase: "lsp-initialized" }),
        expect.objectContaining({ phase: "signal", signal: "SIGTERM" }),
        expect.objectContaining({ phase: "exit" }),
      ]),
    );
    await expect(
      new Promise((resolve, reject) => {
        const probe = net.createConnection({ host: "127.0.0.1", port: readiness.lsp_port });
        probe.once("connect", () => resolve("connected"));
        probe.once("error", reject);
      }),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
