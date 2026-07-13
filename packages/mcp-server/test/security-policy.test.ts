import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("security policy", () => {
  const rootReadme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const securityPolicy = readFileSync(new URL("../../../SECURITY.md", import.meta.url), "utf8");

  it("documents the supported security boundary and private reporting path", () => {
    expect(rootReadme).toContain("[Security policy](SECURITY.md)");
    expect(securityPolicy).toContain("security/advisories/new");
    expect(securityPolicy).toContain("latest npm release");
    expect(securityPolicy).toContain("current `main` branch");
    expect(securityPolicy).toContain("Docker daemon");
    expect(securityPolicy).toContain("SSH");
    expect(securityPolicy).toContain("YDB CLI");
    expect(securityPolicy).toContain("application-level approval gate");
    expect(securityPolicy).toContain("not an operating-system sandbox");
    expect(securityPolicy).toContain("local, development, and test environments");
  });
});
