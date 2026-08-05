import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const OFFICIAL_RELEASE_BASE_URL =
  "https://github.com/cafecito-games/Foundry/releases/download";
const root = process.cwd();
const manifestPath = path.join(root, "foundry-grammar.json");
const grammarPath = path.join(root, "syntaxes/foundryscript.tmLanguage.json");

function parseMode(args) {
  if (args.length === 0) return { check: false };
  if (args.length === 1 && args[0] === "--check") return { check: true };
  throw new Error("Usage: node scripts/sync-grammar.mjs [--check]");
}

async function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${path.basename(manifestPath)}: ${error.message}`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${path.basename(manifestPath)} must be a JSON object`);
  }
  return manifest;
}

function requirePinnedVersion(manifest) {
  const version = manifest?.engineVersion;
  if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) {
    throw new Error(
      `${path.basename(manifestPath)} engineVersion must contain only letters, ` +
        "digits, dots, and hyphens",
    );
  }
  return version;
}

function requirePinnedSha256(manifest) {
  const sha256 = manifest?.sha256;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(
      `${path.basename(manifestPath)} sha256 must be a 64-character lowercase ` +
        "hexadecimal SHA-256 digest of the release asset",
    );
  }
  return sha256;
}

function computeSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateGrammar(bytes) {
  let grammar;
  try {
    grammar = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Release asset is not valid JSON: ${error.message}`);
  }

  if (!grammar || typeof grammar !== "object" || Array.isArray(grammar)) {
    throw new Error("Release asset root must be a JSON object");
  }
  if (grammar.scopeName !== "source.foundryscript") {
    throw new Error("Release asset scopeName must be source.foundryscript");
  }
  if (!Array.isArray(grammar.fileTypes) || !grammar.fileTypes.includes("fs")) {
    throw new Error("Release asset fileTypes must include fs");
  }
  if (!Array.isArray(grammar.patterns) || grammar.patterns.length === 0) {
    throw new Error("Release asset patterns must be a non-empty array");
  }
  if (
    !grammar.repository ||
    typeof grammar.repository !== "object" ||
    Array.isArray(grammar.repository) ||
    Object.keys(grammar.repository).length === 0
  ) {
    throw new Error("Release asset repository must be a non-empty object");
  }
}

async function downloadGrammar(version, expectedSha256) {
  const assetName = `foundryscript-tmlanguage-${version}.json`;
  const baseUrl =
    process.env.FOUNDRY_GRAMMAR_RELEASE_BASE_URL ?? OFFICIAL_RELEASE_BASE_URL;
  const url = `${baseUrl.replace(/\/$/, "")}/v${version}/${assetName}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status} for ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  validateGrammar(bytes);
  const actualSha256 = computeSha256(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Release asset SHA-256 mismatch for ${assetName}. ` +
        `Expected ${expectedSha256}, got ${actualSha256}. ` +
        "If the engine release was republished, update foundry-grammar.json.",
    );
  }
  return { assetName, bytes };
}

async function installGrammar(bytes) {
  const temporaryPath = path.join(
    path.dirname(grammarPath),
    `.${path.basename(grammarPath)}.${process.pid}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, grammarPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function main() {
  const { check } = parseMode(process.argv.slice(2));
  const manifest = await readManifest();
  const version = requirePinnedVersion(manifest);
  const expectedSha256 = requirePinnedSha256(manifest);
  const { assetName, bytes } = await downloadGrammar(version, expectedSha256);

  if (check) {
    let committed;
    try {
      committed = await readFile(grammarPath);
    } catch (error) {
      throw new Error(`Unable to read committed grammar: ${error.message}`);
    }
    if (!committed.equals(bytes)) {
      throw new Error(
        "Committed grammar does not match the pinned release asset. " +
          "Run npm run sync-grammar and commit the result.",
      );
    }
    console.log("Committed grammar matches the pinned release asset.");
    return;
  }

  await installGrammar(bytes);
  console.log(`Installed ${assetName}.`);
}

main().catch((error) => {
  console.error(`sync-grammar: ${error.message}`);
  process.exitCode = 1;
});
