import { pathToFileURL } from "node:url";

const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const registryServerName = "io.github.astandrik/local-ydb-mcp";
const npmPackageName = "@astandrik/local-ydb-mcp";

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

function main(argumentsList) {
  if (argumentsList.length !== 1 || argumentsList[0] !== "--body") {
    throw new Error("Usage: post-release-plugin-pin.mjs --body");
  }
  process.stdout.write(createPullRequestBody(process.env.MCP_VERSION));
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
