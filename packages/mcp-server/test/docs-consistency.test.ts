import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageJson {
  name: string;
  version: string;
  mcpName?: string;
}

interface PackageLock {
  packages: Record<string, { version?: string }>;
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
    environmentVariables?: Array<{ name: string; isRequired?: boolean }>;
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

describe("MCP Registry metadata", () => {
  const packageJson = readJson<PackageJson>(new URL("../package.json", import.meta.url));
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
    expect(npmPackage.environmentVariables).toContainEqual(expect.objectContaining({
      name: "LOCAL_YDB_MCP_CONTENT_FORMAT",
      isRequired: false
    }));
  });

  it("keeps release-please paths rooted inside the configured package", () => {
    const packageConfig = releasePleaseConfig.packages["."];

    expect(releasePleaseManifest["."]).toBe(packageJson.version);
    expect(packageConfig).toBeDefined();
    expect(packageConfig["changelog-path"]).toBe("packages/mcp-server/CHANGELOG.md");
    expect(packageConfig["version-file"]).toBe("packages/mcp-server/.release-please-version");

    const configuredPaths = [
      packageConfig["changelog-path"],
      packageConfig["version-file"],
      ...packageConfig["extra-files"].map((extraFile) => (
        typeof extraFile === "string" ? extraFile : extraFile.path
      ))
    ];

    expect(configuredPaths).toContain("package-lock.json");
    expect(configuredPaths).toContain("server.json");
    expect(configuredPaths.every((configuredPath) => !configuredPath.includes(".."))).toBe(true);
  });
});
