import { readFile, readdir } from "node:fs/promises";

// Mirrors vscode-tmgrammar-test's own parsing (parseScopeAssertion in
// vscode-tmgrammar-test/dist/unit/parsing.js): an assertion line must start
// with the comment token in column 1, and a lone "-" separates required
// scopes from excluded ones, e.g. "^^^ - some.scope" is a pure negative
// assertion with no required scopes. Scopes before the "-" are joined with
// whitespace, not prefixed per-token, so splitting the trailing text on
// whitespace and checking each token for a leading "-" (as a naive read of
// the assertion syntax might do) misclassifies every assertion in this
// codebase, since they are all written as "- scope.name" with a space.
const SUFFIX = /^((?:\s*\w[-\w.]*)*)(?:\s*-)?((?:\s*\w[-\w.]*)*)\s*$/;

const directory = new URL("../tests/grammar/", import.meta.url);
const failures = [];

for (const name of (await readdir(directory)).filter((f) => f.endsWith(".fs"))) {
  const lines = (await readFile(new URL(name, directory), "utf8")).split(/\r?\n/);
  let previousSource = "";

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("#")) {
      previousSource = line;
      continue;
    }

    const rest = line.slice(1);
    const arrowMatch = /^\s*<-\s*(.*)$/.exec(rest);
    const caretMatch = !arrowMatch && /^(\s*)(\^+)\s*(.*)$/.exec(rest);

    if (!arrowMatch && !caretMatch) {
      // An ordinary comment, not an assertion line.
      previousSource = line;
      continue;
    }

    const suffix = arrowMatch ? arrowMatch[1] : caretMatch[3];
    const suffixMatch = SUFFIX.exec(suffix);
    if (!suffixMatch) continue;

    const [, scopes, exclusions] = suffixMatch;
    if (scopes.trim() !== "" || exclusions.trim() === "") continue;

    const from = arrowMatch ? 0 : caretMatch[1].length;
    const to = arrowMatch ? 1 : from + caretMatch[2].length;
    if (from >= previousSource.length) {
      failures.push(
        `${name}:${index + 1} negative assertion selects no tokens ` +
          `(columns ${from}-${to}, source line is ${previousSource.length} chars)`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} inert negative assertion(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log("All negative assertions select at least one token.");
