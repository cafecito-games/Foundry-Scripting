import { createHash, type Hash } from "node:crypto";
import {
  open as openFile,
  stat as statFile,
  type FileHandle,
} from "node:fs/promises";
import { TestAdapterFailure } from "./adapter.js";

export const REPORT_READ_CHUNK_SIZE = 64 * 1024;

export interface ReportFileMetadata {
  readonly size: number;
  readonly device: number | bigint;
  readonly inode: number | bigint;
  readonly birthtimeMs: number;
}

export interface ReportFileHandle {
  readonly stat: () => Promise<ReportFileMetadata>;
  readonly read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesRead: number }>;
  readonly close: () => Promise<void>;
}

export interface ReportFileAccess {
  readonly stat: (path: string) => Promise<ReportFileMetadata>;
  readonly open: (path: string) => Promise<ReportFileHandle>;
}

export interface ReportReadResult {
  readonly present: boolean;
  readonly bytesRead: number;
  readonly totalBytes: number;
}

export interface ReportVerificationResult {
  readonly present: boolean;
}

const nodeReportFileAccess: ReportFileAccess = {
  async stat(path): Promise<ReportFileMetadata> {
    return toMetadata(await statFile(path));
  },
  async open(path): Promise<ReportFileHandle> {
    return fromNodeHandle(await openFile(path, "r"));
  },
};

/** Streams a growing report while retaining only its handle, offset, and block digests. */
export class IncrementalReportReader {
  private handle: ReportFileHandle | undefined;
  private identity: string | undefined;
  private offset = 0;
  private readonly blockDigests: Buffer[] = [];
  private partialBlockHash: Hash = createHash("sha256");
  private partialBlockBytes = 0;
  private closed = false;

  constructor(
    private readonly reportPath: string,
    private readonly files: ReportFileAccess = nodeReportFileAccess,
  ) {}

  async readAvailable(onChunk: (chunk: Buffer) => void): Promise<ReportReadResult> {
    this.assertOpen();
    const metadata = await this.pathMetadata();
    if (metadata === undefined) {
      return { present: false, bytesRead: 0, totalBytes: this.offset };
    }

    const handleMetadata = await this.ensureHandle(metadata);
    this.assertCurrentIdentity(metadata, handleMetadata);
    this.assertNotTruncated(metadata.size);
    this.assertNotTruncated(handleMetadata.size);

    const startedAt = this.offset;
    const targetSize = handleMetadata.size;
    while (this.offset < targetSize) {
      const requested = Math.min(REPORT_READ_CHUNK_SIZE, targetSize - this.offset);
      const buffer = Buffer.allocUnsafe(requested);
      const { bytesRead } = await this.read(buffer, requested, this.offset);
      if (bytesRead === 0) {
        await this.rejectUnexpectedEnd(targetSize);
      }
      const chunk = buffer.subarray(0, bytesRead);
      onChunk(chunk);
      this.recordDigest(chunk);
      this.offset += bytesRead;
    }

    return {
      present: true,
      bytesRead: this.offset - startedAt,
      totalBytes: this.offset,
    };
  }

  async verifyFinal(): Promise<ReportVerificationResult> {
    this.assertOpen();
    const pathBefore = await this.pathMetadata();
    if (pathBefore === undefined) {
      return { present: false };
    }
    const handleMetadata = await this.ensureHandle(pathBefore);
    this.assertCurrentIdentity(pathBefore, handleMetadata);
    this.assertExactFinalSize(pathBefore.size);
    this.assertExactFinalSize(handleMetadata.size);

    let position = 0;
    let block = 0;
    while (position < this.offset) {
      const requested = Math.min(REPORT_READ_CHUNK_SIZE, this.offset - position);
      const buffer = Buffer.allocUnsafe(requested);
      const { bytesRead } = await this.read(buffer, requested, position);
      if (bytesRead !== requested) {
        await this.rejectUnexpectedEnd(this.offset);
      }
      const digest = createHash("sha256")
        .update(buffer.subarray(0, bytesRead))
        .digest();
      if (!digest.equals(this.expectedDigest(block))) {
        throw changedBytesFailure();
      }
      position += bytesRead;
      block += 1;
    }

    const pathAfter = await this.pathMetadata();
    if (pathAfter === undefined) {
      return { present: false };
    }
    const handleAfter = await this.handleMetadata();
    this.assertCurrentIdentity(pathAfter, handleAfter);
    this.assertExactFinalSize(pathAfter.size);
    this.assertExactFinalSize(handleAfter.size);
    return { present: true };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const handle = this.handle;
    this.handle = undefined;
    if (handle !== undefined) {
      await handle.close();
    }
  }

  private async ensureHandle(
    initialPathMetadata: ReportFileMetadata,
  ): Promise<ReportFileMetadata> {
    if (this.handle !== undefined) {
      return this.handleMetadata();
    }

    let pathMetadata = initialPathMetadata;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let candidate: ReportFileHandle;
      try {
        candidate = await this.files.open(this.reportPath);
      } catch (error) {
        if (errorCode(error) === "ENOENT" && attempt === 0) {
          const retried = await this.pathMetadata();
          if (retried === undefined) {
            throw reportReadFailure(error);
          }
          pathMetadata = retried;
          continue;
        }
        throw reportReadFailure(error);
      }
      let candidateMetadata: ReportFileMetadata;
      try {
        candidateMetadata = await candidate.stat();
      } catch (error) {
        await candidate.close().catch(() => undefined);
        throw reportReadFailure(error);
      }
      if (sameIdentity(pathMetadata, candidateMetadata)) {
        this.handle = candidate;
        this.identity = fileIdentity(candidateMetadata);
        return candidateMetadata;
      }
      await candidate.close().catch(() => undefined);
      if (attempt === 0) {
        const retried = await this.pathMetadata();
        if (retried === undefined) {
          throw reportReadFailure(Object.assign(new Error("Report disappeared while opening."), {
            code: "ENOENT",
          }));
        }
        pathMetadata = retried;
      }
    }
    throw new TestAdapterFailure(
      "report_read_failed",
      "Unable to read a stable Foundry test adapter execution report.",
    );
  }

  private async pathMetadata(): Promise<ReportFileMetadata | undefined> {
    try {
      return await this.files.stat(this.reportPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return undefined;
      }
      throw reportReadFailure(error);
    }
  }

  private async handleMetadata(): Promise<ReportFileMetadata> {
    try {
      return await this.handle!.stat();
    } catch (error) {
      throw reportReadFailure(error);
    }
  }

  private async read(
    buffer: Buffer,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }> {
    try {
      return await this.handle!.read(buffer, 0, length, position);
    } catch (error) {
      throw reportReadFailure(error);
    }
  }

  private recordDigest(chunk: Buffer): void {
    let position = 0;
    while (position < chunk.length) {
      const length = Math.min(
        REPORT_READ_CHUNK_SIZE - this.partialBlockBytes,
        chunk.length - position,
      );
      this.partialBlockHash.update(chunk.subarray(position, position + length));
      this.partialBlockBytes += length;
      position += length;
      if (this.partialBlockBytes === REPORT_READ_CHUNK_SIZE) {
        this.blockDigests.push(this.partialBlockHash.digest());
        this.partialBlockHash = createHash("sha256");
        this.partialBlockBytes = 0;
      }
    }
  }

  private expectedDigest(block: number): Buffer {
    const complete = this.blockDigests[block];
    if (complete !== undefined) {
      return complete;
    }
    if (block === this.blockDigests.length && this.partialBlockBytes > 0) {
      return this.partialBlockHash.copy().digest();
    }
    throw new TestAdapterFailure(
      "report_read_failed",
      "Unable to verify the Foundry test adapter execution report.",
    );
  }

  private assertCurrentIdentity(
    pathMetadata: ReportFileMetadata,
    handleMetadata: ReportFileMetadata,
  ): void {
    if (
      this.identity !== fileIdentity(pathMetadata) ||
      this.identity !== fileIdentity(handleMetadata)
    ) {
      throw new TestAdapterFailure(
        "malformed_report",
        "The Foundry test adapter execution report was replaced after streaming began.",
      );
    }
  }

  private assertNotTruncated(size: number): void {
    if (size < this.offset) {
      throw new TestAdapterFailure(
        "malformed_report",
        "The Foundry test adapter execution report was truncated after streaming began.",
      );
    }
  }

  private assertExactFinalSize(size: number): void {
    if (size !== this.offset) {
      throw new TestAdapterFailure(
        "malformed_report",
        "The Foundry test adapter execution report size changed during final verification.",
      );
    }
  }

  private async rejectUnexpectedEnd(expectedSize: number): Promise<never> {
    const metadata = await this.handleMetadata();
    if (metadata.size < this.offset || metadata.size < expectedSize) {
      throw new TestAdapterFailure(
        "malformed_report",
        "The Foundry test adapter execution report was truncated after streaming began.",
      );
    }
    throw new TestAdapterFailure(
      "report_read_failed",
      "Unable to read the complete Foundry test adapter execution report.",
    );
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new TestAdapterFailure(
        "report_read_failed",
        "Unable to read a closed Foundry test adapter execution report.",
      );
    }
  }
}

function changedBytesFailure(): TestAdapterFailure {
  return new TestAdapterFailure(
    "malformed_report",
    "The Foundry test adapter execution report changed previously consumed bytes.",
  );
}

function reportReadFailure(cause: unknown): TestAdapterFailure {
  return new TestAdapterFailure(
    "report_read_failed",
    errorCode(cause) === "ENOENT"
      ? "The Foundry test adapter execution report does not exist."
      : "Unable to read the Foundry test adapter execution report.",
    { cause },
  );
}

function sameIdentity(
  left: ReportFileMetadata,
  right: ReportFileMetadata,
): boolean {
  return fileIdentity(left) === fileIdentity(right);
}

function fileIdentity(metadata: ReportFileMetadata): string {
  if (metadata.inode !== 0 && metadata.inode !== 0n) {
    return `${String(metadata.device)}:${String(metadata.inode)}`;
  }
  return `birth:${metadata.birthtimeMs}`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String(error.code);
}

function toMetadata(metadata: {
  readonly size: number;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly birthtimeMs: number;
}): ReportFileMetadata {
  return {
    size: metadata.size,
    device: metadata.dev,
    inode: metadata.ino,
    birthtimeMs: metadata.birthtimeMs,
  };
}

function fromNodeHandle(handle: FileHandle): ReportFileHandle {
  return {
    async stat(): Promise<ReportFileMetadata> {
      return toMetadata(await handle.stat());
    },
    async read(buffer, offset, length, position): Promise<{ readonly bytesRead: number }> {
      return handle.read(buffer, offset, length, position);
    },
    close: () => handle.close(),
  };
}
