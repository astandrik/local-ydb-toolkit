import {
  addDynamicNodes,
  addStorageGroups,
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
  graphshardCheck,
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
  AuthHardeningArgs,
  CleanupArgs,
  DestroyStackArgs,
  DumpArgs,
  DynamicAuthConfigArgs,
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
  authHardeningSchema,
  cleanupSchema,
  destroyStackSchema,
  dumpSchema,
  dynamicAuthConfigSchema,
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
): Tool {
  return { name, description, inputSchema };
}

export const toolDefinitions = [
  defineTool({
    group: "checks",
    name: "local_ydb_inventory",
    description: "Collect Docker inventory for a local-ydb target profile.",
    inputSchema: profileSchema(),
    handler: withContext(ProfileArgs, (context) => inventory(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_database_status",
    description: "Read database status via the YDB admin API.",
    inputSchema: profileSchema(),
    handler: withContext(ProfileArgs, (context) => databaseStatus(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_container_logs",
    description: "Read recent logs from the static or dynamic local-ydb container.",
    inputSchema: logsSchema(),
    handler: withContext(LogsArgs, (context, parsed) =>
      containerLogs(context, parsed),
    ),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_status_report",
    description: "Aggregate local-ydb inventory, auth, tenant, and node checks.",
    inputSchema: profileSchema(),
    handler: withContext(ProfileArgs, (context) => statusReport(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_tenant_check",
    description: "Check tenant metadata reachability with the YDB CLI.",
    inputSchema: profileSchema(),
    handler: withContext(ProfileArgs, (context) => tenantCheck(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_scheme",
    description: "List or describe YDB scheme objects with capped output.",
    inputSchema: schemeSchema(),
    handler: withContext(SchemeArgs, (context, parsed) =>
      inspectScheme(context, parsed),
    ),
  }),
  defineTool({
    group: "auth",
    name: "local_ydb_permissions",
    description:
      "List, grant, revoke, set, clear, chown, or toggle inheritance for YDB scheme permissions.",
    inputSchema: permissionsSchema(),
    handler: withContext(PermissionsArgs, (context, parsed) =>
      managePermissions(context, parsed),
    ),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_nodes_check",
    description: "Check dynamic nodes through viewer/json nodelist.",
    inputSchema: profileSchema(),
    handler: withContext(ProfileArgs, (context) => nodesCheck(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_graphshard_check",
    description: "Check GraphShard capability and tablet visibility.",
    inputSchema: profileSchema(),
    handler: withContext(ProfileArgs, (context) => graphshardCheck(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_auth_check",
    description: "Check anonymous viewer and CLI auth posture.",
    inputSchema: profileSchema(),
    handler: withContext(ProfileArgs, (context) => authCheck(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_storage_placement",
    description: "Read storage pool and BSC physical placement.",
    inputSchema: profileSchema(),
    handler: withContext(ProfileArgs, (context) => storagePlacement(context)),
  }),
  defineTool({
    group: "storage",
    name: "local_ydb_add_storage_groups",
    description:
      "Increase NumGroups for a tenant storage pool using the current ReadStoragePool definition.",
    inputSchema: addStorageGroupsSchema(),
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
    handler: withContext(ReduceStorageGroupsArgs, (context, parsed) =>
      reduceStorageGroups(context, parsed),
    ),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_storage_leftovers",
    description: "Find leftover local-ydb volumes, dumps, and PDisk paths.",
    inputSchema: profileSchema(),
    handler: withContext(ProfileArgs, (context) => storageLeftovers(context)),
  }),
  defineTool({
    group: "checks",
    name: "local_ydb_list_versions",
    description:
      "List published registry tags for a local-ydb container image, with numeric versions sorted newest first.",
    inputSchema: listVersionsSchema(),
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
      "Start a background Docker pull for a local-ydb image on the selected target.",
    inputSchema: pullImageSchema(),
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
    handler: withContext(DestroyStackArgs, (context, parsed) =>
      destroyStack(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 1,
    name: "local_ydb_bootstrap_root_database",
    description:
      "Bootstrap a plain local YDB database at /local with only a static node; choose this for generic local database requests.",
    inputSchema: mutatingSchema(),
    handler: withContext(MutatingArgs, (context, parsed) =>
      bootstrapRootDatabase(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 2,
    name: "local_ydb_bootstrap",
    description:
      "Bootstrap a tenant topology: static node, configured CMS tenant, and dynamic tenant node; choose this only for tenant, GraphShard, or dynamic-node scenarios.",
    inputSchema: mutatingSchema(),
    handler: withContext(MutatingArgs, (context, parsed) =>
      bootstrap(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 0,
    name: "local_ydb_check_prerequisites",
    description:
      "Check target-host prerequisites and optionally install supported missing packages.",
    inputSchema: mutatingSchema(),
    handler: withContext(MutatingArgs, (context, parsed) =>
      checkPrerequisites(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 3,
    name: "local_ydb_create_tenant",
    description: "Create the configured CMS tenant if missing.",
    inputSchema: mutatingSchema(),
    handler: withContext(MutatingArgs, (context, parsed) =>
      createTenant(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 4,
    name: "local_ydb_start_dynamic_node",
    description: "Start the configured dynamic tenant node.",
    inputSchema: mutatingSchema(),
    handler: withContext(MutatingArgs, (context, parsed) =>
      startDynamicNode(context, parsed),
    ),
  }),
  defineTool({
    group: "dynamic nodes",
    name: "local_ydb_add_dynamic_nodes",
    description:
      "Add extra dynamic tenant nodes one at a time and verify each reaches nodelist.",
    inputSchema: addDynamicNodesSchema(),
    handler: withContext(AddDynamicNodesArgs, (context, parsed) =>
      addDynamicNodes(context, parsed),
    ),
  }),
  defineTool({
    group: "dynamic nodes",
    name: "local_ydb_remove_dynamic_nodes",
    description:
      "Remove extra dynamic tenant nodes one at a time and verify each disappears from nodelist.",
    inputSchema: removeDynamicNodesSchema(),
    handler: withContext(RemoveDynamicNodesArgs, (context, parsed) =>
      removeDynamicNodes(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 5,
    name: "local_ydb_restart_stack",
    description: "Restart static and dynamic local-ydb containers.",
    inputSchema: mutatingSchema(),
    handler: withContext(MutatingArgs, (context, parsed) =>
      restartStack(context, parsed),
    ),
  }),
  defineTool({
    group: "lifecycle",
    instructionOrder: 8,
    name: "local_ydb_upgrade_version",
    description:
      "Upgrade a file-backed, volume-backed local-ydb profile to a target image tag via image preflight, dump, rebuild, restore, auth reapply, extra-node recreation, image verification, and profile image persistence.",
    inputSchema: upgradeVersionSchema(),
    handler: async (args, options) => {
      const parsed = UpgradeVersionArgs.parse(args ?? {});
      return upgradeVersion(createUpgradeToolContext(parsed, options), parsed);
    },
  }),
  defineTool({
    group: "backup restore",
    name: "local_ydb_dump_tenant",
    description: "Dump the configured tenant using a local-ydb helper container.",
    inputSchema: dumpSchema(),
    handler: withContext(DumpArgs, (context, parsed) =>
      dumpTenant(context, parsed),
    ),
  }),
  defineTool({
    group: "backup restore",
    name: "local_ydb_restore_tenant",
    description: "Restore the configured tenant from a named dump.",
    inputSchema: restoreSchema(),
    handler: withContext(RestoreArgs, (context, parsed) =>
      restoreTenant(context, parsed),
    ),
  }),
  defineTool({
    group: "auth",
    name: "local_ydb_prepare_auth_config",
    description:
      "Prepare a hardened YDB config file from the current static-node config.",
    inputSchema: prepareAuthConfigSchema(),
    handler: withContext(PrepareAuthConfigArgs, (context, parsed) =>
      prepareAuthConfig(context, parsed),
    ),
  }),
  defineTool({
    group: "auth",
    name: "local_ydb_write_dynamic_auth_config",
    description:
      "Write a text-proto auth token file for mandatory-auth dynamic node startup.",
    inputSchema: dynamicAuthConfigSchema(),
    handler: withContext(DynamicAuthConfigArgs, (context, parsed) =>
      writeDynamicNodeAuthConfig(context, parsed),
    ),
  }),
  defineTool({
    group: "auth",
    name: "local_ydb_apply_auth_hardening",
    description: "Apply a reviewed YDB config file and restart local-ydb.",
    inputSchema: authHardeningSchema(),
    handler: withContext(AuthHardeningArgs, (context, parsed) =>
      applyAuthHardening(context, parsed),
    ),
  }),
  defineTool({
    group: "auth",
    name: "local_ydb_set_root_password",
    description:
      "Rotate the runtime root password with ALTER USER and sync the host auth config and root password file to match.",
    inputSchema: setRootPasswordSchema(),
    handler: withContext(SetRootPasswordArgs, (context, parsed) =>
      setRootPassword(context, parsed),
    ),
  }),
  defineTool({
    group: "storage",
    name: "local_ydb_cleanup_storage",
    description: "Remove explicitly supplied local-ydb storage paths or volumes.",
    inputSchema: cleanupSchema(),
    handler: withContext(CleanupArgs, (context, parsed) =>
      cleanupStorage(context, parsed),
    ),
  }),
] as const;

export const localYdbTools: Tool[] = toolDefinitions.map(
  ({ name, description, inputSchema }) =>
    tool(name, description, inputSchema),
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
