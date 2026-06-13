import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import {
  commandToShell,
  ConfigSchema,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  type ResolvedLocalYdbProfile
} from "@local-ydb-toolkit/core";
import {
  callLocalYdbToolForTest,
  createLocalYdbMcpServer,
  getLocalYdbPrompt,
  localYdbInstructions,
  localYdbMcpServerVersion,
  localYdbPrompts,
  localYdbTools
} from "../src/index.js";
import { normalizeResponseContentFormat } from "../src/response-format.js";
import { successResult } from "../src/responses.js";
import { toolDefinitions } from "../src/tools/registry.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
}).version;

type TextContentForTest = {
  type: "text";
  text: string;
};

type ToolResultForTest = {
  isError?: boolean;
  content: TextContentForTest[];
  structuredContent?: unknown;
};

const responseFixture = {
  summary: "Example local-ydb response.",
  executed: false,
  plannedCommands: ["docker ps -a", "docker volume ls"],
  verification: ["containers are listed", "volumes are listed"],
  checks: [
    { name: "docker", ok: true },
    { name: "curl", ok: false },
  ],
};

const responseFixtureJsonModel = {
  summary: "Example response with optional fields.",
  optional: undefined,
  nested: [
    { name: "docker", ok: true, note: undefined },
  ],
};

const responseFixtureLogText = {
  summary: "Example log response.",
  ok: true,
  stdout: "2026 INFO [actor]\tmessage: value\nnext",
  stderr: "",
};

class RecordingExecutor implements CommandExecutor {
  readonly commands: string[] = [];

  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    const command = this.display(profile, spec);
    this.commands.push(command);
    if (command.includes("docker ps -a --format")) {
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    }
    if (command.includes("docker volume ls")) {
      return { command, exitCode: 0, stdout: "ydb-local-data\n", stderr: "", ok: true, timedOut: false };
    }
    if (command.includes("docker inspect")) {
      return { command, exitCode: 0, stdout: "[]", stderr: "", ok: true, timedOut: false };
    }
    return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
  }
}

function expectInvalidPromptRequest(run: () => unknown, message: string): void {
  let threw = false;
  let caughtError: unknown;
  try {
    run();
  } catch (error) {
    threw = true;
    caughtError = error;
  }
  if (!threw) {
    throw new Error("Expected prompt request to fail");
  }
  expect(caughtError).toMatchObject({ code: ErrorCode.InvalidParams });
  expect(caughtError).toBeInstanceOf(Error);
  expect((caughtError as Error).message).toContain(message);
}

describe("mcp tools", () => {
  it("registers all public local-ydb tools", () => {
    expect(localYdbTools.map((tool) => tool.name).sort()).toEqual([
      "local_ydb_add_dynamic_nodes",
      "local_ydb_add_storage_groups",
      "local_ydb_apply_auth_hardening",
      "local_ydb_apply_schema",
      "local_ydb_auth_check",
      "local_ydb_bootstrap",
      "local_ydb_bootstrap_root_database",
      "local_ydb_check_prerequisites",
      "local_ydb_cleanup_storage",
      "local_ydb_container_logs",
      "local_ydb_create_tenant",
      "local_ydb_database_status",
      "local_ydb_destroy_stack",
      "local_ydb_dump_tenant",
      "local_ydb_generate_schema",
      "local_ydb_graphshard_check",
      "local_ydb_healthcheck",
      "local_ydb_inventory",
      "local_ydb_list_dumps",
      "local_ydb_list_versions",
      "local_ydb_nodes_check",
      "local_ydb_permissions",
      "local_ydb_prepare_auth_config",
      "local_ydb_pull_image",
      "local_ydb_pull_status",
      "local_ydb_reduce_storage_groups",
      "local_ydb_remove_dynamic_nodes",
      "local_ydb_restart_stack",
      "local_ydb_restore_tenant",
      "local_ydb_scheme",
      "local_ydb_set_root_password",
      "local_ydb_start_dynamic_node",
      "local_ydb_status_report",
      "local_ydb_storage_leftovers",
      "local_ydb_storage_placement",
      "local_ydb_tenant_check",
      "local_ydb_upgrade_version",
      "local_ydb_write_dynamic_auth_config"
    ]);
  });

  it("defaults response text content formatting to JSON", () => {
    expect(normalizeResponseContentFormat(undefined)).toBe("json");
  });

  it("formats response text content as JSON when forced", () => {
    const result = successResult(responseFixture, {
      responseContentFormat: "json",
    }) as ToolResultForTest;

    expect(result.content[1]?.text).toBe(JSON.stringify(responseFixture, null, 2));
    expect(result.structuredContent).toBe(responseFixture);
  });

  it("formats response text content as TOON when forced", () => {
    const result = successResult(responseFixture, {
      responseContentFormat: "toon",
    }) as ToolResultForTest;

    expect(result.content[1]?.text).not.toBe(JSON.stringify(responseFixture, null, 2));
    expect(decode(result.content[1]?.text ?? "")).toEqual(responseFixture);
    expect(result.structuredContent).toBe(responseFixture);
  });

  it("formats TOON against the JSON data model for optional fields", () => {
    const result = successResult(responseFixtureJsonModel, {
      responseContentFormat: "toon",
    }) as ToolResultForTest;
    const jsonModel = JSON.parse(JSON.stringify(responseFixtureJsonModel)) as unknown;

    expect(decode(result.content[1]?.text ?? "")).toEqual(jsonModel);
    expect(result.structuredContent).toBe(responseFixtureJsonModel);
  });

  it("falls back to JSON when TOON would not decode losslessly", () => {
    const result = successResult(responseFixtureLogText, {
      responseContentFormat: "toon",
    }) as ToolResultForTest;

    expect(JSON.parse(result.content[1]?.text ?? "")).toEqual(responseFixtureLogText);
    expect(result.structuredContent).toBe(responseFixtureLogText);
  });

  it("rejects invalid response text content format through tool errors", async () => {
    const server = createLocalYdbMcpServer({
      responseContentFormat: "xml" as "json",
    }) as unknown as {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
    };
    const handler = server._requestHandlers.get("tools/call");
    if (!handler) {
      throw new Error("Expected tools/call handler to be registered");
    }

    const result = await handler({
      method: "tools/call",
      params: {
        name: "local_ydb_pull_status",
        arguments: { jobId: "missing-job" },
      },
    }, {}) as ToolResultForTest;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid LOCAL_YDB_MCP_CONTENT_FORMAT");
    expect(result.structuredContent).toMatchObject({
      error: expect.stringContaining("expected \"json\" or \"toon\""),
    });
  });

  it("rejects invalid response text content format before confirmed mutations run", async () => {
    const executor = new RecordingExecutor();
    const server = createLocalYdbMcpServer({
      config: ConfigSchema.parse({}),
      executor,
      responseContentFormat: "xml" as "json",
    }) as unknown as {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
    };
    const handler = server._requestHandlers.get("tools/call");
    if (!handler) {
      throw new Error("Expected tools/call handler to be registered");
    }

    const result = await handler({
      method: "tools/call",
      params: {
        name: "local_ydb_bootstrap_root_database",
        arguments: { confirm: true },
      },
    }, {}) as ToolResultForTest;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid LOCAL_YDB_MCP_CONTENT_FORMAT");
    expect(executor.commands).toHaveLength(0);
  });

  it("describes every top-level tool input parameter", () => {
    for (const tool of localYdbTools) {
      for (const [propertyName, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(schema, `${tool.name}.${propertyName}`).toMatchObject({
          description: expect.any(String)
        });
        expect((schema as { description?: string }).description?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("annotates tools with behavioral hints", () => {
    const readOnlyTools = new Set([
      "local_ydb_auth_check",
      "local_ydb_container_logs",
      "local_ydb_database_status",
      "local_ydb_generate_schema",
      "local_ydb_graphshard_check",
      "local_ydb_healthcheck",
      "local_ydb_inventory",
      "local_ydb_list_dumps",
      "local_ydb_list_versions",
      "local_ydb_nodes_check",
      "local_ydb_pull_status",
      "local_ydb_scheme",
      "local_ydb_status_report",
      "local_ydb_storage_leftovers",
      "local_ydb_storage_placement",
      "local_ydb_tenant_check"
    ]);
    const destructiveTools = new Set([
      "local_ydb_apply_schema",
      "local_ydb_cleanup_storage",
      "local_ydb_destroy_stack",
      "local_ydb_permissions",
      "local_ydb_reduce_storage_groups",
      "local_ydb_remove_dynamic_nodes",
      "local_ydb_restore_tenant",
      "local_ydb_upgrade_version"
    ]);

    for (const tool of localYdbTools) {
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: readOnlyTools.has(tool.name),
        destructiveHint: destructiveTools.has(tool.name),
        openWorldHint: true
      });
      expect(typeof tool.annotations?.idempotentHint).toBe("boolean");
    }
  });

  it("documents usage and safety cues for Glama low-scoring tools", () => {
    const qualityTargets = [
      "local_ydb_add_dynamic_nodes",
      "local_ydb_add_storage_groups",
      "local_ydb_apply_auth_hardening",
      "local_ydb_auth_check",
      "local_ydb_bootstrap",
      "local_ydb_bootstrap_root_database",
      "local_ydb_check_prerequisites",
      "local_ydb_cleanup_storage",
      "local_ydb_container_logs",
      "local_ydb_database_status",
      "local_ydb_dump_tenant",
      "local_ydb_graphshard_check",
      "local_ydb_healthcheck",
      "local_ydb_inventory",
      "local_ydb_list_dumps",
      "local_ydb_list_versions",
      "local_ydb_nodes_check",
      "local_ydb_permissions",
      "local_ydb_prepare_auth_config",
      "local_ydb_pull_image",
      "local_ydb_restart_stack",
      "local_ydb_restore_tenant",
      "local_ydb_scheme",
      "local_ydb_start_dynamic_node",
      "local_ydb_status_report",
      "local_ydb_storage_leftovers",
      "local_ydb_storage_placement",
      "local_ydb_tenant_check",
      "local_ydb_upgrade_version",
      "local_ydb_write_dynamic_auth_config"
    ];

    for (const toolName of qualityTargets) {
      const tool = localYdbTools.find((candidate) => candidate.name === toolName);
      expect(tool?.description, toolName).toMatch(/use|read-only|without confirm=true/i);
    }
  });

  it("registers stable public local-ydb prompts", () => {
    expect(localYdbPrompts.map((prompt) => prompt.name)).toEqual([
      "local_ydb_diagnose_stack",
      "local_ydb_diagnose_database",
      "local_ydb_bootstrap_root_workflow",
      "local_ydb_bootstrap_tenant_workflow",
      "local_ydb_upgrade_version_workflow",
      "local_ydb_auth_hardening_workflow",
      "local_ydb_reduce_storage_groups_workflow",
      "local_ydb_schema_generate_apply_workflow"
    ]);
  });

  it("marks required prompt arguments in metadata", () => {
    const upgrade = localYdbPrompts.find((prompt) => prompt.name === "local_ydb_upgrade_version_workflow");
    const auth = localYdbPrompts.find((prompt) => prompt.name === "local_ydb_auth_hardening_workflow");
    const reduceStorage = localYdbPrompts.find((prompt) => prompt.name === "local_ydb_reduce_storage_groups_workflow");

    expect(upgrade?.arguments).toContainEqual(expect.objectContaining({
      name: "version",
      required: true
    }));
    expect(auth?.arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "configHostPath" }),
      expect.objectContaining({ name: "sid" }),
      expect.objectContaining({ name: "tokenHostPath" })
    ]));
    expect(reduceStorage?.arguments).toContainEqual(expect.objectContaining({
      name: "count",
      required: true,
      description: expect.stringContaining("storage groups to remove")
    }));
    expect(reduceStorage?.arguments).toContainEqual(expect.objectContaining({
      name: "count",
      description: expect.stringContaining("1-10")
    }));
  });

  it("renders prompt messages for local-ydb workflows", () => {
    const result = getLocalYdbPrompt("local_ydb_upgrade_version_workflow", {
      version: "26.1.2.0",
      profile: "demo",
      configPath: "/path/to/local-ydb.config.json"
    });

    expect(result.description).toContain("version upgrade");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: { type: "text" }
    });

    const text = result.messages[0]?.content.type === "text"
      ? result.messages[0].content.text
      : "";
    expect(text).toContain("local_ydb_list_versions");
    expect(text).toContain("pass image set to the exact target image");
    expect(text).toContain("repeat the same local_ydb_pull_image call with confirm=true");
    expect(text).toContain("returned jobId");
    expect(text).toContain("local_ydb_upgrade_version");
    expect(text).toContain("Call mutating tools without confirm first");
    expect(text).toContain("confirm=true only after the user explicitly approves");
    expect(text).toContain("\"profile\": \"demo\"");
  });

  it("renders database diagnostics prompt with healthcheck-first guidance", () => {
    const result = getLocalYdbPrompt("local_ydb_diagnose_database", {
      profile: "demo",
      databasePath: "/local/example"
    });
    const text = result.messages[0]?.content.type === "text"
      ? result.messages[0].content.text
      : "";

    expect(result.description).toContain("database diagnostics");
    expect(text).toContain("local_ydb_healthcheck");
    expect(text).toContain("Then route by healthcheck issue type");
    expect(text).toContain("STORAGE");
    expect(text).toContain("COMPUTE");
    expect(text).toContain("\"databasePath\": \"/local/example\"");
  });

  it("renders auth hardening artifact creation before apply", () => {
    const result = getLocalYdbPrompt("local_ydb_auth_hardening_workflow", {
      sid: "root@builtin",
      tokenHostPath: "/tmp/dynamic-auth.txt"
    });
    const text = result.messages[0]?.content.type === "text"
      ? result.messages[0].content.text
      : "";

    expect(text).toContain("local_ydb_prepare_auth_config with confirm=true");
    expect(text).toContain("local_ydb_write_dynamic_auth_config with confirm=true");
    expect(text).toContain("Then call local_ydb_apply_auth_hardening without confirm");
    expect(text).toContain("\"sid\": \"root@builtin\"");
    expect(text).toContain("\"tokenHostPath\": \"/tmp/dynamic-auth.txt\"");
  });

  it("renders storage reduction count as groups to remove", () => {
    const result = getLocalYdbPrompt("local_ydb_reduce_storage_groups_workflow", {
      count: "2"
    });
    const text = result.messages[0]?.content.type === "text"
      ? result.messages[0].content.text
      : "";

    expect(text).toContain("Plan removal of 2 storage group(s).");
    expect(text).toContain("count as the number of groups to remove");
    expect(text).toContain("poolName");
    expect(text).toContain("dynamic_storage_pool:1");
    expect(text).toContain("Storage pool not found");
    expect(text).not.toContain("storage pool was not found");
    expect(text).not.toContain("storage groups to keep");
  });

  it("renders schema generation workflow prompt", () => {
    const result = getLocalYdbPrompt("local_ydb_schema_generate_apply_workflow", {
      profile: "ghcr261-auth",
      scenario: "column partition",
      tableName: "tmp_probe"
    });
    const text = result.messages[0]?.content.type === "text"
      ? result.messages[0].content.text
      : "";

    expect(text).toContain("local_ydb_status_report");
    expect(text).toContain("local_ydb_generate_schema with validate=true");
    expect(text).toContain("local_ydb_apply_schema action=validate");
    expect(text).toContain("action=apply with confirm=false");
    expect(text).toContain("confirm=true only after");
    expect(text).toContain("with.STORE");
    expect(text).toContain("partitionByHash only with store: \"column\" and primaryKey columns");
    expect(text).toContain("vector_kmeans_tree");
    expect(text).toContain("\"scenario\": \"column partition\"");
    expect(text).toContain("\"tableName\": \"tmp_probe\"");
  });

  it("renders bootstrap prompts with plan-only prerequisites first", () => {
    const root = getLocalYdbPrompt("local_ydb_bootstrap_root_workflow");
    const tenant = getLocalYdbPrompt("local_ydb_bootstrap_tenant_workflow");
    const rootText = root.messages[0]?.content.type === "text"
      ? root.messages[0].content.text
      : "";
    const tenantText = tenant.messages[0]?.content.type === "text"
      ? tenant.messages[0].content.text
      : "";
    const rootPrerequisitesIndex = rootText.indexOf("local_ydb_check_prerequisites without confirm first");
    const rootBootstrapIndex = rootText.indexOf("local_ydb_bootstrap_root_database without confirm");
    const tenantPrerequisitesIndex = tenantText.indexOf("local_ydb_check_prerequisites without confirm first");
    const tenantBootstrapIndex = tenantText.indexOf("local_ydb_bootstrap without confirm");

    expect(rootText).toContain("local_ydb_check_prerequisites without confirm first");
    expect(tenantText).toContain("local_ydb_check_prerequisites without confirm first");
    expect(rootPrerequisitesIndex).toBeGreaterThanOrEqual(0);
    expect(rootBootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(rootPrerequisitesIndex).toBeLessThan(rootBootstrapIndex);
    expect(tenantPrerequisitesIndex).toBeGreaterThanOrEqual(0);
    expect(tenantBootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(tenantPrerequisitesIndex).toBeLessThan(tenantBootstrapIndex);
  });

  it("renders every listed prompt", () => {
    const promptArgs: Record<string, Record<string, string>> = {
      local_ydb_diagnose_database: { databasePath: "/local/example" },
      local_ydb_upgrade_version_workflow: { version: "26.1.2.0" },
      local_ydb_reduce_storage_groups_workflow: { count: "2" }
    };

    for (const prompt of localYdbPrompts) {
      const result = getLocalYdbPrompt(prompt.name, promptArgs[prompt.name] ?? {});
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.role).toBe("user");
      expect(result.messages[0]?.content.type).toBe("text");
    }
  });

  it("validates required prompt arguments", () => {
    expectInvalidPromptRequest(
      () => getLocalYdbPrompt("local_ydb_upgrade_version_workflow", {}),
      "Missing required argument version",
    );
    expectInvalidPromptRequest(
      () => getLocalYdbPrompt("local_ydb_reduce_storage_groups_workflow", {
        count: "11"
      }),
      "must be between 1 and 10",
    );
    expectInvalidPromptRequest(
      () => getLocalYdbPrompt("local_ydb_diagnose_stack", {
        confirm: "true"
      }),
      "Unknown argument confirm",
    );
  });

  it("rejects unknown prompt names", () => {
    expectInvalidPromptRequest(
      () => getLocalYdbPrompt("__proto__", {}),
      "Prompt __proto__ not found",
    );
  });

  it("returns plan-only output for mutating tools without confirm", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_bootstrap", {}, {
      config: ConfigSchema.parse({})
    }) as { executed: boolean; plannedCommands: string[] };
    expect(result.executed).toBe(false);
    expect(result.plannedCommands.length).toBeGreaterThan(0);
  });

  it("lists dumps through the public MCP handler", async () => {
    const executor = new RecordingExecutor();
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return { command, exitCode: 0, stdout: "mcp-smoke\n", stderr: "", ok: true, timedOut: false };
    };

    const result = await callLocalYdbToolForTest("local_ydb_list_dumps", {}, {
      config: ConfigSchema.parse({}),
      executor
    }) as { ok: boolean; dumps: Array<{ name: string; hostPath: string; tenantDumpPath: string }> };

    expect(result.ok).toBe(true);
    expect(result.dumps).toEqual([
      {
        name: "mcp-smoke",
        hostPath: "/tmp/local-ydb-dump/mcp-smoke",
        tenantDumpPath: "/tmp/local-ydb-dump/mcp-smoke/tenant"
      }
    ]);
  });

  it("passes path-level dump args through the MCP handler", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_dump_tenant", {
      dumpName: "path-smoke",
      path: "dir/table"
    }, {
      config: ConfigSchema.parse({})
    }) as { executed: boolean; plannedCommands: string[] };

    expect(result.executed).toBe(false);
    expect(result.plannedCommands.join("\n")).toContain("tools dump -p dir/table");
  });

  it("rejects blank dump args at the MCP argument layer", async () => {
    for (const field of ["dumpName", "path"]) {
      for (const value of ["", "   "]) {
        await expect(callLocalYdbToolForTest("local_ydb_dump_tenant", {
          [field]: value,
        }, {
          config: ConfigSchema.parse({})
        })).rejects.toThrow("String must contain at least 1 character");
      }
    }
  });

  it("passes restore verification hooks through the MCP handler", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_restore_tenant", {
      dumpName: "path-smoke",
      path: "restore-root",
      describePaths: ["restore-root/table"],
      countQueries: [{ label: "rows", query: "SELECT COUNT(*) FROM `restore-root/table`;" }]
    }, {
      config: ConfigSchema.parse({})
    }) as { executed: boolean; plannedCommands: string[] };

    expect(result.executed).toBe(false);
    expect(result.plannedCommands).toHaveLength(3);
    expect(result.plannedCommands[0]).toContain("tools restore -p restore-root");
    expect(result.plannedCommands[1]).toContain("scheme describe /local/example/restore-root/table");
    expect(result.plannedCommands[2]).toContain("sql -s 'SELECT COUNT(*) FROM `restore-root/table`;'");
  });

  it("rejects count queries that exceed the byte limit before core execution", async () => {
    const multibyteTable = "界".repeat(1400);

    await expect(callLocalYdbToolForTest("local_ydb_restore_tenant", {
      dumpName: "path-smoke",
      countQueries: [{ query: `SELECT COUNT(*) FROM \`${multibyteTable}\`;` }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow("query must be at most 4096 bytes");
  });

  it("rejects blank restore dump names at the MCP argument layer", async () => {
    for (const dumpName of ["", "   "]) {
      await expect(callLocalYdbToolForTest("local_ydb_restore_tenant", {
        dumpName,
      }, {
        config: ConfigSchema.parse({})
      })).rejects.toThrow("String must contain at least 1 character");
    }
  });

  it("rejects blank restore count queries at the MCP argument layer", async () => {
    await expect(callLocalYdbToolForTest("local_ydb_restore_tenant", {
      dumpName: "path-smoke",
      countQueries: [{ query: "   " }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow("String must contain at least 1 character");
  });

  it("rejects blank restore count query labels at the MCP argument layer", async () => {
    await expect(callLocalYdbToolForTest("local_ydb_restore_tenant", {
      dumpName: "path-smoke",
      countQueries: [{ label: "   ", query: "SELECT COUNT(*) FROM `restore-root/table`;" }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow("String must contain at least 1 character");
  });

  it("exposes a root-only bootstrap tool", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_bootstrap_root_database", {}, {
      config: ConfigSchema.parse({})
    }) as { executed: boolean; plannedCommands: string[] };
    const plan = result.plannedCommands.join("\n");
    expect(result.executed).toBe(false);
    expect(plan).toContain("scheme ls /local");
    expect(plan).toContain("for attempt in $(seq 1 30)");
    expect(plan).not.toContain("admin database");
    expect(plan).not.toContain("YDB_FEATURE_FLAGS=enable_graph_shard");
  });

  it("assigns unique lifecycle instruction orders", () => {
    const lifecycle = toolDefinitions
      .filter((definition) => definition.group === "lifecycle")
      .map(({ name, instructionOrder }) => [name, instructionOrder] as const)
      .sort((left, right) => (left[1] ?? Number.MAX_SAFE_INTEGER) - (right[1] ?? Number.MAX_SAFE_INTEGER));

    expect(lifecycle).toEqual([
      ["local_ydb_check_prerequisites", 0],
      ["local_ydb_bootstrap_root_database", 1],
      ["local_ydb_bootstrap", 2],
      ["local_ydb_create_tenant", 3],
      ["local_ydb_start_dynamic_node", 4],
      ["local_ydb_restart_stack", 5],
      ["local_ydb_destroy_stack", 6],
      ["local_ydb_pull_image", 7],
      ["local_ydb_upgrade_version", 8]
    ]);
  });

  it("rejects prototype-derived tool names like __proto__", async () => {
    await expect(callLocalYdbToolForTest("__proto__", {})).rejects.toThrow(
      "Unknown tool: __proto__",
    );
  });

  it("rejects prototype-derived tool names like toString", async () => {
    await expect(callLocalYdbToolForTest("toString", {})).rejects.toThrow(
      "Unknown tool: toString",
    );
  });

  it("can load a config dynamically from configPath without restarting the server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-toolkit-"));
    const configPath = join(dir, "remote.json");
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: "remote",
      profiles: {
        remote: {
          mode: "ssh",
          ssh: {
            host: "example-host",
            user: "ops"
          }
        }
      }
    }), "utf8");

    try {
      const result = await callLocalYdbToolForTest("local_ydb_bootstrap", {
        configPath,
        profile: "remote"
      }) as { executed: boolean; plannedCommands: string[] };
      expect(result.executed).toBe(false);
      expect(result.plannedCommands[0]).toContain("ssh");
      expect(result.plannedCommands[0]).toContain("ops@example-host");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes configPath through to version upgrade planning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-toolkit-"));
    const configPath = join(dir, "upgrade.json");
    writeFileSync(configPath, JSON.stringify({
      profiles: {
        default: {
          image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6"
        }
      }
    }), "utf8");

    try {
      const result = await callLocalYdbToolForTest("local_ydb_upgrade_version", {
        configPath,
        version: "26.1.2.0"
      }, {
        executor: new RecordingExecutor()
      }) as { executed: boolean; profileImageUpdate?: { configPath: string; ok: boolean }; plannedCommands: string[] };

      expect(result.executed).toBe(false);
      expect(result.profileImageUpdate).toMatchObject({
        configPath,
        ok: false
      });
      expect(result.plannedCommands.join("\n")).toContain(`update ${configPath}: profiles.default.image`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps injected test config in-memory for version upgrades", async () => {
    const executor = new RecordingExecutor();

    await expect(callLocalYdbToolForTest("local_ydb_upgrade_version", {
      version: "26.1.2.0"
    }, {
      config: ConfigSchema.parse({
        profiles: {
          default: {
            image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6"
          }
        }
      }),
      executor
    })).rejects.toThrow(/file-backed local-ydb config path/);
    expect(executor.commands).toEqual([]);
  });

  it("exposes nodeIds for targeted dynamic-node removal", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_remove_dynamic_nodes");
    expect(tool?.inputSchema.properties?.nodeIds).toMatchObject({
      type: "array",
      maxItems: 10
    });
  });

  it("exposes configPath on profile-based tool schemas", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_inventory");
    expect(tool?.inputSchema.properties?.configPath).toMatchObject({
      type: "string"
    });
  });

  it("exposes root password constraints in the tool schema", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_set_root_password");
    const password = tool?.inputSchema.properties?.password as { pattern?: string } | undefined;
    const pattern = new RegExp(password?.pattern ?? "");

    expect(tool?.inputSchema.required).toContain("password");
    expect(password).toMatchObject({
      type: "string",
      minLength: 1,
      pattern: "^(?!.*[\\r\\n]).+$"
    });
    expect(pattern.test("S3cr3t!")).toBe(true);
    expect(pattern.test("S3cr3t!\n")).toBe(false);
    expect(pattern.test("S3cr3t!\r")).toBe(false);
  });

  it("rejects invalid root password arguments through Zod", async () => {
    await expect(callLocalYdbToolForTest("local_ydb_set_root_password", {
      password: ""
    })).rejects.toThrow();
    await expect(callLocalYdbToolForTest("local_ydb_set_root_password", {
      password: "line1\nline2"
    })).rejects.toThrow("password must not contain carriage returns or newlines");
    await expect(callLocalYdbToolForTest("local_ydb_set_root_password", {
      password: "line1\rline2"
    })).rejects.toThrow("password must not contain carriage returns or newlines");
  });

  it("exposes scheme inspection options in the tool schema", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_scheme");
    expect(tool?.inputSchema.properties?.action).toMatchObject({
      type: "string",
      enum: ["list", "describe"]
    });
    expect(tool?.inputSchema.properties?.path).toMatchObject({ type: "string" });
    expect(tool?.inputSchema.properties?.recursive).toMatchObject({ type: "boolean" });
    expect(tool?.inputSchema.properties?.long).toMatchObject({ type: "boolean" });
    expect(tool?.inputSchema.properties?.onePerLine).toMatchObject({ type: "boolean" });
    expect(tool?.inputSchema.properties?.stats).toMatchObject({ type: "boolean" });
    expect(tool?.inputSchema.properties?.maxOutputBytes).toMatchObject({
      type: "integer",
      maximum: 1_048_576
    });
  });

  it("exposes permissions management options in the tool schema", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_permissions");
    expect(tool?.inputSchema.properties?.action).toMatchObject({
      type: "string",
      enum: [
        "list",
        "grant",
        "revoke",
        "set",
        "clear",
        "chown",
        "set-inheritance",
        "clear-inheritance"
      ]
    });
    expect(tool?.inputSchema.properties?.permissions).toMatchObject({
      type: "array",
      minItems: 1
    });
    expect(tool?.inputSchema.properties?.subject).toMatchObject({ type: "string" });
    expect(tool?.inputSchema.properties?.owner).toMatchObject({ type: "string" });
    expect(tool?.inputSchema.properties?.confirm).toMatchObject({ type: "boolean" });
  });

  it("exposes schema apply options in the tool schema", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_apply_schema");
    expect(tool?.inputSchema.required).toContain("script");
    expect(tool?.inputSchema.properties?.action).toMatchObject({
      type: "string",
      enum: ["validate", "apply"]
    });
    expect(tool?.inputSchema.properties?.databasePath).toMatchObject({ type: "string" });
    expect(tool?.inputSchema.properties?.script).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 1_048_576
    });
    expect(tool?.inputSchema.properties?.confirm).toMatchObject({ type: "boolean" });
    expect(tool?.inputSchema.properties?.timeoutMs).toMatchObject({
      type: "integer",
      maximum: 600_000
    });
    expect(tool?.inputSchema.properties?.maxOutputBytes).toMatchObject({
      type: "integer",
      maximum: 1_048_576
    });
  });

  it("exposes schema generation options in the tool schema", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_generate_schema");
    expect(tool?.inputSchema.required).toContain("statements");
    expect(tool?.inputSchema.properties?.databasePath).toMatchObject({ type: "string" });
    expect(tool?.inputSchema.properties?.validate).toMatchObject({ type: "boolean" });
    expect(tool?.inputSchema.properties?.statements).toMatchObject({
      type: "array",
      minItems: 1
    });
    expect(tool?.inputSchema.properties?.timeoutMs).toMatchObject({
      type: "integer",
      maximum: 600_000
    });
    expect(tool?.inputSchema.properties?.maxOutputBytes).toMatchObject({
      type: "integer",
      maximum: 1_048_576
    });
  });

  it("exposes schema setting token values in the tool schema", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_generate_schema");
    const statements = tool?.inputSchema.properties?.statements as {
      items?: { oneOf?: Array<{ properties?: Record<string, unknown> }> };
    };
    const createTableSchema = statements.items?.oneOf?.find((schema) => {
      return (schema.properties?.kind as { const?: string } | undefined)?.const === "createTable";
    });
    const tableWith = (createTableSchema?.properties?.with as {
      additionalProperties?: { oneOf?: unknown[] };
      propertyNames?: unknown;
    } | undefined)?.additionalProperties;
    const tableWithSchema = createTableSchema?.properties?.with as {
      propertyNames?: unknown;
    } | undefined;
    const indexes = createTableSchema?.properties?.indexes as {
      items?: { properties?: Record<string, unknown> };
    } | undefined;
    const indexWithSchema = indexes?.items?.properties?.with as {
      propertyNames?: unknown;
    } | undefined;

    expect(tableWith?.oneOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "object",
        required: ["token"],
        additionalProperties: false,
        properties: expect.objectContaining({
          token: expect.objectContaining({
            type: "string",
            minLength: 1
          })
        })
      })
    ]));
    expect(tableWithSchema?.propertyNames).toEqual({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });
    expect(indexWithSchema?.propertyNames).toEqual({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });
  });

  it("exposes non-empty schema array constraints in the tool schema", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_generate_schema");
    const statements = tool?.inputSchema.properties?.statements as {
      items?: { oneOf?: Array<{ properties?: Record<string, unknown> }> };
    };
    const createTableSchema = statements.items?.oneOf?.find((schema) => {
      return (schema.properties?.kind as { const?: string } | undefined)?.const === "createTable";
    });
    const indexes = createTableSchema?.properties?.indexes as { items?: { properties?: Record<string, unknown> } } | undefined;

    expect(indexes?.items?.properties?.cover).toMatchObject({
      type: "array",
      minItems: 1,
      uniqueItems: true
    });
    expect(indexes?.items?.properties?.columns).toMatchObject({
      type: "array",
      minItems: 1,
      uniqueItems: true
    });
    expect(createTableSchema?.properties?.primaryKey).toMatchObject({
      type: "array",
      minItems: 1,
      uniqueItems: true
    });
    expect(createTableSchema?.properties?.partitionByHash).toMatchObject({
      type: "array",
      minItems: 1,
      uniqueItems: true
    });
  });

  it("exposes ALTER ADD COLUMN constraints in the tool schema", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_generate_schema");
    const statements = tool?.inputSchema.properties?.statements as {
      items?: { oneOf?: Array<{ properties?: Record<string, unknown> }> };
    };
    const alterTableSchema = statements.items?.oneOf?.find((schema) => {
      return (schema.properties?.kind as { const?: string } | undefined)?.const === "alterTable";
    });
    const actions = alterTableSchema?.properties?.actions as {
      items?: { oneOf?: Array<{ properties?: Record<string, unknown> }> };
    } | undefined;
    const addColumnAction = actions?.items?.oneOf?.find((schema) => {
      return (schema.properties?.kind as { const?: string } | undefined)?.const === "addColumn";
    });
    const addColumn = addColumnAction?.properties?.column as { not?: unknown } | undefined;

    expect(addColumn?.not).toEqual({
      anyOf: [
        { required: ["notNull"] },
        { required: ["default"] }
      ]
    });
  });

  it("exposes index mode constraints in the tool schema", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_generate_schema");
    const statements = tool?.inputSchema.properties?.statements as {
      items?: { oneOf?: Array<{ properties?: Record<string, unknown> }> };
    };
    const createTableSchema = statements.items?.oneOf?.find((schema) => {
      return (schema.properties?.kind as { const?: string } | undefined)?.const === "createTable";
    });
    const indexes = createTableSchema?.properties?.indexes as { items?: { allOf?: unknown[] } } | undefined;

    expect(indexes?.items?.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        if: expect.objectContaining({
          required: ["using"],
          properties: expect.objectContaining({
            using: { const: "vector_kmeans_tree" }
          })
        }),
        then: expect.objectContaining({
          required: ["global", "sync"],
          properties: expect.objectContaining({
            global: { const: true },
            sync: { const: "sync" },
            local: { const: false },
            unique: { const: false }
          })
        })
      }),
      expect.objectContaining({
        if: expect.objectContaining({
          anyOf: expect.arrayContaining([
            expect.objectContaining({
              not: { required: ["using"] }
            }),
            expect.objectContaining({
              required: ["using"],
              properties: expect.objectContaining({
                using: { const: "secondary" }
              })
            })
          ])
        }),
        then: expect.objectContaining({
          required: ["global"],
          properties: expect.objectContaining({
            global: { const: true },
            local: { const: false }
          }),
          not: { required: ["with"] }
        })
      }),
      expect.objectContaining({
        if: expect.objectContaining({
          required: ["unique"],
          properties: expect.objectContaining({
            unique: { const: true }
          })
        }),
        then: expect.objectContaining({
          required: ["sync"],
          properties: expect.objectContaining({
            sync: { const: "sync" }
          })
        })
      })
    ]));
  });

  it("requires version for the upgrade tool schema", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_upgrade_version");
    expect(tool?.inputSchema.required).toContain("version");
  });

  it("requires jobId for the pull status tool schema", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_pull_status");
    expect(tool?.inputSchema.required).toContain("jobId");
  });

  it("can plan a background image pull through the MCP handler", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_pull_image", {
      image: "ghcr.io/ydb-platform/local-ydb:25.4"
    }, {
      config: ConfigSchema.parse({})
    }) as { executed: boolean; status: string; plannedCommands: string[] };

    expect(result.executed).toBe(false);
    expect(result.status).toBe("planned");
    expect(result.plannedCommands.join("\n")).toContain("docker pull ghcr.io/ydb-platform/local-ydb:25.4");
  });

  it("can read missing pull status through the MCP handler", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_pull_status", {
      jobId: "missing-job"
    }) as { found: boolean; status: string };

    expect(result.found).toBe(false);
    expect(result.status).toBe("unknown");
  });

  it("can list registry tags through the MCP handler", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_list_versions", {
      image: "ghcr.io/ydb-platform/local-ydb",
      pageSize: 2,
      maxPages: 1
    }, {
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "https://ghcr.io/v2/ydb-platform/local-ydb/tags/list?n=2") {
          return new Response(JSON.stringify({ tags: ["26.1.1.6", "latest"] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        throw new Error(`Unexpected fetch request: ${url}`);
      }
    }) as { tags: string[]; truncated: boolean };

    expect(result.tags).toEqual(["26.1.1.6", "latest"]);
    expect(result.truncated).toBe(false);
  });

  it("can inspect scheme objects through the MCP handler", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_scheme", {
      path: "/local/example/dir",
      recursive: true,
      onePerLine: true
    }, {
      config: ConfigSchema.parse({}),
      executor: new RecordingExecutor()
    }) as { action: string; path: string; command: string; maxOutputBytes: number };

    expect(result.action).toBe("list");
    expect(result.path).toBe("/local/example/dir");
    expect(result.maxOutputBytes).toBe(65_536);
    expect(result.command).toContain("scheme ls /local/example/dir -R -1");
  });

  it("rejects incompatible scheme list flags through the MCP handler", async () => {
    await expect(callLocalYdbToolForTest("local_ydb_scheme", {
      path: "/local/example/dir",
      long: true,
      onePerLine: true
    }, {
      config: ConfigSchema.parse({}),
      executor: new RecordingExecutor()
    })).rejects.toThrow(/flags -l and -1 are incompatible/);
  });

  it("can describe scheme objects with stats through the MCP handler", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_scheme", {
      action: "describe",
      path: "/local/example/users",
      stats: true
    }, {
      config: ConfigSchema.parse({}),
      executor: new RecordingExecutor()
    }) as { action: string; path: string; command: string };

    expect(result.action).toBe("describe");
    expect(result.path).toBe("/local/example/users");
    expect(result.command).toContain("scheme describe /local/example/users --stats");
  });

  it("can validate schema DDL through the MCP handler", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_apply_schema", {
      script: "CREATE TABLE users (id Uint64, PRIMARY KEY (id));"
    }, {
      config: ConfigSchema.parse({}),
      sdkExecutor: async () => ({
        ok: true,
        status: "SUCCESS",
        issues: ""
      })
    }) as { action: string; executed: boolean; statements: { kinds: string[] }; validation: { ok: boolean } };

    expect(result.action).toBe("validate");
    expect(result.executed).toBe(false);
    expect(result.statements.kinds).toEqual(["CREATE TABLE"]);
    expect(result.validation.ok).toBe(true);
  });

  it("can generate schema DDL through the MCP handler", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "users",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "email", type: "Utf8" }
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "users_by_email",
          columns: ["email"],
          global: true
        }],
        with: {
          AUTO_PARTITIONING_BY_SIZE: { token: "ENABLED" }
        }
      }]
    }, {
      config: ConfigSchema.parse({})
    }) as { script: string; applyRisk: string; statements: { kinds: string[] }; references: Array<{ label: string }> };

    expect(result.script).toBe([
      "CREATE TABLE `users` (",
      "  `id` Uint64 NOT NULL,",
      "  `email` Utf8,",
      "  INDEX `users_by_email` GLOBAL ON (`email`),",
      "  PRIMARY KEY (`id`)",
      ")",
      "WITH (",
      "  AUTO_PARTITIONING_BY_SIZE = ENABLED",
      ");",
    ].join("\n"));
    expect(result.applyRisk).toBe("low");
    expect(result.statements.kinds).toEqual(["CREATE TABLE"]);
    expect(result.references.map((reference) => reference.label)).toContain("YDB CREATE TABLE syntax");
  });

  it("can validate generated schema DDL through the MCP handler", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_generate_schema", {
      validate: true,
      statements: [{
        kind: "createTable",
        tableName: "users",
        columns: [{ name: "id", type: "Uint64" }],
        primaryKey: ["id"]
      }]
    }, {
      config: ConfigSchema.parse({}),
      sdkExecutor: async () => ({
        ok: true,
        status: "SUCCESS",
        issues: ""
      })
    }) as { validation?: { ok: boolean; status: string }; script: string };

    expect(result.script).toContain("CREATE TABLE `users`");
    expect(result.validation).toMatchObject({
      ok: true,
      status: "SUCCESS"
    });
  });

  it("rejects generated column table partitioning outside the primary key through the MCP handler", async () => {
    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "metrics",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "bucket", type: "Uint32" }
        ],
        primaryKey: ["id"],
        store: "column",
        partitionByHash: ["bucket"]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/partitionByHash column bucket must be part of primaryKey/);
  });

  it("rejects ambiguous generated schema specs through the MCP handler", async () => {
    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64" }],
        primaryKey: ["id"],
        store: "column",
        with: {
          STORE: { token: "ROW" }
        }
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/Use the store field instead of with\.STORE/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "items",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "embedding", type: "String" }
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "embedding_vector_idx",
          columns: ["embedding"],
          global: true,
          using: "vector_kmeans_tree",
          with: {
            distance: "cosine",
            vector_type: "float",
            vector_dimension: 3,
            clusters: 2,
            levels: 1
          }
        }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/vector_kmeans_tree index embedding_vector_idx must be sync/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "items",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "embedding", type: "String" }
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "embedding_vector_idx",
          columns: ["embedding"],
          sync: "sync",
          using: "vector_kmeans_tree",
          with: {
            distance: "cosine",
            vector_type: "float",
            vector_dimension: 3,
            clusters: 2,
            levels: 1
          }
        }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/vector_kmeans_tree index embedding_vector_idx must be global/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "items",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "embedding", type: "String" }
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "embedding_vector_idx",
          columns: ["embedding"],
          global: true,
          local: true,
          sync: "sync",
          using: "vector_kmeans_tree",
          with: {
            distance: "cosine",
            vector_type: "float",
            vector_dimension: 3,
            clusters: 2,
            levels: 1
          }
        }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/vector_kmeans_tree index embedding_vector_idx cannot be local/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "items",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "embedding", type: "String" }
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "embedding_vector_idx",
          columns: ["embedding"],
          global: true,
          unique: true,
          sync: "sync",
          using: "vector_kmeans_tree",
          with: {
            distance: "cosine",
            vector_type: "float",
            vector_dimension: 3,
            clusters: 2,
            levels: 1
          }
        }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/vector_kmeans_tree index embedding_vector_idx cannot be unique/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [{
          kind: "addIndex",
          index: {
            name: "orders_by_created_at",
            columns: ["created_at"],
            local: true
          }
        }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/secondary index orders_by_created_at cannot be local/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [{
          kind: "addIndex",
          index: {
            name: "orders_by_created_at",
            columns: ["created_at"]
          }
        }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/secondary index orders_by_created_at must be global/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [{
          kind: "addIndex",
          index: {
            name: "orders_by_created_at",
            columns: ["created_at"],
            global: true,
            with: {
              AUTO_PARTITIONING_BY_SIZE: { token: "ENABLED" }
            }
          }
        }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/secondary index orders_by_created_at cannot have WITH settings/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "order_no", type: "Utf8" }
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "orders_by_order_no",
          columns: ["order_no"],
          unique: true,
          global: true,
          sync: "async"
        }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/unique index orders_by_order_no must be sync/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "order_no", type: "Utf8" }
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "orders_by_order_no",
          columns: ["order_no"],
          unique: true,
          global: true
        }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/unique index orders_by_order_no must be sync/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "status", type: "Utf8" }
        ],
        primaryKey: ["id"],
        indexes: [
          { name: "orders_by_status", columns: ["status"], global: true, sync: "sync" },
          { name: " orders_by_status ", columns: ["id"], global: true, sync: "sync" }
        ]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/Duplicate index name: orders_by_status/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "status", type: "Utf8" }
        ],
        primaryKey: ["id", " id "]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/primaryKey contains duplicate name: id/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "status", type: "Utf8", notNull: true }
        ],
        primaryKey: ["id"]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/NOT NULL column status must be part of primaryKey/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "metrics",
        columns: [
          { name: "tenant_id", type: "Utf8" },
          { name: "ts", type: "Timestamp", notNull: true }
        ],
        primaryKey: ["tenant_id", "ts"],
        store: "column"
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/column-oriented table primaryKey column tenant_id must be NOT NULL/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64", notNull: true }],
        primaryKey: ["id"],
        with: {
          AUTO_PARTITIONING_BY_SIZE: { token: "ENABLED" },
          auto_partitioning_by_size: { token: "DISABLED" }
        }
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/Duplicate YDB setting name: AUTO_PARTITIONING_BY_SIZE/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64", notNull: true }],
        primaryKey: ["id"],
        with: { "bad-name": 1 }
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/Invalid YDB setting name: bad-name/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "embedding", type: "String" }
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "orders_embedding_idx",
          columns: ["embedding"],
          global: true,
          sync: "sync",
          using: "vector_kmeans_tree",
          with: {
            "bad-name": 1,
            distance: "cosine",
            vector_type: "float",
            vector_dimension: 3,
            clusters: 2,
            levels: 1
          }
        }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/Invalid YDB setting name: bad-name/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [{ kind: "addColumn", column: { name: "status", type: "Utf8", notNull: true } }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/ALTER TABLE ADD COLUMN status cannot include notNull/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [{ kind: "addColumn", column: { name: "status", type: "Utf8", default: "new" } }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/ALTER TABLE ADD COLUMN status cannot include default/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "addColumn", column: { name: "status", type: "Utf8" } },
          { kind: "addColumn", column: { name: " status ", type: "Utf8" } }
        ]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/Duplicate ALTER TABLE ADD COLUMN name: status/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "dropColumn", name: "status" },
          { kind: "dropColumn", name: " status " }
        ]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/Duplicate ALTER TABLE DROP COLUMN name: status/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "dropIndex", name: "orders_by_status" },
          { kind: "dropIndex", name: " orders_by_status " }
        ]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/Duplicate ALTER TABLE DROP INDEX name: orders_by_status/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "metrics",
        columns: [
          { name: "enabled", type: "Bool", notNull: true },
          { name: "value", type: "Utf8" }
        ],
        primaryKey: ["enabled"],
        store: "column"
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/column-oriented table primaryKey column enabled type Bool is not supported/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "__ydb_id", type: "Uint64", notNull: true }],
        primaryKey: ["__ydb_id"]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/Column name __ydb_id must not start with reserved prefix __ydb_/);
  });

  it("rejects empty schema arrays through the MCP handler", async () => {
    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "items",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "embedding", type: "String" }
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "items_by_embedding",
          columns: ["embedding"],
          cover: []
        }]
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/Array must contain at least 1 element/);

    await expect(callLocalYdbToolForTest("local_ydb_generate_schema", {
      statements: [{
        kind: "createTable",
        tableName: "metrics",
        columns: [{ name: "id", type: "Uint64" }],
        primaryKey: ["id"],
        store: "column",
        partitionByHash: []
      }]
    }, {
      config: ConfigSchema.parse({})
    })).rejects.toThrow(/Array must contain at least 1 element/);
  });

  it("advertises schema apply as a mutating destructive tool", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_apply_schema");

    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true
    });
    expect(localYdbInstructions).toContain("local_ydb_apply_schema");
  });

  it("advertises schema generation as a read-only tool", () => {
    const tool = localYdbTools.find((candidate) => candidate.name === "local_ydb_generate_schema");

    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false
    });
    expect(localYdbInstructions).toContain("local_ydb_generate_schema");
    expect(localYdbInstructions).toContain("generate_schema");
  });

  it("can list permissions through the MCP handler without confirm", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_permissions", {
      path: "/local/example/dir"
    }, {
      config: ConfigSchema.parse({}),
      executor: new RecordingExecutor()
    }) as { action: string; path: string; command: string; maxOutputBytes: number };

    expect(result.action).toBe("list");
    expect(result.path).toBe("/local/example/dir");
    expect(result.maxOutputBytes).toBe(65_536);
    expect(result.command).toContain("scheme permissions list /local/example/dir");
  });

  it("plans mutating permissions through the MCP handler without confirm", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_permissions", {
      action: "grant",
      path: "/local/example/dir",
      subject: "testuser",
      permissions: ["ydb.generic.read", "ydb.access.grant"]
    }, {
      config: ConfigSchema.parse({}),
      executor: new RecordingExecutor()
    }) as { executed: boolean; plannedCommands: string[]; permissions: string[] };

    expect(result.executed).toBe(false);
    expect(result.permissions).toEqual(["ydb.generic.read", "ydb.access.grant"]);
    expect(result.plannedCommands[0]).toContain(
      "scheme permissions grant -p ydb.generic.read -p ydb.access.grant /local/example/dir testuser"
    );
  });

  it("exposes server instructions during initialization", () => {
    const server = createLocalYdbMcpServer() as unknown as { _instructions?: string };
    expect(server._instructions).toBe(localYdbInstructions);
    expect(server._instructions).toContain("local_ydb_check_prerequisites");
    expect(server._instructions).toContain("local_ydb_status_report");
    expect(server._instructions).toContain("PENDING_RESOURCES");
  });

  it("declares tools and static prompts capabilities", () => {
    const server = createLocalYdbMcpServer() as unknown as {
      _capabilities?: { tools?: object; prompts?: { listChanged?: boolean } };
    };
    expect(server._capabilities?.tools).toEqual({});
    expect(server._capabilities?.prompts).toEqual({});
  });

  it("mentions every public local-ydb tool in server instructions", () => {
    for (const tool of localYdbTools) {
      expect(localYdbInstructions).toContain(tool.name);
    }
  });

  it("uses the package version in server metadata", () => {
    const server = createLocalYdbMcpServer() as unknown as { _serverInfo?: { version?: string } };
    expect(localYdbMcpServerVersion).toBe(packageVersion);
    expect(server._serverInfo?.version).toBe(packageVersion);
  });
});
