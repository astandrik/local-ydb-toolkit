import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("MCP publication workflow", () => {
  const publishWorkflow = readFileSync(
    new URL("../../../.github/workflows/publish-mcp-server.yml", import.meta.url),
    "utf8",
  );
  const rootReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

  it("validates and readbacks npm and Registry publication state", () => {
    expect(publishWorkflow).toContain('MCP_PUBLISHER_VERSION: "v1.8.0"');
    expect(publishWorkflow).toContain(
      'MCP_PUBLISHER_LINUX_AMD64_SHA256: "1370446bbe74d562608e8005a6ccce02d146a661fbd78674e11cc70b9618d6cf"',
    );
    expect(publishWorkflow.match(/mcp-publisher validate/g)).toHaveLength(3);
    expect(
      publishWorkflow.match(/verify-mcp-publication\.mjs npm --allow-missing/g),
    ).toHaveLength(2);
    expect(
      publishWorkflow.match(/verify-mcp-publication\.mjs npm --wait-seconds 300/g),
    ).toHaveLength(2);
    expect(
      publishWorkflow.match(/verify-mcp-publication\.mjs registry --allow-missing/g),
    ).toHaveLength(2);
    expect(publishWorkflow.match(/mcp-publisher login github-oidc/g)).toHaveLength(2);
    expect(publishWorkflow.match(/mcp-publisher publish/g)).toHaveLength(2);
    expect(
      publishWorkflow.match(/verify-mcp-publication\.mjs registry --wait-seconds 300/g),
    ).toHaveLength(2);
    expect(publishWorkflow.match(/continue-on-error: true/g)).toHaveLength(4);
  });

  it("validates publishable metadata only after exact npm readback", () => {
    const releaseJob = publishWorkflow.slice(
      publishWorkflow.indexOf("  publish:"),
      publishWorkflow.indexOf("  publish-existing-release:"),
    );
    const recoveryJob = publishWorkflow.slice(
      publishWorkflow.indexOf("  publish-existing-release:"),
      publishWorkflow.indexOf("  dry-run:"),
    );

    for (const job of [releaseJob, recoveryJob]) {
      expect(job.indexOf("Verify npm publication")).toBeGreaterThan(-1);
      expect(job.indexOf("Validate MCP Registry metadata")).toBeGreaterThan(
        job.indexOf("Verify npm publication"),
      );
    }
  });

  it("restricts recovery publication to released tags on main", () => {
    const recoveryJob = publishWorkflow.slice(
      publishWorkflow.indexOf("  publish-existing-release:"),
      publishWorkflow.indexOf("  dry-run:"),
    );

    expect(recoveryJob).toContain("ref: refs/tags/${{ inputs.publish_tag }}");
    expect(recoveryJob).toContain('git show-ref --verify --quiet "refs/tags/${PUBLISH_TAG}"');
    expect(recoveryJob).toContain("git merge-base --is-ancestor HEAD origin/main");
    expect(recoveryJob).toContain(
      '"repos/${GITHUB_REPOSITORY}/releases/tags/${PUBLISH_TAG}"',
    );
    expect(recoveryJob).toContain("select(.draft == false and .prerelease == false)");
    expect(recoveryJob.indexOf("Verify published release tag")).toBeLessThan(
      recoveryJob.indexOf("npm ci"),
    );
  });

  it("documents the idempotent Registry recovery path", () => {
    expect(rootReadme).toContain("skips the npm publish step");
    expect(rootReadme).toContain("publishes only the missing MCP Registry record");
    expect(rootReadme).toContain("release a new patch version");
  });
});
