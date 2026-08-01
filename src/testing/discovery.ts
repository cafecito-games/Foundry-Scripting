export interface TestDiscoveryPosition {
  readonly line: number;
  readonly character: number;
}

export interface TestDiscoveryRange {
  readonly start: TestDiscoveryPosition;
  readonly end: TestDiscoveryPosition;
}

interface TestDiscoveryNode {
  readonly id: string;
  readonly label: string;
  readonly parentId: string | null;
  readonly resourcePath: string | null;
  readonly range: TestDiscoveryRange | null;
  readonly runnable: boolean;
  readonly skipped: boolean;
  readonly skipReason: string | null;
}

export interface TestDiscoverySuite extends TestDiscoveryNode {
  readonly kind: "suite";
}

export interface TestDiscoveryTest extends TestDiscoveryNode {
  readonly kind: "test";
  readonly caseKey: string | null;
}

export interface TestDiscoveryError {
  readonly kind: "error";
  readonly id: string;
  readonly label: string;
  readonly parentId: string | null;
  readonly message: string;
  readonly resourcePath: string | null;
  readonly range: TestDiscoveryRange | null;
}

export type TestDiscoveryItem =
  | TestDiscoverySuite
  | TestDiscoveryTest
  | TestDiscoveryError;

export interface TestDiscoveryModel {
  readonly root: string;
  readonly items: readonly TestDiscoveryItem[];
  readonly suiteCount: number;
  readonly testCount: number;
  readonly errorCount: number;
}

export type TestDiscoveryParseErrorKind =
  | "malformed_discovery"
  | "incomplete_discovery";

export class TestDiscoveryParseError extends Error {
  constructor(
    readonly kind: TestDiscoveryParseErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TestDiscoveryParseError";
  }
}

type JsonObject = Record<string, unknown>;

const protocol = "foundry-test-adapter";
const protocolVersion = 1;
const byteOrderMark = [0xef, 0xbb, 0xbf] as const;
const controlCharacter = /[\u0000-\u001f\u007f]/u;

export function parseTestDiscovery(bytes: Uint8Array): TestDiscoveryModel {
  const text = decodeDiscovery(bytes);
  if (!text.endsWith("\n")) {
    throw incomplete("Discovery artifact does not end with LF.");
  }
  if (text.includes("\r")) {
    throw malformed("Discovery artifact must use LF rather than CR line endings.");
  }

  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 1 && lines[0] === "") {
    throw incomplete("Discovery artifact contains no lifecycle records.");
  }

  const records = lines.map((line, index) => parseRecord(line, index + 1));
  const first = records[0];
  if (first.event !== "discovery_start") {
    throw malformed("Record 1 must be discovery_start.");
  }
  const root = resourcePath(first, "root", 1, false);
  const items: TestDiscoveryItem[] = [];
  const suites = new Map<string, TestDiscoverySuite>();
  const ids = new Set<string>();
  let end: JsonObject | undefined;

  for (let index = 1; index < records.length; index += 1) {
    const recordNumber = index + 1;
    const record = records[index];
    if (end !== undefined) {
      throw malformed(`Record ${recordNumber} follows discovery_end.`);
    }
    switch (record.event) {
      case "discovery_start":
        throw malformed(`Record ${recordNumber} duplicates discovery_start.`);
      case "discovery_end":
        end = record;
        break;
      case "suite": {
        const suite = parseNode(record, recordNumber, "suite", ids, suites);
        suites.set(suite.id, suite);
        items.push(suite);
        break;
      }
      case "test": {
        const test = parseNode(record, recordNumber, "test", ids, suites);
        if (test.runnable && !test.skipped && hasSkippedAncestor(test, suites)) {
          throw malformed(
            `Record ${recordNumber} must explicitly skip a runnable test beneath a skipped suite.`,
          );
        }
        items.push(test);
        break;
      }
      case "discovery_error":
        items.push(parseError(record, recordNumber, ids, suites));
        break;
    }
  }

  if (end === undefined) {
    throw incomplete("Discovery artifact has no final discovery_end record.");
  }

  const suiteCount = count(items, "suite");
  const testCount = count(items, "test");
  const errorCount = count(items, "error");
  requireCount(end, "suite_count", suiteCount, records.length);
  requireCount(end, "test_count", testCount, records.length);
  requireCount(end, "error_count", errorCount, records.length);

  return { root, items, suiteCount, testCount, errorCount };
}

function decodeDiscovery(bytes: Uint8Array): string {
  if (
    bytes.length >= byteOrderMark.length &&
    byteOrderMark.every((byte, index) => bytes[index] === byte)
  ) {
    throw malformed("Discovery artifact must not contain a byte-order mark.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw malformed("Discovery artifact is not valid UTF-8.", error);
  }
}

function parseRecord(line: string, recordNumber: number): JsonObject {
  if (line === "" || line.trim() === "") {
    throw malformed(`Record ${recordNumber} is blank.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw malformed(`Record ${recordNumber} is not valid JSON.`, error);
  }
  if (!isObject(value)) {
    throw malformed(`Record ${recordNumber} must be a JSON object.`);
  }
  if (value.protocol !== protocol) {
    throw malformed(`Record ${recordNumber} has an invalid protocol.`);
  }
  if (value.version !== protocolVersion) {
    throw malformed(`Record ${recordNumber} has an invalid protocol version.`);
  }
  if (
    value.event !== "discovery_start" &&
    value.event !== "suite" &&
    value.event !== "test" &&
    value.event !== "discovery_error" &&
    value.event !== "discovery_end"
  ) {
    throw malformed(`Record ${recordNumber} has an unknown event.`);
  }
  return value;
}

function parseNode(
  record: JsonObject,
  recordNumber: number,
  kind: "suite",
  ids: Set<string>,
  suites: ReadonlyMap<string, TestDiscoverySuite>,
): TestDiscoverySuite;
function parseNode(
  record: JsonObject,
  recordNumber: number,
  kind: "test",
  ids: Set<string>,
  suites: ReadonlyMap<string, TestDiscoverySuite>,
): TestDiscoveryTest;
function parseNode(
  record: JsonObject,
  recordNumber: number,
  kind: "suite" | "test",
  ids: Set<string>,
  suites: ReadonlyMap<string, TestDiscoverySuite>,
): TestDiscoverySuite | TestDiscoveryTest {
  const id = uniqueId(record, recordNumber, ids);
  const label = text(record, "label", recordNumber);
  const parentId = parent(record, recordNumber, suites);
  const location = parseLocation(record, recordNumber);
  const runnable = boolean(record, "runnable", recordNumber);
  const skipped = boolean(record, "skipped", recordNumber);
  const skipReason = nullableText(record, "skip_reason", recordNumber);
  if (skipped !== (skipReason !== null)) {
    throw malformed(
      `Record ${recordNumber} has inconsistent skipped and skip_reason fields.`,
    );
  }
  if (kind === "test" && !runnable && skipped) {
    throw malformed(`Record ${recordNumber} marks a non-runnable test skipped.`);
  }
  if (kind === "test") {
    return {
      kind,
      id,
      label,
      parentId,
      ...location,
      runnable,
      skipped,
      skipReason,
      caseKey: nullableText(record, "case_key", recordNumber),
    };
  }
  return {
    kind,
    id,
    label,
    parentId,
    ...location,
    runnable,
    skipped,
    skipReason,
  };
}

function parseError(
  record: JsonObject,
  recordNumber: number,
  ids: Set<string>,
  suites: ReadonlyMap<string, TestDiscoverySuite>,
): TestDiscoveryError {
  const id = uniqueId(record, recordNumber, ids);
  const location = parseLocation(record, recordNumber);
  return {
    kind: "error",
    id,
    label: text(record, "label", recordNumber),
    parentId: parent(record, recordNumber, suites),
    message: text(record, "message", recordNumber),
    ...location,
  };
}

function parseLocation(
  record: JsonObject,
  recordNumber: number,
): {
  readonly resourcePath: string | null;
  readonly range: TestDiscoveryRange | null;
} {
  const resourcePath = resourcePathValue(record, "path", recordNumber, true);
  const range = nullableRange(record, "range", recordNumber);
  if (resourcePath === null && range !== null) {
    throw malformed(`Record ${recordNumber} has a range without a path.`);
  }
  return { resourcePath, range };
}

function uniqueId(
  record: JsonObject,
  recordNumber: number,
  ids: Set<string>,
): string {
  const id = text(record, "id", recordNumber);
  if (ids.has(id)) {
    throw malformed(`Record ${recordNumber} duplicates ID ${JSON.stringify(id)}.`);
  }
  ids.add(id);
  return id;
}

function parent(
  record: JsonObject,
  recordNumber: number,
  suites: ReadonlyMap<string, TestDiscoverySuite>,
): string | null {
  const parentId = nullableText(record, "parent_id", recordNumber);
  if (parentId !== null && !suites.has(parentId)) {
    throw malformed(
      `Record ${recordNumber} parent_id must identify a previous suite.`,
    );
  }
  return parentId;
}

function hasSkippedAncestor(
  test: TestDiscoveryTest,
  suites: ReadonlyMap<string, TestDiscoverySuite>,
): boolean {
  let parentId = test.parentId;
  while (parentId !== null) {
    const suite = suites.get(parentId);
    if (suite === undefined) {
      return false;
    }
    if (suite.skipped) {
      return true;
    }
    parentId = suite.parentId;
  }
  return false;
}

function nullableRange(
  record: JsonObject,
  key: string,
  recordNumber: number,
): TestDiscoveryRange | null {
  const value = required(record, key, recordNumber);
  if (value === null) {
    return null;
  }
  if (!isObject(value)) {
    throw malformed(`Record ${recordNumber} field ${key} must be an object or null.`);
  }
  const start = position(value, "start", recordNumber);
  const end = position(value, "end", recordNumber);
  if (
    start.line > end.line ||
    (start.line === end.line && start.character > end.character)
  ) {
    throw malformed(`Record ${recordNumber} range start follows its end.`);
  }
  return { start, end };
}

function position(
  record: JsonObject,
  key: string,
  recordNumber: number,
): TestDiscoveryPosition {
  const value = required(record, key, recordNumber);
  if (!isObject(value)) {
    throw malformed(`Record ${recordNumber} range ${key} must be an object.`);
  }
  return {
    line: nonNegativeInteger(value, "line", recordNumber),
    character: nonNegativeInteger(value, "character", recordNumber),
  };
}

function resourcePath(
  record: JsonObject,
  key: string,
  recordNumber: number,
  nullable: false,
): string;
function resourcePath(
  record: JsonObject,
  key: string,
  recordNumber: number,
  nullable: true,
): string | null;
function resourcePath(
  record: JsonObject,
  key: string,
  recordNumber: number,
  nullable: boolean,
): string | null {
  return resourcePathValue(record, key, recordNumber, nullable);
}

function resourcePathValue(
  record: JsonObject,
  key: string,
  recordNumber: number,
  nullable: boolean,
): string | null {
  const value = required(record, key, recordNumber);
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== "string" || !isCanonicalResourcePath(value)) {
    throw malformed(`Record ${recordNumber} field ${key} is not a canonical res:// path.`);
  }
  return value;
}

function isCanonicalResourcePath(value: string): boolean {
  if (!value.startsWith("res://") || controlCharacter.test(value)) {
    return false;
  }
  const relative = value.slice("res://".length);
  if (relative === "" || relative.includes("\\")) {
    return false;
  }
  return relative
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function text(record: JsonObject, key: string, recordNumber: number): string {
  const value = required(record, key, recordNumber);
  if (typeof value !== "string" || value === "" || controlCharacter.test(value)) {
    throw malformed(`Record ${recordNumber} field ${key} must be non-empty control-free text.`);
  }
  return value;
}

function nullableText(
  record: JsonObject,
  key: string,
  recordNumber: number,
): string | null {
  const value = required(record, key, recordNumber);
  if (value === null) {
    return null;
  }
  return text(record, key, recordNumber);
}

function boolean(record: JsonObject, key: string, recordNumber: number): boolean {
  const value = required(record, key, recordNumber);
  if (typeof value !== "boolean") {
    throw malformed(`Record ${recordNumber} field ${key} must be a boolean.`);
  }
  return value;
}

function nonNegativeInteger(
  record: JsonObject,
  key: string,
  recordNumber: number,
): number {
  const value = required(record, key, recordNumber);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw malformed(`Record ${recordNumber} field ${key} must be a non-negative integer.`);
  }
  return value;
}

function requireCount(
  record: JsonObject,
  key: string,
  expected: number,
  recordNumber: number,
): void {
  const actual = nonNegativeInteger(record, key, recordNumber);
  if (actual !== expected) {
    throw malformed(
      `Record ${recordNumber} field ${key} is ${actual}; expected ${expected}.`,
    );
  }
}

function required(
  record: JsonObject,
  key: string,
  recordNumber: number,
): unknown {
  if (!Object.hasOwn(record, key)) {
    throw malformed(`Record ${recordNumber} is missing field ${key}.`);
  }
  return record[key];
}

function count(items: readonly TestDiscoveryItem[], kind: TestDiscoveryItem["kind"]): number {
  return items.reduce((total, item) => total + Number(item.kind === kind), 0);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(message: string, cause?: unknown): TestDiscoveryParseError {
  return new TestDiscoveryParseError("malformed_discovery", message, { cause });
}

function incomplete(message: string): TestDiscoveryParseError {
  return new TestDiscoveryParseError("incomplete_discovery", message);
}
