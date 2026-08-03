import path from "node:path";
import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { TestAdapterFailure } from "./adapter.js";
import type { TestDiscoveryModel, TestDiscoveryTest } from "./discovery.js";
import type {
  TestExecutionObserver,
  TestExecutionRequest,
  TestExecutionResult,
} from "./executor.js";
import {
  FoundryTestRunProfile,
  type FoundryTestRunProfileOptions,
} from "./profile.js";
import type { FoundryTapPoint } from "./report.js";

describe("Foundry VS Code run profile", () => {
  it("creates one run synchronously, selects exact leaves, then enqueues before starting", async () => {
    const harness = createHarness();
    const execution = harness.profile.run(
      request([harness.items.get("suite-a")!], [harness.items.get("test-b")!]),
      token(),
    );

    expect(harness.controller.createTestRun).toHaveBeenCalledOnce();
    await execution;

    expect(harness.executed?.leaves.map((leaf) => leaf.id)).toEqual(["test-a"]);
    expect(harness.execute.mock.calls[0]?.[3]).toBe(harness.run);
    expect(harness.run.calls).toEqual([
      "enqueued:test-a",
      "started:test-a",
      "passed:test-a:5",
      "end",
    ]);
  });

  it("routes colliding labels solely through _foundry.id", async () => {
    const harness = createHarness({ points: [passPoint("test-b", 9)] });

    await harness.profile.run(request([harness.items.get("test-b")!]), token());

    expect(harness.run.passed).toHaveBeenCalledWith(
      harness.items.get("test-b"),
      9,
    );
    expect(harness.run.passed).not.toHaveBeenCalledWith(
      harness.items.get("test-a"),
      expect.anything(),
    );
  });

  it("invalidates the full plan when a callback reports an unknown ID", async () => {
    const harness = createHarness({
      points: [passPoint("test-a", 5), passPoint("unknown-id", 1)],
    });

    await harness.profile.run(request(undefined), token());

    expect(harness.run.passed).toHaveBeenCalledWith(harness.items.get("test-a"), 5);
    expect(harness.run.errored).toHaveBeenCalledTimes(2);
    expect(harness.run.appendOutput).toHaveBeenCalledWith(
      expect.stringContaining("unknown test ID"),
    );
  });

  it.each([
    { detail: "", method: "failed" },
    { detail: "discovery_error", method: "errored" },
    { detail: "runtime_error", method: "errored" },
    { detail: "timed_out", method: "errored" },
    { detail: "aborted", method: "errored" },
    { detail: "setup_error", method: "errored" },
  ] as const)("maps not ok status detail '$detail' to $method", async ({ detail, method }) => {
    const point = failPoint("test-a", detail);
    const harness = createHarness({ points: [point], exitCode: 1 });

    await harness.profile.run(request([harness.items.get("test-a")!]), token());

    expect(harness.run[method]).toHaveBeenCalledWith(
      harness.items.get("test-a"),
      expect.objectContaining({ message: "boom" }),
      17,
    );
  });

  it("maps skips and one-based locations", async () => {
    const skip = passPoint("test-b", 1, "pending");
    const failure = {
      ...failPoint("test-a", ""),
      location: {
        fileName: "res://tests/example.fs",
        lineNumber: 5,
        columnNumber: 2,
      },
    };
    const harness = createHarness({ points: [failure, skip], exitCode: 1 });

    await harness.profile.run(request(undefined), token());

    expect(harness.run.skipped).toHaveBeenCalledWith(harness.items.get("test-b"));
    expect(harness.createLocation).toHaveBeenCalledWith(
      path.join("/workspace/game", "tests/example.fs"),
      4,
      1,
    );
    expect(harness.run.failed).toHaveBeenCalledWith(
      harness.items.get("test-a"),
      expect.objectContaining({ location: { line: 4, character: 1 } }),
      17,
    );
  });

  it("appends application output as CRLF without treating it as TAP", async () => {
    const harness = createHarness({
      output: [
        ['application {"not":"tap"}\n', "stdout"],
        ["warning\r\n", "stderr"],
      ],
    });

    await harness.profile.run(request([harness.items.get("test-a")!]), token());

    expect(harness.run.appendOutput.mock.calls).toEqual([
      ['application {"not":"tap"}\r\n'],
      ["warning\r\n"],
    ]);
  });

  it("preserves completed results only for genuine cancellation and skips the remainder", async () => {
    const harness = createHarness({
      points: [passPoint("test-a", 5)],
      cancelled: true,
    });

    await harness.profile.run(request(undefined), token());

    expect(harness.run.passed).toHaveBeenCalledWith(harness.items.get("test-a"), 5);
    expect(harness.run.skipped).toHaveBeenCalledWith(harness.items.get("test-b"));
    expect(harness.run.errored).not.toHaveBeenCalled();
    expect(harness.run.appendOutput).toHaveBeenCalledWith(
      "Foundry test run cancelled by user; completed results were retained.\r\n",
    );
  });

  it("applies selection and TestRun ownership to a DAP-capable Debug executor", async () => {
    const harness = createHarness({
      points: [passPoint("test-a", 5)],
      cancelled: true,
    });

    await harness.profile.run(
      request([harness.items.get("suite-a")!], [harness.items.get("test-b")!]),
      token(),
    );

    expect(harness.executed?.leaves.map((leaf) => leaf.id)).toEqual(["test-a"]);
    expect(harness.execute.mock.calls[0]?.[3]).toBe(harness.run);
    expect(harness.run.passed).toHaveBeenCalledWith(
      harness.items.get("test-a"),
      5,
    );
    expect(harness.run.passed).not.toHaveBeenCalledWith(
      harness.items.get("test-b"),
      expect.anything(),
    );
  });

  it("includes TAP diagnostic codes and line context for invalid completion", async () => {
    const harness = createHarness({
      points: [passPoint("test-a", 5)],
      invalid: true,
      invalidCodes: ["report.point"],
      invalidDiagnostics: ["Line 9 is not a conforming test point."],
    });

    await harness.profile.run(request(undefined), token());

    expect(harness.run.appendOutput).toHaveBeenCalledWith(
      expect.stringContaining(
        "[report.point] Line 9 is not a conforming test point.",
      ),
    );
    expect(harness.run.errored).toHaveBeenCalledTimes(2);
  });

  it("formats structured executor failures for the full selected plan", async () => {
    const failure = new TestAdapterFailure(
      "readiness_timeout",
      "No report bytes arrived before the deadline.",
      {
        phase: "execution",
        exitCode: 137,
        stdout: "ordinary output",
        stderr: "fatal detail",
      },
    );
    const harness = createHarness({ thrown: failure });

    await harness.profile.run(request(undefined), token());

    const output = String(harness.run.appendOutput.mock.calls[0]?.[0]);
    expect(output).toContain("[readiness_timeout]");
    expect(output).toContain("Phase: execution");
    expect(output).toContain("Exit code: 137");
    expect(output).toContain("stdout: ordinary output");
    expect(output).toContain("stderr: fatal detail");
    expect(harness.run.errored).toHaveBeenCalledTimes(2);
  });

  it("invalidates every selected state after a non-cancellation infrastructure failure", async () => {
    const harness = createHarness({
      points: [passPoint("test-a", 5)],
      invalid: true,
    });

    await harness.profile.run(request(undefined), token());

    expect(harness.run.passed).toHaveBeenCalledWith(harness.items.get("test-a"), 5);
    expect(harness.run.errored).toHaveBeenCalledTimes(2);
    expect(harness.run.errored.mock.calls[0]?.[0]).toBe(
      harness.items.get("test-a"),
    );
    expect(
      (harness.run.errored.mock.calls[0]?.[1] as { message: string }).message,
    ).toContain("infrastructure");
    expect(harness.run.appendOutput).toHaveBeenCalledWith(
      expect.stringContaining("infrastructure"),
    );
  });

  it("ends exactly once without spawning for an empty plan or unavailable context", async () => {
    const empty = createHarness();
    await empty.profile.run(request([]), token());
    expect(empty.execute).not.toHaveBeenCalled();
    expect(empty.run.end).toHaveBeenCalledOnce();

    const unavailable = createHarness({ ready: false });
    await unavailable.profile.run(request(undefined), token());
    expect(unavailable.execute).not.toHaveBeenCalled();
    expect(unavailable.run.appendOutput).toHaveBeenCalledWith(
      expect.stringContaining("not ready"),
    );
    expect(unavailable.run.end).toHaveBeenCalledOnce();

    const stale = createHarness({ stale: true });
    await stale.profile.run(request(undefined), token());
    expect(stale.execute).not.toHaveBeenCalled();
    expect(stale.run.appendOutput).toHaveBeenCalledWith(
      expect.stringContaining("not ready"),
    );
    expect(stale.run.end).toHaveBeenCalledOnce();
  });
});

interface Harness {
  readonly controller: { readonly createTestRun: Mock<() => FakeRun> };
  readonly run: FakeRun;
  readonly items: Map<string, vscode.TestItem>;
  readonly execute: Mock<FoundryTestRunProfileOptions["execute"]>;
  readonly createLocation: Mock<FoundryTestRunProfileOptions["createLocation"]>;
  profile: FoundryTestRunProfile;
  executed: TestExecutionRequest | undefined;
}

function createHarness(
  options: {
    readonly points?: readonly FoundryTapPoint[];
    readonly output?: readonly (readonly [string, "stdout" | "stderr"])[];
    readonly exitCode?: number;
    readonly cancelled?: boolean;
    readonly invalid?: boolean;
    readonly ready?: boolean;
    readonly stale?: boolean;
    readonly thrown?: Error;
    readonly invalidCodes?: readonly string[];
    readonly invalidDiagnostics?: readonly string[];
  } = {},
): Harness {
  const model = discoveryModel();
  const items = new Map(
    model.items.map((item) => [item.id, testItem(item.id, item.label)] as const),
  );
  const run = new FakeRun();
  const controller = { createTestRun: vi.fn(() => run) };
  const createLocation = vi.fn(
    (_nativePath: string, line: number, character: number) => ({ line, character }),
  );
  const harness: Harness = {
    controller,
    run,
    items,
    createLocation,
    execute: vi.fn<FoundryTestRunProfileOptions["execute"]>(),
    profile: undefined as unknown as FoundryTestRunProfile,
    executed: undefined,
  };
  harness.execute.mockImplementation(
    async (
      executionRequest: TestExecutionRequest,
      _signal: AbortSignal,
      observer: TestExecutionObserver,
    ): Promise<TestExecutionResult> => {
      if (options.thrown !== undefined) {
        throw options.thrown;
      }
      await Promise.resolve();
      harness.executed = executionRequest;
      for (const [text, stream] of options.output ?? []) {
        observer.onOutput(text, stream);
      }
      for (const point of options.points ?? [passPoint(executionRequest.leaves[0].id, 5)]) {
        observer.onPoint(point);
      }
      if (options.cancelled) {
        return {
          kind: "cancelled",
          completion: {
            valid: true,
            complete: false,
            classification: "cancelled",
            codes: [],
            diagnostics: [],
          },
          processResult: { kind: "cancelled", stdout: "", stderr: "" },
        };
      }
      return {
        kind: "completed",
        completion: {
          valid: !options.invalid,
          complete: true,
          classification: options.invalid
            ? "invalid"
            : (options.exitCode ?? 0) === 0
              ? "conforming"
              : "test_failures",
          codes: options.invalid
            ? (options.invalidCodes ?? ["report.exit"])
            : [],
          diagnostics: options.invalid
            ? (options.invalidDiagnostics ?? ["exit mismatch"])
            : [],
        },
        processResult: {
          kind: "exited",
          exitCode: options.exitCode ?? 0,
          stdout: "",
          stderr: "",
        },
      };
    },
  );
  const profileOptions: FoundryTestRunProfileOptions = {
    controller: controller as unknown as vscode.TestController,
    readyContext: () =>
      options.ready === false
        ? undefined
        : {
            configuration: {
              enabled: true,
              enginePath: "/opt/foundry",
              project: "/workspace/game",
              runner: "res://tests/runner.fs",
              frameworkArgs: [],
            },
            adapter: {
              protocolVersion: 1,
              framework: { id: "neutral", name: "Neutral", version: "1" },
              extensions: [],
            },
            model,
          },
    snapshot: () => ({
      model: options.stale ? { ...model } : model,
      item: (id) => items.get(id),
    }),
    execute: harness.execute,
    createMessage: (message) => ({ message }),
    createLocation,
  };
  harness.profile = new FoundryTestRunProfile(profileOptions);
  return harness;
}

class FakeRun {
  readonly calls: string[] = [];
  readonly enqueued = vi.fn((item: vscode.TestItem) => this.calls.push(`enqueued:${item.id}`));
  readonly started = vi.fn((item: vscode.TestItem) => this.calls.push(`started:${item.id}`));
  readonly passed = vi.fn((item: vscode.TestItem, duration?: number) =>
    this.calls.push(`passed:${item.id}:${String(duration)}`),
  );
  readonly skipped = vi.fn((item: vscode.TestItem) => this.calls.push(`skipped:${item.id}`));
  readonly failed = vi.fn();
  readonly errored = vi.fn();
  readonly appendOutput = vi.fn();
  readonly end = vi.fn(() => this.calls.push("end"));
}

function request(
  include: readonly vscode.TestItem[] | undefined,
  exclude: readonly vscode.TestItem[] = [],
): vscode.TestRunRequest {
  return { include, exclude } as vscode.TestRunRequest;
}

function token(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: vi.fn() }),
  };
}

function testItem(id: string, label: string): vscode.TestItem {
  return { id, label } as vscode.TestItem;
}

function discoveryModel(): TestDiscoveryModel {
  const leaves = [leaf("test-a", false), leaf("test-b", true)];
  return {
    root: "res://tests",
    items: [
      {
        kind: "suite",
        id: "suite-a",
        label: "suite",
        parentId: null,
        resourcePath: null,
        range: null,
        runnable: true,
        skipped: false,
        skipReason: null,
      },
      ...leaves,
    ],
    suiteCount: 1,
    testCount: 2,
    errorCount: 0,
  };
}

function leaf(id: string, skipped: boolean): TestDiscoveryTest {
  return {
    kind: "test",
    id,
    label: "duplicate",
    parentId: "suite-a",
    resourcePath: "res://tests/example.fs",
    range: null,
    runnable: true,
    skipped,
    skipReason: skipped ? "pending" : null,
    caseKey: null,
  };
}

function passPoint(
  id: string,
  durationMs: number,
  skipReason?: string,
): FoundryTapPoint {
  return {
    number: id === "test-a" ? 1 : 2,
    ok: true,
    label: "duplicate",
    ...(skipReason === undefined ? {} : { skipReason }),
    testId: id,
    durationMs,
    statusDetail: "",
  };
}

function failPoint(
  id: string,
  statusDetail: FoundryTapPoint["statusDetail"],
): FoundryTapPoint {
  return {
    number: 1,
    ok: false,
    label: "duplicate",
    testId: id,
    durationMs: 17,
    statusDetail,
    message: "boom",
  };
}
