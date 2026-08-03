const vscode = require("vscode");

const encoder = new TextEncoder();

class ReadOnlyProvider {
  constructor() {
    this.onDidChangeFile = new vscode.EventEmitter().event;
    const enginePath = process.env.FOUNDRY_E2E_FAKE_FOUNDRY;
    const root = vscode.Uri.parse(process.env.FOUNDRY_E2E_VIRTUAL_URI).path;
    this.root = root;
    this.files = new Map([
      [`${root}/project.foundry`, encoder.encode('[application]\nname="Virtual E2E"\n')],
      [`${root}/smoke.fs`, encoder.encode("func virtual_smoke() -> int:\n    return 1\n")],
      [
        `${root}/.vscode/settings.json`,
        encoder.encode(
          `${JSON.stringify({
            "foundryScript.enginePath": enginePath,
            "foundryScript.lsp.mode": "spawn",
            "foundryScript.testing.enabled": true,
            "foundryScript.testing.runner": "res://tests/runner.fs",
          })}\n`,
        ),
      ],
    ]);
  }

  watch() {
    return { dispose() {} };
  }

  stat(uri) {
    const bytes = this.files.get(uri.path);
    if (bytes) return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.length };
    if ([this.root, `${this.root}/.vscode`].includes(uri.path)) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(uri) {
    if (uri.path === this.root) {
      return [
        ["project.foundry", vscode.FileType.File],
        ["smoke.fs", vscode.FileType.File],
        [".vscode", vscode.FileType.Directory],
      ];
    }
    if (uri.path === `${this.root}/.vscode`) {
      return [["settings.json", vscode.FileType.File]];
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readFile(uri) {
    const bytes = this.files.get(uri.path);
    if (!bytes) throw vscode.FileSystemError.FileNotFound(uri);
    return bytes;
  }

  createDirectory(uri) {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  writeFile(uri) {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  delete(uri) {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  rename(uri) {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      "foundry-e2e",
      new ReadOnlyProvider(),
      { isCaseSensitive: true, isReadonly: true },
    ),
  );
}

module.exports = { activate };
