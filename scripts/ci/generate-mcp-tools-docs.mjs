#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const START_MARKER = "<!-- BEGIN GENERATED MCP TOOLS -->";
export const END_MARKER = "<!-- END GENERATED MCP TOOLS -->";

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

export function replaceGeneratedBlock(source, expectedBlock) {
  const startCount = source.split(START_MARKER).length - 1;
  const endCount = source.split(END_MARKER).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `Expected exactly one generated tools marker block; found ${startCount} start and ${endCount} end markers.`,
    );
  }

  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER, start) + END_MARKER.length;
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
  const { toolDefinitions } = await import(pathToFileURL(registryPath).href);
  const expectedBlock = renderToolsBlock(toolDefinitions);
  const readmes = [
    resolve(repoRoot, "README.md"),
    resolve(repoRoot, "packages/mcp-server/README.md"),
  ];
  const stale = [];

  for (const readme of readmes) {
    const source = readFileSync(readme, "utf8");
    const result = replaceGeneratedBlock(source, expectedBlock);
    if (!result.changed) {
      continue;
    }
    if (mode === "--write") {
      writeFileSync(readme, result.content);
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
