import { describe, expect, it } from "vitest";
import { ConfigSchema } from "@local-ydb-toolkit/core";
import { callLocalYdbToolForTest, localYdbTools } from "../src/index.js";

describe("mcp tools", () => {
  it("registers all public local-ydb tools", () => {
    expect(localYdbTools.map((tool) => tool.name).sort()).toEqual([
      "local_ydb_apply_auth_hardening",
      "local_ydb_auth_check",
      "local_ydb_bootstrap",
      "local_ydb_cleanup_storage",
      "local_ydb_create_tenant",
      "local_ydb_dump_tenant",
      "local_ydb_graphshard_check",
      "local_ydb_inventory",
      "local_ydb_nodes_check",
      "local_ydb_restart_stack",
      "local_ydb_restore_tenant",
      "local_ydb_start_dynamic_node",
      "local_ydb_status_report",
      "local_ydb_storage_leftovers",
      "local_ydb_storage_placement",
      "local_ydb_tenant_check"
    ]);
  });

  it("returns plan-only output for mutating tools without confirm", async () => {
    const result = await callLocalYdbToolForTest("local_ydb_bootstrap", {}, {
      config: ConfigSchema.parse({})
    }) as { executed: boolean; plannedCommands: string[] };
    expect(result.executed).toBe(false);
    expect(result.plannedCommands.length).toBeGreaterThan(0);
  });
});
