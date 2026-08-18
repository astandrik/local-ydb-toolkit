import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stableSemverSource = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)";
const stableSemver = new RegExp(`^${stableSemverSource}$`);
const packageName = "@astandrik/local-ydb-mcp";
const pluginManifestPaths = [
  "plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "gemini-extension.json",
];
const mcpConfigPaths = ["mcp.json", ".mcp.json", "gemini-extension.json"];

try {
  const { mcpVersion, write } = parseArguments(process.argv.slice(2));
  const plan = await createPlan(mcpVersion);

  if (plan.kind === "noop") {
    console.log(`Plugin already pins ${packageName}@${mcpVersion}; no files changed.`);
  } else if (!write) {
    console.log(
      `Would update MCP pin ${packageName}@${plan.currentMcpVersion} -> ${packageName}@${mcpVersion} and plugin version ${plan.currentPluginVersion} -> ${plan.nextPluginVersion}.`,
    );
    console.log(`Would update ${plan.files.length} files; rerun with --write to apply.`);
  } else {
    await Promise.all(plan.files.map(({ path, contents }) => writeFile(path, contents, "utf8")));
    console.log(
      `Updated MCP pin ${packageName}@${plan.currentMcpVersion} -> ${packageName}@${mcpVersion} and plugin version ${plan.currentPluginVersion} -> ${plan.nextPluginVersion} in ${plan.files.length} files.`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArguments(argumentsList) {
  let mcpVersion;
  let write = false;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--mcp-version") {
      if (mcpVersion !== undefined || index + 1 >= argumentsList.length) {
        throw new Error("Usage: npm run plugin:pin -- --mcp-version <stable-semver> [--write]");
      }
      mcpVersion = argumentsList[index + 1];
      index += 1;
    } else if (argument === "--write" && !write) {
      write = true;
    } else {
      throw new Error("Usage: npm run plugin:pin -- --mcp-version <stable-semver> [--write]");
    }
  }

  if (typeof mcpVersion !== "string" || !stableSemver.test(mcpVersion)) {
    throw new Error("--mcp-version must be a stable X.Y.Z semver version.");
  }

  return { mcpVersion, write };
}

async function createPlan(targetMcpVersion) {
  const jsonFiles = await Promise.all(
    [...new Set([...pluginManifestPaths, ...mcpConfigPaths])].map(async (relativePath) => ({
      relativePath,
      path: join(repositoryRoot, relativePath),
      value: JSON.parse(await readFile(join(repositoryRoot, relativePath), "utf8")),
    })),
  );
  const jsonByPath = new Map(jsonFiles.map((file) => [file.relativePath, file]));
  const currentPluginVersion = readPluginVersion(jsonByPath);
  const currentMcpVersion = readMcpVersion(jsonByPath);
  const comparison = compareSemver(targetMcpVersion, currentMcpVersion);

  if (comparison < 0) {
    throw new Error(
      `Target MCP version ${targetMcpVersion} is lower than the current MCP version ${currentMcpVersion}.`,
    );
  }
  if (comparison === 0) {
    return { kind: "noop" };
  }

  const nextPluginVersion = incrementPatch(currentPluginVersion);
  for (const relativePath of pluginManifestPaths) {
    const file = jsonByPath.get(relativePath);
    file.value.version = nextPluginVersion;
  }
  for (const relativePath of mcpConfigPaths) {
    const file = jsonByPath.get(relativePath);
    file.value.mcpServers["local-ydb"].args[1] = `${packageName}@${targetMcpVersion}`;
  }

  const updates = jsonFiles.map(jsonUpdate);

  const readme = await readText("README.md");
  updates.push(
    textUpdate(
      "README.md",
      replaceExactly(
        replaceExactly(
          replaceExactly(
            readme,
            `pinned \`${packageName}@${currentMcpVersion}\` package`,
            `pinned \`${packageName}@${targetMcpVersion}\` package`,
          ),
          `Plugin \`${currentPluginVersion}\` pins \`${packageName}@${currentMcpVersion}\`.`,
          `Plugin \`${nextPluginVersion}\` pins \`${packageName}@${targetMcpVersion}\`.`,
        ),
        `dist/local-ydb-toolkit-${currentPluginVersion}-skills.zip`,
        `dist/local-ydb-toolkit-${nextPluginVersion}-skills.zip`,
      ),
    ),
  );

  const submission = await readText("docs/openai-plugin-submission.md");
  updates.push(
    textUpdate(
      "docs/openai-plugin-submission.md",
      replaceExactly(
        submission,
        `- Version: \`${currentPluginVersion}\``,
        `- Version: \`${nextPluginVersion}\``,
      ),
    ),
  );

  return {
    kind: "update",
    currentMcpVersion,
    currentPluginVersion,
    nextPluginVersion,
    files: updates,
  };
}

function readPluginVersion(jsonByPath) {
  const versions = pluginManifestPaths.map((relativePath) => {
    const version = jsonByPath.get(relativePath)?.value.version;
    if (typeof version !== "string" || !stableSemver.test(version)) {
      throw new Error(`${relativePath} must contain a stable plugin version.`);
    }
    return version;
  });
  if (new Set(versions).size !== 1) {
    throw new Error("Plugin manifest versions are not aligned.");
  }
  return versions[0];
}

function readMcpVersion(jsonByPath) {
  const versions = mcpConfigPaths.map((relativePath) => {
    const server = jsonByPath.get(relativePath)?.value.mcpServers?.["local-ydb"];
    if (
      !server ||
      server.command !== "npx" ||
      !Array.isArray(server.args) ||
      server.args.length !== 2 ||
      server.args[0] !== "--yes" ||
      typeof server.args[1] !== "string"
    ) {
      throw new Error(`${relativePath} must contain the exact local-ydb npx package shape.`);
    }
    const match = new RegExp(`^${escapeRegex(packageName)}@(${stableSemverSource})$`).exec(
      server.args[1],
    );
    if (!match) {
      throw new Error(`${relativePath} must pin ${packageName} to a stable X.Y.Z version.`);
    }
    return match[1];
  });
  if (new Set(versions).size !== 1) {
    throw new Error("MCP config package pins are not aligned.");
  }
  return versions[0];
}

function jsonUpdate(file) {
  return { path: file.path, contents: `${JSON.stringify(file.value, null, 2)}\n` };
}

async function readText(relativePath) {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

function textUpdate(relativePath, contents) {
  return { path: join(repositoryRoot, relativePath), contents };
}

function replaceExactly(contents, expected, replacement) {
  const count = contents.split(expected).length - 1;
  if (count !== 1) {
    throw new Error(`Expected exactly one ${JSON.stringify(expected)} replacement, found ${count}.`);
  }
  return contents.replace(expected, replacement);
}

function incrementPatch(version) {
  const [major, minor, patch] = parseSemver(version);
  return `${major}.${minor}.${patch + 1}`;
}

function compareSemver(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function parseSemver(version) {
  if (!stableSemver.test(version)) {
    throw new Error(`Expected a stable X.Y.Z semver version, received ${version}.`);
  }
  return version.split(".").map(Number);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
