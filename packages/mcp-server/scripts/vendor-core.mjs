import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageDir, "../..");
const coreDist = resolve(repoRoot, "packages/core/dist");
const serverDist = resolve(packageDir, "dist");
const vendoredCore = resolve(serverDist, "vendor/core");

await assertFile(resolve(coreDist, "index.js"), "Build @local-ydb-toolkit/core before vendoring it.");
await assertFile(resolve(serverDist, "index.js"), "Build @astandrik/local-ydb-mcp before vendoring core.");

await rm(vendoredCore, { recursive: true, force: true });
await mkdir(vendoredCore, { recursive: true });
await cp(coreDist, vendoredCore, { recursive: true });

await rewriteCoreImport(resolve(serverDist, "index.js"));
await rewriteCoreImport(resolve(serverDist, "index.d.ts"));
await chmod(resolve(serverDist, "index.js"), 0o755);

async function assertFile(filePath, message) {
  const exists = await stat(filePath).then((info) => info.isFile(), () => false);
  if (exists) {
    return;
  }
  throw new Error(`${message} Missing file: ${filePath}`);
}

async function rewriteCoreImport(filePath) {
  const source = await readFile(filePath, "utf8");
  const rewritten = source.replaceAll("\"@local-ydb-toolkit/core\"", "\"./vendor/core/index.js\"");
  if (rewritten === source) {
    throw new Error(`Expected ${filePath} to import @local-ydb-toolkit/core.`);
  }
  await writeFile(filePath, rewritten);
}
