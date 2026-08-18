import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/publish-mcp-server.yml", import.meta.url),
  "utf8",
);

function postReleaseJob() {
  const marker = "  post-release-plugin-pin:\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "publish workflow must define post-release-plugin-pin");
  const remaining = workflow.slice(start + marker.length);
  const nextJob = remaining.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJob === -1 ? remaining : remaining.slice(0, nextJob);
}

test("post-release pinning is gated by a newly created release and successful publication", () => {
  const job = postReleaseJob();

  assert.match(job, /needs:\n\s+- release-please\n\s+- publish/);
  assert.match(job, /needs\.release-please\.outputs\.release_created == 'true'/);
  assert.match(job, /needs\.publish\.result == 'success'/);
  assert.match(job, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(job, /contents: write|pull-requests: write|id-token: write/);
});

test("publication metadata is revalidated before the updater changes plugin files", () => {
  const job = postReleaseJob();
  const revalidate = job.indexOf("Revalidate published MCP metadata");
  const update = job.indexOf("npm run plugin:pin -- --mcp-version");

  assert.ok(revalidate >= 0, "missing release/publication revalidation step");
  assert.ok(update > revalidate, "publication must be revalidated before plugin mutation");
  for (const contract of [
    "assertStableSemver",
    "checkAgentPluginFreshness",
    "loadFreshnessInputs",
    "npmPackageFromServer",
    "RELEASE_TAG",
    "npm_package=",
    "registry_server=",
  ]) {
    assert.ok(job.includes(contract), `missing revalidation contract: ${contract}`);
  }
});

test("the updater is followed by focused contracts, build, package, freshness, and published smoke", () => {
  const job = postReleaseJob();
  const update = job.indexOf("npm run plugin:pin -- --mcp-version");

  for (const command of [
    "node --test scripts/ci/update-agent-plugin-pin.test.mjs scripts/ci/check-agent-plugin-freshness.test.mjs scripts/ci/post-release-plugin-pin.test.mjs",
    "npm run build",
    "npm run plugin:freshness",
    "npm run plugin:package",
    "npm run plugin:smoke",
  ]) {
    assert.ok(job.indexOf(command) > update, `${command} must run after the updater`);
  }
});

test("the checkout and final draft PR step preserve the credential boundary", () => {
  const job = postReleaseJob();
  const secretReference = "secrets.RELEASE_PLEASE_TOKEN";

  assert.match(job, /uses: actions\/checkout@v6[\s\S]*?persist-credentials: false/);
  assert.equal(workflow.split(secretReference).length - 1, 1);
  assert.doesNotMatch(workflow, /RELEASE_PLEASE_TOKEN\s*\|\|\s*github\.token/);
  assert.match(job, /if: \$\{\{ steps\.pin\.outputs\.changed == 'true' \}\}/);
  assert.match(job, /GH_TOKEN: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/);
  assert.match(job, /gh auth setup-git/);
  assert.match(job, /gh pr create[\s\S]*--draft/);
  assert.match(job, /branch="codex\/update-plugin-mcp-pin-v\$\{MCP_VERSION\}"/);
  assert.match(job, /title="chore\(plugin\): pin published MCP \$\{MCP_VERSION\}"/);
});

test("the workflow excludes direct, force, and automatic merge paths", () => {
  const job = postReleaseJob();

  assert.doesNotMatch(job, /git push[^\n]*(--force|-f\b|origin\s+(HEAD:)?main\b)/);
  assert.doesNotMatch(job, /gh pr (merge|ready)|--auto\b/);
  assert.doesNotMatch(job, /github\.token/);
  assert.match(job, /git push --set-upstream origin "\$\{branch\}"/);
});

test("the PR body records exact readback evidence and keeps Cursor follow-up manual", () => {
  const job = postReleaseJob();

  for (const text of [
    "MCP Registry readback",
    "REGISTRY_SERVER",
    "REGISTRY_NPM_PACKAGE",
    "Manual Cursor Directory follow-up",
    "[ ] Merge this draft PR only after review.",
    "[ ] Update the Cursor Directory entry only after merge.",
    "[ ] Submit the Cursor Directory entry for rescan.",
  ]) {
    assert.ok(job.includes(text), `missing PR evidence/checklist text: ${text}`);
  }
});

test("PR state classification creates only from an unused branch", async () => {
  const { classifyPullRequestState } = await import("./post-release-plugin-pin.mjs");

  assert.deepEqual(
    classifyPullRequestState({
      repository: "astandrik/local-ydb-toolkit",
      version: "0.17.0",
      branchExists: false,
      pullRequests: [],
    }),
    {
      action: "create",
      branch: "codex/update-plugin-mcp-pin-v0.17.0",
      title: "chore(plugin): pin published MCP 0.17.0",
    },
  );
});

test("PR state classification returns one exact open draft PR", async () => {
  const { classifyPullRequestState } = await import("./post-release-plugin-pin.mjs");
  const url = "https://github.com/astandrik/local-ydb-toolkit/pull/150";

  assert.deepEqual(
    classifyPullRequestState({
      repository: "astandrik/local-ydb-toolkit",
      version: "0.17.0",
      branchExists: true,
      pullRequests: [{
        url,
        state: "OPEN",
        isDraft: true,
        mergedAt: null,
        title: "chore(plugin): pin published MCP 0.17.0",
        headRefName: "codex/update-plugin-mcp-pin-v0.17.0",
        baseRefName: "main",
        body: "MCP Registry readback: io.github.astandrik/local-ydb-mcp@0.17.0; npm package @astandrik/local-ydb-mcp@0.17.0\n\nManual Cursor Directory follow-up",
      }],
    }),
    {
      action: "return",
      branch: "codex/update-plugin-mcp-pin-v0.17.0",
      title: "chore(plugin): pin published MCP 0.17.0",
      url,
    },
  );
});

test("PR state classification fails closed on orphan, closed-unmerged, and invalid open states", async (t) => {
  const { classifyPullRequestState } = await import("./post-release-plugin-pin.mjs");
  const base = {
    repository: "astandrik/local-ydb-toolkit",
    version: "0.17.0",
  };

  await t.test("orphan branch", () => {
    assert.throws(
      () => classifyPullRequestState({ ...base, branchExists: true, pullRequests: [] }),
      /orphan branch/i,
    );
  });

  await t.test("closed unmerged PR", () => {
    assert.throws(
      () => classifyPullRequestState({
        ...base,
        branchExists: false,
        pullRequests: [{
          url: "https://github.com/astandrik/local-ydb-toolkit/pull/149",
          state: "CLOSED",
          isDraft: true,
          mergedAt: null,
          title: "chore(plugin): pin published MCP 0.17.0",
          headRefName: "codex/update-plugin-mcp-pin-v0.17.0",
          baseRefName: "main",
          body: "MCP Registry readback: io.github.astandrik/local-ydb-mcp@0.17.0; npm package @astandrik/local-ydb-mcp@0.17.0\n\nManual Cursor Directory follow-up",
        }],
      }),
      /closed unmerged pull request/i,
    );
  });

  await t.test("non-draft open PR", () => {
    assert.throws(
      () => classifyPullRequestState({
        ...base,
        branchExists: true,
        pullRequests: [{
          url: "https://github.com/astandrik/local-ydb-toolkit/pull/150",
          state: "OPEN",
          isDraft: false,
          mergedAt: null,
          title: "chore(plugin): pin published MCP 0.17.0",
          headRefName: "codex/update-plugin-mcp-pin-v0.17.0",
          baseRefName: "main",
        }],
      }),
      /does not match the required draft PR contract/i,
    );
  });
});

test("PR state classification rejects unsafe versions before deriving a branch", async () => {
  const { classifyPullRequestState } = await import("./post-release-plugin-pin.mjs");

  assert.throws(
    () => classifyPullRequestState({
      repository: "astandrik/local-ydb-toolkit",
      version: "0.17.0;git push origin main",
      branchExists: false,
      pullRequests: [],
    }),
    /stable X\.Y\.Z semver/i,
  );
});
