import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceMock = vi.hoisted(() => ({
  configuration: new Map<string, unknown>(),
  workspaceFolders: [] as Array<{
    uri: { readonly scheme?: string; readonly fsPath: string };
  }>,
  getConfiguration: vi.fn(),
  constructRelativePattern: vi.fn(),
  findFiles: vi.fn(),
}));

vi.mock("vscode", () => ({
  RelativePattern: class {
    constructor(
      readonly base: string,
      readonly pattern: string,
    ) {
      workspaceMock.constructRelativePattern(base, pattern);
    }
  },
  workspace: {
    get workspaceFolders() {
      return workspaceMock.workspaceFolders;
    },
    getConfiguration: workspaceMock.getConfiguration,
    findFiles: workspaceMock.findFiles,
  },
}));

import { createWorkspaceProjectResolver } from "./workspace.js";

describe("VS Code workspace project resolver", () => {
  beforeEach(() => {
    workspaceMock.configuration.clear();
    workspaceMock.workspaceFolders.length = 0;
    workspaceMock.getConfiguration.mockReset();
    workspaceMock.getConfiguration.mockReturnValue({
      get: (key: string, defaultValue: unknown) =>
        workspaceMock.configuration.get(key) ?? defaultValue,
    });
    workspaceMock.constructRelativePattern.mockReset();
    workspaceMock.findFiles.mockReset();
    workspaceMock.findFiles.mockResolvedValue([]);
  });

  it("rejects a non-file workspace before reading local-only APIs", async () => {
    const readFsPath = vi.fn(() => {
      throw new Error("fsPath must not be read");
    });
    workspaceMock.workspaceFolders.push({
      uri: {
        scheme: "vscode-vfs",
        get fsPath(): string {
          return readFsPath();
        },
      },
    });
    const manifestExists = vi.fn();
    const resolveProject = createWorkspaceProjectResolver({ manifestExists });

    await expect(resolveProject()).resolves.toEqual({
      success: false,
      failure: {
        kind: "unsupported_workspace",
        message:
          'Workspace scheme "vscode-vfs" is unsupported because native Foundry tooling requires a local file workspace.',
      },
    });
    expect(readFsPath).not.toHaveBeenCalled();
    expect(workspaceMock.getConfiguration).not.toHaveBeenCalled();
    expect(manifestExists).not.toHaveBeenCalled();
    expect(workspaceMock.constructRelativePattern).not.toHaveBeenCalled();
    expect(workspaceMock.findFiles).not.toHaveBeenCalled();
  });

  it("reads projectPath and resolves it from the first workspace folder only", async () => {
    workspaceMock.workspaceFolders.push(
      { uri: { scheme: "file", fsPath: "/workspace/first" } },
      { uri: { scheme: "file", fsPath: "/workspace/second" } },
    );
    workspaceMock.findFiles.mockResolvedValue([
      { fsPath: "/workspace/first/test_project/project.foundry" },
    ]);
    const resolveProject = createWorkspaceProjectResolver({
      manifestExists: vi.fn().mockResolvedValue(false),
    });

    await expect(resolveProject()).resolves.toEqual({
      success: true,
      project: "/workspace/first/test_project",
    });
    // Multi-root resolution intentionally prefers the first folder; the
    // reconfiguration e2e scenario relies on reordering to swap projects.
    expect(workspaceMock.findFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        base: "/workspace/first",
        pattern: "**/project.foundry",
      }),
      expect.stringContaining("node_modules"),
    );
  });

  it("reads the configured project path on every resolution", async () => {
    workspaceMock.workspaceFolders.push({
      uri: { scheme: "file", fsPath: "/workspace/root" },
    });
    const manifestExists = vi.fn().mockResolvedValue(true);
    const resolveProject = createWorkspaceProjectResolver({ manifestExists });

    workspaceMock.configuration.set("projectPath", "first");
    await resolveProject();
    workspaceMock.configuration.set("projectPath", "second");
    await resolveProject();

    expect(manifestExists).toHaveBeenNthCalledWith(1, "/workspace/root/first");
    expect(manifestExists).toHaveBeenNthCalledWith(2, "/workspace/root/second");
  });
});
