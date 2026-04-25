#!/usr/bin/env node

import {
  applyAuthHardening,
  authCheck,
  bootstrap,
  cleanupStorage,
  createContext,
  createTenant,
  dumpTenant,
  graphshardCheck,
  inventory,
  nodesCheck,
  restartStack,
  restoreTenant,
  startDynamicNode,
  statusReport,
  storageLeftovers,
  storagePlacement,
  tenantCheck,
  type CommandExecutor,
  type LocalYdbConfig
} from "@local-ydb-toolkit/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const ProfileArgs = z.object({
  profile: z.string().optional()
});

const MutatingArgs = ProfileArgs.extend({
  confirm: z.boolean().optional()
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

const CleanupArgs = MutatingArgs.extend({
  paths: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional()
});

type HandlerOptions = {
  executor?: CommandExecutor;
  config?: LocalYdbConfig;
};

type ToolHandler = (args: unknown, options: HandlerOptions) => Promise<unknown>;

export const localYdbTools: Tool[] = [
  tool("local_ydb_inventory", "Collect Docker inventory for a local-ydb target profile.", profileSchema()),
  tool("local_ydb_status_report", "Aggregate local-ydb inventory, auth, tenant, and node checks.", profileSchema()),
  tool("local_ydb_tenant_check", "Check tenant metadata reachability with the YDB CLI.", profileSchema()),
  tool("local_ydb_nodes_check", "Check dynamic nodes through viewer/json nodelist.", profileSchema()),
  tool("local_ydb_graphshard_check", "Check GraphShard capability and tablet visibility.", profileSchema()),
  tool("local_ydb_auth_check", "Check anonymous viewer and CLI auth posture.", profileSchema()),
  tool("local_ydb_storage_placement", "Read storage pool and BSC physical placement.", profileSchema()),
  tool("local_ydb_storage_leftovers", "Find leftover local-ydb volumes, dumps, and PDisk paths.", profileSchema()),
  tool("local_ydb_bootstrap", "Bootstrap a GraphShard-ready local-ydb topology.", mutatingSchema()),
  tool("local_ydb_create_tenant", "Create the configured CMS tenant if missing.", mutatingSchema()),
  tool("local_ydb_start_dynamic_node", "Start the configured dynamic tenant node.", mutatingSchema()),
  tool("local_ydb_restart_stack", "Restart static and dynamic local-ydb containers.", mutatingSchema()),
  tool("local_ydb_dump_tenant", "Dump the configured tenant using a local-ydb helper container.", dumpSchema()),
  tool("local_ydb_restore_tenant", "Restore the configured tenant from a named dump.", restoreSchema()),
  tool("local_ydb_apply_auth_hardening", "Apply a reviewed YDB config file and restart local-ydb.", authHardeningSchema()),
  tool("local_ydb_cleanup_storage", "Remove explicitly supplied local-ydb storage paths or volumes.", cleanupSchema())
];

const handlers: Record<string, ToolHandler> = {
  local_ydb_inventory: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return inventory(createContext(parsed.profile, options.executor, options.config));
  },
  local_ydb_status_report: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return statusReport(createContext(parsed.profile, options.executor, options.config));
  },
  local_ydb_tenant_check: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return tenantCheck(createContext(parsed.profile, options.executor, options.config));
  },
  local_ydb_nodes_check: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return nodesCheck(createContext(parsed.profile, options.executor, options.config));
  },
  local_ydb_graphshard_check: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return graphshardCheck(createContext(parsed.profile, options.executor, options.config));
  },
  local_ydb_auth_check: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return authCheck(createContext(parsed.profile, options.executor, options.config));
  },
  local_ydb_storage_placement: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return storagePlacement(createContext(parsed.profile, options.executor, options.config));
  },
  local_ydb_storage_leftovers: async (args, options) => {
    const parsed = ProfileArgs.parse(args ?? {});
    return storageLeftovers(createContext(parsed.profile, options.executor, options.config));
  },
  local_ydb_bootstrap: async (args, options) => {
    const parsed = MutatingArgs.parse(args ?? {});
    return bootstrap(createContext(parsed.profile, options.executor, options.config), parsed);
  },
  local_ydb_create_tenant: async (args, options) => {
    const parsed = MutatingArgs.parse(args ?? {});
    return createTenant(createContext(parsed.profile, options.executor, options.config), parsed);
  },
  local_ydb_start_dynamic_node: async (args, options) => {
    const parsed = MutatingArgs.parse(args ?? {});
    return startDynamicNode(createContext(parsed.profile, options.executor, options.config), parsed);
  },
  local_ydb_restart_stack: async (args, options) => {
    const parsed = MutatingArgs.parse(args ?? {});
    return restartStack(createContext(parsed.profile, options.executor, options.config), parsed);
  },
  local_ydb_dump_tenant: async (args, options) => {
    const parsed = DumpArgs.parse(args ?? {});
    return dumpTenant(createContext(parsed.profile, options.executor, options.config), parsed);
  },
  local_ydb_restore_tenant: async (args, options) => {
    const parsed = RestoreArgs.parse(args ?? {});
    return restoreTenant(createContext(parsed.profile, options.executor, options.config), parsed);
  },
  local_ydb_apply_auth_hardening: async (args, options) => {
    const parsed = AuthHardeningArgs.parse(args ?? {});
    return applyAuthHardening(createContext(parsed.profile, options.executor, options.config), parsed);
  },
  local_ydb_cleanup_storage: async (args, options) => {
    const parsed = CleanupArgs.parse(args ?? {});
    return cleanupStorage(createContext(parsed.profile, options.executor, options.config), parsed);
  }
};

export function createLocalYdbMcpServer(options: HandlerOptions = {}): Server {
  const server = new Server(
    { name: "local-ydb-toolkit", version: "0.1.0" },
    { capabilities: { tools: {} } }
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
      profile: { type: "string", description: "Named profile from local-ydb.config.json. Defaults to config.defaultProfile." }
    },
    additionalProperties: false
  };
}

function mutatingSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      confirm: { type: "boolean", description: "Must be true to execute commands. Omit or false for plan-only output." }
    },
    additionalProperties: false
  };
}

function dumpSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
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
      confirm: { type: "boolean" },
      configHostPath: { type: "string", description: "Reviewed config.yaml path on the selected target host." }
    },
    additionalProperties: false
  };
}

function cleanupSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
