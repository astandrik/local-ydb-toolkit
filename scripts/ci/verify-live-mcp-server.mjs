import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const profileName = "ci-action";
const tenantPath = requiredEnv("LOCAL_YDB_DATABASE");
const dynamicEndpoint = requiredEnv("LOCAL_YDB_ENDPOINT");
const staticEndpoint = requiredEnv("LOCAL_YDB_STATIC_ENDPOINT");
const monitoringUrl = requiredEnv("LOCAL_YDB_MONITORING_URL");
const image = requiredEnv("LOCAL_YDB_IMAGE");
const containerPrefix = requiredEnv("LOCAL_YDB_CONTAINER_PREFIX");
const rootPasswordFile = process.env.LOCAL_YDB_PASSWORD_FILE || process.env.LOCAL_YDB_ROOT_PASSWORD_FILE;
const rootUser = process.env.LOCAL_YDB_USER || "root";

const tempDir = await mkdtemp(join(tmpdir(), "local-ydb-mcp-integration-"));
const configPath = join(tempDir, "local-ydb.config.json");
const mcpServerPath = resolve("packages/mcp-server/dist/index.js");
const stderrChunks = [];

const config = {
  defaultProfile: profileName,
  profiles: {
    [profileName]: {
      mode: "local",
      image,
      staticContainer: `${containerPrefix}-static`,
      dynamicContainer: `${containerPrefix}-dynamic`,
      tenantPath,
      volume: `${containerPrefix}-data`,
      network: `${containerPrefix}-net`,
      monitoringBaseUrl: monitoringUrl,
      ports: {
        staticGrpc: endpointPort(staticEndpoint, "LOCAL_YDB_STATIC_ENDPOINT"),
        dynamicGrpc: endpointPort(dynamicEndpoint, "LOCAL_YDB_ENDPOINT"),
        monitoring: endpointPort(monitoringUrl, "LOCAL_YDB_MONITORING_URL"),
      },
      ...(rootPasswordFile ? { rootUser, rootPasswordFile } : {}),
    },
  },
};

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpServerPath],
  cwd: process.cwd(),
  env: {
    ...stringEnv(process.env),
    LOCAL_YDB_TOOLKIT_CONFIG: configPath,
    LOCAL_YDB_MCP_CONTENT_FORMAT: "json",
  },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

const client = new Client(
  { name: "local-ydb-toolkit-ci", version: "0.0.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport, { timeout: 60_000 });

  assert(client.getServerVersion()?.name === "local-ydb-toolkit", "Unexpected MCP server name.");
  assert(client.getServerCapabilities()?.tools, "MCP server did not advertise tools.");
  assert(client.getServerCapabilities()?.prompts, "MCP server did not advertise prompts.");
  assert(
    client.getInstructions()?.includes("local_ydb_status_report"),
    "MCP server instructions did not include local-ydb guidance.",
  );

  await verifyToolRegistry(client);
  await verifyPromptRegistry(client);
  await verifyLiveTools(client);

  console.log("Live local-ydb MCP stdio server integration passed.");
} finally {
  await client.close().catch(() => {});
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});

  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  if (stderr) {
    console.log(`MCP stderr:\n${stderr}`);
  }
}

async function verifyToolRegistry(client) {
  console.log("::group::tools/list");
  try {
    const result = await client.listTools(undefined, { timeout: 60_000 });
    const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
    const expectedTools = [
      "local_ydb_status_report",
      "local_ydb_inventory",
      "local_ydb_database_status",
      "local_ydb_tenant_check",
      "local_ydb_nodes_check",
      "local_ydb_scheme",
      "local_ydb_graphshard_check",
      "local_ydb_auth_check",
      "local_ydb_storage_placement",
      "local_ydb_container_logs",
      "local_ydb_permissions",
      "local_ydb_add_dynamic_nodes",
    ];

    for (const name of expectedTools) {
      assert(tools.has(name), `Missing MCP tool ${name}.`);
    }

    const expectedReadOnlyTools = expectedTools.filter(
      (toolName) => toolName !== "local_ydb_permissions" && toolName !== "local_ydb_add_dynamic_nodes",
    );
    for (const name of expectedReadOnlyTools) {
      assert(tools.get(name)?.annotations?.readOnlyHint === true, `${name} should be advertised as read-only.`);
    }

    console.log(JSON.stringify({ toolCount: result.tools.length, checked: expectedTools }, null, 2));
  } finally {
    console.log("::endgroup::");
  }
}

async function verifyPromptRegistry(client) {
  console.log("::group::prompts/list-get");
  try {
    const result = await client.listPrompts(undefined, { timeout: 60_000 });
    const promptNames = new Set(result.prompts.map((prompt) => prompt.name));
    assert(promptNames.has("local_ydb_diagnose_stack"), "Missing diagnose prompt.");
    assert(promptNames.has("local_ydb_bootstrap_tenant_workflow"), "Missing tenant bootstrap prompt.");

    const prompt = await client.getPrompt(
      {
        name: "local_ydb_diagnose_stack",
        arguments: { profile: profileName },
      },
      { timeout: 60_000 },
    );
    const text = prompt.messages[0]?.content?.text;
    assert(
      typeof text === "string" && text.includes("local_ydb_status_report"),
      "Diagnose prompt did not render expected guidance.",
    );

    console.log(JSON.stringify({ promptCount: result.prompts.length, checked: [...promptNames].sort() }, null, 2));
  } finally {
    console.log("::endgroup::");
  }
}

async function verifyLiveTools(client) {
  const profile = profileName;
  const statusReport = await callTool(client, "local_ydb_status_report", { profile });
  assert(statusReport.tenant?.ok === true, statusReport.tenant?.stderr || "tenant check failed");
  assert(statusReport.nodes?.ok === true, statusReport.nodes?.error || "node check failed");

  const inventory = await callTool(client, "local_ydb_inventory", { profile });
  assert(Array.isArray(inventory.containers), "inventory did not return containers.");
  assert(Array.isArray(inventory.volumes), "inventory did not return volumes.");
  assert(
    inventory.containers.some((container) => container.names === `${containerPrefix}-static`),
    "inventory did not include the static local-ydb container.",
  );

  const databaseStatus = await callTool(client, "local_ydb_database_status", { profile });
  assert(databaseStatus.ok === true, databaseStatus.stderr || "database status failed");

  const tenantCheck = await callTool(client, "local_ydb_tenant_check", { profile });
  assert(tenantCheck.ok === true, tenantCheck.stderr || "tenant check failed");

  const nodesCheck = await callTool(client, "local_ydb_nodes_check", { profile });
  assert(nodesCheck.ok === true, nodesCheck.error || "nodes check failed");
  assert(Array.isArray(nodesCheck.nodes) && nodesCheck.nodes.length > 0, "nodes check returned no nodes.");

  const scheme = await callTool(client, "local_ydb_scheme", {
    profile,
    path: tenantPath,
    onePerLine: true,
  });
  assert(scheme.ok === true, scheme.stderr || "scheme list failed");

  const permissions = await callTool(client, "local_ydb_permissions", {
    profile,
    action: "list",
    path: tenantPath,
  });
  assert(permissions.ok === true, permissions.stderr || "permissions list failed");

  const graphshard = await callTool(client, "local_ydb_graphshard_check", { profile });
  assert(graphshard.ok === true, graphshard.tabletInfoError || "GraphShard check failed");
  assert(graphshard.graphShardExists === true, "GraphShard was not reported for the tenant.");

  const storagePlacement = await callTool(client, "local_ydb_storage_placement", { profile });
  assert(storagePlacement.ok === true, storagePlacement.queryBase?.stderr || "storage placement failed");

  const authCheck = await callTool(client, "local_ydb_auth_check", { profile });
  assert(Number.isInteger(authCheck.viewerWhoamiStatus), "auth check did not return a viewer status.");

  const staticLogs = await callTool(client, "local_ydb_container_logs", {
    profile,
    target: "static",
    lines: 20,
  });
  assert(staticLogs.ok === true, staticLogs.stderr || "static container logs failed");

  await verifyConfirmedDynamicNodeMutation(client, profile);
}

async function verifyConfirmedDynamicNodeMutation(client, profile) {
  const extraContainer = `${containerPrefix}-dynamic-2`;
  const dynamicNodePlan = await callTool(client, "local_ydb_add_dynamic_nodes", {
    profile,
    count: 1,
  });
  assert(
    dynamicNodePlan.executed === false,
    "plan-only dynamic-node tool should not execute without confirm=true.",
  );
  assert(
    Array.isArray(dynamicNodePlan.plannedCommands) && dynamicNodePlan.plannedCommands.length > 0,
    "dynamic-node plan did not include commands.",
  );

  let added = false;
  try {
    const addResult = await callTool(client, "local_ydb_add_dynamic_nodes", {
      profile,
      count: 1,
      confirm: true,
    });
    added = true;
    assert(addResult.executed === true, "confirmed dynamic-node add did not execute.");
    assert(
      addResult.results?.every((result) => result.ok === true) === true,
      "confirmed dynamic-node add had failed command results.",
    );
    assert(
      addResult.nodeChecks?.every((check) => check.ok === true) === true,
      "confirmed dynamic-node add did not verify the extra node.",
    );

    const afterAdd = await callTool(client, "local_ydb_nodes_check", { profile });
    assert(
      nodePorts(afterAdd).includes(19003),
      "extra dynamic node IC port was not visible after confirmed add.",
    );
  } finally {
    if (added) {
      const removeResult = await callTool(client, "local_ydb_remove_dynamic_nodes", {
        profile,
        containers: [extraContainer],
        confirm: true,
      });
      assert(removeResult.executed === true, "confirmed dynamic-node removal did not execute.");
      assert(
        removeResult.results?.every((result) => result.ok === true) === true,
        "confirmed dynamic-node removal had failed command results.",
      );
      assert(
        removeResult.nodeChecks?.every((check) => check.ok === true) === true,
        "confirmed dynamic-node removal did not verify node disappearance.",
      );

      const afterRemove = await callTool(client, "local_ydb_nodes_check", { profile });
      assert(
        !nodePorts(afterRemove).includes(19003),
        "extra dynamic node IC port was still visible after confirmed removal.",
      );
    }
  }
}

async function callTool(client, name, args) {
  console.log(`::group::tools/call ${name}`);
  try {
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 180_000 },
    );
    if (result.isError) {
      throw new Error(`${name} returned MCP error: ${toolText(result)}`);
    }
    const data = "structuredContent" in result ? result.structuredContent : result.toolResult;
    assertPlainObject(data, `${name} did not return structured content.`);
    console.log(JSON.stringify(summarize(data), null, 2));
    return data;
  } finally {
    console.log("::endgroup::");
  }
}

function nodePorts(value) {
  return Array.isArray(value.nodes)
    ? value.nodes
      .map((node) => node?.Port)
      .filter((port) => Number.isInteger(port))
    : [];
}

function summarize(value) {
  return {
    summary: value.summary,
    ok: value.ok,
    tenantOk: value.tenant?.ok,
    nodesOk: value.nodes?.ok,
    nodeCount: Array.isArray(value.nodes) ? value.nodes.length : undefined,
    graphShardExists: value.graphShardExists,
    viewerWhoamiStatus: value.viewerWhoamiStatus,
    executed: value.executed,
    risk: value.risk,
    command: value.command,
  };
}

function toolText(result) {
  if (!Array.isArray(result.content)) {
    return JSON.stringify(result);
  }
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function endpointPort(value, name) {
  const port = Number(new URL(value).port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must include a valid port: ${value}`);
  }
  return port;
}

function stringEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter((entry) => typeof entry[1] === "string"),
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPlainObject(value, message) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    message,
  );
}
