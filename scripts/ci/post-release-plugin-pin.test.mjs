import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/publish-mcp-server.yml", import.meta.url),
  "utf8",
);
const actionSha = "5f6978faf089d4d20b00c7766989d076bb2fc7f1";
const actionUse = `peter-evans/create-pull-request@${actionSha}`;
const secretReference = "${{ secrets.RELEASE_PLEASE_TOKEN }}";
const focusedContracts = [
  "scripts/ci/update-agent-plugin-pin.test.mjs",
  "scripts/ci/check-agent-plugin-freshness.test.mjs",
  "scripts/ci/agent-plugin-workflow.test.mjs",
  "scripts/ci/post-release-plugin-pin.test.mjs",
];
const changedPaths = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "README.md",
  "docs/openai-plugin-submission.md",
  "gemini-extension.json",
  "mcp.json",
  "plugin.json",
];

function workflowJob(name, source = workflow) {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `publish workflow must define ${name}`);
  const remaining = source.slice(start + marker.length);
  const nextJob = remaining.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJob === -1 ? remaining : remaining.slice(0, nextJob);
}

function workflowStepByUses(job, uses) {
  const marker = `      - uses: ${uses}\n`;
  const start = job.indexOf(marker);
  assert.notEqual(start, -1, `workflow job must use ${uses}`);
  const remaining = job.slice(start + marker.length);
  const nextStep = remaining.search(/^      - (?:name|uses|run):/m);
  return nextStep === -1 ? remaining : remaining.slice(0, nextStep);
}

function workflowStepByName(job, name) {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  assert.notEqual(start, -1, `workflow job must define step ${name}`);
  const remaining = job.slice(start + marker.length);
  const nextStep = remaining.search(/^      - (?:name|uses|run):/m);
  return nextStep === -1 ? remaining : remaining.slice(0, nextStep);
}

test("one post-release job handles normal and recovery publication", () => {
  const jobNames = [...workflow.matchAll(/^  (post-release-plugin-pin[^:]*):$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(jobNames, ["post-release-plugin-pin"]);

  const job = workflowJob("post-release-plugin-pin");
  for (const dependency of ["release-please", "publish", "publish-existing-release"]) {
    assert.match(job, new RegExp(`^      - ${dependency}$`, "m"));
  }
  assert.match(job, /always\(\)/);
  assert.match(job, /needs\.release-please\.outputs\.release_created == 'true'/);
  assert.match(job, /needs\.publish\.result == 'success'/);
  assert.match(job, /needs\.publish-existing-release\.result == 'success'/);
  assert.match(
    job,
    /RELEASE_TAG: \$\{\{ needs\.publish-existing-release\.outputs\.tag_name \|\| needs\.release-please\.outputs\.tag_name \}\}/,
  );
  assert.match(
    job,
    /RELEASE_VERSION: \$\{\{ needs\.publish-existing-release\.outputs\.version \|\| needs\.release-please\.outputs\.version \}\}/,
  );
});

test("post-release validation checks the exact publication before proposing changes", () => {
  const job = workflowJob("post-release-plugin-pin");
  assert.match(job, /ref: refs\/heads\/main/);
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /node-version: "24"/);
  assert.match(job, /\^\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/);
  assert.match(job, /mcp-server-v\$\{RELEASE_VERSION\}/);

  const updateIndex = job.indexOf("node scripts/ci/update-agent-plugin-pin.mjs");
  const freshnessIndex = job.indexOf("node scripts/ci/check-agent-plugin-freshness.mjs");
  const contractsIndex = job.indexOf("node --test");
  const hooksIndex = job.indexOf("git config --local core.hooksPath /dev/null");
  const actionIndex = job.indexOf(actionUse);
  assert.ok(updateIndex >= 0, "post-release job must run the deterministic updater");
  assert.ok(freshnessIndex > updateIndex, "freshness readback must follow the update");
  assert.ok(contractsIndex > freshnessIndex, "focused contracts must follow freshness readback");
  assert.ok(hooksIndex > contractsIndex, "Git hooks must be disabled after validation");
  assert.ok(actionIndex > hooksIndex, "the token-bearing action must be the final operation");
  assert.match(
    job,
    /node scripts\/ci\/update-agent-plugin-pin\.mjs --mcp-version "\$\{RELEASE_VERSION\}" --write/,
  );
  for (const contract of focusedContracts) {
    assert.match(job, new RegExp(contract.replaceAll(".", "\\.")));
  }
});

test("create-pull-request is immutable and configured for the exact draft proposal", () => {
  const job = workflowJob("post-release-plugin-pin");
  const actionStep = workflowStepByUses(job, actionUse);
  assert.match(actionStep, /token: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/);
  assert.match(actionStep, /base: main/);
  assert.match(
    actionStep,
    /branch: codex\/update-plugin-mcp-pin-v\$\{\{ steps\.publication\.outputs\.mcp_version \}\}/,
  );
  assert.equal(
    actionStep.split("chore(plugin): pin published MCP ${{ steps.publication.outputs.mcp_version }}").length - 1,
    2,
    "title and commit message must be identical",
  );
  assert.match(actionStep, /draft: always-true/);
  assert.match(actionStep, /delete-branch: false/);
  assert.match(actionStep, /committer: github-actions\[bot\] <41898282\+github-actions\[bot\]@users\.noreply\.github\.com>/);
  assert.match(actionStep, /author: github-actions\[bot\] <41898282\+github-actions\[bot\]@users\.noreply\.github\.com>/);

  const addPaths = /          add-paths: \|\n((?:            [^\n]+\n)+)/.exec(actionStep);
  assert.ok(addPaths, "create-pull-request must define an explicit add-paths allowlist");
  assert.deepEqual(
    addPaths[1].trim().split("\n").map((line) => line.trim()),
    changedPaths,
  );
});

test("draft body records publication evidence and the manual Cursor boundary", () => {
  const actionStep = workflowStepByUses(workflowJob("post-release-plugin-pin"), actionUse);
  assert.match(actionStep, /body: \|/);
  assert.match(actionStep, /GitHub release output: `mcp-server-v\$\{\{ steps\.publication\.outputs\.mcp_version \}\}`/);
  assert.match(actionStep, /npm latest readback: `@astandrik\/local-ydb-mcp@\$\{\{ steps\.publication\.outputs\.mcp_version \}\}`/);
  assert.match(actionStep, /MCP Registry readback: `io\.github\.astandrik\/local-ydb-mcp@\$\{\{ steps\.publication\.outputs\.mcp_version \}\}`/);
  assert.match(actionStep, /Manual Cursor Directory follow-up:/);
  assert.match(actionStep, /Merge this draft PR only after review/);
  assert.match(actionStep, /Update the Cursor Directory entry only after merge/);
  assert.match(actionStep, /Submit the Cursor Directory entry for rescan/);
});

test("PAT is limited to the two action inputs and never reaches shell", () => {
  const postReleaseJob = workflowJob("post-release-plugin-pin");
  const releasePleaseJob = workflowJob("release-please");
  const actionStep = workflowStepByUses(postReleaseJob, actionUse);
  assert.equal(workflow.split(secretReference).length - 1, 2);
  assert.match(releasePleaseJob, /token: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/);
  assert.match(actionStep, /token: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /RELEASE_PLEASE_TOKEN\s*\|\|\s*github\.token/);
  assert.doesNotMatch(workflow, /(?:GH_TOKEN|GITHUB_TOKEN): \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/);
  assert.equal(postReleaseJob.trimEnd().endsWith(actionStep.trimEnd()), true);
});

test("the proposal job executes no package installation or build before the PAT action", () => {
  const job = workflowJob("post-release-plugin-pin");
  assert.doesNotMatch(job, /\bnpm (?:ci|install|run|pack|exec)\b/);
  assert.doesNotMatch(job, /\bnpx\b/);
  assert.doesNotMatch(job, /plugin:(?:package|smoke)/);
  assert.doesNotMatch(job, /cache: npm/);
  assert.match(job, /permissions:\n      contents: read/);
  assert.doesNotMatch(job, /pull-requests: write/);
});

test("custom artifact and pull-request state machines are absent", () => {
  for (const forbidden of [
    "actions/upload-artifact",
    "actions/download-artifact",
    "post-release-plugin-pin.mjs",
    "POST_RELEASE_PLUGIN_PIN_STATE_CLASSIFIER",
    "POST_RELEASE_PLUGIN_PIN_CHANGE_GATE",
    "patch_sha256",
    "body_sha256",
    "gh pr ",
    "git push",
    "--force-with-lease",
    "auto-merge",
  ]) {
    assert.equal(workflow.includes(forbidden), false, `workflow must not contain ${forbidden}`);
  }
});

test("publication validation exports the version consumed by the action", () => {
  const step = workflowStepByName(
    workflowJob("post-release-plugin-pin"),
    "Validate published MCP and update plugin pin",
  );
  assert.match(step, /id: publication/);
  assert.match(step, /echo "mcp_version=\$\{RELEASE_VERSION\}" >> "\$\{GITHUB_OUTPUT\}"/);
});
