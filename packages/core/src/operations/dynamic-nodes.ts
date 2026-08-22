import { bash, shellQuote, type CommandResult, type CommandSpec } from "../api-client.js";
import {
  attachConfirmation,
  authorizeMutation,
  commandPlanIntent,
  confirmationSummarySuffix,
} from "../confirmation.js";
import { nodesCheck, requireInventory } from "./checks.js";
import { commandForStaticCompatibilityCheck, dynamicNodeStartSpecs, waitForYdbCli } from "./commands.js";
import {
  additionalDynamicNodePlans,
  configuredDynamicNodePlans,
  startDynamicNodePlans
} from "./dynamic-node-topology.js";
import { inspectDynamicNodePorts } from "./dynamic-node-inspect.js";
import {
  assertPositiveInteger,
  delay,
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
  const configuredPlans = configuredDynamicNodePlans(ctx.profile);
  const beforeRunSpecs = [
    bash(commandForStaticCompatibilityCheck(ctx.profile, {
      requireGraphShard: true,
      publishedDynamicGrpcPorts: configuredPlans.map((plan) => plan.grpcPort)
    }), { timeoutMs: 60_000, description: "Verify static local-ydb node compatibility before dynamic node start" })
  ];
  const specs = plans.flatMap((plan) => dynamicNodeStartSpecs(ctx.profile, plan, "ensure", beforeRunSpecs));
  const rollback = plans.map((plan) => `docker rm -f ${plan.container}`);
  const verification = [
    "each added container is Up, not Restarting",
    "authenticated viewer/json/nodelist includes each added node IC port",
    `scheme ls ${ctx.profile.tenantPath}`
  ];

  const summary = `Add ${plans.length} dynamic node${plans.length === 1 ? "" : "s"} to ${ctx.profile.tenantPath}.`;
  const decision = await authorizeMutation(ctx, options, commandPlanIntent({
    summary,
    risk: "high",
    specs,
    rollback,
    verification,
  }));
  if (!decision.execute) {
    return attachConfirmation({
      summary: `${summary}${confirmationSummarySuffix(decision.confirmation)}`,
      executed: false,
      risk: "high",
      plannedCommands: specs.map((spec) => ctx.client.display(spec)),
      rollback,
      verification,
      nodes: plans
    }, decision.confirmation);
  }

  const { results, nodeChecks, completedNodes } = await startDynamicNodePlans(ctx, plans, "ensure", beforeRunSpecs);
  if (completedNodes < plans.length) {
    return attachConfirmation(
      addDynamicNodesResponse(ctx, plans, specs, nodeChecks, results, rollback, verification, completedNodes),
      decision.confirmation,
    );
  }

  results.push(await ctx.client.run(waitForYdbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Verify tenant metadata")));
  return attachConfirmation(
    addDynamicNodesResponse(ctx, plans, specs, nodeChecks, results, rollback, verification, completedNodes),
    decision.confirmation,
  );
}

export async function removeDynamicNodes(ctx: ToolkitContext, options: RemoveDynamicNodesOptions = {}): Promise<RemoveDynamicNodesResponse> {
  const targets = await removableDynamicNodeTargets(ctx, options);
  const specs = targets.map((target) => bash(`docker rm -f ${shellQuote(target.container)}`, {
    timeoutMs: 60_000,
    description: `Remove dynamic tenant node ${target.container}`
  }));
  const rollback = [
    ...(targets.some((target) => target.index <= ctx.profile.dynamicNodeCount)
      ? ["Restore configured nodes with local_ydb_restart_stack or local_ydb_bootstrap."]
      : []),
    ...(targets.some((target) => target.index > ctx.profile.dynamicNodeCount)
      ? ["Recreate removed one-off nodes with local_ydb_add_dynamic_nodes using matching suffixes and ports if needed."]
      : [])
  ];
  const verification = [
    "authenticated viewer/json/nodelist no longer includes each removed node IC port",
    `scheme ls ${ctx.profile.tenantPath}`
  ];

  const summary = `Remove ${targets.length} dynamic node${targets.length === 1 ? "" : "s"} from ${ctx.profile.tenantPath}.`;
  const decision = await authorizeMutation(ctx, options, commandPlanIntent({
    summary,
    risk: "high",
    specs,
    rollback,
    verification,
  }));
  if (!decision.execute) {
    return attachConfirmation({
      summary: `${summary}${confirmationSummarySuffix(decision.confirmation)}`,
      executed: false,
      risk: "high",
      plannedCommands: specs.map((spec) => ctx.client.display(spec)),
      rollback,
      verification,
      nodes: targets
    }, decision.confirmation);
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
      return attachConfirmation(
        removeDynamicNodesResponse(ctx, targets, nodeChecks, results, rollback, verification, completedNodes),
        decision.confirmation,
      );
    }
    const icPort = target.icPort;
    if (typeof icPort === "number") {
      const check = await waitForDynamicNodePortAbsence(ctx, { ...target, icPort });
      nodeChecks.push(check);
      if (!check.ok) {
        return attachConfirmation(
          removeDynamicNodesResponse(ctx, targets, nodeChecks, results, rollback, verification, completedNodes),
          decision.confirmation,
        );
      }
    }
    completedNodes += 1;
  }

  results.push(await ctx.client.run(waitForYdbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Verify tenant metadata")));
  return attachConfirmation(
    removeDynamicNodesResponse(ctx, targets, nodeChecks, results, rollback, verification, completedNodes),
    decision.confirmation,
  );
}

async function removableDynamicNodeTargets(ctx: ToolkitContext, options: RemoveDynamicNodesOptions): Promise<DynamicNodeTarget[]> {
  const hasExplicitTargets = Boolean(options.nodeIds?.length || options.containers?.length);
  const startIndex = options.startIndex ?? (hasExplicitTargets ? 2 : ctx.profile.dynamicNodeCount + 1);
  if (startIndex < 2) {
    throw new Error("startIndex must be 2 or greater to avoid the profile dynamicContainer");
  }
  if (options.nodeIds && options.nodeIds.length > 0 && options.containers && options.containers.length > 0) {
    throw new Error("Specify either nodeIds or containers, not both");
  }
  if (options.nodeIds && options.nodeIds.length > 0 && options.count !== undefined) {
    throw new Error("count cannot be used with nodeIds");
  }

  const inventoryState = await requireInventory(ctx);
  const containers = inventoryState.containers;
  const available = containers
    .map((container) => extraDynamicNodeTarget(ctx.profile, container.names))
    .filter((target): target is DynamicNodeTarget => Boolean(target))
    .filter((target) => target.index >= startIndex);

  let targets: DynamicNodeTarget[];
  if (options.nodeIds && options.nodeIds.length > 0) {
    const requestedNodeIds = validateNodeIds(options.nodeIds);
    const inspectByContainer = await inspectDynamicNodePorts(ctx, available.map((target) => target.container));
    targets = await targetsForNodeIds(ctx, available, inspectByContainer, requestedNodeIds);
    return targets.sort((left, right) => right.index - left.index);
  } else if (options.containers && options.containers.length > 0) {
    const requested = new Set(options.containers);
    targets = available.filter((target) => requested.has(target.container));
    if (targets.length !== requested.size) {
      const resolved = new Set(targets.map((target) => target.container));
      const missing = Array.from(requested).filter((container) => !resolved.has(container));
      throw new Error(`Requested dynamic-node containers were not found or were not removable suffixes: ${missing.join(", ")}`);
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

  const inspectByContainer = await inspectDynamicNodePorts(ctx, targets.map((target) => target.container));
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
      missing.push(`${nodeId} (port ${icPort} is not a removable dynamic-node suffix)`);
      continue;
    }
    targets.push({ ...target, nodeId });
  }

  if (missing.length > 0) {
    throw new Error(`Requested dynamic-node IDs were not found or were not removable suffixes: ${missing.join(", ")}`);
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
  specs: readonly CommandSpec[],
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
    plannedCommands: specs.map((spec) => ctx.client.display(spec)),
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
