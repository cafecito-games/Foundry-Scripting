import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./sync-grammar.mjs", import.meta.url));
const version = "9.8.7-test.6";
const assetName = `foundryscript-tmlanguage-${version}.json`;
const validGrammar = Buffer.from(
  `${JSON.stringify(
    {
      name: "Foundry Script",
      scopeName: "source.foundryscript",
      fileTypes: ["fs"],
      patterns: [{ include: "#comments" }],
      repository: { comments: { match: "#.*" } },
    },
    null,
    2,
  )}\n`,
);

describe("sync-grammar command", () => {
  let root;
  let server;
  let releaseBaseUrl;
  let responseBody;
  let responseStatus;
  let requests;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "foundry-grammar-sync-"));
    await mkdir(path.join(root, "syntaxes"));
    await writeFile(
      path.join(root, "foundry-grammar.json"),
      `${JSON.stringify({ engineVersion: version }, null, 2)}\n`,
    );
    responseBody = validGrammar;
    responseStatus = 200;
    requests = [];
    server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(responseStatus, { "content-type": "application/json" });
      response.end(responseBody);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test server address");
    }
    releaseBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });

  async function runSync(args = []) {
    return execFileAsync(process.execPath, [scriptPath, ...args], {
      cwd: root,
      env: {
        ...process.env,
        FOUNDRY_GRAMMAR_RELEASE_BASE_URL: releaseBaseUrl,
      },
    });
  }

  async function runFailure(args = []) {
    try {
      await runSync(args);
    } catch (error) {
      return error;
    }
    throw new Error("Expected sync-grammar to fail");
  }

  it("downloads the pinned asset and preserves its exact bytes", async () => {
    const result = await runSync();

    expect(result.stderr).toBe("");
    expect(
      await readFile(path.join(root, "syntaxes/foundryscript.tmLanguage.json")),
    ).toEqual(validGrammar);
    expect(requests).toEqual([`/v${version}/${assetName}`]);
  });

  it("passes check mode when the committed bytes match", async () => {
    await writeFile(
      path.join(root, "syntaxes/foundryscript.tmLanguage.json"),
      validGrammar,
    );

    const result = await runSync(["--check"]);

    expect(result.stdout).toContain("matches the pinned release asset");
  });

  it("fails check mode without changing a drifted grammar", async () => {
    const edited = Buffer.from("accidental edit\n");
    const grammarPath = path.join(root, "syntaxes/foundryscript.tmLanguage.json");
    await writeFile(grammarPath, edited);

    const error = await runFailure(["--check"]);

    expect(error.stderr).toContain("does not match the pinned release asset");
    expect(error.stderr).toContain("npm run sync-grammar");
    expect(await readFile(grammarPath)).toEqual(edited);
  });

  it("rejects a grammar with the wrong scope without touching the existing file", async () => {
    const grammarPath = path.join(root, "syntaxes/foundryscript.tmLanguage.json");
    const existing = Buffer.from("keep this grammar\n");
    await writeFile(grammarPath, existing);
    responseBody = Buffer.from(
      JSON.stringify({
        scopeName: "source.wrong",
        fileTypes: ["fs"],
        patterns: [{}],
        repository: { rule: {} },
      }),
    );

    const error = await runFailure();

    expect(error.stderr).toContain("scopeName must be source.foundryscript");
    expect(await readFile(grammarPath)).toEqual(existing);
  });

  it.each([
    ["invalid JSON", Buffer.from("{"), "valid JSON"],
    [
      "a missing fs file type",
      Buffer.from(
        JSON.stringify({
          scopeName: "source.foundryscript",
          fileTypes: [],
          patterns: [{}],
          repository: { rule: {} },
        }),
      ),
      "fileTypes",
    ],
    [
      "empty patterns",
      Buffer.from(
        JSON.stringify({
          scopeName: "source.foundryscript",
          fileTypes: ["fs"],
          patterns: [],
          repository: { rule: {} },
        }),
      ),
      "patterns",
    ],
    [
      "an empty repository",
      Buffer.from(
        JSON.stringify({
          scopeName: "source.foundryscript",
          fileTypes: ["fs"],
          patterns: [{}],
          repository: {},
        }),
      ),
      "repository",
    ],
  ])("rejects %s", async (_caseName, body, expectedMessage) => {
    const grammarPath = path.join(root, "syntaxes/foundryscript.tmLanguage.json");
    const existing = Buffer.from("keep this grammar\n");
    await writeFile(grammarPath, existing);
    responseBody = body;

    const error = await runFailure();

    expect(error.stderr).toContain(expectedMessage);
    expect(await readFile(grammarPath)).toEqual(existing);
  });

  it("reports a failed release request before validating or writing", async () => {
    responseStatus = 404;
    responseBody = Buffer.from("not found");

    const error = await runFailure();

    expect(error.stderr).toContain("HTTP 404");
  });

  it("rejects an unsafe engine version", async () => {
    await writeFile(
      path.join(root, "foundry-grammar.json"),
      `${JSON.stringify({ engineVersion: "../wrong" }, null, 2)}\n`,
    );

    const error = await runFailure();

    expect(error.stderr).toContain("engineVersion");
    expect(requests).toEqual([]);
  });

  it("rejects unsupported arguments", async () => {
    const error = await runFailure(["--write-somewhere-else"]);

    expect(error.stderr).toContain("Usage: node scripts/sync-grammar.mjs [--check]");
    expect(requests).toEqual([]);
  });
});

describe("grammar package commands", () => {
  it("exposes explicit sync and check commands without a build lifecycle hook", () => {
    const require = createRequire(import.meta.url);
    const packageJson = require("../package.json");

    expect(packageJson.scripts["sync-grammar"]).toBe(
      "node scripts/sync-grammar.mjs",
    );
    expect(packageJson.scripts["check:grammar-sync"]).toBe(
      "node scripts/sync-grammar.mjs --check",
    );
    expect(packageJson.scripts.build).toBe("node esbuild.mjs");
    expect(packageJson.scripts.prepare).toBeUndefined();
    expect(packageJson.scripts.prebuild).toBeUndefined();
  });
});
