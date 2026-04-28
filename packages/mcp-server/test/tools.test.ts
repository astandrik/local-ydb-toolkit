import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  localYdbInstructions,
  localYdbMcpServerVersion,
  localYdbTools
} from "../src/index.js";
import { toolDefinitions } from "../src/tools/registry.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
}).version;

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

describe("mcp tools", () => {
  it("registers all public local-ydb tools", () => {
    expect(localYdbTools.map((tool) => tool.name).sort()).toEqual([
      "local_ydb_add_dynamic_nodes",
      "local_ydb_add_storage_groups",
      "local_ydb_apply_auth_hardening",
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
      "local_ydb_graphshard_check",
      "local_ydb_inventory",
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

  it("returns plan-only output for mutating tools without confirm", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_bootstrap", {}, {
      config: ConfigSchema.parse({})
    }) as { executed: boolean; plannedCommands: string[] };
    expect(result.executed).toBe(false);
    expect(result.plannedCommands.length).toBeGreaterThan(0);
  });

  it("exposes a root-only bootstrap tool", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_bootstrap_root_database", {}, {
      config: ConfigSchema.parse({})
    }) as { executed: boolean; plannedCommands: string[] };
    const plan = result.plannedCommands.join("\n");
    expect(result.executed).toBe(false);
    expect(plan).toContain("scheme ls /local");
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
      long: true,
      onePerLine: true
    }, {
      config: ConfigSchema.parse({}),
      executor: new RecordingExecutor()
    }) as { action: string; path: string; command: string; maxOutputBytes: number };

    expect(result.action).toBe("list");
    expect(result.path).toBe("/local/example/dir");
    expect(result.maxOutputBytes).toBe(65_536);
    expect(result.command).toContain("scheme ls /local/example/dir -l -R -1");
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
