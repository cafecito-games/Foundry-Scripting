const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const extensionId = "cafecito-games.foundryscript";
const expectedTaskKinds = ["build", "format", "lint", "run", "test"];

async function run() {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, "The minimum-host fixture workspace must be open.");
  assert.equal(workspace.uri.scheme, "file");
  assert.equal(vscode.workspace.isTrusted, true);

  const document = await vscode.workspace.openTextDocument(
    path.join(workspace.uri.fsPath, "smoke.fs"),
  );
  await vscode.window.showTextDocument(document);
  assert.equal(document.languageId, "foundryscript");

  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, `Extension ${extensionId} was not installed.`);
  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  assert.ok(
    commands.includes("foundryScript.connectionActions"),
    "FoundryScript connection actions command was not registered.",
  );

  const tasks = await vscode.tasks.fetchTasks({ type: "foundryscript" });
  const kinds = tasks
    .map((task) => task.definition.command)
    .filter((kind) => typeof kind === "string")
    .sort();
  assert.deepEqual(kinds, expectedTaskKinds);
}

module.exports = { run };
