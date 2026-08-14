import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadCleanupHelperAsset } from "../src/cleanup-helper.js";

const temporaryDirectories: string[] = [];
const sourceAssetDirectory = resolve(
  import.meta.dirname,
  "../src/native/cleanup-helper/linux-amd64",
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bundled cleanup helper asset", () => {
  it("loads a verified linux/amd64 binary", async () => {
    const asset = await loadCleanupHelperAsset();
    const binary = Buffer.from(asset.base64, "base64");

    expect(asset.platform).toBe("linux");
    expect(asset.architecture).toBe("amd64");
    expect(asset.size).toBe(binary.length);
    expect(asset.sha256).toBe(createHash("sha256").update(binary).digest("hex"));
  });

  it("rejects a corrupted binary", async () => {
    const assetDirectory = await copyAssetDirectory();
    const binaryPath = resolve(assetDirectory, "cleanup-helper");
    const binary = await readFile(binaryPath);
    binary[0] ^= 0xff;
    await writeFile(binaryPath, binary);

    await expect(loadCleanupHelperAsset(pathToDirectoryUrl(assetDirectory))).rejects.toThrow(
      "SHA-256 integrity check",
    );
  });

  it("rejects a malformed manifest", async () => {
    const assetDirectory = await copyAssetDirectory();
    await writeFile(resolve(assetDirectory, "manifest.json"), "{}\n", "utf8");

    await expect(loadCleanupHelperAsset(pathToDirectoryUrl(assetDirectory))).rejects.toThrow(
      "manifest is invalid",
    );
  });
});

async function copyAssetDirectory() {
  const directory = await mkdtemp(resolve(tmpdir(), "local-ydb-cleanup-helper-test-"));
  temporaryDirectories.push(directory);
  await cp(sourceAssetDirectory, directory, { recursive: true });
  return directory;
}

function pathToDirectoryUrl(directory: string) {
  return new URL("./", pathToFileURL(`${directory}/`));
}
