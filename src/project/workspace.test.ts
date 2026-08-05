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
    workspaceMock.configuration.set("projectPath", "test_project");
    const manifestExists = vi.fn().mockResolvedValue(true);
    const resolveProject = createWorkspaceProjectResolver({ manifestExists });

    await expect(resolveProject()).resolves.toEqual({
      success: true,
      project: "/workspace/first/test_project",
    });
    // The configured path is resolved from the first folder only; no
    // multi-folder scan is performed when projectPath is set.
    expect(manifestExists).toHaveBeenCalledWith("/workspace/first/test_project");
    expect(manifestExists).not.toHaveBeenCalledWith(
      "/workspace/second/test_project",
    );
    expect(workspaceMock.findFiles).not.toHaveBeenCalled();
  });

  it("searches every file-scheme folder when projectPath is unset", async () => {
    workspaceMock.workspaceFolders.push(
      { uri: { scheme: "file", fsPath: "/workspace/first" } },
      { uri: { scheme: "file", fsPath: "/workspace/second" } },
    );
    let callIndex = 0;
    workspaceMock.findFiles.mockImplementation(() => {
      callIndex += 1;
      return Promise.resolve(
        callIndex === 1
          ? [{ fsPath: "/workspace/first/test_project/project.foundry" }]
          : [],
      );
    });
    const resolveProject = createWorkspaceProjectResolver({
      manifestExists: vi.fn().mockResolvedValue(false),
    });

    await expect(resolveProject()).resolves.toEqual({
      success: true,
      project: "/workspace/first/test_project",
    });
    expect(workspaceMock.findFiles).toHaveBeenCalledTimes(2);
  });

  it("reports ambiguity when multiple folders contain a project", async () => {
    workspaceMock.workspaceFolders.push(
      { uri: { scheme: "file", fsPath: "/workspace/first" } },
      { uri: { scheme: "file", fsPath: "/workspace/second" } },
    );
    let callIndex = 0;
    workspaceMock.findFiles.mockImplementation(() => {
      callIndex += 1;
      return Promise.resolve(
        callIndex === 1
          ? [{ fsPath: "/workspace/first/game/project.foundry" }]
          : [{ fsPath: "/workspace/second/tools/project.foundry" }],
      );
    });
    const resolveProject = createWorkspaceProjectResolver({
      manifestExists: vi.fn().mockResolvedValue(false),
    });

    const result = await resolveProject();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.failure.kind).toBe("ambiguous_projects");
      expect(result.failure.setting).toBe("foundryScript.projectPath");
    }
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
