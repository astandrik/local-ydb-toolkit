import type { CommandResult, DockerContainerSummary } from "../api-client.js";
import type { ResolvedLocalYdbProfile } from "../validation.js";
import { nodesCheck } from "./checks.js";
import { dynamicNodeStartSpecs } from "./commands.js";
import { assertPort, assertPositiveInteger, delay, observedNodePorts } from "./helpers.js";
import type {
  AddDynamicNodesOptions,
  DynamicNodeCheck,
  DynamicNodePlan,
  ToolkitContext
} from "./types.js";

export interface DynamicTopologyExecution {
  results: CommandResult[];
  nodeChecks: DynamicNodeCheck[];
  completedNodes: number;
}

export interface DynamicTopologyDrift {
  missing: string[];
  unexpected: DockerContainerSummary[];
}

export function dynamicNodePlan(profile: ResolvedLocalYdbProfile, index: number): DynamicNodePlan {
  assertPositiveInteger("dynamic node index", index);
  const offset = index - 1;
  const plan = {
    container: index === 1 ? profile.dynamicContainer : `${profile.dynamicContainer}-${index}`,
    index,
    grpcPort: profile.ports.dynamicGrpc + offset,
    monitoringPort: profile.ports.dynamicMonitoring + offset,
    icPort: profile.ports.dynamicIc + offset
  };
  validatePlanPorts(plan);
  return plan;
}

export function configuredDynamicNodePlans(profile: ResolvedLocalYdbProfile): DynamicNodePlan[] {
  const plans = Array.from({ length: profile.dynamicNodeCount }, (_, offset) => dynamicNodePlan(profile, offset + 1));
  validateSharedNetworkPorts(profile, plans);
  return plans;
}

export function additionalDynamicNodePlans(
  profile: ResolvedLocalYdbProfile,
  options: AddDynamicNodesOptions
): DynamicNodePlan[] {
  const count = options.count ?? 1;
  const startIndex = options.startIndex ?? profile.dynamicNodeCount + 1;
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
  const plans = Array.from({ length: count }, (_, offset) => ({
    container: `${profile.dynamicContainer}-${startIndex + offset}`,
    index: startIndex + offset,
    grpcPort: grpcPortStart + offset,
    monitoringPort: monitoringPortStart + offset,
    icPort: icPortStart + offset
  }));
  plans.forEach(validatePlanPorts);

  const replacedIndexes = new Set(plans.map((plan) => plan.index));
  const configuredPlans = configuredDynamicNodePlans(profile)
    .filter((plan) => !replacedIndexes.has(plan.index));
  validateSharedNetworkPorts(profile, [...configuredPlans, ...plans]);
  return plans;
}

export function classifyDynamicTopologyDrift(
  profile: ResolvedLocalYdbProfile,
  containers: DockerContainerSummary[]
): DynamicTopologyDrift {
  const configured = configuredDynamicNodePlans(profile);
  const byName = new Map(containers.map((container) => [container.names, container]));
  const missing = configured
    .map((plan) => plan.container)
    .filter((container) => !byName.has(container));
  const unexpected = containers
    .filter((container) => dynamicNodeSuffixIndex(profile, container.names) > profile.dynamicNodeCount)
    .sort((left, right) => dynamicNodeSuffixIndex(profile, left.names) - dynamicNodeSuffixIndex(profile, right.names));
  return { missing, unexpected };
}

export async function startDynamicNodePlans(
  ctx: ToolkitContext,
  plans: DynamicNodePlan[]
): Promise<DynamicTopologyExecution> {
  const results: CommandResult[] = [];
  const nodeChecks: DynamicNodeCheck[] = [];
  let completedNodes = 0;

  for (const plan of plans) {
    for (const spec of dynamicNodeStartSpecs(ctx.profile, plan)) {
      const result = await ctx.client.run(spec);
      results.push(result);
      if (!result.ok) {
        return { results, nodeChecks, completedNodes };
      }
    }

    const check = await waitForDynamicNodePort(ctx, plan);
    nodeChecks.push(check);
    if (!check.ok) {
      results.push({
        command: `verify dynamic node ${plan.container} IC port ${plan.icPort}`,
        exitCode: 1,
        stdout: `Observed IC ports: ${check.observedPorts.join(", ") || "<none>"}`,
        stderr: check.error ?? `Configured IC port ${plan.icPort} did not appear in viewer/json/nodelist.`,
        ok: false,
        timedOut: false
      });
      return { results, nodeChecks, completedNodes };
    }
    completedNodes += 1;
  }

  return { results, nodeChecks, completedNodes };
}

export async function waitForDynamicNodePort(
  ctx: ToolkitContext,
  plan: DynamicNodePlan
): Promise<DynamicNodeCheck> {
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

function validatePlanPorts(plan: DynamicNodePlan): void {
  [plan.grpcPort, plan.monitoringPort, plan.icPort].forEach(assertPort);
}

function validateSharedNetworkPorts(profile: ResolvedLocalYdbProfile, plans: DynamicNodePlan[]): void {
  const bindings = [
    { label: "static gRPC", port: profile.ports.staticGrpc },
    { label: "static monitoring", port: 8765 },
    ...plans.flatMap((plan) => [
      { label: `${plan.container} gRPC`, port: plan.grpcPort },
      { label: `${plan.container} monitoring`, port: plan.monitoringPort },
      { label: `${plan.container} IC`, port: plan.icPort }
    ])
  ];
  const seen = new Map<number, string>();
  for (const binding of bindings) {
    assertPort(binding.port);
    const existing = seen.get(binding.port);
    if (existing) {
      throw new Error(`Dynamic-node topology maps both ${existing} and ${binding.label} to port ${binding.port} in the shared network namespace.`);
    }
    seen.set(binding.port, binding.label);
  }
}

function dynamicNodeSuffixIndex(profile: ResolvedLocalYdbProfile, name?: string): number {
  if (!name || !name.startsWith(`${profile.dynamicContainer}-`)) {
    return 0;
  }
  const suffix = name.slice(profile.dynamicContainer.length + 1);
  return /^\d+$/.test(suffix) ? Number(suffix) : 0;
}
