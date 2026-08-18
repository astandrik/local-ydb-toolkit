import { pathToFileURL } from "node:url";

const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const registryServerName = "io.github.astandrik/local-ydb-mcp";
const npmPackageName = "@astandrik/local-ydb-mcp";

export function classifyPullRequestState({
  repository,
  version,
  branchExists,
  pullRequests,
}) {
  if (typeof version !== "string" || !stableSemver.test(version)) {
    throw new Error("MCP version must use a stable X.Y.Z semver");
  }
  if (typeof repository !== "string" || !repositoryName.test(repository)) {
    throw new Error("Repository must use the owner/name form");
  }
  if (typeof branchExists !== "boolean") {
    throw new Error("Branch existence must be a boolean");
  }
  if (!Array.isArray(pullRequests)) {
    throw new Error("Pull request state must be a JSON array");
  }

  const branch = `codex/update-plugin-mcp-pin-v${version}`;
  const title = `chore(plugin): pin published MCP ${version}`;
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
    const expectedRegistryEvidence = `${registryServerName}@${version}`;
    const expectedNpmEvidence = `${npmPackageName}@${version}`;
    const urlPattern = new RegExp(
      `^https://github\\.com/${escapeRegex(repository)}/pull/\\d+$`,
    );
    if (
      pullRequest.isDraft !== true
      || pullRequest.mergedAt !== null
      || pullRequest.title !== title
      || pullRequest.headRefName !== branch
      || pullRequest.baseRefName !== "main"
      || typeof pullRequest.url !== "string"
      || !urlPattern.test(pullRequest.url)
      || typeof pullRequest.body !== "string"
      || !pullRequest.body.includes(expectedRegistryEvidence)
      || !pullRequest.body.includes(expectedNpmEvidence)
      || !pullRequest.body.includes("Manual Cursor Directory follow-up")
    ) {
      throw new Error(`Open pull request for ${branch} does not match the required draft PR contract`);
    }

    return { action: "return", branch, title, url: pullRequest.url };
  }

  if (pullRequests.length > 0) {
    throw new Error(`Refusing to reuse ${branch}: unexpected historical pull request state`);
  }
  if (branchExists) {
    throw new Error(`Refusing to reuse orphan branch ${branch}`);
  }

  return { action: "create", branch, title };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main() {
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
    pullRequests,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entryPoint === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
