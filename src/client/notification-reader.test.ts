import { describe, expect, it, vi } from "vitest";
import type {
  DataCallback,
  Disposable,
  Event,
  Message,
  MessageReader,
  NotificationMessage,
  PartialMessageInfo,
  ResponseMessage,
} from "vscode-jsonrpc";
import { createNotificationInterceptingReader } from "./notification-reader.js";

const neverEvent = (() => ({ dispose: () => undefined })) as Event<never>;

class FakeMessageReader implements MessageReader {
  readonly onError = neverEvent as Event<Error>;
  readonly onClose = neverEvent as Event<void>;
  readonly onPartialMessage = neverEvent as Event<PartialMessageInfo>;
  readonly dispose = vi.fn();
  private callback: DataCallback | undefined;

  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    return { dispose: vi.fn() };
  }

  emit(message: Message): void {
    this.callback?.(message);
  }
}

describe("notification-intercepting message reader", () => {
  it("consumes selected notifications and preserves every unrelated frame in order", () => {
    const source = new FakeMessageReader();
    const interceptNotification = vi.fn(
      (method: string) => method === "fs_client/changeWorkspace",
    );
    const reader = createNotificationInterceptingReader(
      source,
      interceptNotification,
    );
    const received: Message[] = [];
    reader.listen((message) => received.push(message));
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    };
    const unrelatedNotification = {
      jsonrpc: "2.0",
      method: "telemetry/event",
      params: { ready: true },
    };
    const workspaceNotification = {
      jsonrpc: "2.0",
      method: "fs_client/changeWorkspace",
      params: { path: "/projects/server-project" },
    };
    const initializeResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: {} },
    };

    source.emit(initializeRequest);
    source.emit(unrelatedNotification);
    source.emit(workspaceNotification);
    source.emit(initializeResponse);

    expect(interceptNotification).toHaveBeenCalledTimes(2);
    expect(interceptNotification).toHaveBeenNthCalledWith(
      1,
      "telemetry/event",
      { ready: true },
    );
    expect(interceptNotification).toHaveBeenNthCalledWith(
      2,
      "fs_client/changeWorkspace",
      { path: "/projects/server-project" },
    );
    expect(received).toEqual([
      initializeRequest,
      unrelatedNotification,
      initializeResponse,
    ]);
    expect(received[0]).toBe(initializeRequest);
    expect(received[1]).toBe(unrelatedNotification);
    expect(received[2]).toBe(initializeResponse);
  });

  it("intercepts initialization-time notifications before the initialize response", () => {
    const source = new FakeMessageReader();
    const events: string[] = [];
    const reader = createNotificationInterceptingReader(
      source,
      (method, params) => {
        events.push(`${method}:${JSON.stringify(params)}`);
        return true;
      },
    );
    reader.listen((message) => {
      events.push(`forward:${"id" in message ? String(message.id) : "other"}`);
    });

    const warning: NotificationMessage = {
      jsonrpc: "2.0",
      method: "window/showMessage",
      params: { type: 2, message: "workspace warning" },
    };
    const workspaceChange: NotificationMessage = {
      jsonrpc: "2.0",
      method: "fs_client/changeWorkspace",
      params: { path: "/projects/server-project" },
    };
    const initializeResponse: ResponseMessage = {
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: {} },
    };

    source.emit(warning);
    source.emit(workspaceChange);
    source.emit(initializeResponse);

    expect(events).toEqual([
      'window/showMessage:{"type":2,"message":"workspace warning"}',
      'fs_client/changeWorkspace:{"path":"/projects/server-project"}',
      "forward:1",
    ]);
  });

  it("disposes the underlying reader", () => {
    const source = new FakeMessageReader();
    const reader = createNotificationInterceptingReader(
      source,
      () => false,
    );

    reader.dispose();

    expect(source.dispose).toHaveBeenCalledOnce();
  });
});
