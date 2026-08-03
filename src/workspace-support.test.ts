import { describe, expect, it } from "vitest";
import { classifyNativeWorkspaceEligibility } from "./workspace-support.js";

describe("native workspace eligibility", () => {
  it("restricts an untrusted window without workspace folders", () => {
    expect(classifyNativeWorkspaceEligibility(false, undefined)).toEqual({
      kind: "restricted",
    });
  });

  it("restricts an untrusted file workspace", () => {
    expect(classifyNativeWorkspaceEligibility(false, ["file"])).toEqual({
      kind: "restricted",
    });
  });

  it("restricts an untrusted virtual workspace", () => {
    expect(classifyNativeWorkspaceEligibility(false, ["vscode-vfs"])).toEqual({
      kind: "restricted",
    });
  });

  it("allows a trusted window without workspace folders", () => {
    expect(classifyNativeWorkspaceEligibility(true, undefined)).toEqual({
      kind: "eligible",
    });
  });

  it("allows a trusted window with an empty workspace-folder list", () => {
    expect(classifyNativeWorkspaceEligibility(true, [])).toEqual({
      kind: "eligible",
    });
  });

  it("allows a trusted file workspace", () => {
    expect(classifyNativeWorkspaceEligibility(true, ["file"])).toEqual({
      kind: "eligible",
    });
  });

  it("identifies the unsupported scheme of a trusted virtual workspace", () => {
    expect(classifyNativeWorkspaceEligibility(true, ["vscode-vfs"])).toEqual({
      kind: "unsupported_scheme",
      scheme: "vscode-vfs",
    });
  });

  it("uses only the first folder when a file folder precedes a virtual folder", () => {
    expect(
      classifyNativeWorkspaceEligibility(true, ["file", "vscode-vfs"]),
    ).toEqual({ kind: "eligible" });
  });

  it("uses only the first folder when a virtual folder precedes a file folder", () => {
    expect(
      classifyNativeWorkspaceEligibility(true, ["vscode-vfs", "file"]),
    ).toEqual({
      kind: "unsupported_scheme",
      scheme: "vscode-vfs",
    });
  });
});
