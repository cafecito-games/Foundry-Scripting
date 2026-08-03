import type { ToolingHostMode } from "../tooling/coordinator.js";

export type LspMode = ToolingHostMode;

export interface ConnectionSettings {
  readonly mode: LspMode;
  readonly port: number;
  readonly dapPort: number;
  readonly enginePath: string;
}

type ConnectionSettingKey =
  | "foundryScript.lsp.mode"
  | "foundryScript.lsp.port"
  | "foundryScript.dap.port"
  | "foundryScript.enginePath";

export class ConnectionConfigurationFailure extends Error {
  constructor(
    readonly setting: ConnectionSettingKey,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionConfigurationFailure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is LspMode {
  return value === "spawn" || value === "attach" || value === "auto" || value === "off";
}

function requirePort(value: unknown, setting: ConnectionSettingKey): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  ) {
    throw new ConnectionConfigurationFailure(
      setting,
      `${setting} must be a finite integer from 1-65535.`,
    );
  }
  return value;
}

export function validateConnectionSettings(value: unknown): ConnectionSettings {
  const settings = isRecord(value) ? value : {};
  if (!isMode(settings.mode)) {
    throw new ConnectionConfigurationFailure(
      "foundryScript.lsp.mode",
      'foundryScript.lsp.mode must be one of "spawn", "attach", "auto", or "off".',
    );
  }
  if (typeof settings.enginePath !== "string" || settings.enginePath.trim() === "") {
    throw new ConnectionConfigurationFailure(
      "foundryScript.enginePath",
      "foundryScript.enginePath must be a non-empty string.",
    );
  }
  const port = requirePort(settings.port, "foundryScript.lsp.port");
  const dapPort = requirePort(settings.dapPort, "foundryScript.dap.port");
  if (port === dapPort) {
    throw new ConnectionConfigurationFailure(
      "foundryScript.lsp.port",
      "foundryScript.lsp.port must differ from foundryScript.dap.port.",
    );
  }
  return {
    mode: settings.mode,
    port,
    dapPort,
    enginePath: settings.enginePath,
  };
}
