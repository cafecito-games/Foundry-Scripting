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
    if (handleMetadata === undefined) {
      return { present: false, bytesRead: 0, totalBytes: this.offset };
    }
    const currentPathMetadata = await this.pathMetadata();
    if (currentPathMetadata === undefined) {
      return { present: false, bytesRead: 0, totalBytes: this.offset };
    }
    this.assertCurrentIdentity(currentPathMetadata, handleMetadata);
    this.assertNotTruncated(currentPathMetadata.size);
    this.assertNotTruncated(handleMetadata.size);

    const startedAt = this.offset;
    const targetSize = handleMetadata.size;
    while (this.offset < targetSize) {
      const requested = Math.min(REPORT_READ_CHUNK_SIZE, targetSize - this.offset);
      const buffer = Buffer.allocUnsafe(requested);
      const { bytesRead } = await this.read(buffer, 0, requested, this.offset);
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
    if (handleMetadata === undefined) {
      return { present: false };
    }
    const currentPathMetadata = await this.pathMetadata();
    if (currentPathMetadata === undefined) {
      return { present: false };
    }
    this.assertCurrentIdentity(currentPathMetadata, handleMetadata);
    this.assertExactFinalSize(currentPathMetadata.size);
    this.assertExactFinalSize(handleMetadata.size);

    let position = 0;
    let block = 0;
    while (position < this.offset) {
      const requested = Math.min(REPORT_READ_CHUNK_SIZE, this.offset - position);
      const buffer = Buffer.allocUnsafe(requested);
      let filled = 0;
      while (filled < requested) {
        const { bytesRead } = await this.read(
          buffer,
          filled,
          requested - filled,
          position + filled,
        );
        if (bytesRead === 0) {
          await this.rejectUnexpectedEnd(this.offset);
        }
        filled += bytesRead;
      }
      const digest = createHash("sha256")
        .update(buffer)
        .digest();
      if (!digest.equals(this.expectedDigest(block))) {
        throw changedBytesFailure();
      }
      position += requested;
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
  ): Promise<ReportFileMetadata | undefined> {
    if (this.handle !== undefined) {
      return this.handleMetadata();
    }

    let pathMetadata = initialPathMetadata;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fileIdentity(pathMetadata);
      let candidate: ReportFileHandle;
      try {
        candidate = await this.files.open(this.reportPath);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          const retried = await this.pathMetadata();
          if (retried === undefined) {
            return undefined;
          }
          if (attempt === 0) {
            pathMetadata = retried;
            continue;
          }
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
      let candidateIdentity: string;
      try {
        candidateIdentity = fileIdentity(candidateMetadata);
      } catch (error) {
        await candidate.close().catch(() => undefined);
        throw error;
      }
      const confirmedPathMetadata = await this.pathMetadata();
      if (confirmedPathMetadata === undefined) {
        await candidate.close().catch(() => undefined);
        return undefined;
      }
      let confirmedPathIdentity: string;
      try {
        confirmedPathIdentity = fileIdentity(confirmedPathMetadata);
      } catch (error) {
        await candidate.close().catch(() => undefined);
        throw error;
      }
      if (confirmedPathIdentity === candidateIdentity) {
        this.handle = candidate;
        this.identity = candidateIdentity;
        return candidateMetadata;
      }
      await candidate.close().catch(() => undefined);
      if (attempt === 0) {
        pathMetadata = confirmedPathMetadata;
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
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }> {
    try {
      return await this.handle!.read(buffer, offset, length, position);
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

function fileIdentity(metadata: ReportFileMetadata): string {
  const device = stableDevice(metadata.device);
  const inode = stablePositive(metadata.inode);
  if (inode !== undefined) {
    return `inode:${device}:${inode}`;
  }
  if (!Number.isFinite(metadata.birthtimeMs) || metadata.birthtimeMs <= 0) {
    throw identityFailure();
  }
  return `birth:${device}:${metadata.birthtimeMs}`;
}

function stableDevice(value: number | bigint): string {
  if (typeof value === "bigint") {
    if (value >= 0n) return String(value);
  } else if (Number.isFinite(value) && value >= 0) {
    return String(value);
  }
  throw identityFailure();
}

function stablePositive(value: number | bigint): string | undefined {
  if (typeof value === "bigint") {
    return value > 0n ? String(value) : undefined;
  }
  return Number.isFinite(value) && value > 0 ? String(value) : undefined;
}

function identityFailure(): TestAdapterFailure {
  return new TestAdapterFailure(
    "report_read_failed",
    "Unable to determine a stable identity for the Foundry test adapter execution report.",
  );
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
