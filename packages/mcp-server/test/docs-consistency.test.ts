import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageJson {
  name: string;
  version: string;
  mcpName?: string;
  dependencies: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, {
    version?: string;
    dependencies?: Record<string, string>;
  }>;
}

interface ServerJson {
  name: string;
  version: string;
  packages: Array<{
    registryType: string;
    identifier: string;
    version: string;
    runtimeHint?: string;
    runtimeArguments?: Array<{ name?: string; value?: string }>;
    transport: { type: string };
    environmentVariables?: Array<{
      name: string;
      isRequired?: boolean;
      choices?: string[];
      default?: string;
      placeholder?: string;
    }>;
  }>;
}

interface ReleasePleaseConfig {
  packages: Record<string, {
    "changelog-path": string;
    "extra-files": Array<string | { path: string }>;
    "version-file": string;
  }>;
}

interface MintlifyConfig {
  navigation: {
    groups: Array<{
      group: string;
      pages: string[];
    }>;
  };
}

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

function managedBlock(text: string, name: string): string {
  const startMarker = `<!-- BEGIN ${name} -->`;
  const endMarker = `<!-- END ${name} -->`;
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`Managed block ${name} was not found`);
  }
  return text.slice(start, end + endMarker.length);
}

function sectionRange(text: string, startHeading: string, endHeading: string): string {
  const start = text.indexOf(startHeading);
  const end = text.indexOf(endHeading, start + startHeading.length);
  if (start < 0 || end < 0) {
    throw new Error(`Section range ${startHeading}..${endHeading} was not found`);
  }
  return text.slice(start, end).trim();
}

describe("MCP Registry metadata", () => {
  const packageJson = readJson<PackageJson>(new URL("../package.json", import.meta.url));
  const corePackageJson = readJson<PackageJson>(
    new URL("../../core/package.json", import.meta.url),
  );
  const packageLock = readJson<PackageLock>(new URL("../../../package-lock.json", import.meta.url));
  const serverJson = readJson<ServerJson>(new URL("../../../server.json", import.meta.url));
  const releasePleaseConfig = readJson<ReleasePleaseConfig>(new URL("../../../.github/release-please-config.json", import.meta.url));
  const releasePleaseManifest = readJson<Record<string, string>>(new URL("../../../.github/.release-please-manifest.json", import.meta.url));

  it("keeps server identity aligned with the npm package", () => {
    const npmPackage = serverJson.packages[0];

    expect(serverJson.name).toBe(packageJson.mcpName);
    expect(serverJson.version).toBe(packageJson.version);
    expect(npmPackage.identifier).toBe(packageJson.name);
    expect(npmPackage.version).toBe(packageJson.version);
    expect(packageLock.packages["packages/mcp-server"]?.version).toBe(packageJson.version);
  });

  it("declares every runtime dependency required by the vendored core", () => {
    expect(packageJson.dependencies).toMatchObject(corePackageJson.dependencies);
    expect(
      packageLock.packages["packages/mcp-server"]?.dependencies,
    ).toMatchObject(corePackageJson.dependencies);
  });

  it("describes the local stdio npm install shape", () => {
    const npmPackage = serverJson.packages[0];
    const runtimeArguments = JSON.stringify(npmPackage.runtimeArguments ?? []);

    expect(npmPackage.registryType).toBe("npm");
    expect(npmPackage.runtimeHint).toBe("npx");
    expect(npmPackage.transport.type).toBe("stdio");
    expect(runtimeArguments).not.toContain(packageJson.name);
    expect(npmPackage.environmentVariables).toContainEqual(expect.objectContaining({
      name: "LOCAL_YDB_TOOLKIT_CONFIG",
      isRequired: false
    }));
    const contentFormat = npmPackage.environmentVariables?.find(
      ({ name }) => name === "LOCAL_YDB_MCP_CONTENT_FORMAT",
    );
    expect(contentFormat).toEqual(expect.objectContaining({
      isRequired: false,
      choices: ["json", "toon"],
      default: "json",
      placeholder: "toon",
    }));
  });

  it("uses package-relative release files and repo-root metadata files", () => {
    const packageConfig = releasePleaseConfig.packages["packages"];

    expect(releasePleaseManifest["packages"]).toBe(packageJson.version);
    expect(packageConfig).toBeDefined();
    expect(packageConfig["changelog-path"]).toBe("mcp-server/CHANGELOG.md");
    expect(packageConfig["version-file"]).toBe("mcp-server/.release-please-version");

    const configuredPaths = [
      packageConfig["changelog-path"],
      packageConfig["version-file"],
      ...packageConfig["extra-files"].map((extraFile) => (
        typeof extraFile === "string" ? extraFile : extraFile.path
      ))
    ];

    expect(configuredPaths).toContain("/package-lock.json");
    expect(configuredPaths).toContain("/server.json");
    expect(configuredPaths.every((configuredPath) => !configuredPath.includes(".."))).toBe(true);
  });
});

describe("repository skill consistency", () => {
  it("keeps the declarative topology contract identical in both scenario copies", () => {
    const rootScenarios = readFileSync(new URL("../../../MCP_TOOL_TEST_SCENARIOS.md", import.meta.url), "utf8");
    const skillScenarios = readFileSync(new URL("../../../skills/local-ydb/references/mcp-tool-scenarios.md", import.meta.url), "utf8");

    const rootContract = managedBlock(rootScenarios, "DECLARATIVE TOPOLOGY CONTRACT");
    expect(rootContract).toBe(managedBlock(skillScenarios, "DECLARATIVE TOPOLOGY CONTRACT"));
    expect(rootContract).toContain("Static IC port `19001` is reserved");
    expect(rootContract).toContain("every configured dynamic gRPC port on loopback");
    expect(rootContract).toContain("matching nodelist port alone is insufficient");
    expect(rootContract).toContain("Before any restart mutation");
    expect(rootContract).toContain("requires destroy/bootstrap");
    expect(rootContract).toContain("including containers observed restarting");
    expect(rootContract).toContain("standalone primary start validate names and the complete shared-network port set");
    expect(rootContract).toContain("inventory does not retain removed configured container definitions");
    expect(rootContract).toContain("restores configured nodes through restart or bootstrap");
    expect(rootContract).toContain("before any config or container mutation");
    expect(rootContract).toContain("without a dynamic-node token file");
    expect(rootContract).toContain("preserve exact one-off gRPC, monitoring, and IC ports before dump or destroy");
  });

  it("keeps the declarative topology acceptance flow identical", () => {
    const rootScenarios = readFileSync(new URL("../../../MCP_TOOL_TEST_SCENARIOS.md", import.meta.url), "utf8");
    const skillScenarios = readFileSync(new URL("../../../skills/local-ydb/references/mcp-tool-scenarios.md", import.meta.url), "utf8");
    const rootFlow = sectionRange(rootScenarios, "## Declarative Topology Acceptance Flow", "<!-- BEGIN MANAGED SQL SCENARIOS -->");
    const skillFlow = sectionRange(skillScenarios, "## Declarative Topology Acceptance Flow", "<!-- BEGIN MANAGED SQL SCENARIOS -->");

    expect(rootFlow).toBe(skillFlow);
    expect(rootFlow).toContain("Bootstrap with `dynamicNodeCount: 1`");
    expect(rootFlow).toContain("Change the same profile to `dynamicNodeCount: 3`");
    expect(rootFlow).toContain("full static compatibility check before every mutation");
    expect(rootFlow).toContain("without changing saved IDs/states or creating `-2`/`-3`");
    expect(rootFlow).toContain("tenant bootstrap must reject the same shared compatibility contract");
    expect(rootFlow).toContain("non-default gRPC, monitoring, and IC ports");
    expect(rootFlow).toContain("failure before dump or destroy");
  });

  it("keeps dynamic-node scenarios 11 and 12 identical and topology-aware", () => {
    const rootScenarios = readFileSync(new URL("../../../MCP_TOOL_TEST_SCENARIOS.md", import.meta.url), "utf8");
    const skillScenarios = readFileSync(new URL("../../../skills/local-ydb/references/mcp-tool-scenarios.md", import.meta.url), "utf8");
    const rootSection = sectionRange(rootScenarios, "## Scenario 11: Add Extra Dynamic Nodes", "## Scenario 13: Add Storage Groups");
    const skillSection = sectionRange(skillScenarios, "## Scenario 11: Add Extra Dynamic Nodes", "## Scenario 13: Add Storage Groups");

    expect(rootSection).toBe(skillSection);
    expect(rootSection).toContain("ydb-dyn-example-ghcr261-4");
    expect(rootSection).toContain("ydb-dyn-example-ghcr261-5");
    expect(rootSection).toContain("2260/9069/19305");
    expect(rootSection).toContain("2261/9070/19306");
    expect(rootSection).toContain("five dynamic nodes total");
    expect(rootSection).toContain("docker rm -f ydb-dyn-example-ghcr261-4 ydb-dyn-example-ghcr261-5");
    expect(rootSection).toContain("explicit `startIndex: 2` is rejected before a mutating plan");
    expect(rootSection).toContain("exact container is stably running");
    expect(rootSection).toContain("default plan-only output targets the highest one-off suffix, `ydb-dyn-example-ghcr261-5`");
    expect(rootSection).toContain("Configured suffix `-2` is removable only through an explicit");
    expect(rootSection).toContain("rollback for the removed one-off node uses `local_ydb_add_dynamic_nodes`");
    expect(rootSection).toContain("rollback uses `local_ydb_restart_stack` or `local_ydb_bootstrap`");
    expect(rootSection).not.toContain("docker rm -f ydb-dyn-example-ghcr261-2 ydb-dyn-example-ghcr261-3");
  });
});

describe("Mintlify declarative topology documentation", () => {
  const configuration = readFileSync(
    new URL("../../../docs/get-started/configure.mdx", import.meta.url),
    "utf8",
  );
  const index = readFileSync(
    new URL("../../../docs/index.mdx", import.meta.url),
    "utf8",
  );
  const workflow = readFileSync(
    new URL("../../../docs/workflows/dynamic-node-topology.mdx", import.meta.url),
    "utf8",
  );
  const tools = readFileSync(
    new URL("../../../docs/reference/tools.mdx", import.meta.url),
    "utf8",
  );
  const mintlifyConfig = readJson<MintlifyConfig>(
    new URL("../../../docs/docs.json", import.meta.url),
  );

  it("publishes the declarative topology workflow in navigation", () => {
    const workflows = mintlifyConfig.navigation.groups.find(
      ({ group }) => group === "Workflows",
    );

    expect(workflows?.pages).toContain("workflows/dynamic-node-topology");
    expect(index).toContain('href="/workflows/dynamic-node-topology"');
    expect(configuration).toContain('"dynamicNodeCount": 3');
    expect(configuration).toContain("total configured tenant-node count");
    expect(configuration).toContain("defaults to `1`");
    expect(configuration).toContain("Static IC port `19001` is");
  });

  it("keeps configured, one-off, and readiness contracts explicit", () => {
    expect(workflow).toContain("`dynamicNodeCount + 1`");
    expect(workflow).toContain("greater than `dynamicNodeCount`");
    expect(workflow).toContain("`Running=true` and `Restarting=false`");
    expect(workflow).toContain("same container ID and `RestartCount`");
    expect(workflow).toContain("matching nodelist port alone is insufficient");
    expect(workflow).toContain("every configured dynamic gRPC port");
    expect(workflow).toMatch(/before any\s+stop, remove, or start command/);
    expect(workflow).toContain("requires destroy followed by bootstrap");
    expect(workflow).toContain("including containers observed");
    expect(workflow).toContain("restarting.");
    expect(workflow).toContain("`local_ydb_restart_stack` or `local_ydb_bootstrap`");
    expect(workflow).toContain("`local_ydb_add_dynamic_nodes`");
    expect(workflow).toContain("distinct from the static container name");
    expect(workflow).toContain("Before copying config or changing");
    expect(workflow).toContain("exact gRPC, monitoring, and IC ports");
    expect(workflow).toContain("inventory does not");
    expect(workflow).toContain("retain removed configured definitions");
    expect(workflow).toContain("never removes unexpected one-off containers");
    expect(workflow).toContain("still attempts every preflight-running one-off container");
    expect(workflow).toContain("restore only one-off suffixes above");
    expect(tools).toContain("bootstrap/restart configured nodes; add/remove one-off nodes");
  });
});

describe("MCP prompt documentation", () => {
  const repositoryReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const packageReadme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const promptSafetySummary = "Tenant dumps are mandatory for data-preserving version upgrades and storage-group reduction";
  const authSafetySummary = "live or production-like auth hardening requires a reviewed tenant dump or copied-volume rehearsal";
  const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ");

  it.each([
    ["repository README", repositoryReadme],
    ["package README", packageReadme],
  ])("documents destructive prompt preconditions in the %s", (_name, readme) => {
    const normalizedReadme = normalizeWhitespace(readme);

    expect(normalizedReadme).toContain(promptSafetySummary);
    expect(normalizedReadme).toContain(authSafetySummary);
    expect(normalizedReadme).not.toContain("storage group reduction");
  });
});
