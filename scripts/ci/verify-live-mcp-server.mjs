import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const dumpHostPath = join(tempDir, "dumps");
const mcpServerPath = resolve("packages/mcp-server/dist/index.js");
const stderrChunks = [];
const staticContainer = `${containerPrefix}-static`;
const dynamicContainer = `${containerPrefix}-dynamic`;
const staticGrpcPort = endpointPort(staticEndpoint, "LOCAL_YDB_STATIC_ENDPOINT");
const dynamicGrpcPort = endpointPort(dynamicEndpoint, "LOCAL_YDB_ENDPOINT");
const monitoringPort = endpointPort(monitoringUrl, "LOCAL_YDB_MONITORING_URL");

const config = {
  defaultProfile: profileName,
  profiles: {
    [profileName]: {
      mode: "local",
      image,
      staticContainer,
      dynamicContainer,
      tenantPath,
      volume: `${containerPrefix}-data`,
      network: `${containerPrefix}-net`,
      monitoringBaseUrl: monitoringUrl,
      dumpHostPath,
      ports: {
        staticGrpc: staticGrpcPort,
        dynamicGrpc: dynamicGrpcPort,
        monitoring: monitoringPort,
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
      "local_ydb_healthcheck",
      "local_ydb_tenant_check",
      "local_ydb_nodes_check",
      "local_ydb_scheme",
      "local_ydb_apply_schema",
      "local_ydb_graphshard_check",
      "local_ydb_auth_check",
      "local_ydb_storage_placement",
      "local_ydb_container_logs",
      "local_ydb_permissions",
      "local_ydb_add_dynamic_nodes",
      "local_ydb_list_dumps",
      "local_ydb_dump_tenant",
      "local_ydb_restore_tenant",
      "local_ydb_cleanup_storage",
    ];

    for (const name of expectedTools) {
      assert(tools.has(name), `Missing MCP tool ${name}.`);
    }

    const expectedMutatingTools = new Set([
      "local_ydb_apply_schema",
      "local_ydb_permissions",
      "local_ydb_add_dynamic_nodes",
      "local_ydb_dump_tenant",
      "local_ydb_restore_tenant",
      "local_ydb_cleanup_storage",
    ]);
    const expectedDestructiveTools = new Set([
      "local_ydb_apply_schema",
      "local_ydb_permissions",
      "local_ydb_restore_tenant",
      "local_ydb_cleanup_storage",
    ]);
    for (const name of expectedTools) {
      const annotations = tools.get(name)?.annotations ?? {};
      assert(
        annotations.readOnlyHint === !expectedMutatingTools.has(name),
        `${name} read-only annotation did not match expected live-test classification.`,
      );
      assert(
        annotations.destructiveHint === expectedDestructiveTools.has(name),
        `${name} destructive annotation did not match expected live-test classification.`,
      );
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

  const healthcheck = await callTool(client, "local_ydb_healthcheck", { profile });
  assert(healthcheck.ok === true, healthcheck.stderr || healthcheck.parseError || "healthcheck failed");
  assert(typeof healthcheck.selfCheckResult === "string", "healthcheck did not return a selfCheckResult.");

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

  await verifySchemaApply(client, profile);

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

  await verifyBackupRestore(client, profile);
  await verifyConfirmedDynamicNodeMutation(client, profile);
}

async function verifySchemaApply(client, profile) {
  const tableName = "schema_apply_smoke";
  const tablePath = `${tenantPath}/${tableName}`;
  const createScript = `
    CREATE TABLE ${tableName} (
      id Uint64 NOT NULL,
      value Utf8,
      PRIMARY KEY (id)
    );
  `;

  const validation = await callTool(client, "local_ydb_apply_schema", {
    profile,
    action: "validate",
    script: createScript,
  });
  assert(validation.validation?.ok === true, validation.validation?.issues || "schema validation failed");
  assert(validation.executed === false, "schema validation should not apply DDL.");

  const apply = await callTool(client, "local_ydb_apply_schema", {
    profile,
    action: "apply",
    confirm: true,
    script: createScript,
  });
  assert(apply.executed === true, apply.execution?.issues || "schema apply failed");
  assert(apply.execution?.ok === true, apply.execution?.issues || "schema apply execution failed");

  const describe = await callTool(client, "local_ydb_scheme", {
    profile,
    action: "describe",
    path: tablePath,
  });
  assert(describe.ok === true, describe.stderr || "created schema table was not describable");

  const drop = await callTool(client, "local_ydb_apply_schema", {
    profile,
    action: "apply",
    confirm: true,
    script: `DROP TABLE ${tableName};`,
  });
  assert(drop.executed === true, drop.execution?.issues || "schema cleanup drop failed");
  assert(drop.execution?.ok === true, drop.execution?.issues || "schema cleanup drop execution failed");
}

async function verifyBackupRestore(client, profile) {
  const dumpName = "ci-backup-restore-smoke";
  const sourcePath = "ci_backup_src";
  const restorePath = "ci_backup_dst";
  const tableName = "items";
  const sourceTable = `${sourcePath}/${tableName}`;
  const restoreTable = `${restorePath}/${tableName}`;
  const dumpPath = `${dumpHostPath}/${dumpName}`;
  const restoreArgs = {
    profile,
    dumpName,
    path: restorePath,
    describePaths: [restoreTable],
    countQueries: [{ label: "restored items", query: `SELECT COUNT(*) FROM \`${restoreTable}\`;` }],
  };

  let failure;
  let cleanupFailure;
  try {
    await cleanupBackupRestoreObjects(sourcePath, restorePath, tableName);
    await runYdbCli(["scheme", "mkdir", `${tenantPath}/${sourcePath}`], "create backup source directory");
    await runYdbCli([
      "sql",
      "-s",
      `
        CREATE TABLE \`${sourceTable}\` (
          id Uint64 NOT NULL,
          value Utf8,
          PRIMARY KEY (id)
        );
      `,
    ], "create backup source table");
    await runYdbCli([
      "sql",
      "-s",
      `UPSERT INTO \`${sourceTable}\` (id, value) VALUES (1, "one"), (2, "two");`,
    ], "insert backup source rows");
    const sourceCount = await runYdbCli([
      "sql",
      "-s",
      `SELECT COUNT(*) FROM \`${sourceTable}\`;`,
    ], "count backup source rows");
    assertOutputContainsNumber(sourceCount.stdout, 2, "source row count did not return 2");

    const dumpPlan = await callTool(client, "local_ydb_dump_tenant", {
      profile,
      dumpName,
      path: sourcePath,
    });
    assert(dumpPlan.executed === false, "plan-only dump should not execute without confirm=true.");
    assert(
      plannedCommandsText(dumpPlan).includes(`tools dump -p ${sourcePath}`),
      "path-level dump plan did not target the source path.",
    );
    assert(
      plannedCommandsText(dumpPlan).includes(`/dump/${dumpName}/tenant`),
      "path-level dump plan did not use the expected tenant dump output path.",
    );

    const dumpResult = await callTool(client, "local_ydb_dump_tenant", {
      profile,
      dumpName,
      path: sourcePath,
      confirm: true,
    });
    assert(dumpResult.executed === true, "confirmed dump did not execute.");
    assert(
      dumpResult.results?.every((result) => result.ok === true) === true,
      "confirmed dump had failed command results.",
    );

    const dumps = await callTool(client, "local_ydb_list_dumps", { profile });
    const listedDump = Array.isArray(dumps.dumps)
      ? dumps.dumps.find((dump) => dump.name === dumpName)
      : undefined;
    assert(listedDump, "list dumps did not include the CI backup/restore dump.");
    assert(
      listedDump.tenantDumpPath === `${dumpPath}/tenant`,
      "list dumps returned an unexpected tenant dump path.",
    );

    const restorePlan = await callTool(client, "local_ydb_restore_tenant", restoreArgs);
    assert(restorePlan.executed === false, "plan-only restore should not execute without confirm=true.");
    assert(
      plannedCommandsText(restorePlan).includes(`tools restore -p ${restorePath} -i /dump/${dumpName}/tenant`),
      "path-level restore plan did not target the destination path and dump input.",
    );

    const restoreResult = await callTool(client, "local_ydb_restore_tenant", {
      ...restoreArgs,
      confirm: true,
    });
    assert(restoreResult.executed === true, "confirmed restore did not execute.");
    assert(
      restoreResult.results?.length === 3,
      "confirmed restore did not run restore plus two verification hooks.",
    );
    assert(
      restoreResult.results.every((result) => result.ok === true),
      "confirmed restore or verification hook had failed command results.",
    );
    assert(
      restoreResult.results[0]?.command?.includes("--entrypoint /bin/bash") === true,
      "confirmed restore helper did not override the local-ydb image entrypoint.",
    );
    assertOutputContainsNumber(
      restoreResult.results[2]?.stdout ?? "",
      2,
      "restore verification count query did not return 2",
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanupBackupRestoreDump(client, profile, dumpName, dumpPath);
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      await cleanupBackupRestoreObjects(sourcePath, restorePath, tableName);
    } catch (error) {
      cleanupFailure ??= error;
    }
  }

  if (failure) {
    if (cleanupFailure) {
      console.log(`Backup/restore dump cleanup also failed: ${errorMessage(cleanupFailure)}`);
    }
    throw failure;
  }
  if (cleanupFailure) {
    throw cleanupFailure;
  }
}

async function cleanupBackupRestoreObjects(sourcePath, restorePath, tableName) {
  for (const tablePath of [`${sourcePath}/${tableName}`, `${restorePath}/${tableName}`]) {
    await runYdbCliAllowFailure([
      "sql",
      "-s",
      `DROP TABLE \`${tablePath}\`;`,
    ], `cleanup backup table ${tablePath}`);
  }
  for (const directoryPath of [restorePath, sourcePath]) {
    await runYdbCliAllowFailure([
      "scheme",
      "rmdir",
      `${tenantPath}/${directoryPath}`,
    ], `cleanup backup directory ${directoryPath}`);
  }
}

async function cleanupBackupRestoreDump(client, profile, dumpName, dumpPath) {
  const args = { profile, paths: [dumpPath] };
  const cleanupPlan = await callTool(client, "local_ydb_cleanup_storage", args);
  assert(cleanupPlan.executed === false, "plan-only dump cleanup should not execute without confirm=true.");

  const cleanupResult = await callTool(client, "local_ydb_cleanup_storage", {
    ...args,
    confirm: true,
  });
  assert(cleanupResult.executed === true, "confirmed dump cleanup did not execute.");
  assert(
    cleanupResult.results?.every((result) => result.ok === true) === true,
    "confirmed dump cleanup had failed command results.",
  );

  const afterCleanup = await callTool(client, "local_ydb_list_dumps", { profile });
  assert(
    !Array.isArray(afterCleanup.dumps) || !afterCleanup.dumps.some((dump) => dump.name === dumpName),
    "list dumps still included the CI backup/restore dump after cleanup.",
  );
}

async function verifyConfirmedDynamicNodeMutation(client, profile) {
  const extraContainer = `${containerPrefix}-dynamic-2`;
  const extraIcPort = 19003;
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
      nodePorts(afterAdd).includes(extraIcPort),
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
        removeResult.results?.some((result) => result.ok === true) === true,
        "confirmed dynamic-node removal had no successful command results.",
      );
      assert(
        removeResult.nodeChecks?.every((check) => check.ok === true) === true,
        "confirmed dynamic-node removal did not verify node disappearance.",
      );

      const afterRemove = await callTool(client, "local_ydb_nodes_check", { profile });
      assert(
        !nodePorts(afterRemove).includes(extraIcPort),
        "extra dynamic node IC port was still visible after confirmed removal.",
      );

      const tenantAfterRemove = await callTool(client, "local_ydb_tenant_check", { profile });
      assert(
        tenantAfterRemove.ok === true,
        tenantAfterRemove.stderr || "tenant check failed after confirmed dynamic-node removal",
      );
    }
  }
}

async function runYdbCli(args, description) {
  console.log(`::group::ydb/${description}`);
  try {
    const result = await runCommand("docker", ydbCliDockerArgs(args), {
      input: rootPasswordFile ? await readFile(rootPasswordFile) : undefined,
    });
    console.log(JSON.stringify({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }, null, 2));
    assert(result.exitCode === 0, result.stderr || `${description} failed`);
    return result;
  } finally {
    console.log("::endgroup::");
  }
}

async function runYdbCliAllowFailure(args, description) {
  console.log(`::group::ydb/${description}`);
  try {
    const result = await runCommand("docker", ydbCliDockerArgs(args), {
      input: rootPasswordFile ? await readFile(rootPasswordFile) : undefined,
    });
    console.log(JSON.stringify({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }, null, 2));
    return result;
  } finally {
    console.log("::endgroup::");
  }
}

function ydbCliDockerArgs(args) {
  const endpoint = `grpc://localhost:${dynamicGrpcPort}`;
  if (!rootPasswordFile) {
    return ["exec", staticContainer, "/ydb", "-e", endpoint, "-d", tenantPath, ...args];
  }
  const script = [
    "set -euo pipefail",
    "password_file=$(mktemp /tmp/local-ydb-ci-password-XXXXXX)",
    "trap 'rm -f \"$password_file\"' EXIT",
    "cat >\"$password_file\"",
    "/ydb -e \"$1\" -d \"$2\" --user \"$3\" --password-file \"$password_file\" \"${@:4}\"",
  ].join("; ");
  return [
    "exec",
    "-i",
    staticContainer,
    "bash",
    "-lc",
    script,
    "_",
    endpoint,
    tenantPath,
    rootUser,
    ...args,
  ];
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", rejectPromise);
    child.on("close", (exitCode) => {
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
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

function plannedCommandsText(value) {
  return Array.isArray(value.plannedCommands) ? value.plannedCommands.join("\n") : "";
}

function assertOutputContainsNumber(stdout, expected, message) {
  assert(
    new RegExp(`(^|[^0-9])${expected}([^0-9]|$)`).test(stdout),
    `${message}: ${stdout}`,
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
