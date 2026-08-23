import { constants } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const fileSystemFixture = vi.hoisted(() => ({
  specialPath: "/sentinel/local-ydb-config.fifo",
  descriptor: 24_680,
  openFlags: undefined as Parameters<typeof import("node:fs").openSync>[1] | undefined,
  closed: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (
      path: Parameters<typeof actual.openSync>[0],
      flags: Parameters<typeof actual.openSync>[1],
      mode?: Parameters<typeof actual.openSync>[2],
    ) => {
      if (path === fileSystemFixture.specialPath) {
        fileSystemFixture.openFlags = flags;
        return fileSystemFixture.descriptor;
      }
      return actual.openSync(path, flags, mode);
    },
    fstatSync: (descriptor: number) => (
      descriptor === fileSystemFixture.descriptor
        ? actual.statSync(process.cwd())
        : actual.fstatSync(descriptor)
    ),
    closeSync: (descriptor: number) => {
      if (descriptor === fileSystemFixture.descriptor) {
        fileSystemFixture.closed = true;
        return;
      }
      actual.closeSync(descriptor);
    },
  };
});

import { ConfigLoadError, loadConfig } from "../src/validation.js";

describe("config special files", () => {
  it("opens candidates without blocking before rejecting non-regular files", () => {
    let error: unknown;
    try {
      loadConfig(fileSystemFixture.specialPath);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigLoadError);
    expect(error).toMatchObject({ code: "CONFIG_NOT_FILE" });
    expect(fileSystemFixture.openFlags).toBe(
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    );
    expect(fileSystemFixture.closed).toBe(true);
    expect(String(error)).not.toContain(fileSystemFixture.specialPath);
  });
});
