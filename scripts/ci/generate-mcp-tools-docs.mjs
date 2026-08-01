#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const START_MARKER = "<!-- BEGIN GENERATED MCP TOOLS -->";
export const END_MARKER = "<!-- END GENERATED MCP TOOLS -->";
export const TOOLSETS_START_MARKER = "<!-- BEGIN GENERATED MCP TOOLSETS -->";
export const TOOLSETS_END_MARKER = "<!-- END GENERATED MCP TOOLSETS -->";

function formatGroup(group) {
  return group
    .split(" ")
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function escapeTableCell(value) {
  return value.replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim();
}

export function renderToolsBlock(toolDefinitions) {
  const groups = new Map();

  for (const definition of toolDefinitions) {
    const group = groups.get(definition.group) ?? [];
    group.push(definition);
    groups.set(definition.group, group);
  }

  const lines = [
    START_MARKER,
    "## Tools",
    "",
    `The server exposes ${toolDefinitions.length} tools. This index is generated from the runtime tool registry; edit \`toolDefinitions\` and run \`npm run docs:generate\` to update it.`,
  ];

  for (const [groupName, definitions] of groups) {
    lines.push(
      "",
      `### ${formatGroup(groupName)}`,
      "",
      "| Tool | Mode | Description |",
      "| --- | --- | --- |",
    );

    for (const definition of definitions) {
      const mode = definition.annotations?.readOnlyHint === true
        ? "read-only"
        : "plan-first mutation";
      lines.push(
        `| \`${definition.name}\` | ${mode} | ${escapeTableCell(definition.description)} |`,
      );
    }
  }

  lines.push("", END_MARKER);
  return lines.join("\n");
}

export function renderToolsetsBlock(toolsetPresets) {
  const lines = [
    TOOLSETS_START_MARKER,
    "## Toolsets",
    "",
    "`LOCAL_YDB_MCP_TOOLSETS` selects a comma-separated union of tool presets to expose at startup; `LOCAL_YDB_MCP_ENABLE_TOOLS` adds individual tools and `LOCAL_YDB_MCP_DISABLE_TOOLS` removes them afterwards. Unknown preset or tool names fail server startup with a validation error. When all three variables are unset, the server exposes the default `all` toolset. Prompts and server instructions are filtered together with the tools. This index is generated from the runtime toolset presets; edit `toolsetPresets` and run `npm run docs:generate` to update it.",
    "",
    "| Toolset | Tools | Included tools |",
    "| --- | --- | --- |",
  ];

  for (const [name, tools] of Object.entries(toolsetPresets)) {
    const toolList = tools.map((tool) => `\`${tool}\``).join(", ");
    lines.push(`| \`${name}\` | ${tools.length} | ${toolList} |`);
  }

  lines.push("", TOOLSETS_END_MARKER);
  return lines.join("\n");
}

export function replaceGeneratedBlock(
  source,
  expectedBlock,
  startMarker = START_MARKER,
  endMarker = END_MARKER,
) {
  const startCount = source.split(startMarker).length - 1;
  const endCount = source.split(endMarker).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `Expected exactly one generated marker block for ${startMarker}; found ${startCount} start and ${endCount} end markers.`,
    );
  }

  const start = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker, start + startMarker.length);
  if (endIndex === -1) {
    throw new Error(
      "Expected the generated end marker after the start marker.",
    );
  }
  const end = endIndex + endMarker.length;
  const content = `${source.slice(0, start)}${expectedBlock}${source.slice(end)}`;
  return { content, changed: content !== source };
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "--write" && mode !== "--check") {
    throw new Error("Usage: generate-mcp-tools-docs.mjs --write|--check");
  }

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const registryPath = resolve(
    repoRoot,
    "packages/mcp-server/dist/tools/registry.js",
  );
  const toolsetsPath = resolve(
    repoRoot,
    "packages/mcp-server/dist/tools/toolsets.js",
  );
  const { toolDefinitions } = await import(pathToFileURL(registryPath).href);
  const { toolsetPresets } = await import(pathToFileURL(toolsetsPath).href);
  const blocks = [
    {
      expected: renderToolsBlock(toolDefinitions),
      startMarker: START_MARKER,
      endMarker: END_MARKER,
    },
    {
      expected: renderToolsetsBlock(toolsetPresets),
      startMarker: TOOLSETS_START_MARKER,
      endMarker: TOOLSETS_END_MARKER,
    },
  ];
  const readmes = [
    resolve(repoRoot, "README.md"),
    resolve(repoRoot, "packages/mcp-server/README.md"),
  ];
  const stale = [];

  for (const readme of readmes) {
    let source = readFileSync(readme, "utf8");
    let changed = false;
    for (const block of blocks) {
      const result = replaceGeneratedBlock(
        source,
        block.expected,
        block.startMarker,
        block.endMarker,
      );
      source = result.content;
      changed = changed || result.changed;
    }
    if (!changed) {
      continue;
    }
    if (mode === "--write") {
      writeFileSync(readme, source);
    } else {
      stale.push(readme);
    }
  }

  if (stale.length > 0) {
    throw new Error(
      `Generated MCP tools documentation is stale:\n${stale.join("\n")}\nRun npm run docs:generate.`,
    );
  }

  console.log(
    mode === "--write"
      ? `Updated MCP tools documentation for ${toolDefinitions.length} tools.`
      : `MCP tools documentation is current for ${toolDefinitions.length} tools.`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
