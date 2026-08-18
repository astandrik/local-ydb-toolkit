import { pathToFileURL } from "node:url";

const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const gitObjectId = /^[0-9a-f]{40}$/i;
const registryServerName = "io.github.astandrik/local-ydb-mcp";
const npmPackageName = "@astandrik/local-ydb-mcp";

export function classifyPullRequestState({
  repository,
  version,
  branchExists,
  branchOid,
  pullRequests,
}) {
  assertStableSemver(version);
  if (typeof repository !== "string" || !repositoryName.test(repository)) {
    throw new Error("Repository must use the owner/name form");
  }
  if (typeof branchExists !== "boolean") {
    throw new Error("Branch existence must be a boolean");
  }
  if (!Array.isArray(pullRequests)) {
    throw new Error("Pull request state must be a JSON array");
  }
  if (branchExists) {
    if (typeof branchOid !== "string" || !gitObjectId.test(branchOid)) {
      throw new Error("Existing upstream branch must have a full Git object ID");
    }
  } else if (branchOid !== null) {
    throw new Error("A missing upstream branch must not have a Git object ID");
  }

  const branch = `codex/update-plugin-mcp-pin-v${version}`;
  const title = `chore(plugin): pin published MCP ${version}`;
  const [repositoryOwner, repositoryBaseName] = repository.split("/");
  const closedUnmerged = pullRequests.find(
    (pullRequest) => pullRequest?.state === "CLOSED" && pullRequest.mergedAt === null,
  );
  if (closedUnmerged) {
    throw new Error(
      `Refusing to recreate ${branch}: closed unmerged pull request ${String(closedUnmerged.url)}`,
    );
  }

  const openPullRequests = pullRequests.filter((pullRequest) => pullRequest?.state === "OPEN");
  if (openPullRequests.length > 0) {
    if (!branchExists || openPullRequests.length !== 1 || pullRequests.length !== 1) {
      throw new Error(`Existing pull request state for ${branch} is ambiguous`);
    }

    const [pullRequest] = openPullRequests;
    const urlPattern = new RegExp(
      `^https://github\\.com/${escapeRegex(repository)}/pull/\\d+$`,
    );
    if (
      pullRequest.isCrossRepository !== false
      || pullRequest.headRepository?.name?.toLowerCase() !== repositoryBaseName.toLowerCase()
      || pullRequest.headRepositoryOwner?.login?.toLowerCase() !== repositoryOwner.toLowerCase()
    ) {
      throw new Error(`Open pull request for ${branch} must use the same-repository upstream head`);
    }
    if (
      typeof pullRequest.headRefOid !== "string"
      || !gitObjectId.test(pullRequest.headRefOid)
      || pullRequest.headRefOid.toLowerCase() !== branchOid.toLowerCase()
    ) {
      throw new Error(`Open pull request head OID does not match the upstream branch ${branch}`);
    }
    if (
      pullRequest.isDraft !== true
      || pullRequest.mergedAt !== null
      || pullRequest.title !== title
      || pullRequest.headRefName !== branch
      || pullRequest.baseRefName !== "main"
      || typeof pullRequest.url !== "string"
      || !urlPattern.test(pullRequest.url)
      || typeof pullRequest.body !== "string"
      || pullRequest.body !== createPullRequestBody(version)
    ) {
      throw new Error(`Open pull request for ${branch} does not match the required draft PR contract`);
    }

    return { action: "return", branch, title, url: pullRequest.url, headRefOid: pullRequest.headRefOid };
  }

  if (pullRequests.length > 0) {
    throw new Error(`Refusing to reuse ${branch}: unexpected historical pull request state`);
  }
  if (branchExists) {
    throw new Error(`Refusing to reuse orphan branch ${branch}`);
  }

  return { action: "create", branch, title };
}

export function createPullRequestBody(version) {
  assertStableSemver(version);
  return `This draft was created after the MCP release was published and read back.

Publication evidence:
- GitHub release output: mcp-server-v${version}
- npm latest readback: ${npmPackageName}@${version}
- MCP Registry readback: ${registryServerName}@${version}; npm package ${npmPackageName}@${version}

Automated checks: focused updater/freshness/workflow contracts, package build, plugin package, freshness readback, and published MCP smoke.

Manual Cursor Directory follow-up:
- [ ] Merge this draft PR only after review.
- [ ] Update the Cursor Directory entry only after merge.
- [ ] Confirm the Cursor command pins ${npmPackageName}@${version}.
- [ ] Submit the Cursor Directory entry for rescan.`;
}

function assertStableSemver(version) {
  if (typeof version !== "string" || !stableSemver.test(version)) {
    throw new Error("MCP version must use a stable X.Y.Z semver");
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main(argumentsList) {
  if (argumentsList.length === 1 && argumentsList[0] === "--body") {
    process.stdout.write(createPullRequestBody(process.env.MCP_VERSION));
    return;
  }
  if (argumentsList.length !== 0) {
    throw new Error("Usage: post-release-plugin-pin.mjs [--body]");
  }

  let pullRequests;
  try {
    pullRequests = JSON.parse(process.env.PULL_REQUESTS_JSON ?? "");
  } catch (error) {
    throw new Error(
      `Pull request state contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = classifyPullRequestState({
    repository: process.env.GITHUB_REPOSITORY,
    version: process.env.MCP_VERSION,
    branchExists: process.env.BRANCH_EXISTS === "true"
      ? true
      : process.env.BRANCH_EXISTS === "false"
        ? false
        : process.env.BRANCH_EXISTS,
    branchOid: process.env.BRANCH_OID || null,
    pullRequests,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entryPoint === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
