import type { CommandResult, DockerContainerSummary } from "../api-client.js";
import { waitForYdbCli, ydbCli, ydbdAdmin, ydbRootCli } from "./commands.js";
import { probeDockerRuntime } from "./docker-runtime.js";
import { collectGraphShardTabletIds, publicProfile, readPath } from "./helpers.js";
import { capText, normalizeMaxOutputBytes } from "./output.js";
import type {
  HealthcheckOption,
  HealthcheckOptions,
  HealthcheckResponse,
  ToolkitContext,
} from "./types.js";

const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 120_000;
const MAX_HEALTHCHECK_TIMEOUT_MS = 600_000;
const HEALTHCHECK_PROCESS_TIMEOUT_GRACE_MS = 5_000;
const DEFAULT_MAX_HEALTHCHECK_ISSUES = 100;
const HEALTHCHECK_COMPATIBILITY_HELP = "Try 'healthcheck --help' for more information.";
const HEALTHCHECK_COMPATIBILITY_SUMMARY = "Compatibility fallback applied; inspect warnings.";
const HEALTHCHECK_OPTION_FLAGS: Record<HealthcheckOption, "--no-cache" | "--no-merge"> = {
  noCache: "--no-cache",
  noMerge: "--no-merge",
};
const HEALTHCHECK_OPTION_WARNINGS: Record<HealthcheckOption, string> = {
  noCache: "The requested noCache option is unsupported by this YDB CLI; cache bypass was not guaranteed.",
  noMerge: "The requested noMerge option is unsupported by this YDB CLI; healthcheck issue entries may have been merged.",
};

export type InventoryFailureReason =
  | "docker-cli-missing"
  | "docker-daemon-unavailable"
  | "docker-inventory-failed";

type PublicProfile = ReturnType<typeof publicProfile>;

interface InventoryBase {
  summary: string;
  profile: PublicProfile;
  docker: {
    cliAvailable: boolean;
    daemonReachable: boolean;
  };
}

export interface InventorySuccess extends InventoryBase {
  ok: true;
  containers: DockerContainerSummary[];
  volumes: string[];
  inspect: unknown[];
}

export interface InventoryFailure extends InventoryBase {
  ok: false;
  reason: InventoryFailureReason;
}

export type InventoryResponse = InventorySuccess | InventoryFailure;

export async function inventory(ctx: ToolkitContext): Promise<InventoryResponse> {
  const probe = await probeDockerRuntime(ctx);
  const docker = {
    cliAvailable: probe.cliAvailable,
    daemonReachable: probe.daemonReachable
  };
  if (probe.status === "cli-missing") {
    return {
      summary: `Docker inventory is unavailable for profile ${ctx.profile.name}: ${probe.detail}`,
      ok: false,
      profile: publicProfile(ctx.profile),
      docker,
      reason: "docker-cli-missing"
    };
  }
  if (probe.status === "daemon-unavailable") {
    return {
      summary: `Docker inventory is unavailable for profile ${ctx.profile.name}: ${probe.detail}`,
      ok: false,
      profile: publicProfile(ctx.profile),
      docker,
      reason: "docker-daemon-unavailable"
    };
  }
  if (probe.status === "target-unreachable" || probe.status === "probe-failed") {
    return {
      summary: `Docker inventory is unavailable for profile ${ctx.profile.name}: ${probe.detail}`,
      ok: false,
      profile: publicProfile(ctx.profile),
      docker,
      reason: "docker-inventory-failed"
    };
  }

  try {
    const containers = await ctx.client.dockerPs();
    const volumes = await ctx.client.dockerVolumes();
    const existingContainerNames = new Set(containers.map((container) => container.names));
    const inspectNames = [ctx.profile.staticContainer, ctx.profile.dynamicContainer]
      .filter((name) => existingContainerNames.has(name));
    const inspect = await ctx.client.dockerInspect(inspectNames);
    return {
      summary: `Found ${containers.length} Docker containers and ${volumes.length} Docker volumes for profile ${ctx.profile.name}.`,
      ok: true,
      profile: publicProfile(ctx.profile),
      docker,
      containers,
      volumes,
      inspect
    };
  } catch {
    return {
      summary: `Docker inventory failed for profile ${ctx.profile.name} after the Docker daemon became reachable.`,
      ok: false,
      profile: publicProfile(ctx.profile),
      docker,
      reason: "docker-inventory-failed"
    };
  }
}

export async function requireInventory(ctx: ToolkitContext): Promise<InventorySuccess> {
  const result = await inventory(ctx);
  if (!result.ok) {
    throw new Error(result.summary);
  }
  return result;
}

export async function statusReport(ctx: ToolkitContext) {
  const inv = await safeStatusComponent(
    () => inventory(ctx),
    () => inventoryFallback(ctx)
  );
  const authStatus = await safeStatusComponent(
    () => authCheck(ctx),
    authFallback
  );
  const tenant = await safeStatusComponent(
    () => tenantCheck(ctx),
    tenantFallback
  );
  const nodes = await safeStatusComponent(
    () => nodesCheck(ctx),
    nodesFallback
  );
  const health = await safeStatusComponent(
    () => healthcheck(ctx),
    () => healthcheckFallback(ctx)
  );
  return {
    summary: `Status report for ${ctx.profile.name}: docker=${inv.ok ? "ok" : "unavailable"}, tenant=${tenant.ok ? "ok" : "not-ok"}, nodes=${nodes.ok ? "ok" : "not-ok"}, health=${health.selfCheckResult ?? "unavailable"}.`,
    inventory: inv,
    auth: authStatus,
    tenant,
    nodes,
    healthcheck: health
  };
}

async function safeStatusComponent<T>(run: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback();
  }
}

function inventoryFallback(ctx: ToolkitContext): InventoryFailure {
  return {
    summary: `Docker inventory could not be determined for profile ${ctx.profile.name}.`,
    ok: false,
    profile: publicProfile(ctx.profile),
    docker: {
      cliAvailable: false,
      daemonReachable: false
    },
    reason: "docker-inventory-failed"
  };
}

function authFallback() {
  return {
    summary: "Auth check is unavailable.",
    viewerWhoamiStatus: null,
    anonymousCliOk: false,
    anonymousCliCommand: "",
    anonymousCliStderr: ""
  };
}

function tenantFallback() {
  return {
    summary: "Tenant check is unavailable.",
    ok: false,
    command: "",
    stdout: "",
    stderr: ""
  };
}

function nodesFallback() {
  return {
    summary: "Node check is unavailable.",
    ok: false,
    nodes: [],
    tenantAliveNodes: 0,
    tenantNodeIds: [],
    warning: undefined,
    error: "Node check could not be executed."
  };
}

function healthcheckFallback(ctx: ToolkitContext): HealthcheckResponse {
  return {
    summary: "YDB healthcheck is unavailable.",
    ok: false,
    commandOk: false,
    healthy: false,
    databasePath: ctx.profile.tenantPath,
    command: "",
    issueCount: 0,
    issueStatusCounts: {},
    issueTypes: [],
    issues: [],
    issuesTruncated: false,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    maxOutputBytes: normalizeMaxOutputBytes(undefined),
    maxIssues: DEFAULT_MAX_HEALTHCHECK_ISSUES,
    optionResolution: {
      requested: [],
      effective: [],
      unsupported: [],
    },
    compatibilityFallback: false,
    warnings: [],
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
  const requested = requestedHealthcheckOptions(options);
  const deadlineMs = Date.now() + timeoutMs + HEALTHCHECK_PROCESS_TIMEOUT_GRACE_MS;
  const execution = await runHealthcheckWithCompatibility(
    ctx,
    databasePath,
    timeoutMs,
    deadlineMs,
    requested,
  );
  const { result, effective, unsupported, compatibilityFallback } = execution;
  const warnings = unsupported.map((option) => HEALTHCHECK_OPTION_WARNINGS[option]);
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
    optionResolution: {
      requested,
      effective,
      unsupported,
    },
    compatibilityFallback,
    warnings,
  };

  if (!result.ok) {
    return {
      ...base,
      summary: compatibilitySummary(`YDB healthcheck for ${databasePath} failed.`, compatibilityFallback),
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
      summary: compatibilitySummary(
        `YDB healthcheck for ${databasePath} returned invalid JSON.`,
        compatibilityFallback,
      ),
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
  const healthSummary = healthy
    ? `YDB healthcheck for ${databasePath} returned GOOD.`
    : `YDB healthcheck for ${databasePath} returned ${selfCheckResult ?? "unknown"} with ${issueLog.length} issue(s).`;
  return {
    ...base,
    summary: compatibilitySummary(healthSummary, compatibilityFallback),
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

async function runHealthcheckWithCompatibility(
  ctx: ToolkitContext,
  databasePath: string,
  timeoutMs: number,
  deadlineMs: number,
  requested: HealthcheckOption[],
): Promise<{
  result: CommandResult;
  effective: HealthcheckOption[];
  unsupported: HealthcheckOption[];
  compatibilityFallback: boolean;
}> {
  let effective = [...requested];
  const unsupported: HealthcheckOption[] = [];
  let compatibilityFallback = false;
  let result: CommandResult | undefined;

  for (let attempt = 0; attempt <= requested.length; attempt += 1) {
    if (attempt > 0) {
      if (Date.now() >= deadlineMs) {
        break;
      }
      compatibilityFallback = true;
    }
    const args = healthcheckArgs(timeoutMs, effective);
    const commandSpec = databasePath === ctx.profile.rootDatabase
      ? ydbRootCli(ctx.profile, args, "Run YDB healthcheck")
      : ydbCli(ctx.profile, args, databasePath, "Run YDB healthcheck");
    result = await ctx.client.run({
      ...commandSpec,
      timeoutMs: Math.max(1, deadlineMs - Date.now()),
    });

    const unsupportedOption = unsupportedHealthcheckOption(result, args, effective);
    if (unsupportedOption === undefined) {
      break;
    }
    effective = effective.filter((option) => option !== unsupportedOption);
    unsupported.push(unsupportedOption);
    if (attempt === requested.length || Date.now() >= deadlineMs) {
      break;
    }
  }

  if (result === undefined) {
    throw new Error("YDB healthcheck command could not start before its deadline");
  }
  return { result, effective, unsupported, compatibilityFallback };
}

function requestedHealthcheckOptions(options: HealthcheckOptions): HealthcheckOption[] {
  return [
    ...(options.noCache ? ["noCache" as const] : []),
    ...(options.noMerge ? ["noMerge" as const] : []),
  ];
}

function healthcheckArgs(timeoutMs: number, effective: HealthcheckOption[]): string[] {
  return [
    "monitoring",
    "healthcheck",
    "--format",
    "json",
    "--timeout",
    String(timeoutMs),
    ...effective.map((option) => HEALTHCHECK_OPTION_FLAGS[option]),
  ];
}

function unsupportedHealthcheckOption(
  result: CommandResult,
  args: string[],
  effective: HealthcheckOption[],
): HealthcheckOption | undefined {
  if (result.ok || result.timedOut || result.stdout !== "") {
    return undefined;
  }
  const lines = result.stderr.replace(/\r\n/g, "\n").split("\n");
  while (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length !== 2 || lines[1] !== HEALTHCHECK_COMPATIBILITY_HELP) {
    return undefined;
  }
  const match = /^\(NLastGetopt::TUsageException\) unknown option '(no-cache|no-merge)' in '--\1'$/.exec(lines[0] ?? "");
  if (match === null) {
    return undefined;
  }
  const option: HealthcheckOption = match[1] === "no-cache" ? "noCache" : "noMerge";
  const flag = HEALTHCHECK_OPTION_FLAGS[option];
  return effective.includes(option) && args.includes(flag) ? option : undefined;
}

function compatibilitySummary(summary: string, applied: boolean): string {
  return applied ? `${summary} ${HEALTHCHECK_COMPATIBILITY_SUMMARY}` : summary;
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
