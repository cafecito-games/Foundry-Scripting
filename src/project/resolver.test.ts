import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveFoundryProject } from "./resolver.js";

function request(
  overrides: Partial<Parameters<typeof resolveFoundryProject>[0]> = {},
): Parameters<typeof resolveFoundryProject>[0] {
  return {
    workspacePath: "/workspace/repository",
    workspaceScheme: "file",
    configuredPath: "",
    manifestExists: vi.fn().mockResolvedValue(false),
    findManifests: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("Foundry project resolver", () => {
  it("reports a missing workspace before filesystem access", async () => {
    const manifestExists = vi.fn();
    const findManifests = vi.fn();

    const result = await resolveFoundryProject(
      request({
        workspacePath: undefined,
        workspaceScheme: undefined,
        manifestExists,
        findManifests,
      }),
    );

    expect(result).toMatchObject({
      success: false,
      failure: { kind: "missing_workspace" },
    });
    expect(manifestExists).not.toHaveBeenCalled();
    expect(findManifests).not.toHaveBeenCalled();
  });

  it("rejects a non-file workspace before path or filesystem access", async () => {
    const manifestExists = vi.fn();
    const findManifests = vi.fn();
    const resolutionRequest = {
      workspacePath: undefined,
      workspaceScheme: "vscode-vfs",
      get configuredPath(): string {
        throw new Error("configuredPath must not be read");
      },
      manifestExists,
      findManifests,
    };

    const result = await resolveFoundryProject(resolutionRequest);

    expect(result).toEqual({
      success: false,
      failure: {
        kind: "unsupported_workspace",
        message:
          'Workspace scheme "vscode-vfs" is unsupported because native Foundry tooling requires a local file workspace.',
      },
    });
    expect(manifestExists).not.toHaveBeenCalled();
    expect(findManifests).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "relative",
      configuredPath: "test_project",
      expected: path.resolve("/workspace/repository", "test_project"),
    },
    {
      name: "absolute",
      configuredPath: "/projects/game",
      expected: path.resolve("/projects/game"),
    },
  ])("uses a valid $name configured path without discovery", async (testCase) => {
    const manifestExists = vi.fn().mockResolvedValue(true);
    const findManifests = vi.fn();

    const result = await resolveFoundryProject(
      request({
        configuredPath: testCase.configuredPath,
        manifestExists,
        findManifests,
      }),
    );

    expect(result).toEqual({ success: true, project: testCase.expected });
    expect(manifestExists).toHaveBeenCalledWith(testCase.expected);
    expect(findManifests).not.toHaveBeenCalled();
  });

  it("rejects an invalid configured path without falling back", async () => {
    const findManifests = vi.fn();
    const result = await resolveFoundryProject(
      request({ configuredPath: "missing", findManifests }),
    );

    expect(result).toMatchObject({
      success: false,
      failure: {
        kind: "invalid_configured_project",
        setting: "foundryScript.projectPath",
      },
    });
    expect(findManifests).not.toHaveBeenCalled();
  });

  it("prefers a workspace-root project without nested discovery", async () => {
    const findManifests = vi.fn();
    const result = await resolveFoundryProject(
      request({
        manifestExists: vi.fn().mockResolvedValue(true),
        findManifests,
      }),
    );

    expect(result).toEqual({
      success: true,
      project: path.resolve("/workspace/repository"),
    });
    expect(findManifests).not.toHaveBeenCalled();
  });

  it("resolves one nested project", async () => {
    const result = await resolveFoundryProject(
      request({
        findManifests: vi.fn().mockResolvedValue([
          "/workspace/repository/test_project/project.foundry",
        ]),
      }),
    );

    expect(result).toEqual({
      success: true,
      project: "/workspace/repository/test_project",
    });
  });

  it("reports no discovered project", async () => {
    const result = await resolveFoundryProject(request());

    expect(result).toMatchObject({
      success: false,
      failure: {
        kind: "project_not_found",
        setting: "foundryScript.projectPath",
      },
    });
  });

  it("sorts and deduplicates ambiguous manifest candidates", async () => {
    const result = await resolveFoundryProject(
      request({
        findManifests: vi.fn().mockResolvedValue([
          "/workspace/repository/zeta/project.foundry",
          "/workspace/repository/alpha/project.foundry",
          "/workspace/repository/alpha/project.foundry",
        ]),
      }),
    );

    expect(result).toMatchObject({
      success: false,
      failure: {
        kind: "ambiguous_projects",
        setting: "foundryScript.projectPath",
        candidates: ["alpha/project.foundry", "zeta/project.foundry"],
      },
    });
  });

  it.each(["manifest", "discovery"])(
    "retains the cause of a %s filesystem failure",
    async (phase) => {
      const cause = new Error("denied");
      const result = await resolveFoundryProject(
        request({
          manifestExists:
            phase === "manifest"
              ? vi.fn().mockRejectedValue(cause)
              : vi.fn().mockResolvedValue(false),
          findManifests:
            phase === "discovery"
              ? vi.fn().mockRejectedValue(cause)
              : vi.fn().mockResolvedValue([]),
        }),
      );

      expect(result).toMatchObject({
        success: false,
        failure: { kind: "filesystem_error", cause },
      });
    },
  );
});
