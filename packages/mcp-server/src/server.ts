import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { localYdbMcpServerVersion } from "./metadata.js";
import { filterLocalYdbPrompts, getLocalYdbPrompt } from "./prompts.js";
import { resolveResponseContentFormat } from "./response-format.js";
import { errorResult, successResult } from "./responses.js";
import { buildLocalYdbInstructions } from "./tools/instructions.js";
import { handlers } from "./tools/registry.js";
import { filterToolDefinitions, resolveToolSelection } from "./tools/toolsets.js";
import type { HandlerOptions, ToolHandler } from "./tools/context.js";

export function createLocalYdbMcpServer(
  options: HandlerOptions = {},
  selection: readonly string[] = resolveToolSelection(),
): Server {
  const enabledDefinitions = filterToolDefinitions(selection);
  const enabledToolNames = new Set(enabledDefinitions.map((definition) => definition.name));
  const tools = enabledDefinitions.map(
    ({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    }),
  );
  const enabledHandlers = new Map(
    enabledDefinitions.map((definition) => [definition.name, definition.handler]),
  );
  const instructions = buildLocalYdbInstructions(enabledDefinitions);
  const prompts = filterLocalYdbPrompts(enabledToolNames);

  const server = new Server(
    { name: "local-ydb-toolkit", version: localYdbMcpServerVersion },
    { capabilities: { tools: {}, prompts: {} }, instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts,
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getLocalYdbPrompt(request.params.name, request.params.arguments ?? {}, enabledToolNames),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const handler = enabledHandlers.get(name);
    if (!handler) {
      return errorResult(`Unknown tool: ${name}. If this tool exists, it may be disabled by the current toolset selection; check LOCAL_YDB_MCP_TOOLSETS, LOCAL_YDB_MCP_ENABLE_TOOLS, and LOCAL_YDB_MCP_DISABLE_TOOLS and restart the MCP server.`);
    }
    try {
      const responseContentFormat = resolveResponseContentFormat(options.responseContentFormat);
      const callOptions = { ...options, responseContentFormat };
      return successResult(
        await handler(request.params.arguments ?? {}, callOptions),
        callOptions,
      );
    } catch (error) {
      return errorResult(
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  return server;
}

export async function callLocalYdbToolForTest(
  name: string,
  args: unknown,
  options: HandlerOptions = {},
): Promise<unknown> {
  const handler = resolveHandler(name);
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(args, options);
}

// Test helper intentionally resolves against the full registry, ignoring toolset filtering.
function resolveHandler(name: string): ToolHandler | undefined {
  if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
    return undefined;
  }
  return handlers[name];
}
