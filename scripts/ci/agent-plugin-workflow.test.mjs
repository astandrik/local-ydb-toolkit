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

test("workflow contract changes trigger both push and pull request checks", () => {
  const contractPath = '"scripts/ci/agent-plugin-workflow.test.mjs"';

  assert.equal(workflow.split(contractPath).length - 1, 2);
});
