import {
  bash,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  LocalYdbApiClient,
  parseBscPlacement,
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

export async function bootstrap(ctx: ToolkitContext, options: MutatingOptions = {}): Promise<OperationResponse> {
  const specs = [
    bash(`docker network inspect ${shellQuote(ctx.profile.network)} >/dev/null 2>&1 || docker network create ${shellQuote(ctx.profile.network)}`, { description: "Ensure Docker network exists" }),
    ctx.profile.bindMountPath
      ? bash(`mkdir -p ${shellQuote(ctx.profile.bindMountPath)}`, { description: "Ensure bind mount path exists" })
      : bash(`docker volume inspect ${shellQuote(ctx.profile.volume)} >/dev/null 2>&1 || docker volume create ${shellQuote(ctx.profile.volume)}`, { description: "Ensure Docker volume exists" }),
    bash(`docker inspect ${shellQuote(ctx.profile.staticContainer)} >/dev/null 2>&1 || ${commandForStaticRun(ctx.profile)}`, { timeoutMs: 60_000, description: "Start static local-ydb node" }),
    bash("sleep 5", { description: "Wait briefly for static node startup" }),
    createTenantSpec(ctx.profile),
    bash(`docker inspect ${shellQuote(ctx.profile.dynamicContainer)} >/dev/null 2>&1 || ${commandForDynamicRun(ctx.profile)}`, { timeoutMs: 60_000, description: "Start dynamic tenant node" }),
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
    specs: [bash(`docker inspect ${shellQuote(ctx.profile.dynamicContainer)} >/dev/null 2>&1 || ${commandForDynamicRun(ctx.profile)}`, { timeoutMs: 60_000 })],
    rollback: [`docker rm -f ${ctx.profile.dynamicContainer}`],
    verification: ["container is Up", "viewer/json/nodelist includes the dynamic node", `scheme ls ${ctx.profile.tenantPath}`]
  }, options);
}

export async function restartStack(ctx: ToolkitContext, options: MutatingOptions = {}) {
  const specs = [
    bash(`docker stop ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || true`),
    bash(`docker stop ${shellQuote(ctx.profile.staticContainer)} 2>/dev/null || true`),
    bash(`docker start ${shellQuote(ctx.profile.staticContainer)}`),
    bash("sleep 5"),
    bash(`docker start ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || ${commandForDynamicRun(ctx.profile)}`)
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
  const specs = [
    bash(`mkdir -p ${shellQuote(ctx.profile.dumpHostPath)}`),
    helperContainer(ctx.profile, `/ydb -e grpc://localhost:${ctx.profile.ports.dynamicGrpc} -d ${shellQuote(ctx.profile.tenantPath)} ${ydbAuthArgs(ctx.profile)} tools dump -p . -o ${shellQuote(`/dump/${dumpName}/tenant`)}`)
  ];
  return runMutating(ctx, {
    summary: `Dump ${ctx.profile.tenantPath} to ${ctx.profile.dumpHostPath}/${dumpName}.`,
    risk: "medium",
    specs,
    rollback: [`rm -rf ${ctx.profile.dumpHostPath}/${dumpName}`],
    verification: [`test -d ${ctx.profile.dumpHostPath}/${dumpName}/tenant`]
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
  if (!options.configHostPath) {
    return planOnly(ctx, "Auth hardening requires configHostPath for the prepared YDB config.", "high", [], ["No changes."], ["Provide a reviewed configHostPath."]);
  }
  const target = "/ydb_data/cluster/kikimr_configs/config.yaml";
  return runMutating(ctx, {
    summary: `Apply reviewed YDB auth config from ${options.configHostPath}.`,
    risk: "high",
    specs: [
      bash(`docker cp ${shellQuote(options.configHostPath)} ${shellQuote(`${ctx.profile.staticContainer}:/tmp/local-ydb-toolkit-config.yaml`)}`),
      ctx.client.dockerExec(ctx.profile.staticContainer, ["cp", target, `${target}.before-local-ydb-toolkit-auth`]),
      ctx.client.dockerExec(ctx.profile.staticContainer, ["cp", "/tmp/local-ydb-toolkit-config.yaml", target]),
      bash(`docker restart ${shellQuote(ctx.profile.staticContainer)}`),
      bash(`docker restart ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || true`)
    ],
    rollback: [
      `docker exec ${ctx.profile.staticContainer} cp ${target}.before-local-ydb-toolkit-auth ${target}`,
      `docker restart ${ctx.profile.staticContainer}`
    ],
    verification: ["anonymous viewer/json returns 401", "authenticated tenant checks pass", "dynamic node reaches nodelist"]
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
  const mount = profile.bindMountPath ? `${profile.bindMountPath}:/ydb_data:ro` : `${profile.volume}:/ydb_data:ro`;
  return [
    "docker", "run", "-d",
    "--name", profile.dynamicContainer,
    "--no-healthcheck",
    "--network", `container:${profile.staticContainer}`,
    "--restart", "unless-stopped",
    "-v", mount,
    "--entrypoint", "/ydbd",
    profile.image,
    "server",
    "--yaml-config", "/ydb_data/cluster/kikimr_configs/config.yaml",
    "--tcp",
    "--node-broker", `grpc://127.0.0.1:${profile.ports.staticGrpc}`,
    "--grpc-port", String(profile.ports.dynamicGrpc),
    "--mon-port", String(profile.ports.dynamicMonitoring),
    "--ic-port", String(profile.ports.dynamicIc),
    "--tenant", profile.tenantPath,
    "--node-host", "127.0.0.1",
    "--node-address", "127.0.0.1",
    "--node-resolve-host", "127.0.0.1",
    "--node-domain", "local"
  ].map(shellQuote).join(" ");
}

function createTenantSpec(profile: ResolvedLocalYdbProfile): CommandSpec {
  const statusArgs = ["admin", "database", profile.tenantPath, "status"];
  const createArgs = ["admin", "database", profile.tenantPath, "create", `${profile.storagePoolKind}:${profile.storagePoolCount}`];
  return bash(`${dockerExecYdbd(profile, statusArgs)} >/dev/null 2>&1 || ${dockerExecYdbd(profile, createArgs)}`, {
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
