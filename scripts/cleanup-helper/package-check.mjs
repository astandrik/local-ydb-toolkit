import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  helperBinaryPath,
  helperManifestPath,
  repositoryRoot,
} from "./config.mjs";

const packResult = await runNpmPack();
const files = packResult.files ?? [];
const binaryPackagePath = "dist/vendor/core/native/cleanup-helper/linux-amd64/cleanup-helper";
const manifestPackagePath = "dist/vendor/core/native/cleanup-helper/linux-amd64/manifest.json";
const binaryEntry = files.find((entry) => entry.path === binaryPackagePath);
const manifestEntry = files.find((entry) => entry.path === manifestPackagePath);

if (!binaryEntry || !manifestEntry) {
  throw new Error("MCP package is missing the bundled cleanup helper binary or manifest.");
}
const nativeEntries = files.filter((entry) => entry.path.includes("native/cleanup-helper/"));
if (nativeEntries.length !== 2) {
  throw new Error(`MCP package contains unexpected cleanup-helper files: ${JSON.stringify(nativeEntries)}`);
}
if (typeof binaryEntry.mode === "number" && (binaryEntry.mode & 0o111) === 0) {
  throw new Error("Bundled cleanup helper is not executable in the MCP package.");
}

const vendoredBinaryPath = resolve(
  repositoryRoot,
  "packages/mcp-server/dist/vendor/core/native/cleanup-helper/linux-amd64/cleanup-helper",
);
const vendoredManifestPath = resolve(
  repositoryRoot,
  "packages/mcp-server/dist/vendor/core/native/cleanup-helper/linux-amd64/manifest.json",
);
const vendoredLoaderPath = resolve(
  repositoryRoot,
  "packages/mcp-server/dist/vendor/core/cleanup-helper.js",
);
const [sourceBinary, vendoredBinary, sourceManifest, vendoredManifest, vendoredStatus] =
  await Promise.all([
    readFile(helperBinaryPath),
    readFile(vendoredBinaryPath),
    readFile(helperManifestPath),
    readFile(vendoredManifestPath),
    stat(vendoredBinaryPath),
  ]);
if (!sourceBinary.equals(vendoredBinary) || !sourceManifest.equals(vendoredManifest)) {
  throw new Error("Vendored cleanup helper differs from the verified core asset.");
}
if ((vendoredStatus.mode & 0o111) === 0) {
  throw new Error("Vendored cleanup helper lost its executable mode.");
}

const manifest = JSON.parse(sourceManifest.toString("utf8"));
const digest = createHash("sha256").update(vendoredBinary).digest("hex");
if (digest !== manifest.binary.sha256) {
  throw new Error("Vendored cleanup helper digest does not match its manifest.");
}
const vendoredLoader = await import(pathToFileURL(vendoredLoaderPath).href);
const loadedAsset = await vendoredLoader.loadCleanupHelperAsset();
if (loadedAsset.sha256 !== digest || loadedAsset.size !== vendoredBinary.length) {
  throw new Error("Vendored cleanup helper cannot be loaded with its runtime integrity check.");
}

async function runNpmPack() {
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(
      "npm",
      ["pack", "--dry-run", "--json", "--workspace", "@astandrik/local-ydb-mcp"],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "inherit"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolvePromise(stdout);
      } else {
        reject(new Error(`npm pack exited with code ${exitCode ?? "unknown"}`));
      }
    });
  });
  const parsed = JSON.parse(result);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`Unexpected npm pack output: ${result}`);
  }
  return parsed[0];
}
