import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guidanceFiles = [
  ["README.md", "../../README.md"],
  ["packages/mcp-server/README.md", "../../packages/mcp-server/README.md"],
  ["packages/mcp-server/src/prompts.ts", "../../packages/mcp-server/src/prompts.ts"],
  ["packages/mcp-server/src/tools/instructions.ts", "../../packages/mcp-server/src/tools/instructions.ts"],
  ["packages/mcp-server/src/tools/input-schemas.ts", "../../packages/mcp-server/src/tools/input-schemas.ts"],
  ["packages/core/src/confirmation.ts", "../../packages/core/src/confirmation.ts"],
  ["skills/local-ydb/SKILL.md", "../../skills/local-ydb/SKILL.md"],
  ["MCP_TOOL_TEST_SCENARIOS.md", "../../MCP_TOOL_TEST_SCENARIOS.md"],
  [
    "skills/local-ydb/references/mcp-tool-scenarios.md",
    "../../skills/local-ydb/references/mcp-tool-scenarios.md",
  ],
  ["docs/diagnostics-coverage.md", "../../docs/diagnostics-coverage.md"],
  ["docs/reference/safety.mdx", "../../docs/reference/safety.mdx"],
  ["docs/workflows/diagnostics.mdx", "../../docs/workflows/diagnostics.mdx"],
];

const ambiguousResponseReferences = [
  /returned `?confirmationToken`?/,
  /response's `?confirmationToken`?/,
  /plan's(?: one-time)? `?confirmationToken`?/,
  /its `?confirmationToken`?/,
  /plan plus one-time `confirmationToken`/,
  /token-from-the-plan-response/,
];

test("distinguishes response confirmation.token from request confirmationToken", () => {
  const guidance = new Map(guidanceFiles.map(([label, relativePath]) => [
    label,
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ]));

  for (const [label, text] of guidance) {
    assert.match(text, /confirmation\.token/, `${label} must name the response field`);
    assert.match(text, /confirmationToken/, `${label} must name the request argument`);
    for (const pattern of ambiguousResponseReferences) {
      assert.doesNotMatch(text, pattern, `${label} must not describe the request argument as a response field`);
    }
  }

  const rulePrefix = "- For every mutating tool,";
  const rootRule = guidance.get("MCP_TOOL_TEST_SCENARIOS.md")
    ?.split("\n")
    .find((line) => line.startsWith(rulePrefix));
  const skillRule = guidance.get("skills/local-ydb/references/mcp-tool-scenarios.md")
    ?.split("\n")
    .find((line) => line.startsWith(rulePrefix));

  assert.ok(rootRule, "root scenarios must contain the canonical mutation rule");
  assert.equal(skillRule, rootRule, "scenario copies must use the same token-field guidance");
  assert.match(rootRule, /`confirmation\.token`/);
  assert.match(rootRule, /`confirmationToken` request argument/);
});
