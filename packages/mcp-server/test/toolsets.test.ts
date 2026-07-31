import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  createLocalYdbMcpServer,
  getLocalYdbPrompt,
  resolveToolSelection,
  resolveToolSelectionFromEnv,
  toolsetPresets,
} from "../src/index.js";
import { toolDefinitions } from "../src/tools/registry.js";

type TextContentForTest = {
  type: "text";
  text: string;
};

type ToolResultForTest = {
  isError?: boolean;
  content: TextContentForTest[];
  structuredContent?: unknown;
};

type ServerForTest = {
  _instructions?: string;
  _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
};

function requestHandler(server: unknown, method: string) {
  const handler = (server as ServerForTest)._requestHandlers.get(method);
  if (!handler) {
    throw new Error(`Expected ${method} handler to be registered`);
  }
  return handler;
}

const registryNames = toolDefinitions.map((definition) => definition.name);

describe("toolset presets", () => {
  it("covers the full registry with the all preset", () => {
    expect([...toolsetPresets.all].sort()).toEqual([...registryNames].sort());
    expect(toolsetPresets.all).toHaveLength(38);
  });

  it("references only registered tools from every preset", () => {
    const registered = new Set(registryNames);
    for (const [preset, names] of Object.entries(toolsetPresets)) {
      for (const name of names) {
        expect(registered.has(name), `${preset} references unknown tool ${name}`).toBe(true);
      }
    }
  });

  it("places every tool in at least one non-all preset", () => {
    const curated = new Set<string>([
      ...toolsetPresets.diagnostics,
      ...toolsetPresets.developer,
      ...toolsetPresets.operator,
      ...toolsetPresets.security,
    ]);
    for (const name of registryNames) {
      expect(curated.has(name), `${name} is not placed in any preset`).toBe(true);
    }
  });

  it("nests diagnostics inside developer inside operator", () => {
    const developer = new Set(toolsetPresets.developer);
    const operator = new Set(toolsetPresets.operator);
    for (const name of toolsetPresets.diagnostics) {
      expect(developer.has(name)).toBe(true);
    }
    for (const name of toolsetPresets.developer) {
      expect(operator.has(name)).toBe(true);
    }
  });

  it("has the documented preset sizes", () => {
    expect(toolsetPresets.diagnostics).toHaveLength(14);
    expect(toolsetPresets.developer).toHaveLength(26);
    expect(toolsetPresets.operator).toHaveLength(33);
    expect(toolsetPresets.security).toHaveLength(7);
  });
});

describe("resolveToolSelectionFromEnv", () => {
  it("defaults to all tools in registry order", () => {
    expect(resolveToolSelectionFromEnv({})).toEqual(registryNames);
  });

  it("treats an empty toolsets value as all", () => {
    expect(resolveToolSelectionFromEnv({ toolsets: "  " })).toEqual(registryNames);
  });

  it("resolves a single preset", () => {
    const selection = resolveToolSelectionFromEnv({ toolsets: "diagnostics" });
    expect(selection).toHaveLength(14);
    expect(selection).toContain("local_ydb_status_report");
    expect(selection).not.toContain("local_ydb_bootstrap");
  });

  it("unions multiple presets", () => {
    const selection = resolveToolSelectionFromEnv({ toolsets: "diagnostics, security" });
    expect(selection).toHaveLength(19);
    expect(selection).toContain("local_ydb_permissions");
    expect(selection).toContain("local_ydb_healthcheck");
  });

  it("adds tools through enable overrides", () => {
    const selection = resolveToolSelectionFromEnv({
      toolsets: "diagnostics",
      enableTools: "local_ydb_bootstrap",
    });
    expect(selection).toHaveLength(15);
    expect(selection).toContain("local_ydb_bootstrap");
  });

  it("removes tools through disable overrides", () => {
    const selection = resolveToolSelectionFromEnv({
      toolsets: "diagnostics",
      disableTools: "local_ydb_scheme",
    });
    expect(selection).toHaveLength(13);
    expect(selection).not.toContain("local_ydb_scheme");
  });

  it("lets disable win over enable", () => {
    const selection = resolveToolSelectionFromEnv({
      toolsets: "all",
      enableTools: "local_ydb_scheme",
      disableTools: "local_ydb_scheme",
    });
    expect(selection).not.toContain("local_ydb_scheme");
    expect(selection).toHaveLength(37);
  });

  it("rejects unknown toolset names", () => {
    expect(() => resolveToolSelectionFromEnv({ toolsets: "bogus" })).toThrowError(
      /Invalid LOCAL_YDB_MCP_TOOLSETS: unknown toolset "bogus"\. Expected a comma-separated list of: diagnostics, developer, operator, security, all\./,
    );
  });

  it("rejects unknown tool names in enable and disable lists", () => {
    expect(() => resolveToolSelectionFromEnv({ enableTools: "local_ydb_bogus" })).toThrowError(
      /Invalid LOCAL_YDB_MCP_ENABLE_TOOLS: unknown tool "local_ydb_bogus"\./,
    );
    expect(() => resolveToolSelectionFromEnv({ disableTools: "local_ydb_bogus" })).toThrowError(
      /Invalid LOCAL_YDB_MCP_DISABLE_TOOLS: unknown tool "local_ydb_bogus"\./,
    );
  });

  it("preserves registry order regardless of preset order", () => {
    const selection = resolveToolSelectionFromEnv({ toolsets: "security,diagnostics" });
    const positions = selection.map((name) => registryNames.indexOf(name));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});

describe("resolveToolSelection", () => {
  it("reads selection from process env", () => {
    const previous = {
      toolsets: process.env.LOCAL_YDB_MCP_TOOLSETS,
      enable: process.env.LOCAL_YDB_MCP_ENABLE_TOOLS,
      disable: process.env.LOCAL_YDB_MCP_DISABLE_TOOLS,
    };
    try {
      process.env.LOCAL_YDB_MCP_TOOLSETS = "diagnostics";
      delete process.env.LOCAL_YDB_MCP_ENABLE_TOOLS;
      delete process.env.LOCAL_YDB_MCP_DISABLE_TOOLS;
      expect(resolveToolSelection()).toHaveLength(14);
    } finally {
      if (previous.toolsets === undefined) {
        delete process.env.LOCAL_YDB_MCP_TOOLSETS;
      } else {
        process.env.LOCAL_YDB_MCP_TOOLSETS = previous.toolsets;
      }
      if (previous.enable === undefined) {
        delete process.env.LOCAL_YDB_MCP_ENABLE_TOOLS;
      } else {
        process.env.LOCAL_YDB_MCP_ENABLE_TOOLS = previous.enable;
      }
      if (previous.disable === undefined) {
        delete process.env.LOCAL_YDB_MCP_DISABLE_TOOLS;
      } else {
        process.env.LOCAL_YDB_MCP_DISABLE_TOOLS = previous.disable;
      }
    }
  });
});

describe("toolset-filtered server", () => {
  const diagnosticsSelection = resolveToolSelectionFromEnv({ toolsets: "diagnostics" });

  it("lists only the enabled tools", async () => {
    const server = createLocalYdbMcpServer({}, diagnosticsSelection);
    const handler = requestHandler(server, "tools/list");
    const result = await handler({ method: "tools/list", params: {} }, {}) as {
      tools: Array<{ name: string }>;
    };
    expect(result.tools.map((tool) => tool.name)).toEqual(diagnosticsSelection);
  });

  it("rejects calls to disabled tools", async () => {
    const server = createLocalYdbMcpServer({}, diagnosticsSelection);
    const handler = requestHandler(server, "tools/call");
    const result = await handler({
      method: "tools/call",
      params: { name: "local_ydb_bootstrap", arguments: {} },
    }, {}) as ToolResultForTest;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown tool: local_ydb_bootstrap");
  });

  it("rebuilds instructions without references to disabled tools", () => {
    const server = createLocalYdbMcpServer({}, diagnosticsSelection) as unknown as ServerForTest;
    expect(server._instructions).toContain("local_ydb_status_report");
    expect(server._instructions).toContain("local_ydb_healthcheck");
    expect(server._instructions).not.toContain("local_ydb_bootstrap");
    expect(server._instructions).not.toContain("local_ydb_check_prerequisites");
    expect(server._instructions).not.toContain("local_ydb_apply_schema");
    expect(server._instructions).not.toContain("auth: local_ydb");
  });

  it("keeps full instructions when every tool is enabled", () => {
    const server = createLocalYdbMcpServer() as unknown as ServerForTest;
    expect(server._instructions).toContain("local_ydb_check_prerequisites");
    expect(server._instructions).toContain("local_ydb_upgrade_version");
    expect(server._instructions).toContain("PENDING_RESOURCES");
  });

  it("lists only prompts covered by the enabled tools", async () => {
    const server = createLocalYdbMcpServer({}, diagnosticsSelection);
    const handler = requestHandler(server, "prompts/list");
    const result = await handler({ method: "prompts/list", params: {} }, {}) as {
      prompts: Array<{ name: string }>;
    };
    expect(result.prompts.map((prompt) => prompt.name).sort()).toEqual([
      "local_ydb_diagnose_database",
      "local_ydb_diagnose_stack",
    ]);
  });

  it("rejects prompts that need disabled tools", async () => {
    const server = createLocalYdbMcpServer({}, diagnosticsSelection);
    const handler = requestHandler(server, "prompts/get");
    await expect(handler({
      method: "prompts/get",
      params: { name: "local_ydb_upgrade_version_workflow", arguments: { version: "25.2.1.7" } },
    }, {})).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining("Prompt local_ydb_upgrade_version_workflow not found"),
    });
  });

  it("serves prompts that are fully covered", async () => {
    const server = createLocalYdbMcpServer({}, diagnosticsSelection);
    const handler = requestHandler(server, "prompts/get");
    const result = await handler({
      method: "prompts/get",
      params: { name: "local_ydb_diagnose_stack", arguments: {} },
    }, {}) as { messages: Array<{ content: { text: string } }> };
    expect(result.messages[0]?.content.text).toContain("local_ydb_status_report");
  });

  it("keeps security preset prompts and tools consistent", async () => {
    const securitySelection = resolveToolSelectionFromEnv({ toolsets: "security" });
    const server = createLocalYdbMcpServer({}, securitySelection);
    const promptsHandler = requestHandler(server, "prompts/list");
    const result = await promptsHandler({ method: "prompts/list", params: {} }, {}) as {
      prompts: Array<{ name: string }>;
    };
    expect(result.prompts.map((prompt) => prompt.name)).toEqual([
      "local_ydb_auth_hardening_workflow",
    ]);
  });

  it("derives the enabled surface from registered definitions, not raw selection names", async () => {
    const server = createLocalYdbMcpServer({}, ["local_ydb_bogus_tool"]);
    const toolsHandler = requestHandler(server, "tools/list");
    const toolsResult = await toolsHandler({ method: "tools/list", params: {} }, {}) as {
      tools: Array<{ name: string }>;
    };
    expect(toolsResult.tools).toEqual([]);
    const promptsHandler = requestHandler(server, "prompts/list");
    const promptsResult = await promptsHandler({ method: "prompts/list", params: {} }, {}) as {
      prompts: Array<{ name: string }>;
    };
    expect(promptsResult.prompts).toEqual([]);
  });

  it("produces coherent instructions when every tool is disabled", () => {
    const server = createLocalYdbMcpServer({}, []) as unknown as ServerForTest;
    expect(server._instructions).toContain("No local-ydb tools are enabled.");
    expect(server._instructions).not.toContain("by category: .");
  });
});

describe("getLocalYdbPrompt with enabled tools", () => {
  it("throws not found for prompts outside the enabled set", () => {
    const enabled = new Set(resolveToolSelectionFromEnv({ toolsets: "diagnostics" }));
    expect(() => getLocalYdbPrompt("local_ydb_bootstrap_root_workflow", {}, enabled)).toThrowError(
      /Prompt local_ydb_bootstrap_root_workflow not found/,
    );
  });
});
