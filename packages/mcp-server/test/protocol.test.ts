import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { decode } from "@toon-format/toon";
import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@local-ydb-toolkit/core";
import {
  createLocalYdbMcpApplication,
  createLocalYdbMcpServer,
  getLocalYdbPrompt,
  localYdbPrompts,
  localYdbTools,
  type LocalYdbMcpApplication,
} from "../src/index.js";

type ProtocolServer = LocalYdbMcpApplication | Server;

const openConnections: Array<{ client: Client; server: ProtocolServer }> = [];

afterEach(async () => {
  for (const { client, server } of openConnections.splice(0)) {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

describe("MCP protocol contract", () => {
  it("keeps the application and compatibility factories on the same 39/8/0 surface", async () => {
    const applicationSnapshot = await protocolSnapshot(createLocalYdbMcpApplication());
    const compatibilitySnapshot = await protocolSnapshot(createLocalYdbMcpServer());

    expect(compatibilitySnapshot).toEqual(applicationSnapshot);
    expect(applicationSnapshot.capabilities.tools).toEqual({});
    expect(applicationSnapshot.capabilities.prompts).toEqual({ listChanged: true });
    expect(applicationSnapshot.capabilities.resources).toBeUndefined();
    expect(applicationSnapshot.tools).toHaveLength(39);
    expect(canonicalJson(applicationSnapshot.tools)).toBe(canonicalJson(localYdbTools));
    expect(applicationSnapshot.prompts).toHaveLength(8);
    expect(JSON.stringify(applicationSnapshot.prompts)).toBe(JSON.stringify(localYdbPrompts));
  });

  it("exposes only the supported application lifecycle surface", () => {
    const application = createLocalYdbMcpApplication();

    expect(Object.keys(application).sort()).toEqual(["close", "connect", "server"]);
    expect(application).not.toHaveProperty("registerPrompt");
    expect(application).not.toHaveProperty("registerTool");
  });

  it("renders every prompt and preserves strict prompt argument errors", async () => {
    const { client } = await connect(createLocalYdbMcpApplication());
    const promptArguments: Record<string, Record<string, string>> = {
      local_ydb_diagnose_database: { databasePath: "/local/example" },
      local_ydb_upgrade_version_workflow: { version: "26.1.2.0" },
      local_ydb_reduce_storage_groups_workflow: { count: "2" },
    };

    for (const prompt of localYdbPrompts) {
      const result = await client.getPrompt({
        name: prompt.name,
        arguments: promptArguments[prompt.name] ?? {},
      });
      expect(result.description).toBe(prompt.description);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toMatchObject({ type: "text" });
    }

    await expect(client.getPrompt({
      name: "local_ydb_upgrade_version_workflow",
      arguments: {},
    })).rejects.toThrow("Missing required argument version");
    await expect(client.getPrompt({
      name: "local_ydb_reduce_storage_groups_workflow",
      arguments: { count: "not-an-integer" },
    })).rejects.toThrow("must be an integer");
    await expect(client.getPrompt({
      name: "local_ydb_diagnose_stack",
      arguments: { confirm: "true" },
    })).rejects.toThrow("Unknown argument confirm");
    await expect(client.getPrompt({
      name: "local_ydb_diagnose_stack",
      arguments: { prototype: "untrusted" },
    })).rejects.toThrow("Unknown argument prototype");
    expect(() => getLocalYdbPrompt(
      "local_ydb_diagnose_stack",
      JSON.parse('{"__proto__":"untrusted"}') as Record<string, string>,
    )).toThrow("Unknown argument __proto__");
    await expect(client.getPrompt({
      name: "__proto__",
      arguments: {},
    })).rejects.toThrow("Prompt __proto__ not found");
  });

  it("rejects non-string arguments passed directly to the prompt helper", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["local_ydb_upgrade_version_workflow", { version: 123 }],
      ["local_ydb_diagnose_stack", { profile: false }],
    ];

    for (const [name, args] of cases) {
      let error: unknown;
      try {
        getLocalYdbPrompt(name, args);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: ErrorCode.InvalidParams });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("must be a string");
    }
  });

  it("preserves tool errors and JSON/TOON response formatting over MCP", async () => {
    for (const responseContentFormat of ["json", "toon"] as const) {
      const { client } = await connect(createLocalYdbMcpApplication({
        config: ConfigSchema.parse({}),
        responseContentFormat,
        sqlExecutor: async () => ({
          completion: "success",
          resultSets: [{
            index: 0,
            columns: [{ name: "value", type: "Int32" }],
            rows: [[1]],
            truncationReasons: [],
          }],
          capturedBytes: 36,
          truncationReasons: [],
          status: StatusIds_StatusCode.SUCCESS,
        }),
      }));

      const unknown = await client.callTool({ name: "local_ydb_missing", arguments: {} });
      expect(unknown).toMatchObject({
        isError: true,
        structuredContent: { error: "Unknown tool: local_ydb_missing" },
      });

      const invalid = await client.callTool({
        name: "local_ydb_sql",
        arguments: { script: "" },
      });
      expect(invalid).toMatchObject({
        isError: true,
        structuredContent: { error: expect.any(String) },
      });

      const result = await client.callTool({
        name: "local_ydb_sql",
        arguments: { script: "SELECT 1;" },
      });
      const text = textContentAt(result.content, 1);
      const jsonModel = JSON.parse(JSON.stringify(result.structuredContent)) as unknown;

      expect(result.structuredContent).toMatchObject({
        action: "query",
        resultSets: [{ rows: [[1]] }],
      });
      expect(responseContentFormat === "json" ? JSON.parse(text) : decode(text)).toEqual(jsonModel);
    }
  });

  it("returns safe structured config errors without parser snippets or paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-mcp-config-error-"));
    const configPath = join(dir, "config.json");
    const marker = "BENIGN_MCP_CONFIG_MARKER";
    writeFileSync(configPath, `${marker}\n`, "utf8");
    try {
      const { client } = await connect(createLocalYdbMcpApplication());
      const result = await client.callTool({
        name: "local_ydb_inventory",
        arguments: { configPath },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "CONFIG_INVALID_JSON",
          error: expect.any(String),
        },
      });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(JSON.stringify(result)).not.toContain(configPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown top-level MCP tool arguments", async () => {
    const { client } = await connect(createLocalYdbMcpApplication({
      config: ConfigSchema.parse({}),
    }));
    const result = await client.callTool({
      name: "local_ydb_inventory",
      arguments: { unexpected: true },
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: expect.any(String) },
    });
  });

  it("propagates client cancellation to the tool handler abort signal", async () => {
    let startedResolve: (() => void) | undefined;
    let cancelledResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      cancelledResolve = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const { client } = await connect(createLocalYdbMcpApplication({
      config: ConfigSchema.parse({}),
      sqlExecutor: async (_context, request) => {
        observedSignal = request.signal;
        startedResolve?.();
        await new Promise<void>((resolve) => {
          const finish = () => {
            cancelledResolve?.();
            resolve();
          };
          if (request.signal?.aborted) {
            finish();
          } else {
            request.signal?.addEventListener("abort", finish, { once: true });
          }
        });
        return {
          completion: "cancelled",
          resultSets: [],
          capturedBytes: 0,
          truncationReasons: [],
        };
      },
    }));
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "local_ydb_sql", arguments: { script: "SELECT 1;" } },
      undefined,
      { signal: controller.signal },
    );

    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await cancelled;
    expect(observedSignal?.aborted).toBe(true);
  });
});

async function protocolSnapshot(server: ProtocolServer): Promise<{
  capabilities: NonNullable<ReturnType<Client["getServerCapabilities"]>>;
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
  prompts: Awaited<ReturnType<Client["listPrompts"]>>["prompts"];
}> {
  const { client } = await connect(server);
  const tools = await client.listTools();
  const prompts = await client.listPrompts();
  await expect(client.listResources()).rejects.toMatchObject({
    code: ErrorCode.MethodNotFound,
  });

  return {
    capabilities: client.getServerCapabilities() ?? {},
    tools: tools.tools,
    prompts: prompts.prompts,
  };
}

async function connect(server: ProtocolServer): Promise<{ client: Client }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "local-ydb-toolkit-protocol-test", version: "0.0.0" },
    { capabilities: {} },
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openConnections.push({ client, server });
  return { client };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue: unknown) => {
    if (!currentValue || Array.isArray(currentValue) || typeof currentValue !== "object") {
      return currentValue;
    }
    return Object.fromEntries(
      Object.entries(currentValue as Record<string, unknown>).sort(([left], [right]) => (
        left < right ? -1 : left > right ? 1 : 0
      )),
    );
  });
}

function textContentAt(content: unknown, index: number): string {
  if (!Array.isArray(content)) {
    throw new Error("Expected MCP tool content to be an array");
  }
  const item: unknown = content[index];
  if (
    !item
    || typeof item !== "object"
    || !("type" in item)
    || item.type !== "text"
    || !("text" in item)
    || typeof item.text !== "string"
  ) {
    throw new Error(`Expected MCP tool content ${index} to be text`);
  }
  return item.text;
}
