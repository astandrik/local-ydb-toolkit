import { bash, shellQuote, type CommandResult, type CommandSpec } from "../api-client.js";
import { withAuthorizedContentExecution } from "../confirmed-content.js";
import {
  attachConfirmation,
  authorizeMutation,
  commandPlanIntent,
  confirmationSummarySuffix,
} from "../confirmation.js";
import { requireInventory } from "./checks.js";
import {
  commandForDynamicEnsureRun,
  commandForStaticCompatibilityCheck,
  commandForStaticEnsureRun,
  createTenantSpec,
  dynamicNodeAuthConfirmationBindings,
  dynamicNodeAuthRedactions,
  dynamicNodeStartSpecs,
  removeTenantIfPresentSpec,
  waitForYdbRootCli,
  waitForYdbCli,
} from "./commands.js";
import {
  classifyDynamicTopologyDrift,
  configuredDynamicNodePlans,
  dynamicNodePlan,
  startDynamicNodePlans,
  validateDynamicNodePlans
} from "./dynamic-node-topology.js";
import { normalizeExpectedYdbResult, runCommandSpecs, runMutating } from "./execution.js";
import { findExtraDynamicContainers } from "./helpers.js";
import { ensureImagePresentSpec } from "./images.js";
import {
  exactDynamicNodeRemovalSpec,
  type InspectedDynamicNodePlan,
} from "./dynamic-node-inspect.js";
import type {
  DestroyStackOptions,
  DestroyStackResponse,
  MutatingOptions,
  OperationResponse,
  RestartStackResponse,
  ToolkitContext
} from "./types.js";

export async function bootstrap(ctx: ToolkitContext, options: MutatingOptions = {}): Promise<OperationResponse> {
  const plans = configuredDynamicNodePlans(ctx.profile);
  const baseSpecs = [
    ensureImagePresentSpec(ctx.profile.image),
    bash(`docker network inspect ${shellQuote(ctx.profile.network)} >/dev/null 2>&1 || docker network create ${shellQuote(ctx.profile.network)}`, { description: "Ensure Docker network exists" }),
    ctx.profile.bindMountPath
      ? bash(`mkdir -p ${shellQuote(ctx.profile.bindMountPath)}`, { description: "Ensure bind mount path exists" })
      : bash(`docker volume inspect ${shellQuote(ctx.profile.volume)} >/dev/null 2>&1 || docker volume create ${shellQuote(ctx.profile.volume)}`, { description: "Ensure Docker volume exists" }),
    bash(commandForStaticEnsureRun(ctx.profile, {
      enableGraphShard: true,
      requireGraphShard: true,
      publishedDynamicGrpcPorts: plans.map((plan) => plan.grpcPort)
    }), { timeoutMs: 60_000, description: "Start static local-ydb node" }),
    bash("sleep 5", { description: "Wait briefly for static node startup" }),
    createTenantSpec(ctx.profile),
    bash("sleep 5", { description: "Wait briefly for tenant creation" })
  ];
  const finalSpecs = [
    waitForYdbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Wait for tenant metadata"),
    bash(`curl -fsSL ${shellQuote(`${ctx.profile.monitoringBaseUrl}/viewer/json/capabilities?database=${encodeURIComponent(ctx.profile.tenantPath)}`)} >/dev/null || true`, { allowFailure: true, description: "Verify viewer capabilities endpoint" })
  ];
  const nodeSpecs = plans.flatMap((plan) => dynamicNodeStartSpecs(ctx.profile, plan, "recreate"));
  const specs = [...baseSpecs, ...nodeSpecs, ...finalSpecs];
  const rollback = [
    ...plans.slice().reverse().map((plan) => `docker rm -f ${plan.container}`),
    `docker rm -f ${ctx.profile.staticContainer}`,
    ctx.profile.bindMountPath ? `Review and remove bind mount path manually: ${ctx.profile.bindMountPath}` : `docker volume rm ${ctx.profile.volume}`
  ];
  const verification = [
    `scheme ls ${ctx.profile.tenantPath}`,
    "viewer capabilities reports GraphShardExists=true",
    `viewer/json/nodelist includes configured IC ports: ${plans.map((plan) => plan.icPort).join(", ")}`
  ];

  const summary = `Bootstrap local-ydb topology for ${ctx.profile.tenantPath}.`;
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
      verification
    }, decision.confirmation);
  }
  return withAuthorizedContentExecution(
    ctx,
    decision.receipt,
    specs,
    async (executionContext) => {
      const confirmed = <T extends object>(response: T) =>
        attachConfirmation(response, decision.confirmation);

      const results = await runCommandSpecs(executionContext, baseSpecs);
      if (!completedAll(baseSpecs, results)) {
        return confirmed(bootstrapResponse(ctx, specs, rollback, verification, results, 0, plans.length));
      }
      const topology = await startDynamicNodePlans(executionContext, plans, "recreate");
      results.push(...topology.results);
      if (topology.completedNodes < plans.length) {
        return confirmed(bootstrapResponse(ctx, specs, rollback, verification, results, topology.completedNodes, plans.length));
      }
      results.push(...await runCommandSpecs(executionContext, finalSpecs));
      return confirmed(bootstrapResponse(ctx, specs, rollback, verification, results, topology.completedNodes, plans.length));
    },
  );
}

export async function bootstrapRootDatabase(ctx: ToolkitContext, options: MutatingOptions = {}): Promise<OperationResponse> {
  const specs = [
    ensureImagePresentSpec(ctx.profile.image),
    bash(`docker network inspect ${shellQuote(ctx.profile.network)} >/dev/null 2>&1 || docker network create ${shellQuote(ctx.profile.network)}`, { description: "Ensure Docker network exists" }),
    ctx.profile.bindMountPath
      ? bash(`mkdir -p ${shellQuote(ctx.profile.bindMountPath)}`, { description: "Ensure bind mount path exists" })
      : bash(`docker volume inspect ${shellQuote(ctx.profile.volume)} >/dev/null 2>&1 || docker volume create ${shellQuote(ctx.profile.volume)}`, { description: "Ensure Docker volume exists" }),
    bash(commandForStaticEnsureRun(ctx.profile, { enableGraphShard: false }), { timeoutMs: 60_000, description: "Start static local-ydb node" }),
    bash("sleep 5", { description: "Wait briefly for static node startup" }),
    waitForYdbRootCli(ctx.profile, ["scheme", "ls", ctx.profile.rootDatabase], "Wait for root database metadata"),
    bash(`curl -fsSL ${shellQuote(`${ctx.profile.monitoringBaseUrl}/viewer/json/tenants?database=${encodeURIComponent(ctx.profile.rootDatabase)}`)} >/dev/null || true`, { allowFailure: true, description: "Verify viewer tenants endpoint" })
  ];
  return runMutating(ctx, {
    summary: `Bootstrap local-ydb root database ${ctx.profile.rootDatabase}.`,
    risk: "high",
    specs,
    rollback: [
      `docker rm -f ${ctx.profile.staticContainer}`,
      ctx.profile.bindMountPath ? `Review and remove bind mount path manually: ${ctx.profile.bindMountPath}` : `docker volume rm ${ctx.profile.volume}`
    ],
    verification: [
      `scheme ls ${ctx.profile.rootDatabase}`,
      "static container is Up",
      "monitoring endpoint is reachable"
    ]
  }, options);
}

export async function startDynamicNode(ctx: ToolkitContext, options: MutatingOptions = {}) {
  const plan = dynamicNodePlan(ctx.profile, 1);
  validateDynamicNodePlans(ctx.profile, [plan]);
  const configuredPlans = configuredDynamicNodePlans(ctx.profile);
  return runMutating(ctx, {
    summary: `Start dynamic node ${ctx.profile.dynamicContainer}.`,
    risk: "medium",
    specs: [
      ensureImagePresentSpec(ctx.profile.image),
      bash(commandForStaticCompatibilityCheck(ctx.profile, {
        requireGraphShard: true,
        publishedDynamicGrpcPorts: configuredPlans.map((configuredPlan) => configuredPlan.grpcPort)
      }), { timeoutMs: 60_000, description: "Verify static local-ydb node compatibility before dynamic node start" }),
      bash(commandForDynamicEnsureRun(ctx.profile, plan), {
        timeoutMs: 60_000,
        redactions: dynamicNodeAuthRedactions(ctx.profile),
        confirmationContentBindings: dynamicNodeAuthConfirmationBindings(ctx.profile),
      })
    ],
    rollback: [`docker rm -f ${ctx.profile.dynamicContainer}`],
    verification: ["container is Up", "viewer/json/nodelist includes the dynamic node", `scheme ls ${ctx.profile.tenantPath}`]
  }, options);
}

export async function destroyStack(
  ctx: ToolkitContext,
  options: DestroyStackOptions = {},
  preparedExtraDynamicNodes?: readonly (string | Pick<InspectedDynamicNodePlan, "container" | "containerId">)[],
): Promise<DestroyStackResponse> {
  const preparedTargets = preparedExtraDynamicNodes
    ? [...preparedExtraDynamicNodes]
    : findExtraDynamicContainers(
        ctx.profile,
        (await requireInventory(ctx)).containers.map((container) => container.names),
      );
  const extraDynamicNodes = preparedTargets.map((target) =>
    typeof target === "string" ? target : target.container
  );
  const specs: CommandSpec[] = [
    removeTenantIfPresentSpec(ctx.profile),
    ...preparedTargets.map(removeExtraDynamicNodeSpec),
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

  const summary = `Destroy local-ydb stack for ${ctx.profile.name}.`;
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
      plannedCommands,
      rollback,
      verification,
      tenantRemovePlanned: true,
      extraDynamicNodes,
      removesBindMountPath: Boolean(ctx.profile.bindMountPath && options.removeBindMountPath),
      removesAuthArtifacts: Boolean(options.removeAuthArtifacts),
      removesDumpHostPath: Boolean(options.removeDumpHostPath)
    }, decision.confirmation);
  }

  const results: CommandResult[] = [];
  let tenantRemoveSkipped = false;
  for (const [index, spec] of specs.entries()) {
    const result = normalizeExpectedYdbResult(spec, await ctx.client.run(spec));
    results.push(result);
    if (!result.ok) {
      if (index === 0 && canContinueAfterTenantRemoveFailureDuringTeardown(ctx, options, result)) {
        tenantRemoveSkipped = true;
        continue;
      }
      break;
    }
  }

  return attachConfirmation({
    summary: tenantRemoveSkipped
      ? `Destroy local-ydb stack for ${ctx.profile.name}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands after continuing past tenant removal failure during teardown.`
      : `Destroy local-ydb stack for ${ctx.profile.name}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands.`,
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
  }, decision.confirmation);
}

function removeExtraDynamicNodeSpec(
  target: string | Pick<InspectedDynamicNodePlan, "container" | "containerId">,
): CommandSpec {
  if (typeof target === "string") {
    return bash(`docker rm -f ${shellQuote(target)} 2>/dev/null || true`, {
      timeoutMs: 60_000,
      description: `Remove extra dynamic tenant node ${target}`,
    });
  }
  return exactDynamicNodeRemovalSpec(
    target,
    `Remove exact extra dynamic tenant node ${target.container}`,
  );
}

function canContinueAfterTenantRemoveFailureDuringTeardown(
  ctx: ToolkitContext,
  options: DestroyStackOptions,
  result: CommandResult
): boolean {
  const tearingDownUnderlyingStorage = !ctx.profile.bindMountPath || Boolean(options.removeBindMountPath);
  if (!tearingDownUnderlyingStorage) {
    return false;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  return /UNAUTHORIZED|Invalid password|Access denied|login denied|too many failed password attempts|CLIENT_UNAUTHENTICATED|connection refused|Endpoint list is empty|Could not resolve redirected path|Failed to connect|TRANSPORT_UNAVAILABLE|Status:\s*UNAVAILABLE|No such container/i.test(output);
}

export async function restartStack(ctx: ToolkitContext, options: MutatingOptions = {}): Promise<RestartStackResponse> {
  const inventory = await requireInventory(ctx);
  const plans = configuredDynamicNodePlans(ctx.profile);
  const drift = classifyDynamicTopologyDrift(ctx.profile, inventory.containers);
  const configuredNames = new Set(plans.map((plan) => plan.container));
  const runningConfigured = inventory.containers
    .filter((container) => container.names && configuredNames.has(container.names) && container.state === "running")
    .map((container) => container.names as string);
  const runningUnexpected = drift.unexpected
    .filter((container) => container.state === "running" && container.names)
    .map((container) => container.names as string);
  const stopSpecs = [...runningConfigured.slice().reverse(), ...runningUnexpected.slice().reverse()]
    .map((container) => bash(`docker stop ${shellQuote(container)}`, {
      timeoutMs: 60_000,
      description: `Stop dynamic tenant node ${container}`
    }));
  const preflightSpecs = [
    ensureImagePresentSpec(ctx.profile.image),
    bash(commandForStaticCompatibilityCheck(ctx.profile, {
      requireGraphShard: true,
      publishedDynamicGrpcPorts: plans.map((plan) => plan.grpcPort)
    }), { timeoutMs: 60_000, description: "Verify static local-ydb node compatibility" })
  ];
  const mutationSpecs = [
    ...stopSpecs,
    bash(`docker stop ${shellQuote(ctx.profile.staticContainer)} 2>/dev/null || true`),
    bash(`docker start ${shellQuote(ctx.profile.staticContainer)}`),
    bash("sleep 5"),
    createTenantSpec(ctx.profile),
    bash("sleep 5")
  ];
  const nodeSpecs = plans.flatMap((plan) => dynamicNodeStartSpecs(ctx.profile, plan, "recreate"));
  const unexpectedStartSpecs = runningUnexpected.map((container) => bash(`docker start ${shellQuote(container)}`, {
    timeoutMs: 60_000,
    description: `Restore unexpected dynamic tenant node ${container}`
  }));
  const metadataSpec = waitForYdbCli(
    ctx.profile,
    ["scheme", "ls", ctx.profile.tenantPath],
    ctx.profile.tenantPath,
    "Verify tenant metadata after restart"
  );
  const finalSpecs = [...unexpectedStartSpecs, metadataSpec];
  const specs = [...preflightSpecs, ...mutationSpecs, ...nodeSpecs, ...finalSpecs];
  const rollback = [
    "Recreate configured nodes with local_ydb_restart_stack or local_ydb_bootstrap; local_ydb_inventory does not retain removed container definitions.",
    ...runningUnexpected.map((container) => `docker start ${container}`)
  ];
  const verification = [
    "static and configured dynamic containers are Up",
    `viewer/json/nodelist includes configured IC ports: ${plans.map((plan) => plan.icPort).join(", ")}`,
    `scheme ls ${ctx.profile.tenantPath}`,
    "unexpected dynamic containers retain their preflight running/stopped state"
  ];
  const missingDynamicContainers = drift.missing;
  const unexpectedDynamicContainers = drift.unexpected
    .map((container) => container.names)
    .filter((name): name is string => Boolean(name));

  const summary = `Restart local-ydb static and dynamic containers for ${ctx.profile.name}.`;
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
      missingDynamicContainers,
      unexpectedDynamicContainers
    }, decision.confirmation);
  }
  return withAuthorizedContentExecution(
    ctx,
    decision.receipt,
    specs,
    async (executionContext) => {
      const confirmed = (response: RestartStackResponse) =>
        attachConfirmation(response, decision.confirmation);

      const results = await runCommandSpecs(executionContext, preflightSpecs);
      if (!completedAll(preflightSpecs, results)) {
        return confirmed(restartResponse(ctx, specs, rollback, verification, results, missingDynamicContainers, unexpectedDynamicContainers, 0, plans.length));
      }
      const mutationResults = await runCommandSpecs(executionContext, mutationSpecs);
      results.push(...mutationResults);
      if (!completedAll(mutationSpecs, mutationResults)) {
        results.push(...await restoreUnexpectedDynamicNodes(executionContext, unexpectedStartSpecs));
        return confirmed(restartResponse(ctx, specs, rollback, verification, results, missingDynamicContainers, unexpectedDynamicContainers, 0, plans.length));
      }
      const topology = await startDynamicNodePlans(executionContext, plans, "recreate");
      results.push(...topology.results);
      if (topology.completedNodes < plans.length) {
        results.push(...await restoreUnexpectedDynamicNodes(executionContext, unexpectedStartSpecs));
        return confirmed(restartResponse(ctx, specs, rollback, verification, results, missingDynamicContainers, unexpectedDynamicContainers, topology.completedNodes, plans.length));
      }
      const recoveryResults = await restoreUnexpectedDynamicNodes(executionContext, unexpectedStartSpecs);
      results.push(...recoveryResults);
      if (!completedAll(unexpectedStartSpecs, recoveryResults)) {
        return confirmed(restartResponse(ctx, specs, rollback, verification, results, missingDynamicContainers, unexpectedDynamicContainers, topology.completedNodes, plans.length));
      }
      results.push(await executionContext.client.run(metadataSpec));
      return confirmed(restartResponse(ctx, specs, rollback, verification, results, missingDynamicContainers, unexpectedDynamicContainers, topology.completedNodes, plans.length));
    },
  );
}

async function restoreUnexpectedDynamicNodes(ctx: ToolkitContext, specs: CommandSpec[]): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const spec of specs) {
    results.push(await ctx.client.run(spec));
  }
  return results;
}

function completedAll(specs: CommandSpec[], results: CommandResult[]): boolean {
  return results.length === specs.length && results.every((result) => result.ok);
}

function bootstrapResponse(
  ctx: ToolkitContext,
  specs: CommandSpec[],
  rollback: string[],
  verification: string[],
  results: CommandResult[],
  completedNodes: number,
  nodeCount: number
): OperationResponse {
  return {
    summary: `Bootstrap local-ydb topology for ${ctx.profile.tenantPath}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands; verified ${completedNodes}/${nodeCount} configured dynamic nodes.`,
    executed: true,
    risk: "high",
    plannedCommands: specs.map((spec) => ctx.client.display(spec)),
    rollback,
    verification,
    results
  };
}

function restartResponse(
  ctx: ToolkitContext,
  specs: CommandSpec[],
  rollback: string[],
  verification: string[],
  results: CommandResult[],
  missingDynamicContainers: string[],
  unexpectedDynamicContainers: string[],
  completedNodes: number,
  nodeCount: number
): RestartStackResponse {
  return {
    summary: `Restart local-ydb static and dynamic containers for ${ctx.profile.name}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands; verified ${completedNodes}/${nodeCount} configured dynamic nodes.`,
    executed: true,
    risk: "high",
    plannedCommands: specs.map((spec) => ctx.client.display(spec)),
    rollback,
    verification,
    results,
    missingDynamicContainers,
    unexpectedDynamicContainers
  };
}
