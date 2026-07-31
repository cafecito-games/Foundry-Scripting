import type {
  Message,
  MessageReader,
  NotificationMessage,
} from "vscode-jsonrpc";

export type NotificationInterceptor = (
  method: string,
  params: unknown,
) => boolean;

export function createNotificationInterceptingReader(
  source: MessageReader,
  interceptNotification: NotificationInterceptor,
): MessageReader {
  return {
    onError: source.onError,
    onClose: source.onClose,
    onPartialMessage: source.onPartialMessage,
    listen: (callback) =>
      source.listen((message) => {
        if (
          isNotificationMessage(message) &&
          interceptNotification(message.method, message.params)
        ) {
          return;
        }

        callback(message);
      }),
    dispose: () => source.dispose(),
  };
}

function isNotificationMessage(
  message: Message,
): message is NotificationMessage {
  const candidate = message as Message & {
    readonly id?: unknown;
    readonly method?: unknown;
  };
  return !("id" in candidate) && typeof candidate.method === "string";
}
