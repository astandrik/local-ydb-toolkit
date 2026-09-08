import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { constants as osConstants } from "node:os";

export type BoundedFileReadErrorCode =
  | "not-found"
  | "not-file"
  | "too-large"
  | "read-failed";

export class BoundedFileReadError extends Error {
  constructor(readonly code: BoundedFileReadErrorCode) {
    super("Bounded regular-file read failed");
    this.name = "BoundedFileReadError";
  }
}

export interface BoundedFileContents {
  text: string;
  contentSha256: string;
  mode: number;
}

const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

export function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
): BoundedFileContents {
  let descriptor: number;
  try {
    descriptor = openSync(path, READ_FLAGS);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new BoundedFileReadError("not-found");
    }
    if (isNonRegularOpenError(error)) {
      throw new BoundedFileReadError("not-file");
    }
    throw new BoundedFileReadError("read-failed");
  }

  try {
    let stats: ReturnType<typeof fstatSync>;
    try {
      stats = fstatSync(descriptor);
    } catch {
      throw new BoundedFileReadError("read-failed");
    }
    if (!stats.isFile()) {
      throw new BoundedFileReadError("not-file");
    }
    if (stats.size > maximumBytes) {
      throw new BoundedFileReadError("too-large");
    }

    let buffer = Buffer.alloc(Math.min(
      maximumBytes + 1,
      Math.max(4_096, stats.size + 1),
    ));
    let bytesRead = 0;
    try {
      while (true) {
        if (bytesRead === buffer.length) {
          if (buffer.length === maximumBytes + 1) {
            break;
          }
          const expanded = Buffer.alloc(Math.min(
            maximumBytes + 1,
            buffer.length * 2,
          ));
          buffer.copy(expanded);
          buffer = expanded;
        }
        const count = readSync(
          descriptor,
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          null,
        );
        if (count === 0) {
          break;
        }
        bytesRead += count;
      }
    } catch {
      throw new BoundedFileReadError("read-failed");
    }
    if (bytesRead > maximumBytes) {
      throw new BoundedFileReadError("too-large");
    }

    const text = buffer.toString("utf8", 0, bytesRead);
    return {
      text,
      contentSha256: createHash("sha256").update(text).digest("hex"),
      mode: stats.mode & 0o777,
    };
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // The read result or bounded failure remains authoritative.
    }
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isNonRegularOpenError(error: unknown): boolean {
  const darwinSocketError = process.platform === "darwin"
    && error instanceof Error
    && "errno" in error
    && error.errno === -osConstants.errno.EOPNOTSUPP;
  // Linux reports sockets as ENXIO; Darwin uses EOPNOTSUPP, which Node exposes via errno.
  return isFileSystemError(error, "EISDIR")
    || isFileSystemError(error, "ENXIO")
    || darwinSocketError;
}
