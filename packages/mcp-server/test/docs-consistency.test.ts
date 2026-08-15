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

    expect(managedBlock(rootScenarios, "DECLARATIVE TOPOLOGY CONTRACT"))
      .toBe(managedBlock(skillScenarios, "DECLARATIVE TOPOLOGY CONTRACT"));
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
    expect(rootSection).toContain("default plan-only output targets the highest one-off suffix, `ydb-dyn-example-ghcr261-5`");
    expect(rootSection).toContain("Configured suffix `-2` is removable only through an explicit");
    expect(rootSection).not.toContain("docker rm -f ydb-dyn-example-ghcr261-2 ydb-dyn-example-ghcr261-3");
  });
});
