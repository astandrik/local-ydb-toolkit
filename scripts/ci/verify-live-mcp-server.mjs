import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertLiveToolRegistry,
  verifyManagedSqlLive,
} from "./managed-sql-live.mjs";
import { contiguousPortCandidates } from "./live-port-allocation.mjs";

const profileName = "ci-action";
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
const tenantPath = requiredEnv("LOCAL_YDB_DATABASE");
const dynamicEndpoint = requiredEnv("LOCAL_YDB_ENDPOINT");
const staticEndpoint = requiredEnv("LOCAL_YDB_STATIC_ENDPOINT");
const monitoringUrl = requiredEnv("LOCAL_YDB_MONITORING_URL");
const image = requiredEnv("LOCAL_YDB_IMAGE");
const containerPrefix = requiredEnv("LOCAL_YDB_CONTAINER_PREFIX");
const rootPasswordFile = process.env.LOCAL_YDB_PASSWORD_FILE || process.env.LOCAL_YDB_ROOT_PASSWORD_FILE;
const rootUser = process.env.LOCAL_YDB_USER || "root";
const dynamicNodeAuthTokenFile = rootPasswordFile
  ? join(dirname(rootPasswordFile), "dynamic-node-auth.pb")
  : undefined;
if (dynamicNodeAuthTokenFile) {
  let tokenStat;
  try {
    tokenStat = await stat(dynamicNodeAuthTokenFile);
  } catch {
    throw new Error("Authenticated live verification requires a dynamic-node auth token file.");
  }
  if (!tokenStat.isFile()) {
    throw new Error("The dynamic-node auth token path is not a regular file.");
  }
}

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
const lifecycleProfileName = "ci-lifecycle-restart";
const lifecyclePrefix = `${containerPrefix}-lifecycle-restart`;
const lifecycleStaticContainer = `${lifecyclePrefix}-static`;
const lifecycleDynamicContainer = `${lifecyclePrefix}-dynamic`;
const lifecycleVolume = `${lifecyclePrefix}-data`;
const lifecycleMismatchedVolume = `${lifecyclePrefix}-mismatched-data`;
const lifecycleNetwork = `${lifecyclePrefix}-net`;
const [
  lifecycleStaticGrpcPort,
  lifecycleDynamicGrpcPort,
  lifecycleMonitoringPort,
] = await allocateOpenPorts(3);
const topologyProfileName = "ci-declarative-topology";
const topologyPrefix = `${containerPrefix}-declarative-topology`;
const topologyStaticContainer = `${topologyPrefix}-static`;
const topologyDynamicContainer = `${topologyPrefix}-dynamic`;
const topologyVolume = `${topologyPrefix}-data`;
const topologyNetwork = `${topologyPrefix}-net`;
const topologyPorts = await allocateContiguousOpenPorts(18);
const topologyStaticGrpcPort = topologyPorts[0];
const topologyDynamicGrpcPort = topologyPorts[1];
const topologyMonitoringPort = topologyPorts[6];
const topologyDynamicMonitoringPort = topologyPorts[7];
const topologyDynamicIcPort = topologyPorts[12];
const topologyUnusedMonitoringPort = topologyPorts[17];

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
      ...(rootPasswordFile
        ? {
            rootUser,
            rootPasswordFile,
            dynamicNodeAuthTokenFile,
            dynamicNodeAuthSid: "root@builtin",
          }
        : {}),
    },
    [lifecycleProfileName]: {
      mode: "local",
      image,
      staticContainer: lifecycleStaticContainer,
      dynamicContainer: lifecycleDynamicContainer,
      tenantPath: "/local/lifecycle-restart",
      volume: lifecycleVolume,
      network: lifecycleNetwork,
      monitoringBaseUrl: `http://127.0.0.1:${lifecycleMonitoringPort}`,
      dumpHostPath: join(tempDir, "lifecycle-dumps"),
      ports: {
        staticGrpc: lifecycleStaticGrpcPort,
        dynamicGrpc: lifecycleDynamicGrpcPort,
        monitoring: lifecycleMonitoringPort,
      },
    },
    [topologyProfileName]: {
      mode: "local",
      image,
      staticContainer: topologyStaticContainer,
      dynamicContainer: topologyDynamicContainer,
      dynamicNodeCount: 1,
      tenantPath: "/local/declarative-topology",
      volume: topologyVolume,
      network: topologyNetwork,
      monitoringBaseUrl: `http://127.0.0.1:${topologyMonitoringPort}`,
      dumpHostPath: join(tempDir, "declarative-topology-dumps"),
      ports: {
        staticGrpc: topologyStaticGrpcPort,
        dynamicGrpc: topologyDynamicGrpcPort,
        monitoring: topologyMonitoringPort,
        dynamicMonitoring: topologyDynamicMonitoringPort,
        dynamicIc: topologyDynamicIcPort,
      },
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
  await verifyStoppedStaticRestart(client);
  await verifyDeclarativeTopologyLifecycle(client);

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
    assertLiveToolRegistry(result);
    const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
    const expectedTools = [
      "local_ydb_check_prerequisites",
      "local_ydb_status_report",
      "local_ydb_inventory",
      "local_ydb_database_status",
      "local_ydb_healthcheck",
      "local_ydb_tenant_check",
      "local_ydb_nodes_check",
      "local_ydb_scheme",
      "local_ydb_apply_schema",
      "local_ydb_sql",
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
      "local_ydb_check_prerequisites",
      "local_ydb_apply_schema",
      "local_ydb_sql",
      "local_ydb_permissions",
      "local_ydb_add_dynamic_nodes",
      "local_ydb_dump_tenant",
      "local_ydb_restore_tenant",
      "local_ydb_cleanup_storage",
    ]);
    const expectedDestructiveTools = new Set([
      "local_ydb_apply_schema",
      "local_ydb_sql",
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
    const promptNames = result.prompts.map((prompt) => prompt.name).sort();
    assert(
      JSON.stringify(promptNames) === JSON.stringify(expectedPromptNames),
      `Unexpected prompt registry: ${JSON.stringify(promptNames)}.`,
    );

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

    console.log(JSON.stringify({ promptCount: result.prompts.length, checked: promptNames }, null, 2));
  } finally {
    console.log("::endgroup::");
  }
}

async function verifyLiveTools(client) {
  const profile = profileName;
  const prerequisites = await callTool(client, "local_ydb_check_prerequisites", {
    profile,
    confirm: false,
  });
  assert(prerequisites.ready === true, "prerequisites did not report ready=true.");
  assert(
    Array.isArray(prerequisites.unavailable) && prerequisites.unavailable.length === 0,
    "prerequisites reported unavailable services.",
  );
  assert(
    prerequisites.checks?.some(
      (check) => check.name === "dockerDaemon" && check.kind === "service" && check.ok === true,
    ),
    "prerequisites did not confirm Docker daemon reachability.",
  );

  const statusReport = await callTool(client, "local_ydb_status_report", { profile });
  assert(statusReport.tenant?.ok === true, statusReport.tenant?.stderr || "tenant check failed");
  assert(statusReport.nodes?.ok === true, statusReport.nodes?.error || "node check failed");

  const inventory = await callTool(client, "local_ydb_inventory", { profile });
  assert(inventory.ok === true, inventory.summary || "inventory did not report ok=true.");
  assert(inventory.docker?.cliAvailable === true, "inventory did not confirm Docker CLI availability.");
  assert(inventory.docker?.daemonReachable === true, "inventory did not confirm Docker daemon reachability.");
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
  await verifyManagedSqlLive({
    callTool: (name, args) => callTool(client, name, args),
    profile,
  });

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
      plannedCommandsText(restorePlan).includes(`tools restore -p ${restorePath} -i /dump/confirmed`),
      "path-level restore plan did not target the destination path and dump input.",
    );
    assert(
      plannedCommandsText(restorePlan).includes(":/dump/confirmed:ro"),
      "path-level restore plan did not use a read-only confirmed snapshot mount.",
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

async function verifyStoppedStaticRestart(client) {
  console.log("::group::lifecycle stopped-static restart");
  const failures = [];
  try {
    try {
      const initialBootstrap = await callTool(client, "local_ydb_bootstrap_root_database", {
        profile: lifecycleProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(initialBootstrap, "initial disposable root bootstrap");

      const stopResult = await runCommand("docker", ["stop", lifecycleStaticContainer]);
      assert(
        stopResult.exitCode === 0,
        `failed to stop disposable static container: ${stopResult.stderr || stopResult.stdout}`,
      );
      const stoppedState = await runCommand("docker", [
        "inspect",
        "--format",
        "{{.State.Running}}",
        lifecycleStaticContainer,
      ]);
      assert(
        stoppedState.exitCode === 0 && stoppedState.stdout.trim() === "false",
        `disposable static container did not stop cleanly: ${stoppedState.stderr || stoppedState.stdout}`,
      );

      config.profiles[lifecycleProfileName].volume = lifecycleMismatchedVolume;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      try {
        const incompatibleBootstrap = await callTool(client, "local_ydb_bootstrap_root_database", {
          profile: lifecycleProfileName,
          confirm: true,
        });
        assert(incompatibleBootstrap.executed === true, "incompatible disposable root bootstrap did not execute checks.");
        const incompatibility = incompatibleBootstrap.results?.find((result) => result.ok === false);
        assert(
          incompatibility?.stderr?.includes("does not match profile data mount"),
          "stopped container with a mismatched profile volume was not rejected.",
        );
        const stillStoppedState = await runCommand("docker", [
          "inspect",
          "--format",
          "{{.State.Running}}",
          lifecycleStaticContainer,
        ]);
        assert(
          stillStoppedState.exitCode === 0 && stillStoppedState.stdout.trim() === "false",
          "incompatible stopped container was started despite the volume mismatch.",
        );
      } finally {
        config.profiles[lifecycleProfileName].volume = lifecycleVolume;
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      }

      const repeatedBootstrap = await callTool(client, "local_ydb_bootstrap_root_database", {
        profile: lifecycleProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(repeatedBootstrap, "repeated disposable root bootstrap");
      const restartCommand = repeatedBootstrap.results?.find(
        (result) => typeof result.command === "string" && result.command.includes("docker start"),
      );
      assert(restartCommand?.ok === true, "repeated bootstrap did not execute the stopped-container start path.");
      assert(
        restartCommand.command.includes("HostConfig.PortBindings"),
        "repeated bootstrap did not validate stored port bindings before start.",
      );
      assert(
        !restartCommand.command.includes("docker port"),
        "repeated bootstrap still relies on docker port for a stopped container.",
      );

      const healthcheck = await callTool(client, "local_ydb_healthcheck", {
        profile: lifecycleProfileName,
        databasePath: "/local",
      });
      assert(
        healthcheck.ok === true && healthcheck.healthy === true,
        healthcheck.stderr || healthcheck.summary || "disposable root healthcheck failed",
      );
    } catch (error) {
      failures.push(error);
    }

    try {
      const cleanup = await callTool(client, "local_ydb_destroy_stack", {
        profile: lifecycleProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(cleanup, "disposable lifecycle cleanup");
    } catch (error) {
      failures.push(error);
    }

    try {
      await cleanupLifecycleArtifacts();
      await assertLifecycleArtifactsAbsent();
    } catch (error) {
      failures.push(error);
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "Disposable stopped-static restart or cleanup failed.");
    }
    console.log("Disposable stopped-static restart and cleanup passed.");
  } finally {
    console.log("::endgroup::");
  }
}

async function verifyDeclarativeTopologyLifecycle(client) {
  console.log("::group::declarative dynamic-node topology");
  const failures = [];
  const configuredContainers = [
    topologyDynamicContainer,
    `${topologyDynamicContainer}-2`,
    `${topologyDynamicContainer}-3`,
  ];
  const oneOffContainer = `${topologyDynamicContainer}-4`;
  const configuredIcPorts = [
    topologyDynamicIcPort,
    topologyDynamicIcPort + 1,
    topologyDynamicIcPort + 2,
  ];
  const topologyProfile = config.profiles[topologyProfileName];
  try {
    try {
      topologyProfile.dynamicNodeCount = 2;
      topologyProfile.ports.dynamicIc = 19_000;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      const staticIcCollision = await client.callTool(
        {
          name: "local_ydb_bootstrap",
          arguments: { profile: topologyProfileName },
        },
        undefined,
        { timeout: 180_000 },
      );
      assert(staticIcCollision.isError === true, "topology using static IC port 19001 unexpectedly produced a bootstrap plan.");
      assert(
        toolText(staticIcCollision).includes("static IC") && toolText(staticIcCollision).includes("19001"),
        "static IC collision did not identify the reserved port.",
      );
      topologyProfile.dynamicNodeCount = 1;
      topologyProfile.ports.dynamicIc = topologyDynamicIcPort;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      const initialBootstrapPlan = await callTool(client, "local_ydb_bootstrap", {
        profile: topologyProfileName,
      });
      assert(initialBootstrapPlan.executed === false, "initial declarative bootstrap plan executed unexpectedly.");
      assert(
        plannedCommandsText(initialBootstrapPlan).includes(`--name ${topologyDynamicContainer} `),
        "initial declarative bootstrap plan omitted the primary dynamic node.",
      );
      assert(
        !plannedCommandsText(initialBootstrapPlan).includes(`--name ${topologyDynamicContainer}-2 `),
        "one-node declarative bootstrap plan included a suffix node.",
      );

      const initialBootstrapResult = await callTool(client, "local_ydb_bootstrap", {
        profile: topologyProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(initialBootstrapResult, "one-node declarative bootstrap");
      await assertConfiguredTopology(client, [topologyDynamicContainer], [topologyDynamicIcPort]);
      const initialInventory = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
      const initialStatic = findContainer(initialInventory, topologyStaticContainer);
      const initialDynamic = findContainer(initialInventory, topologyDynamicContainer);
      assert(initialStatic?.id && initialDynamic?.id, "one-node bootstrap did not expose stable container IDs.");
      const initialBindings = await inspectTopologyStaticBindings();

      topologyProfile.dynamicNodeCount = 3;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      const incompatibleRestartPlan = await callTool(client, "local_ydb_restart_stack", {
        profile: topologyProfileName,
      });
      const compatibilityCommandIndex = incompatibleRestartPlan.plannedCommands?.findIndex(
        (command) => command.includes("HostConfig.PortBindings"),
      ) ?? -1;
      const restartMutationIndex = incompatibleRestartPlan.plannedCommands?.findIndex(
        (command) => command.includes("docker stop"),
      ) ?? -1;
      assert(compatibilityCommandIndex >= 0, "restart plan omitted the full static compatibility preflight.");
      assert(restartMutationIndex >= 0, "restart plan omitted lifecycle mutations after the preflight.");
      assert(compatibilityCommandIndex < restartMutationIndex, "restart plan placed static compatibility after a lifecycle mutation.");

      const incompatibleRestart = await callTool(client, "local_ydb_restart_stack", {
        profile: topologyProfileName,
        confirm: true,
      });
      const restartIncompatibilityIndex = incompatibleRestart.results?.findIndex((result) => result.ok === false) ?? -1;
      assert(restartIncompatibilityIndex >= 0, "restart accepted a static container with incomplete configured gRPC bindings.");
      assert(
        incompatibleRestart.results?.[restartIncompatibilityIndex]?.stderr?.includes("does not match profile published ports"),
        "restart static incompatibility did not identify the published-port mismatch.",
      );
      assert(
        incompatibleRestart.results?.length === restartIncompatibilityIndex + 1,
        "restart continued after static compatibility failed.",
      );
      const afterIncompatibleRestart = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
      assert(findContainer(afterIncompatibleRestart, topologyStaticContainer)?.id === initialStatic.id, "failed restart changed the static container identity.");
      assert(findContainer(afterIncompatibleRestart, topologyStaticContainer)?.state === initialStatic.state, "failed restart changed the static container state.");
      assert(findContainer(afterIncompatibleRestart, topologyDynamicContainer)?.id === initialDynamic.id, "failed restart changed the configured container identity.");
      assert(findContainer(afterIncompatibleRestart, topologyDynamicContainer)?.state === initialDynamic.state, "failed restart changed the configured container state.");
      assert(!findContainer(afterIncompatibleRestart, `${topologyDynamicContainer}-2`), "failed restart created configured suffix node 2.");
      assert(!findContainer(afterIncompatibleRestart, `${topologyDynamicContainer}-3`), "failed restart created configured suffix node 3.");
      assert(await inspectTopologyStaticBindings() === initialBindings, "failed restart changed the static container bindings.");

      const bootstrapPlan = await callTool(client, "local_ydb_bootstrap", {
        profile: topologyProfileName,
      });
      const nodeTwoRecreation = bootstrapPlan.plannedCommands?.find((command) => command.includes(`--name ${topologyDynamicContainer}-2 `));
      assert(nodeTwoRecreation, "three-node bootstrap plan omitted suffix node 2.");
      assert(nodeTwoRecreation.includes(`docker rm -f ${topologyDynamicContainer}-2`), "bootstrap did not plan to recreate suffix node 2.");
      assert(!nodeTwoRecreation.includes(".State.Running"), "bootstrap retained a running-container short circuit for suffix node 2.");

      const incompatibleBootstrap = await callTool(client, "local_ydb_bootstrap", {
        profile: topologyProfileName,
        confirm: true,
      });
      const incompatibilityIndex = incompatibleBootstrap.results?.findIndex((result) => result.ok === false) ?? -1;
      assert(incompatibilityIndex >= 0, "bootstrap accepted a static container with incomplete configured gRPC bindings.");
      assert(
        incompatibleBootstrap.results?.[incompatibilityIndex]?.stderr?.includes("does not match profile published ports"),
        "static binding incompatibility did not identify the published-port mismatch.",
      );
      assert(
        !incompatibleBootstrap.results?.some((result) => result.command?.includes(`docker rm -f ${topologyDynamicContainer}`)),
        "bootstrap mutated a configured dynamic node after static compatibility failed.",
      );
      const afterIncompatibleBootstrap = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
      assert(findContainer(afterIncompatibleBootstrap, topologyStaticContainer)?.id === initialStatic.id, "failed bootstrap changed the static container identity.");
      assert(findContainer(afterIncompatibleBootstrap, topologyDynamicContainer)?.id === initialDynamic.id, "failed bootstrap changed the configured container identity.");

      const rebuild = await callTool(client, "local_ydb_destroy_stack", {
        profile: topologyProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(rebuild, "one-node topology destroy before three-node rebuild");

      const bootstrapResult = await callTool(client, "local_ydb_bootstrap", {
        profile: topologyProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(bootstrapResult, "fresh three-node declarative bootstrap");
      await assertConfiguredTopology(client, configuredContainers, configuredIcPorts);
      await assertConfiguredGrpcBindingsAndEndpoints();
      const recreatedInventory = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });

      const configuredIdsBeforeIncompatibleAdd = configuredContainers.map((container) => findContainer(recreatedInventory, container)?.id);
      const setIncompatibleRestartPolicy = await runCommand("docker", ["update", "--restart=no", topologyStaticContainer]);
      assert(setIncompatibleRestartPolicy.exitCode === 0, setIncompatibleRestartPolicy.stderr || "failed to create the incompatible static fixture.");
      try {
        const incompatibleAddPlan = await callTool(client, "local_ydb_add_dynamic_nodes", {
          profile: topologyProfileName,
          count: 1,
        });
        const compatibilityIndex = incompatibleAddPlan.plannedCommands?.findIndex(
          (command) => command.includes("expected_image_id=") && command.includes("HostConfig.RestartPolicy.Name"),
        ) ?? -1;
        const createIndex = incompatibleAddPlan.plannedCommands?.findIndex(
          (command) => command.includes("docker create") && command.includes(`--name ${oneOffContainer}`),
        ) ?? -1;
        assert(compatibilityIndex >= 0, "owned incompatible add plan omitted static compatibility.");
        assert(createIndex > compatibilityIndex, "owned incompatible add plan placed compatibility after container creation.");

        const incompatibleAdd = await callTool(client, "local_ydb_add_dynamic_nodes", {
          profile: topologyProfileName,
          count: 1,
          confirm: true,
        });
        const failedResult = incompatibleAdd.results?.find((result) => result.ok === false);
        assert(
          failedResult?.stderr?.includes("does not match profile restart policy"),
          failedResult?.stderr || "owned static incompatibility did not identify restart policy.",
        );
        assert(
          !incompatibleAdd.results?.some((result) => result.command.includes("docker create") && result.command.includes(`--name ${oneOffContainer}`)),
          "owned incompatible add reached dynamic container creation.",
        );
        const afterIncompatibleAdd = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
        assert(!findContainer(afterIncompatibleAdd, oneOffContainer), "owned incompatible add created a one-off container.");
        assert(
          JSON.stringify(configuredContainers.map((container) => findContainer(afterIncompatibleAdd, container)?.id)) === JSON.stringify(configuredIdsBeforeIncompatibleAdd),
          "owned incompatible add changed configured container identities.",
        );
      } finally {
        const restoreRestartPolicy = await runCommand("docker", ["update", "--restart=unless-stopped", topologyStaticContainer]);
        assert(restoreRestartPolicy.exitCode === 0, restoreRestartPolicy.stderr || "failed to restore the task-owned static restart policy.");
      }

      const configuredIdsBeforeRejectedAdd = configuredContainers.map((container) => findContainer(recreatedInventory, container)?.id);
      const overlappingAdd = await client.callTool(
        {
          name: "local_ydb_add_dynamic_nodes",
          arguments: { profile: topologyProfileName, startIndex: 2 },
        },
        undefined,
        { timeout: 180_000 },
      );
      assert(overlappingAdd.isError === true, "one-off add accepted an index inside the configured topology.");
      assert(
        toolText(overlappingAdd).includes("startIndex must be greater than dynamicNodeCount (3)"),
        "configured-index add rejection did not report the dynamicNodeCount boundary.",
      );
      const afterRejectedAdd = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
      assert(
        JSON.stringify(configuredContainers.map((container) => findContainer(afterRejectedAdd, container)?.id)) === JSON.stringify(configuredIdsBeforeRejectedAdd),
        "rejected configured-index add changed configured container identities.",
      );

      const noTokenAuthPlan = await callTool(client, "local_ydb_apply_auth_hardening", {
        profile: topologyProfileName,
        configHostPath: join(tempDir, "declarative-no-token-auth.yaml"),
      });
      const noTokenAuthCommands = plannedCommandsText(noTokenAuthPlan);
      for (const container of configuredContainers) {
        assert(noTokenAuthCommands.includes(`docker rm -f ${container}`), `no-token auth plan did not recreate ${container}.`);
        assert(noTokenAuthCommands.includes(`--name ${container} `), `no-token auth plan did not run ${container}.`);
      }
      assert(
        !noTokenAuthCommands.includes(`docker restart ${topologyDynamicContainer}`),
        "no-token auth plan retained the dynamic docker restart shortcut.",
      );

      const configuredIdsBeforeDefaultRemove = configuredContainers.map((container) => findContainer(recreatedInventory, container)?.id);
      const defaultRemoveResult = await client.callTool(
        {
          name: "local_ydb_remove_dynamic_nodes",
          arguments: { profile: topologyProfileName },
        },
        undefined,
        { timeout: 180_000 },
      );
      assert(defaultRemoveResult.isError === true, "default removal without one-off nodes unexpectedly succeeded.");
      const defaultRemoveError = toolText(defaultRemoveResult);
      assert(defaultRemoveError.includes("found 0"), "default removal without one-off nodes did not report found 0.");
      const afterDefaultRemove = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
      assert(
        JSON.stringify(configuredContainers.map((container) => findContainer(afterDefaultRemove, container)?.id)) === JSON.stringify(configuredIdsBeforeDefaultRemove),
        "default removal changed configured container identities.",
      );

      const addPlan = await callTool(client, "local_ydb_add_dynamic_nodes", {
        profile: topologyProfileName,
        count: 2,
      });
      assert(addPlan.executed === false, "two-node one-off add plan executed unexpectedly.");
      assert(
        JSON.stringify(addPlan.nodes) === JSON.stringify([
          {
            container: oneOffContainer,
            index: 4,
            grpcPort: topologyDynamicGrpcPort + 3,
            monitoringPort: topologyDynamicMonitoringPort + 3,
            icPort: topologyDynamicIcPort + 3,
          },
          {
            container: `${topologyDynamicContainer}-5`,
            index: 5,
            grpcPort: topologyDynamicGrpcPort + 4,
            monitoringPort: topologyDynamicMonitoringPort + 4,
            icPort: topologyDynamicIcPort + 4,
          },
        ]),
        "two-node one-off add plan did not derive nodes 4 and 5 from the configured count.",
      );

      const addResult = await callTool(client, "local_ydb_add_dynamic_nodes", {
        profile: topologyProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(addResult, "default one-off node add");
      const afterAdd = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
      const oneOffBefore = findContainer(afterAdd, oneOffContainer);
      assert(oneOffBefore?.id, "one-off container ID was not available after add.");
      assert(oneOffBefore.state === "running", "one-off container was not running after add.");

      const configuredNodeTwo = `${topologyDynamicContainer}-2`;
      const removeNodeTwo = await runCommand("docker", ["rm", "-f", configuredNodeTwo]);
      assert(removeNodeTwo.exitCode === 0, `failed to replace configured node 2: ${removeNodeTwo.stderr || removeNodeTwo.stdout}`);
      const restartingFixture = await runCommand("docker", [
        "run",
        "-d",
        "--name",
        configuredNodeTwo,
        "--network",
        `container:${topologyStaticContainer}`,
        "--restart",
        "unless-stopped",
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        "exit 1",
      ]);
      assert(restartingFixture.exitCode === 0, restartingFixture.stderr || "failed to create restarting configured-node fixture.");
      await waitForRestartingContainer(configuredNodeTwo);
      const restartingInventory = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
      const restartingNode = findContainer(restartingInventory, configuredNodeTwo);
      assert(restartingNode?.id, "restarting configured-node fixture ID was not available.");
      assert(restartingNode.state === "restarting", "configured-node fixture did not enter restarting state.");

      const restartPlan = await callTool(client, "local_ydb_restart_stack", {
        profile: topologyProfileName,
      });
      assert(
        JSON.stringify(restartPlan.missingDynamicContainers) === JSON.stringify([]),
        "restart classified the present restarting configured node as missing.",
      );
      assert(
        JSON.stringify(restartPlan.unexpectedDynamicContainers) === JSON.stringify([oneOffContainer]),
        "restart preflight did not report the one-off node.",
      );
      assert(
        plannedCommandsText(restartPlan).includes(`docker rm -f ${configuredNodeTwo}`),
        "restart plan did not unconditionally remove the restarting configured node.",
      );
      assert(
        !plannedCommandsText(restartPlan).includes(".State.Running"),
        "restart plan retained a running-container short circuit.",
      );
      assert(
        !plannedCommandsText(restartPlan).includes(`docker rm -f ${oneOffContainer}`),
        "restart plan attempted to remove the one-off container.",
      );

      const restartResult = await callTool(client, "local_ydb_restart_stack", {
        profile: topologyProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(restartResult, "drift-aware declarative restart");
      await assertConfiguredTopology(client, configuredContainers, configuredIcPorts);
      const afterRestart = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
      assert(findContainer(afterRestart, configuredNodeTwo)?.id !== restartingNode.id, "restart preserved the restarting fixture identity instead of recreating it.");
      const oneOffAfter = findContainer(afterRestart, oneOffContainer);
      assert(oneOffAfter?.id === oneOffBefore.id, "restart changed the one-off container identity.");
      assert(oneOffAfter?.state === oneOffBefore.state, "restart changed the one-off container running state.");

      topologyProfile.monitoringBaseUrl = `http://127.0.0.1:${topologyUnusedMonitoringPort}`;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      try {
        const failedRestart = await callTool(client, "local_ydb_restart_stack", {
          profile: topologyProfileName,
          confirm: true,
        });
        const failedResultIndex = failedRestart.results?.findIndex((result) => result.ok === false) ?? -1;
        const recoveryResultIndex = failedRestart.results?.findIndex((result, index) => (
          index > failedResultIndex
          && result.ok === true
          && result.command?.includes(`docker start ${oneOffContainer}`)
        )) ?? -1;
        assert(failedResultIndex >= 0, "restart with an unused monitoring endpoint did not fail readiness.");
        assert(recoveryResultIndex > failedResultIndex, "failed restart did not restore the running one-off container after the original error.");
        const afterFailedRestart = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
        const oneOffAfterFailure = findContainer(afterFailedRestart, oneOffContainer);
        assert(oneOffAfterFailure?.id === oneOffBefore.id, "failed restart changed the one-off container identity.");
        assert(oneOffAfterFailure?.state === "running", "failed restart left the one-off container stopped.");
      } finally {
        topologyProfile.monitoringBaseUrl = `http://127.0.0.1:${topologyMonitoringPort}`;
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      }

      const finalRestart = await callTool(client, "local_ydb_restart_stack", {
        profile: topologyProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(finalRestart, "post-recovery declarative restart");
      await assertConfiguredTopology(client, configuredContainers, configuredIcPorts);
      const afterFinalRestart = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
      assert(findContainer(afterFinalRestart, oneOffContainer)?.id === oneOffBefore.id, "successful restart changed the one-off container identity.");
      assert(findContainer(afterFinalRestart, oneOffContainer)?.state === "running", "successful restart changed the one-off running state.");

      const configuredRemovePlan = await callTool(client, "local_ydb_remove_dynamic_nodes", {
        profile: topologyProfileName,
        containers: [`${topologyDynamicContainer}-2`],
      });
      assert(
        configuredRemovePlan.rollback.some((instruction) => instruction.includes("local_ydb_restart_stack") && instruction.includes("local_ydb_bootstrap")),
        "configured-node removal did not provide restart/bootstrap rollback.",
      );
      assert(
        !configuredRemovePlan.rollback.some((instruction) => instruction.includes("local_ydb_add_dynamic_nodes")),
        "configured-node removal incorrectly suggested one-off add rollback.",
      );
      const removeConfigured = await callTool(client, "local_ydb_remove_dynamic_nodes", {
        profile: topologyProfileName,
        containers: [`${topologyDynamicContainer}-2`],
        confirm: true,
      });
      assertSuccessfulMutation(removeConfigured, "configured node drift fixture removal");

      const restoreConfigured = await callTool(client, "local_ydb_restart_stack", {
        profile: topologyProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(restoreConfigured, "configured node rollback through restart");
      await assertConfiguredTopology(client, configuredContainers, configuredIcPorts);
      const afterConfiguredRollback = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
      assert(findContainer(afterConfiguredRollback, oneOffContainer)?.id === oneOffBefore.id, "configured-node rollback changed the one-off identity.");

      const oneOffRemovePlan = await callTool(client, "local_ydb_remove_dynamic_nodes", {
        profile: topologyProfileName,
        containers: [oneOffContainer],
      });
      assert(
        oneOffRemovePlan.rollback.some((instruction) => instruction.includes("local_ydb_add_dynamic_nodes")),
        "one-off removal did not provide add rollback.",
      );
      assert(
        !oneOffRemovePlan.rollback.some((instruction) => instruction.includes("local_ydb_restart_stack") || instruction.includes("local_ydb_bootstrap")),
        "one-off removal incorrectly suggested configured topology rollback.",
      );
      const removeOneOff = await callTool(client, "local_ydb_remove_dynamic_nodes", {
        profile: topologyProfileName,
        containers: [oneOffContainer],
        confirm: true,
      });
      assertSuccessfulMutation(removeOneOff, "one-off node removal");
      await assertConfiguredTopology(client, configuredContainers, configuredIcPorts);

      const destroyResult = await callTool(client, "local_ydb_destroy_stack", {
        profile: topologyProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(destroyResult, "declarative topology destroy");

      const rebootstrapResult = await callTool(client, "local_ydb_bootstrap", {
        profile: topologyProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(rebootstrapResult, "declarative topology rebootstrap");
      const afterRebootstrap = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
      const dynamicNames = afterRebootstrap.containers
        ?.map((container) => container.names)
        .filter((name) => name === topologyDynamicContainer || name?.startsWith(`${topologyDynamicContainer}-`))
        .sort();
      assert(
        JSON.stringify(dynamicNames) === JSON.stringify([...configuredContainers].sort()),
        "destroy/rebootstrap did not produce exactly the configured dynamic containers.",
      );
      await assertConfiguredTopology(client, configuredContainers, configuredIcPorts);
    } catch (error) {
      failures.push(error);
    }

    try {
      const cleanup = await callTool(client, "local_ydb_destroy_stack", {
        profile: topologyProfileName,
        confirm: true,
      });
      assertSuccessfulMutation(cleanup, "declarative topology cleanup");
    } catch (error) {
      failures.push(error);
    }

    try {
      await cleanupTopologyArtifacts();
      await assertTopologyArtifactsAbsent();
    } catch (error) {
      failures.push(error);
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "Declarative topology lifecycle or cleanup failed.");
    }
    console.log("Declarative dynamic-node topology lifecycle passed.");
  } finally {
    console.log("::endgroup::");
  }
}

async function assertConfiguredGrpcBindingsAndEndpoints() {
  const bindings = JSON.parse(await inspectTopologyStaticBindings());
  const expectedBindings = new Map([
    [topologyStaticGrpcPort, topologyStaticGrpcPort],
    [topologyDynamicGrpcPort, topologyDynamicGrpcPort],
    [topologyDynamicGrpcPort + 1, topologyDynamicGrpcPort + 1],
    [topologyDynamicGrpcPort + 2, topologyDynamicGrpcPort + 2],
    [8765, topologyMonitoringPort],
  ]);
  assert(Object.keys(bindings).length === expectedBindings.size, "static container published unexpected extra ports.");
  for (const [containerPort, hostPort] of expectedBindings) {
    assert(
      JSON.stringify(bindings[`${containerPort}/tcp`]) === JSON.stringify([{ HostIp: "127.0.0.1", HostPort: String(hostPort) }]),
      `static container did not publish exact loopback binding ${containerPort}->${hostPort}.`,
    );
  }

  for (const port of [topologyDynamicGrpcPort, topologyDynamicGrpcPort + 1, topologyDynamicGrpcPort + 2]) {
    const scheme = await runCommand("docker", [
      "exec",
      topologyStaticContainer,
      "/ydb",
      "-e",
      `grpc://localhost:${port}`,
      "-d",
      config.profiles[topologyProfileName].tenantPath,
      "scheme",
      "ls",
    ]);
    assert(scheme.exitCode === 0, scheme.stderr || `scheme ls failed through configured dynamic gRPC port ${port}.`);
  }
}

async function inspectTopologyStaticBindings() {
  const inspect = await runCommand("docker", [
    "inspect",
    "--type",
    "container",
    "--format",
    "{{json .HostConfig.PortBindings}}",
    topologyStaticContainer,
  ]);
  assert(inspect.exitCode === 0, inspect.stderr || "failed to inspect configured gRPC bindings.");
  return inspect.stdout;
}

async function waitForRestartingContainer(container) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inspect = await runCommand("docker", [
      "inspect",
      "--type",
      "container",
      "--format",
      "{{.State.Restarting}}",
      container,
    ]);
    if (inspect.exitCode === 0 && inspect.stdout.trim() === "true") {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Container ${container} did not enter Docker's restarting state.`);
}

async function assertConfiguredTopology(client, configuredContainers, configuredIcPorts) {
  const inventory = await callTool(client, "local_ydb_inventory", { profile: topologyProfileName });
  assert(inventory.ok === true, inventory.summary || "declarative inventory failed.");
  for (const container of configuredContainers) {
    assert(findContainer(inventory, container), `declarative inventory omitted ${container}.`);
  }

  const nodes = await callTool(client, "local_ydb_nodes_check", { profile: topologyProfileName });
  const observedPorts = nodePorts(nodes);
  for (const port of configuredIcPorts) {
    assert(observedPorts.includes(port), `declarative nodelist omitted IC port ${port}.`);
  }

  const tenant = await callTool(client, "local_ydb_tenant_check", { profile: topologyProfileName });
  assert(tenant.ok === true, tenant.stderr || "declarative tenant metadata check failed.");
}

function findContainer(inventory, name) {
  return Array.isArray(inventory.containers)
    ? inventory.containers.find((container) => container.names === name)
    : undefined;
}

async function cleanupTopologyArtifacts() {
  await runCommand("docker", [
    "rm",
    "-f",
    `${topologyDynamicContainer}-5`,
    `${topologyDynamicContainer}-4`,
    `${topologyDynamicContainer}-3`,
    `${topologyDynamicContainer}-2`,
    topologyDynamicContainer,
    topologyStaticContainer,
  ]);
  await runCommand("docker", ["network", "rm", topologyNetwork]);
  await runCommand("docker", ["volume", "rm", topologyVolume]);
}

async function assertTopologyArtifactsAbsent() {
  for (const [kind, args] of [
    ["static container", ["inspect", topologyStaticContainer]],
    ["primary dynamic container", ["inspect", topologyDynamicContainer]],
    ["dynamic container 2", ["inspect", `${topologyDynamicContainer}-2`]],
    ["dynamic container 3", ["inspect", `${topologyDynamicContainer}-3`]],
    ["one-off dynamic container", ["inspect", `${topologyDynamicContainer}-4`]],
    ["one-off dynamic container 5", ["inspect", `${topologyDynamicContainer}-5`]],
    ["network", ["network", "inspect", topologyNetwork]],
    ["volume", ["volume", "inspect", topologyVolume]],
  ]) {
    const result = await runCommand("docker", args);
    assert(result.exitCode !== 0, `Disposable declarative topology ${kind} still exists after cleanup.`);
  }
}

function assertSuccessfulMutation(result, description) {
  assert(result.executed === true, `${description} did not execute.`);
  assert(
    Array.isArray(result.results) && result.results.length > 0,
    `${description} returned no command results.`,
  );
  assert(
    result.results.every((commandResult) => commandResult.ok === true),
    `${description} returned a failed command result.`,
  );
}

async function cleanupLifecycleArtifacts() {
  await runCommand("docker", [
    "rm",
    "-f",
    lifecycleDynamicContainer,
    lifecycleStaticContainer,
  ]);
  await runCommand("docker", ["network", "rm", lifecycleNetwork]);
  await runCommand("docker", ["volume", "rm", lifecycleVolume]);
  await runCommand("docker", ["volume", "rm", lifecycleMismatchedVolume]);
}

async function assertLifecycleArtifactsAbsent() {
  for (const [kind, args] of [
    ["container", ["inspect", lifecycleStaticContainer]],
    ["dynamic container", ["inspect", lifecycleDynamicContainer]],
    ["network", ["network", "inspect", lifecycleNetwork]],
    ["volume", ["volume", "inspect", lifecycleVolume]],
    ["mismatched volume", ["volume", "inspect", lifecycleMismatchedVolume]],
  ]) {
    const result = await runCommand("docker", args);
    assert(result.exitCode !== 0, `Disposable lifecycle ${kind} still exists after cleanup.`);
  }
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
    let effectiveArgs = args;
    if (args.confirm === true && args.confirmationToken === undefined) {
      const planArgs = { ...args };
      delete planArgs.confirm;
      const plan = await invokeTool(client, name, planArgs);
      console.log(JSON.stringify(summarize(plan), null, 2));
      if (
        plan.confirmation?.status === "not-required"
        || isReadOnlyMixedAction(name, planArgs)
      ) {
        return plan;
      }
      assert(
        typeof plan.confirmation?.token === "string",
        `${name} did not return a confirmation token for its exact plan.`,
      );
      effectiveArgs = {
        ...args,
        confirmationToken: plan.confirmation.token,
      };
    }
    const data = await invokeTool(client, name, effectiveArgs);
    console.log(JSON.stringify(summarize(data), null, 2));
    return data;
  } finally {
    console.log("::endgroup::");
  }
}

function isReadOnlyMixedAction(name, args) {
  return (name === "local_ydb_sql" && (args.action ?? "query") !== "execute")
    || (name === "local_ydb_apply_schema" && (args.action ?? "validate") === "validate")
    || (name === "local_ydb_permissions" && (args.action ?? "list") === "list");
}

async function invokeTool(client, name, args) {
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
  return data;
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
    outcome: value.outcome,
    confirmationRequired: value.confirmationRequired,
    confirmationConsumed: value.confirmationConsumed,
    confirmationStatus: value.confirmation?.status,
    outputBytes: value.outputBytes,
    truncated: value.truncated,
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

async function allocateOpenPorts(count) {
  const ports = new Set();
  while (ports.size < count) {
    ports.add(await allocateOpenPort());
  }
  return [...ports];
}

async function allocateContiguousOpenPorts(count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ports = contiguousPortCandidates(count);
    const servers = [];
    try {
      for (const port of ports) {
        servers.push(await listenOnPort(port));
      }
      await Promise.all(servers.map(closeServer));
      return ports;
    } catch {
      await Promise.all(servers.map(closeServer));
    }
  }
  throw new Error(`Could not allocate ${count} contiguous open TCP ports.`);
}

function listenOnPort(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPromise);
    server.listen({ host: "127.0.0.1", port }, () => resolvePromise(server));
  });
}

function closeServer(server) {
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
  });
}

async function allocateOpenPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.on("error", rejectPromise);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("Could not allocate an open TCP port."));
        return;
      }
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
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
