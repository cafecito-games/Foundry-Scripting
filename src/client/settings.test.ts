import { describe, expect, it } from "vitest";
import {
  ConnectionConfigurationFailure,
  validateConnectionSettings,
} from "./settings.js";

const validSettings = {
  mode: "spawn",
  port: 6005,
  dapPort: 6006,
  enginePath: "foundry",
};

describe("connection settings validation", () => {
  it.each(["spawn", "attach", "auto", "off"] as const)(
    "accepts %s mode snapshots",
    (mode) => {
      expect(validateConnectionSettings({ ...validSettings, mode })).toEqual({
        ...validSettings,
        mode,
      });
    },
  );

  it.each([
    ["unknown mode", { mode: "invalid" }, "foundryScript.lsp.mode", "must be one of"],
    ["non-string engine path", { enginePath: 42 }, "foundryScript.enginePath", "non-empty string"],
    ["blank engine path", { enginePath: "  " }, "foundryScript.enginePath", "non-empty string"],
    ["string LSP port", { port: "6005" }, "foundryScript.lsp.port", "finite integer"],
    ["fractional LSP port", { port: 1.5 }, "foundryScript.lsp.port", "finite integer"],
    ["zero LSP port", { port: 0 }, "foundryScript.lsp.port", "1-65535"],
    ["large LSP port", { port: 65536 }, "foundryScript.lsp.port", "1-65535"],
    ["NaN LSP port", { port: Number.NaN }, "foundryScript.lsp.port", "finite integer"],
    ["infinite LSP port", { port: Number.POSITIVE_INFINITY }, "foundryScript.lsp.port", "finite integer"],
    ["string DAP port", { dapPort: "6006" }, "foundryScript.dap.port", "finite integer"],
    ["fractional DAP port", { dapPort: 1.5 }, "foundryScript.dap.port", "finite integer"],
    ["zero DAP port", { dapPort: 0 }, "foundryScript.dap.port", "1-65535"],
    ["large DAP port", { dapPort: 65536 }, "foundryScript.dap.port", "1-65535"],
    ["NaN DAP port", { dapPort: Number.NaN }, "foundryScript.dap.port", "finite integer"],
    ["infinite DAP port", { dapPort: Number.POSITIVE_INFINITY }, "foundryScript.dap.port", "finite integer"],
    ["identical ports", { dapPort: 6005 }, "foundryScript.lsp.port", "must differ"],
  ])("rejects %s with its actionable setting", (_name, invalid, setting, message) => {
    const failure = expectFailure(() =>
      validateConnectionSettings({ ...validSettings, ...invalid }),
    );

    expect(failure.setting).toBe(setting);
    expect(failure.message).toContain(setting);
    expect(failure.message).toContain(message);
  });
});

function expectFailure(operation: () => unknown): ConnectionConfigurationFailure {
  try {
    operation();
  } catch (error) {
    if (error instanceof ConnectionConfigurationFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("expected connection settings validation to fail");
}
