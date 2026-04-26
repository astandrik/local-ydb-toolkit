#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addStorageGroups,
  addDynamicNodes,
  applyAuthHardening,
  authCheck,
  databaseStatus,
  bootstrap,
  checkPrerequisites,
  containerLogs,
  cleanupStorage,
  createContext,
  createTenant,
  reduceStorageGroups,
  dumpTenant,
  graphshardCheck,
  inventory,
  nodesCheck,
  prepareAuthConfig,
  destroyStack,
  removeDynamicNodes,
  restartStack,
  restoreTenant,
  setRootPassword,
  startDynamicNode,
  statusReport,
  storageLeftovers,
  storagePlacement,
  tenantCheck,
  writeDynamicNodeAuthConfig,
  type CommandExecutor,
  type LocalYdbConfig,
  loadConfig
} from "@local-ydb-toolkit/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PackageMetadata = z.object({
  version: z.string()
});

export const localYdbMcpServerVersion = PackageMetadata.parse(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
).version;

const ProfileArgs = z.object({
  profile: z.string().optional(),
  configPath: z.string().optional()
});

const LogsArgs = ProfileArgs.extend({
  target: z.enum(["static", "dynamic"]),
  lines: z.number().int().positive().optional()
});

const MutatingArgs = ProfileArgs.extend({
  confirm: z.boolean().optional()
});

const AddDynamicNodesArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  startIndex: z.number().int().min(2).optional(),
  grpcPortStart: z.number().int().positive().max(65535).optional(),
  monitoringPortStart: z.number().int().positive().max(65535).optional(),
  icPortStart: z.number().int().positive().max(65535).optional()
});

const RemoveDynamicNodesArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  startIndex: z.number().int().min(2).optional(),
  containers: z.array(z.string()).optional(),
  nodeIds: z.array(z.number().int().positive()).max(10).optional()
});

const AddStorageGroupsArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  poolName: z.string().optional()
});

const ReduceStorageGroupsArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  dumpName: z.string().optional(),
  poolName: z.string().optional()
});

const DestroyStackArgs = MutatingArgs.extend({
  removeBindMountPath: z.boolean().optional(),
  removeAuthArtifacts: z.boolean().optional(),
  removeDumpHostPath: z.boolean().optional()
});

const DumpArgs = MutatingArgs.extend({
  dumpName: z.string().optional()
});

const RestoreArgs = MutatingArgs.extend({
  dumpName: z.string()
});

const AuthHardeningArgs = MutatingArgs.extend({
  configHostPath: z.string().optional()
});

const PrepareAuthConfigArgs = MutatingArgs.extend({
  configHostPath: z.string().optional(),
  sid: z.string().optional()
});

const DynamicAuthConfigArgs = MutatingArgs.extend({
  sid: z.string().optional(),
  tokenHostPath: z.string().optional()
});

const SetRootPasswordArgs = MutatingArgs.extend({
  password: z.string().min(1)
});

const CleanupArgs = MutatingArgs.extend({
  paths: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional()
});

type HandlerOptions = {
  executor?: CommandExecutor;
  config?: LocalYdbConfig;
};

type ToolHandler = (args: unknown, options: HandlerOptions) => Promise<unknown>;

function handlerConfig(configPath: string | undefined, options: HandlerOptions): LocalYdbConfig {
  return options.config ?? loadConfig(configPath);
}

export const localYdbInstructions = [
  "Use local_ydb_check_prerequisites first on a new local or remote target to verify Docker, host helpers, and auth-file prerequisites before deeper checks.",
  "If local_ydb_check_prerequisites reports installable missing packages, review the plan first and then run it with confirm=true to install supported host helpers such as curl or ruby; Docker still requires manual installation.",
  "Use local_ydb_status_report or local_ydb_inventory first to establish the current stack state before mutating anything.",
  "For bootstrap or restart issues, inspect local_ydb_database_status and local_ydb_container_logs before retrying.",
  "Prefer exact image tags for local-ydb stacks and avoid mixing static and dynamic image versions in one stack.",
  "On a fresh /local/<tenant> database, admin database status can be PENDING_RESOURCES before the first dynamic node registers; treat status success as the readiness gate for the first dynamic-node start.",
  "For storage-pool expansion, reread the current pool definition first and increase NumGroups on that exact pool instead of guessing a partial DefineStoragePool shape.",
  "For storage-pool reduction, do not try to live-decrease NumGroups; dump the tenant, rebuild the stack with a smaller storagePoolCount, restore, and then reapply auth if the profile uses it.",
  "For full teardown, remove tenant metadata first when the static node is reachable, then remove containers, network, and storage; keep shared host paths opt-in.",
  "When adding extra dynamic nodes, start and verify one node at a time before adding the next.",
  "When removing extra dynamic nodes, remove one node at a time and confirm its IC port disappears from nodelist before removing another.",
  "For auth rollout, prepare the config and dynamic auth token first, then apply auth hardening; after auth, anonymous viewer checks should return 401 while authenticated tenant checks should still pass."
].join(" ");

export const localYdbTools: Tool[] = [
  tool("local_ydb_inventory", "Collect Docker inventory for a local-ydb target profile.", profileSchema()),
  tool("local_ydb_database_status", "Read database status via the YDB admin API.", profileSchema()),
  tool("local_ydb_container_logs", "Read recent logs from the static or dynamic local-ydb container.", logsSchema()),
  tool("local_ydb_status_report", "Aggregate local-ydb inventory, auth, tenant, and node checks.", profileSchema()),
  tool("local_ydb_tenant_check", "Check tenant metadata reachability with the YDB CLI.", profileSchema()),
  tool("local_ydb_nodes_check", "Check dynamic nodes through viewer/json nodelist.", profileSchema()),
  tool("local_ydb_graphshard_check", "Check GraphShard capability and tablet visibility.", profileSchema()),
  tool("local_ydb_auth_check", "Check anonymous viewer and CLI auth posture.", profileSchema()),
  tool("local_ydb_storage_placement", "Read storage pool and BSC physical placement.", profileSchema()),
  tool("local_ydb_add_storage_groups", "Increase NumGroups for a tenant storage pool using the current ReadStoragePool definition.", addStorageGroupsSchema()),
  tool("local_ydb_reduce_storage_groups", "Reduce NumGroups for a tenant storage pool by dumping the tenant, rebuilding the profile stack with a smaller storagePoolCount, restoring the dump, and reapplying auth when needed.", reduceStorageGroupsSchema()),
  tool("local_ydb_storage_leftovers", "Find leftover local-ydb volumes, dumps, and PDisk paths.", profileSchema()),
  tool("local_ydb_destroy_stack", "Remove tenant metadata, local-ydb containers, network, and storage for a profile, with optional host-path cleanup.", destroyStackSchema()),
  tool("local_ydb_bootstrap", "Bootstrap a GraphShard-ready local-ydb topology.", mutatingSchema()),
  tool("local_ydb_check_prerequisites", "Check target-host prerequisites and optionally install supported missing packages.", mutatingSchema()),
  tool("local_ydb_create_tenant", "Create the configured CMS tenant if missing.", mutatingSchema()),
  tool("local_ydb_start_dynamic_node", "Start the configured dynamic tenant node.", mutatingSchema()),
  tool("local_ydb_add_dynamic_nodes", "Add extra dynamic tenant nodes one at a time and verify each reaches nodelist.", addDynamicNodesSchema()),
  tool("local_ydb_remove_dynamic_nodes", "Remove extra dynamic tenant nodes one at a time and verify each disappears from nodelist.", removeDynamicNodesSchema()),
  tool("local_ydb_restart_stack", "Restart static and dynamic local-ydb containers.", mutatingSchema()),
  tool("local_ydb_dump_tenant", "Dump the configured tenant using a local-ydb helper container.", dumpSchema()),
  tool("local_ydb_restore_tenant", "Restore the configured tenant from a named dump.", restoreSchema()),
  tool("local_ydb_prepare_auth_config", "Prepare a hardened YDB config file from the current static-node config.", prepareAuthConfigSchema()),
  tool("local_ydb_write_dynamic_auth_config", "Write a text-proto auth token file for mandatory-auth dynamic node startup.", dynamicAuthConfigSchema()),
  tool("local_ydb_apply_auth_hardening", "Apply a reviewed YDB config file and restart local-ydb.", authHardeningSchema()),
  tool("local_ydb_set_root_password", "Rotate the runtime root password with ALTER USER and sync the host auth config and root password file to match.", setRootPasswordSchema()),
  tool("local_ydb_cleanup_storage", "Remove explicitly supplied local-ydb storage paths or volumes.", cleanupSchema())
];

const handlers: Record<string, ToolHandler> = {
  local_ydb_inventory: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return inventory(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)));
  },
  local_ydb_database_status: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return databaseStatus(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)));
  },
  local_ydb_container_logs: async (args, options) => {
    const parsed = LogsArgs.parse(args ?? {});
    return containerLogs(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_status_report: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return statusReport(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)));
  },
  local_ydb_tenant_check: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return tenantCheck(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)));
  },
  local_ydb_nodes_check: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return nodesCheck(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)));
  },
  local_ydb_graphshard_check: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return graphshardCheck(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)));
  },
  local_ydb_auth_check: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return authCheck(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)));
  },
  local_ydb_storage_placement: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return storagePlacement(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)));
  },
  local_ydb_add_storage_groups: async (args, options) => {
    const parsed = AddStorageGroupsArgs.parse(args ?? {});
    return addStorageGroups(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_reduce_storage_groups: async (args, options) => {
    const parsed = ReduceStorageGroupsArgs.parse(args ?? {});
    return reduceStorageGroups(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_storage_leftovers: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return storageLeftovers(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)));
  },
  local_ydb_destroy_stack: async (args, options) => {
    const parsed = DestroyStackArgs.parse(args ?? {});
    return destroyStack(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_bootstrap: async (args, options) => {
    const parsed = MutatingArgs.parse(args ?? {});
    return bootstrap(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_check_prerequisites: async (args, options) => {
    const parsed = MutatingArgs.parse(args ?? {});
    return checkPrerequisites(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_create_tenant: async (args, options) => {
    const parsed = MutatingArgs.parse(args ?? {});
    return createTenant(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_start_dynamic_node: async (args, options) => {
    const parsed = MutatingArgs.parse(args ?? {});
    return startDynamicNode(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_add_dynamic_nodes: async (args, options) => {
    const parsed = AddDynamicNodesArgs.parse(args ?? {});
    return addDynamicNodes(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_remove_dynamic_nodes: async (args, options) => {
    const parsed = RemoveDynamicNodesArgs.parse(args ?? {});
    return removeDynamicNodes(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_restart_stack: async (args, options) => {
    const parsed = MutatingArgs.parse(args ?? {});
    return restartStack(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_dump_tenant: async (args, options) => {
    const parsed = DumpArgs.parse(args ?? {});
    return dumpTenant(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_restore_tenant: async (args, options) => {
    const parsed = RestoreArgs.parse(args ?? {});
    return restoreTenant(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_prepare_auth_config: async (args, options) => {
    const parsed = PrepareAuthConfigArgs.parse(args ?? {});
    return prepareAuthConfig(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_write_dynamic_auth_config: async (args, options) => {
    const parsed = DynamicAuthConfigArgs.parse(args ?? {});
    return writeDynamicNodeAuthConfig(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_apply_auth_hardening: async (args, options) => {
    const parsed = AuthHardeningArgs.parse(args ?? {});
    return applyAuthHardening(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_set_root_password: async (args, options) => {
    const parsed = SetRootPasswordArgs.parse(args ?? {});
    return setRootPassword(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  },
  local_ydb_cleanup_storage: async (args, options) => {
    const parsed = CleanupArgs.parse(args ?? {});
    return cleanupStorage(createContext(parsed.profile, options.executor, handlerConfig(parsed.configPath, options)), parsed);
  }
};

export function createLocalYdbMcpServer(options: HandlerOptions = {}): Server {
  const server = new Server(
    { name: "local-ydb-toolkit", version: localYdbMcpServerVersion },
    { capabilities: { tools: {} }, instructions: localYdbInstructions }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: localYdbTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const handler = handlers[name];
    if (!handler) {
      return errorResult(`Unknown tool: ${name}`);
    }
    try {
      return successResult(await handler(request.params.arguments ?? {}, options));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}

export async function callLocalYdbToolForTest(name: string, args: unknown, options: HandlerOptions = {}): Promise<unknown> {
  const handler = handlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(args, options);
}

async function main(): Promise<void> {
  const server = createLocalYdbMcpServer();
  await server.connect(new StdioServerTransport());
}

function tool(name: string, description: string, inputSchema: Tool["inputSchema"]): Tool {
  return { name, description, inputSchema };
}

function profileSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string", description: "Named profile from local-ydb.config.json. Defaults to config.defaultProfile." },
      configPath: { type: "string", description: "Explicit local-ydb config file path to load for this tool call. Useful when the MCP server should pick up a different config without restart." }
    },
    additionalProperties: false
  };
}

function logsSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["target"],
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      target: { type: "string", enum: ["static", "dynamic"] },
      lines: { type: "integer", minimum: 1, description: "Number of recent log lines to read. Defaults to 200." }
    },
    additionalProperties: false
  };
}

function mutatingSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string", description: "Explicit local-ydb config file path to load for this tool call." },
      confirm: { type: "boolean", description: "Must be true to execute commands. Omit or false for plan-only output." }
    },
    additionalProperties: false
  };
}

function addDynamicNodesSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean", description: "Must be true to execute commands. Omit or false for plan-only output." },
      count: { type: "integer", minimum: 1, maximum: 10, description: "Number of additional dynamic nodes to add. Defaults to 1." },
      startIndex: { type: "integer", minimum: 2, description: "Suffix for the first added container. Defaults to 2, producing <dynamicContainer>-2." },
      grpcPortStart: { type: "integer", minimum: 1, maximum: 65535, description: "gRPC port for the first added node. Defaults to profile.dynamicGrpc + startIndex - 1." },
      monitoringPortStart: { type: "integer", minimum: 1, maximum: 65535, description: "Monitoring port for the first added node. Defaults to profile.dynamicMonitoring + startIndex - 1." },
      icPortStart: { type: "integer", minimum: 1, maximum: 65535, description: "Interconnect port for the first added node. Defaults to profile.dynamicIc + startIndex - 1." }
    },
    additionalProperties: false
  };
}

function addStorageGroupsSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean", description: "Must be true to execute commands. Omit or false for plan-only output." },
      count: { type: "integer", minimum: 1, maximum: 10, description: "Number of storage groups to add. Defaults to 1." },
      poolName: { type: "string", description: "Explicit storage pool name. Defaults to <tenantPath>:<storagePoolKind>." }
    },
    additionalProperties: false
  };
}

function reduceStorageGroupsSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean", description: "Must be true to execute commands. Omit or false for plan-only output." },
      count: { type: "integer", minimum: 1, maximum: 10, description: "Number of storage groups to remove from the current tenant pool. Defaults to 1." },
      dumpName: { type: "string", description: "Optional dump directory name under profile.dumpHostPath to preserve before rebuild." },
      poolName: { type: "string", description: "Explicit storage pool name. Defaults to <tenantPath>:<storagePoolKind>." }
    },
    additionalProperties: false
  };
}

function destroyStackSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean", description: "Must be true to execute commands. Omit or false for plan-only output." },
      removeBindMountPath: { type: "boolean", description: "Delete profile.bindMountPath when the profile uses a bind mount. Defaults to false." },
      removeAuthArtifacts: { type: "boolean", description: "Delete explicit authConfigPath, dynamicNodeAuthTokenFile, and rootPasswordFile when configured. Defaults to false." },
      removeDumpHostPath: { type: "boolean", description: "Delete profile.dumpHostPath. Defaults to false because it may be shared." }
    },
    additionalProperties: false
  };
}

function removeDynamicNodesSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean", description: "Must be true to execute commands. Omit or false for plan-only output." },
      count: { type: "integer", minimum: 1, maximum: 10, description: "Number of extra dynamic nodes to remove. Defaults to 1." },
      startIndex: { type: "integer", minimum: 2, description: "Minimum suffix to consider removable. Defaults to 2." },
      containers: { type: "array", items: { type: "string" }, description: "Explicit extra dynamic-node container names to remove." },
      nodeIds: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 10, description: "Explicit YDB dynamic-node IDs to remove. IDs must resolve to extra dynamic-node containers; the profile's base dynamic node is not removable through this option." }
    },
    additionalProperties: false
  };
}

function dumpSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean" },
      dumpName: { type: "string", description: "Optional dump directory name under profile.dumpHostPath." }
    },
    additionalProperties: false
  };
}

function restoreSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["dumpName"],
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean" },
      dumpName: { type: "string", description: "Dump directory name under profile.dumpHostPath." }
    },
    additionalProperties: false
  };
}

function authHardeningSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean" },
      configHostPath: { type: "string", description: "Reviewed config.yaml path on the selected target host. Defaults to profile.authConfigPath when present." }
    },
    additionalProperties: false
  };
}

function prepareAuthConfigSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean", description: "Must be true to execute commands. Omit or false for plan-only output." },
      configHostPath: { type: "string", description: "Host path for the generated hardened config. Defaults to profile.authConfigPath when present." },
      sid: { type: "string", description: "SID to place into viewer, monitoring, administration, and register_dynamic_node_allowed_sids. Defaults to profile.dynamicNodeAuthSid or root@builtin." }
    },
    additionalProperties: false
  };
}

function dynamicAuthConfigSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean", description: "Must be true to execute commands. Omit or false for plan-only output." },
      sid: { type: "string", description: "SID to store in both StaffApiUserToken and NodeRegistrationToken." },
      tokenHostPath: { type: "string", description: "Host path for the generated text-proto auth token file. Defaults to profile.dynamicNodeAuthTokenFile when present." }
    },
    additionalProperties: false
  };
}

function setRootPasswordSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["password"],
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean", description: "Must be true to execute commands. Omit or false for plan-only output." },
      password: { type: "string", description: "New root password to apply to the runtime root user and then persist into the host auth config and root password file." }
    },
    additionalProperties: false
  };
}

function cleanupSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean" },
      paths: { type: "array", items: { type: "string" } },
      volumes: { type: "array", items: { type: "string" } }
    },
    additionalProperties: false
  };
}

function successResult(result: unknown) {
  const data = result as { summary?: string };
  return {
    content: [
      { type: "text", text: data.summary ?? "local-ydb tool completed." },
      { type: "text", text: JSON.stringify(result, null, 2) }
    ],
    structuredContent: result
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: message }
  };
}

if (isCliEntryPoint()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}

function isCliEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return fileURLToPath(import.meta.url) === entry;
  }
}
