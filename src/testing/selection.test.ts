import { describe, expect, it } from "vitest";
import type {
  TestDiscoveryItem,
  TestDiscoveryModel,
  TestDiscoverySuite,
  TestDiscoveryTest,
} from "./discovery.js";
import { selectRunnableLeaves } from "./selection.js";

describe("test run selection", () => {
  it("runs all runnable leaves in discovery order when include is undefined", () => {
    expect(ids(selectRunnableLeaves(model(), undefined, []))).toEqual([
      "test-a",
      "test-b",
      "test-c",
    ]);
  });

  it("expands nested suites and applies descendant exclusions afterward", () => {
    expect(
      ids(
        selectRunnableLeaves(
          model(),
          ["suite-root", "test-b"],
          ["suite-nested"],
        ),
      ),
    ).toEqual(["test-a"]);
  });

  it("deduplicates repeated and overlapping selections", () => {
    expect(
      ids(
        selectRunnableLeaves(
          model(),
          ["suite-root", "test-a", "suite-root", "test-c"],
          [],
        ),
      ),
    ).toEqual(["test-a", "test-b", "test-c"]);
  });

  it("never selects errors or non-runnable tests", () => {
    expect(
      selectRunnableLeaves(model(), ["error-a", "test-disabled"], []),
    ).toEqual([]);
  });

  it("treats an explicit empty include as an empty plan", () => {
    expect(selectRunnableLeaves(model(), [], [])).toEqual([]);
  });

  it("lets direct test exclusions remove a run-all leaf", () => {
    expect(ids(selectRunnableLeaves(model(), undefined, ["test-b"]))).toEqual([
      "test-a",
      "test-c",
    ]);
  });
});

function ids(leaves: readonly TestDiscoveryTest[]): string[] {
  return leaves.map((leaf) => leaf.id);
}

function model(): TestDiscoveryModel {
  const items: TestDiscoveryItem[] = [
    suite("suite-root", null),
    test("test-a", "suite-root", true),
    suite("suite-nested", "suite-root"),
    test("test-b", "suite-nested", true),
    test("test-disabled", "suite-nested", false),
    suite("suite-other", null),
    test("test-c", "suite-other", true),
    suite("suite-empty", null),
    {
      kind: "error",
      id: "error-a",
      label: "duplicate label",
      parentId: "suite-root",
      message: "broken discovery",
      resourcePath: null,
      range: null,
    },
  ];
  return {
    root: "res://tests",
    items,
    suiteCount: 4,
    testCount: 4,
    errorCount: 1,
  };
}

function suite(id: string, parentId: string | null): TestDiscoverySuite {
  return {
    kind: "suite",
    id,
    label: "duplicate label",
    parentId,
    resourcePath: null,
    range: null,
    runnable: true,
    skipped: false,
    skipReason: null,
  };
}

function test(
  id: string,
  parentId: string,
  runnable: boolean,
): TestDiscoveryTest {
  return {
    kind: "test",
    id,
    label: "duplicate label",
    parentId,
    resourcePath: null,
    range: null,
    runnable,
    skipped: false,
    skipReason: null,
    caseKey: null,
  };
}
