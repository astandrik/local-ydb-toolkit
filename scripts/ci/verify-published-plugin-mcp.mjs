import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const portableManifest = await readJson(join(repositoryRoot, "plugin.json"));
const portableMcp = await readJson(join(repositoryRoot, "mcp.json"));
const packageSpec = portableMcp.mcpServers["local-ydb"].args[1];
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
const temporaryRoot = await mkdtemp(join(tmpdir(), "local-ydb-published-mcp-"));
const stderrChunks = [];
const transport = new StdioClientTransport({
  command: "npx",
  args: ["--yes", "--prefer-online", packageSpec],
  cwd: temporaryRoot,
  env: {
    ...stringEnvironment(process.env),
    npm_config_cache: join(temporaryRoot, "npm-cache"),
  },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

const client = new Client(
  { name: "local-ydb-agent-plugin-smoke", version: portableManifest.version },
  { capabilities: {} },
);

try {
  await client.connect(transport, { timeout: 120_000 });
  assert.equal(client.getServerVersion()?.name, "local-ydb-toolkit");
  assert(client.getServerCapabilities()?.tools);
  assert(client.getServerCapabilities()?.prompts);

  const toolResult = await client.listTools(undefined, { timeout: 60_000 });
  assert.equal(toolResult.tools.length, 39);
  assert.equal(new Set(toolResult.tools.map((tool) => tool.name)).size, 39);
  assert(toolResult.tools.some((tool) => tool.name === "local_ydb_status_report"));
  assert(toolResult.tools.some((tool) => tool.name === "local_ydb_sql"));
  const promptResult = await client.listPrompts(undefined, { timeout: 60_000 });
  assert.deepEqual(
    promptResult.prompts.map((prompt) => prompt.name).sort(),
    expectedPromptNames,
  );

  console.log(`Published plugin MCP smoke passed for ${packageSpec} with 39 tools and 8 prompts.`);
} finally {
  await client.close().catch(() => {});
  await rm(temporaryRoot, { recursive: true, force: true });

  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  if (stderr) {
    console.log(`MCP stderr:\n${stderr}`);
  }
}

function stringEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter((entry) => typeof entry[1] === "string"),
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
