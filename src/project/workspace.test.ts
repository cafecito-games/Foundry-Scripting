import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceMock = vi.hoisted(() => ({
  configuration: new Map<string, unknown>(),
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  findFiles: vi.fn(),
}));

vi.mock("vscode", () => ({
  RelativePattern: class {
    constructor(
      readonly base: string,
      readonly pattern: string,
    ) {}
  },
  workspace: {
    get workspaceFolders() {
      return workspaceMock.workspaceFolders;
    },
    getConfiguration: () => ({
      get: (key: string, defaultValue: unknown) =>
        workspaceMock.configuration.get(key) ?? defaultValue,
    }),
    findFiles: workspaceMock.findFiles,
  },
}));

import { createWorkspaceProjectResolver } from "./workspace.js";

describe("VS Code workspace project resolver", () => {
  beforeEach(() => {
    workspaceMock.configuration.clear();
    workspaceMock.workspaceFolders.length = 0;
    workspaceMock.findFiles.mockReset();
    workspaceMock.findFiles.mockResolvedValue([]);
  });

  it("reads projectPath and searches only the first workspace folder", async () => {
    workspaceMock.workspaceFolders.push(
      { uri: { fsPath: "/workspace/first" } },
      { uri: { fsPath: "/workspace/second" } },
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
    expect(workspaceMock.findFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        base: "/workspace/first",
        pattern: "**/project.foundry",
      }),
      expect.stringContaining("node_modules"),
    );
  });

  it("reads the configured project path on every resolution", async () => {
    workspaceMock.workspaceFolders.push({ uri: { fsPath: "/workspace/root" } });
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
