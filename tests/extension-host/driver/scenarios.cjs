const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const extensionId = "cafecito-games.foundryscript";
const control = requiredEnvironment("FOUNDRY_E2E_CONTROL");
const fakeFoundry = requiredEnvironment("FOUNDRY_E2E_FAKE_FOUNDRY");
const workspaceRoot = requiredEnvironment("FOUNDRY_E2E_WORKSPACE");
const eventsPath = path.join(control, "events.ndjson");
const statePath = path.join(control, "state.json");

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function readEvents() {
  try {
    return (await fs.readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitFor(description, predicate, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function setState(update) {
  const current = JSON.parse(await fs.readFile(statePath, "utf8"));
  const temporary = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ ...current, ...update })}\n`);
  await fs.rename(temporary, statePath);
}

function phaseEvents(events, operation, phase = "start") {
  return events.filter(
    (event) => event.phase === phase && operationMatches(event.argv, operation),
  );
}

function operationMatches(argv, operation) {
  if (operation === "tooling") return argv[0] === "tooling" && argv[1] === "serve";
  if (operation === "lint") return argv[0] === "script" && argv[1] === "lint";
  const adapter = argv.indexOf("adapter");
  return adapter >= 0 && argv[adapter + 1] === operation;
}

async function localDocument(folder = vscode.workspace.workspaceFolders?.[0]) {
  assert.ok(folder, "A local fixture workspace must be open.");
  const document = await vscode.workspace.openTextDocument(
    path.join(folder.uri.fsPath, "smoke.fs"),
  );
  await vscode.window.showTextDocument(document);
  return document;
}

async function activateFoundryScript(document) {
  assert.equal(document.languageId, "foundryscript");
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, "The packaged FoundryScript extension was not installed.");
  await extension.activate();
  assert.equal(extension.isActive, true);
  return extension;
}

async function commands() {
  return vscode.commands.getCommands(true);
}

async function foundryTasks() {
  return vscode.tasks.fetchTasks({ type: "foundryscript" });
}

async function languageAndTasks() {
  assert.equal(vscode.workspace.isTrusted, true);
  const document = await localDocument();
  await activateFoundryScript(document);
  assert.ok((await commands()).includes("foundryScript.connectionActions"));
  const tasks = await foundryTasks();
  assert.deepEqual(
    tasks.map((task) => task.definition.command).sort(),
    ["build", "format", "lint", "run", "test"],
  );
  assert.deepEqual(await readEvents(), []);
}

async function waitForAdapterGeneration(count) {
  return waitFor(`test adapter generation ${count}`, async () => {
    const events = await readEvents();
    const capabilities = phaseEvents(events, "capabilities");
    const discoveries = phaseEvents(events, "discover");
    const exits = events.filter((event) => event.phase === "exit");
    if (
      capabilities.length < count ||
      discoveries.length < count ||
      ![capabilities[count - 1], discoveries[count - 1]].every((start) =>
        exits.some((exit) => exit.invocationId === start.invocationId),
      )
    ) {
      return undefined;
    }
    const outputIndex = discoveries[count - 1].argv.indexOf("--output");
    const artifact = discoveries[count - 1].argv[outputIndex + 1];
    try {
      await fs.access(path.dirname(artifact));
      return undefined;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { events, capabilities, discoveries };
  });
}

async function testExplorer() {
  await activateFoundryScript(await localDocument());
  const first = await waitForAdapterGeneration(1);
  assert.ok(
    first.events.findIndex((event) => event.invocationId === first.capabilities[0].invocationId) <
      first.events.findIndex((event) => event.invocationId === first.discoveries[0].invocationId),
  );

  await vscode.workspace
    .getConfiguration("foundryScript")
    .update("testing.args", ["--seed", "7"], vscode.ConfigurationTarget.Workspace);
  const second = await waitForAdapterGeneration(2);
  const argv = second.discoveries[1].argv;
  assert.deepEqual(argv.slice(-3), ["--", "--seed", "7"]);
  const starts = second.events.filter((event) => event.phase === "start");
  const exits = new Set(
    second.events
      .filter((event) => event.phase === "exit")
      .map((event) => event.invocationId),
  );
  assert.ok(starts.every((event) => exits.has(event.invocationId)));
}

async function runLintTask() {
  const task = (await foundryTasks()).find(
    (candidate) => candidate.definition.command === "lint",
  );
  assert.ok(task, "The contributed lint task is missing.");
  const ended = new Promise((resolve) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.definition.command === "lint") {
        disposable.dispose();
        resolve(event.exitCode);
      }
    });
  });
  await vscode.tasks.executeTask(task);
  assert.equal(await ended, 0);
}

async function documentDiagnostics(uri, message) {
  return waitFor(`diagnostic ${message}`, () => {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    return diagnostics.some((diagnostic) => diagnostic.message === message)
      ? diagnostics
      : undefined;
  });
}

async function diagnostics() {
  const document = await localDocument();
  await activateFoundryScript(document);
  await runLintTask();
  let visible = await documentDiagnostics(
    document.uri,
    "CLI diagnostic generation 1",
  );
  assert.equal(visible.length, 1);
  assert.equal(visible[0].source, "foundry-e2e-cli");

  await vscode.workspace
    .getConfiguration("foundryScript")
    .update("lsp.mode", "spawn", vscode.ConfigurationTarget.Workspace);
  await waitFor("spawned tooling readiness", async () =>
    phaseEvents(await readEvents(), "tooling", "ready").length === 1,
  );
  visible = await documentDiagnostics(document.uri, "LSP diagnostic generation 1");
  assert.equal(visible.length, 1);
  assert.equal(visible[0].source, "foundry-e2e-lsp");

  await vscode.workspace
    .getConfiguration("foundryScript")
    .update("lsp.mode", "off", vscode.ConfigurationTarget.Workspace);
  await waitFor("owned tooling host shutdown", async () => {
    const events = await readEvents();
    const tooling = phaseEvents(events, "tooling")[0];
    return tooling !== undefined && events.some(
      (event) =>
        event.invocationId === tooling.invocationId && event.phase === "exit",
    );
  });
  assert.deepEqual(
    vscode.languages.getDiagnostics(document.uri).map((entry) => entry.message),
    ["LSP diagnostic generation 1"],
  );

  await setState({ generation: 2, lintMessage: "CLI diagnostic generation 2" });
  await runLintTask();
  visible = await documentDiagnostics(document.uri, "CLI diagnostic generation 2");
  assert.equal(visible.length, 1);
  assert.equal(phaseEvents(await readEvents(), "lint").length, 2);
}

async function reconfiguration() {
  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders?.length, 2);
  const firstProject = folders[0].uri.fsPath;
  const secondProject = folders[1].uri.fsPath;
  await activateFoundryScript(await localDocument(folders[0]));
  await waitFor("first tooling host", async () => {
    const ready = phaseEvents(await readEvents(), "tooling", "ready");
    return ready.length === 1 && ready[0].project === firstProject;
  });
  await waitForAdapterGeneration(1);

  await vscode.workspace
    .getConfiguration("foundryScript")
    .update("dap.port", 6010, vscode.ConfigurationTarget.Workspace);
  await waitFor("connection-setting replacement", async () => {
    const events = await readEvents();
    return phaseEvents(events, "tooling", "ready").length === 2 &&
      phaseEvents(events, "tooling", "signal").length >= 1;
  });

  assert.equal(
    vscode.workspace.updateWorkspaceFolders(
      0,
      2,
      { uri: vscode.Uri.file(secondProject), name: folders[1].name },
      { uri: vscode.Uri.file(firstProject), name: folders[0].name },
    ),
    true,
  );
  await waitFor("first-folder replacement", async () => {
    const ready = phaseEvents(await readEvents(), "tooling", "ready");
    return ready.length === 3 && ready[2].project === secondProject;
  });
  const beforeTestingChange = phaseEvents(await readEvents(), "discover").length;
  await vscode.workspace
    .getConfiguration("foundryScript")
    .update("testing.args", ["--reconfigured"], vscode.ConfigurationTarget.Workspace);
  await waitForAdapterGeneration(beforeTestingChange + 1);

  const events = await readEvents();
  const toolingStarts = phaseEvents(events, "tooling");
  const toolingExits = new Set(
    events
      .filter((event) => event.phase === "exit")
      .map((event) => event.invocationId),
  );
  assert.equal(
    toolingStarts.filter((event) => !toolingExits.has(event.invocationId)).length,
    1,
  );
  assert.equal((await foundryTasks()).length, 5);
}

async function coldStartFailure() {
  const document = await localDocument();
  assert.equal(document.languageId, "foundryscript");
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension);
  const startedAt = Date.now();
  await extension.activate();
  assert.ok(Date.now() - startedAt < 2_000, "Cold activation exceeded two seconds.");
  assert.equal(extension.isActive, true);
  assert.ok((await commands()).includes("foundryScript.connectionActions"));
  assert.equal((await foundryTasks()).length, 5);
  assert.deepEqual(await readEvents(), []);
}

async function pendingStartShutdown() {
  await activateFoundryScript(await localDocument());
  await waitFor("never-ready fake start", async () =>
    phaseEvents(await readEvents(), "tooling").length === 1,
  );
}

async function normalShutdown() {
  await activateFoundryScript(await localDocument());
  await waitFor("normal tooling readiness", async () =>
    phaseEvents(await readEvents(), "tooling", "ready").length === 1,
  );
  await waitForAdapterGeneration(1);
}

async function restricted() {
  assert.equal(
    vscode.workspace.isTrusted,
    false,
    "The fresh profile did not enter Restricted Mode.",
  );
  assert.ok((await vscode.languages.getLanguages()).includes("foundryscript"));
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, "The packaged FoundryScript extension was not installed.");
  await extension.activate();
  assert.equal(extension.isActive, true);
  assert.ok(!(await commands()).includes("foundryScript.connectionActions"));
  assert.deepEqual(await readEvents(), []);
}

async function virtualWorkspace() {
  const virtualRoot = requiredEnvironment("FOUNDRY_E2E_VIRTUAL_URI");
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder);
  assert.equal(folder.uri.scheme, "foundry-e2e");
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(vscode.Uri.parse(virtualRoot), "smoke.fs"),
  );
  await activateFoundryScript(document);
  assert.ok(!(await commands()).includes("foundryScript.connectionActions"));
  assert.equal((await foundryTasks()).length, 0);
  assert.deepEqual(await readEvents(), []);
}

const scenarios = {
  "language-tasks": languageAndTasks,
  "test-explorer": testExplorer,
  diagnostics,
  reconfiguration,
  "cold-start-failure": coldStartFailure,
  "pending-start-shutdown": pendingStartShutdown,
  "normal-shutdown": normalShutdown,
  restricted,
  "virtual-workspace": virtualWorkspace,
};

async function runScenario(scenario) {
  if (scenario !== "restricted") {
    assert.equal(
      vscode.workspace.getConfiguration("foundryScript").get("enginePath"),
      scenario === "cold-start-failure"
        ? path.join(path.dirname(control), "missing-foundry")
        : fakeFoundry,
    );
  }
  const implementation = scenarios[scenario];
  if (!implementation) throw new Error(`Unknown scenario: ${scenario}`);
  await implementation();
}

module.exports = { runScenario };
