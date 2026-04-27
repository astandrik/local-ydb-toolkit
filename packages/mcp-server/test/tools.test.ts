import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "@local-ydb-toolkit/core";
import {
  callLocalYdbToolForTest,
  createLocalYdbMcpServer,
  localYdbInstructions,
  localYdbMcpServerVersion,
  localYdbTools
} from "../src/index.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
}).version;

describe("mcp tools", () => {
  it("registers all public local-ydb tools", () => {
    expect(localYdbTools.map((tool) => tool.name).sort()).toEqual([
      "local_ydb_add_dynamic_nodes",
      "local_ydb_add_storage_groups",
      "local_ydb_apply_auth_hardening",
      "local_ydb_auth_check",
      "local_ydb_bootstrap",
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
      "local_ydb_prepare_auth_config",
      "local_ydb_pull_image",
      "local_ydb_pull_status",
      "local_ydb_reduce_storage_groups",
      "local_ydb_remove_dynamic_nodes",
      "local_ydb_restart_stack",
      "local_ydb_restore_tenant",
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
