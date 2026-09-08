import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { pluginPinFromConfig } from "./check-agent-plugin-freshness.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expectedPromptNames = [
  "local_ydb_auth_hardening_workflow",
  "local_ydb_bootstrap_root_workflow",
  "local_ydb_bootstrap_tenant_workflow",
  "local_ydb_diagnose_database",
  "local_ydb_diagnose_stack",
  "local_ydb_reduce_storage_groups_workflow",
  "local_ydb_schema_generate_apply_workflow",
  "local_ydb_upgrade_version_workflow",
];
const globalSentinel = "UNEXPECTED_GLOBAL_LOCAL_YDB_MCP";

export function assertPublishedMcp({ serverInfo, capabilities, tools, prompts }, expectedVersion) {
  assert.equal(serverInfo?.name, "local-ydb-toolkit");
  assert.equal(serverInfo?.version, expectedVersion, "Running MCP version must match the plugin pin");
  assert(capabilities?.tools);
  assert(capabilities?.prompts);
  assert.equal(tools.length, 39);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 39);
  for (const name of ["local_ydb_status_report", "local_ydb_healthcheck", "local_ydb_sql"]) {
    assert(tools.some((tool) => tool.name === name), `Missing tool: ${name}`);
  }
  assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), expectedPromptNames);
}

export async function createPluginFixture(sourceRoot, fixtureRoot, pinnedVersion) {
  // Copy installation metadata, never the build output or npm ci's workspace links.
  const paths = [
    "package.json", "plugin.json", "mcp.json", ".mcp.json",
    ".codex-plugin/plugin.json", "gemini-extension.json",
  ];
  for (const entry of await readdir(join(sourceRoot, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      paths.push(`packages/${entry.name}/package.json`);
    }
  }
  for (const path of paths) {
    const destination = join(fixtureRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(sourceRoot, path), destination);
  }
  // Keep the collision covered even between an npm release and its plugin-pin update.
  const workspacePath = join(fixtureRoot, "packages/mcp-server/package.json");
  const workspace = await readJson(workspacePath);
  workspace.version = pinnedVersion;
  await writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);
}

async function probe(server, cwd, env, pluginVersion) {
  const stderrChunks = [];
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd,
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  const client = new Client(
    { name: "local-ydb-agent-plugin-smoke", version: pluginVersion },
    { capabilities: {} },
  );
  try {
    await client.connect(transport, { timeout: 120_000 });
    const { tools } = await client.listTools(undefined, { timeout: 60_000 });
    const { prompts } = await client.listPrompts(undefined, { timeout: 60_000 });
    return {
      serverInfo: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      tools,
      prompts,
    };
  } catch (error) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    throw new Error(`${error.message}\n${stderr}`, { cause: error });
  } finally {
    await client.close();
  }
}

async function main() {
  const portableManifest = await readJson(join(repositoryRoot, "plugin.json"));
  const portableMcp = await readJson(join(repositoryRoot, "mcp.json"));
  const pin = pluginPinFromConfig(portableMcp, "@astandrik/local-ydb-mcp");
  const prefix = join(repositoryRoot, ".codex-plugin");
  assert((await lstat(prefix)).isDirectory());
  for (const name of ["package.json", "package-lock.json", "npm-shrinkwrap.json", "node_modules"]) {
    await assert.rejects(lstat(join(prefix, name)), { code: "ENOENT" });
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "local-ydb-published-mcp-"));
  try {
    const fixtureRoot = join(temporaryRoot, "plugin");
    await createPluginFixture(repositoryRoot, fixtureRoot, pin.version);
    const fixtureMcp = await readJson(join(fixtureRoot, "mcp.json"));
    const server = fixtureMcp.mcpServers["local-ydb"];
    const binDirectory = join(temporaryRoot, "bin");
    await mkdir(binDirectory);
    await writeFile(join(binDirectory, "local-ydb-mcp"),
      `#!/usr/bin/env node\nprocess.stderr.write("${globalSentinel}\\n");\nprocess.exit(86);\n`,
      { mode: 0o755 });
    const userConfig = join(temporaryRoot, "npmrc");
    await writeFile(userConfig, "");
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")),
      PATH: `${binDirectory}${delimiter}${process.env.PATH}`,
      npm_config_userconfig: userConfig,
      npm_config_cache: join(temporaryRoot, "npm-cache"),
      npm_config_fetch_retries: "0",
      npm_config_fetch_timeout: "30000",
      npm_config_offline: "false",
    };

    const sentinel = spawnSync("local-ydb-mcp", [], {
      cwd: fixtureRoot, env, encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(sentinel.error);
    assert.equal(sentinel.status, 86, "The global PATH trap must be executable");
    assert(sentinel.stderr.includes(globalSentinel));
    console.log("global PATH trap: sentinel verified.");

    for (const [label, offline] of [["cold online", false], ["warm offline", true]]) {
      const snapshot = await probe(server, fixtureRoot,
        { ...env, npm_config_offline: String(offline) }, portableManifest.version);
      assertPublishedMcp(snapshot, pin.version);
      console.log(`${label}: ${pin.spec}, ${snapshot.tools.length} tools, ${snapshot.prompts.length} prompts.`);
    }

    await assert.rejects(
      probe(server, fixtureRoot, {
        ...env,
        npm_config_cache: join(temporaryRoot, "empty-offline-cache"),
        npm_config_offline: "true",
      }, portableManifest.version),
      (error) => /ENOTCACHED/.test(error.message) && !error.message.includes(globalSentinel),
    );
    console.log("cold offline: package unavailable; no global executable fallback.");

    await rm(join(fixtureRoot, ".codex-plugin"), { recursive: true });
    await assert.rejects(
      probe(server, fixtureRoot, { ...env, npm_config_offline: "true" }, portableManifest.version),
      (error) => /ENOENT/.test(error.message) && !error.message.includes(globalSentinel),
    );
    console.log("missing prefix: launch failed; no global executable fallback.");
    console.log(`Published plugin MCP smoke passed for ${pin.spec}.`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
