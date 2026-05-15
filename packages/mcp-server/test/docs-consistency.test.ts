import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localYdbInstructions } from "../src/index.js";
import { toolDefinitions } from "../src/tools/registry.js";

const skillUrl = new URL("../../../skills/local-ydb/SKILL.md", import.meta.url);
const scenariosUrl = new URL(
  "../../../skills/local-ydb/references/mcp-tool-scenarios.md",
  import.meta.url,
);
const rootScenariosUrl = new URL("../../../MCP_TOOL_TEST_SCENARIOS.md", import.meta.url);

const publicToolNames = toolDefinitions.map((definition) => definition.name).sort();

function read(url: URL): string {
  return readFileSync(url, "utf8");
}

function extractReferencedSkillFiles(skill: string): string[] {
  return Array.from(skill.matchAll(/`(references\/[^`]+\.md)`/g), (match) => match[1]);
}

function extractScenarioScopeTools(scenarios: string): string[] {
  const scope = scenarios.match(
    /This document covers all public `local_ydb_\*` tools currently registered by the MCP server:\n\n(?<list>[\s\S]*?)\n\n## Profiles/,
  )?.groups?.list;
  if (!scope) {
    throw new Error("Could not find MCP tool scenario scope list");
  }
  return Array.from(scope.matchAll(/^- `(local_ydb_[a-z_]+)`$/gm), (match) => match[1]).sort();
}

describe("documentation consistency", () => {
  it("keeps SKILL.md reference links resolvable", () => {
    const references = extractReferencedSkillFiles(read(skillUrl));

    expect(references).toContain("references/mcp-tool-scenarios.md");
    for (const reference of references) {
      expect(existsSync(new URL(`../../../skills/local-ydb/${reference}`, import.meta.url))).toBe(true);
    }
  });

  it("keeps the canonical MCP scenario scope in sync with registered tools", () => {
    expect(extractScenarioScopeTools(read(scenariosUrl))).toEqual(publicToolNames);
  });

  it("mentions every public MCP tool in the canonical scenario runbook", () => {
    const scenarios = read(scenariosUrl);

    for (const toolName of publicToolNames) {
      expect(scenarios).toContain(toolName);
    }
  });

  it("keeps server instructions aligned with registered tools", () => {
    for (const toolName of publicToolNames) {
      expect(localYdbInstructions).toContain(toolName);
    }
  });

  it("keeps the root scenario document as a pointer to the canonical skill reference", () => {
    expect(read(rootScenariosUrl)).toContain("skills/local-ydb/references/mcp-tool-scenarios.md");
  });
});
