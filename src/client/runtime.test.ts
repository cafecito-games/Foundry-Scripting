import { beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedManagerOptions {
  createClient: (endpoint: { host: string; port: number }, signal: AbortSignal) => unknown;
  onStateChange?: (state: { kind: string }) => void;
  output?: unknown;
}

interface CapturedClientOptions {
  signal?: AbortSignal;
  workspaceMismatchHandler?: {
    handleServerWorkspace: (path: string) => Promise<void>;
  };
}

const runtimeMock = vi.hoisted(() => ({
  managerOptions: [] as CapturedManagerOptions[],
  clientOptions: [] as CapturedClientOptions[],
  showWarningMessage: vi.fn(),
  executeCommand: vi.fn(),
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
  FoundryHostLauncher: class {},
}));

vi.mock("./language-client.js", () => ({
  FoundryScriptLanguageClient: class {
    constructor(options: CapturedClientOptions) {
      runtimeMock.clientOptions.push(options);
    }
  },
}));

import { createConnectionManager } from "./runtime.js";

describe("connection runtime", () => {
  beforeEach(() => {
    runtimeMock.managerOptions.length = 0;
    runtimeMock.clientOptions.length = 0;
    runtimeMock.showWarningMessage.mockReset();
    runtimeMock.executeCommand.mockReset();
  });

  it("wires cancellation and workspace mismatch handling into each client", async () => {
    runtimeMock.showWarningMessage.mockResolvedValue("Open Server Project");
    const outputChannel = { appendLine: vi.fn() } as never;
    const onStateChange = vi.fn();
    createConnectionManager(
      outputChannel,
      "/workspace/editor-project",
      onStateChange,
    );
    const signal = new AbortController().signal;

    runtimeMock.managerOptions[0]?.createClient(
      { host: "127.0.0.1", port: 6005 },
      signal,
    );
    const options = runtimeMock.clientOptions[0];
    expect(runtimeMock.managerOptions[0]?.onStateChange).toBe(onStateChange);
    expect(runtimeMock.managerOptions[0]?.output).toBe(outputChannel);
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
});
