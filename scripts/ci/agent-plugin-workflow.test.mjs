import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/agent-plugin-smoke.yml", import.meta.url),
  "utf8",
);

function workflowJob(name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Agent Plugin workflow must define ${name}`);
  const remaining = workflow.slice(start + marker.length);
  const nextJob = remaining.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJob === -1 ? remaining : remaining.slice(0, nextJob);
}

test("freshness runs only after publication through schedule or manual dispatch", () => {
  const job = workflowJob("plugin-freshness");

  assert.match(
    job,
    /if: >-\n\s+github\.event_name == 'schedule' \|\|\n\s+github\.event_name == 'workflow_dispatch'/,
  );
  assert.doesNotMatch(job, /github\.event_name == '(?:push|pull_request)'/);
});

test("published MCP compatibility remains selected for every workflow trigger", () => {
  const job = workflowJob("published-mcp-smoke");

  for (const trigger of ["push", "pull_request", "workflow_dispatch", "schedule"]) {
    assert.match(workflow, new RegExp(`^  ${trigger}:`, "m"));
  }
  assert.doesNotMatch(job, /(?:^|\n)\s+if:/);
});

test("published MCP smoke allows a cold install to finish", () => {
  const job = workflowJob("published-mcp-smoke");

  assert.match(job, /^\s+timeout-minutes: 10$/m);
});

test("launcher metadata and contracts trigger both push and pull request checks", () => {
  for (const path of [
    ".codex-plugin/**", ".claude-plugin/plugin.json", "gemini-extension.json",
    ".mcp.json", "mcp.json", "packages/*/package.json", "scripts/ci/*plugin*.mjs",
  ]) {
    assert.equal(workflow.split(JSON.stringify(path)).length - 1, 2, path);
  }
});

test("published smoke covers the minimum Node version and CI Node after contract checks", () => {
  const job = workflowJob("published-mcp-smoke");
  assert.match(job, /node: \["20\.19\.0", "24"\]/);
  assert.match(job, /node-version: \$\{\{ matrix\.node \}\}/);
  const contracts = job.indexOf("node --test scripts/ci/*plugin*.test.mjs");
  assert(contracts > job.indexOf("npm ci"));
  assert(job.indexOf("npm run plugin:smoke") > contracts);
});
