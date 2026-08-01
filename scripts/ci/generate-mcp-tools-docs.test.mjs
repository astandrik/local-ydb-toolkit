import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  END_MARKER,
  START_MARKER,
  TOOLSETS_END_MARKER,
  TOOLSETS_START_MARKER,
  renderToolsBlock,
  renderToolsetsBlock,
  replaceGeneratedBlock,
} from "./generate-mcp-tools-docs.mjs";

const definitions = [
  {
    group: "checks",
    name: "local_ydb_inventory",
    description: "Inspect the selected target.",
    annotations: { readOnlyHint: true },
  },
  {
    group: "storage",
    name: "local_ydb_cleanup_storage",
    description: "Plan cleanup | execution only after confirmation.",
    annotations: { readOnlyHint: false },
  },
];

test("renders groups, full tool names, safety mode, and descriptions deterministically", () => {
  const block = renderToolsBlock(definitions);

  assert.match(block, /^<!-- BEGIN GENERATED MCP TOOLS -->/);
  assert.match(block, /## Tools/);
  assert.match(block, /### Checks/);
  assert.match(block, /`local_ydb_inventory` \| read-only \| Inspect the selected target\./);
  assert.match(block, /### Storage/);
  assert.match(
    block,
    /`local_ydb_cleanup_storage` \| plan-first mutation \| Plan cleanup \\| execution only after confirmation\./,
  );
  assert.match(block, /<!-- END GENERATED MCP TOOLS -->$/);
});

test("replaces exactly one generated marker block and reports freshness", () => {
  const oldBlock = `${START_MARKER}\nold\n${END_MARKER}`;
  const source = `before\n\n${oldBlock}\n\nafter\n`;
  const expectedBlock = renderToolsBlock(definitions);

  const replaced = replaceGeneratedBlock(source, expectedBlock);
  assert.equal(replaced.changed, true);
  assert.equal(replaced.content, `before\n\n${expectedBlock}\n\nafter\n`);
  assert.equal(replaceGeneratedBlock(replaced.content, expectedBlock).changed, false);
});

test("rejects missing or duplicate marker blocks", () => {
  const block = renderToolsBlock(definitions);

  assert.throws(() => replaceGeneratedBlock("no markers", block), /exactly one/);
  assert.throws(
    () => replaceGeneratedBlock(`${block}\n${block}`, block),
    /exactly one/,
  );
});

test("rejects an end marker that appears before the start marker", () => {
  const block = renderToolsBlock(definitions);
  const reversed = `${END_MARKER}\ncontent\n${START_MARKER}`;

  assert.throws(
    () => replaceGeneratedBlock(reversed, block),
    /end marker after the start marker/,
  );
});

test("renders the toolsets block with preset sizes and tool lists", () => {
  const block = renderToolsetsBlock({
    diagnostics: ["local_ydb_status_report", "local_ydb_healthcheck"],
    all: ["local_ydb_status_report", "local_ydb_healthcheck", "local_ydb_bootstrap"],
  });

  assert.match(block, /^<!-- BEGIN GENERATED MCP TOOLSETS -->/);
  assert.match(block, /## Toolsets/);
  assert.match(block, /LOCAL_YDB_MCP_TOOLSETS/);
  assert.match(block, /LOCAL_YDB_MCP_ENABLE_TOOLS/);
  assert.match(block, /LOCAL_YDB_MCP_DISABLE_TOOLS/);
  assert.match(block, /`diagnostics` \| 2 \| `local_ydb_status_report`, `local_ydb_healthcheck`/);
  assert.match(block, /`all` \| 3 \|/);
  assert.match(block, /<!-- END GENERATED MCP TOOLSETS -->$/);
});

test("replaces the toolsets block with its own markers", () => {
  const toolsetsBlock = renderToolsetsBlock({ all: ["local_ydb_status_report"] });
  const toolsBlock = renderToolsBlock(definitions);
  const source = `${toolsBlock}\n\n${TOOLSETS_START_MARKER}\nold\n${TOOLSETS_END_MARKER}\n`;

  const replaced = replaceGeneratedBlock(
    source,
    toolsetsBlock,
    TOOLSETS_START_MARKER,
    TOOLSETS_END_MARKER,
  );
  assert.equal(replaced.changed, true);
  assert.ok(replaced.content.includes(toolsBlock));
  assert.ok(replaced.content.includes(toolsetsBlock));
  assert.equal(
    replaceGeneratedBlock(
      replaced.content,
      toolsetsBlock,
      TOOLSETS_START_MARKER,
      TOOLSETS_END_MARKER,
    ).changed,
    false,
  );
});

test("standalone docs check prepares runtime registry output without rewriting docs", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const scripts = packageJson.scripts;
  const standaloneCommand = [
    scripts["build:packages"],
    scripts["predocs:check"],
    scripts["docs:check"],
    scripts["docs:check:built"],
  ].filter(Boolean).join(" && ");

  assert.equal(scripts["predocs:check"], "npm run build:packages");
  assert.equal(scripts["docs:check"], "npm run docs:check:built");
  assert.match(standaloneCommand, /build -w @local-ydb-toolkit\/core/);
  assert.match(standaloneCommand, /build -w @astandrik\/local-ydb-mcp/);
  assert.match(standaloneCommand, /generate-mcp-tools-docs\.mjs --check/);
  assert.doesNotMatch(standaloneCommand, /--write/);
  assert.match(packageJson.scripts.build, /docs:check:built$/);
});
