import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
});
