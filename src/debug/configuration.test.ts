import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ProjectResolution } from "../project/resolver.js";

type ConfigurationModule = typeof import("./configuration.js");

async function loadConfigurationModule(): Promise<
  ConfigurationModule | undefined
> {
  return import("./configuration.js").catch(() => undefined);
}

const workspaceFolder = {
  uri: { fsPath: "/workspace/repository" },
  name: "repository",
  index: 0,
} as unknown as vscode.WorkspaceFolder;

describe("FoundryScript debug configuration provider", () => {
  const resolveProject = vi.fn<() => Promise<ProjectResolution>>();
  const reportError = vi.fn<(message: string) => void>();

  beforeEach(() => {
    resolveProject.mockReset();
    reportError.mockReset();
    resolveProject.mockResolvedValue({
      success: true,
      project: "/workspace/repository/game",
    });
  });

  it("generates the required default main-scene configuration", async () => {
    const configuration = await loadConfigurationModule();

    expect(configuration?.createDefaultDebugConfiguration()).toEqual({
      type: "foundryscript",
      request: "launch",
      name: "Debug Foundry Project",
      scene: "main",
      args: [],
    });

    const provider = new configuration!.FoundryScriptDebugConfigurationProvider(
      { resolveProject, reportError },
    );
    expect(provider.provideDebugConfigurations(workspaceFolder)).toEqual([
      configuration!.createDefaultDebugConfiguration(),
    ]);
    expect(
      provider.resolveDebugConfiguration(
        workspaceFolder,
        {} as vscode.DebugConfiguration,
      ),
    ).toEqual(configuration!.createDefaultDebugConfiguration());
  });

  it("defers validation until VS Code has substituted supported fields", async () => {
    const configuration = await loadConfigurationModule();
    expect(configuration).toBeDefined();
    const provider = new configuration!.FoundryScriptDebugConfigurationProvider(
      { resolveProject, reportError },
    );
    const unresolved = {
      type: "foundryscript",
      request: "launch",
      name: "Debug ${workspaceFolderBasename}",
      scene: "res://${input:scene}.tscn",
      args: ["--data", "${workspaceFolder}/data"],
    };

    expect(
      provider.resolveDebugConfiguration(workspaceFolder, unresolved),
    ).toBe(unresolved);
    await expect(
      provider.resolveDebugConfigurationWithSubstitutedVariables(
        workspaceFolder,
        {
          ...unresolved,
          name: "Debug repository",
          scene: "res://levels/forest.tscn",
          args: ["--data", "/workspace/repository/data"],
        },
      ),
    ).resolves.toEqual({
      type: "foundryscript",
      request: "launch",
      name: "Debug repository",
      scene: "res://levels/forest.tscn",
      project: "/workspace/repository/game",
      playArgs: ["--data", "/workspace/repository/data"],
    });
  });

  it.each(["main", "res://levels/forest.tscn"])(
    "validates and resolves scene %s",
    async (scene) => {
      const configuration = await loadConfigurationModule();
      expect(configuration).toBeDefined();
      const provider =
        new configuration!.FoundryScriptDebugConfigurationProvider({
          resolveProject,
          reportError,
        });

      await expect(
        provider.resolveDebugConfigurationWithSubstitutedVariables(
          workspaceFolder,
          {
            type: "foundryscript",
            request: "launch",
            name: "Debug scene",
            scene,
            args: [],
            project: "/user/controlled/path",
          },
        ),
      ).resolves.toEqual({
        type: "foundryscript",
        request: "launch",
        name: "Debug scene",
        scene,
        project: "/workspace/repository/game",
        playArgs: [],
      });
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])("preserves noDebug=%s", async (noDebug) => {
    const configuration = await loadConfigurationModule();
    expect(configuration).toBeDefined();
    const provider = new configuration!.FoundryScriptDebugConfigurationProvider(
      { resolveProject, reportError },
    );

    await expect(
      provider.resolveDebugConfigurationWithSubstitutedVariables(
        workspaceFolder,
        {
          type: "foundryscript",
          request: "launch",
          name: "Run scene",
          scene: "main",
          noDebug,
        },
      ),
    ).resolves.toMatchObject({ noDebug });
  });

  it.each([undefined, "attach", "restart"])(
    "rejects unsupported request %s",
    async (request) => {
      const configuration = await loadConfigurationModule();
      expect(configuration).toBeDefined();
      const provider =
        new configuration!.FoundryScriptDebugConfigurationProvider({
          resolveProject,
          reportError,
        });

      await expect(
        provider.resolveDebugConfigurationWithSubstitutedVariables(
          workspaceFolder,
          {
            type: "foundryscript",
            name: "Invalid request",
            request,
            scene: "main",
          } as unknown as vscode.DebugConfiguration,
        ),
      ).resolves.toBeUndefined();
      expect(reportError).toHaveBeenCalledWith(
        'FoundryScript debug configurations support only request "launch".',
      );
      expect(resolveProject).not.toHaveBeenCalled();
    },
  );

  it("accepts an internal structured project_test launch without a scene", async () => {
    const module = await loadConfigurationModule();
    expect(module).toBeDefined();
    const provider = new module!.FoundryScriptDebugConfigurationProvider({
      resolveProject,
      reportError,
    });
    const configuration = {
      type: "foundryscript",
      request: "launch",
      name: "Debug Foundry Tests",
      project: "/workspace/game",
      noDebug: false,
      "foundry/launch": {
        kind: "project_test",
        runner: "res://tests/runner.fs",
        adapter: {
          protocolVersion: 1,
          report: "/tmp/foundryscript-test-debug/report.tap",
          testIds: ["test-a", "test-b"],
        },
      },
    };

    await expect(
      provider.resolveDebugConfigurationWithSubstitutedVariables(
        undefined,
        configuration as vscode.DebugConfiguration,
      ),
    ).resolves.toEqual(configuration);
    expect(resolveProject).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unsupported protocol",
      mutate: (configuration: Record<string, unknown>) => {
        projectTestAdapter(configuration).protocolVersion = 2;
      },
      message: "protocol version 1",
    },
    {
      name: "relative report",
      mutate: (configuration: Record<string, unknown>) => {
        projectTestAdapter(configuration).report = "relative/report.tap";
      },
      message: "absolute TAP report",
    },
    {
      name: "duplicate selections",
      mutate: (configuration: Record<string, unknown>) => {
        projectTestAdapter(configuration).testIds = ["test-a", "test-a"];
      },
      message: "unique non-empty",
    },
  ])("rejects an internal project_test launch with $name", async ({ mutate, message }) => {
    const module = await loadConfigurationModule();
    expect(module).toBeDefined();
    const provider = new module!.FoundryScriptDebugConfigurationProvider({
      resolveProject,
      reportError,
    });
    const configuration = projectTestConfiguration();
    mutate(configuration);

    await expect(
      provider.resolveDebugConfigurationWithSubstitutedVariables(
        undefined,
        configuration as vscode.DebugConfiguration,
      ),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(resolveProject).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "current",
    "forest.tscn",
    "res://forest.scn",
    "res:///forest.tscn",
    "res://levels//forest.tscn",
    "res://levels/../forest.tscn",
    "res://levels\\forest.tscn",
  ])("rejects invalid scene %s", async (scene) => {
    const configuration = await loadConfigurationModule();
    expect(configuration).toBeDefined();
    const provider = new configuration!.FoundryScriptDebugConfigurationProvider(
      { resolveProject, reportError },
    );

    await expect(
      provider.resolveDebugConfigurationWithSubstitutedVariables(
        workspaceFolder,
        {
          type: "foundryscript",
          request: "launch",
          name: "Invalid scene",
          scene,
        },
      ),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(
      'Set "scene" to "main" or a canonical res:// path ending in .tscn.',
    );
    expect(resolveProject).not.toHaveBeenCalled();
  });

  it.each(["--verbose", ["--verbose", 2], [false]])(
    "rejects non-string argument arrays %j",
    async (args) => {
      const configuration = await loadConfigurationModule();
      expect(configuration).toBeDefined();
      const provider =
        new configuration!.FoundryScriptDebugConfigurationProvider({
          resolveProject,
          reportError,
        });

      await expect(
        provider.resolveDebugConfigurationWithSubstitutedVariables(
          workspaceFolder,
          {
            type: "foundryscript",
            request: "launch",
            name: "Invalid args",
            scene: "main",
            args,
          },
        ),
      ).resolves.toBeUndefined();
      expect(reportError).toHaveBeenCalledWith(
        'Set "args" to an array containing only strings.',
      );
      expect(resolveProject).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      kind: "ambiguous_projects" as const,
      message:
        "Multiple Foundry projects were found. Configure foundryScript.projectPath.",
      setting: "foundryScript.projectPath" as const,
    },
    {
      kind: "project_not_found" as const,
      message: "No project.foundry was found under the workspace.",
      setting: "foundryScript.projectPath" as const,
    },
  ])("reports project resolution failure $kind", async (failure) => {
    const configuration = await loadConfigurationModule();
    expect(configuration).toBeDefined();
    resolveProject.mockResolvedValue({ success: false, failure });
    const provider = new configuration!.FoundryScriptDebugConfigurationProvider(
      { resolveProject, reportError },
    );

    await expect(
      provider.resolveDebugConfigurationWithSubstitutedVariables(
        workspaceFolder,
        {
          type: "foundryscript",
          request: "launch",
          name: "Debug scene",
          scene: "main",
        },
      ),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(failure.message);
  });

  it("reports unexpected project resolution errors", async () => {
    const configuration = await loadConfigurationModule();
    expect(configuration).toBeDefined();
    resolveProject.mockRejectedValue(new Error("permission denied"));
    const provider = new configuration!.FoundryScriptDebugConfigurationProvider(
      { resolveProject, reportError },
    );

    await expect(
      provider.resolveDebugConfigurationWithSubstitutedVariables(
        workspaceFolder,
        {
          type: "foundryscript",
          request: "launch",
          name: "Debug scene",
          scene: "main",
        },
      ),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(
      "Unable to resolve the Foundry project: permission denied",
    );
  });
});

function projectTestConfiguration(): Record<string, unknown> {
  return {
    type: "foundryscript",
    request: "launch",
    name: "Debug Foundry Tests",
    project: "/workspace/game",
    noDebug: false,
    "foundry/launch": {
      kind: "project_test",
      runner: "res://tests/runner.fs",
      adapter: {
        protocolVersion: 1,
        report: "/tmp/foundryscript-test-debug/report.tap",
        testIds: ["test-a", "test-b"],
      },
    },
  };
}

function projectTestAdapter(
  configuration: Record<string, unknown>,
): Record<string, unknown> {
  const launch = configuration["foundry/launch"] as Record<string, unknown>;
  return launch.adapter as Record<string, unknown>;
}
