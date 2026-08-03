#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

const control = process.env.FOUNDRY_E2E_CONTROL;
if (!control) {
  console.error("FOUNDRY_E2E_CONTROL is required.");
  process.exit(64);
}

const argv = process.argv.slice(2);
const invocationId = randomUUID();
const project = option("--project") ?? process.cwd();
const eventsPath = path.join(control, "events.ndjson");

function option(name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function state() {
  try {
    return JSON.parse(readFileSync(path.join(control, "state.json"), "utf8"));
  } catch {
    return { mode: "normal", generation: 1 };
  }
}

function record(phase, extra = {}) {
  appendFileSync(
    eventsPath,
    `${JSON.stringify({
      invocationId,
      pid: process.pid,
      argv,
      project,
      phase,
      ...extra,
    })}\n`,
  );
}

function finish(exit = 0) {
  record("exit", { exit });
  process.exit(exit);
}

function writeJson(pathname, value) {
  writeFileSync(pathname, `${JSON.stringify(value)}\n`);
}

function lint() {
  const configuration = state();
  const message = configuration.lintMessage ?? `CLI diagnostic generation ${configuration.generation ?? 1}`;
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      diagnostics: [
        {
          message,
          path: "res://smoke.fs",
          range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 },
          ruleId: "e2e-lint",
          severity: "warning",
          source: "foundry-e2e-cli",
        },
      ],
    })}\n`,
  );
  finish();
}

function adapter() {
  const output = option("--output");
  if (!output) finish(64);
  const adapterIndex = argv.indexOf("adapter");
  const operation = argv[adapterIndex + 1];
  if (operation === "capabilities") {
    writeJson(output, {
      protocol: "foundry-test-adapter",
      supported_versions: [1],
      framework: { id: "foundry-e2e", name: "Foundry E2E", version: "1.0.0" },
      extensions: [],
    });
  } else if (operation === "discover") {
    const records = [
      { protocol: "foundry-test-adapter", version: 1, event: "discovery_start", root: "res://tests" },
      {
        protocol: "foundry-test-adapter",
        version: 1,
        event: "suite",
        id: "suite-e2e",
        label: "E2E Suite",
        parent_id: null,
        path: "res://smoke.fs",
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
        runnable: true,
        skipped: false,
        skip_reason: null,
      },
      {
        protocol: "foundry-test-adapter",
        version: 1,
        event: "test",
        id: "test-e2e",
        label: "discovers through Extension Host",
        parent_id: "suite-e2e",
        path: "res://smoke.fs",
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
        runnable: true,
        skipped: false,
        skip_reason: null,
        case_key: null,
      },
      { protocol: "foundry-test-adapter", version: 1, event: "discovery_end", suite_count: 1, test_count: 1, error_count: 0 },
    ];
    writeFileSync(output, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  } else {
    finish(64);
  }
  finish();
}

function frame(message) {
  const payload = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function createLspServer(configuration) {
  return net.createServer((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      while (true) {
        const headerEnd = bytes.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = bytes.subarray(0, headerEnd).toString("ascii");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) return socket.destroy();
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (bytes.length < bodyStart + length) return;
        const message = JSON.parse(bytes.subarray(bodyStart, bodyStart + length).toString("utf8"));
        bytes = bytes.subarray(bodyStart + length);
        if (message.method === "initialize") {
          socket.write(
            frame({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                capabilities: { textDocumentSync: 1 },
                serverInfo: { name: "foundry-e2e", version: "1.0.0" },
              },
            }),
          );
        } else if (message.method === "initialized") {
          socket.write(frame({ jsonrpc: "2.0", method: "foundry_script/capabilities", params: { native_classes: [] } }));
          if (configuration.mode === "clean-disconnect") socket.end();
        } else if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
          const uri = message.params?.textDocument?.uri;
          if (uri) {
            socket.write(
              frame({
                jsonrpc: "2.0",
                method: "textDocument/publishDiagnostics",
                params: {
                  uri,
                  diagnostics: [
                    {
                      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
                      severity: 1,
                      source: "foundry-e2e-lsp",
                      message: configuration.lspMessage ?? `LSP diagnostic generation ${configuration.generation ?? 1}`,
                    },
                  ],
                },
              }),
            );
          }
        } else if (message.method === "shutdown") {
          socket.write(frame({ jsonrpc: "2.0", id: message.id, result: null }));
        } else if (message.method === "exit") {
          socket.end();
        } else if (message.id !== undefined) {
          socket.write(frame({ jsonrpc: "2.0", id: message.id, result: null }));
        }
      }
    });
  });
}

async function tooling() {
  const configuration = state();
  if (configuration.mode === "never-ready") {
    const keepAlive = setInterval(() => undefined, 1_000);
    const stop = (signal) => {
      clearInterval(keepAlive);
      record("signal", { signal });
      finish();
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
    return;
  }
  const lsp = createLspServer(configuration);
  const dap = net.createServer((socket) => socket.destroy());
  const [lspPort, dapPort] = await Promise.all([listen(lsp), listen(dap)]);
  record("ready", { lspPort, dapPort, localOnly: true });
  process.stdout.write(
    `FOUNDRY_TOOLING ${JSON.stringify({
      project,
      pid: process.pid,
      local_only: true,
      services: ["lsp", "dap"],
      lsp_port: lspPort,
      dap_port: dapPort,
    })}\n`,
  );
  const stop = (signal) => {
    record("signal", { signal });
    let remaining = 2;
    const closed = () => {
      remaining -= 1;
      if (remaining === 0) finish();
    };
    lsp.close(closed);
    dap.close(closed);
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

record("start");
if (argv[0] === "script" && argv[1] === "lint" && argv.includes("--format=json")) {
  lint();
} else if (argv.includes("adapter")) {
  adapter();
} else if (argv[0] === "tooling" && argv[1] === "serve") {
  await tooling();
} else {
  console.error(`Unsupported fake Foundry invocation: ${argv.join(" ")}`);
  finish(64);
}
