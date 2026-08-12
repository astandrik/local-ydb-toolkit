import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageSpec = "@astandrik/local-ydb-mcp@0.15.2";
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
  { name: "local-ydb-agent-plugin-smoke", version: "0.1.0" },
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

  console.log(`Published plugin MCP smoke passed for ${packageSpec} with 39 tools.`);
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
