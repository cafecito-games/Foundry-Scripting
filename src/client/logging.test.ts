import { describe, expect, it } from "vitest";
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
});
