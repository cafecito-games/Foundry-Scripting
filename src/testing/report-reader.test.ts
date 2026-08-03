import { describe, expect, it } from "vitest";
import { TestAdapterFailure } from "./adapter.js";
import {
  IncrementalReportReader,
  REPORT_READ_CHUNK_SIZE,
  type ReportFileAccess,
  type ReportFileHandle,
  type ReportFileMetadata,
} from "./report-reader.js";

describe("incremental report reader", () => {
  it("treats an absent artifact before the first byte as not present", async () => {
    const files = new FakeReportFiles();
    const reader = new IncrementalReportReader("/run/report.tap", files);
    const chunks: Buffer[] = [];

    await expect(reader.readAvailable((chunk) => chunks.push(chunk))).resolves.toEqual({
      present: false,
      bytesRead: 0,
      totalBytes: 0,
    });
    expect(chunks).toEqual([]);
    expect(files.opens).toBe(0);
    expect(files.contentBytesRead).toBe(0);
  });

  it("streams initial and appended ranges in chunks no larger than 64 KiB", async () => {
    const files = new FakeReportFiles();
    const initial = Buffer.alloc(REPORT_READ_CHUNK_SIZE * 2 + 17, 0x61);
    files.replace(initial);
    const reader = new IncrementalReportReader("/run/report.tap", files);
    const chunks: Buffer[] = [];

    await expect(reader.readAvailable((chunk) => chunks.push(Buffer.from(chunk)))).resolves.toEqual({
      present: true,
      bytesRead: initial.length,
      totalBytes: initial.length,
    });
    files.append(Buffer.alloc(REPORT_READ_CHUNK_SIZE + 9, 0x62));
    const appended = await reader.readAvailable((chunk) => chunks.push(Buffer.from(chunk)));

    expect(appended.bytesRead).toBe(REPORT_READ_CHUNK_SIZE + 9);
    expect(Buffer.concat(chunks)).toEqual(files.contents);
    expect(files.reads.map((call) => call.length)).toEqual([
      REPORT_READ_CHUNK_SIZE,
      REPORT_READ_CHUNK_SIZE,
      17,
      REPORT_READ_CHUNK_SIZE,
      9,
    ]);
    expect(files.maxReturnedBuffer).toBe(REPORT_READ_CHUNK_SIZE);
    expect(files.opens).toBe(1);
  });

  it("performs no content read on unchanged polls", async () => {
    const files = new FakeReportFiles();
    files.replace(Buffer.from("TAP version 13\n"));
    const reader = new IncrementalReportReader("/run/report.tap", files);
    await reader.readAvailable(() => undefined);
    const reads = files.reads.length;

    await expect(reader.readAvailable(() => undefined)).resolves.toMatchObject({ bytesRead: 0 });

    expect(files.reads).toHaveLength(reads);
    expect(files.pathStats).toBeGreaterThan(1);
  });

  it("rejects truncation below the consumed offset", async () => {
    const files = new FakeReportFiles();
    files.replace(Buffer.from("TAP version 13\n"));
    const reader = new IncrementalReportReader("/run/report.tap", files);
    await reader.readAvailable(() => undefined);
    files.truncate(3);

    await expect(reader.readAvailable(() => undefined)).rejects.toMatchObject({
      kind: "malformed_report",
      message:
        "The Foundry test adapter execution report was truncated after streaming began.",
    });
  });

  it("rejects path replacement after streaming begins without reading it", async () => {
    const files = new FakeReportFiles();
    files.replace(Buffer.from("TAP version 13\n"));
    const reader = new IncrementalReportReader("/run/report.tap", files);
    await reader.readAvailable(() => undefined);
    const reads = files.reads.length;
    files.replace(Buffer.from("TAP version 14\n"));

    await expect(reader.readAvailable(() => undefined)).rejects.toMatchObject({
      kind: "malformed_report",
      message:
        "The Foundry test adapter execution report was replaced after streaming began.",
    });
    expect(files.reads).toHaveLength(reads);
  });

  it("finds same-identity consumed-prefix mutation during final verification", async () => {
    const files = new FakeReportFiles();
    const original = Buffer.alloc(REPORT_READ_CHUNK_SIZE + 23, 0x61);
    files.replace(original);
    const reader = new IncrementalReportReader("/run/report.tap", files);
    await reader.readAvailable(() => undefined);
    files.mutate(7, Buffer.from("changed"));

    await expect(reader.verifyFinal()).rejects.toMatchObject({
      kind: "malformed_report",
      message:
        "The Foundry test adapter execution report changed previously consumed bytes.",
    });
  });

  it("verifies the exact streamed size and identity with one sequential pass", async () => {
    const files = new FakeReportFiles();
    const contents = Buffer.alloc(REPORT_READ_CHUNK_SIZE * 2 + 31, 0x63);
    files.replace(contents);
    const reader = new IncrementalReportReader("/run/report.tap", files);
    await reader.readAvailable(() => undefined);
    const streamedBytes = files.contentBytesRead;

    await expect(reader.verifyFinal()).resolves.toEqual({ present: true });

    expect(files.contentBytesRead - streamedBytes).toBe(contents.length);
    expect(files.maxReturnedBuffer).toBe(REPORT_READ_CHUNK_SIZE);
    expect(files.reads.slice(-3).map(({ position, length }) => ({ position, length }))).toEqual([
      { position: 0, length: REPORT_READ_CHUNK_SIZE },
      { position: REPORT_READ_CHUNK_SIZE, length: REPORT_READ_CHUNK_SIZE },
      { position: REPORT_READ_CHUNK_SIZE * 2, length: 31 },
    ]);
  });

  it("reports a final size race instead of verifying a stale prefix", async () => {
    const files = new FakeReportFiles();
    files.replace(Buffer.from("stable"));
    const reader = new IncrementalReportReader("/run/report.tap", files);
    await reader.readAvailable(() => undefined);
    files.onRead = ({ position }) => {
      if (position === 0) {
        files.append(Buffer.from("growth"));
      }
    };

    await expect(reader.verifyFinal()).rejects.toMatchObject({
      kind: "malformed_report",
      message:
        "The Foundry test adapter execution report size changed during final verification.",
    });
  });

  it("closes its retained handle at most once", async () => {
    const files = new FakeReportFiles();
    files.replace(Buffer.from("report"));
    const reader = new IncrementalReportReader("/run/report.tap", files);
    await reader.readAvailable(() => undefined);

    await reader.close();
    await reader.close();

    expect(files.closes).toBe(1);
  });

  it("does not hide non-ENOENT metadata failures", async () => {
    const files = new FakeReportFiles();
    files.statError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const reader = new IncrementalReportReader("/run/report.tap", files);

    const failure = await captureFailure(reader.readAvailable(() => undefined));
    expect(failure.kind).toBe("report_read_failed");
    expect(failure.cause).toBe(files.statError);
  });
});

interface ReadCall {
  readonly position: number;
  readonly length: number;
}

class FakeReportFiles implements ReportFileAccess {
  contents: Buffer | undefined;
  identity = 0;
  pathStats = 0;
  opens = 0;
  closes = 0;
  contentBytesRead = 0;
  maxReturnedBuffer = 0;
  readonly reads: ReadCall[] = [];
  statError: Error | undefined;
  onRead: ((call: ReadCall) => void) | undefined;

  replace(contents: Buffer): void {
    this.identity += 1;
    this.contents = Buffer.from(contents);
  }

  append(contents: Buffer): void {
    if (this.contents === undefined) {
      throw new Error("Cannot append to a missing fake report.");
    }
    this.contents = Buffer.concat([this.contents, contents]);
  }

  truncate(size: number): void {
    if (this.contents === undefined) {
      throw new Error("Cannot truncate a missing fake report.");
    }
    this.contents = Buffer.from(this.contents.subarray(0, size));
  }

  mutate(position: number, contents: Buffer): void {
    if (this.contents === undefined) {
      throw new Error("Cannot mutate a missing fake report.");
    }
    contents.copy(this.contents, position);
  }

  stat(_path: string): Promise<ReportFileMetadata> {
    this.pathStats += 1;
    if (this.statError !== undefined) {
      return Promise.reject(this.statError);
    }
    return Promise.resolve(this.metadata());
  }

  open(_path: string): Promise<ReportFileHandle> {
    this.opens += 1;
    const openedIdentity = this.identity;
    if (this.contents === undefined) {
      return Promise.reject(missing());
    }
    const openedContents = this.contents;
    return Promise.resolve({
      stat: () =>
        Promise.resolve(
          this.metadata(
            openedIdentity,
            openedIdentity === this.identity ? this.contents : openedContents,
          ),
        ),
      read: (buffer, offset, length, position) => {
        const call = { position, length };
        this.reads.push(call);
        this.onRead?.(call);
        const contents =
          openedIdentity === this.identity ? this.contents : openedContents;
        if (contents === undefined) return Promise.resolve({ bytesRead: 0 });
        const bytesRead = Math.max(
          0,
          Math.min(length, contents.length - position),
        );
        contents.copy(buffer, offset, position, position + bytesRead);
        this.contentBytesRead += bytesRead;
        this.maxReturnedBuffer = Math.max(this.maxReturnedBuffer, bytesRead);
        return Promise.resolve({ bytesRead });
      },
      close: () => {
        this.closes += 1;
        return Promise.resolve();
      },
    });
  }

  private metadata(
    identity = this.identity,
    contents = this.contents,
  ): ReportFileMetadata {
    if (contents === undefined) {
      throw missing();
    }
    return {
      size: contents.length,
      device: 7,
      inode: identity,
      birthtimeMs: identity,
    };
  }
}

function missing(): Error {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

async function captureFailure(promise: Promise<unknown>): Promise<TestAdapterFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TestAdapterFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a test adapter failure.");
}
