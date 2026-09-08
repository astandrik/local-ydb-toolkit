import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { constants as osConstants } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fileSystemFixture = vi.hoisted(() => ({
  path: "/sentinel/local-ydb-confirmation-input",
  socketPath: "/sentinel/local-ydb-confirmation-input.sock",
  deniedPath: "/sentinel/local-ydb-confirmation-input.denied",
  oversizedPath: "/sentinel/local-ydb-confirmation-input.oversized",
  growingPath: "/sentinel/local-ydb-confirmation-input.growing",
  descriptor: 97_531,
  oversizedDescriptor: 97_532,
  growingDescriptor: 97_533,
  oversizedSize: 16 * 1024 * 1024 + 1,
  openFlags: undefined as Parameters<typeof import("node:fs").openSync>[1] | undefined,
  pathStatCalls: 0,
  oversizedReadCalls: 0,
  growingReadCalls: 0,
  closed: false,
  oversizedClosed: false,
  growingClosed: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (path: Parameters<typeof actual.statSync>[0]) => {
      if (path === fileSystemFixture.path) {
        fileSystemFixture.pathStatCalls += 1;
        return {
          isFile: () => true,
        } as ReturnType<typeof actual.statSync>;
      }
      return actual.statSync(path);
    },
    openSync: (
      path: Parameters<typeof actual.openSync>[0],
      flags: Parameters<typeof actual.openSync>[1],
      mode?: Parameters<typeof actual.openSync>[2],
    ) => {
      if (path === fileSystemFixture.socketPath) {
        fileSystemFixture.openFlags = flags;
        if (process.platform === "darwin") {
          const errno = -osConstants.errno.EOPNOTSUPP;
          throw Object.assign(new Error("fixture socket target"), {
            code: `Unknown system error ${errno}`,
            errno,
          });
        }
        throw Object.assign(new Error("fixture socket target"), {
          code: "ENXIO",
          errno: -osConstants.errno.ENXIO,
        });
      }
      if (path === fileSystemFixture.deniedPath) {
        fileSystemFixture.openFlags = flags;
        throw Object.assign(new Error("fixture read denied"), { code: "EACCES" });
      }
      if (path === fileSystemFixture.path) {
        fileSystemFixture.openFlags = flags;
        return fileSystemFixture.descriptor;
      }
      if (path === fileSystemFixture.oversizedPath) {
        fileSystemFixture.openFlags = flags;
        return fileSystemFixture.oversizedDescriptor;
      }
      if (path === fileSystemFixture.growingPath) {
        fileSystemFixture.openFlags = flags;
        return fileSystemFixture.growingDescriptor;
      }
      return actual.openSync(path, flags, mode);
    },
    fstatSync: (descriptor: number) => (
      descriptor === fileSystemFixture.descriptor
        ? {
            isFile: () => true,
            size: 0,
          } as ReturnType<typeof actual.fstatSync>
        : descriptor === fileSystemFixture.oversizedDescriptor
          ? {
              isFile: () => true,
              size: fileSystemFixture.oversizedSize,
            } as ReturnType<typeof actual.fstatSync>
          : descriptor === fileSystemFixture.growingDescriptor
            ? {
                isFile: () => true,
                size: 0,
              } as ReturnType<typeof actual.fstatSync>
        : actual.fstatSync(descriptor)
    ),
    readSync: (
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      if (descriptor === fileSystemFixture.descriptor) {
        return 0;
      }
      if (descriptor === fileSystemFixture.oversizedDescriptor) {
        fileSystemFixture.oversizedReadCalls += 1;
        return 0;
      }
      if (descriptor === fileSystemFixture.growingDescriptor) {
        fileSystemFixture.growingReadCalls += 1;
        return Math.min(length, 64 * 1024);
      }
      return actual.readSync(descriptor, buffer, offset, length, position);
    },
    closeSync: (descriptor: number) => {
      if (descriptor === fileSystemFixture.descriptor) {
        fileSystemFixture.closed = true;
        return;
      }
      if (descriptor === fileSystemFixture.oversizedDescriptor) {
        fileSystemFixture.oversizedClosed = true;
        return;
      }
      if (descriptor === fileSystemFixture.growingDescriptor) {
        fileSystemFixture.growingClosed = true;
        return;
      }
      actual.closeSync(descriptor);
    },
  };
});

import {
  confirmationContentIntent,
  MAX_CONFIRMATION_FILE_BYTES,
} from "../src/confirmation-inputs.js";
import { createContext } from "../src/operations/context.js";
import { ConfigSchema } from "../src/validation.js";

describe("confirmation special-file inputs", () => {
  beforeEach(() => {
    fileSystemFixture.openFlags = undefined;
    fileSystemFixture.pathStatCalls = 0;
    fileSystemFixture.oversizedReadCalls = 0;
    fileSystemFixture.growingReadCalls = 0;
    fileSystemFixture.closed = false;
    fileSystemFixture.oversizedClosed = false;
    fileSystemFixture.growingClosed = false;
  });

  it("fingerprints local files through one nonblocking descriptor without a path stat", async () => {
    const context = createContext(undefined, undefined, ConfigSchema.parse({}));

    const intent = await confirmationContentIntent(context, [{
      kind: "file",
      path: fileSystemFixture.path,
      role: "fixture-secret",
    }]);

    expect(intent).toEqual([{
      kind: "file",
      path: fileSystemFixture.path,
      role: "fixture-secret",
      state: "file",
      sha256: createHash("sha256").digest("hex"),
    }]);
    expect(fileSystemFixture.openFlags).toBe(
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    );
    expect(fileSystemFixture.pathStatCalls).toBe(0);
    expect(fileSystemFixture.closed).toBe(true);
  });

  it("classifies platform socket open errors as non-files", async () => {
    const context = createContext(undefined, undefined, ConfigSchema.parse({}));

    const intent = await confirmationContentIntent(context, [{
      kind: "file",
      path: fileSystemFixture.socketPath,
      role: "fixture-socket",
    }]);

    expect(intent).toEqual([{
      kind: "file",
      path: fileSystemFixture.socketPath,
      role: "fixture-socket",
      state: "not-file",
    }]);
    expect(fileSystemFixture.openFlags).toBe(
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    );
    expect(fileSystemFixture.pathStatCalls).toBe(0);
    expect(fileSystemFixture.closed).toBe(false);
  });

  it("keeps regular access failures generic and non-disclosing", async () => {
    const context = createContext(undefined, undefined, ConfigSchema.parse({}));
    let error: unknown;
    try {
      await confirmationContentIntent(context, [{
        kind: "file",
        path: fileSystemFixture.deniedPath,
        role: "fixture-denied",
      }]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Unable to fingerprint a confirmation content input");
    expect(String(error)).not.toContain(fileSystemFixture.deniedPath);
    expect(fileSystemFixture.openFlags).toBe(
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    );
    expect(fileSystemFixture.pathStatCalls).toBe(0);
    expect(fileSystemFixture.closed).toBe(false);
  });

  it("rejects oversized local credential files before synchronous hashing", async () => {
    const context = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(confirmationContentIntent(context, [{
      kind: "file",
      path: fileSystemFixture.oversizedPath,
      role: "fixture-oversized",
    }])).rejects.toThrow("Unable to fingerprint a confirmation content input");

    expect(fileSystemFixture.oversizedSize).toBe(MAX_CONFIRMATION_FILE_BYTES + 1);
    expect(fileSystemFixture.openFlags).toBe(
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    );
    expect(fileSystemFixture.oversizedReadCalls).toBe(0);
    expect(fileSystemFixture.oversizedClosed).toBe(true);
  });

  it("stops hashing when a local file grows beyond its reviewed descriptor size", async () => {
    const context = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(confirmationContentIntent(context, [{
      kind: "file",
      path: fileSystemFixture.growingPath,
      role: "fixture-growing",
    }])).rejects.toThrow("Unable to fingerprint a confirmation content input");

    expect(fileSystemFixture.growingReadCalls).toBe(1);
    expect(fileSystemFixture.growingClosed).toBe(true);
  });
});
