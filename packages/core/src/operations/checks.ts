import { waitForYdbCli, ydbCli, ydbdAdmin, ydbRootCli } from "./commands.js";
import { collectGraphShardTabletIds, publicProfile, readPath } from "./helpers.js";
import { capText, normalizeMaxOutputBytes } from "./output.js";
import type { HealthcheckOptions, HealthcheckResponse, ToolkitContext } from "./types.js";

const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 120_000;
const MAX_HEALTHCHECK_TIMEOUT_MS = 600_000;
const HEALTHCHECK_PROCESS_TIMEOUT_GRACE_MS = 5_000;
const DEFAULT_MAX_HEALTHCHECK_ISSUES = 100;

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
  const health = await healthcheck(ctx);
  return {
    summary: `Status report for ${ctx.profile.name}: tenant=${tenant.ok ? "ok" : "not-ok"}, nodes=${nodes.ok ? "ok" : "not-ok"}, health=${health.selfCheckResult ?? "unavailable"}.`,
    inventory: inv,
    auth: authStatus,
    tenant,
    nodes,
    healthcheck: health
  };
}

export async function tenantCheck(ctx: ToolkitContext) {
  const result = await ctx.client.run(waitForYdbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Check tenant metadata"));
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

export async function healthcheck(
  ctx: ToolkitContext,
  options: HealthcheckOptions = {}
): Promise<HealthcheckResponse> {
  const databasePath = normalizeHealthcheckDatabasePath(ctx, options.databasePath);
  const timeoutMs = normalizeHealthcheckTimeoutMs(options.timeoutMs);
  const maxOutputBytes = normalizeMaxOutputBytes(options.maxOutputBytes);
  const maxIssues = normalizeMaxIssues(options.maxIssues);
  const args = [
    "monitoring",
    "healthcheck",
    "--format",
    "json",
    "--timeout",
    String(timeoutMs),
    ...(options.noCache ? ["--no-cache"] : []),
    ...(options.noMerge ? ["--no-merge"] : []),
  ];
  const commandSpec = databasePath === ctx.profile.rootDatabase
    ? ydbRootCli(ctx.profile, args, "Run YDB healthcheck")
    : ydbCli(ctx.profile, args, databasePath, "Run YDB healthcheck");
  const result = await ctx.client.run({
    ...commandSpec,
    timeoutMs: Math.max(commandSpec.timeoutMs ?? 0, timeoutMs + HEALTHCHECK_PROCESS_TIMEOUT_GRACE_MS),
  });
  const stdout = capText(result.stdout, maxOutputBytes);
  const stderr = capText(result.stderr, maxOutputBytes);
  const base = {
    command: result.command,
    databasePath,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    maxOutputBytes,
    maxIssues,
  };

  if (!result.ok) {
    return {
      ...base,
      summary: `YDB healthcheck for ${databasePath} failed.`,
      ok: false,
      commandOk: false,
      healthy: false,
      issueCount: 0,
      issueStatusCounts: {},
      issueTypes: [],
      issues: [],
      issuesTruncated: false,
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch (error) {
    return {
      ...base,
      summary: `YDB healthcheck for ${databasePath} returned invalid JSON.`,
      ok: false,
      commandOk: true,
      healthy: false,
      issueCount: 0,
      issueStatusCounts: {},
      issueTypes: [],
      issues: [],
      issuesTruncated: false,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }

  const selfCheckResult = readStringField(data, "self_check_result", "selfCheckResult");
  const issueLog = readIssueLog(data);
  const issues = issueLog.slice(0, maxIssues);
  const issuesTruncated = issueLog.length > issues.length;
  const healthy = selfCheckResult === "GOOD";
  return {
    ...base,
    summary: healthy
      ? `YDB healthcheck for ${databasePath} returned GOOD.`
      : `YDB healthcheck for ${databasePath} returned ${selfCheckResult ?? "unknown"} with ${issueLog.length} issue(s).`,
    ok: true,
    commandOk: true,
    healthy,
    selfCheckResult,
    issueCount: issueLog.length,
    issueStatusCounts: issueStatusCounts(issueLog),
    issueTypes: issueTypes(issueLog),
    issues,
    issuesTruncated,
  };
}

function normalizeHealthcheckDatabasePath(ctx: ToolkitContext, path: string | undefined): string {
  const databasePath = path === undefined ? ctx.profile.tenantPath : path.trim();
  if (!databasePath) {
    throw new Error("databasePath must be non-empty");
  }
  if (databasePath !== ctx.profile.tenantPath && databasePath !== ctx.profile.rootDatabase) {
    throw new Error(`databasePath must be exactly ${ctx.profile.tenantPath} or ${ctx.profile.rootDatabase}`);
  }
  return databasePath;
}

function normalizeHealthcheckTimeoutMs(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_HEALTHCHECK_TIMEOUT_MS;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_HEALTHCHECK_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be a positive integer no greater than ${MAX_HEALTHCHECK_TIMEOUT_MS}`);
  }
  return value;
}

function normalizeMaxIssues(maxIssues: number | undefined): number {
  const value = maxIssues ?? DEFAULT_MAX_HEALTHCHECK_ISSUES;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxIssues must be a positive integer");
  }
  return value;
}

function readIssueLog(data: unknown): unknown[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
  const issueLog = record.issue_log ?? record.issueLog;
  return Array.isArray(issueLog) ? issueLog : [];
}

function readStringField(data: unknown, ...names: string[]): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function issueStatusCounts(issues: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    const status = readStringField(issue, "status");
    if (status) {
      counts[status] = (counts[status] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function issueTypes(issues: unknown[]): string[] {
  return Array.from(new Set(issues
    .map((issue) => readStringField(issue, "type"))
    .filter((value): value is string => Boolean(value))))
    .sort((left, right) => left.localeCompare(right));
}

export async function nodesCheck(ctx: ToolkitContext) {
  const database = encodeURIComponent(ctx.profile.tenantPath);
  const authenticated = Boolean(ctx.profile.rootPasswordFile);
  const response = await ctx.client.viewerGet(`/viewer/json/nodelist?database=${database}&enums=true&type=any`, authenticated);
  const tenantInfo = await ctx.client.viewerGet(`/viewer/json/tenantinfo?database=${database}&path=${database}&tablets=false&storage=false&memory=false`, authenticated);
  const hasNodeArray = response.status === "ok" && Array.isArray(response.data);
  const nodes: unknown[] = hasNodeArray ? response.data as unknown[] : [];
  const tenantNodes = readTenantNodes(tenantInfo.data);
  const tenantInfoConfirmsNodes = tenantNodes.aliveNodes > 0;
  const nodelistConfirmsNodes = hasNodeArray && nodes.length > 0;
  const invalidResponseMessage = response.status === "ok" && !Array.isArray(response.data)
    ? "Expected viewer nodelist response to be an array."
    : undefined;
  const emptyNodesError = hasNodeArray && nodes.length === 0 && !tenantInfoConfirmsNodes
    ? "Viewer nodelist returned no nodes; dynamic node registration was not confirmed."
    : undefined;
  const tenantInfoError = tenantInfo.status === "error"
    ? tenantInfo.error
    : !tenantNodes.found
      ? "Expected viewer tenantinfo response to contain TenantInfo."
      : undefined;
  const responseError = response.status === "error" && !tenantInfoConfirmsNodes ? response.error : undefined;
  const nodelistWarning = hasNodeArray && nodes.length === 0 && tenantInfoConfirmsNodes
    ? "Viewer nodelist returned no nodes; tenantinfo confirmed alive tenant nodes."
    : undefined;
  const warning = nodelistWarning
    ?? (response.status === "error" && tenantInfoConfirmsNodes ? response.error : undefined)
    ?? (tenantInfoError && nodelistConfirmsNodes ? tenantInfoError : undefined)
    ?? (invalidResponseMessage && tenantInfoConfirmsNodes ? invalidResponseMessage : undefined);
  return {
    summary: nodelistConfirmsNodes
      ? `Viewer returned ${nodes.length} nodes.`
      : tenantInfoConfirmsNodes
        ? `Tenant ${ctx.profile.tenantPath} reports ${tenantNodes.aliveNodes} alive node${tenantNodes.aliveNodes === 1 ? "" : "s"}; viewer nodelist returned ${nodes.length} nodes.`
        : response.status === "ok"
          ? hasNodeArray
            ? `Viewer returned ${nodes.length} nodes.`
            : "Viewer node-list check returned a non-array response."
          : "Viewer node-list check failed.",
    ok: nodelistConfirmsNodes || tenantInfoConfirmsNodes,
    nodes,
    tenantAliveNodes: tenantNodes.aliveNodes,
    tenantNodeIds: tenantNodes.nodeIds,
    warning,
    error: responseError ?? emptyNodesError ?? (tenantInfoConfirmsNodes ? undefined : invalidResponseMessage) ?? (nodelistConfirmsNodes ? undefined : tenantInfoError)
  };
}

function readTenantNodes(data: unknown): { found: boolean; aliveNodes: number; nodeIds: number[] } {
  const tenantInfo = readPath(data, ["TenantInfo"]);
  if (!Array.isArray(tenantInfo) || tenantInfo.length === 0) {
    return { found: false, aliveNodes: 0, nodeIds: [] };
  }
  const tenant = tenantInfo[0];
  if (!tenant || typeof tenant !== "object") {
    return { found: false, aliveNodes: 0, nodeIds: [] };
  }
  const obj = tenant as Record<string, unknown>;
  const aliveNodes = toNumber(obj.AliveNodes) ?? 0;
  const nodeIds = Array.isArray(obj.NodeIds)
    ? obj.NodeIds.map(toNumber).filter((value): value is number => typeof value === "number")
    : [];
  return { found: true, aliveNodes, nodeIds };
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
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
