export interface LogOutput {
  appendLine(value: string): void;
}

export type LogLevel = "info" | "warn" | "error";

// Error-aware JSON replacer: surfaces circular-reference and other
// serialization failures instead of silently dropping the log line.
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.cause === undefined ? {} : { cause: value.cause }),
      ...(value.stack === undefined ? {} : { stack: value.stack }),
    };
  }
  return value;
}

export function writeLog(
  output: LogOutput,
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    output.appendLine(
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          level,
          event,
          ...fields,
        },
        errorReplacer,
      ),
    );
  } catch (serializationError) {
    // The channel itself may be closed during async teardown; either way,
    // surface the programmer-visible serialization failure to stderr so a
    // circular field or bad replacer does not vanish silently.
    const reason =
      serializationError instanceof Error
        ? serializationError.message
        : String(serializationError);
    console.warn(
      `FoundryScript logging failed to serialize event "${event}": ${reason}`,
    );
  }
}
