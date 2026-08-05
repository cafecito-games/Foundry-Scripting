import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Allowed VSIX contents. Runtime assets come from package.json `contributes`,
// `main`, and the auto-packaged LICENSE/README/CHANGELOG. Anything outside this
// set is rejected so that agent scratch directories, task runners, and other
// development-only files cannot leak into a published extension.
const ALLOWED_FILES = new Set([
  "package.json",
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "dist/extension.js",
  "language-configuration.json",
  "syntaxes/foundryscript.tmLanguage.json",
]);

const REQUIRED_FILES = [
  "package.json",
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "dist/extension.js",
  "language-configuration.json",
  "syntaxes/foundryscript.tmLanguage.json",
];

function normalizePackagePath(packagePath) {
  return packagePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function validatePackageFiles(packageFiles) {
  const normalizedFiles = packageFiles.map(normalizePackagePath);

  for (const requiredFile of REQUIRED_FILES) {
    if (!normalizedFiles.includes(requiredFile)) {
      throw new Error(`VSIX is missing required file: ${requiredFile}`);
    }
  }

  for (const packagePath of normalizedFiles) {
    if (!ALLOWED_FILES.has(packagePath)) {
      throw new Error(
        `VSIX contains an unexpected file: ${packagePath}. Only files explicitly listed in scripts/check-package-files.mjs are permitted.`,
      );
    }
  }
}

function listPackageFiles(repositoryRoot) {
  const vscePath = path.join(repositoryRoot, "node_modules/@vscode/vsce/vsce");

  try {
    const output = execFileSync(process.execPath, [vscePath, "ls"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr).trim()
      : "";
    throw new Error(
      "Could not list VSIX files with the repository-local @vscode/vsce. " +
        "Run npm ci and resolve the VSCE error before checking package contents. " +
        `${detail}${stderr ? `\n${stderr}` : ""}`,
    );
  }
}

export function main() {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const packageFiles = listPackageFiles(repositoryRoot);
  validatePackageFiles(packageFiles);
  console.log(`Validated ${packageFiles.length} package files.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
