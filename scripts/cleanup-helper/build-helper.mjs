import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  builderImage,
  compilerFlags,
  helperSourcePath,
} from "./config.mjs";

export async function buildCleanupHelper(outputPath) {
  const absoluteOutputPath = resolve(outputPath);
  const outputDirectory = dirname(absoluteOutputPath);
  await mkdir(outputDirectory, { recursive: true });

  const userArgs = typeof process.getuid === "function" && typeof process.getgid === "function"
    ? ["--user", `${process.getuid()}:${process.getgid()}`]
    : [];
  const args = [
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
    "--env",
    "LC_ALL=C",
    "--env",
    "TZ=UTC",
    "--env",
    "SOURCE_DATE_EPOCH=0",
    "--mount",
    `type=bind,src=${helperSourcePath},dst=/src/cleanup-helper.c,readonly`,
    "--mount",
    `type=bind,src=${outputDirectory},dst=/out`,
    "--entrypoint",
    "gcc",
    builderImage,
    ...compilerFlags,
    "-o",
    `/out/${absoluteOutputPath.slice(outputDirectory.length + 1)}`,
    "/src/cleanup-helper.c",
  ];

  await run("docker", args);
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} exited with code ${exitCode ?? "unknown"}`));
      }
    });
  });
}
