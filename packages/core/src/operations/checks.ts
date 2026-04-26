import { ydbCli, ydbdAdmin } from "./commands.js";
import { collectGraphShardTabletIds, publicProfile, readPath } from "./helpers.js";
import type { ToolkitContext } from "./types.js";

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
