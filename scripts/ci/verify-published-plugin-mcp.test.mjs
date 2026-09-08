import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertPublishedMcp, createPluginFixture } from "./verify-published-plugin-mcp.mjs";

function snapshot(version = "0.18.2") {
  return {
    serverInfo: { name: "local-ydb-toolkit", version },
    capabilities: { tools: {}, prompts: {} },
    tools: [
      "local_ydb_status_report", "local_ydb_healthcheck", "local_ydb_sql",
      ...Array.from({ length: 36 }, (_, index) => `other_tool_${index}`),
    ].map((name) => ({ name })),
    prompts: [
      "local_ydb_auth_hardening_workflow",
      "local_ydb_bootstrap_root_workflow",
      "local_ydb_bootstrap_tenant_workflow",
      "local_ydb_diagnose_database",
      "local_ydb_diagnose_stack",
      "local_ydb_reduce_storage_groups_workflow",
      "local_ydb_schema_generate_apply_workflow",
      "local_ydb_upgrade_version_workflow",
    ].map((name) => ({ name })),
  };
}

test("accepts the pinned version and rejects a wrong version with the same 39 tools", () => {
  assertPublishedMcp(snapshot(), "0.18.2");
  assertPublishedMcp(snapshot("0.18.3"), "0.18.3");
  assert.throws(() => assertPublishedMcp(snapshot("0.7.2"), "0.18.2"), /version must match the plugin pin/);
});

test("rejects missing tools, duplicates, wrong identity and prompts despite matching counts", () => {
  const missingHealthcheck = snapshot();
  missingHealthcheck.tools[1].name = "unrelated_tool";
  assert.throws(() => assertPublishedMcp(missingHealthcheck, "0.18.2"), /Missing tool: local_ydb_healthcheck/);

  const duplicate = snapshot();
  duplicate.tools[4] = duplicate.tools[3];
  assert.throws(() => assertPublishedMcp(duplicate, "0.18.2"));

  const wrongIdentity = snapshot();
  wrongIdentity.serverInfo.name = "another-server";
  assert.throws(() => assertPublishedMcp(wrongIdentity, "0.18.2"));

  const wrongPrompts = snapshot();
  wrongPrompts.prompts[0].name = "another_prompt";
  assert.throws(() => assertPublishedMcp(wrongPrompts, "0.18.2"));
});

test("fixture preserves manifest argv and a matching unbuilt workspace without installed dependencies", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const fixtureRoot = await mkdtemp(join(tmpdir(), "local-ydb-plugin-fixture-test-"));
  try {
    await createPluginFixture(repositoryRoot, fixtureRoot, "99.0.0");
    assert.deepEqual(
      await readFile(join(fixtureRoot, "mcp.json")),
      await readFile(join(repositoryRoot, "mcp.json")),
    );
    const workspace = JSON.parse(await readFile(join(fixtureRoot, "packages/mcp-server/package.json"), "utf8"));
    assert.equal(workspace.name, "@astandrik/local-ydb-mcp");
    assert.equal(workspace.version, "99.0.0");
    assert((await lstat(join(fixtureRoot, ".codex-plugin"))).isDirectory());
    for (const path of ["node_modules", "packages/mcp-server/dist", ".codex-plugin/package.json", ".codex-plugin/node_modules"]) {
      await assert.rejects(lstat(join(fixtureRoot, path)), { code: "ENOENT" });
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
