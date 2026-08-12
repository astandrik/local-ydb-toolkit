import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const portableManifest = await readJson(join(repositoryRoot, "plugin.json"));
const legacyManifest = await readJson(join(repositoryRoot, ".codex-plugin", "plugin.json"));
const defaultArchive = join(
  repositoryRoot,
  "dist",
  `${portableManifest.name}-${portableManifest.version}-skills.zip`,
);
const requestedOutput = parseOutputPath(process.argv.slice(2));
const outputPath = requestedOutput
  ? resolve(repositoryRoot, requestedOutput)
  : defaultArchive;
const stagingRoot = await mkdtemp(join(tmpdir(), "local-ydb-plugin-package-"));

try {
  await copyRelativeFile("plugin.json", stagingRoot);
  await copyRelativeFile("LICENSE", stagingRoot);
  await copyRelativeFile("assets/icon.svg", stagingRoot);
  await copyRelativeTree("skills/local-ydb", stagingRoot);

  const publicLegacyManifest = structuredClone(legacyManifest);
  delete publicLegacyManifest.mcpServers;
  const publicLegacyPath = join(stagingRoot, ".codex-plugin", "plugin.json");
  await mkdir(dirname(publicLegacyPath), { recursive: true });
  await writeFile(publicLegacyPath, `${JSON.stringify(publicLegacyManifest, null, 2)}\n`, "utf8");

  const files = await listRegularFiles(stagingRoot);
  await Promise.all(files.map((file) => normalizeFile(join(stagingRoot, file))));
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  const zipResult = spawnSync("zip", ["-X", "-q", outputPath, "-@"], {
    cwd: stagingRoot,
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
    input: `${files.join("\n")}\n`,
  });
  if (zipResult.error) {
    throw new Error(`Unable to run zip: ${zipResult.error.message}`);
  }
  if (zipResult.status !== 0) {
    throw new Error(`zip failed (${zipResult.status}): ${zipResult.stderr.trim()}`);
  }

  console.log(outputPath);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

function parseOutputPath(args) {
  if (args.length === 0) {
    return undefined;
  }
  if (args.length === 2 && args[0] === "--output" && args[1]) {
    return args[1];
  }
  throw new Error("Usage: node scripts/package-agent-plugin.mjs [--output <archive.zip>]");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function copyRelativeFile(path, destinationRoot) {
  const source = join(repositoryRoot, path);
  const destination = join(destinationRoot, path);
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Plugin package source must be a regular file: ${path}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function copyRelativeTree(path, destinationRoot) {
  const sourceRoot = join(repositoryRoot, path);
  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Plugin package source must be a directory: ${path}`);
  }
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".gitkeep") {
      continue;
    }
    const childPath = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Plugin package cannot contain symlinks: ${childPath}`);
    }
    if (entry.isDirectory()) {
      await copyRelativeTree(childPath, destinationRoot);
    } else if (entry.isFile()) {
      await copyRelativeFile(childPath, destinationRoot);
    } else {
      throw new Error(`Plugin package source has unsupported file type: ${childPath}`);
    }
  }
}

async function listRegularFiles(root) {
  const files = [];
  await visit(root);
  return files.sort();

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Plugin package cannot contain symlinks: ${path}`);
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join("/"));
      } else {
        throw new Error(`Plugin package has unsupported file type: ${path}`);
      }
    }
  }
}

async function normalizeFile(path) {
  const timestamp = new Date("1980-01-01T00:00:00.000Z");
  await chmod(path, 0o644);
  await utimes(path, timestamp, timestamp);
}
