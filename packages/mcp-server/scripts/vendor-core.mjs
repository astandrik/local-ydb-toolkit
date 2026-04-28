import {
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
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

const rewrittenFiles = await rewriteCoreImports(serverDist);
if (rewrittenFiles === 0) {
  throw new Error(`Expected emitted files in ${serverDist} to import @local-ydb-toolkit/core.`);
}
await chmod(resolve(serverDist, "index.js"), 0o755);

async function assertFile(filePath, message) {
  const exists = await stat(filePath).then((info) => info.isFile(), () => false);
  if (exists) {
    return;
  }
  throw new Error(`${message} Missing file: ${filePath}`);
}

async function rewriteCoreImports(directoryPath) {
  const filePaths = await listServerOutputFiles(directoryPath);
  let rewrittenFiles = 0;

  await Promise.all(
    filePaths.map(async (filePath) => {
      const didRewrite = await rewriteCoreImport(filePath);
      if (didRewrite) {
        rewrittenFiles++;
      }
    }),
  );

  return rewrittenFiles;
}

async function listServerOutputFiles(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const filePaths = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directoryPath, entry.name);

      if (entry.isDirectory()) {
        if (entryPath === resolve(serverDist, "vendor")) {
          return [];
        }

        return listServerOutputFiles(entryPath);
      }

      if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) {
        return [entryPath];
      }

      return [];
    }),
  );

  return filePaths.flat();
}

async function rewriteCoreImport(filePath) {
  const source = await readFile(filePath, "utf8");
  const coreImportPath = relative(dirname(filePath), resolve(vendoredCore, "index.js")).replaceAll(
    "\\",
    "/",
  );
  const importSpecifier = coreImportPath.startsWith(".")
    ? coreImportPath
    : `./${coreImportPath}`;
  const rewritten = source.replaceAll(
    "\"@local-ydb-toolkit/core\"",
    `"${importSpecifier}"`,
  );
  if (rewritten === source) {
    return false;
  }
  await writeFile(filePath, rewritten);
  return true;
}
