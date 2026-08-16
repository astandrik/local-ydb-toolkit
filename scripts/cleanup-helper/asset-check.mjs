import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  binaryRelativePath,
  builderImage,
  compilerFlags,
  helperBinaryPath,
  helperManifestPath,
  helperSourcePath,
  sourceRelativePath,
} from "./config.mjs";

const manifest = JSON.parse(await readFile(helperManifestPath, "utf8"));
const source = await readFile(helperSourcePath);
const binary = await readFile(helperBinaryPath);
const binaryStatus = await stat(helperBinaryPath);

assertEqual(manifest.schemaVersion, 1, "manifest schemaVersion");
assertEqual(manifest.platform, "linux", "manifest platform");
assertEqual(manifest.architecture, "amd64", "manifest architecture");
assertEqual(manifest.source?.path, sourceRelativePath, "manifest source path");
assertEqual(manifest.source?.sha256, sha256(source), "manifest source digest");
assertEqual(manifest.binary?.path, binaryRelativePath, "manifest binary path");
assertEqual(manifest.binary?.sha256, sha256(binary), "manifest binary digest");
assertEqual(manifest.binary?.size, binary.length, "manifest binary size");
assertEqual(manifest.builder?.image, builderImage, "manifest builder image");
assertEqual(manifest.builder?.compiler, "gcc", "manifest compiler");
assertEqual(JSON.stringify(manifest.builder?.flags), JSON.stringify(compilerFlags), "compiler flags");
assertEqual(binaryStatus.isFile(), true, "binary asset type");
assertEqual((binaryStatus.mode & 0o111) !== 0, true, "binary executable mode");
assertStaticLinuxAmd64Elf(binary);

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function assertStaticLinuxAmd64Elf(binaryContents) {
  assertEqual(binaryContents.length >= 64, true, "ELF header size");
  assertEqual(binaryContents.subarray(0, 4).toString("hex"), "7f454c46", "ELF magic");
  assertEqual(binaryContents[4], 2, "ELF class");
  assertEqual(binaryContents[5], 1, "ELF byte order");
  assertEqual(binaryContents.readUInt16LE(18), 62, "ELF machine");

  const programHeaderOffset = Number(binaryContents.readBigUInt64LE(32));
  const programHeaderEntrySize = binaryContents.readUInt16LE(54);
  const programHeaderCount = binaryContents.readUInt16LE(56);
  for (let index = 0; index < programHeaderCount; index++) {
    const headerOffset = programHeaderOffset + index * programHeaderEntrySize;
    if (headerOffset + 4 > binaryContents.length) {
      throw new Error("cleanup-helper asset check failed: invalid ELF program header table");
    }
    const programType = binaryContents.readUInt32LE(headerOffset);
    if (programType === 2 || programType === 3) {
      throw new Error("cleanup-helper asset check failed: binary is dynamically linked");
    }
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `cleanup-helper asset check failed for ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
