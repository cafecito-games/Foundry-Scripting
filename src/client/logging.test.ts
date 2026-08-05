import { describe, expect, it, vi } from "vitest";
import { writeLog } from "./logging.js";

describe("writeLog", () => {
  it("does not let a closed VS Code channel interrupt lifecycle cleanup", () => {
    const output = {
      appendLine: (): never => {
        throw new Error("Channel has been closed");
      },
    };

    expect(() => writeLog(output, "info", "shutdown")).not.toThrow();
  });

  it("warns on stderr when fields cannot be serialized", () => {
    const circular: Record<string, unknown> = { kind: "loop" };
    circular.self = circular;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() =>
      writeLog({ appendLine: () => undefined }, "info", "loop", { circular }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("loop"),
    );

    warn.mockRestore();
  });
});
