import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  binaryRelativePath,
  builderImage,
  compilerFlags,
  sourceRelativePath,
} from "./config.mjs";

export async function sha256File(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

export async function createManifest(sourcePath, binaryPath) {
  const binary = await readFile(binaryPath);
  return {
    schemaVersion: 1,
    platform: "linux",
    architecture: "amd64",
    source: {
      path: sourceRelativePath,
      sha256: await sha256File(sourcePath),
    },
    binary: {
      path: binaryRelativePath,
      sha256: createHash("sha256").update(binary).digest("hex"),
      size: binary.length,
    },
    builder: {
      image: builderImage,
      compiler: "gcc",
      flags: compilerFlags,
      environment: {
        LC_ALL: "C",
        SOURCE_DATE_EPOCH: "0",
        TZ: "UTC",
      },
    },
  };
}
