import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildCleanupHelper } from "./build-helper.mjs";
import { helperBinaryPath } from "./config.mjs";

const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "local-ydb-cleanup-helper-check-"));
try {
  const rebuiltBinaryPath = resolve(temporaryDirectory, "cleanup-helper");
  await buildCleanupHelper(rebuiltBinaryPath);
  const [committedBinary, rebuiltBinary] = await Promise.all([
    readFile(helperBinaryPath),
    readFile(rebuiltBinaryPath),
  ]);
  if (!committedBinary.equals(rebuiltBinary)) {
    throw new Error(
      "cleanup-helper binary is stale or non-reproducible; run npm run cleanup-helper:build",
    );
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
