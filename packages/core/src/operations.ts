import { dirname } from "node:path";
import {
  bash,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  LocalYdbApiClient,
  parseBscPlacement,
  parseReadStoragePools,
  type StoragePoolSummary,
  shellQuote
} from "./api-client.js";
import { loadConfig, resolveProfile, type LocalYdbConfig, type ResolvedLocalYdbProfile } from "./validation.js";

export interface ToolkitContext {
  config: LocalYdbConfig;
  profile: ResolvedLocalYdbProfile;
  client: LocalYdbApiClient;
}

export interface OperationPlan {
  risk: "low" | "medium" | "high";
  plannedCommands: string[];
  rollback: string[];
  verification: string[];
}

export interface OperationResponse extends OperationPlan {
  summary: string;
  executed: boolean;
  results?: CommandResult[];
}

export interface MutatingOptions {
  confirm?: boolean;
}

export interface AddDynamicNodesOptions extends MutatingOptions {
  count?: number;
  startIndex?: number;
  grpcPortStart?: number;
  monitoringPortStart?: number;
  icPortStart?: number;
}

export interface RemoveDynamicNodesOptions extends MutatingOptions {
  count?: number;
  startIndex?: number;
  containers?: string[];
}

export interface AddStorageGroupsOptions extends MutatingOptions {
  count?: number;
  poolName?: string;
}

export interface DestroyStackOptions extends MutatingOptions {
  removeBindMountPath?: boolean;
  removeAuthArtifacts?: boolean;
  removeDumpHostPath?: boolean;
}

export interface DynamicNodePlan {
  container: string;
  index: number;
  grpcPort: number;
  monitoringPort: number;
  icPort: number;
}

export interface DynamicNodeTarget {
  container: string;
  index: number;
  icPort?: number;
}

export interface DynamicNodeCheck {
  container: string;
  icPort: number;
  ok: boolean;
  attempts: number;
  observedPorts: number[];
  error?: string;
}

export interface AddDynamicNodesResponse extends OperationResponse {
  nodes: DynamicNodePlan[];
  nodeChecks?: DynamicNodeCheck[];
}

export interface RemoveDynamicNodesResponse extends OperationResponse {
  nodes: DynamicNodeTarget[];
  nodeChecks?: DynamicNodeCheck[];
}

export interface AddStorageGroupsResponse extends OperationResponse {
  pool: {
    name: string;
    boxId: number;
    storagePoolId: number;
    numGroups: number;
    targetNumGroups: number;
    itemConfigGeneration?: number;
  };
  observedNumGroups?: number;
}

export interface DestroyStackResponse extends OperationResponse {
  tenantRemovePlanned: boolean;
  extraDynamicNodes: string[];
  removesBindMountPath: boolean;
  removesAuthArtifacts: boolean;
  removesDumpHostPath: boolean;
}

type ResolvedStoragePoolSummary = Required<Pick<StoragePoolSummary, "rawBlock" | "boxId" | "storagePoolId" | "name" | "numGroups">> &
  Pick<StoragePoolSummary, "itemConfigGeneration">;

export function createContext(profileName?: string, executor?: CommandExecutor, config = loadConfig()): ToolkitContext {
  const profile = resolveProfile(config, profileName);
  return {
    config,
    profile,
    client: new LocalYdbApiClient(profile, executor)
  };
}

export async function inventory(ctx: ToolkitContext) {
  const containers = await ctx.client.dockerPs();
  const volumes = await ctx.client.dockerVolumes();
  const inspect = await ctx.client.dockerInspect([ctx.profile.staticContainer, ctx.profile.dynamicContainer]);
  return {
    summary: `Found ${containers.length} Docker containers and ${volumes.length} Docker volumes for profile ${ctx.profile.name}.`,
    profile: publicProfile(ctx.profile),
    containers,
    volumes,
    inspect
  };
}

export async function statusReport(ctx: ToolkitContext) {
  const inv = await inventory(ctx);
  const authStatus = await authCheck(ctx);
  const tenant = await tenantCheck(ctx);
  const nodes = await nodesCheck(ctx);
  return {
    summary: `Status report for ${ctx.profile.name}: tenant=${tenant.ok ? "ok" : "not-ok"}, nodes=${nodes.ok ? "ok" : "not-ok"}.`,
    inventory: inv,
    auth: authStatus,
    tenant,
    nodes
  };
}

export async function tenantCheck(ctx: ToolkitContext) {
  const result = await ctx.client.run(ydbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Check tenant metadata"));
  return {
    summary: result.ok ? `Tenant ${ctx.profile.tenantPath} metadata is reachable.` : `Tenant ${ctx.profile.tenantPath} metadata check failed.`,
    ok: result.ok,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function databaseStatus(ctx: ToolkitContext) {
  const result = await ctx.client.run(ydbdAdmin(ctx.profile, ["admin", "database", ctx.profile.tenantPath, "status"], "Read database status"));
  return {
    summary: result.ok ? `Database status for ${ctx.profile.tenantPath} was read.` : `Database status for ${ctx.profile.tenantPath} could not be read.`,
    ok: result.ok,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function nodesCheck(ctx: ToolkitContext) {
  const database = encodeURIComponent(ctx.profile.tenantPath);
  const response = await ctx.client.viewerGet(`/viewer/json/nodelist?database=${database}&enums=true&type=any`, Boolean(ctx.profile.rootPasswordFile));
  const nodes = response.status === "ok" && Array.isArray(response.data) ? response.data : [];
  return {
    summary: response.status === "ok" ? `Viewer returned ${nodes.length} nodes.` : "Viewer node-list check failed.",
    ok: response.status === "ok",
    nodes,
    error: response.error
  };
}

export async function graphshardCheck(ctx: ToolkitContext) {
  const database = encodeURIComponent(ctx.profile.tenantPath);
  const capabilities = await ctx.client.viewerGet(`/viewer/json/capabilities?database=${database}`, Boolean(ctx.profile.rootPasswordFile));
  const tabletInfo = await ctx.client.viewerGet(`/viewer/json/tabletinfo?database=${database}&enums=true`, Boolean(ctx.profile.rootPasswordFile));
  const graphShardExists = readPath(capabilities.data, ["Settings", "Database", "GraphShardExists"]);
  const graphTabletIds = collectGraphShardTabletIds(tabletInfo.data);
  return {
    summary: graphShardExists ? `GraphShard exists for ${ctx.profile.tenantPath}.` : `GraphShard was not confirmed for ${ctx.profile.tenantPath}.`,
    ok: Boolean(graphShardExists),
    graphShardExists: Boolean(graphShardExists),
    graphTabletIds,
    capabilities,
    tabletInfoStatus: tabletInfo.status,
    tabletInfoError: tabletInfo.error
  };
}

export async function authCheck(ctx: ToolkitContext) {
  const localWhoami = await ctx.client.viewerStatus("/viewer/json/whoami");
  const anonymousCli = await ctx.client.run(ydbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Check anonymous YDB CLI access"));
  return {
    summary: `Anonymous viewer whoami returned ${localWhoami ?? "unknown"}.`,
    viewerWhoamiStatus: localWhoami,
    anonymousCliOk: anonymousCli.ok,
    anonymousCliCommand: anonymousCli.command,
    anonymousCliStderr: anonymousCli.stderr
  };
}

export async function storagePlacement(ctx: ToolkitContext) {
  const readPool = await ctx.client.run(ydbdAdmin(ctx.profile, [
    "admin", "blobstorage", "config", "invoke",
    "--proto", "Command { ReadStoragePool { BoxId: 1 } }"
  ], "Read storage pool config"));
  const queryBase = await ctx.client.run(ydbdAdmin(ctx.profile, [
    "admin", "blobstorage", "config", "invoke",
    "--proto", "Command { QueryBaseConfig { RetrieveDevices: true SuppressNodes: true } }"
  ], "Query BSC physical placement"));
  return {
    summary: queryBase.ok ? "BSC placement query completed." : "BSC placement query failed.",
    ok: readPool.ok && queryBase.ok,
    readPool: {
      command: readPool.command,
      ok: readPool.ok,
      stdout: readPool.stdout,
      stderr: readPool.stderr
    },
    queryBase: {
      command: queryBase.command,
      ok: queryBase.ok,
      placement: parseBscPlacement(queryBase.stdout),
      stdout: queryBase.stdout,
      stderr: queryBase.stderr
    }
  };
}

export async function storageLeftovers(ctx: ToolkitContext) {
  const paths = ctx.profile.storageSearchPaths.map(shellQuote).join(" ");
  const result = await ctx.client.run(bash(`docker volume ls --format '{{.Name}}' | grep -E 'ydb|local' || true\nfind ${paths} -maxdepth 4 \\( -path '*ydb*pdisks*' -o -path '*ydb-dump*' -o -path '*ydb-data*' -o -path '*ydb-local-data*' \\) -print 2>/dev/null | sort || true`, {
    allowFailure: true,
    timeoutMs: 60_000,
    description: "Find local-ydb leftover volumes and paths"
  }));
  return {
    summary: "Collected candidate leftover storage paths and volumes.",
    ok: result.ok,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function containerLogs(
  ctx: ToolkitContext,
  options: { target: "static" | "dynamic"; lines?: number }
) {
  const container = options.target === "dynamic" ? ctx.profile.dynamicContainer : ctx.profile.staticContainer;
  const lines = options.lines ?? 200;
  const result = await ctx.client.run({
    command: "docker",
    args: ["logs", "--tail", String(lines), container],
    allowFailure: true,
    description: `Read ${options.target} container logs`
  });
  return {
    summary: result.ok ? `Read ${options.target} container logs.` : `Failed to read ${options.target} container logs.`,
    ok: result.ok,
    container,
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function bootstrap(ctx: ToolkitContext, options: MutatingOptions = {}): Promise<OperationResponse> {
  const specs = [
    bash(`docker network inspect ${shellQuote(ctx.profile.network)} >/dev/null 2>&1 || docker network create ${shellQuote(ctx.profile.network)}`, { description: "Ensure Docker network exists" }),
    ctx.profile.bindMountPath
      ? bash(`mkdir -p ${shellQuote(ctx.profile.bindMountPath)}`, { description: "Ensure bind mount path exists" })
      : bash(`docker volume inspect ${shellQuote(ctx.profile.volume)} >/dev/null 2>&1 || docker volume create ${shellQuote(ctx.profile.volume)}`, { description: "Ensure Docker volume exists" }),
    bash(`docker inspect ${shellQuote(ctx.profile.staticContainer)} >/dev/null 2>&1 || ${commandForStaticRun(ctx.profile)}`, { timeoutMs: 60_000, description: "Start static local-ydb node" }),
    bash("sleep 5", { description: "Wait briefly for static node startup" }),
    createTenantSpec(ctx.profile),
    bash("sleep 5", { description: "Wait briefly for tenant creation" }),
    bash(commandForDynamicEnsureRun(ctx.profile), { timeoutMs: 60_000, description: "Start dynamic tenant node" }),
    bash("sleep 5", { description: "Wait briefly for dynamic node startup" }),
    ydbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Verify tenant metadata"),
    bash(`curl -fsSL ${shellQuote(`${ctx.profile.monitoringBaseUrl}/viewer/json/capabilities?database=${encodeURIComponent(ctx.profile.tenantPath)}`)} >/dev/null`, { allowFailure: true, description: "Verify viewer capabilities endpoint" })
  ];
  return runMutating(ctx, {
    summary: `Bootstrap local-ydb topology for ${ctx.profile.tenantPath}.`,
    risk: "high",
    specs,
    rollback: [
      `docker rm -f ${ctx.profile.dynamicContainer}`,
      `docker rm -f ${ctx.profile.staticContainer}`,
      ctx.profile.bindMountPath ? `Review and remove bind mount path manually: ${ctx.profile.bindMountPath}` : `docker volume rm ${ctx.profile.volume}`
    ],
    verification: [
      `scheme ls ${ctx.profile.tenantPath}`,
      "viewer capabilities reports GraphShardExists=true",
      "dynamic node appears in viewer/json/nodelist"
    ]
  }, options);
}

export async function createTenant(ctx: ToolkitContext, options: MutatingOptions = {}) {
  return runMutating(ctx, {
    summary: `Create CMS tenant ${ctx.profile.tenantPath}.`,
    risk: "medium",
    specs: [createTenantSpec(ctx.profile)],
    rollback: [`/ydbd --server localhost:${ctx.profile.ports.staticGrpc} admin database ${ctx.profile.tenantPath} remove --force`],
    verification: [`admin database ${ctx.profile.tenantPath} status`, `scheme ls ${ctx.profile.tenantPath}`]
  }, options);
}

export async function startDynamicNode(ctx: ToolkitContext, options: MutatingOptions = {}) {
  return runMutating(ctx, {
    summary: `Start dynamic node ${ctx.profile.dynamicContainer}.`,
    risk: "medium",
    specs: [bash(commandForDynamicEnsureRun(ctx.profile), { timeoutMs: 60_000 })],
    rollback: [`docker rm -f ${ctx.profile.dynamicContainer}`],
    verification: ["container is Up", "viewer/json/nodelist includes the dynamic node", `scheme ls ${ctx.profile.tenantPath}`]
  }, options);
}

export async function addDynamicNodes(ctx: ToolkitContext, options: AddDynamicNodesOptions = {}): Promise<AddDynamicNodesResponse> {
  const plans = additionalDynamicNodePlans(ctx.profile, options);
  const specs = plans.flatMap((plan) => dynamicNodeStartSpecs(ctx.profile, plan));
  const rollback = plans.map((plan) => `docker rm -f ${plan.container}`);
  const verification = [
    "each added container is Up, not Restarting",
    "authenticated viewer/json/nodelist includes each added node IC port",
    `scheme ls ${ctx.profile.tenantPath}`
  ];

  if (!options.confirm) {
    return {
      summary: `Add ${plans.length} dynamic node${plans.length === 1 ? "" : "s"} to ${ctx.profile.tenantPath}. Not executed because confirm=true was not provided.`,
      executed: false,
      risk: "high",
      plannedCommands: specs.map((spec) => ctx.client.display(spec)),
      rollback,
      verification,
      nodes: plans
    };
  }

  const results: CommandResult[] = [];
  const nodeChecks: DynamicNodeCheck[] = [];
  let completedNodes = 0;

  for (const plan of plans) {
    for (const spec of dynamicNodeStartSpecs(ctx.profile, plan)) {
      const result = await ctx.client.run(spec);
      results.push(result);
      if (!result.ok) {
        return addDynamicNodesResponse(ctx, plans, nodeChecks, results, rollback, verification, completedNodes);
      }
    }

    const check = await waitForDynamicNodePort(ctx, plan);
    nodeChecks.push(check);
    if (!check.ok) {
      return addDynamicNodesResponse(ctx, plans, nodeChecks, results, rollback, verification, completedNodes);
    }
    completedNodes += 1;
  }

  results.push(await ctx.client.run(ydbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Verify tenant metadata")));
  return addDynamicNodesResponse(ctx, plans, nodeChecks, results, rollback, verification, completedNodes);
}

export async function removeDynamicNodes(ctx: ToolkitContext, options: RemoveDynamicNodesOptions = {}): Promise<RemoveDynamicNodesResponse> {
  const targets = await removableDynamicNodeTargets(ctx, options);
  const specs = targets.map((target) => bash(`docker rm -f ${shellQuote(target.container)}`, {
    timeoutMs: 60_000,
    description: `Remove dynamic tenant node ${target.container}`
  }));
  const rollback = [
    "Recreate removed nodes with local_ydb_add_dynamic_nodes using matching suffixes and ports if needed."
  ];
  const verification = [
    "authenticated viewer/json/nodelist no longer includes each removed node IC port",
    `scheme ls ${ctx.profile.tenantPath}`
  ];

  if (!options.confirm) {
    return {
      summary: `Remove ${targets.length} dynamic node${targets.length === 1 ? "" : "s"} from ${ctx.profile.tenantPath}. Not executed because confirm=true was not provided.`,
      executed: false,
      risk: "high",
      plannedCommands: specs.map((spec) => ctx.client.display(spec)),
      rollback,
      verification,
      nodes: targets
    };
  }

  const results: CommandResult[] = [];
  const nodeChecks: DynamicNodeCheck[] = [];
  let completedNodes = 0;

  for (const target of targets) {
    const result = await ctx.client.run(bash(`docker rm -f ${shellQuote(target.container)}`, {
      timeoutMs: 60_000,
      description: `Remove dynamic tenant node ${target.container}`
    }));
    results.push(result);
    if (!result.ok) {
      return removeDynamicNodesResponse(ctx, targets, nodeChecks, results, rollback, verification, completedNodes);
    }
    const icPort = target.icPort;
    if (typeof icPort === "number") {
      const check = await waitForDynamicNodePortAbsence(ctx, { ...target, icPort });
      nodeChecks.push(check);
      if (!check.ok) {
        return removeDynamicNodesResponse(ctx, targets, nodeChecks, results, rollback, verification, completedNodes);
      }
    }
    completedNodes += 1;
  }

  results.push(await ctx.client.run(ydbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Verify tenant metadata")));
  return removeDynamicNodesResponse(ctx, targets, nodeChecks, results, rollback, verification, completedNodes);
}

export async function addStorageGroups(ctx: ToolkitContext, options: AddStorageGroupsOptions = {}): Promise<AddStorageGroupsResponse> {
  const groupsToAdd = options.count ?? 1;
  assertPositiveInteger("count", groupsToAdd);
  if (groupsToAdd > 10) {
    throw new Error("count must be 10 or less");
  }

  const pool = await readTargetStoragePool(ctx, options.poolName);
  const targetNumGroups = pool.numGroups + groupsToAdd;
  const defineSpec = ydbdAdmin(ctx.profile, [
    "admin", "blobstorage", "config", "invoke",
    "--proto", buildDefineStoragePoolRequest(pool, targetNumGroups)
  ], `Increase storage groups for ${pool.name}`);
  const plannedCommands = [ctx.client.display(defineSpec)];
  const rollback = [
    `Reapply DefineStoragePool for ${pool.name} with NumGroups: ${pool.numGroups} and ItemConfigGeneration: ${pool.itemConfigGeneration ?? "<current>"}.`
  ];
  const verification = [
    `ReadStoragePool for ${pool.name} reports NumGroups: ${targetNumGroups}`,
    `scheme ls ${ctx.profile.tenantPath}`
  ];

  if (!options.confirm) {
    return {
      summary: `Add ${groupsToAdd} storage group${groupsToAdd === 1 ? "" : "s"} to ${pool.name}. Not executed because confirm=true was not provided.`,
      executed: false,
      risk: "high",
      plannedCommands,
      rollback,
      verification,
      pool: {
        name: pool.name,
        boxId: pool.boxId,
        storagePoolId: pool.storagePoolId,
        numGroups: pool.numGroups,
        targetNumGroups,
        itemConfigGeneration: pool.itemConfigGeneration
      }
    };
  }

  const results: CommandResult[] = [];
  const invokeResult = await ctx.client.run(defineSpec);
  results.push(invokeResult);
  if (!invokeResult.ok) {
    return addStorageGroupsResponse(ctx, pool, targetNumGroups, undefined, results, rollback, verification);
  }

  const refreshedPool = await readTargetStoragePool(ctx, pool.name);
  const observedNumGroups = refreshedPool.numGroups;
  results.push({
    command: `verify storage pool ${pool.name} NumGroups`,
    exitCode: observedNumGroups === targetNumGroups ? 0 : 1,
    stdout: `Observed NumGroups: ${observedNumGroups}`,
    stderr: observedNumGroups === targetNumGroups ? "" : `Expected NumGroups: ${targetNumGroups}`,
    ok: observedNumGroups === targetNumGroups,
    timedOut: false
  });
  if (observedNumGroups !== targetNumGroups) {
    return addStorageGroupsResponse(ctx, pool, targetNumGroups, observedNumGroups, results, rollback, verification);
  }
  const tenantResult = await ctx.client.run(ydbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Verify tenant metadata"));
  results.push(tenantResult);

  return addStorageGroupsResponse(ctx, pool, targetNumGroups, observedNumGroups, results, rollback, verification);
}

export async function destroyStack(ctx: ToolkitContext, options: DestroyStackOptions = {}): Promise<DestroyStackResponse> {
  const inventoryState = await inventory(ctx);
  const extraDynamicNodes = findExtraDynamicContainers(ctx.profile, inventoryState.containers.map((container) => container.names));
  const specs: CommandSpec[] = [
    removeTenantIfPresentSpec(ctx.profile),
    ...extraDynamicNodes.map((container) => bash(`docker rm -f ${shellQuote(container)} 2>/dev/null || true`, {
      timeoutMs: 60_000,
      description: `Remove extra dynamic tenant node ${container}`
    })),
    bash(`docker rm -f ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || true`, {
      timeoutMs: 60_000,
      description: `Remove main dynamic tenant node ${ctx.profile.dynamicContainer}`
    }),
    bash(`docker rm -f ${shellQuote(ctx.profile.staticContainer)} 2>/dev/null || true`, {
      timeoutMs: 60_000,
      description: `Remove static local-ydb node ${ctx.profile.staticContainer}`
    }),
    bash(`docker network rm ${shellQuote(ctx.profile.network)} 2>/dev/null || true`, {
      timeoutMs: 60_000,
      description: `Remove Docker network ${ctx.profile.network}`
    })
  ];

  if (ctx.profile.bindMountPath) {
    if (options.removeBindMountPath) {
      specs.push(bash(`rm -rf ${shellQuote(ctx.profile.bindMountPath)}`, {
        timeoutMs: 60_000,
        description: `Remove bind mount path ${ctx.profile.bindMountPath}`
      }));
    }
  } else {
    specs.push(bash(`docker volume rm ${shellQuote(ctx.profile.volume)} 2>/dev/null || true`, {
      timeoutMs: 60_000,
      description: `Remove Docker volume ${ctx.profile.volume}`
    }));
  }

  if (options.removeAuthArtifacts) {
    for (const path of [ctx.profile.authConfigPath, ctx.profile.dynamicNodeAuthTokenFile, ctx.profile.rootPasswordFile].filter((value): value is string => Boolean(value))) {
      specs.push(bash(`rm -f ${shellQuote(path)}`, {
        timeoutMs: 60_000,
        description: `Remove auth artifact ${path}`
      }));
    }
  }

  if (options.removeDumpHostPath) {
    specs.push(bash(`rm -rf ${shellQuote(ctx.profile.dumpHostPath)}`, {
      timeoutMs: 60_000,
      description: `Remove dump directory ${ctx.profile.dumpHostPath}`
    }));
  }

  const rollback = [
    "Restore from dump or recreate the profile stack with local_ydb_bootstrap/local_ydb_start_dynamic_node after rebuilding the profile state."
  ];
  const verification = [
    "local_ydb_inventory reports no profile containers",
    "local_ydb_storage_leftovers no longer reports the profile volume or bind path when the destructive options were enabled"
  ];
  const plannedCommands = specs.map((spec) => ctx.client.display(spec));

  if (!options.confirm) {
    return {
      summary: `Destroy local-ydb stack for ${ctx.profile.name}. Not executed because confirm=true was not provided.`,
      executed: false,
      risk: "high",
      plannedCommands,
      rollback,
      verification,
      tenantRemovePlanned: true,
      extraDynamicNodes,
      removesBindMountPath: Boolean(ctx.profile.bindMountPath && options.removeBindMountPath),
      removesAuthArtifacts: Boolean(options.removeAuthArtifacts),
      removesDumpHostPath: Boolean(options.removeDumpHostPath)
    };
  }

  const results: CommandResult[] = [];
  for (const spec of specs) {
    const result = await ctx.client.run(spec);
    results.push(result);
    if (!result.ok) {
      break;
    }
  }

  return {
    summary: `Destroy local-ydb stack for ${ctx.profile.name}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands.`,
    executed: true,
    risk: "high",
    plannedCommands,
    rollback,
    verification,
    results,
    tenantRemovePlanned: true,
    extraDynamicNodes,
    removesBindMountPath: Boolean(ctx.profile.bindMountPath && options.removeBindMountPath),
    removesAuthArtifacts: Boolean(options.removeAuthArtifacts),
    removesDumpHostPath: Boolean(options.removeDumpHostPath)
  };
}

export async function restartStack(ctx: ToolkitContext, options: MutatingOptions = {}) {
  const specs = [
    bash(`docker stop ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || true`),
    bash(`docker stop ${shellQuote(ctx.profile.staticContainer)} 2>/dev/null || true`),
    bash(`docker start ${shellQuote(ctx.profile.staticContainer)}`),
    bash("sleep 5"),
    createTenantSpec(ctx.profile),
    bash("sleep 5"),
    bash(commandForDynamicEnsureRun(ctx.profile))
  ];
  return runMutating(ctx, {
    summary: `Restart local-ydb static and dynamic containers for ${ctx.profile.name}.`,
    risk: "high",
    specs,
    rollback: ["Start previous container definitions captured by local_ydb_inventory."],
    verification: ["static and dynamic containers are Up", `scheme ls ${ctx.profile.tenantPath}`]
  }, options);
}

export async function dumpTenant(ctx: ToolkitContext, options: MutatingOptions & { dumpName?: string } = {}) {
  const dumpName = options.dumpName ?? `${ctx.profile.tenantPath.split("/").pop() ?? "tenant"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dumpPath = `${ctx.profile.dumpHostPath}/${dumpName}`;
  const specs = [
    bash(`mkdir -p ${shellQuote(dumpPath)}`),
    helperContainer(ctx.profile, `/ydb -e grpc://localhost:${ctx.profile.ports.dynamicGrpc} -d ${shellQuote(ctx.profile.tenantPath)} ${ydbAuthArgs(ctx.profile)} tools dump -p . -o ${shellQuote(`/dump/${dumpName}/tenant`)}`)
  ];
  return runMutating(ctx, {
    summary: `Dump ${ctx.profile.tenantPath} to ${dumpPath}.`,
    risk: "medium",
    specs,
    rollback: [`rm -rf ${dumpPath}`],
    verification: [`test -d ${dumpPath}/tenant`]
  }, options);
}

export async function restoreTenant(ctx: ToolkitContext, options: MutatingOptions & { dumpName?: string } = {}) {
  if (!options.dumpName) {
    return planOnly(ctx, "Restore requires dumpName.", "high", [], ["No changes."], ["Provide dumpName and rerun."]);
  }
  return runMutating(ctx, {
    summary: `Restore ${ctx.profile.tenantPath} from ${ctx.profile.dumpHostPath}/${options.dumpName}.`,
    risk: "high",
    specs: [
      helperContainer(ctx.profile, `/ydb -e grpc://localhost:${ctx.profile.ports.dynamicGrpc} -d ${shellQuote(ctx.profile.tenantPath)} ${ydbAuthArgs(ctx.profile)} tools restore -p . -i ${shellQuote(`/dump/${options.dumpName}/tenant`)}`)
    ],
    rollback: ["Restore from a previous dump or restart the previous volume/container set."],
    verification: [`scheme ls ${ctx.profile.tenantPath}`, "small table reads succeed"]
  }, options);
}

export async function applyAuthHardening(ctx: ToolkitContext, options: MutatingOptions & { configHostPath?: string } = {}) {
  const configHostPath = options.configHostPath ?? ctx.profile.authConfigPath;
  if (!configHostPath) {
    return planOnly(ctx, "Auth hardening requires configHostPath for the prepared YDB config.", "high", [], ["No changes."], ["Provide a reviewed configHostPath."]);
  }
  const target = "/ydb_data/cluster/kikimr_configs/config.yaml";
  const dynamicNodeRecreate = ctx.profile.dynamicNodeAuthTokenFile
    ? [
        bash(`docker rm -f ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || true`),
        bash(commandForDynamicRun(ctx.profile), { timeoutMs: 60_000 })
      ]
    : [
        bash(`docker restart ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || true`)
      ];
  return runMutating(ctx, {
    summary: `Apply reviewed YDB auth config from ${configHostPath}.`,
    risk: "high",
    specs: [
      bash(`docker cp ${shellQuote(configHostPath)} ${shellQuote(`${ctx.profile.staticContainer}:/tmp/local-ydb-toolkit-config.yaml`)}`),
      ctx.client.dockerExec(ctx.profile.staticContainer, ["cp", target, `${target}.before-local-ydb-toolkit-auth`]),
      ctx.client.dockerExec(ctx.profile.staticContainer, ["cp", "/tmp/local-ydb-toolkit-config.yaml", target]),
      bash(`docker stop ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || true`),
      bash(`docker restart ${shellQuote(ctx.profile.staticContainer)}`),
      bash("sleep 5"),
      createTenantSpec(ctx.profile),
      ...dynamicNodeRecreate
    ],
    rollback: [
      `docker exec ${ctx.profile.staticContainer} cp ${target}.before-local-ydb-toolkit-auth ${target}`,
      `docker restart ${ctx.profile.staticContainer}`
    ],
    verification: ["anonymous viewer/json returns 401", "authenticated tenant checks pass", "dynamic node reaches nodelist"]
  }, options);
}

export async function prepareAuthConfig(
  ctx: ToolkitContext,
  options: MutatingOptions & { configHostPath?: string; sid?: string } = {}
) {
  const configHostPath = options.configHostPath ?? ctx.profile.authConfigPath;
  const sid = options.sid ?? ctx.profile.dynamicNodeAuthSid ?? "root@builtin";
  const rootSid = ctx.profile.rootUser;
  if (!configHostPath) {
    return planOnly(
      ctx,
      "Prepare auth config requires configHostPath directly or through the selected profile.",
      "medium",
      [],
      ["No changes."],
      ["Provide configHostPath and rerun."]
    );
  }

  const rootPasswordFile = ctx.profile.rootPasswordFile ?? "";
  const target = "/ydb_data/cluster/kikimr_configs/config.yaml";
  const script = [
    "set -euo pipefail",
    `install -d -m 0700 ${shellQuote(dirname(configHostPath))}`,
    rootPasswordFile ? `install -d -m 0700 ${shellQuote(dirname(rootPasswordFile))}` : ":",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT",
    `docker exec ${shellQuote(ctx.profile.staticContainer)} cat ${shellQuote(target)} > \"$tmp\"`,
    [
      "ruby -ryaml -e",
      shellQuote([
        "config = YAML.load_file(ARGV[0])",
        "domains = config.fetch(\"domains_config\")",
        "security = domains[\"security_config\"] ||= {}",
        "allowed_sids = [ARGV[2], ARGV[4]].reject(&:empty?).uniq",
        "security[\"enforce_user_token_requirement\"] = true",
        "security[\"viewer_allowed_sids\"] = allowed_sids",
        "security[\"monitoring_allowed_sids\"] = allowed_sids",
        "security[\"administration_allowed_sids\"] = allowed_sids",
        "security[\"register_dynamic_node_allowed_sids\"] = allowed_sids",
        "File.write(ARGV[1], YAML.dump(config))",
        "File.chmod(0600, ARGV[1])",
        "if !ARGV[3].empty?",
        "  root = Array(security[\"default_users\"]).find { |user| user[\"name\"] == \"root\" }",
        "  raise \"root password not found in security_config.default_users\" unless root && root[\"password\"]",
        "  File.write(ARGV[3], \"#{root[\"password\"]}\\n\")",
        "  File.chmod(0600, ARGV[3])",
        "end"
      ].join("; ")),
      "\"$tmp\"",
      shellQuote(configHostPath),
      shellQuote(sid),
      shellQuote(rootPasswordFile),
      shellQuote(rootSid)
    ].join(" ")
  ].join("\n");

  return runMutating(ctx, {
    summary: `Prepare hardened auth config at ${configHostPath}.`,
    risk: "medium",
    specs: [bash(script)],
    rollback: [
      `rm -f ${configHostPath}`,
      ...(rootPasswordFile ? [`rm -f ${rootPasswordFile}`] : [])
    ],
    verification: [
      `test -s ${configHostPath}`,
      ...(rootPasswordFile ? [`test -s ${rootPasswordFile}`] : [])
    ]
  }, options);
}

export async function writeDynamicNodeAuthConfig(
  ctx: ToolkitContext,
  options: MutatingOptions & { sid?: string; tokenHostPath?: string } = {}
) {
  const sid = options.sid ?? ctx.profile.dynamicNodeAuthSid;
  const tokenHostPath = options.tokenHostPath ?? ctx.profile.dynamicNodeAuthTokenFile;
  if (!sid || !tokenHostPath) {
    return planOnly(
      ctx,
      "Dynamic node auth config requires both sid and tokenHostPath.",
      "medium",
      [],
      ["No changes."],
      ["Provide sid and tokenHostPath directly or through the selected profile."]
    );
  }

  const staffToken = `StaffApiUserToken: "${escapeTextProtoString(sid)}"`;
  const registrationToken = `NodeRegistrationToken: "${escapeTextProtoString(sid)}"`;
  return runMutating(ctx, {
    summary: `Write dynamic-node auth config to ${tokenHostPath}.`,
    risk: "medium",
    specs: [
      bash(
        `install -d -m 0700 ${shellQuote(dirname(tokenHostPath))} && printf '%s\n' ${shellQuote(staffToken)} ${shellQuote(registrationToken)} > ${shellQuote(tokenHostPath)} && chmod 600 ${shellQuote(tokenHostPath)}`
      )
    ],
    rollback: [`rm -f ${tokenHostPath}`],
    verification: [`test -s ${tokenHostPath}`]
  }, options);
}

export async function cleanupStorage(ctx: ToolkitContext, options: MutatingOptions & { paths?: string[]; volumes?: string[] } = {}) {
  const paths = options.paths ?? [];
  const volumes = options.volumes ?? [];
  for (const path of paths) {
    assertSafeCleanupTarget(path);
  }
  for (const volume of volumes) {
    assertSafeCleanupTarget(volume);
  }
  const specs = [
    ...volumes.map((volume) => bash(`docker volume rm ${shellQuote(volume)}`)),
    ...paths.map((path) => bash(`rm -rf ${shellQuote(path)}`))
  ];
  return runMutating(ctx, {
    summary: `Clean ${paths.length} storage paths and ${volumes.length} Docker volumes.`,
    risk: "high",
    specs,
    rollback: ["No automatic rollback after deletion; restore from backups/dumps."],
    verification: ["local_ydb_storage_leftovers no longer reports the removed targets"]
  }, options);
}

async function runMutating(ctx: ToolkitContext, plan: { summary: string; risk: OperationPlan["risk"]; specs: CommandSpec[]; rollback: string[]; verification: string[] }, options: MutatingOptions): Promise<OperationResponse> {
  const plannedCommands = plan.specs.map((spec) => ctx.client.display(spec));
  if (!options.confirm) {
    return {
      summary: `${plan.summary} Not executed because confirm=true was not provided.`,
      executed: false,
      risk: plan.risk,
      plannedCommands,
      rollback: plan.rollback,
      verification: plan.verification
    };
  }
  const results: CommandResult[] = [];
  for (const spec of plan.specs) {
    const result = await ctx.client.run(spec);
    results.push(result);
    if (!result.ok) {
      break;
    }
  }
  return {
    summary: `${plan.summary} Executed ${results.filter((result) => result.ok).length}/${results.length} commands.`,
    executed: true,
    risk: plan.risk,
    plannedCommands,
    rollback: plan.rollback,
    verification: plan.verification,
    results
  };
}

function planOnly(ctx: ToolkitContext, summary: string, risk: OperationPlan["risk"], specs: CommandSpec[], rollback: string[], verification: string[]): OperationResponse {
  return {
    summary,
    executed: false,
    risk,
    plannedCommands: specs.map((spec) => ctx.client.display(spec)),
    rollback,
    verification
  };
}

function publicProfile(profile: ResolvedLocalYdbProfile) {
  return {
    ...profile,
    authConfigPath: profile.authConfigPath ? "<redacted>" : undefined,
    dynamicNodeAuthTokenFile: profile.dynamicNodeAuthTokenFile ? "<redacted>" : undefined,
    rootPasswordFile: profile.rootPasswordFile ? "<redacted>" : undefined,
    ssh: profile.ssh ? { ...profile.ssh, identityFile: profile.ssh.identityFile ? "<redacted>" : undefined } : undefined
  };
}

function commandForStaticRun(profile: ResolvedLocalYdbProfile): string {
  const mount = profile.bindMountPath ? `${profile.bindMountPath}:/ydb_data` : `${profile.volume}:/ydb_data`;
  return [
    "docker", "run", "-d",
    "--name", profile.staticContainer,
    "--no-healthcheck",
    "--network", profile.network,
    "--restart", "unless-stopped",
    "-p", `127.0.0.1:${profile.ports.monitoring}:8765`,
    "-v", mount,
    "-e", `GRPC_PORT=${profile.ports.staticGrpc}`,
    "-e", "MON_PORT=8765",
    "-e", "GRPC_TLS_PORT=",
    "-e", "YDB_GRPC_ENABLE_TLS=0",
    "-e", "YDB_ANONYMOUS_CREDENTIALS=1",
    "-e", "YDB_LOCAL_SURVIVE_RESTART=1",
    "-e", "YDB_FEATURE_FLAGS=enable_graph_shard",
    profile.image
  ].map(shellQuote).join(" ");
}

function commandForDynamicRun(profile: ResolvedLocalYdbProfile): string {
  return commandForDynamicNodeRun(profile, {
    container: profile.dynamicContainer,
    grpcPort: profile.ports.dynamicGrpc,
    monitoringPort: profile.ports.dynamicMonitoring,
    icPort: profile.ports.dynamicIc
  });
}

function commandForDynamicNodeRun(profile: ResolvedLocalYdbProfile, node: Pick<DynamicNodePlan, "container" | "grpcPort" | "monitoringPort" | "icPort">): string {
  const mount = profile.bindMountPath ? `${profile.bindMountPath}:/ydb_data:ro` : `${profile.volume}:/ydb_data:ro`;
  const authMount = profile.dynamicNodeAuthTokenFile ? [`${profile.dynamicNodeAuthTokenFile}:/run/local-ydb/dynamic-node-auth.pb:ro`] : [];
  const authArgs = profile.dynamicNodeAuthTokenFile ? ["--auth-token-file", "/run/local-ydb/dynamic-node-auth.pb"] : [];
  const dynamicArgs = [
    "--tcp",
    ...authArgs,
    "--node-broker", `grpc://127.0.0.1:${profile.ports.staticGrpc}`,
    "--grpc-port", String(node.grpcPort),
    "--mon-port", String(node.monitoringPort),
    "--ic-port", String(node.icPort),
    "--tenant", profile.tenantPath,
    "--node-host", "127.0.0.1",
    "--node-address", "127.0.0.1",
    "--node-resolve-host", "127.0.0.1",
    "--node-domain", "local"
  ].map(shellQuote).join(" ");
  const innerCommand = [
    "set -euo pipefail",
    "cfg=/tmp/local-ydb-dynamic-config.yaml",
    "sed -e '/^  ca: \\/ydb_certs\\/ca\\.pem$/d' -e '/^  cert: \\/ydb_certs\\/cert\\.pem$/d' -e '/^  key: \\/ydb_certs\\/key\\.pem$/d' /ydb_data/cluster/kikimr_configs/config.yaml > \"$cfg\"",
    `exec /ydbd server --yaml-config "$cfg" ${dynamicArgs}`
  ].join("; ");
  return [
    "docker", "run", "-d",
    "--name", node.container,
    "--no-healthcheck",
    "--network", `container:${profile.staticContainer}`,
    "--restart", "unless-stopped",
    "-v", mount,
    "-e", `GRPC_PORT=${node.grpcPort}`,
    "-e", `MON_PORT=${node.monitoringPort}`,
    "-e", "GRPC_TLS_PORT=",
    "-e", "YDB_GRPC_ENABLE_TLS=0",
    ...authMount.flatMap((value) => ["-v", value]),
    "--entrypoint", "/bin/bash",
    profile.image,
    "-lc", innerCommand
  ].map(shellQuote).join(" ");
}

function commandForDynamicEnsureRun(profile: ResolvedLocalYdbProfile, node?: Pick<DynamicNodePlan, "container" | "grpcPort" | "monitoringPort" | "icPort">): string {
  const target = node ?? {
    container: profile.dynamicContainer,
    grpcPort: profile.ports.dynamicGrpc,
    monitoringPort: profile.ports.dynamicMonitoring,
    icPort: profile.ports.dynamicIc
  };
  const container = shellQuote(target.container);
  return [
    `if docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null | grep -qx true; then`,
    "  exit 0",
    "fi",
    `docker rm -f ${container} 2>/dev/null || true`,
    commandForDynamicNodeRun(profile, target)
  ].join("\n");
}

function additionalDynamicNodePlans(profile: ResolvedLocalYdbProfile, options: AddDynamicNodesOptions): DynamicNodePlan[] {
  const count = options.count ?? 1;
  const startIndex = options.startIndex ?? 2;
  assertPositiveInteger("count", count);
  assertPositiveInteger("startIndex", startIndex);
  if (count > 10) {
    throw new Error("count must be 10 or less");
  }
  if (startIndex < 2) {
    throw new Error("startIndex must be 2 or greater to avoid the profile dynamicContainer");
  }

  const grpcPortStart = options.grpcPortStart ?? profile.ports.dynamicGrpc + startIndex - 1;
  const monitoringPortStart = options.monitoringPortStart ?? profile.ports.dynamicMonitoring + startIndex - 1;
  const icPortStart = options.icPortStart ?? profile.ports.dynamicIc + startIndex - 1;
  [grpcPortStart, monitoringPortStart, icPortStart].forEach((port) => assertPort(port));

  const plans = Array.from({ length: count }, (_, offset) => ({
    container: `${profile.dynamicContainer}-${startIndex + offset}`,
    index: startIndex + offset,
    grpcPort: grpcPortStart + offset,
    monitoringPort: monitoringPortStart + offset,
    icPort: icPortStart + offset
  }));
  plans.forEach((plan) => {
    [plan.grpcPort, plan.monitoringPort, plan.icPort].forEach((port) => assertPort(port));
  });
  return plans;
}

async function removableDynamicNodeTargets(ctx: ToolkitContext, options: RemoveDynamicNodesOptions): Promise<DynamicNodeTarget[]> {
  const startIndex = options.startIndex ?? 2;
  if (startIndex < 2) {
    throw new Error("startIndex must be 2 or greater to avoid the profile dynamicContainer");
  }

  const containers = await ctx.client.dockerPs();
  const available = containers
    .map((container) => extraDynamicNodeTarget(ctx.profile, container.names))
    .filter((target): target is DynamicNodeTarget => Boolean(target))
    .filter((target) => target.index >= startIndex);

  let targets: DynamicNodeTarget[];
  if (options.containers && options.containers.length > 0) {
    const requested = new Set(options.containers);
    targets = available.filter((target) => requested.has(target.container));
    if (targets.length !== requested.size) {
      const resolved = new Set(targets.map((target) => target.container));
      const missing = Array.from(requested).filter((container) => !resolved.has(container));
      throw new Error(`Requested dynamic-node containers were not found or were not removable extras: ${missing.join(", ")}`);
    }
  } else {
    const count = options.count ?? 1;
    assertPositiveInteger("count", count);
    if (count > 10) {
      throw new Error("count must be 10 or less");
    }
    targets = available
      .sort((left, right) => right.index - left.index)
      .slice(0, count);
    if (targets.length < count) {
      throw new Error(`Requested ${count} removable dynamic nodes but found ${targets.length}`);
    }
  }

  const inspectByContainer = await inspectDynamicNodeTargets(ctx, targets.map((target) => target.container));
  return targets
    .sort((left, right) => right.index - left.index)
    .map((target) => ({
      ...target,
      icPort: inspectByContainer.get(target.container)?.icPort ?? target.icPort
    }));
}

function extraDynamicNodeTarget(profile: ResolvedLocalYdbProfile, name?: string): DynamicNodeTarget | undefined {
  if (!name) {
    return undefined;
  }
  const match = new RegExp(`^${escapeRegExp(profile.dynamicContainer)}-(\\d+)$`).exec(name);
  if (!match) {
    return undefined;
  }
  return {
    container: name,
    index: Number(match[1])
  };
}

function findExtraDynamicContainers(profile: ResolvedLocalYdbProfile, names: Array<string | undefined>): string[] {
  return names
    .map((name) => extraDynamicNodeTarget(profile, name))
    .filter((target): target is DynamicNodeTarget => Boolean(target))
    .sort((left, right) => right.index - left.index)
    .map((target) => target.container);
}

async function inspectDynamicNodeTargets(ctx: ToolkitContext, containers: string[]): Promise<Map<string, { icPort?: number }>> {
  const inspect = await ctx.client.dockerInspect(containers);
  const byContainer = new Map<string, { icPort?: number }>();
  for (const item of inspect) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const name = typeof obj.Name === "string" ? obj.Name.replace(/^\//, "") : undefined;
    if (!name) {
      continue;
    }
    byContainer.set(name, {
      icPort: readCommandPort(obj, "--ic-port")
    });
  }
  return byContainer;
}

function readCommandPort(value: Record<string, unknown>, flag: string): number | undefined {
  const args = Array.isArray(value.Args) ? value.Args : [];
  const fromArgs = readPortFromArgs(args, flag);
  if (typeof fromArgs === "number") {
    return fromArgs;
  }
  const config = value.Config;
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const cmd = Array.isArray((config as Record<string, unknown>).Cmd) ? (config as Record<string, unknown>).Cmd as unknown[] : [];
  return readPortFromArgs(cmd, flag);
}

function readPortFromArgs(args: unknown[], flag: string): number | undefined {
  const strings = args.filter((arg): arg is string => typeof arg === "string");
  for (let index = 0; index < strings.length; index += 1) {
    if (strings[index] === flag) {
      const port = Number(strings[index + 1]);
      return Number.isFinite(port) ? port : undefined;
    }
  }
  const joined = strings.join(" ");
  const match = new RegExp(`${escapeRegExp(flag)}\\s+(\\d+)`).exec(joined);
  return match ? Number(match[1]) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readTargetStoragePool(ctx: ToolkitContext, poolName?: string): Promise<ResolvedStoragePoolSummary> {
  const result = await ctx.client.run(ydbdAdmin(ctx.profile, [
    "admin", "blobstorage", "config", "invoke",
    "--proto", "Command { ReadStoragePool { BoxId: 1 } }"
  ], "Read storage pool config"));
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "ReadStoragePool failed");
  }

  const targetName = poolName ?? `${ctx.profile.tenantPath}:${ctx.profile.storagePoolKind}`;
  const pools = parseReadStoragePools(result.stdout);
  const matches = pools.filter((pool) => pool.name === targetName);
  if (matches.length === 0) {
    throw new Error(`Storage pool not found: ${targetName}`);
  }
  if (matches.length > 1) {
    throw new Error(`Storage pool name is ambiguous: ${targetName}`);
  }
  const pool = matches[0];
  if (!pool.rawBlock || typeof pool.boxId !== "number" || typeof pool.storagePoolId !== "number" || typeof pool.name !== "string" || typeof pool.numGroups !== "number") {
    throw new Error(`Storage pool ${targetName} is missing required fields in ReadStoragePool output`);
  }
  return {
    rawBlock: pool.rawBlock,
    boxId: pool.boxId,
    storagePoolId: pool.storagePoolId,
    name: pool.name,
    numGroups: pool.numGroups,
    itemConfigGeneration: pool.itemConfigGeneration
  };
}

function buildDefineStoragePoolRequest(pool: Pick<ResolvedStoragePoolSummary, "rawBlock" | "name" | "numGroups" | "itemConfigGeneration">, targetNumGroups: number): string {
  if (!/\bNumGroups:\s*\d+/.test(pool.rawBlock)) {
    throw new Error(`Storage pool ${pool.name} does not expose NumGroups in ReadStoragePool output`);
  }
  const defineStoragePool = pool.rawBlock
    .replace(/^StoragePool\b/, "DefineStoragePool")
    .replace(/\bNumGroups:\s*\d+/, `NumGroups: ${targetNumGroups}`);
  return `Command { ${defineStoragePool} } Command { QueryBaseConfig { RetrieveDevices: true SuppressNodes: true } }`;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertPort(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Port must be an integer between 1 and 65535: ${value}`);
  }
}

async function waitForDynamicNodePort(ctx: ToolkitContext, plan: DynamicNodePlan): Promise<DynamicNodeCheck> {
  let observedPorts: number[] = [];
  let error: string | undefined;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const check = await nodesCheck(ctx);
    observedPorts = observedNodePorts(check.nodes);
    error = check.error;
    if (observedPorts.includes(plan.icPort)) {
      return { container: plan.container, icPort: plan.icPort, ok: true, attempts: attempt, observedPorts };
    }
    if (attempt < 5) {
      await delay(2_000);
    }
  }
  return { container: plan.container, icPort: plan.icPort, ok: false, attempts: 5, observedPorts, error };
}

async function waitForDynamicNodePortAbsence(ctx: ToolkitContext, target: DynamicNodeTarget & { icPort: number }): Promise<DynamicNodeCheck> {
  let observedPorts: number[] = [];
  let error: string | undefined;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const check = await nodesCheck(ctx);
    observedPorts = observedNodePorts(check.nodes);
    error = check.error;
    if (!observedPorts.includes(target.icPort)) {
      return { container: target.container, icPort: target.icPort, ok: true, attempts: attempt, observedPorts };
    }
    if (attempt < 5) {
      await delay(2_000);
    }
  }
  return { container: target.container, icPort: target.icPort, ok: false, attempts: 5, observedPorts, error };
}

function observedNodePorts(nodes: unknown[]): number[] {
  return nodes
    .map((node) => node && typeof node === "object" ? (node as Record<string, unknown>).Port : undefined)
    .filter((port): port is number => typeof port === "number")
    .sort((a, b) => a - b);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addDynamicNodesResponse(
  ctx: ToolkitContext,
  plans: DynamicNodePlan[],
  nodeChecks: DynamicNodeCheck[],
  results: CommandResult[],
  rollback: string[],
  verification: string[],
  completedNodes: number
): AddDynamicNodesResponse {
  return {
    summary: `Add ${plans.length} dynamic node${plans.length === 1 ? "" : "s"} to ${ctx.profile.tenantPath}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands; verified ${completedNodes}/${plans.length} nodes.`,
    executed: true,
    risk: "high",
    plannedCommands: plans.flatMap((plan) => dynamicNodeStartSpecs(ctx.profile, plan).map((spec) => ctx.client.display(spec))),
    rollback,
    verification,
    results,
    nodes: plans,
    nodeChecks
  };
}

function removeDynamicNodesResponse(
  ctx: ToolkitContext,
  targets: DynamicNodeTarget[],
  nodeChecks: DynamicNodeCheck[],
  results: CommandResult[],
  rollback: string[],
  verification: string[],
  completedNodes: number
): RemoveDynamicNodesResponse {
  return {
    summary: `Remove ${targets.length} dynamic node${targets.length === 1 ? "" : "s"} from ${ctx.profile.tenantPath}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands; verified ${completedNodes}/${targets.length} nodes.`,
    executed: true,
    risk: "high",
    plannedCommands: targets.map((target) => ctx.client.display(bash(`docker rm -f ${shellQuote(target.container)}`, {
      timeoutMs: 60_000,
      description: `Remove dynamic tenant node ${target.container}`
    }))),
    rollback,
    verification,
    results,
    nodes: targets,
    nodeChecks
  };
}

function addStorageGroupsResponse(
  ctx: ToolkitContext,
  pool: ResolvedStoragePoolSummary,
  targetNumGroups: number,
  observedNumGroups: number | undefined,
  results: CommandResult[],
  rollback: string[],
  verification: string[]
): AddStorageGroupsResponse {
  return {
    summary: `Add storage groups to ${pool.name}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands.`,
    executed: true,
    risk: "high",
    plannedCommands: [
      ctx.client.display(ydbdAdmin(ctx.profile, [
        "admin", "blobstorage", "config", "invoke",
        "--proto", buildDefineStoragePoolRequest(pool, targetNumGroups)
      ], `Increase storage groups for ${pool.name}`))
    ],
    rollback,
    verification,
    results,
    pool: {
      name: pool.name,
      boxId: pool.boxId,
      storagePoolId: pool.storagePoolId,
      numGroups: pool.numGroups,
      targetNumGroups,
      itemConfigGeneration: pool.itemConfigGeneration
    },
    observedNumGroups
  };
}

function dynamicNodeStartSpecs(profile: ResolvedLocalYdbProfile, plan: DynamicNodePlan): CommandSpec[] {
  return [
    bash(commandForDynamicEnsureRun(profile, plan), {
      timeoutMs: 60_000,
      description: `Start dynamic tenant node ${plan.container}`
    }),
    bash("sleep 5", { description: `Wait briefly for ${plan.container} startup` })
  ];
}

function removeTenantIfPresentSpec(profile: ResolvedLocalYdbProfile): CommandSpec {
  const removeCommand = dockerExecYdbd(profile, ["admin", "database", profile.tenantPath, "remove", "--force"]);
  return bash([
    "set -euo pipefail",
    `if ! docker inspect -f '{{.State.Running}}' ${shellQuote(profile.staticContainer)} 2>/dev/null | grep -qx true; then`,
    "  exit 0",
    "fi",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT",
    `if ${removeCommand} >"$tmp" 2>&1; then`,
    "  cat \"$tmp\"",
    "  exit 0",
    "elif grep -Eq 'Unknown tenant|NOT_FOUND|not found|Path does not exist' \"$tmp\"; then",
    "  cat \"$tmp\"",
    "  exit 0",
    "else",
    "  cat \"$tmp\" >&2",
    "  exit 1",
    "fi"
  ].join("\n"), {
    timeoutMs: 60_000,
    allowFailure: true,
    description: `Remove tenant ${profile.tenantPath} if present`
  });
}

function createTenantSpec(profile: ResolvedLocalYdbProfile): CommandSpec {
  const statusArgs = ["admin", "database", profile.tenantPath, "status"];
  const createArgs = ["admin", "database", profile.tenantPath, "create", `${profile.storagePoolKind}:${profile.storagePoolCount}`];
  const statusCommand = dockerExecYdbd(profile, statusArgs);
  const createCommand = dockerExecYdbd(profile, createArgs);
  return bash([
    "set -euo pipefail",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT",
    "for attempt in $(seq 1 15); do",
    `  if ${statusCommand} >"$tmp" 2>&1; then`,
    "    cat \"$tmp\"",
    "    exit 0",
    "  elif grep -Eq 'Unknown tenant|NOT_FOUND' \"$tmp\"; then",
    `    ${createCommand} >/dev/null 2>&1 || exit $?`,
    "  else",
    "    cat \"$tmp\" >&2",
    "    exit 1",
    "  fi",
    "  sleep 2",
    "done",
    "cat \"$tmp\" >&2",
    "exit 1"
  ].join("\n"), {
    timeoutMs: 60_000,
    description: "Create CMS tenant if missing"
  });
}

function ydbCli(profile: ResolvedLocalYdbProfile, args: string[], database: string, description: string): CommandSpec {
  if (profile.rootPasswordFile) {
    return passwordPipedDockerExec(profile, `/ydb -e grpc://localhost:${profile.ports.dynamicGrpc} -d ${shellQuote(database)} --user ${shellQuote(profile.rootUser)} --password-file /tmp/root.password ${args.map(shellQuote).join(" ")}`, description);
  }
  return {
    command: "docker",
    args: ["exec", profile.staticContainer, "/ydb", "-e", `grpc://localhost:${profile.ports.dynamicGrpc}`, "-d", database, ...args],
    allowFailure: true,
    description
  };
}

function ydbdAdmin(profile: ResolvedLocalYdbProfile, args: string[], description: string): CommandSpec {
  if (profile.rootPasswordFile) {
    return passwordPipedDockerExec(profile, `/ydbd --server localhost:${profile.ports.staticGrpc} --user ${shellQuote(profile.rootUser)} --password-file /tmp/root.password ${args.map(shellQuote).join(" ")}`, description);
  }
  return {
    command: "docker",
    args: ["exec", profile.staticContainer, "/ydbd", "--server", `localhost:${profile.ports.staticGrpc}`, "--no-password", ...args],
    allowFailure: true,
    description
  };
}

function dockerExecYdbd(profile: ResolvedLocalYdbProfile, args: string[]): string {
  if (profile.rootPasswordFile) {
    return commandForPasswordPipedDockerExec(profile, `/ydbd --server localhost:${profile.ports.staticGrpc} --user ${shellQuote(profile.rootUser)} --password-file /tmp/root.password ${args.map(shellQuote).join(" ")}`);
  }
  return ["docker", "exec", profile.staticContainer, "/ydbd", "--server", `localhost:${profile.ports.staticGrpc}`, "--no-password", ...args].map(shellQuote).join(" ");
}

function passwordPipedDockerExec(profile: ResolvedLocalYdbProfile, innerCommand: string, description: string): CommandSpec {
  return bash(commandForPasswordPipedDockerExec(profile, innerCommand), {
    allowFailure: true,
    description,
    redactions: [profile.rootPasswordFile ?? ""]
  });
}

function commandForPasswordPipedDockerExec(profile: ResolvedLocalYdbProfile, innerCommand: string): string {
  if (!profile.rootPasswordFile) {
    throw new Error("rootPasswordFile is required");
  }
  const script = `umask 077; cat >/tmp/root.password; ${innerCommand}; rc=$?; rm -f /tmp/root.password; exit $rc`;
  return `cat ${shellQuote(profile.rootPasswordFile)} | docker exec -i ${shellQuote(profile.staticContainer)} bash -lc ${shellQuote(script)}`;
}

function helperContainer(profile: ResolvedLocalYdbProfile, innerCommand: string): CommandSpec {
  const passwordMount = profile.rootPasswordFile ? ["-v", `${profile.rootPasswordFile}:/tmp/root.password:ro`] : [];
  return bash([
    [
      "docker", "run", "--rm",
      "--network", `container:${profile.staticContainer}`,
      "-v", `${profile.dumpHostPath}:/dump`,
      ...passwordMount,
      "--entrypoint", "/bin/bash",
      profile.image,
      "-lc",
      innerCommand
    ].map(shellQuote).join(" ")
  ].join("\n"), {
    timeoutMs: 300_000,
    redactions: [profile.rootPasswordFile ?? ""]
  });
}

function ydbAuthArgs(profile: ResolvedLocalYdbProfile): string {
  return profile.rootPasswordFile ? `--user ${shellQuote(profile.rootUser)} --password-file /tmp/root.password` : "";
}

function escapeTextProtoString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function collectGraphShardTabletIds(value: unknown): unknown[] {
  const result: unknown[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") {
      return;
    }
    const obj = item as Record<string, unknown>;
    if (obj.Type === "GraphShard" && "TabletId" in obj) {
      result.push(obj.TabletId);
    }
    Object.values(obj).forEach(visit);
  };
  visit(value);
  return result;
}

function assertSafeCleanupTarget(target: string): void {
  const normalized = target.trim();
  if (!normalized || normalized === "/" || normalized === "/tmp" || normalized === "/var" || normalized === "/var/lib" || normalized === "/var/lib/docker" || normalized === "/var/lib/docker/volumes") {
    throw new Error(`Refusing unsafe cleanup target: ${target}`);
  }
  if (!/(ydb|local|dump)/i.test(normalized)) {
    throw new Error(`Cleanup target must look local-ydb related: ${target}`);
  }
}
