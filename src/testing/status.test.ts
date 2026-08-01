import { describe, expect, it, vi } from "vitest";
import { TestAdapterFailure, type TestAdapterFailureKind } from "./adapter.js";
import {
  TestingStatusController,
  renderTestingState,
  type TestingStatusItem,
} from "./status.js";

describe("testing status", () => {
  it("renders all negotiated framework metadata", () => {
    expect(
      renderTestingState({
        kind: "ready",
        adapter: {
          protocolVersion: 1,
          framework: {
            id: "neutral-spec",
            name: "Neutral Spec",
            version: "2.4.0",
          },
          extensions: ["neutral.coverage", "neutral.watch"],
        },
        discoveryErrorCount: 0,
      }),
    ).toEqual({
      text: "$(beaker) Tests: Neutral Spec",
      tooltip:
        "Framework: Neutral Spec\n" +
        "Framework ID: neutral-spec\n" +
        "Framework version: 2.4.0\n" +
        "Protocol version: 1\n" +
        "Extensions: neutral.coverage, neutral.watch",
    });
  });

  it("renders negotiating and extension-free ready states", () => {
    expect(
      renderTestingState({
        kind: "negotiating",
        runner: "res://tests/runner.fs",
      }),
    ).toEqual({
      text: "$(loading~spin) Tests: Negotiating",
      tooltip: "Negotiating Foundry test adapter res://tests/runner.fs.",
    });
    expect(
      renderTestingState({
        kind: "discovering",
        adapter: {
          protocolVersion: 1,
          framework: { id: "neutral", name: "Neutral", version: "1" },
          extensions: [],
        },
      }),
    ).toEqual({
      text: "$(loading~spin) Tests: Discovering",
      tooltip: "Discovering tests with Neutral using protocol version 1.",
    });
    expect(
      renderTestingState({
        kind: "ready",
        adapter: {
          protocolVersion: 1,
          framework: { id: "neutral", name: "Neutral", version: "1" },
          extensions: [],
        },
        discoveryErrorCount: 0,
      }).tooltip,
    ).toContain("Extensions: none");
  });

  it.each([
    { count: 1, noun: "error" },
    { count: 3, noun: "errors" },
  ])("renders $count represented discovery $noun", ({ count, noun }) => {
    expect(
      renderTestingState({
        kind: "ready",
        adapter: {
          protocolVersion: 1,
          framework: { id: "neutral", name: "Neutral", version: "1" },
          extensions: [],
        },
        discoveryErrorCount: count,
      }),
    ).toEqual({
      text: `$(warning) Tests: Neutral (${count} discovery ${noun})`,
      tooltip:
        "Framework: Neutral\n" +
        "Framework ID: neutral\n" +
        "Framework version: 1\n" +
        "Protocol version: 1\n" +
        "Extensions: none\n" +
        `Discovery errors: ${count}`,
    });
  });

  it.each([
    "missing_runner",
    "invalid_runner",
    "missing_engine",
    "missing_project",
    "malformed_capabilities",
    "incompatible_adapter",
    "process_failed",
    "legacy_runner",
    "spawn_failed",
    "read_failed",
    "invalid_protocol_version",
    "malformed_discovery",
    "incomplete_discovery",
    "discovery_exit_mismatch",
  ] as TestAdapterFailureKind[])("surfaces actionable %s failures", (kind) => {
    const failure = new TestAdapterFailure(kind, `Action required for ${kind}.`);

    expect(renderTestingState({ kind: "error", failure })).toEqual({
      text: "$(warning) Tests: Unavailable",
      tooltip: `Action required for ${kind}.`,
    });
  });

  it("disposes status while disabled and creates a fresh item when re-enabled", () => {
    const items: TestingStatusItem[] = [];
    const createItem = vi.fn(() => {
      const item: TestingStatusItem = {
        text: "",
        tooltip: "",
        show: vi.fn(),
        dispose: vi.fn(),
      };
      items.push(item);
      return item;
    });
    const controller = new TestingStatusController(createItem);

    controller.update({
      kind: "negotiating",
      runner: "res://tests/runner.fs",
    });
    controller.update({ kind: "disabled" });
    controller.update({
      kind: "error",
      failure: new TestAdapterFailure("legacy_runner", "Upgrade the runner."),
    });
    controller.dispose();

    expect(createItem).toHaveBeenCalledTimes(2);
    expect(items[0]?.show).toHaveBeenCalledOnce();
    expect(items[0]?.dispose).toHaveBeenCalledOnce();
    expect(items[1]?.show).toHaveBeenCalledOnce();
    expect(items[1]?.dispose).toHaveBeenCalledOnce();
  });
});
