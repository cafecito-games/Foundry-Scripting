import { EventEmitter as NodeEventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";

const providerMock = vi.hoisted(() => ({
  configuration: new Map<string, unknown>(),
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  showErrorMessage: vi.fn(),
  executeCommand: vi.fn(),
  registerTaskProvider: vi.fn(),
}));

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }

  class CustomExecution {
    constructor(
      readonly callback: () => Promise<vscode.Pseudoterminal>,
    ) {}
  }

  class Task {
    group: unknown;
    constructor(
      readonly definition: vscode.TaskDefinition,
      readonly scope: vscode.TaskScope,
      readonly name: string,
      readonly source: string,
      readonly execution: vscode.CustomExecution,
      readonly problemMatchers: string[],
    ) {}
  }

  return {
    EventEmitter,
    CustomExecution,
    Task,
    TaskScope: { Workspace: 1 },
    TaskGroup: { Build: { id: "build" }, Test: { id: "test" } },
    workspace: {
      get workspaceFolders() {
        return providerMock.workspaceFolders;
      },
      getConfiguration: () => ({
        get: (key: string, defaultValue: unknown) =>
          providerMock.configuration.get(key) ?? defaultValue,
      }),
    },
    window: { showErrorMessage: providerMock.showErrorMessage },
    commands: { executeCommand: providerMock.executeCommand },
    tasks: { registerTaskProvider: providerMock.registerTaskProvider },
  };
});

import {
  FOUNDRY_TASK_TYPE,
  FoundryTaskProvider,
  registerFoundryTaskProvider,
} from "./provider.js";

class FakeChildProcess extends NodeEventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly kill = vi.fn(() => true);

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function taskTerminal(task: vscode.Task): Promise<vscode.Pseudoterminal> {
  const execution = task.execution as vscode.CustomExecution & {
    callback: () => Promise<vscode.Pseudoterminal>;
  };
  return execution.callback();
}

describe("Foundry task provider", () => {
  beforeEach(() => {
    providerMock.configuration.clear();
    providerMock.workspaceFolders.length = 0;
    providerMock.showErrorMessage.mockReset();
    providerMock.executeCommand.mockReset();
    providerMock.registerTaskProvider.mockReset();
  });

  it("registers and provides the five Foundry CLI tasks", () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    registerFoundryTaskProvider(context);

    expect(providerMock.registerTaskProvider).toHaveBeenCalledWith(
      FOUNDRY_TASK_TYPE,
      expect.any(FoundryTaskProvider),
    );
    expect(context.subscriptions).toHaveLength(1);

    const provider = new FoundryTaskProvider();
    expect(provider.provideTasks().map((task) => task.definition)).toEqual([
      { type: FOUNDRY_TASK_TYPE, command: "build" },
      { type: FOUNDRY_TASK_TYPE, command: "lint" },
      { type: FOUNDRY_TASK_TYPE, command: "test" },
      { type: FOUNDRY_TASK_TYPE, command: "format" },
      { type: FOUNDRY_TASK_TYPE, command: "run" },
    ]);
  });

  it("resolves valid tasks.json definitions without replacing the definition", () => {
    const provider = new FoundryTaskProvider();
    const definition = { type: FOUNDRY_TASK_TYPE, command: "test", extra: true };
    const unresolved = { definition } as unknown as vscode.Task;

    const resolved = provider.resolveTask(unresolved);

    expect(resolved?.definition).toBe(definition);
    expect(
      provider.resolveTask({
        definition: { type: FOUNDRY_TASK_TYPE, command: "unknown" },
      } as unknown as vscode.Task),
    ).toBeUndefined();
  });

  it("executes a resolved test task with configured project and runner", async () => {
    providerMock.configuration.set("enginePath", "/opt/foundry");
    providerMock.configuration.set("test.runner", "res://tests/runner.fs");
    providerMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child.asChildProcess());
    const provider = new FoundryTaskProvider({ spawnProcess });
    const definition = { type: FOUNDRY_TASK_TYPE, command: "test" };
    const task = provider.resolveTask({ definition } as unknown as vscode.Task);

    const terminal = await taskTerminal(task as vscode.Task);
    terminal.open(undefined);

    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/foundry",
      [
        "project",
        "test",
        "--project",
        "/workspace/game",
        "--runner",
        "res://tests/runner.fs",
      ],
      {
        cwd: "/workspace/game",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  });

  it.each([
    {
      name: "engine",
      setup: () => {
        providerMock.configuration.set("enginePath", "");
        providerMock.workspaceFolders.push({ uri: { fsPath: "/game" } });
      },
      command: "build",
      action: "Open Settings",
      vscodeCommand: [
        "workbench.action.openSettings",
        "foundryScript.enginePath",
      ],
    },
    {
      name: "project",
      setup: () => undefined,
      command: "build",
      action: "Open Folder",
      vscodeCommand: ["workbench.action.files.openFolder"],
    },
    {
      name: "test runner",
      setup: () => {
        providerMock.workspaceFolders.push({ uri: { fsPath: "/game" } });
      },
      command: "test",
      action: "Open Settings",
      vscodeCommand: [
        "workbench.action.openSettings",
        "foundryScript.test.runner",
      ],
    },
  ])("offers an actionable fix for a missing $name", async (testCase) => {
    testCase.setup();
    providerMock.showErrorMessage.mockResolvedValue(testCase.action);
    const provider = new FoundryTaskProvider();
    const [task] = provider
      .provideTasks()
      .filter((candidate) => candidate.definition.command === testCase.command);

    const terminal = await taskTerminal(task);
    terminal.open(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(providerMock.showErrorMessage).toHaveBeenCalledWith(
      expect.any(String),
      testCase.action,
    );
    expect(providerMock.executeCommand).toHaveBeenCalledWith(
      ...testCase.vscodeCommand,
    );
  });

  it("offers engine settings when the configured executable cannot start", async () => {
    providerMock.configuration.set("enginePath", "/missing/foundry");
    providerMock.workspaceFolders.push({ uri: { fsPath: "/game" } });
    providerMock.showErrorMessage.mockResolvedValue("Open Settings");
    const child = new FakeChildProcess();
    const provider = new FoundryTaskProvider({
      spawnProcess: () => child.asChildProcess(),
    });
    const [task] = provider.provideTasks();
    const terminal = await taskTerminal(task);

    terminal.open(undefined);
    child.emit(
      "error",
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(providerMock.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "foundryScript.enginePath",
    );
  });
});
