import { bash, shellQuote, type CommandResult, type CommandSpec } from "../api-client.js";
import { inventory } from "./checks.js";
import {
  commandForDynamicEnsureRun,
  commandForStaticRun,
  createTenantSpec,
  removeTenantIfPresentSpec,
  ydbCli
} from "./commands.js";
import { normalizeExpectedYdbResult, runMutating } from "./execution.js";
import { findExtraDynamicContainers } from "./helpers.js";
import type { DestroyStackOptions, DestroyStackResponse, MutatingOptions, OperationResponse, ToolkitContext } from "./types.js";

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

export async function startDynamicNode(ctx: ToolkitContext, options: MutatingOptions = {}) {
  return runMutating(ctx, {
    summary: `Start dynamic node ${ctx.profile.dynamicContainer}.`,
    risk: "medium",
    specs: [bash(commandForDynamicEnsureRun(ctx.profile), { timeoutMs: 60_000 })],
    rollback: [`docker rm -f ${ctx.profile.dynamicContainer}`],
    verification: ["container is Up", "viewer/json/nodelist includes the dynamic node", `scheme ls ${ctx.profile.tenantPath}`]
  }, options);
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
  let tenantRemoveSkippedDueToAuthFailure = false;
  for (const [index, spec] of specs.entries()) {
    const result = normalizeExpectedYdbResult(spec, await ctx.client.run(spec));
    results.push(result);
    if (!result.ok) {
      if (index === 0 && canContinueAfterTenantRemoveFailure(ctx, options, result)) {
        tenantRemoveSkippedDueToAuthFailure = true;
        continue;
      }
      break;
    }
  }

  return {
    summary: tenantRemoveSkippedDueToAuthFailure
      ? `Destroy local-ydb stack for ${ctx.profile.name}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands after continuing past tenant removal auth failure.`
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
  };
}

function canContinueAfterTenantRemoveFailure(
  ctx: ToolkitContext,
  options: DestroyStackOptions,
  result: CommandResult
): boolean {
  const tearingDownUnderlyingStorage = !ctx.profile.bindMountPath || Boolean(options.removeBindMountPath);
  if (!tearingDownUnderlyingStorage) {
    return false;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  return /UNAUTHORIZED|Invalid password|Access denied|login denied|too many failed password attempts|CLIENT_UNAUTHENTICATED/i.test(output);
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
