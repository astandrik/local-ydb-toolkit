import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { localYdbMcpServerVersion } from "./metadata.js";
import { getLocalYdbPrompt, localYdbPrompts } from "./prompts.js";
import { errorResult, successResult } from "./responses.js";
import { localYdbInstructions } from "./tools/instructions.js";
import { handlers, localYdbTools } from "./tools/registry.js";
import type { HandlerOptions, ToolHandler } from "./tools/context.js";

export function createLocalYdbMcpServer(options: HandlerOptions = {}): Server {
  const server = new Server(
    { name: "local-ydb-toolkit", version: localYdbMcpServerVersion },
    { capabilities: { tools: {}, prompts: {} }, instructions: localYdbInstructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: localYdbTools,
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: localYdbPrompts,
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getLocalYdbPrompt(request.params.name, request.params.arguments ?? {}),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const handler = resolveHandler(name);
    if (!handler) {
      return errorResult(`Unknown tool: ${name}`);
    }
    try {
      return successResult(
        await handler(request.params.arguments ?? {}, options),
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

function resolveHandler(name: string): ToolHandler | undefined {
  if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
    return undefined;
  }
  return handlers[name];
}
