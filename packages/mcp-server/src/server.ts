import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { localYdbMcpServerVersion } from "./metadata.js";
import { getLocalYdbPrompt, registerLocalYdbPrompts } from "./prompts.js";
import { resolveResponseContentFormat } from "./response-format.js";
import { errorResult, successResult } from "./responses.js";
import { localYdbInstructions } from "./tools/instructions.js";
import { handlers, localYdbTools } from "./tools/registry.js";
import type { HandlerOptions, ToolHandler } from "./tools/context.js";

export function createLocalYdbMcpApplication(options: HandlerOptions = {}): McpServer {
  const application = new McpServer(
    { name: "local-ydb-toolkit", version: localYdbMcpServerVersion },
    { capabilities: { tools: {} }, instructions: localYdbInstructions },
  );
  const { server } = application;

  registerLocalYdbPrompts(application);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: localYdbTools,
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getLocalYdbPrompt(request.params.name, request.params.arguments ?? {}),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const handler = resolveHandler(name);
    if (!handler) {
      return errorResult(`Unknown tool: ${name}`);
    }
    try {
      const responseContentFormat = resolveResponseContentFormat(options.responseContentFormat);
      const callOptions = {
        ...options,
        responseContentFormat,
        signal: extra.signal ?? options.signal,
      };
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

  return application;
}

/** @deprecated Use createLocalYdbMcpApplication for new integrations. */
export function createLocalYdbMcpServer(options: HandlerOptions = {}): Server {
  return createLocalYdbMcpApplication(options).server;
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
