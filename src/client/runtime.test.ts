import { beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedManagerOptions {
  createClient: (endpoint: { host: string; port: number }, signal: AbortSignal) => unknown;
  coordinator?: unknown;
  onStateChange?: (state: { kind: string }) => void;
  output?: unknown;
}

interface CapturedClientOptions {
  signal?: AbortSignal;
  onDiagnostics?: (uri: unknown, diagnostics: readonly unknown[]) => void;
  workspaceMismatchHandler?: {
    handleServerWorkspace: (path: string) => Promise<void>;
  };
}

const runtimeMock = vi.hoisted(() => ({
  managerOptions: [] as CapturedManagerOptions[],
  clientOptions: [] as CapturedClientOptions[],
  showWarningMessage: vi.fn(),
  executeCommand: vi.fn(),
  coordinatorOptions: [] as Array<{ launcher?: unknown; onStateChange?: unknown }>,
  launcherInstances: [] as unknown[],
}));

vi.mock("vscode", () => ({
  window: { showWarningMessage: runtimeMock.showWarningMessage },
  commands: { executeCommand: runtimeMock.executeCommand },
  Uri: { file: (path: string) => ({ scheme: "file", fsPath: path }) },
}));

vi.mock("./connection-manager.js", () => ({
  ConnectionManager: class {
    constructor(options: CapturedManagerOptions) {
      runtimeMock.managerOptions.push(options);
    }
  },
}));

vi.mock("./host-launcher.js", () => ({
  FoundryHostLauncher: class {
    constructor() {
      runtimeMock.launcherInstances.push(this);
    }
  },
}));

vi.mock("../tooling/coordinator.js", () => ({
  ToolingHostCoordinator: class {
    constructor(options: { launcher?: unknown; onStateChange?: unknown }) {
      runtimeMock.coordinatorOptions.push(options);
    }
  },
}));

vi.mock("./language-client.js", () => ({
  FoundryScriptLanguageClient: class {
    constructor(options: CapturedClientOptions) {
      runtimeMock.clientOptions.push(options);
    }
  },
}));

import {
  createConnectionManager,
  createToolingHostCoordinator,
} from "./runtime.js";
import type {
  DiagnosticsUnit,
  SourcedDiagnostics,
} from "../diagnostics/index.js";

function noopDiagnostics(): DiagnosticsUnit {
  return {
    accept: vi.fn(),
    setLanguageServerConnected: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("connection runtime", () => {
  beforeEach(() => {
    runtimeMock.managerOptions.length = 0;
    runtimeMock.clientOptions.length = 0;
    runtimeMock.showWarningMessage.mockReset();
    runtimeMock.executeCommand.mockReset();
    runtimeMock.coordinatorOptions.length = 0;
    runtimeMock.launcherInstances.length = 0;
  });

  it("creates one coordinator around one combined-host launcher", () => {
    const outputChannel = { appendLine: vi.fn() };

    const coordinator = createToolingHostCoordinator(outputChannel as never);

    expect(runtimeMock.launcherInstances).toHaveLength(1);
    expect(runtimeMock.coordinatorOptions).toHaveLength(1);
    expect(runtimeMock.coordinatorOptions[0]?.launcher).toBe(
      runtimeMock.launcherInstances[0],
    );
    expect(runtimeMock.coordinatorOptions[0]?.onStateChange).toBeTypeOf(
      "function",
    );
    expect(coordinator).toBeDefined();

    const onStateChange = runtimeMock.coordinatorOptions[0]?.onStateChange as
      | ((state: { kind: string }) => void)
      | undefined;
    onStateChange?.({ kind: "starting" });
    expect(outputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('"event":"tooling.host.state"'),
    );
  });

  it("wires cancellation and workspace mismatch handling into each client", async () => {
    runtimeMock.showWarningMessage.mockResolvedValue("Open Server Project");
    const outputChannel = { appendLine: vi.fn() } as never;
    const onStateChange = vi.fn();
    const coordinator = createToolingHostCoordinator(outputChannel);
    createConnectionManager(
      outputChannel,
      "/workspace/editor-project",
      onStateChange,
      noopDiagnostics(),
      coordinator,
    );
    const signal = new AbortController().signal;

    runtimeMock.managerOptions[0]?.createClient(
      { host: "127.0.0.1", port: 6005 },
      signal,
    );
    const options = runtimeMock.clientOptions[0];
    const state = { kind: "connected" };
    runtimeMock.managerOptions[0]?.onStateChange?.(state);
    expect(onStateChange).toHaveBeenCalledWith(state);
    expect(runtimeMock.managerOptions[0]?.output).toBe(outputChannel);
    expect(runtimeMock.managerOptions[0]?.coordinator).toBe(coordinator);
    expect(options?.signal).toBe(signal);

    await options?.workspaceMismatchHandler?.handleServerWorkspace(
      "/workspace/server-project",
    );

    expect(runtimeMock.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("/workspace/editor-project"),
      "Open Server Project",
    );
    expect(runtimeMock.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      { scheme: "file", fsPath: "/workspace/server-project" },
    );
  });

  it("routes LSP diagnostics and connection state through the shared unit", () => {
    const accept = vi.fn<(update: SourcedDiagnostics) => void>();
    const setLanguageServerConnected = vi.fn<(connected: boolean) => void>();
    const diagnostics: DiagnosticsUnit = {
      accept: (update) => accept(update),
      setLanguageServerConnected: (connected) =>
        setLanguageServerConnected(connected),
      dispose: vi.fn(),
    };
    createConnectionManager(
      { appendLine: vi.fn() } as never,
      "/workspace/game",
      vi.fn(),
      diagnostics,
      createToolingHostCoordinator({ appendLine: vi.fn() } as never),
    );

    runtimeMock.managerOptions[0]?.onStateChange?.({ kind: "connected" });
    runtimeMock.managerOptions[0]?.onStateChange?.({ kind: "retrying" });
    const signal = new AbortController().signal;
    runtimeMock.managerOptions[0]?.createClient(
      { host: "127.0.0.1", port: 6005 },
      signal,
    );
    const uri = { fsPath: "/workspace/game/player.fs" };
    const lspDiagnostics = [{ message: "LSP error" }];
    runtimeMock.clientOptions[0]?.onDiagnostics?.(uri, lspDiagnostics);

    expect(setLanguageServerConnected.mock.calls).toEqual([[true], [false]]);
    expect(accept).toHaveBeenCalledWith({
      source: "lsp",
      uri,
      diagnostics: lspDiagnostics,
    });
  });
});
