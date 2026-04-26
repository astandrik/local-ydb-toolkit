import {
  bash,
  parseBscPlacement,
  parseReadStoragePools,
  shellQuote,
  type CommandResult,
  type StoragePoolSummary
} from "../api-client.js";
import { ydbCli, ydbdAdmin } from "./commands.js";
import { runMutating } from "./execution.js";
import { assertPositiveInteger, assertSafeCleanupTarget } from "./helpers.js";
import type { AddStorageGroupsOptions, AddStorageGroupsResponse, MutatingOptions, ToolkitContext } from "./types.js";

type ResolvedStoragePoolSummary = Required<Pick<StoragePoolSummary, "rawBlock" | "boxId" | "storagePoolId" | "name" | "numGroups">> &
  Pick<StoragePoolSummary, "itemConfigGeneration">;

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

export async function addStorageGroups(ctx: ToolkitContext, options: AddStorageGroupsOptions = {}): Promise<AddStorageGroupsResponse> {
  const groupsToAdd = options.count ?? 1;
  assertPositiveInteger("count", groupsToAdd);
  if (groupsToAdd > 10) {
    throw new Error("count must be 10 or less");
  }

  const pool = await readTargetStoragePool(ctx, options.poolName);
  const targetNumGroups = pool.numGroups + groupsToAdd;
  const defineSpec = ydbdAdmin(ctx.profile, [
    "admin", "blobstorage", "config", "invoke",
    "--proto", buildDefineStoragePoolRequest(pool, targetNumGroups)
  ], `Increase storage groups for ${pool.name}`);
  const plannedCommands = [ctx.client.display(defineSpec)];
  const rollback = [
    `Reapply DefineStoragePool for ${pool.name} with NumGroups: ${pool.numGroups} and ItemConfigGeneration: ${pool.itemConfigGeneration ?? "<current>"}.`
  ];
  const verification = [
    `ReadStoragePool for ${pool.name} reports NumGroups: ${targetNumGroups}`,
    `scheme ls ${ctx.profile.tenantPath}`
  ];

  if (!options.confirm) {
    return {
      summary: `Add ${groupsToAdd} storage group${groupsToAdd === 1 ? "" : "s"} to ${pool.name}. Not executed because confirm=true was not provided.`,
      executed: false,
      risk: "high",
      plannedCommands,
      rollback,
      verification,
      pool: {
        name: pool.name,
        boxId: pool.boxId,
        storagePoolId: pool.storagePoolId,
        numGroups: pool.numGroups,
        targetNumGroups,
        itemConfigGeneration: pool.itemConfigGeneration
      }
    };
  }

  const results: CommandResult[] = [];
  const invokeResult = await ctx.client.run(defineSpec);
  results.push(invokeResult);
  if (!invokeResult.ok) {
    return addStorageGroupsResponse(ctx, pool, targetNumGroups, undefined, results, rollback, verification);
  }

  const refreshedPool = await readTargetStoragePool(ctx, pool.name);
  const observedNumGroups = refreshedPool.numGroups;
  results.push({
    command: `verify storage pool ${pool.name} NumGroups`,
    exitCode: observedNumGroups === targetNumGroups ? 0 : 1,
    stdout: `Observed NumGroups: ${observedNumGroups}`,
    stderr: observedNumGroups === targetNumGroups ? "" : `Expected NumGroups: ${targetNumGroups}`,
    ok: observedNumGroups === targetNumGroups,
    timedOut: false
  });
  if (observedNumGroups !== targetNumGroups) {
    return addStorageGroupsResponse(ctx, pool, targetNumGroups, observedNumGroups, results, rollback, verification);
  }
  const tenantResult = await ctx.client.run(ydbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Verify tenant metadata"));
  results.push(tenantResult);

  return addStorageGroupsResponse(ctx, pool, targetNumGroups, observedNumGroups, results, rollback, verification);
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

async function readTargetStoragePool(ctx: ToolkitContext, poolName?: string): Promise<ResolvedStoragePoolSummary> {
  const result = await ctx.client.run(ydbdAdmin(ctx.profile, [
    "admin", "blobstorage", "config", "invoke",
    "--proto", "Command { ReadStoragePool { BoxId: 1 } }"
  ], "Read storage pool config"));
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || "ReadStoragePool failed");
  }

  const targetName = poolName ?? `${ctx.profile.tenantPath}:${ctx.profile.storagePoolKind}`;
  const pools = parseReadStoragePools(result.stdout);
  const matches = pools.filter((pool) => pool.name === targetName);
  if (matches.length === 0) {
    throw new Error(`Storage pool not found: ${targetName}`);
  }
  if (matches.length > 1) {
    throw new Error(`Storage pool name is ambiguous: ${targetName}`);
  }
  const pool = matches[0];
  if (!pool.rawBlock || typeof pool.boxId !== "number" || typeof pool.storagePoolId !== "number" || typeof pool.name !== "string" || typeof pool.numGroups !== "number") {
    throw new Error(`Storage pool ${targetName} is missing required fields in ReadStoragePool output`);
  }
  return {
    rawBlock: pool.rawBlock,
    boxId: pool.boxId,
    storagePoolId: pool.storagePoolId,
    name: pool.name,
    numGroups: pool.numGroups,
    itemConfigGeneration: pool.itemConfigGeneration
  };
}

function buildDefineStoragePoolRequest(pool: Pick<ResolvedStoragePoolSummary, "rawBlock" | "name" | "numGroups" | "itemConfigGeneration">, targetNumGroups: number): string {
  if (!/\bNumGroups:\s*\d+/.test(pool.rawBlock)) {
    throw new Error(`Storage pool ${pool.name} does not expose NumGroups in ReadStoragePool output`);
  }
  const defineStoragePool = pool.rawBlock
    .replace(/^StoragePool\b/, "DefineStoragePool")
    .replace(/\bNumGroups:\s*\d+/, `NumGroups: ${targetNumGroups}`);
  return `Command { ${defineStoragePool} } Command { QueryBaseConfig { RetrieveDevices: true SuppressNodes: true } }`;
}

function addStorageGroupsResponse(
  ctx: ToolkitContext,
  pool: ResolvedStoragePoolSummary,
  targetNumGroups: number,
  observedNumGroups: number | undefined,
  results: CommandResult[],
  rollback: string[],
  verification: string[]
): AddStorageGroupsResponse {
  return {
    summary: `Add storage groups to ${pool.name}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands.`,
    executed: true,
    risk: "high",
    plannedCommands: [
      ctx.client.display(ydbdAdmin(ctx.profile, [
        "admin", "blobstorage", "config", "invoke",
        "--proto", buildDefineStoragePoolRequest(pool, targetNumGroups)
      ], `Increase storage groups for ${pool.name}`))
    ],
    rollback,
    verification,
    results,
    pool: {
      name: pool.name,
      boxId: pool.boxId,
      storagePoolId: pool.storagePoolId,
      numGroups: pool.numGroups,
      targetNumGroups,
      itemConfigGeneration: pool.itemConfigGeneration
    },
    observedNumGroups
  };
}
