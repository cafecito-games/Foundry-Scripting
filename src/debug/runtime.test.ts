import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ProjectResolution } from "../project/resolver.js";

const runtimeMock = vi.hoisted(() => ({
  registerDebugConfigurationProvider: vi.fn(),
  showErrorMessage: vi.fn(),
  disposable: { dispose: vi.fn() },
}));

vi.mock("vscode", () => ({
  debug: {
    registerDebugConfigurationProvider:
      runtimeMock.registerDebugConfigurationProvider,
  },
  window: {
    showErrorMessage: runtimeMock.showErrorMessage,
  },
}));

type RuntimeModule = typeof import("./runtime.js");

async function loadRuntimeModule(): Promise<RuntimeModule | undefined> {
  return import("./runtime.js").catch(() => undefined);
}

describe("FoundryScript debug runtime registration", () => {
  const resolveProject = vi.fn<() => Promise<ProjectResolution>>();

  beforeEach(() => {
    resolveProject.mockReset();
    resolveProject.mockResolvedValue({
      success: true,
      project: "/workspace/game",
    });
    runtimeMock.registerDebugConfigurationProvider.mockReset();
    runtimeMock.registerDebugConfigurationProvider.mockReturnValue(
      runtimeMock.disposable,
    );
    runtimeMock.showErrorMessage.mockReset();
    runtimeMock.disposable.dispose.mockReset();
  });

  it("registers exactly one provider and owns its disposal", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    runtime!.registerFoundryScriptDebugConfigurationProvider(
      context,
      resolveProject,
    );

    expect(
      runtimeMock.registerDebugConfigurationProvider,
    ).toHaveBeenCalledOnce();
    expect(
      runtimeMock.registerDebugConfigurationProvider,
    ).toHaveBeenCalledWith("foundryscript", expect.any(Object));
    expect(context.subscriptions).toEqual([runtimeMock.disposable]);

    context.subscriptions[0].dispose();
    expect(runtimeMock.disposable.dispose).toHaveBeenCalledOnce();
  });

  it("exercises registered provider resolution through the VS Code API shape", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const folder = {
      uri: { fsPath: "/workspace" },
      name: "workspace",
      index: 0,
    } as unknown as vscode.WorkspaceFolder;
    runtime!.registerFoundryScriptDebugConfigurationProvider(
      context,
      resolveProject,
    );
    const provider = runtimeMock.registerDebugConfigurationProvider.mock
      .calls[0][1] as vscode.DebugConfigurationProvider;

    await expect(
      provider.resolveDebugConfigurationWithSubstitutedVariables?.(
        folder,
        {
          type: "foundryscript",
          request: "launch",
          name: "Debug Forest",
          scene: "res://levels/forest.tscn",
          args: ["--seed", "42"],
          noDebug: true,
        },
      ),
    ).resolves.toMatchObject({
      project: "/workspace/game",
      playArgs: ["--seed", "42"],
      noDebug: true,
    });
  });

  it("reports provider validation errors through VS Code", async () => {
    const runtime = await loadRuntimeModule();
    expect(runtime).toBeDefined();
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    runtime!.registerFoundryScriptDebugConfigurationProvider(
      context,
      resolveProject,
    );
    const provider = runtimeMock.registerDebugConfigurationProvider.mock
      .calls[0][1] as vscode.DebugConfigurationProvider;

    await expect(
      provider.resolveDebugConfigurationWithSubstitutedVariables?.(undefined, {
        type: "foundryscript",
        request: "attach",
        name: "Attach",
        scene: "main",
      }),
    ).resolves.toBeUndefined();
    expect(runtimeMock.showErrorMessage).toHaveBeenCalledWith(
      'FoundryScript debug configurations support only request "launch".',
    );
  });
});
