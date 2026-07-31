import { describe, expect, it, vi } from "vitest";
import {
  OPEN_SERVER_WORKSPACE_ACTION,
  RAW_WORKSPACE_MISMATCH_WARNING,
  createWorkspaceMismatchHandler,
  workspacePathsMatch,
} from "./workspace-mismatch.js";

describe("workspace path comparison", () => {
  it("normalizes separators, dot segments, and trailing separators", () => {
    expect(
      workspacePathsMatch("/projects/game/", "/projects/./game", {
        platform: "linux",
        realpath: (value) => value,
      }),
    ).toBe(true);
  });

  it("compares Windows paths without case sensitivity", () => {
    expect(
      workspacePathsMatch("C:\\Projects\\Game", "c:/projects/game/", {
        platform: "win32",
        realpath: (value) => value,
      }),
    ).toBe(true);
  });

  it("uses canonical paths when both locations can be resolved", () => {
    const aliases = new Map([
      ["/projects/game-link", "/projects/game"],
      ["/projects/game", "/projects/game"],
    ]);

    expect(
      workspacePathsMatch("/projects/game-link", "/projects/game", {
        platform: "linux",
        realpath: (value) => aliases.get(value) ?? value,
      }),
    ).toBe(true);
  });

  it("does not treat a missing path as the process working directory", () => {
    expect(
      workspacePathsMatch("", "/projects/game", {
        platform: "linux",
        realpath: (value) => value,
      }),
    ).toBe(false);
  });
});

describe("workspace mismatch handling", () => {
  it("suppresses only the exact raw engine warning", () => {
    const handler = createWorkspaceMismatchHandler({
      workspacePath: "/projects/vscode-project",
      showWarningMessage: vi.fn(),
      openFolder: vi.fn(),
    });

    expect(
      handler.shouldSuppressServerMessage({
        type: 2,
        message: RAW_WORKSPACE_MISMATCH_WARNING,
      }),
    ).toBe(true);
    expect(
      handler.shouldSuppressServerMessage({
        type: 3,
        message: RAW_WORKSPACE_MISMATCH_WARNING,
      }),
    ).toBe(false);
    expect(
      handler.shouldSuppressServerMessage({
        type: 2,
        message: "A different warning",
      }),
    ).toBe(false);
  });

  it("does not show a message when normalized workspace paths match", async () => {
    const showWarningMessage = vi.fn();
    const handler = createWorkspaceMismatchHandler({
      workspacePath: "/projects/game/",
      showWarningMessage,
      openFolder: vi.fn(),
      pathComparison: {
        platform: "linux",
        realpath: (value) => value,
      },
    });

    await handler.handleServerWorkspace("/projects/./game");

    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it("shows one actionable message naming both mismatched paths", async () => {
    const showWarningMessage = vi.fn().mockResolvedValue(undefined);
    const handler = createWorkspaceMismatchHandler({
      workspacePath: "/projects/vscode-project",
      showWarningMessage,
      openFolder: vi.fn(),
    });

    await handler.handleServerWorkspace("/projects/server-project");

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    const [message, action] = showWarningMessage.mock.calls[0] as [
      string,
      string,
    ];
    expect(message).toContain("/projects/vscode-project");
    expect(message).toContain("/projects/server-project");
    expect(action).toBe(OPEN_SERVER_WORKSPACE_ACTION);
  });

  it("opens the server project when the user chooses the action", async () => {
    const openFolder = vi.fn().mockResolvedValue(undefined);
    const handler = createWorkspaceMismatchHandler({
      workspacePath: "/projects/vscode-project",
      showWarningMessage: vi
        .fn()
        .mockResolvedValue(OPEN_SERVER_WORKSPACE_ACTION),
      openFolder,
    });

    await handler.handleServerWorkspace("/projects/server-project");

    expect(openFolder).toHaveBeenCalledOnce();
    expect(openFolder).toHaveBeenCalledWith("/projects/server-project");
  });

  it("suppresses repeated signals while the first message is pending", async () => {
    let resolvePrompt: ((choice: string | undefined) => void) | undefined;
    const showWarningMessage = vi.fn(
      () =>
        new Promise<string | undefined>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    const handler = createWorkspaceMismatchHandler({
      workspacePath: "/projects/vscode-project",
      showWarningMessage,
      openFolder: vi.fn(),
    });

    const first = handler.handleServerWorkspace("/projects/server-project");
    const repeated = handler.handleServerWorkspace("/projects/server-project");

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    resolvePrompt?.(undefined);
    await Promise.all([first, repeated]);
  });

  it("suppresses repeats for the session after the message is acknowledged", async () => {
    const showWarningMessage = vi.fn().mockResolvedValue(undefined);
    const handler = createWorkspaceMismatchHandler({
      workspacePath: "/projects/vscode-project",
      showWarningMessage,
      openFolder: vi.fn(),
    });

    await handler.handleServerWorkspace("/projects/server-project");
    await handler.handleServerWorkspace("/projects/another-server-project");

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
  });
});
