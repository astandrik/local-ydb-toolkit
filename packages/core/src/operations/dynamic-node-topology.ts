import { bash, shellQuote, type CommandResult, type CommandSpec, type DockerContainerSummary } from "../api-client.js";
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

interface DynamicContainerSample {
  id: string;
  restartCount: number;
}

const STATIC_IC_PORT = 19_001;

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
  validatePlan(profile, plan);
  return plan;
}

export function configuredDynamicNodePlans(profile: ResolvedLocalYdbProfile): DynamicNodePlan[] {
  const plans = Array.from({ length: profile.dynamicNodeCount }, (_, offset) => dynamicNodePlan(profile, offset + 1));
  validateSharedNetworkPorts(profile, plans);
  return plans;
}

export function validateDynamicNodePlans(profile: ResolvedLocalYdbProfile, plans: DynamicNodePlan[]): void {
  plans.forEach((plan) => validatePlan(profile, plan));
  validateSharedNetworkPorts(profile, plans);
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
  if (startIndex <= profile.dynamicNodeCount) {
    throw new Error(`startIndex must be greater than dynamicNodeCount (${profile.dynamicNodeCount}) for one-off nodes`);
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
  validateDynamicNodePlans(profile, [...configuredDynamicNodePlans(profile), ...plans]);
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
  plans: DynamicNodePlan[],
  mode: "ensure" | "recreate" = "ensure",
  beforeRunSpecs: readonly CommandSpec[] = []
): Promise<DynamicTopologyExecution> {
  const results: CommandResult[] = [];
  const nodeChecks: DynamicNodeCheck[] = [];
  let completedNodes = 0;

  for (const plan of plans) {
    for (const spec of dynamicNodeStartSpecs(ctx.profile, plan, mode, beforeRunSpecs)) {
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
  let previousSample: DynamicContainerSample | undefined;
  const containerIdentityWarning = "A matching IC port does not confirm the exact container state.";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const container = await inspectDynamicContainer(ctx, plan.container);
    const check = await nodesCheck(ctx);
    observedPorts = observedNodePorts(check.nodes);
    const portRegistered = observedPorts.includes(plan.icPort);
    if (container.sample && portRegistered) {
      if (previousSample?.id === container.sample.id && previousSample.restartCount === container.sample.restartCount) {
        return { container: plan.container, icPort: plan.icPort, ok: true, attempts: attempt, observedPorts };
      }
      previousSample = container.sample;
      error = `Exact container ${plan.container} has not yet remained stable for two consecutive checks. ${containerIdentityWarning}`;
    } else {
      previousSample = undefined;
      const failure = container.error
        ?? check.error
        ?? `Configured IC port ${plan.icPort} did not appear in viewer/json/nodelist.`;
      error = `${failure} ${containerIdentityWarning}`;
    }
    if (attempt < 5) {
      await delay(2_000);
    }
  }
  return { container: plan.container, icPort: plan.icPort, ok: false, attempts: 5, observedPorts, error };
}

async function inspectDynamicContainer(
  ctx: ToolkitContext,
  container: string
): Promise<{ sample?: DynamicContainerSample; error?: string }> {
  const result = await ctx.client.run(bash(
    `docker inspect --type container --format '{{.Id}}\t{{.State.Running}}\t{{.State.Restarting}}\t{{.RestartCount}}' ${shellQuote(container)}`,
    {
      allowFailure: true,
      description: `Inspect exact dynamic tenant node ${container}`
    }
  ));
  if (!result.ok) {
    return { error: `Exact container ${container} is missing or could not be inspected.` };
  }
  const [id, running, restarting, restartCountText] = result.stdout.trim().split("\t");
  const restartCount = Number(restartCountText);
  if (!id || !Number.isSafeInteger(restartCount) || restartCount < 0 || !["true", "false"].includes(running) || !["true", "false"].includes(restarting)) {
    return { error: `Exact container ${container} returned an invalid Docker state sample.` };
  }
  if (running !== "true" || restarting !== "false") {
    return { error: `Exact container ${container} is not stably running (Running=${running}, Restarting=${restarting}).` };
  }
  return { sample: { id, restartCount } };
}

function validatePlan(profile: ResolvedLocalYdbProfile, plan: DynamicNodePlan): void {
  if (plan.container === profile.staticContainer) {
    throw new Error(`Configured dynamic node ${plan.container} aliases the static container name.`);
  }
  [plan.grpcPort, plan.monitoringPort, plan.icPort].forEach(assertPort);
}

function validateSharedNetworkPorts(profile: ResolvedLocalYdbProfile, plans: DynamicNodePlan[]): void {
  const bindings = [
    { label: "static gRPC", port: profile.ports.staticGrpc },
    { label: "static monitoring", port: 8765 },
    { label: "static IC", port: STATIC_IC_PORT },
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
