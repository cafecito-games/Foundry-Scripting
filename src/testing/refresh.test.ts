import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TestingRefreshCoordinator,
  isRelevantTestingWorkspacePath,
} from "./refresh.js";

describe("testing workspace refresh relevance", () => {
  const project = path.join("", "workspace", "game");

  it.each([
    "player.fs",
    path.join("tests", "unit", "player.test.fs"),
    "project.foundry",
  ])("accepts active-project %s", (relativePath) => {
    expect(
      isRelevantTestingWorkspacePath(project, path.join(project, relativePath)),
    ).toBe(true);
  });

  it.each([
    path.join("", "workspace", "other", "tests", "unit.fs"),
    path.join("", "workspace", "game-other", "unit.fs"),
    path.join(project, "README.md"),
    path.join(project, "nested", "project.foundry"),
    path.join(project, ".git", "generated.fs"),
    path.join(project, ".foundry", "cache.fs"),
    path.join(project, "build", "generated.fs"),
    path.join(project, "dist", "generated.fs"),
    path.join(project, "foundryscript-test-run-owned", "generated.fs"),
  ])("rejects irrelevant path %s", (changedPath) => {
    expect(isRelevantTestingWorkspacePath(project, changedPath)).toBe(false);
  });

  it("matches excluded path components exactly", () => {
    expect(
      isRelevantTestingWorkspacePath(
        project,
        path.join(project, "builder", "distribution.fs"),
      ),
    ).toBe(true);
  });
});

describe("testing refresh coordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst after the last full debounce window", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = new TestingRefreshCoordinator({ refresh });

    coordinator.workspaceChanged();
    await vi.advanceTimersByTimeAsync(200);
    coordinator.workspaceChanged();
    await vi.advanceTimersByTimeAsync(249);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(undefined);
  });

  it("lets explicit refresh cancel a pending debounce and begin immediately", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = new TestingRefreshCoordinator({ refresh });
    const controller = new AbortController();

    coordinator.workspaceChanged();
    await coordinator.explicitRefresh(controller.signal);
    await vi.runAllTimersAsync();

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(controller.signal);
  });

  it("makes cancelled captured timer callbacks inert", async () => {
    let callback: (() => void) | undefined;
    const cancelTimer = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = new TestingRefreshCoordinator({
      refresh,
      scheduleTimer: (scheduled) => {
        callback = scheduled;
        return 7;
      },
      cancelTimer,
    });

    coordinator.workspaceChanged();
    coordinator.cancelPending();
    callback?.();
    await Promise.resolve();

    expect(cancelTimer).toHaveBeenCalledWith(7);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("routes scheduled refresh rejection without an unhandled promise", async () => {
    const failure = new Error("refresh failed");
    const onError = vi.fn();
    let callback: (() => void) | undefined;
    const coordinator = new TestingRefreshCoordinator({
      refresh: vi.fn().mockRejectedValue(failure),
      onError,
      scheduleTimer: (scheduled) => {
        callback = scheduled;
        return 1;
      },
    });

    coordinator.workspaceChanged();
    callback?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("cancels on dispose and stays inert after repeated disposal", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const coordinator = new TestingRefreshCoordinator({ refresh });

    coordinator.workspaceChanged();
    coordinator.dispose();
    coordinator.dispose();
    coordinator.workspaceChanged();
    await coordinator.explicitRefresh();
    await vi.runAllTimersAsync();

    expect(refresh).not.toHaveBeenCalled();
  });
});
