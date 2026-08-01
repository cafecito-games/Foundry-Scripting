import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseTestDiscovery } from "./discovery.js";
import {
  FoundryTap13Parser,
  type FoundryTapPoint,
} from "./report.js";
import { selectRunnableLeaves } from "./selection.js";

const encoder = new TextEncoder();
const leaf = { id: "test-a", skipped: false, skipReason: null } as const;

describe("streaming Foundry TAP13 parser", () => {
  it("decodes a UTF-8 scalar split across chunks", () => {
    const points: FoundryTapPoint[] = [];
    const bytes = encoder.encode(report(point({ label: "adds 😀 numbers" })));
    const scalar = encoder.encode("😀");
    const scalarStart = findSubarray(bytes, scalar);
    const parser = new FoundryTap13Parser([leaf], (value) => points.push(value));

    parser.push(bytes.subarray(0, scalarStart + 2));
    expect(points).toEqual([]);
    parser.push(bytes.subarray(scalarStart + 2));

    expect(parser.finish({ kind: "exited", exitCode: 0 })).toMatchObject({
      valid: true,
      complete: true,
      classification: "conforming",
      codes: [],
    });
    expect(points).toHaveLength(1);
    expect(points[0]?.label).toBe("adds 😀 numbers");
  });

  it("validates the final decoder flush", () => {
    const parser = new FoundryTap13Parser([leaf], () => undefined);
    const bytes = encoder.encode(report(point()));

    parser.push(bytes);
    parser.push(Uint8Array.from([0xf0, 0x9f, 0x98]));

    expect(parser.finish({ kind: "exited", exitCode: 0 })).toMatchObject({
      valid: false,
      complete: false,
      classification: "infrastructure_failure",
      codes: ["artifact.encoding"],
    });
  });

  it("discards an invalid UTF-8 suffix that was never LF-flushed on cancellation", () => {
    const points: FoundryTapPoint[] = [];
    const parser = new FoundryTap13Parser(
      [leaf, { id: "test-b", skipped: false, skipReason: null }],
      (value) => points.push(value),
    );
    parser.push(encoder.encode(report(point()).replace("1..1", "1..2")));
    parser.push(Uint8Array.from([0xff]));

    expect(parser.finish({ kind: "cancelled" })).toMatchObject({
      valid: true,
      complete: false,
      classification: "cancelled",
      codes: [],
    });
    expect(points.map((value) => value.testId)).toEqual(["test-a"]);
  });

  it.each([
    {
      name: "byte-order mark",
      bytes: Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode(report(point()))]),
      code: "artifact.encoding",
    },
    {
      name: "CRLF",
      bytes: encoder.encode(report(point()).replaceAll("\n", "\r\n")),
      code: "report.line_ending",
    },
    {
      name: "wrong header",
      bytes: encoder.encode(report(point()).replace("TAP version 13", "TAP version 12")),
      code: "report.header",
    },
    {
      name: "wrong adapter comment",
      bytes: encoder.encode(
        report(point()).replace("# foundry-test-adapter: 1", "# foundry-test-adapter: 2"),
      ),
      code: "report.adapter_version",
    },
    {
      name: "late plan",
      bytes: encoder.encode(
        report(point()).replace("1..1\n", "ok 1 - early\n1..1\n"),
      ),
      code: "report.plan",
    },
    {
      name: "oversized plan",
      bytes: encoder.encode(
        report(point()).replace("1..1", `1..${"9".repeat(10)}`),
      ),
      code: "report.plan",
    },
    {
      name: "oversized point",
      bytes: encoder.encode(
        report(point()).replace("ok 1 -", `ok ${"9".repeat(10)} -`),
      ),
      code: "report.point",
    },
  ])("rejects $name", ({ bytes, code }) => {
    const parser = new FoundryTap13Parser([leaf], () => undefined);
    parser.push(bytes);

    expect(parser.finish({ kind: "exited", exitCode: 0 }).codes).toContain(code);
  });

  it("does not publish a point before its closing marker and LF", () => {
    const points: FoundryTapPoint[] = [];
    const parser = new FoundryTap13Parser([leaf], (value) => points.push(value));
    const content = report(point());
    const boundary = content.indexOf("  ...\n") + "  ...".length;

    parser.push(encoder.encode(content.slice(0, boundary)));
    expect(points).toEqual([]);
    parser.push(encoder.encode(content.slice(boundary)));

    expect(points).toHaveLength(1);
    expect(parser.finish({ kind: "exited", exitCode: 0 }).valid).toBe(true);
  });

  it("parses required metadata and one-based location", () => {
    const points: FoundryTapPoint[] = [];
    const parser = new FoundryTap13Parser([leaf], (value) => points.push(value));
    parser.push(
      encoder.encode(
        report(
          point({
            ok: false,
            message: "expected 4, got 5",
            duration: 23,
            location: ["res://tests/math.fs", 5, 2],
          }),
        ),
      ),
    );

    expect(parser.finish({ kind: "exited", exitCode: 1 }).valid).toBe(true);
    expect(points[0]).toMatchObject({
      ok: false,
      testId: "test-a",
      durationMs: 23,
      statusDetail: "",
      message: "expected 4, got 5",
      location: {
        fileName: "res://tests/math.fs",
        lineNumber: 5,
        columnNumber: 2,
      },
    });
  });
});

describe("normative Foundry v1 report fixtures", () => {
  const fixtures = reportFixtureEntries();

  it("covers every report entry in the immutable manifest", () => {
    expect(fixtures).toHaveLength(62);
  });

  it.each(fixtures)("matches $id", (fixture) => {
    const artifactPath = protocolFixturePath(fixture.artifact);
    if (!existsSync(artifactPath)) {
      expect(fixture.expected.codes).toEqual(
        fixture.cancelled ? [] : ["artifact.missing"],
      );
      expect(fixture.expected.valid).toBe(fixture.cancelled);
      return;
    }

    const contextInvalid =
      fixture.discovery?.startsWith("invalid/discovery/") ?? false;
    const leaves = contextInvalid
      ? undefined
      : expectedLeaves(fixture.discovery, fixture.selections);
    const parser = new FoundryTap13Parser(
      leaves,
      () => undefined,
      fixture.id === "report.invalid.empty-suite-selection",
    );
    const bytes = readFileSync(artifactPath);
    for (const chunk of chunkBytes(bytes)) {
      parser.push(chunk);
    }
    const result = parser.finish(
      fixture.cancelled
        ? { kind: "cancelled", exitCode: fixture.exit_code }
        : fixture.exit_code === null
          ? { kind: "artifact" }
          : { kind: "exited", exitCode: fixture.exit_code },
    );

    if (contextInvalid) {
      expect(result.valid).toBe(true);
      expect(result.complete).toBe(true);
      return;
    }
    expect(result).toMatchObject({
      valid: fixture.expected.valid,
      complete: fixture.expected.complete,
      classification: fixture.expected.classification,
    });
    expect([...result.codes].sort()).toEqual([...fixture.expected.codes].sort());
  });
});

function report(...points: string[]): string {
  return `TAP version 13\n# foundry-test-adapter: 1\n1..${points.length}\n${points.join("")}`;
}

function point(
  options: {
    label?: string;
    ok?: boolean;
    message?: string;
    duration?: number;
    location?: readonly [string, number, number];
  } = {},
): string {
  const ok = options.ok ?? true;
  const lines = [
    `${ok ? "ok" : "not ok"} 1 - ${options.label ?? "adds numbers"}`,
    "  ---",
  ];
  if (options.message !== undefined) {
    lines.push(`  message: ${JSON.stringify(options.message)}`);
  }
  if (options.location !== undefined) {
    lines.push(
      "  at:",
      `    fileName: ${JSON.stringify(options.location[0])}`,
      `    lineNumber: ${options.location[1]}`,
      `    columnNumber: ${options.location[2]}`,
    );
  }
  lines.push(
    "  _foundry:",
    '    id: "test-a"',
    `    duration_ms: ${options.duration ?? 2}`,
    '    status_detail: ""',
    "  ...",
  );
  return `${lines.join("\n")}\n`;
}

function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((byte, offset) => haystack[start + offset] === byte)) {
      return start;
    }
  }
  throw new Error("Expected byte sequence was absent.");
}

interface ReportFixtureEntry {
  readonly id: string;
  readonly operation: string;
  readonly artifact: string;
  readonly exit_code: number | null;
  readonly cancelled: boolean;
  readonly discovery: string | null;
  readonly selections: readonly string[];
  readonly expected: {
    readonly valid: boolean;
    readonly complete: boolean;
    readonly classification: string;
    readonly codes: readonly string[];
  };
}

function reportFixtureEntries(): ReportFixtureEntry[] {
  const manifest = JSON.parse(
    readFileSync(protocolFixturePath("manifest.json"), "utf8"),
  ) as { readonly fixtures: readonly ReportFixtureEntry[] };
  return manifest.fixtures.filter((fixture) => fixture.operation === "report");
}

function protocolFixturePath(relativePath: string): string {
  return path.join(
    process.cwd(),
    "src",
    "testing",
    "fixtures",
    "protocol-v1",
    relativePath,
  );
}

function expectedLeaves(
  discovery: string | null,
  selections: readonly string[],
) {
  if (discovery === null) {
    return undefined;
  }
  const model = parseTestDiscovery(
    readFileSync(
      path.join(
        process.cwd(),
        "src",
        "testing",
        "fixtures",
        "discovery",
        discovery.replace("valid/discovery/", "valid/"),
      ),
    ),
  );
  return selectRunnableLeaves(
    model,
    selections.length === 0 ? undefined : selections,
    [],
  ).map((value) => ({
    id: value.id,
    skipped: value.skipped,
    skipReason: value.skipReason,
  }));
}

function chunkBytes(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const sizes = [1, 2, 7, 19, 3, 31];
  while (offset < bytes.length) {
    const size = sizes[chunks.length % sizes.length] ?? 1;
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}
