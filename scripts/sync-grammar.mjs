import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "foundry-grammar.json");
const grammarPath = path.join(root, "syntaxes/foundryscript.tmLanguage.json");
const releaseBaseUrl =
  process.env.FOUNDRY_GRAMMAR_RELEASE_BASE_URL ??
  "https://github.com/cafecito-games/Foundry/releases/download";

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const version = manifest.engineVersion;
  const assetName = `foundryscript-tmlanguage-${version}.json`;
  const url = `${releaseBaseUrl.replace(/\/$/, "")}/v${version}/${assetName}`;
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
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

  console.log(`Installed ${assetName}.`);
}

main().catch((error) => {
  console.error(`sync-grammar: ${error.message}`);
  process.exitCode = 1;
});
