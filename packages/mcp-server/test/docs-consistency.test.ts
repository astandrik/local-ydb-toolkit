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

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

describe("MCP Registry metadata", () => {
  const packageJson = readJson<PackageJson>(new URL("../package.json", import.meta.url));
  const packageLock = readJson<PackageLock>(new URL("../../../package-lock.json", import.meta.url));
  const serverJson = readJson<ServerJson>(new URL("../../../server.json", import.meta.url));

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
  });
});
