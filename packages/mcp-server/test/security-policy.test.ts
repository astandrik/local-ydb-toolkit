import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("security policy", () => {
  const rootReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const securityPolicy = readFileSync(new URL("../../../SECURITY.md", import.meta.url), "utf8");
  const packageSecurityPolicy = readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  const packageManifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );

  it("documents the supported security boundary and private reporting path", () => {
    expect(rootReadme).toContain("[Security policy](SECURITY.md)");
    expect(securityPolicy).toContain("security/advisories/new");
    expect(securityPolicy).toContain("latest npm release");
    expect(securityPolicy).toContain("current `main` branch");
    expect(securityPolicy).toContain("Docker daemon");
    expect(securityPolicy).toContain("SSH");
    expect(securityPolicy).toContain("YDB CLI");
    expect(securityPolicy).toContain("process-bound, one-time HMAC token");
    expect(securityPolicy).toContain("must not log or persist tokens");
    expect(securityPolicy).toContain("application-level gate");
    expect(securityPolicy).toContain("not an operating-system sandbox");
    expect(securityPolicy).toContain("local, development, and test environments");
  });

  it("publishes the repository security policy with the MCP package", () => {
    expect(packageSecurityPolicy).toBe(securityPolicy);
    expect(packageManifest.files.filter((path: string) => path === "SECURITY.md")).toHaveLength(1);
  });
});
