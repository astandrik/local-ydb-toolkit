import { bash, shellQuote, type CommandResult } from "../api-client.js";
import type { ResolvedLocalYdbProfile } from "../validation.js";
import { nodesCheck } from "./checks.js";
import { dynamicNodeStartSpecs, ydbCli } from "./commands.js";
import {
  assertPort,
  assertPositiveInteger,
  delay,
  escapeRegExp,
  extraDynamicNodeTarget,
  observedNodePorts
} from "./helpers.js";
import type {
  AddDynamicNodesOptions,
  AddDynamicNodesResponse,
  DynamicNodeCheck,
  DynamicNodePlan,
  DynamicNodeTarget,
  RemoveDynamicNodesOptions,
  RemoveDynamicNodesResponse,
  ToolkitContext
} from "./types.js";

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
  if (options.nodeIds && options.nodeIds.length > 0 && options.containers && options.containers.length > 0) {
    throw new Error("Specify either nodeIds or containers, not both");
  }
  if (options.nodeIds && options.nodeIds.length > 0 && options.count !== undefined) {
    throw new Error("count cannot be used with nodeIds");
  }

  const containers = await ctx.client.dockerPs();
  const available = containers
    .map((container) => extraDynamicNodeTarget(ctx.profile, container.names))
    .filter((target): target is DynamicNodeTarget => Boolean(target))
    .filter((target) => target.index >= startIndex);

  let targets: DynamicNodeTarget[];
  if (options.nodeIds && options.nodeIds.length > 0) {
    const requestedNodeIds = validateNodeIds(options.nodeIds);
    const inspectByContainer = await inspectDynamicNodeTargets(ctx, available.map((target) => target.container));
    targets = await targetsForNodeIds(ctx, available, inspectByContainer, requestedNodeIds);
    return targets.sort((left, right) => right.index - left.index);
  } else if (options.containers && options.containers.length > 0) {
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

function validateNodeIds(nodeIds: number[]): number[] {
  if (nodeIds.length > 10) {
    throw new Error("nodeIds must contain 10 IDs or less");
  }
  const unique = new Set<number>();
  for (const nodeId of nodeIds) {
    assertPositiveInteger("nodeIds", nodeId);
    unique.add(nodeId);
  }
  if (unique.size !== nodeIds.length) {
    throw new Error("nodeIds must be unique");
  }
  return nodeIds;
}

async function targetsForNodeIds(
  ctx: ToolkitContext,
  available: DynamicNodeTarget[],
  inspectByContainer: Map<string, { icPort?: number }>,
  requestedNodeIds: number[]
): Promise<DynamicNodeTarget[]> {
  const check = await nodesCheck(ctx);
  if (!check.ok) {
    throw new Error(`Could not read dynamic nodes from viewer/json/nodelist: ${check.error ?? "unknown error"}`);
  }

  const portByNodeId = new Map<number, number>();
  for (const node of check.nodes) {
    const parsed = readNodeIdAndPort(node);
    if (parsed) {
      portByNodeId.set(parsed.nodeId, parsed.icPort);
    }
  }

  const targetsByPort = new Map<number, DynamicNodeTarget>();
  for (const target of available) {
    const icPort = inspectByContainer.get(target.container)?.icPort;
    if (typeof icPort === "number") {
      targetsByPort.set(icPort, { ...target, icPort });
    }
  }

  const targets: DynamicNodeTarget[] = [];
  const missing: string[] = [];
  for (const nodeId of requestedNodeIds) {
    const icPort = portByNodeId.get(nodeId);
    if (typeof icPort !== "number") {
      missing.push(`${nodeId} (not found in nodelist)`);
      continue;
    }
    const target = targetsByPort.get(icPort);
    if (!target) {
      missing.push(`${nodeId} (port ${icPort} is not a removable extra dynamic node)`);
      continue;
    }
    targets.push({ ...target, nodeId });
  }

  if (missing.length > 0) {
    throw new Error(`Requested dynamic-node IDs were not found or were not removable extras: ${missing.join(", ")}`);
  }
  return targets;
}

function readNodeIdAndPort(node: unknown): { nodeId: number; icPort: number } | undefined {
  if (!node || typeof node !== "object") {
    return undefined;
  }
  const obj = node as Record<string, unknown>;
  const nodeId = obj.Id;
  const icPort = obj.Port;
  if (typeof nodeId !== "number" || typeof icPort !== "number") {
    return undefined;
  }
  return { nodeId, icPort };
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
