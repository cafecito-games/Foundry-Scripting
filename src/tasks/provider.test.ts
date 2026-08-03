import { EventEmitter as NodeEventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import capturedFixtureJson from "./fixtures/lint-report.json";
import type {
  DiagnosticsUnit,
  SourcedDiagnostics,
  SourcedDiagnosticsSnapshot,
} from "../diagnostics/index.js";

const providerMock = vi.hoisted(() => ({
  configuration: new Map<string, unknown>(),
  workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  showErrorMessage: vi.fn(),
  executeCommand: vi.fn(),
  registerTaskProvider: vi.fn(),
  resolveProject: vi.fn(),
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
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

  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }

  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }

  class Diagnostic {
    source: string | undefined;
    code: string | number | undefined;
    constructor(
      readonly range: Range,
      readonly message: string,
      readonly severity: number,
    ) {}
  }

  return {
    EventEmitter,
    CustomExecution,
    Task,
    Position,
    Range,
    Diagnostic,
    DiagnosticSeverity: providerMock.DiagnosticSeverity,
    Uri: {
      file: (fsPath: string) => ({
        fsPath,
        toString: () => `file://${fsPath}`,
      }),
    },
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

vi.mock("../project/workspace.js", () => ({
  createWorkspaceProjectResolver: () => providerMock.resolveProject,
}));

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

  complete(code: number | null): void {
    this.exitCode = code;
    this.emit("close", code, null);
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

const capturedFixture = JSON.stringify(capturedFixtureJson);

function createDiagnosticsHarness() {
  const accept = vi.fn<(update: SourcedDiagnostics) => void>();
  const replace = vi.fn<(snapshot: SourcedDiagnosticsSnapshot) => void>();
  const diagnostics: DiagnosticsUnit = {
    accept: (update) => accept(update),
    replace: (snapshot) => replace(snapshot),
    setLanguageServerConnected: vi.fn(),
    dispose: vi.fn(),
  };
  return { diagnostics, accept, replace };
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
    providerMock.resolveProject.mockReset();
    providerMock.resolveProject.mockImplementation(() =>
      Promise.resolve(
        providerMock.workspaceFolders[0] === undefined
          ? {
              success: false,
              failure: {
                kind: "missing_workspace",
                message: "Open a workspace folder before using Foundry tooling.",
              },
            }
          : {
              success: true,
              project: providerMock.workspaceFolders[0].uri.fsPath,
            },
      ),
    );
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
    const tasks = provider.provideTasks();
    expect(tasks.map((task) => task.definition)).toEqual([
      { type: FOUNDRY_TASK_TYPE, command: "build" },
      { type: FOUNDRY_TASK_TYPE, command: "lint" },
      { type: FOUNDRY_TASK_TYPE, command: "test" },
      { type: FOUNDRY_TASK_TYPE, command: "format" },
      { type: FOUNDRY_TASK_TYPE, command: "run" },
    ]);
    expect(tasks.every((task) => task.problemMatchers.length === 0)).toBe(true);
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
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());

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

  it("uses the shared resolved project for the command and cwd", async () => {
    providerMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/repository" },
    });
    providerMock.resolveProject.mockResolvedValue({
      success: true,
      project: "/workspace/repository/test_project",
    });
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn(() => child.asChildProcess());
    const provider = new FoundryTaskProvider({ spawnProcess });
    const [task] = provider.provideTasks();
    const terminal = await taskTerminal(task);

    terminal.open(undefined);
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());

    expect(spawnProcess).toHaveBeenCalledWith(
      "foundry",
      [
        "project",
        "import",
        "--project",
        "/workspace/repository/test_project",
      ],
      expect.objectContaining({ cwd: "/workspace/repository/test_project" }),
    );
  });

  it("does not spawn when project selection is ambiguous", async () => {
    providerMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/repository" },
    });
    providerMock.resolveProject.mockResolvedValue({
      success: false,
      failure: {
        kind: "ambiguous_projects",
        message: "Multiple Foundry projects were found: a/project.foundry, b/project.foundry.",
        setting: "foundryScript.projectPath",
        candidates: ["a/project.foundry", "b/project.foundry"],
      },
    });
    providerMock.showErrorMessage.mockResolvedValue("Open Settings");
    const spawnProcess = vi.fn();
    const provider = new FoundryTaskProvider({ spawnProcess });
    const [task] = provider.provideTasks();
    const terminal = await taskTerminal(task);
    const closes: Array<number | void> = [];
    terminal.onDidClose?.((code) => closes.push(code));

    terminal.open(undefined);
    await vi.waitFor(() => expect(closes).toEqual([1]));

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(providerMock.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Multiple Foundry projects"),
      "Open Settings",
    );
    expect(providerMock.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "foundryScript.projectPath",
    );
  });

  it("reports an unsupported workspace without spawning Foundry", async () => {
    providerMock.resolveProject.mockResolvedValue({
      success: false,
      failure: {
        kind: "unsupported_workspace",
        message:
          'Workspace scheme "vscode-vfs" is unsupported because native Foundry tooling requires a local file workspace.',
      },
    });
    const spawnProcess = vi.fn();
    const provider = new FoundryTaskProvider({ spawnProcess });
    const [task] = provider.provideTasks();
    const terminal = await taskTerminal(task);
    const writes: string[] = [];
    const closes: Array<number | void> = [];
    terminal.onDidWrite((text) => writes.push(text));
    terminal.onDidClose?.((code) => closes.push(code));

    terminal.open(undefined);
    await vi.waitFor(() => expect(closes).toEqual([1]));

    expect(writes.join("")).toContain(
      'Error: Workspace scheme "vscode-vfs" is unsupported',
    );
    expect(providerMock.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Workspace scheme "vscode-vfs" is unsupported'),
    );
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("does not spawn after closing while project resolution is pending", async () => {
    let finishResolution: ((value: {
      success: true;
      project: string;
    }) => void) | undefined;
    providerMock.resolveProject.mockReturnValue(
      new Promise((resolve) => {
        finishResolution = resolve;
      }),
    );
    const spawnProcess = vi.fn();
    const provider = new FoundryTaskProvider({ spawnProcess });
    const [task] = provider.provideTasks();
    const terminal = await taskTerminal(task);

    terminal.open(undefined);
    terminal.close();
    finishResolution?.({ success: true, project: "/workspace/game" });
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnProcess).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(child.listenerCount("error")).toBeGreaterThan(0));
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

  it("captures only lint stdout while preserving ordered terminal output", async () => {
    providerMock.configuration.set("enginePath", "/opt/foundry");
    providerMock.workspaceFolders.push({
      uri: { fsPath: "/workspace/game" },
    });
    const child = new FakeChildProcess();
    const { diagnostics, accept, replace } = createDiagnosticsHarness();
    const provider = new FoundryTaskProvider({
      diagnostics,
      spawnProcess: () => child.asChildProcess(),
    });
    const lintTask = provider
      .provideTasks()
      .find((task) => task.definition.command === "lint");
    const terminal = await taskTerminal(lintTask as vscode.Task);
    const writes: string[] = [];
    terminal.onDidWrite((text) => writes.push(text));

    terminal.open(undefined);
    await vi.waitFor(() => expect(child.listenerCount("close")).toBeGreaterThan(0));
    const split = Math.floor(capturedFixture.length / 2);
    child.stdout.write(capturedFixture.slice(0, split));
    child.stderr.write("ordinary stderr\n");
    child.stdout.write(capturedFixture.slice(split));
    await Promise.resolve();
    child.complete(1);

    expect(writes.join("")).toBe(
      `${capturedFixture.slice(0, split)}ordinary stderr\r\n${capturedFixture.slice(split)}`,
    );
    expect(accept).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledOnce();
    expect(replace.mock.calls[0]?.[0]).toMatchObject({
      source: "cli",
      entries: [
        { uri: { fsPath: "/workspace/game/tests/grammar/annotations.fs" } },
        { uri: { fsPath: "/workspace/game/tests/grammar/comments.fs" } },
      ],
    });
  });

  it.each([
    { name: "command failure", exitCode: 2, output: capturedFixture },
    { name: "cancellation", exitCode: null, output: capturedFixture },
  ])("does not publish lint diagnostics after $name", async (testCase) => {
    providerMock.workspaceFolders.push({ uri: { fsPath: "/game" } });
    const child = new FakeChildProcess();
    const { diagnostics, accept } = createDiagnosticsHarness();
    const provider = new FoundryTaskProvider({
      diagnostics,
      spawnProcess: () => child.asChildProcess(),
    });
    const lintTask = provider
      .provideTasks()
      .find((task) => task.definition.command === "lint");
    const terminal = await taskTerminal(lintTask as vscode.Task);
    terminal.open(undefined);
    await vi.waitFor(() => expect(child.listenerCount("close")).toBeGreaterThan(0));
    child.stdout.write(testCase.output);
    await Promise.resolve();
    if (testCase.exitCode === null) {
      terminal.close();
    }
    child.complete(testCase.exitCode);

    expect(accept).not.toHaveBeenCalled();
  });

  it("reports malformed successful lint output without clearing diagnostics", async () => {
    providerMock.workspaceFolders.push({ uri: { fsPath: "/game" } });
    const child = new FakeChildProcess();
    const { diagnostics, accept } = createDiagnosticsHarness();
    const provider = new FoundryTaskProvider({
      diagnostics,
      spawnProcess: () => child.asChildProcess(),
    });
    const lintTask = provider
      .provideTasks()
      .find((task) => task.definition.command === "lint");
    const terminal = await taskTerminal(lintTask as vscode.Task);
    const closes: Array<number | void> = [];
    terminal.onDidClose?.((code) => closes.push(code));
    terminal.open(undefined);
    await vi.waitFor(() => expect(child.listenerCount("close")).toBeGreaterThan(0));
    child.stdout.write("not JSON");
    await Promise.resolve();

    child.complete(0);
    await Promise.resolve();

    expect(accept).not.toHaveBeenCalled();
    expect(providerMock.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Could not ingest Foundry lint JSON"),
    );
    expect(closes).toEqual([1]);
  });

  it("does not parse lint JSON after the child process fails to spawn", async () => {
    providerMock.workspaceFolders.push({ uri: { fsPath: "/game" } });
    const child = new FakeChildProcess();
    const { diagnostics, accept } = createDiagnosticsHarness();
    const provider = new FoundryTaskProvider({
      diagnostics,
      spawnProcess: () => child.asChildProcess(),
    });
    const lintTask = provider
      .provideTasks()
      .find((task) => task.definition.command === "lint");
    const terminal = await taskTerminal(lintTask as vscode.Task);
    terminal.open(undefined);
    await vi.waitFor(() => expect(child.listenerCount("error")).toBeGreaterThan(0));

    child.emit(
      "error",
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    await Promise.resolve();

    expect(accept).not.toHaveBeenCalled();
    expect(providerMock.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(providerMock.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Configure foundryScript.enginePath"),
      "Open Settings",
    );
    expect(providerMock.showErrorMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("Could not ingest Foundry lint JSON"),
    );
  });
});
