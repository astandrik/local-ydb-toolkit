import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_ASSET_DIRECTORY = new URL("./native/cleanup-helper/linux-amd64/", import.meta.url);
const MAX_HELPER_SIZE_BYTES = 2 * 1024 * 1024;
const BINARY_ASSET_PATH =
  "packages/core/src/native/cleanup-helper/linux-amd64/cleanup-helper";

export interface CleanupHelperAsset {
  platform: "linux";
  architecture: "amd64";
  sha256: string;
  size: number;
  base64: string;
}

interface CleanupHelperManifest {
  schemaVersion: 1;
  platform: "linux";
  architecture: "amd64";
  binary: {
    path: string;
    sha256: string;
    size: number;
  };
}

export async function loadCleanupHelperAsset(
  assetDirectory: URL = DEFAULT_ASSET_DIRECTORY,
): Promise<CleanupHelperAsset> {
  const manifest = parseManifest(
    JSON.parse(await readFile(new URL("manifest.json", assetDirectory), "utf8")) as unknown,
  );
  const binary = await readFile(new URL("cleanup-helper", assetDirectory));
  if (binary.length !== manifest.binary.size) {
    throw new Error(
      `Bundled cleanup helper size mismatch: expected ${manifest.binary.size}, got ${binary.length}.`,
    );
  }
  const digest = createHash("sha256").update(binary).digest("hex");
  if (digest !== manifest.binary.sha256) {
    throw new Error("Bundled cleanup helper failed its SHA-256 integrity check.");
  }
  return {
    platform: manifest.platform,
    architecture: manifest.architecture,
    sha256: digest,
    size: binary.length,
    base64: binary.toString("base64"),
  };
}

function parseManifest(value: unknown): CleanupHelperManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.platform !== "linux" ||
      value.architecture !== "amd64" || !isRecord(value.binary) ||
      value.binary.path !== BINARY_ASSET_PATH || typeof value.binary.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.binary.sha256) ||
      typeof value.binary.size !== "number" || !Number.isSafeInteger(value.binary.size) ||
      value.binary.size <= 0 || value.binary.size > MAX_HELPER_SIZE_BYTES) {
    throw new Error("Bundled cleanup helper manifest is invalid.");
  }
  return value as unknown as CleanupHelperManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
