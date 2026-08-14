import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const helperSourcePath = resolve(
  repositoryRoot,
  "packages/core/native/cleanup-helper/cleanup-helper.c",
);
export const helperAssetDirectory = resolve(
  repositoryRoot,
  "packages/core/src/native/cleanup-helper/linux-amd64",
);
export const helperBinaryPath = resolve(helperAssetDirectory, "cleanup-helper");
export const helperManifestPath = resolve(helperAssetDirectory, "manifest.json");
export const helperDistDirectory = resolve(
  repositoryRoot,
  "packages/core/dist/native/cleanup-helper/linux-amd64",
);

export const builderImage =
  "docker.io/library/gcc@sha256:82549aa8f90ada3236a8be70c74543132a76662ef33f0c3271ed802b81584a82";

export const compilerFlags = [
  "-std=c17",
  "-O2",
  "-static",
  "-D_FORTIFY_SOURCE=2",
  "-fstack-protector-strong",
  "-fno-ident",
  "-ffile-prefix-map=/src=.",
  "-fdebug-prefix-map=/src=.",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-Wformat=2",
  "-Wshadow",
  "-Wstrict-prototypes",
  "-Wmissing-prototypes",
  "-Wl,--build-id=none",
  "-Wl,-z,noexecstack",
  "-s",
];

export const sourceRelativePath = "packages/core/native/cleanup-helper/cleanup-helper.c";
export const binaryRelativePath =
  "packages/core/src/native/cleanup-helper/linux-amd64/cleanup-helper";
