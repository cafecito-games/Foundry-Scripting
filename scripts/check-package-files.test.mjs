import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { validatePackageFiles } from "./check-package-files.mjs";

const requiredFiles = [
  "package.json",
  "dist/extension.js",
  "language-configuration.json",
  "syntaxes/foundryscript.tmLanguage.json",
];

describe("validatePackageFiles", () => {
  it("accepts the required minimal file listing", () => {
    expect(() => validatePackageFiles(requiredFiles)).not.toThrow();
  });

  it.each([
    ".worktrees/package-leak/marker.txt",
    ".github/workflows/ci.yml",
    ".cursor/skills/example.md",
    ".vscode/settings.json",
    "docs/packaging.md",
    "scripts/check-package-files.mjs",
    "src/extension.ts",
    "tests/grammar/keywords.fs",
    "node_modules/example/index.js",
    "dist/extension.js.map",
    "tsconfig.production-strict.json",
  ])("rejects %s", (offendingPath) => {
    expect(() => validatePackageFiles([...requiredFiles, offendingPath])).toThrow(
      offendingPath,
    );
  });

  it.each(requiredFiles)("requires %s", (missingPath) => {
    expect(() =>
      validatePackageFiles(requiredFiles.filter((path) => path !== missingPath)),
    ).toThrow(missingPath);
  });
});

describe("package CI configuration", () => {
  it("packages before validating package files without a standalone build", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const packageJob = workflow.slice(workflow.indexOf("  package:"));

    expect(packageJob).toMatch(
      /- run: npm ci\s+- run: npm run package\s+- run: npm run check:package-files/s,
    );
    expect(packageJob).not.toContain("- run: npm run build");
  });
});
