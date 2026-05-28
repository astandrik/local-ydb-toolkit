import {
  addDynamicNodes,
  addStorageGroups,
  applySchema,
  applyAuthHardening,
  authCheck,
  bootstrap,
  bootstrapRootDatabase,
  checkPrerequisites,
  cleanupStorage,
  containerLogs,
  createTenant,
  databaseStatus,
  destroyStack,
  dumpTenant,
  generateSchema,
  graphshardCheck,
  healthcheck,
  inspectScheme,
  inventory,
  listVersions,
  managePermissions,
  nodesCheck,
  prepareAuthConfig,
  pullImage,
  pullImageStatus,
  reduceStorageGroups,
  removeDynamicNodes,
  restartStack,
  restoreTenant,
  setRootPassword,
  startDynamicNode,
  statusReport,
  storageLeftovers,
  storagePlacement,
  tenantCheck,
  upgradeVersion,
  writeDynamicNodeAuthConfig,
  type ToolkitContext,
} from "@local-ydb-toolkit/core";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import {
  AddDynamicNodesArgs,
  AddStorageGroupsArgs,
  ApplySchemaArgs,
  AuthHardeningArgs,
  CleanupArgs,
  DestroyStackArgs,
  DumpArgs,
  DynamicAuthConfigArgs,
  GenerateSchemaArgs,
  HealthcheckArgs,
  ListVersionsArgs,
  LogsArgs,
  MutatingArgs,
  PermissionsArgs,
  PrepareAuthConfigArgs,
  ProfileArgs,
  PullImageArgs,
  PullStatusArgs,
  ReduceStorageGroupsArgs,
  RemoveDynamicNodesArgs,
  RestoreArgs,
  SchemeArgs,
  SetRootPasswordArgs,
  UpgradeVersionArgs,
} from "./args.js";
import {
  addDynamicNodesSchema,
  addStorageGroupsSchema,
  applySchemaSchema,
  authHardeningSchema,
  cleanupSchema,
  destroyStackSchema,
  dumpSchema,
  dynamicAuthConfigSchema,
  generateSchemaSchema,
  healthcheckSchema,
  listVersionsSchema,
  logsSchema,
  mutatingSchema,
  permissionsSchema,
  prepareAuthConfigSchema,
  profileSchema,
  pullImageSchema,
  pullStatusSchema,
  reduceStorageGroupsSchema,
  removeDynamicNodesSchema,
  restoreSchema,
  schemeSchema,
  setRootPasswordSchema,
  upgradeVersionSchema,
} from "./input-schemas.js";
import {
  createToolContext,
  createUpgradeToolContext,
  type ProfileToolArgs,
  type ToolHandler,
} from "./context.js";

export const localYdbToolGroups = [
  "checks",
  "schema",
  "lifecycle",
  "dynamic nodes",
  "storage",
  "backup restore",
  "auth",
] as const;

export type LocalYdbToolGroup = (typeof localYdbToolGroups)[number];

export type ToolDefinition = {
  group: LocalYdbToolGroup;
  instructionOrder?: number;
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  annotations: Tool["annotations"];
  handler: ToolHandler;
};

function defineTool(definition: ToolDefinition): ToolDefinition {
  return definition;
}

function withContext<T extends ProfileToolArgs>(
  schema: z.ZodType<T>,
  run: (context: ToolkitContext, parsed: T) => Promise<unknown> | unknown,
): ToolHandler {
  return async (args, options) => {
    const parsed = schema.parse(args ?? {});
    return run(createToolContext(parsed, options), parsed);
  };
}

function tool(
  name: string,
  description: string,
  inputSchema: Tool["inputSchema"],
  annotations: Tool["annotations"],
): Tool {
  return { name, description, inputSchema, annotations };
}

function readOnlyAnnotations(): Tool["annotations"] {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
}

function mutatingAnnotations(options: {
  destructive?: boolean;
  idempotent?: boolean;
} = {}): Tool["annotations"] {
  return {
    readOnlyHint: false,
    destructiveHint: options.destructive ?? false,
    idempotentHint: options.idempotent ?? false,
    openWorldHint: true,
  };
}

export const toolDefinitions = [
  defineTool({
    group: "checks",
    name: "local_ydb_inventory",
    description:
      "Read-only Docker inventory for a local-ydb target profile. Returns the public profile, Docker containers and volumes visible on the selected target, and inspect data for the configured static and primary dynamic containers; use before mutating tools to capture current stack state.",
    inputSchema: profileSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(ProfileArgs, (context) => inventory(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_database_status",
    description:
      "Read-only YDB admin database status for the configured tenant path. Returns the command, stdout, stderr, and ok flag; use this for tenant state before bootstrap/restart troubleshooting, and use local_ydb_tenant_check for scheme reachability.",
    inputSchema: profileSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(ProfileArgs, (context) => databaseStatus(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_healthcheck",
    description:
      "Read-only YDB monitoring healthcheck for the configured tenant or root database. Uses the official YDB CLI SelfCheck path, returns selfCheckResult, issue counts, issue types, capped raw output, and whether the database is healthy; use after local_ydb_status_report for database-level diagnostics.",
    inputSchema: healthcheckSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(HealthcheckArgs, (context, parsed) =>
      healthcheck(context, parsed),
    ),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_container_logs",
    description:
      "Read recent Docker logs from the configured static or primary dynamic local-ydb container. Use when bootstrap, restart, or readiness checks fail; target selects the container role and lines controls the tail length.",
    inputSchema: logsSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(LogsArgs, (context, parsed) =>
      containerLogs(context, parsed),
    ),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_status_report",
    description:
      "Read-only aggregate report for quick diagnosis. Runs local_ydb_inventory, local_ydb_auth_check, local_ydb_tenant_check, local_ydb_nodes_check, and local_ydb_healthcheck, returning each result; use this first for broad stack health, then run focused checks for database status, GraphShard, storage, or logs.",
    inputSchema: profileSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(ProfileArgs, (context) => statusReport(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_tenant_check",
    description:
      "Read-only check that uses the YDB CLI to verify the configured tenant path is reachable. Use after bootstrap or restore to confirm tenant metadata before node or GraphShard checks.",
    inputSchema: profileSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(ProfileArgs, (context) => tenantCheck(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_scheme",
    description:
      "Read-only YDB scheme list or describe with capped stdout/stderr. It uses the root database for rootDatabase paths and the tenant database otherwise; list supports recursive/long/onePerLine flags, describe supports stats, and incompatible flag combinations are rejected.",
    inputSchema: schemeSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(SchemeArgs, (context, parsed) =>
      inspectScheme(context, parsed),
    ),
  }),
  defineTool({
    group: "schema",
    name: "local_ydb_generate_schema",
    description:
      "Read-only structured YDB table DDL generator. It renders strict JSON specs for CREATE TABLE, ALTER TABLE, DROP TABLE, and secondary indexes, returns the generated script with official references and warnings, and can optionally validate through the YDB JS SDK without applying changes.",
    inputSchema: generateSchemaSchema(),
    annotations: readOnlyAnnotations(),
    handler: async (args, options) => {
      const parsed = GenerateSchemaArgs.parse(args ?? {});
      return generateSchema(createToolContext(parsed, options), {
        ...parsed,
        sdkExecutor: options.sdkExecutor,
      });
    },
  }),
  defineTool({
    group: "schema",
    name: "local_ydb_apply_schema",
    description:
      "Validate or apply YDB table DDL through the official YDB JS SDK. It accepts raw YQL DDL for PRAGMA plus CREATE TABLE, ALTER TABLE, and DROP TABLE; action=apply validates first and executes only with confirm=true.",
    inputSchema: applySchemaSchema(),
    annotations: mutatingAnnotations({ destructive: true }),
    handler: async (args, options) => {
      const parsed = ApplySchemaArgs.parse(args ?? {});
      return applySchema(createToolContext(parsed, options), {
        ...parsed,
        sdkExecutor: options.sdkExecutor,
      });
    },
  }),
  defineTool({
    group: "auth",
    name: "local_ydb_permissions",
    description:
      "Inspect or change YDB scheme permissions for a path. The default list action is read-only; grant, revoke, set, clear, chown, and inheritance changes return a plan unless confirm=true.",
    inputSchema: permissionsSchema(),
    annotations: mutatingAnnotations({ destructive: true }),
    handler: withContext(PermissionsArgs, (context, parsed) =>
      managePermissions(context, parsed),
    ),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_nodes_check",
    description:
      "Read-only check of dynamic node registration through viewer/json nodelist. Use after starting, adding, or removing dynamic nodes; use local_ydb_tenant_check first when tenant reachability is unknown.",
    inputSchema: profileSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(ProfileArgs, (context) => nodesCheck(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_graphshard_check",
    description:
      "Read-only GraphShard check through viewer/json capabilities and tabletinfo for the configured tenant. Returns graphShardExists, tablet ids, and viewer status details; use after tenant bootstrap when GraphShard support or tablet visibility is the specific question.",
    inputSchema: profileSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(ProfileArgs, (context) => graphshardCheck(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_auth_check",
    description:
      "Read-only auth audit that checks anonymous viewer whoami status and configured YDB CLI tenant access, using root credentials when rootPasswordFile is configured. Use after auth hardening or password rotation to verify the expected posture.",
    inputSchema: profileSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(ProfileArgs, (context) => authCheck(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_storage_placement",
    description:
      "Read-only storage inspection that returns ReadStoragePool output and BSC physical placement. Use before adding or reducing storage groups to confirm the exact pool shape.",
    inputSchema: profileSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(ProfileArgs, (context) => storagePlacement(context)),
  }),
  defineTool({
    group: "storage",
    name: "local_ydb_add_storage_groups",
    description:
      "Increase NumGroups for one tenant storage pool using the current ReadStoragePool definition. Without confirm=true this returns the DefineStoragePool plan, rollback, target pool, and target count; when the update succeeds it verifies NumGroups and tenant metadata.",
    inputSchema: addStorageGroupsSchema(),
    annotations: mutatingAnnotations(),
    handler: withContext(AddStorageGroupsArgs, (context, parsed) =>
      addStorageGroups(context, parsed),
    ),
  }),
  defineTool({
    group: "storage",
    name: "local_ydb_reduce_storage_groups",
    description:
      "Reduce NumGroups for a tenant storage pool by dumping the tenant, rebuilding the profile stack with a smaller storagePoolCount, restoring the dump, and reapplying auth when needed.",
    inputSchema: reduceStorageGroupsSchema(),
    annotations: mutatingAnnotations({ destructive: true }),
    handler: withContext(ReduceStorageGroupsArgs, (context, parsed) =>
      reduceStorageGroups(context, parsed),
    ),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_storage_leftovers",
    description:
      "Read-only search for candidate leftover local-ydb Docker volumes, dumps, and PDisk/data paths. It scans Docker volume names plus profile.storageSearchPaths and deletes nothing; use before local_ydb_cleanup_storage to decide exact paths or volumes to remove.",
    inputSchema: profileSchema(),
    annotations: readOnlyAnnotations(),
    handler: withContext(ProfileArgs, (context) => storageLeftovers(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_list_versions",
    description:
      "List published registry tags for a local-ydb container image, with numeric version tags sorted newest first. Use before local_ydb_upgrade_version to choose a target tag; pageSize and maxPages bound registry pagination and the response reports truncation.",
    inputSchema: listVersionsSchema(),
    annotations: readOnlyAnnotations(),
    handler: async (args, options) => {
      const parsed = ListVersionsArgs.parse(args ?? {});
      return listVersions({ ...parsed, fetchImpl: options.fetchImpl });
    },
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 7,
    name: "local_ydb_pull_image",
    description:
      "Plan or start a background Docker pull for a local-ydb image on the selected target. Without confirm=true it returns inspect and pull commands only; with confirm=true it returns a jobId for local_ydb_pull_status unless the image is already present.",
    inputSchema: pullImageSchema(),
    annotations: mutatingAnnotations(),
    handler: withContext(PullImageArgs, (context, parsed) =>
      pullImage(context, parsed),
    ),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_pull_status",
    description:
      "Check the status of a background Docker image pull started by local_ydb_pull_image.",
    inputSchema: pullStatusSchema(),
    annotations: readOnlyAnnotations(),
    handler: async (args) => {
      const parsed = PullStatusArgs.parse(args ?? {});
      return pullImageStatus(parsed.jobId);
    },
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 6,
    name: "local_ydb_destroy_stack",
    description:
      "Remove tenant metadata, local-ydb containers, network, and storage for a profile, with optional host-path cleanup.",
    inputSchema: destroyStackSchema(),
    annotations: mutatingAnnotations({ destructive: true }),
    handler: withContext(DestroyStackArgs, (context, parsed) =>
      destroyStack(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 1,
    name: "local_ydb_bootstrap_root_database",
    description:
      "Bootstrap a plain local YDB database at /local with only a static node. Use for generic local database requests that do not need a CMS tenant, GraphShard, or dynamic nodes; without confirm=true this returns the image preflight, Docker network/storage/static-node, and verification plan without executing it.",
    inputSchema: mutatingSchema(),
    annotations: mutatingAnnotations({ idempotent: true }),
    handler: withContext(MutatingArgs, (context, parsed) =>
      bootstrapRootDatabase(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 2,
    name: "local_ydb_bootstrap",
    description:
      "Bootstrap a tenant topology: static node with GraphShard flags, configured CMS tenant, and primary dynamic tenant node. Use only for tenant, GraphShard, dump/restore, or dynamic-node scenarios; without confirm=true this returns the full plan and creates nothing.",
    inputSchema: mutatingSchema(),
    annotations: mutatingAnnotations({ idempotent: true }),
    handler: withContext(MutatingArgs, (context, parsed) =>
      bootstrap(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 0,
    name: "local_ydb_check_prerequisites",
    description:
      "Check target-host prerequisites for Docker, curl, ruby, and the configured rootPasswordFile when present. Without confirm=true it returns checks, missing items, manual actions, and any apt-get install plan; with confirm=true it may install only supported curl/ruby packages and never installs Docker.",
    inputSchema: mutatingSchema(),
    annotations: mutatingAnnotations({ idempotent: true }),
    handler: withContext(MutatingArgs, (context, parsed) =>
      checkPrerequisites(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 3,
    name: "local_ydb_create_tenant",
    description:
      "Create the configured CMS tenant when the static node is already running. Use before local_ydb_start_dynamic_node for tenant topologies; without confirm=true this returns the planned status/create command and creates nothing.",
    inputSchema: mutatingSchema(),
    annotations: mutatingAnnotations({ idempotent: true }),
    handler: withContext(MutatingArgs, (context, parsed) =>
      createTenant(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 4,
    name: "local_ydb_start_dynamic_node",
    description:
      "Start the configured primary dynamic tenant node for an existing CMS tenant. Use after local_ydb_create_tenant or when admin status is PENDING_RESOURCES; use local_ydb_add_dynamic_nodes for extra nodes. Without confirm=true this returns a plan only.",
    inputSchema: mutatingSchema(),
    annotations: mutatingAnnotations({ idempotent: true }),
    handler: withContext(MutatingArgs, (context, parsed) =>
      startDynamicNode(context, parsed),
    ),
  }),
  defineTool({
    group: "dynamic nodes",
    name: "local_ydb_add_dynamic_nodes",
    description:
      "Add extra dynamic tenant nodes beyond the configured primary dynamic node, one at a time. Without confirm=true it returns container/port plans; with confirm=true it starts each node, verifies its IC port appears in viewer/json nodelist, and checks tenant metadata.",
    inputSchema: addDynamicNodesSchema(),
    annotations: mutatingAnnotations(),
    handler: withContext(AddDynamicNodesArgs, (context, parsed) =>
      addDynamicNodes(context, parsed),
    ),
  }),
  defineTool({
    group: "dynamic nodes",
    name: "local_ydb_remove_dynamic_nodes",
    description:
      "Remove extra dynamic tenant nodes one at a time and verify nodelist disappearance when the node IC port can be resolved.",
    inputSchema: removeDynamicNodesSchema(),
    annotations: mutatingAnnotations({ destructive: true }),
    handler: withContext(RemoveDynamicNodesArgs, (context, parsed) =>
      removeDynamicNodes(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 5,
    name: "local_ydb_restart_stack",
    description:
      "Restart the selected profile by stopping dynamic and static containers, starting the static node, ensuring the configured tenant, then starting the dynamic node. Use after config or runtime changes; without confirm=true this returns the restart plan only.",
    inputSchema: mutatingSchema(),
    annotations: mutatingAnnotations(),
    handler: withContext(MutatingArgs, (context, parsed) =>
      restartStack(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 8,
    name: "local_ydb_upgrade_version",
    description:
      "Upgrade a file-backed, volume-backed local-ydb profile to a target image tag. Use only for version upgrades on profiles without bindMountPath; it preflights source and target images, dumps, rebuilds, restores, reapplies auth when configured, recreates extra nodes, verifies container images, and persists the profile image after successful confirmed execution.",
    inputSchema: upgradeVersionSchema(),
    annotations: mutatingAnnotations({ destructive: true }),
    handler: async (args, options) => {
      const parsed = UpgradeVersionArgs.parse(args ?? {});
      return upgradeVersion(createUpgradeToolContext(parsed, options), parsed);
    },
  }),
  defineTool({
    group: "backup restore",
    name: "local_ydb_dump_tenant",
    description:
      "Dump the configured tenant using a local-ydb helper container on the static container network. It creates profile.dumpHostPath/dumpName, excludes .sys objects, writes the tenant dump under dumpName/tenant, and without confirm=true returns the mkdir/helper-container plan only.",
    inputSchema: dumpSchema(),
    annotations: mutatingAnnotations(),
    handler: withContext(DumpArgs, (context, parsed) =>
      dumpTenant(context, parsed),
    ),
  }),
  defineTool({
    group: "backup restore",
    name: "local_ydb_restore_tenant",
    description:
      "Restore the configured tenant from a dump under profile.dumpHostPath. Use after bootstrap or rebuild when the target tenant is ready; without confirm=true this returns the restore plan and does not write data.",
    inputSchema: restoreSchema(),
    annotations: mutatingAnnotations({ destructive: true }),
    handler: withContext(RestoreArgs, (context, parsed) =>
      restoreTenant(context, parsed),
    ),
  }),
  defineTool({
    group: "auth",
    name: "local_ydb_prepare_auth_config",
    description:
      "Generate a hardened YDB config from the current static-node config. Use before local_ydb_write_dynamic_auth_config and local_ydb_apply_auth_hardening; without confirm=true this returns the planned write only.",
    inputSchema: prepareAuthConfigSchema(),
    annotations: mutatingAnnotations(),
    handler: withContext(PrepareAuthConfigArgs, (context, parsed) =>
      prepareAuthConfig(context, parsed),
    ),
  }),
  defineTool({
    group: "auth",
    name: "local_ydb_write_dynamic_auth_config",
    description:
      "Write the text-proto dynamic-node auth token file needed for mandatory-auth startup. Use after choosing the SID for auth hardening; without confirm=true this returns the planned file write only.",
    inputSchema: dynamicAuthConfigSchema(),
    annotations: mutatingAnnotations(),
    handler: withContext(DynamicAuthConfigArgs, (context, parsed) =>
      writeDynamicNodeAuthConfig(context, parsed),
    ),
  }),
  defineTool({
    group: "auth",
    name: "local_ydb_apply_auth_hardening",
    description:
      "Apply a reviewed hardened YDB config file and restart local-ydb so auth settings take effect. Use only after preparing and reviewing the config; without confirm=true this returns the apply/restart plan only.",
    inputSchema: authHardeningSchema(),
    annotations: mutatingAnnotations(),
    handler: withContext(AuthHardeningArgs, (context, parsed) =>
      applyAuthHardening(context, parsed),
    ),
  }),
  defineTool({
    group: "auth",
    name: "local_ydb_set_root_password",
    description:
      "Rotate the runtime root password with ALTER USER and sync the host auth config and root password file to match. YDB may reject passwords that violate auth_config.password_complexity; this tool requires a non-empty password value.",
    inputSchema: setRootPasswordSchema(),
    annotations: mutatingAnnotations(),
    handler: withContext(SetRootPasswordArgs, (context, parsed) =>
      setRootPassword(context, parsed),
    ),
  }),
  defineTool({
    group: "storage",
    name: "local_ydb_cleanup_storage",
    description:
      "Delete only the explicitly supplied local-ydb host paths or Docker volumes. Use after inspecting local_ydb_storage_leftovers; without confirm=true this returns the cleanup plan and removes nothing.",
    inputSchema: cleanupSchema(),
    annotations: mutatingAnnotations({ destructive: true }),
    handler: withContext(CleanupArgs, (context, parsed) =>
      cleanupStorage(context, parsed),
    ),
  }),
] as const;

export const localYdbTools: Tool[] = toolDefinitions.map(
  ({ name, description, inputSchema, annotations }) =>
    tool(name, description, inputSchema, annotations),
);

export const handlers: Record<string, ToolHandler> = Object.fromEntries(
  toolDefinitions.map((definition) => [definition.name, definition.handler]),
);

export const localYdbToolIndex = localYdbToolGroups.map(
  (group) =>
    [
      group,
      toolDefinitions
        .map((definition, index) => ({ definition, index }))
        .filter(({ definition }) => definition.group === group)
        .sort(
          (left, right) =>
            (left.definition.instructionOrder ?? left.index) -
            (right.definition.instructionOrder ?? right.index),
        )
        .map(({ definition }) => definition.name),
    ] as const,
);
