import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/publish-mcp-server.yml", import.meta.url),
  "utf8",
);
const repository = "astandrik/local-ydb-toolkit";
const version = "0.17.0";
const branch = `codex/update-plugin-mcp-pin-v${version}`;
const title = `chore(plugin): pin published MCP ${version}`;
const headRefOid = "0123456789abcdef0123456789abcdef01234567";
const canonicalBody = `This draft was created after the MCP release was published and read back.

Publication evidence:
- GitHub release output: mcp-server-v0.17.0
- npm latest readback: @astandrik/local-ydb-mcp@0.17.0
- MCP Registry readback: io.github.astandrik/local-ydb-mcp@0.17.0; npm package @astandrik/local-ydb-mcp@0.17.0

Automated checks: focused updater/freshness/workflow contracts, package build, plugin package, freshness readback, and published MCP smoke.

Manual Cursor Directory follow-up:
- [ ] Merge this draft PR only after review.
- [ ] Update the Cursor Directory entry only after merge.
- [ ] Confirm the Cursor command pins @astandrik/local-ydb-mcp@0.17.0.
- [ ] Submit the Cursor Directory entry for rescan.`;

function postReleaseJob() {
  const marker = "  post-release-plugin-pin:\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "publish workflow must define post-release-plugin-pin");
  const remaining = workflow.slice(start + marker.length);
  const nextJob = remaining.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJob === -1 ? remaining : remaining.slice(0, nextJob);
}

function validPullRequest(overrides = {}) {
  return {
    url: "https://github.com/astandrik/local-ydb-toolkit/pull/150",
    state: "OPEN",
    isDraft: true,
    mergedAt: null,
    title,
    headRefName: branch,
    baseRefName: "main",
    body: canonicalBody,
    isCrossRepository: false,
    headRepository: { name: "local-ydb-toolkit" },
    headRepositoryOwner: { login: "astandrik" },
    headRefOid,
    ...overrides,
  };
}

function assertOnlySafePushCommand(source) {
  const commands = source
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /(?:^|[\s/])git\s+push(?:\s|$)/.test(line));
  assert.deepEqual(
    commands,
    ['git push --set-upstream origin "${branch}"'],
    `unsafe git push command: ${commands.join(" | ") || "missing"}`,
  );
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

  assertOnlySafePushCommand(job);
  assert.doesNotMatch(job, /gh pr (merge|ready)|--auto\b/);
  assert.doesNotMatch(job, /github\.token/);
});

test("the push-command guard rejects direct-main and force refspec variants", () => {
  for (const command of [
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin HEAD:refs/heads/main",
    'git push origin "${branch}:refs/heads/main"',
    'git push --force origin "${branch}"',
    'git push --force-with-lease origin "${branch}"',
    'git push -f origin "${branch}"',
    "git push origin +HEAD:refs/heads/main",
    'git push origin "+${branch}:refs/heads/codex/update-plugin-mcp-pin-v0.17.0"',
    "command git push origin HEAD:refs/heads/main",
    "env GIT_CONFIG_COUNT=0 git push --force origin feature",
    "/usr/bin/git push origin main",
  ]) {
    assert.throws(() => assertOnlySafePushCommand(command), /unsafe git push command/);
  }
});

test("the workflow delegates PR body construction to the canonical helper", () => {
  const job = postReleaseJob();

  assert.match(job, /node scripts\/ci\/post-release-plugin-pin\.mjs --body/);
  assert.match(job, /--body-file "\$\{body_file\}"/);
});

test("existing PR reuse is bound to the same-repository upstream branch OID", () => {
  const job = postReleaseJob();

  for (const field of [
    "isCrossRepository",
    "headRepository",
    "headRepositoryOwner",
    "headRefOid",
  ]) {
    assert.ok(job.includes(field), `missing existing-PR identity field: ${field}`);
  }
  assert.match(job, /branch_oid=/);
  assert.match(job, /git rev-parse "refs\/remotes\/origin\/\$\{branch\}"/);
  assert.match(job, /existing_head_oid/);
});

test("PR state classification creates only from an unused branch", async () => {
  const { classifyPullRequestState } = await import("./post-release-plugin-pin.mjs");

  assert.deepEqual(
    classifyPullRequestState({
      repository,
      version,
      branchExists: false,
      branchOid: null,
      pullRequests: [],
    }),
    {
      action: "create",
      branch,
      title,
    },
  );
});

test("PR state classification returns one exact open draft PR", async () => {
  const { classifyPullRequestState } = await import("./post-release-plugin-pin.mjs");
  const pullRequest = validPullRequest();

  assert.deepEqual(
    classifyPullRequestState({
      repository,
      version,
      branchExists: true,
      branchOid: headRefOid,
      pullRequests: [pullRequest],
    }),
    {
      action: "return",
      branch,
      title,
      url: pullRequest.url,
      headRefOid,
    },
  );
});

test("PR state classification rejects fork heads and mismatched upstream OIDs", async (t) => {
  const { classifyPullRequestState } = await import("./post-release-plugin-pin.mjs");
  const base = {
    repository,
    version,
    branchExists: true,
    branchOid: headRefOid,
  };

  await t.test("fork head", () => {
    assert.throws(
      () => classifyPullRequestState({
        ...base,
        pullRequests: [validPullRequest({
          isCrossRepository: true,
          headRepositoryOwner: { login: "attacker" },
        })],
      }),
      /same-repository upstream head/i,
    );
  });

  await t.test("mismatched head OID", () => {
    assert.throws(
      () => classifyPullRequestState({
        ...base,
        pullRequests: [validPullRequest({
          headRefOid: "fedcba9876543210fedcba9876543210fedcba98",
        })],
      }),
      /head OID does not match the upstream branch/i,
    );
  });
});

test("the canonical PR body contains every exact release and manual-follow-up line", async () => {
  const { createPullRequestBody } = await import("./post-release-plugin-pin.mjs");

  assert.equal(createPullRequestBody(version), canonicalBody);
});

test("PR state classification rejects missing evidence and checklist lines", async (t) => {
  const { classifyPullRequestState } = await import("./post-release-plugin-pin.mjs");
  const base = {
    repository,
    version,
    branchExists: true,
    branchOid: headRefOid,
  };

  await t.test("missing GitHub release evidence", () => {
    assert.throws(
      () => classifyPullRequestState({
        ...base,
        pullRequests: [validPullRequest({
          body: canonicalBody.replace("- GitHub release output: mcp-server-v0.17.0\n", ""),
        })],
      }),
      /does not match the required draft PR contract/i,
    );
  });

  await t.test("missing Cursor rescan checklist item", () => {
    assert.throws(
      () => classifyPullRequestState({
        ...base,
        pullRequests: [validPullRequest({
          body: canonicalBody.replace("- [ ] Submit the Cursor Directory entry for rescan.", ""),
        })],
      }),
      /does not match the required draft PR contract/i,
    );
  });
});

test("PR state classification fails closed on orphan, closed-unmerged, and invalid open states", async (t) => {
  const { classifyPullRequestState } = await import("./post-release-plugin-pin.mjs");
  const base = {
    repository,
    version,
    branchOid: null,
  };

  await t.test("orphan branch", () => {
    assert.throws(
      () => classifyPullRequestState({
        ...base,
        branchExists: true,
        branchOid: headRefOid,
        pullRequests: [],
      }),
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
          body: canonicalBody,
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
        branchOid: headRefOid,
        pullRequests: [validPullRequest({ isDraft: false })],
      }),
      /does not match the required draft PR contract/i,
    );
  });
});

test("PR state classification rejects unsafe versions before deriving a branch", async () => {
  const { classifyPullRequestState } = await import("./post-release-plugin-pin.mjs");

  assert.throws(
    () => classifyPullRequestState({
      repository,
      version: "0.17.0;git push origin main",
      branchExists: false,
      branchOid: null,
      pullRequests: [],
    }),
    /stable X\.Y\.Z semver/i,
  );
});
