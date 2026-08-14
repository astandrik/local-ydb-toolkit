import { chmod, copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildCleanupHelper } from "./build-helper.mjs";
import {
  helperAssetDirectory,
  helperBinaryPath,
  helperManifestPath,
  helperSourcePath,
} from "./config.mjs";
import { createManifest } from "./manifest.mjs";

const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "local-ydb-cleanup-helper-build-"));
try {
  const temporaryBinary = resolve(temporaryDirectory, "cleanup-helper");
  await buildCleanupHelper(temporaryBinary);
  const manifest = await createManifest(helperSourcePath, temporaryBinary);

  await mkdir(helperAssetDirectory, { recursive: true });
  await copyFile(temporaryBinary, helperBinaryPath);
  await chmod(helperBinaryPath, 0o755);
  await writeFile(helperManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
