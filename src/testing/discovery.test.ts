import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TestDiscoveryParseError,
  parseTestDiscovery,
} from "./discovery.js";

const validFixtures = [
  "additive.jsonl",
  "astral-range.jsonl",
  "empty.jsonl",
  "nested.jsonl",
  "with-errors.jsonl",
  "with-skip.jsonl",
] as const;

const invalidFixtures = [
  "blank-line.jsonl",
  "byte-order-mark.jsonl",
  "count-mismatch.jsonl",
  "crlf.jsonl",
  "duplicate-id.jsonl",
  "duplicate-start.jsonl",
  "inherited-skip.jsonl",
  "invalid-utf8.jsonl",
  "late-start.jsonl",
  "malformed-line.jsonl",
  "missing-end.jsonl",
  "missing-start.jsonl",
  "non-canonical-path.jsonl",
  "non-canonical-root.jsonl",
  "non-runnable-skipped.jsonl",
  "range-order.jsonl",
  "range-without-path.jsonl",
  "reason-without-skip.jsonl",
  "records-after-end.jsonl",
  "skip-without-reason.jsonl",
  "test-as-parent.jsonl",
  "truncated.jsonl",
  "unknown-event.jsonl",
  "unknown-parent.jsonl",
  "wrong-version.jsonl",
] as const;

describe("test discovery parser", () => {
  it.each(validFixtures)("accepts normative valid fixture %s", (fixture) => {
    expect(() => parseTestDiscovery(readFixture("valid", fixture))).not.toThrow();
  });

  it.each(invalidFixtures)("rejects normative invalid fixture %s", (fixture) => {
    expect(() => parseTestDiscovery(readFixture("invalid", fixture))).toThrow(
      TestDiscoveryParseError,
    );
  });

  it("returns an authoritative empty model", () => {
    expect(parseTestDiscovery(readFixture("valid", "empty.jsonl"))).toEqual({
      root: "res://tests",
      items: [],
      suiteCount: 0,
      testCount: 0,
      errorCount: 0,
    });
  });

  it("retains ordered identity, locations, runnable state, and case keys", () => {
    const model = parseTestDiscovery(readFixture("valid", "nested.jsonl"));

    expect(model.items.map(({ kind, id, parentId }) => ({ kind, id, parentId }))).toEqual([
      { kind: "suite", id: "suite-a", parentId: null },
      { kind: "test", id: "test-a", parentId: "suite-a" },
      { kind: "test", id: "test-b", parentId: "suite-a" },
      { kind: "suite", id: "suite-b", parentId: null },
      { kind: "test", id: "test-c", parentId: "suite-b" },
      { kind: "test", id: "test-d", parentId: "suite-b" },
    ]);
    expect(model.items[1]).toMatchObject({
      label: "adds numbers",
      caseKey: null,
      runnable: true,
      resourcePath: "res://tests/math_tests.fs",
      range: {
        start: { line: 4, character: 0 },
        end: { line: 6, character: 1 },
      },
    });
    expect(model.items[2]).toMatchObject({
      label: "adds numbers",
      caseKey: "case-2",
    });
    expect(model.items[5]).toMatchObject({ runnable: false, skipped: false });
  });

  it("retains valid records and represented discovery errors", () => {
    const model = parseTestDiscovery(readFixture("valid", "with-errors.jsonl"));

    expect(model).toMatchObject({ suiteCount: 1, testCount: 1, errorCount: 1 });
    expect(model.items.map((item) => item.kind)).toEqual([
      "suite",
      "test",
      "error",
    ]);
    expect(model.items[2]).toEqual({
      kind: "error",
      id: "error-a",
      label: "BrokenTests discovery",
      parentId: null,
      message: "Unable to index suite",
      resourcePath: "res://tests/broken_tests.fs",
      range: null,
    });
  });

  it("retains explicit skip state and reason", () => {
    const model = parseTestDiscovery(readFixture("valid", "with-skip.jsonl"));

    expect(model.items[1]).toMatchObject({
      kind: "test",
      skipped: true,
      skipReason: "pending upstream fix",
    });
  });

  it("passes UTF-16 character offsets through unchanged", () => {
    const model = parseTestDiscovery(readFixture("valid", "astral-range.jsonl"));

    expect(model.items[1]).toMatchObject({
      range: {
        start: { line: 3, character: 2 },
        end: { line: 3, character: 30 },
      },
    });
  });

  it("ignores additive record properties", () => {
    const model = parseTestDiscovery(readFixture("valid", "additive.jsonl"));

    expect(model.items[0]).not.toHaveProperty("tags");
  });

  it("treats U+2028 and U+2029 inside strings as ordinary characters", () => {
    const bytes = discoveryBytes([
      startRecord(),
      suiteRecord({ label: "line\u2028paragraph\u2029separators" }),
      endRecord({ suite_count: 1 }),
    ]);

    expect(parseTestDiscovery(bytes).items[0]).toMatchObject({
      label: "line\u2028paragraph\u2029separators",
    });
  });

  it("classifies incomplete lifecycles separately", () => {
    const missingEnd = discoveryBytes([startRecord()]);
    const missingFinalLf = missingEnd.subarray(0, missingEnd.length - 1);

    expect(captureParseError(missingEnd).kind).toBe("incomplete_discovery");
    expect(captureParseError(missingFinalLf).kind).toBe("incomplete_discovery");
  });

  it("rejects boolean positions", () => {
    const bytes = discoveryBytes([
      startRecord(),
      suiteRecord({
        range: {
          start: { line: true, character: 0 },
          end: { line: true, character: 1 },
        },
      }),
      endRecord({ suite_count: 1 }),
    ]);

    expect(captureParseError(bytes).kind).toBe("malformed_discovery");
  });
});

function readFixture(
  validity: "valid" | "invalid",
  fixture: string,
): Buffer {
  return readFileSync(
    path.join(
      process.cwd(),
      "src",
      "testing",
      "fixtures",
      "discovery",
      validity,
      fixture,
    ),
  );
}

function discoveryBytes(records: readonly Record<string, unknown>[]): Buffer {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function envelope(event: string): Record<string, unknown> {
  return { protocol: "foundry-test-adapter", version: 1, event };
}

function startRecord(): Record<string, unknown> {
  return { ...envelope("discovery_start"), root: "res://tests" };
}

function suiteRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...envelope("suite"),
    id: "suite-a",
    label: "Suite",
    parent_id: null,
    path: "res://tests/suite.fs",
    range: null,
    runnable: true,
    skipped: false,
    skip_reason: null,
    ...overrides,
  };
}

function endRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...envelope("discovery_end"),
    suite_count: 0,
    test_count: 0,
    error_count: 0,
    ...overrides,
  };
}

function captureParseError(bytes: Uint8Array): TestDiscoveryParseError {
  try {
    parseTestDiscovery(bytes);
  } catch (error) {
    if (error instanceof TestDiscoveryParseError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a test discovery parse error.");
}
