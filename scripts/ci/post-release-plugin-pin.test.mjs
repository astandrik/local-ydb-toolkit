import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function workflowJob(name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `publish workflow must define ${name}`);
  const remaining = workflow.slice(start + marker.length);
  const nextJob = remaining.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJob === -1 ? remaining : remaining.slice(0, nextJob);
}

function workflowStep(job, name) {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  assert.notEqual(start, -1, `workflow job must define step ${name}`);
  const remaining = job.slice(start + marker.length);
  const nextStep = remaining.search(/^      - (?:name|uses|run):/m);
  return nextStep === -1 ? remaining : remaining.slice(0, nextStep);
}

function inlineWorkflowBlock(beginMarker, endMarker) {
  const start = workflow.indexOf(beginMarker);
  const end = workflow.indexOf(endMarker);
  assert.ok(start >= 0, `missing workflow marker: ${beginMarker}`);
  assert.ok(end > start, `missing workflow marker: ${endMarker}`);
  return workflow
    .slice(start + beginMarker.length, end)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n")
    .trim();
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

async function runProductionClassifier({
  branchExists = false,
  branchOid = "",
  pullRequests = [],
  body = canonicalBody,
  proposalPatch = "exact plugin patch\n",
  existingPatch = proposalPatch,
} = {}) {
  const fixture = await mkdtemp(join(tmpdir(), "plugin-pin-classifier-"));
  try {
    const bodyPath = join(fixture, "pr-body.md");
    const proposalPatchPath = join(fixture, "proposal.patch");
    const existingPatchPath = join(fixture, "existing.patch");
    await Promise.all([
      writeFile(bodyPath, body),
      writeFile(proposalPatchPath, proposalPatch),
      writeFile(existingPatchPath, existingPatch),
    ]);
    const { GH_TOKEN: _ignored, ...environment } = process.env;
    return spawnSync(process.execPath, ["--input-type=module"], {
      input: inlineWorkflowBlock(
        "// BEGIN POST_RELEASE_PLUGIN_PIN_STATE_CLASSIFIER",
        "// END POST_RELEASE_PLUGIN_PIN_STATE_CLASSIFIER",
      ),
      env: {
        ...environment,
        BODY_PATH: bodyPath,
        BRANCH: branch,
        BRANCH_EXISTS: String(branchExists),
        BRANCH_OID: branchOid,
        EXISTING_PATCH_PATH: existingPatchPath,
        GITHUB_REPOSITORY: repository,
        PROPOSAL_PATCH_PATH: proposalPatchPath,
        PULL_REQUESTS_JSON: JSON.stringify(pullRequests),
        TITLE: title,
      },
      encoding: "utf8",
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function runProductionChangeGate() {
  const fixture = await mkdtemp(join(tmpdir(), "plugin-pin-change-gate-"));
  try {
    const runGit = (args) => {
      const result = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    runGit(["init", "--quiet"]);
    runGit(["config", "user.name", "Contract Test"]);
    runGit(["config", "user.email", "contract@example.test"]);
    await writeFile(join(fixture, "tracked.txt"), "clean\n");
    runGit(["add", "tracked.txt"]);
    runGit(["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-verify", "-m", "fixture"]);

    const outputPath = join(fixture, "github-output");
    const result = spawnSync("bash", ["-euo", "pipefail"], {
      cwd: fixture,
      input: inlineWorkflowBlock(
        "# BEGIN POST_RELEASE_PLUGIN_PIN_CHANGE_GATE",
        "# END POST_RELEASE_PLUGIN_PIN_CHANGE_GATE",
      ),
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        MCP_VERSION: version,
      },
      encoding: "utf8",
    });
    return {
      ...result,
      output: await readFile(outputPath, "utf8"),
    };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

function assertOnlySafePushCommand(source) {
  const commands = source
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /(?:^|[\s/])git(?:\s+-c\s+\S+)*\s+push(?:\s|$)/.test(line));
  assert.deepEqual(
    commands,
    ['git -c core.hooksPath=/dev/null push --no-verify --set-upstream origin "${BRANCH}"'],
    `unsafe git push command: ${commands.join(" | ") || "missing"}`,
  );
}

test("post-release pinning is gated by a newly created release and successful publication", () => {
  const job = workflowJob("post-release-plugin-pin-prepare");

  assert.match(job, /needs:\n\s+- release-please\n\s+- publish/);
  assert.match(job, /needs\.release-please\.outputs\.release_created == 'true'/);
  assert.match(job, /needs\.publish\.result == 'success'/);
  assert.match(job, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(job, /contents: write|pull-requests: write|id-token: write/);
});

test("publication metadata is revalidated before the updater changes plugin files", () => {
  const job = workflowJob("post-release-plugin-pin-prepare");
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
  const job = workflowJob("post-release-plugin-pin-prepare");
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

test("the PAT-bearing mutation runs in a fresh job after tokenless preparation", () => {
  const prepareJob = workflowJob("post-release-plugin-pin-prepare");
  const mutationJob = workflowJob("post-release-plugin-pin-mutate");
  const finalStep = workflowStep(mutationJob, "Create plugin pin branch and draft PR");
  const secretReference = "secrets.RELEASE_PLEASE_TOKEN";

  assert.doesNotMatch(prepareJob, /RELEASE_PLEASE_TOKEN/);
  assert.doesNotMatch(prepareJob, /github\.token/);
  assert.match(mutationJob, /needs:\n\s+- post-release-plugin-pin-prepare/);
  assert.match(mutationJob, /uses: actions\/checkout@v6[\s\S]*?persist-credentials: false/);
  assert.match(mutationJob, /uses: actions\/download-artifact@v5/);
  assert.doesNotMatch(mutationJob, /github\.token/);
  assert.equal(workflow.split(secretReference).length - 1, 1);
  assert.doesNotMatch(workflow, /RELEASE_PLEASE_TOKEN\s*\|\|\s*github\.token/);
  assert.match(finalStep, /GH_TOKEN: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/);
  assert.match(finalStep, /gh auth setup-git/);
  assert.match(finalStep, /gh pr create[\s\S]*--draft/);
  assert.doesNotMatch(finalStep, /\b(?:npm|npx)\b|node\s+(?:\.\/)?scripts\//);
});

test("the fresh mutation job never executes package or checked-out repository code", () => {
  const job = workflowJob("post-release-plugin-pin-mutate");

  assert.doesNotMatch(job, /uses: actions\/setup-node/);
  assert.doesNotMatch(job, /(?:^|\n)\s+(?:npm|npx)\b/);
  assert.doesNotMatch(job, /node\s+(?:\.\/)?scripts\//);
  assert.doesNotMatch(job, /\.\/scripts\//);
  assert.match(job, /node --input-type=module <<'NODE'/);
});

test("the workflow excludes direct, force, and automatic merge paths", () => {
  const job = workflowJob("post-release-plugin-pin-mutate");

  assertOnlySafePushCommand(job);
  assert.doesNotMatch(job, /gh pr (merge|ready)|--auto\b/);
  assert.match(job, /git -c core\.hooksPath=\/dev\/null switch/);
  assert.match(job, /git -c core\.hooksPath=\/dev\/null commit --no-verify/);
  assert.match(job, /git -c core\.hooksPath=\/dev\/null push --no-verify/);
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
  const prepareJob = workflowJob("post-release-plugin-pin-prepare");
  const mutationJob = workflowJob("post-release-plugin-pin-mutate");

  assert.match(prepareJob, /node scripts\/ci\/post-release-plugin-pin\.mjs --body/);
  assert.match(mutationJob, /--body-file "proposal\/pr-body\.md"/);
});

test("existing PR reuse is bound to the same-repository upstream branch OID", () => {
  const job = workflowJob("post-release-plugin-pin-mutate");

  for (const field of [
    "isCrossRepository",
    "headRepository",
    "headRepositoryOwner",
    "headRefOid",
  ]) {
    assert.ok(job.includes(field), `missing existing-PR identity field: ${field}`);
  }
  assert.match(job, /branch_oid=/);
  assert.match(job, /git rev-parse "refs\/remotes\/origin\/\$\{BRANCH\}"/);
  assert.match(job, /pr\.headRefOid !== branchOid/);
});

test("the preparation job exports only a checksummed inert proposal artifact", () => {
  const prepareJob = workflowJob("post-release-plugin-pin-prepare");
  const mutationJob = workflowJob("post-release-plugin-pin-mutate");

  assert.match(prepareJob, /uses: actions\/upload-artifact@v4/);
  assert.match(prepareJob, /plugin-pin-proposal\.json/);
  assert.match(prepareJob, /plugin-pin\.patch/);
  assert.match(prepareJob, /pr-body\.md/);
  assert.match(prepareJob, /patch_sha256:/);
  assert.match(mutationJob, /needs\.post-release-plugin-pin-prepare\.outputs\.patch_sha256/);
  assert.match(mutationJob, /git apply --check "proposal\/plugin-pin\.patch"/);
  assert.match(mutationJob, /git apply "proposal\/plugin-pin\.patch"/);
  assert.match(mutationJob, /cmp "proposal\/plugin-pin\.patch"/);
});

test("the fresh mutation job independently validates the exact plugin transformation", () => {
  const job = workflowJob("post-release-plugin-pin-mutate");

  assert.match(job, /Validate exact plugin transformation/);
  assert.match(job, /execFileSync\("git", \["show", `HEAD:\$\{path\}`\]/);
  assert.match(job, /\$\{packageName\}@\$\{targetVersion\}/);
  assert.match(job, /Expected transformed content mismatch/);
  assert.match(job, /server\.json does not match the trusted published target/);
});

test("the production change gate makes a current main pin a successful no-op", async () => {
  const result = await runProductionChangeGate();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /^mcp_version=0\.17\.0$/m);
  assert.match(result.output, /^base_oid=[0-9a-f]{40}$/m);
  assert.match(result.output, /^changed=false$/m);
});

test("the production inline classifier creates only from an unused branch", async () => {
  const result = await runProductionClassifier();

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { action: "create", url: "" });
});

test("the production inline classifier returns one exact upstream draft", async () => {
  const pullRequest = validPullRequest();
  const result = await runProductionClassifier({
    branchExists: true,
    branchOid: headRefOid,
    pullRequests: [pullRequest],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { action: "return", url: pullRequest.url });
});

test("the production inline classifier rejects fork and OID mismatches", async (t) => {
  await t.test("fork head", async () => {
    const result = await runProductionClassifier({
      branchExists: true,
      branchOid: headRefOid,
      pullRequests: [validPullRequest({
        isCrossRepository: true,
        headRepositoryOwner: { login: "attacker" },
      })],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the required upstream draft contract/i);
  });

  await t.test("head OID mismatch", async () => {
    const result = await runProductionClassifier({
      branchExists: true,
      branchOid: headRefOid,
      pullRequests: [validPullRequest({
        headRefOid: "fedcba9876543210fedcba9876543210fedcba98",
      })],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the required upstream draft contract/i);
  });
});

test("the canonical PR body contains every exact release and manual-follow-up line", async () => {
  const { createPullRequestBody } = await import("./post-release-plugin-pin.mjs");

  assert.equal(createPullRequestBody(version), canonicalBody);
});

test("the production inline classifier rejects body and patch divergence", async (t) => {
  await t.test("body mismatch", async () => {
    const result = await runProductionClassifier({
      branchExists: true,
      branchOid: headRefOid,
      pullRequests: [validPullRequest({ body: "incomplete body" })],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the required upstream draft contract/i);
  });

  await t.test("patch mismatch", async () => {
    const result = await runProductionClassifier({
      branchExists: true,
      branchOid: headRefOid,
      existingPatch: "divergent branch patch\n",
      pullRequests: [validPullRequest()],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not contain the exact proposal patch/i);
  });
});

test("the production inline classifier fails closed on orphan and closed PR state", async (t) => {
  await t.test("orphan branch", async () => {
    const result = await runProductionClassifier({
      branchExists: true,
      branchOid: headRefOid,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /orphan branch/i);
  });

  await t.test("closed unmerged PR", async () => {
    const result = await runProductionClassifier({
      pullRequests: [{
        url: "https://github.com/astandrik/local-ydb-toolkit/pull/149",
        state: "CLOSED",
        mergedAt: null,
      }],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /closed unmerged pull request/i);
  });
});

test("the production inline classifier rejects ambiguous and invalid open PRs", async (t) => {
  await t.test("multiple open PRs", async () => {
    const result = await runProductionClassifier({
      branchExists: true,
      branchOid: headRefOid,
      pullRequests: [validPullRequest(), validPullRequest({
        url: "https://github.com/astandrik/local-ydb-toolkit/pull/151",
      })],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ambiguous/i);
  });

  await t.test("non-draft open PR", async () => {
    const result = await runProductionClassifier({
      branchExists: true,
      branchOid: headRefOid,
      pullRequests: [validPullRequest({ isDraft: false })],
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the required upstream draft contract/i);
  });
});
