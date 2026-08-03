import { describe, expect, it } from "vitest";
import packageManifest from "../../package.json";

interface StringSchema {
  readonly const?: string;
  readonly pattern?: string;
}

function acceptsStringSchema(schema: StringSchema, value: string): boolean {
  if (schema.const !== undefined) return value === schema.const;
  if (schema.pattern !== undefined) return new RegExp(schema.pattern).test(value);
  return false;
}

describe("FoundryScript debugger manifest", () => {
  it("declares limited support for untrusted and virtual workspaces", () => {
    expect(packageManifest.capabilities).toEqual({
      untrustedWorkspaces: {
        supported: "limited",
        description:
          "Syntax highlighting remains available. Foundry processes, tasks, tests, and debugging require workspace trust.",
        restrictedConfigurations: [
          "foundryScript.lsp.mode",
          "foundryScript.lsp.port",
          "foundryScript.dap.port",
          "foundryScript.enginePath",
          "foundryScript.projectPath",
          "foundryScript.test.runner",
          "foundryScript.testing.enabled",
          "foundryScript.testing.runner",
          "foundryScript.testing.args",
        ],
      },
      virtualWorkspaces: {
        supported: "limited",
        description:
          "Syntax highlighting and language configuration remain available. Native Foundry tooling requires a local file workspace.",
      },
    });
  });

  it("activates for Foundry projects without wildcard or startup activation", () => {
    expect(packageManifest.activationEvents).toEqual([
      "onLanguage:foundryscript",
      "onCommand:foundryScript.connectionActions",
      "onTaskType:foundryscript",
      "onDebugInitialConfigurations",
      "onDebugResolve:foundryscript",
      "workspaceContains:**/project.foundry",
    ]);
  });

  it("gates connection actions on a trusted local workspace", () => {
    expect(
      packageManifest.contributes.commands.find(
        ({ command }) => command === "foundryScript.connectionActions",
      ),
    ).toEqual({
      command: "foundryScript.connectionActions",
      title: "Show Language Server Connection Actions",
      category: "FoundryScript",
      enablement: "isWorkspaceTrusted && !virtualWorkspace",
    });
  });

  it("describes testing integration as current functionality", () => {
    expect(
      packageManifest.contributes.configuration.properties[
        "foundryScript.testing.enabled"
      ],
    ).toMatchObject({
      type: "boolean",
      default: false,
      description:
        "Enable Foundry Test Explorer discovery, run, and debug integration.",
    });
  });

  it("contributes the debugger and FoundryScript line breakpoints", () => {
    expect(packageManifest.contributes.breakpoints).toEqual([
      { language: "foundryscript" },
    ]);
    expect(packageManifest.contributes.debuggers).toHaveLength(1);
    expect(packageManifest.contributes.debuggers[0]).toMatchObject({
      type: "foundryscript",
      label: "FoundryScript",
      languages: ["foundryscript"],
    });
  });

  it("contributes launch-only scene and string argument attributes", () => {
    const debuggerContribution = packageManifest.contributes.debuggers[0];
    expect(Object.keys(debuggerContribution.configurationAttributes)).toEqual([
      "launch",
    ]);

    const launch = debuggerContribution.configurationAttributes.launch;
    expect(launch.required).toContain("scene");
    expect(launch.properties.args).toMatchObject({
      type: "array",
      items: { type: "string" },
    });

    const sceneOptions = launch.properties.scene.oneOf;
    for (const scene of ["main", "res://levels/forest.tscn"]) {
      expect(
        sceneOptions.some((schema) => acceptsStringSchema(schema, scene)),
      ).toBe(true);
    }
    for (const scene of [
      "current",
      "levels/forest.tscn",
      "res://levels/forest.scn",
      "res:///forest.tscn",
      "res://levels//forest.tscn",
      "res://levels/../forest.tscn",
    ]) {
      expect(
        sceneOptions.some((schema) => acceptsStringSchema(schema, scene)),
      ).toBe(false);
    }
  });

  it("offers main and explicit scene snippets with the required default", () => {
    const debuggerContribution = packageManifest.contributes.debuggers[0];
    const defaultConfiguration = {
      type: "foundryscript",
      request: "launch",
      name: "Debug Foundry Project",
      scene: "main",
      args: [],
    };

    expect(debuggerContribution.initialConfigurations).toEqual([
      defaultConfiguration,
    ]);
    expect(debuggerContribution.configurationSnippets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ body: defaultConfiguration }),
        expect.objectContaining({
          body: {
            type: "foundryscript",
            request: "launch",
            name: "Debug Foundry Scene",
            scene: "res://levels/forest.tscn",
            args: [],
          },
        }),
      ]),
    );
  });

  it("contributes a bounded integer DAP port setting", () => {
    expect(
      packageManifest.contributes.configuration.properties[
        "foundryScript.dap.port"
      ],
    ).toEqual({
      type: "integer",
      default: 6006,
      minimum: 1,
      maximum: 65535,
      description:
        "TCP port used to connect to the Foundry debug adapter in an externally owned tooling host.",
    });
  });

  it("contributes a bounded integer LSP port setting", () => {
    expect(
      packageManifest.contributes.configuration.properties[
        "foundryScript.lsp.port"
      ],
    ).toEqual({
      type: "integer",
      default: 6005,
      minimum: 1,
      maximum: 65535,
      description:
        "TCP port used to attach to an existing Foundry language server.",
    });
  });
});
