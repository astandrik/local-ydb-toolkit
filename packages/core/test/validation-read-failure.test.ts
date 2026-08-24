import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fileSystemFixture = vi.hoisted(() => ({
  unreadablePath: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = (
    path: Parameters<typeof actual.openSync>[0],
    flags: Parameters<typeof actual.openSync>[1],
    mode?: Parameters<typeof actual.openSync>[2],
  ) => {
    if (path === fileSystemFixture.unreadablePath) {
      const error = Object.assign(new Error("fixture read denied"), { code: "EACCES" });
      throw error;
    }
    return actual.openSync(path, flags, mode);
  };
  return { ...actual, openSync };
});

import { ConfigLoadError, loadConfig } from "../src/validation.js";

describe("config read failures", () => {
  it("reports unreadable files without relying on process privileges", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-config-unreadable-"));
    const configPath = join(dir, "config.json");
    const marker = "BENIGN_UNREADABLE_CONFIG_MARKER";
    writeFileSync(configPath, marker, "utf8");
    fileSystemFixture.unreadablePath = configPath;

    try {
      let error: unknown;
      try {
        loadConfig(configPath);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigLoadError);
      expect(error).toMatchObject({ code: "CONFIG_READ_FAILED" });
      expect(String(error)).not.toContain(configPath);
      expect(String(error)).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(configPath);
      expect(JSON.stringify(error)).not.toContain(marker);
    } finally {
      fileSystemFixture.unreadablePath = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
