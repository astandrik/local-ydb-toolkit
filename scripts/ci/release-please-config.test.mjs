import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const releaseRoot = "packages";
const releaseConfig = JSON.parse(readFileSync(".github/release-please-config.json", "utf8"));
const releaseManifest = JSON.parse(readFileSync(".github/.release-please-manifest.json", "utf8"));
const packageJson = JSON.parse(readFileSync("packages/mcp-server/package.json", "utf8"));
const publishWorkflow = readFileSync(".github/workflows/publish-mcp-server.yml", "utf8");

test("MCP releases only consider the core and server package tree", () => {
  assert.deepEqual(Object.keys(releaseConfig.packages), [releaseRoot]);
  assert.deepEqual(Object.keys(releaseManifest), [releaseRoot]);
  assert.equal(releaseManifest[releaseRoot], packageJson.version);
  assert.deepEqual(
    readdirSync(releaseRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    ["core", "mcp-server"],
  );

  const triggersMcpRelease = (files) => files.some(
    (file) => file === releaseRoot || file.startsWith(`${releaseRoot}/`),
  );

  assert.equal(triggersMcpRelease([
    "plugin.json",
    "skills/local-ydb/SKILL.md",
    "package.json",
    "package-lock.json",
  ]), false);
  assert.equal(triggersMcpRelease(["packages/core/src/operations/version.ts"]), true);
  assert.equal(triggersMcpRelease(["packages/mcp-server/src/server.ts"]), true);
  assert.equal(triggersMcpRelease([
    "plugin.json",
    "packages/core/src/operations/version.ts",
  ]), true);
});

test("release-please updates MCP metadata and forwards path-prefixed outputs", () => {
  const packageConfig = releaseConfig.packages[releaseRoot];

  assert.equal(packageConfig["release-type"], "simple");
  assert.equal(packageConfig["package-name"], packageJson.name);
  assert.equal(packageConfig.component, "mcp-server");
  assert.equal(packageConfig["changelog-path"], "mcp-server/CHANGELOG.md");
  assert.equal(packageConfig["version-file"], "mcp-server/.release-please-version");

  const configuredPaths = packageConfig["extra-files"].map(({ path }) => path);
  assert.ok(configuredPaths.includes("/packages/mcp-server/package.json"));
  assert.ok(configuredPaths.includes("/package-lock.json"));
  assert.ok(configuredPaths.includes("/server.json"));
  assert.ok(configuredPaths.every((path) => path.startsWith("/") && !path.includes("..")));

  for (const output of ["release_created", "tag_name", "version"]) {
    assert.match(
      publishWorkflow,
      new RegExp(`${output}: \\$\\{\\{ steps\\.release\\.outputs\\['packages--${output}'\\] \\}\\}`),
    );
  }
});
