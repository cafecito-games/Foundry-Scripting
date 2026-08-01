import path from "node:path";
import type * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type {
  TestDiscoveryError,
  TestDiscoveryItem,
  TestDiscoveryModel,
  TestDiscoveryRange,
  TestDiscoverySuite,
  TestDiscoveryTest,
} from "./discovery.js";
import { FoundryTestExplorer } from "./explorer.js";

describe("Foundry Test Explorer reconciliation", () => {
  it("projects authoritative hierarchy, locations, ranges, and metadata", () => {
    const harness = createHarness();
    const range = location(3, 2, 3, 30);
    const items = [
      suite({ id: "suite-a", label: "Math" }),
      test({
        id: "row-0",
        label: "adds numbers",
        parentId: "suite-a",
        caseKey: "row:0",
        range,
      }),
      test({
        id: "row-1",
        label: "adds numbers",
        parentId: "suite-a",
        caseKey: "row:1",
        skipped: true,
        skipReason: "pending upstream",
      }),
      test({
        id: "helper",
        label: "generated helper",
        parentId: "suite-a",
        runnable: false,
      }),
      discoveryError({ id: "error-a", parentId: "suite-a" }),
    ];

    harness.explorer.reconcile("/workspace/game", model(items));

    const suiteItem = harness.controller.items.get("suite-a");
    expect(suiteItem?.children.get("row-0")?.id).toBe("row-0");
    expect(suiteItem?.children.get("row-1")?.id).toBe("row-1");
    expect(harness.controller.items.get("adds numbers")).toBeUndefined();
    expect(suiteItem?.children.get("row-0")?.uri).toEqual({
      fsPath: path.join("/workspace/game", "tests/example.fs"),
    });
    expect(suiteItem?.children.get("row-0")?.range).toEqual(range);
    expect(harness.createRange).toHaveBeenCalledWith(range);
    expect(harness.explorer.getMetadata("row-0")).toEqual({
      kind: "test",
      parentId: "suite-a",
      resourcePath: "res://tests/example.fs",
      runnable: true,
      skipped: false,
      skipReason: null,
      caseKey: "row:0",
    });
    expect(harness.explorer.getMetadata("row-1")).toMatchObject({
      caseKey: "row:1",
      skipped: true,
      skipReason: "pending upstream",
    });
    expect(suiteItem?.children.get("row-1")?.description).toBe(
      "Skipped: pending upstream",
    );
    expect(suiteItem?.children.get("helper")?.description).toBe("Not runnable");
    expect(suiteItem?.children.get("error-a")).toMatchObject({
      label: "Broken discovery",
      description: "Discovery error",
      error: "Unable to index suite",
    });
    expect(harness.explorer.getMetadata("error-a")).toMatchObject({
      kind: "error",
      runnable: false,
      skipped: false,
      caseKey: null,
    });
  });

  it("preserves object identity and mutates labels and ranges in place", () => {
    const harness = createHarness();
    harness.explorer.reconcile(
      "/workspace/game",
      model([suite(), test({ parentId: "suite-a" })]),
    );
    const originalSuite = harness.controller.items.get("suite-a");
    const originalTest = originalSuite?.children.get("test-a");

    harness.explorer.reconcile(
      "/workspace/game",
      model([
        suite(),
        test({
          parentId: "suite-a",
          label: "renamed",
          range: location(8, 1, 9, 4),
        }),
      ]),
    );

    const refreshedSuite = harness.controller.items.get("suite-a");
    const refreshedTest = refreshedSuite?.children.get("test-a");
    expect(refreshedSuite).toBe(originalSuite);
    expect(refreshedTest).toBe(originalTest);
    expect(refreshedTest).toMatchObject({
      label: "renamed",
      range: location(8, 1, 9, 4),
    });
  });

  it("reparents the same object under the new authoritative suite", () => {
    const harness = createHarness();
    harness.explorer.reconcile(
      "/workspace/game",
      model([
        suite({ id: "suite-a" }),
        suite({ id: "suite-b" }),
        test({ parentId: "suite-a" }),
      ]),
    );
    const original = harness.controller.items
      .get("suite-a")
      ?.children.get("test-a");

    harness.explorer.reconcile(
      "/workspace/game",
      model([
        suite({ id: "suite-a" }),
        suite({ id: "suite-b" }),
        test({ parentId: "suite-b" }),
      ]),
    );

    expect(harness.controller.items.get("suite-a")?.children.size).toBe(0);
    const reparented = harness.controller.items
      .get("suite-b")
      ?.children.get("test-a");
    expect(reparented).toBe(original);
    expect(reparented?.parent?.id).toBe("suite-b");
  });

  it("reconciles additions, removals, and discovery sort order", () => {
    const harness = createHarness();
    harness.explorer.reconcile(
      "/workspace/game",
      model([
        suite({ id: "removed" }),
        suite({ id: "kept" }),
        test({ id: "old-child", parentId: "kept" }),
      ]),
    );
    const kept = harness.controller.items.get("kept");

    harness.explorer.reconcile(
      "/workspace/game",
      model([
        suite({ id: "kept" }),
        test({ id: "new-child", parentId: "kept" }),
      ]),
    );

    expect(harness.controller.items.get("removed")).toBeUndefined();
    expect(harness.controller.items.get("kept")).toBe(kept);
    expect(kept?.children.get("old-child")).toBeUndefined();
    expect(kept?.children.get("new-child")?.sortText).toBe("000000001");
    expect(kept?.sortText).toBe("000000000");
  });

  it("recreates only IDs whose immutable path changes", () => {
    const harness = createHarness();
    harness.explorer.reconcile(
      "/workspace/game",
      model([suite(), test({ parentId: "suite-a" })]),
    );
    const originalSuite = harness.controller.items.get("suite-a");
    const originalTest = originalSuite?.children.get("test-a");

    harness.explorer.reconcile(
      "/workspace/game",
      model([
        suite(),
        test({
          parentId: "suite-a",
          resourcePath: "res://tests/moved.fs",
        }),
      ]),
    );

    expect(harness.controller.items.get("suite-a")).toBe(originalSuite);
    expect(originalSuite?.children.get("test-a")).not.toBe(originalTest);
  });

  it("reattaches stable descendants when their parent must be recreated", () => {
    const harness = createHarness();
    harness.explorer.reconcile(
      "/workspace/game",
      model([suite(), test({ parentId: "suite-a" })]),
    );
    const originalSuite = harness.controller.items.get("suite-a");
    const originalTest = originalSuite?.children.get("test-a");

    harness.explorer.reconcile(
      "/workspace/game",
      model([
        suite({ resourcePath: "res://tests/moved-suite.fs" }),
        test({ parentId: "suite-a" }),
      ]),
    );

    const recreatedSuite = harness.controller.items.get("suite-a");
    expect(recreatedSuite).not.toBe(originalSuite);
    expect(recreatedSuite?.children.get("test-a")).toBe(originalTest);
    expect(originalTest?.parent).toBe(recreatedSuite);
  });

  it("recreates an ID when its event kind changes", () => {
    const harness = createHarness();
    harness.explorer.reconcile("/workspace/game", model([suite()]));
    const original = harness.controller.items.get("suite-a");

    harness.explorer.reconcile(
      "/workspace/game",
      model([test({ id: "suite-a", parentId: null })]),
    );

    expect(harness.controller.items.get("suite-a")).not.toBe(original);
    expect(harness.explorer.getMetadata("suite-a")?.kind).toBe("test");
  });

  it("recreates located items when the project changes their native URI", () => {
    const harness = createHarness();
    harness.explorer.reconcile("/workspace/one", model([suite()]));
    const original = harness.controller.items.get("suite-a");

    harness.explorer.reconcile("/workspace/two", model([suite()]));

    expect(harness.controller.items.get("suite-a")).not.toBe(original);
    expect(harness.controller.items.get("suite-a")?.uri).toEqual({
      fsPath: path.join("/workspace/two", "tests/example.fs"),
    });
  });

  it("treats a valid empty model as authoritative", () => {
    const harness = createHarness();
    harness.explorer.reconcile("/workspace/game", model([suite()]));

    harness.explorer.reconcile("/workspace/game", model([]));

    expect(harness.controller.items.size).toBe(0);
    expect(harness.explorer.getMetadata("suite-a")).toBeUndefined();
  });

  it("retains the last-known-good tree when no reconcile occurs", () => {
    const harness = createHarness();
    harness.explorer.reconcile("/workspace/game", model([suite()]));
    const original = harness.controller.items.get("suite-a");

    // Parser, process, and cancellation failures deliberately never call reconcile.

    expect(harness.controller.items.get("suite-a")).toBe(original);
  });

  it("clears all owned hierarchy and metadata explicitly", () => {
    const harness = createHarness();
    harness.explorer.reconcile(
      "/workspace/game",
      model([suite(), test({ parentId: "suite-a" })]),
    );

    harness.explorer.clear();

    expect(harness.controller.items.size).toBe(0);
    expect(harness.explorer.getMetadata("test-a")).toBeUndefined();
  });

  it("exposes only the latest authoritative model and exact TestItem identities", () => {
    const harness = createHarness();
    const discovered = model([
      suite(),
      test({ id: "row-a", parentId: "suite-a", label: "duplicate" }),
      test({ id: "row-b", parentId: "suite-a", label: "duplicate" }),
      discoveryError({ id: "error-a", parentId: "suite-a" }),
    ]);

    harness.explorer.reconcile("/workspace/game", discovered);

    const snapshot = harness.explorer.snapshot();
    expect(snapshot?.model).toBe(discovered);
    expect(snapshot?.item("row-a")).toBe(
      harness.controller.items.get("suite-a")?.children.get("row-a"),
    );
    expect(snapshot?.item("row-b")?.label).toBe("duplicate");
    expect(snapshot?.item("error-a")?.id).toBe("error-a");
    expect(snapshot?.item("missing")).toBeUndefined();

    harness.explorer.clear();
    expect(harness.explorer.snapshot()).toBeUndefined();
  });
});

interface Harness {
  readonly controller: FakeController;
  readonly explorer: FoundryTestExplorer;
  readonly createRange: ReturnType<typeof vi.fn<(range: TestDiscoveryRange) => vscode.Range>>;
}

function createHarness(): Harness {
  const controller = new FakeController();
  const createRange = vi.fn(
    (range: TestDiscoveryRange) => range as unknown as vscode.Range,
  );
  return {
    controller,
    createRange,
    explorer: new FoundryTestExplorer(controller.asTestController(), {
      createUri: (nativePath) => ({ fsPath: nativePath }) as vscode.Uri,
      createRange,
    }),
  };
}

class FakeController {
  readonly items = new FakeCollection(undefined);
  readonly createTestItem = vi.fn(
    (id: string, label: string, uri?: vscode.Uri) =>
      new FakeItem(id, label, uri),
  );

  asTestController(): vscode.TestController {
    return this as unknown as vscode.TestController;
  }
}

class FakeCollection implements vscode.TestItemCollection {
  private readonly values = new Map<string, vscode.TestItem>();

  constructor(private readonly owner: FakeItem | undefined) {}

  get size(): number {
    return this.values.size;
  }

  replace(items: readonly vscode.TestItem[]): void {
    for (const item of this.values.values()) {
      setParent(item, undefined);
    }
    this.values.clear();
    for (const item of items) {
      this.add(item);
    }
  }

  forEach(
    callback: (item: vscode.TestItem, collection: vscode.TestItemCollection) => unknown,
    thisArg?: unknown,
  ): void {
    for (const item of this.values.values()) {
      callback.call(thisArg, item, this);
    }
  }

  add(item: vscode.TestItem): void {
    this.values.set(item.id, item);
    setParent(item, this.owner);
  }

  delete(itemId: string): void {
    const item = this.values.get(itemId);
    if (item !== undefined) {
      setParent(item, undefined);
    }
    this.values.delete(itemId);
  }

  get(itemId: string): vscode.TestItem | undefined {
    return this.values.get(itemId);
  }

  [Symbol.iterator](): Iterator<[string, vscode.TestItem]> {
    return this.values[Symbol.iterator]();
  }
}

class FakeItem implements vscode.TestItem {
  readonly children = new FakeCollection(this);
  parent: vscode.TestItem | undefined;
  tags: readonly vscode.TestTag[] = [];
  canResolveChildren = false;
  busy = false;
  description: string | undefined;
  sortText: string | undefined;
  range: vscode.Range | undefined;
  error: string | vscode.MarkdownString | undefined;

  constructor(
    readonly id: string,
    public label: string,
    readonly uri: vscode.Uri | undefined,
  ) {}
}

function setParent(item: vscode.TestItem, parent: vscode.TestItem | undefined): void {
  (item as FakeItem).parent = parent;
}

function model(items: readonly TestDiscoveryItem[]): TestDiscoveryModel {
  return {
    root: "res://tests",
    items,
    suiteCount: items.filter((item) => item.kind === "suite").length,
    testCount: items.filter((item) => item.kind === "test").length,
    errorCount: items.filter((item) => item.kind === "error").length,
  };
}

function suite(overrides: Partial<TestDiscoverySuite> = {}): TestDiscoverySuite {
  return {
    kind: "suite",
    id: "suite-a",
    label: "Suite",
    parentId: null,
    resourcePath: "res://tests/example.fs",
    range: location(0, 0, 20, 0),
    runnable: true,
    skipped: false,
    skipReason: null,
    ...overrides,
  };
}

function test(overrides: Partial<TestDiscoveryTest> = {}): TestDiscoveryTest {
  return {
    kind: "test",
    id: "test-a",
    label: "test",
    parentId: null,
    resourcePath: "res://tests/example.fs",
    range: location(4, 0, 6, 1),
    runnable: true,
    skipped: false,
    skipReason: null,
    caseKey: null,
    ...overrides,
  };
}

function discoveryError(
  overrides: Partial<TestDiscoveryError> = {},
): TestDiscoveryError {
  return {
    kind: "error",
    id: "error-a",
    label: "Broken discovery",
    parentId: null,
    message: "Unable to index suite",
    resourcePath: "res://tests/broken.fs",
    range: null,
    ...overrides,
  };
}

function location(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
): TestDiscoveryRange {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}
