import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const values = parseArguments(process.argv.slice(2));
const directory = await mkdtemp(
  path.join(os.tmpdir(), "foundryscript-live-verifier-"),
);
try {
  const output = path.join(directory, "verifier.cjs");
  await build({
    entryPoints: [
      path.join(process.cwd(), "src", "testing", "live-verifier.ts"),
    ],
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    logLevel: "silent",
  });
  const module = await import(pathToFileURL(output).href);
  const verify =
    module.verifyLiveFoundryTestRun ??
    module.default?.verifyLiveFoundryTestRun;
  if (typeof verify !== "function") {
    throw new Error("The bundled live verifier has no executable export.");
  }
  const result = await verify(values);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function parseArguments(arguments_) {
  const allowed = new Set(["foundry", "project", "runner", "path"]);
  const parsed = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (
      typeof option !== "string" ||
      !option.startsWith("--") ||
      !allowed.has(option.slice(2)) ||
      typeof value !== "string" ||
      value.length === 0
    ) {
      usage();
    }
    parsed.set(option.slice(2), value);
  }
  if ([...allowed].some((name) => !parsed.has(name))) {
    usage();
  }
  return {
    foundry: parsed.get("foundry"),
    project: parsed.get("project"),
    runner: parsed.get("runner"),
    root: parsed.get("path"),
  };
}

function usage() {
  process.stderr.write(
    "Usage: node scripts/verify-foundry-test-run.mjs " +
      "--foundry <binary> --project <directory> " +
      "--runner <res://runner> --path <res://root>\n",
  );
  process.exitCode = 2;
  throw new Error("Invalid live-verifier arguments.");
}
