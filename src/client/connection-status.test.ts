import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTION_ACTIONS_COMMAND,
  ConnectionStatusController,
  OPEN_LOG_ACTION,
  OPEN_SETTINGS_ACTION,
  RECONNECT_ACTION,
  renderConnectionState,
} from "./connection-status.js";

describe("connection status presentation", () => {
  it("renders every lifecycle state truthfully", () => {
    expect(renderConnectionState({ kind: "connected" })).toMatchObject({
      text: "$(plug) FoundryScript: Connected",
    });
    expect(renderConnectionState({ kind: "spawning" })).toMatchObject({
      text: "$(loading~spin) FoundryScript: Spawning",
    });
    expect(
      renderConnectionState({
        kind: "retrying",
        attempt: 3,
        maxAttempts: 5,
        delayMs: 2_000,
      }),
    ).toEqual({
      text: "$(sync~spin) FoundryScript: Retrying 3/5",
      tooltip: "Reconnect attempt 3 of 5 starts in 2 seconds.",
    });
    expect(
      renderConnectionState({
        kind: "retrying",
        attempt: 1,
        maxAttempts: 5,
        delayMs: 0,
      }),
    ).toEqual({
      text: "$(sync~spin) FoundryScript: Retrying 1/5",
      tooltip: "Reconnect attempt 1 of 5 starts immediately.",
    });
    expect(renderConnectionState({ kind: "disconnected" })).toMatchObject({
      text: "$(debug-disconnect) FoundryScript: Disconnected",
    });
    expect(renderConnectionState({ kind: "off" })).toMatchObject({
      text: "$(circle-slash) FoundryScript: Off",
    });
  });
});

describe("connection status actions", () => {
  const item = { text: "", tooltip: "", command: undefined as string | undefined };
  const showQuickPick = vi.fn();
  const reconnectNow = vi.fn().mockResolvedValue(undefined);
  const openLog = vi.fn();
  const openSettings = vi.fn().mockResolvedValue(undefined);
  let controller: ConnectionStatusController;

  beforeEach(() => {
    item.text = "";
    item.tooltip = "";
    item.command = undefined;
    showQuickPick.mockReset();
    reconnectNow.mockClear();
    openLog.mockClear();
    openSettings.mockClear();
    controller = new ConnectionStatusController(item, {
      showQuickPick,
      reconnectNow,
      openLog,
      openSettings,
    });
  });

  it("updates the item and offers immediate reconnect plus the log", async () => {
    controller.update({ kind: "connected" });
    showQuickPick.mockResolvedValue(RECONNECT_ACTION);

    await controller.showActions();

    expect(item.command).toBe(CONNECTION_ACTIONS_COMMAND);
    expect(item.text).toContain("Connected");
    expect(showQuickPick).toHaveBeenCalledWith(
      [RECONNECT_ACTION, OPEN_LOG_ACTION],
      { placeHolder: "FoundryScript language server" },
    );
    expect(reconnectNow).toHaveBeenCalledOnce();
  });

  it("opens the log from a non-off state", async () => {
    controller.update({ kind: "disconnected" });
    showQuickPick.mockResolvedValue(OPEN_LOG_ACTION);

    await controller.showActions();

    expect(openLog).toHaveBeenCalledOnce();
  });

  it("keeps off truthful and offers settings plus the log", async () => {
    controller.update({ kind: "off" });
    showQuickPick.mockResolvedValue(OPEN_SETTINGS_ACTION);

    await controller.showActions();

    expect(showQuickPick).toHaveBeenCalledWith(
      [OPEN_SETTINGS_ACTION, OPEN_LOG_ACTION],
      { placeHolder: "FoundryScript language server" },
    );
    expect(reconnectNow).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledOnce();
  });
});
