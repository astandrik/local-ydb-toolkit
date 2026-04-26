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
      "local_ydb_nodes_check",
      "local_ydb_prepare_auth_config",
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
