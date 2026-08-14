import { describe, expect, it } from "vitest";
import { ConfigSchema, DEFAULT_IMAGE, resolveProfile } from "../src/validation.js";

describe("config validation", () => {
  it("builds a default local profile", () => {
    const config = ConfigSchema.parse({});
    const profile = resolveProfile(config);
    expect(profile.mode).toBe("local");
    expect(profile.image).toBe(DEFAULT_IMAGE);
    expect(profile.staticContainer).toBe("ydb-local");
    expect(profile.tenantPath).toBe("/local/example");
    expect(profile.dynamicContainer).toBe("ydb-dyn-example");
    expect(profile.dynamicNodeCount).toBe(1);
  });

  it.each([1, 11])("accepts dynamicNodeCount=%i", (dynamicNodeCount) => {
    const config = ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount } }
    });
    expect(resolveProfile(config).dynamicNodeCount).toBe(dynamicNodeCount);
  });

  it.each([0, 12, 1.5])("rejects dynamicNodeCount=%s", (dynamicNodeCount) => {
    expect(() => ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount } }
    })).toThrow();
  });

  it("requires ssh settings for ssh profiles", () => {
    expect(() => ConfigSchema.parse({
      profiles: {
        remote: {
          mode: "ssh"
        }
      }
    })).toThrow(/ssh settings/);
  });

  it("derives monitoring URL from a custom monitoring port", () => {
    const config = ConfigSchema.parse({
      profiles: {
        default: {
          ports: {
            monitoring: 9876
          }
        }
      }
    });
    expect(resolveProfile(config).monitoringBaseUrl).toBe("http://127.0.0.1:9876");
  });
});
