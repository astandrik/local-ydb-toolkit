import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const START_MARKER = "<!-- BEGIN MANAGED SQL SCENARIOS -->";
const END_MARKER = "<!-- END MANAGED SQL SCENARIOS -->";

test("keeps the managed SQL manual scenario block synchronized in both copies", () => {
  const rootScenarios = readFileSync(
    new URL("../../MCP_TOOL_TEST_SCENARIOS.md", import.meta.url),
    "utf8",
  );
  const skillScenarios = readFileSync(
    new URL("../../skills/local-ydb/references/mcp-tool-scenarios.md", import.meta.url),
    "utf8",
  );

  const rootBlock = extractManagedSqlBlock(rootScenarios, "MCP_TOOL_TEST_SCENARIOS.md");
  const skillBlock = extractManagedSqlBlock(
    skillScenarios,
    "skills/local-ydb/references/mcp-tool-scenarios.md",
  );

  assert.equal(skillBlock, rootBlock);
  assert.match(rootBlock, /local_ydb_sql/);
  assert.match(rootBlock, /SnapshotRO/);
  assert.match(rootBlock, /mandatory EXPLAIN/);
  assert.match(rootBlock, /confirm=true/);
  assert.match(rootBlock, /maxRows/);
  assert.match(rootBlock, /maxOutputBytes/);
  assert.match(rootBlock, /WITH \(STORE = COLUMN\)/);
  assert.match(rootBlock, /cleanup/i);
});

function extractManagedSqlBlock(source, fileName) {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  assert.notEqual(start, -1, `${fileName} is missing ${START_MARKER}`);
  assert.notEqual(end, -1, `${fileName} is missing ${END_MARKER}`);
  assert.ok(end > start, `${fileName} has reversed managed SQL markers`);
  return source.slice(start + START_MARKER.length, end).trim();
}
