import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  builderImage,
  compilerFlags,
  helperBinaryPath,
  helperSourcePath,
  repositoryRoot,
} from "./config.mjs";

const temporaryDirectories = [];
const statxEnosysWrapperSource = resolve(
  repositoryRoot,
  "scripts/cleanup-helper/statx-enosys-wrapper.c",
);
const unlinkPauseWrapperSource = resolve(
  repositoryRoot,
  "scripts/cleanup-helper/unlink-pause-wrapper.c",
);
const renameat2EnosysWrapperSource = resolve(
  repositoryRoot,
  "scripts/cleanup-helper/renameat2-enosys-wrapper.c",
);

try {
  await assertDockerAvailable();
  await testDirectoryCleanup();
  await testMissingAndInvalidTargets();
  await testSymlinkConfinement();
  await testConcurrentIntermediateSwap();
  await testTargetMoveConfinement();
  await testMountConfinement();
  await testRenameat2Requirement();
  await testStatxRequirement();
  process.stdout.write("cleanup-helper native tests passed\n");
} finally {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

async function testDirectoryCleanup() {
  const root = await createRoot("basic");
  await mkdir(resolve(root, "target/nested"), { recursive: true });
  await writeFile(resolve(root, "target/nested/data"), "data", "utf8");
  await mkdir(resolve(root, "outside"));
  await writeFile(resolve(root, "outside/sentinel"), "keep", "utf8");
  await symlink("../../outside/sentinel", resolve(root, "target/nested/link"));

  const result = await runHelper(root, "target");
  assert.equal(result.code, 0, result.stderr);
  await assertMissing(resolve(root, "target"));
  await assertPresent(resolve(root, "outside/sentinel"));
}

async function testMissingAndInvalidTargets() {
  const root = await createRoot("invalid");
  const missing = await runHelper(root, "missing");
  assert.equal(missing.code, 0, missing.stderr);

  await writeFile(resolve(root, "regular-file"), "keep", "utf8");
  const regularFile = await runHelper(root, "regular-file");
  assert.notEqual(regularFile.code, 0);
  assert.match(regularFile.stderr, /target must be a directory/);
  await assertPresent(resolve(root, "regular-file"));

  for (const path of ["", "/target", "target/", "target//child", "target/../child", "target\\child"]) {
    const invalid = await runHelper(root, path);
    assert.equal(invalid.code, 64, `expected usage failure for ${JSON.stringify(path)}: ${invalid.stderr}`);
  }
}

async function testSymlinkConfinement() {
  const root = await createRoot("symlinks");
  await mkdir(resolve(root, "outside/final-target"), { recursive: true });
  await writeFile(resolve(root, "outside/final-target/sentinel"), "keep", "utf8");
  await symlink("outside/final-target", resolve(root, "final-link"));

  const finalSymlink = await runHelper(root, "final-link");
  assert.notEqual(finalSymlink.code, 0);
  assert.match(finalSymlink.stderr, /symlink/);
  await assertPresent(resolve(root, "outside/final-target/sentinel"));

  await mkdir(resolve(root, "outside/intermediate/target"), { recursive: true });
  await writeFile(resolve(root, "outside/intermediate/target/sentinel"), "keep", "utf8");
  await symlink("outside/intermediate", resolve(root, "intermediate-link"));

  const intermediateSymlink = await runHelper(root, "intermediate-link/target");
  assert.notEqual(intermediateSymlink.code, 0);
  assert.match(intermediateSymlink.stderr, /symlink/);
  await assertPresent(resolve(root, "outside/intermediate/target/sentinel"));
}

async function testConcurrentIntermediateSwap() {
  const root = await createRoot("race");
  const checked = resolve(root, "checked");
  const staging = resolve(root, "checked.real");
  const victimSentinel = resolve(root, "victim/target/sentinel");
  await mkdir(resolve(checked, "target/data"), { recursive: true });
  await mkdir(resolve(root, "victim/target"), { recursive: true });
  await writeFile(victimSentinel, "keep", "utf8");
  await Promise.all(
    Array.from({ length: 2_000 }, (_, index) =>
      writeFile(resolve(checked, `target/data/file-${index}`), `${index}`, "utf8")),
  );

  let finished = false;
  const helperRun = runHelper(root, "checked/target").finally(() => {
    finished = true;
  });
  let swaps = 0;
  for (let attempt = 0; attempt < 1_000 && !finished; attempt++) {
    try {
      await rename(checked, staging);
      await symlink("victim", checked);
      swaps++;
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      await unlink(checked);
      await rename(staging, checked);
    } catch {
      await restoreCheckedDirectory(checked, staging);
    }
  }
  const result = await helperRun;
  await restoreCheckedDirectory(checked, staging);

  assert.ok(swaps > 0, "race test did not install the intermediate symlink");
  assert.ok(result.code === 0 || result.code === 65 || result.code === 70, result.stderr);
  await assertPresent(victimSentinel);
}

async function testTargetMoveConfinement() {
  const workspace = await createRoot("target-move");
  const root = resolve(workspace, "cleanup-root");
  const outside = resolve(workspace, "outside");
  const target = resolve(root, "target");
  const movedTarget = resolve(outside, "moved-target");
  const readyMarker = resolve(root, ".cleanup-helper-test-unlink-ready");
  const continueMarker = resolve(root, ".cleanup-helper-test-unlink-continue");
  await mkdir(target, { recursive: true });
  await mkdir(outside);
  await writeFile(resolve(target, "sentinel"), "keep", "utf8");
  const pausedHelper = await buildWrappedHelper(
    root,
    "cleanup-helper-unlink-pause",
    unlinkPauseWrapperSource,
    "unlinkat",
  );

  const helperRun = runHelperBinary(root, "target", pausedHelper);
  let moveSucceeded = false;
  let moveError;
  try {
    await waitForPath(readyMarker);
    try {
      await rename(target, movedTarget);
      moveSucceeded = true;
    } catch (error) {
      moveError = error;
    }
  } finally {
    await writeFile(continueMarker, "continue", "utf8");
  }

  const result = await helperRun;
  assert.equal(result.code, 0, result.stderr);
  if (moveSucceeded) {
    await assertPresent(resolve(movedTarget, "sentinel"));
  } else {
    assert.equal(moveError?.code, "ENOENT", String(moveError));
    await assertMissing(movedTarget);
  }
  const leakedClaims = (await readdir(root)).filter((name) => name.startsWith(".local-ydb-cleanup-"));
  assert.deepEqual(leakedClaims, []);
}

async function testMountConfinement() {
  const root = await createRoot("mounts");
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  assert.notEqual(hostUid, undefined, "mount tests require a POSIX host uid");
  assert.notEqual(hostGid, undefined, "mount tests require a POSIX host gid");
  const script = String.raw`
set -euo pipefail
cleanup_mount() { mountpoint -q "$1" && umount "$1" || true; }
trap 'cleanup_mount /cleanup-root/disk; cleanup_mount /cleanup-root/target; cleanup_mount /cleanup-root/descendant/mounted' EXIT

mkdir -p /cleanup-root/disk
chown "$CLEANUP_HOST_UID:$CLEANUP_HOST_GID" /cleanup-root/disk
mount -t tmpfs -o size=1m tmpfs /cleanup-root/disk
mkdir -p /cleanup-root/disk/target
if /cleanup-helper /cleanup-root disk/target; then exit 21; fi
cleanup_mount /cleanup-root/disk

mkdir -p /cleanup-root/target
chown "$CLEANUP_HOST_UID:$CLEANUP_HOST_GID" /cleanup-root/target
mount -t tmpfs -o size=1m tmpfs /cleanup-root/target
touch /cleanup-root/target/sentinel
if /cleanup-helper /cleanup-root target; then exit 22; fi
test -f /cleanup-root/target/sentinel
cleanup_mount /cleanup-root/target

mkdir -p /cleanup-root/descendant/mounted
chown -R "$CLEANUP_HOST_UID:$CLEANUP_HOST_GID" /cleanup-root/descendant
mount -t tmpfs -o size=1m tmpfs /cleanup-root/descendant/mounted
touch /cleanup-root/descendant/mounted/sentinel
if /cleanup-helper /cleanup-root descendant; then exit 23; fi
test -f /cleanup-root/descendant/mounted/sentinel
cleanup_mount /cleanup-root/descendant/mounted
`;
  const result = await runDocker([
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--network",
    "none",
    "--read-only",
    "--privileged",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=16m",
    "--env",
    `CLEANUP_HOST_UID=${hostUid}`,
    "--env",
    `CLEANUP_HOST_GID=${hostGid}`,
    "--mount",
    `type=bind,src=${root},dst=/cleanup-root`,
    "--mount",
    `type=bind,src=${helperBinaryPath},dst=/cleanup-helper,readonly`,
    "--entrypoint",
    "/bin/bash",
    builderImage,
    "-c",
    script,
  ], 60_000);
  assert.equal(result.code, 0, result.stderr);
}

async function testStatxRequirement() {
  const root = await createRoot("statx");
  await mkdir(resolve(root, "target"));
  const unavailableHelper = await buildWrappedHelper(
    root,
    "cleanup-helper-statx-enosys",
    statxEnosysWrapperSource,
    "syscall",
  );
  const result = await runHelperBinary(root, "target", unavailableHelper);
  assert.equal(result.code, 70, result.stderr);
  assert.match(result.stderr, /Linux STATX_MNT_ID support is required/);
  await assertPresent(resolve(root, "target"));
}

async function testRenameat2Requirement() {
  const root = await createRoot("renameat2");
  await mkdir(resolve(root, "target"));
  await writeFile(resolve(root, "target/sentinel"), "keep", "utf8");
  const unavailableHelper = await buildWrappedHelper(
    root,
    "cleanup-helper-renameat2-enosys",
    renameat2EnosysWrapperSource,
    "renameat2",
  );
  const result = await runHelperBinary(root, "target", unavailableHelper);
  assert.equal(result.code, 70, result.stderr);
  assert.match(result.stderr, /Linux renameat2 RENAME_NOREPLACE support is required/);
  await assertPresent(resolve(root, "target/sentinel"));
  const leakedClaims = (await readdir(root)).filter((name) => name.startsWith(".local-ydb-cleanup-"));
  assert.deepEqual(leakedClaims, []);
}

async function buildWrappedHelper(root, outputName, wrapperSource, wrappedSymbol) {
  const outputPath = resolve(root, outputName);
  const userArgs = typeof process.getuid === "function" && typeof process.getgid === "function"
    ? ["--user", `${process.getuid()}:${process.getgid()}`]
    : [];
  const buildResult = await runDocker([
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    ...userArgs,
    "--mount",
    `type=bind,src=${helperSourcePath},dst=/src/cleanup-helper.c,readonly`,
    "--mount",
    `type=bind,src=${wrapperSource},dst=/src/test-wrapper.c,readonly`,
    "--mount",
    `type=bind,src=${root},dst=/out`,
    "--entrypoint",
    "gcc",
    builderImage,
    ...compilerFlags,
    `-Wl,--wrap=${wrappedSymbol}`,
    "-o",
    `/out/${outputName}`,
    "/src/cleanup-helper.c",
    "/src/test-wrapper.c",
  ], 60_000);
  assert.equal(buildResult.code, 0, buildResult.stderr);
  return outputPath;
}

async function runHelper(root, relativePath) {
  return runHelperBinary(root, relativePath, helperBinaryPath);
}

async function runHelperBinary(root, relativePath, binaryPath) {
  return runDocker([
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--network",
    "none",
    "--read-only",
    "--pids-limit",
    "64",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "FOWNER",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,src=${root},dst=/cleanup-root`,
    "--mount",
    `type=bind,src=${binaryPath},dst=/cleanup-helper,readonly`,
    "--entrypoint",
    "/cleanup-helper",
    builderImage,
    "/cleanup-root",
    relativePath,
  ]);
}

async function assertDockerAvailable() {
  const result = await runDocker(["info", "--format", "{{.ServerVersion}}"]);
  if (result.code !== 0) {
    throw new Error(`cleanup-helper tests require a running Docker daemon: ${result.stderr.trim()}`);
  }
}

async function runDocker(args, timeoutMs = 30_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`));
      } else {
        resolvePromise({ code, stdout, stderr });
      }
    });
  });
}

async function createRoot(label) {
  const directory = await mkdtemp(resolve(tmpdir(), `local-ydb-cleanup-helper-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function restoreCheckedDirectory(checked, staging) {
  const checkedStatus = await lstat(checked).catch(() => undefined);
  if (checkedStatus?.isSymbolicLink()) {
    await unlink(checked);
  }
  const stagingStatus = await lstat(staging).catch(() => undefined);
  const restoredStatus = await lstat(checked).catch(() => undefined);
  if (stagingStatus && !restoredStatus) {
    await rename(staging, checked);
  }
}

async function assertPresent(path) {
  await access(path, fsConstants.F_OK);
}

async function assertMissing(path) {
  await assert.rejects(access(path, fsConstants.F_OK));
}

async function waitForPath(path) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await access(path, fsConstants.F_OK).then(() => true, () => false)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}
