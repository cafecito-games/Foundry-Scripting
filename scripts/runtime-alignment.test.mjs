import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const rootUrl = new URL("../", import.meta.url);

async function readText(path) {
  try {
    return await readFile(new URL(path, rootUrl), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJson(path) {
  const source = await readText(path);
  return source === undefined ? undefined : JSON.parse(source);
}

describe("supported runtime dependency contract", () => {
  it("pins the minimum platform declarations and compatible toolchain exactly", async () => {
    const manifest = await readJson("package.json");

    expect(manifest.engines).toMatchObject({
      node: ">=24",
      vscode: "^1.125.0",
    });
    expect(manifest.dependencies).toMatchObject({
      "vscode-jsonrpc": "9.0.1",
      "vscode-languageclient": "10.1.0",
    });
    expect(manifest.devDependencies).toMatchObject({
      "@types/node": "24.13.3",
      "@types/vscode": "1.125.0",
      "@typescript-eslint/eslint-plugin": "8.66.0",
      "@typescript-eslint/parser": "8.66.0",
      "@vscode/test-electron": "3.1.0",
      esbuild: "0.28.1",
      typescript: "6.0.3",
      vite: "8.2.0",
      vitest: "4.1.10",
    });
  });

  it("locks each direct runtime-alignment dependency to the declared version", async () => {
    const lock = await readJson("package-lock.json");
    const expectedDependencies = {
      "vscode-jsonrpc": "9.0.1",
      "vscode-languageclient": "10.1.0",
    };
    const expectedDevDependencies = {
      "@types/node": "24.13.3",
      "@types/vscode": "1.125.0",
      "@typescript-eslint/eslint-plugin": "8.66.0",
      "@typescript-eslint/parser": "8.66.0",
      "@vscode/test-electron": "3.1.0",
      esbuild: "0.28.1",
      typescript: "6.0.3",
      vite: "8.2.0",
      vitest: "4.1.10",
    };

    expect(lock.packages[""].dependencies).toMatchObject(expectedDependencies);
    expect(lock.packages[""].devDependencies).toMatchObject(
      expectedDevDependencies,
    );
    for (const [name, version] of Object.entries({
      ...expectedDependencies,
      ...expectedDevDependencies,
    })) {
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
  });
});

describe("production compiler hardening contract", () => {
  it("enables override checking globally and both additional flags in production", async () => {
    const base = await readJson("tsconfig.json");
    const production = await readJson("tsconfig.production-strict.json");

    expect(base.compilerOptions.noImplicitOverride).toBe(true);
    expect(production).toMatchObject({
      extends: "./tsconfig.json",
      compilerOptions: {
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    });
  });

  it("runs the whole-source and production-strict compiler passes", async () => {
    const manifest = await readJson("package.json");

    expect(manifest.scripts["typecheck:strict-production"]).toBe(
      "tsc --project tsconfig.production-strict.json",
    );
    expect(manifest.scripts.typecheck).toBe(
      "tsc --noEmit && npm run typecheck:strict-production",
    );
  });
});

describe("maintenance and minimum-host automation contract", () => {
  it("exposes exact audit and VS Code 1.125 smoke commands", async () => {
    const manifest = await readJson("package.json");

    expect(manifest.scripts["audit:production"]).toBe("npm audit --omit=dev");
    expect(manifest.scripts["audit:development"]).toBe(
      "npm audit --audit-level=moderate",
    );
    expect(manifest.scripts["test:vscode-minimum"]).toBe(
      "node scripts/run-vscode-minimum.mjs",
    );
  });

  it("runs audits and the exact minimum host in dedicated CI jobs", async () => {
    const workflowSource = await readText(".github/workflows/ci.yml");
    const workflow = parseYaml(workflowSource);
    const auditJob = workflow.jobs["dependency-audit"];
    const minimumJob = workflow.jobs["vscode-minimum"];

    expect(auditJob).toBeDefined();
    expect(minimumJob).toBeDefined();
    if (auditJob === undefined || minimumJob === undefined) return;

    expect(auditJob.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run: "npm ci" }),
        expect.objectContaining({ run: "npm run audit:production" }),
        expect.objectContaining({ run: "npm run audit:development" }),
      ]),
    );
    expect(minimumJob["runs-on"]).toBe("ubuntu-22.04");
    expect(minimumJob.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uses: "actions/setup-node@v7",
          with: expect.objectContaining({ "node-version": "24" }),
        }),
        expect.objectContaining({ run: "npm run build" }),
        expect.objectContaining({ run: "xvfb-run -a npm run test:vscode-minimum" }),
      ]),
    );
  });

  it("checks npm and GitHub Actions monthly with Dependabot", async () => {
    const source = await readText(".github/dependabot.yml");
    expect(source).toBeDefined();
    if (source === undefined) return;

    const dependabot = parseYaml(source);
    expect(dependabot.version).toBe(2);
    expect(dependabot.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "package-ecosystem": "npm",
          directory: "/",
          schedule: { interval: "monthly" },
        }),
        expect.objectContaining({
          "package-ecosystem": "github-actions",
          directory: "/",
          schedule: { interval: "monthly" },
        }),
      ]),
    );
  });
});
