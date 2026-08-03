const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const extensionId = "cafecito-games.foundryscript";

async function languageAndTasks() {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace);
  const document = await vscode.workspace.openTextDocument(
    path.join(workspace.uri.fsPath, "smoke.fs"),
  );
  assert.equal(document.languageId, "foundryscript");
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, "The packaged FoundryScript extension was not installed.");
  await extension.activate();
  assert.equal(extension.isActive, true);
  assert.ok(
    (await vscode.commands.getCommands(true)).includes(
      "foundryScript.connectionActions",
    ),
  );
  const tasks = await vscode.tasks.fetchTasks({ type: "foundryscript" });
  assert.deepEqual(
    tasks.map((task) => task.definition.command).sort(),
    ["build", "format", "lint", "run", "test"],
  );
}

async function runScenario(scenario) {
  if (scenario === "language-tasks") return languageAndTasks();
  throw new Error(`Scenario not implemented yet: ${scenario}`);
}

module.exports = { runScenario };
