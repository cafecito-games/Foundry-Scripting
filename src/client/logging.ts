export interface LogOutput {
  appendLine(value: string): void;
}

export type LogLevel = "info" | "warn" | "error";

export function writeLog(
  output: LogOutput,
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    output.appendLine(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event,
        ...fields,
      }),
    );
  } catch {
    // VS Code may close output channels before asynchronous extension cleanup.
  }
}
