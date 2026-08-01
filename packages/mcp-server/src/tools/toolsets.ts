import { toolDefinitions, type ToolDefinition } from "./registry.js";

export const TOOLSETS_ENV = "LOCAL_YDB_MCP_TOOLSETS";
export const ENABLE_TOOLS_ENV = "LOCAL_YDB_MCP_ENABLE_TOOLS";
export const DISABLE_TOOLS_ENV = "LOCAL_YDB_MCP_DISABLE_TOOLS";

const diagnosticsTools = [
  "local_ydb_inventory",
  "local_ydb_database_status",
  "local_ydb_healthcheck",
  "local_ydb_container_logs",
  "local_ydb_status_report",
  "local_ydb_tenant_check",
  "local_ydb_scheme",
  "local_ydb_nodes_check",
  "local_ydb_graphshard_check",
  "local_ydb_auth_check",
  "local_ydb_storage_placement",
  "local_ydb_storage_leftovers",
  "local_ydb_list_versions",
  "local_ydb_pull_status",
] as const;

const developerTools = [
  ...diagnosticsTools,
  "local_ydb_generate_schema",
  "local_ydb_apply_schema",
  "local_ydb_check_prerequisites",
  "local_ydb_bootstrap_root_database",
  "local_ydb_bootstrap",
  "local_ydb_create_tenant",
  "local_ydb_start_dynamic_node",
  "local_ydb_restart_stack",
  "local_ydb_pull_image",
  "local_ydb_list_dumps",
  "local_ydb_dump_tenant",
  "local_ydb_restore_tenant",
] as const;

const operatorTools = [
  ...developerTools,
  "local_ydb_destroy_stack",
  "local_ydb_upgrade_version",
  "local_ydb_add_dynamic_nodes",
  "local_ydb_remove_dynamic_nodes",
  "local_ydb_add_storage_groups",
  "local_ydb_reduce_storage_groups",
  "local_ydb_cleanup_storage",
] as const;

const securityTools = [
  "local_ydb_status_report",
  "local_ydb_auth_check",
  "local_ydb_permissions",
  "local_ydb_prepare_auth_config",
  "local_ydb_write_dynamic_auth_config",
  "local_ydb_apply_auth_hardening",
  "local_ydb_set_root_password",
] as const;

const allTools = toolDefinitions.map((definition) => definition.name);

export const toolsetPresets = {
  diagnostics: diagnosticsTools,
  developer: developerTools,
  operator: operatorTools,
  security: securityTools,
  all: allTools,
} as const;

export type ToolsetName = keyof typeof toolsetPresets;

export const toolsetNames = Object.keys(toolsetPresets) as ToolsetName[];

export interface ToolSelectionEnv {
  toolsets?: string | undefined;
  enableTools?: string | undefined;
  disableTools?: string | undefined;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePresets(value: string | undefined): ToolsetName[] {
  const names = parseCsv(value);
  if (names.length === 0) {
    return ["all"];
  }
  const validNames = new Set<string>(toolsetNames);
  for (const name of names) {
    if (!validNames.has(name)) {
      throw new Error(
        `Invalid ${TOOLSETS_ENV}: unknown toolset ${JSON.stringify(name)}. Expected a comma-separated list of: ${toolsetNames.join(", ")}.`,
      );
    }
  }
  return names as ToolsetName[];
}

function parseToolNames(value: string | undefined, envName: string): string[] {
  const names = parseCsv(value);
  const validNames = new Set(allTools);
  for (const name of names) {
    if (!validNames.has(name)) {
      throw new Error(
        `Invalid ${envName}: unknown tool ${JSON.stringify(name)}. Expected comma-separated tool names such as local_ydb_status_report; run without ${envName} to list all registered tools.`,
      );
    }
  }
  return names;
}

export function resolveToolSelectionFromEnv(env: ToolSelectionEnv): readonly string[] {
  const enabled = new Set<string>();
  for (const preset of parsePresets(env.toolsets)) {
    for (const name of toolsetPresets[preset]) {
      enabled.add(name);
    }
  }
  for (const name of parseToolNames(env.enableTools, ENABLE_TOOLS_ENV)) {
    enabled.add(name);
  }
  for (const name of parseToolNames(env.disableTools, DISABLE_TOOLS_ENV)) {
    enabled.delete(name);
  }
  return allTools.filter((name) => enabled.has(name));
}

export function resolveToolSelection(): readonly string[] {
  return resolveToolSelectionFromEnv({
    toolsets: process.env[TOOLSETS_ENV],
    enableTools: process.env[ENABLE_TOOLS_ENV],
    disableTools: process.env[DISABLE_TOOLS_ENV],
  });
}

export function filterToolDefinitions(
  selection: readonly string[],
): ToolDefinition[] {
  const enabled = new Set(selection);
  return toolDefinitions.filter((definition) => enabled.has(definition.name));
}
