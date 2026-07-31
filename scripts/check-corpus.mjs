import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// vscode-oniguruma and vscode-textmate are CommonJS. A namespace import yields a
// module wrapper whose members are not callable (`oniguruma.loadWASM is not a
// function`), so require them explicitly.
const require = createRequire(import.meta.url);
const oniguruma = require("vscode-oniguruma");
const textmate = require("vscode-textmate");

const enginePath = process.env.FOUNDRY_ENGINE_PATH;
if (!enginePath) {
  console.log(
    "FOUNDRY_ENGINE_PATH is not set - skipping the corpus check.\n" +
      "Set it to a Foundry engine checkout to run this locally:\n" +
      "  FOUNDRY_ENGINE_PATH=~/CafecitoGames/Foundry npm run test:corpus",
  );
  process.exit(0);
}

// `yield` is reserved but always an error (GRAMMAR.md 2.5), so scoping it
// invalid is correct rather than a grammar bug.
const ALLOWED_INVALID = ["invalid.illegal.yield"];

async function makeRegistry() {
  const wasmPath = require.resolve("vscode-oniguruma/release/onig.wasm");
  await oniguruma.loadWASM(await readFile(wasmPath));

  const grammarSource = await readFile(
    new URL("../syntaxes/foundryscript.tmLanguage.json", import.meta.url),
    "utf8",
  );

  return new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
      createOnigString: (source) => new oniguruma.OnigString(source),
    }),
    loadGrammar: async (scopeName) =>
      scopeName === "source.foundryscript"
        ? textmate.parseRawGrammar(grammarSource, "foundryscript.tmLanguage.json")
        : null,
  });
}

async function* findScripts(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "bin" || entry.name === "thirdparty") {
        continue;
      }
      yield* findScripts(full);
    } else if (entry.name.endsWith(".fs")) {
      yield full;
    }
  }
}

const registry = await makeRegistry();
const grammar = await registry.loadGrammar("source.foundryscript");
if (!grammar) {
  console.error("Failed to load source.foundryscript");
  process.exit(1);
}

const failures = [];
let scanned = 0;

for await (const file of findScripts(enginePath)) {
  const source = await readFile(file, "utf8");
  let ruleStack = textmate.INITIAL;
  let lineNumber = 0;

  // The \r? is load-bearing, not cosmetic. A CR surviving into the line text
  // turns a line-continuation backslash into invalid.illegal.unknown-escape and
  // cascades into the following line, so a CRLF checkout would fail this gate on
  // valid engine code. Real VS Code is unaffected -- getLineContent() strips the
  // full EOL -- so this only bites tooling that splits a file itself.
  for (const line of source.split(/\r?\n/)) {
    lineNumber += 1;
    const result = grammar.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;

    for (const token of result.tokens) {
      for (const scope of token.scopes) {
        if (
          scope.startsWith("invalid.illegal") &&
          !ALLOWED_INVALID.some((allowed) => scope.startsWith(allowed))
        ) {
          failures.push(
            `${path.relative(enginePath, file)}:${lineNumber} ` +
              `"${line.slice(token.startIndex, token.endIndex)}" scoped ${scope}`,
          );
        }
      }
    }
  }

  scanned += 1;
}

console.log(`Scanned ${scanned} .fs files.`);

if (failures.length > 0) {
  console.error(`\n${failures.length} unexpected invalid scope(s):\n`);
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log("No unexpected invalid scopes.");
