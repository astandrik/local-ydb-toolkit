import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/operations/context.js";
import {
  ConfigLoadError,
  ConfigSchema,
  DEFAULT_IMAGE,
  MAX_CONFIG_FILE_BYTES,
  loadConfig,
  resolveConfigPath,
  resolveProfile,
} from "../src/validation.js";

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

  it.each([
    { unexpected: true },
    { profiles: { default: { unexpected: true } } },
    { profiles: { default: { ports: { unexpected: 123 } } } },
    {
      profiles: {
        remote: {
          mode: "ssh",
          ssh: { host: "example.test", unexpected: true },
        },
      },
    },
  ])("rejects unknown config properties", (config) => {
    expect(() => ConfigSchema.parse(config)).toThrow();
  });

  it("uses defaults only when the implicit cwd config is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-config-default-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.LOCAL_YDB_TOOLKIT_CONFIG;
    delete process.env.LOCAL_YDB_TOOLKIT_CONFIG;
    process.chdir(dir);
    try {
      expect(resolveProfile(loadConfig()).image).toBe(DEFAULT_IMAGE);
    } finally {
      process.chdir(previousCwd);
      if (previousEnv === undefined) {
        delete process.env.LOCAL_YDB_TOOLKIT_CONFIG;
      } else {
        process.env.LOCAL_YDB_TOOLKIT_CONFIG = previousEnv;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires explicit config paths to be absolute and present", () => {
    expectConfigError(() => loadConfig(""), "CONFIG_PATH_NOT_ABSOLUTE");
    expectConfigError(() => loadConfig("relative.json"), "CONFIG_PATH_NOT_ABSOLUTE");
    expectConfigError(() => resolveConfigPath(""), "CONFIG_PATH_NOT_ABSOLUTE");
    expectConfigError(() => resolveConfigPath("relative.json"), "CONFIG_PATH_NOT_ABSOLUTE");
    expectConfigError(
      () => createContext(undefined, undefined, ConfigSchema.parse({}), ""),
      "CONFIG_PATH_NOT_ABSOLUTE",
    );
    expectConfigError(
      () => loadConfig(join(tmpdir(), "local-ydb-config-missing", "config.json")),
      "CONFIG_NOT_FOUND",
    );
  });

  it("treats LOCAL_YDB_TOOLKIT_CONFIG as an explicit path", () => {
    const previousEnv = process.env.LOCAL_YDB_TOOLKIT_CONFIG;
    try {
      process.env.LOCAL_YDB_TOOLKIT_CONFIG = "";
      expectConfigError(() => loadConfig(), "CONFIG_PATH_NOT_ABSOLUTE");
      process.env.LOCAL_YDB_TOOLKIT_CONFIG = "relative.json";
      expectConfigError(() => loadConfig(), "CONFIG_PATH_NOT_ABSOLUTE");
      process.env.LOCAL_YDB_TOOLKIT_CONFIG = join(
        tmpdir(),
        "local-ydb-config-env-missing",
        "config.json",
      );
      expectConfigError(() => loadConfig(), "CONFIG_NOT_FOUND");
    } finally {
      if (previousEnv === undefined) {
        delete process.env.LOCAL_YDB_TOOLKIT_CONFIG;
      } else {
        process.env.LOCAL_YDB_TOOLKIT_CONFIG = previousEnv;
      }
    }
  });

  it("fails closed when the implicit cwd config exists but is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-config-implicit-invalid-"));
    const previousCwd = process.cwd();
    const previousEnv = process.env.LOCAL_YDB_TOOLKIT_CONFIG;
    delete process.env.LOCAL_YDB_TOOLKIT_CONFIG;
    writeFileSync(join(dir, "local-ydb.config.json"), "not-json", "utf8");
    process.chdir(dir);
    try {
      expectConfigError(() => loadConfig(), "CONFIG_INVALID_JSON");
    } finally {
      process.chdir(previousCwd);
      if (previousEnv === undefined) {
        delete process.env.LOCAL_YDB_TOOLKIT_CONFIG;
      } else {
        process.env.LOCAL_YDB_TOOLKIT_CONFIG = previousEnv;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects directories and oversized config files", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-config-limits-"));
    const oversizedPath = join(dir, "oversized.json");
    writeFileSync(oversizedPath, " ".repeat(MAX_CONFIG_FILE_BYTES + 1), "utf8");
    try {
      expectConfigError(() => loadConfig(dir), "CONFIG_NOT_FILE");
      expectConfigError(() => loadConfig(oversizedPath), "CONFIG_TOO_LARGE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not expose invalid JSON contents or paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-config-json-"));
    const configPath = join(dir, "config.json");
    const marker = "BENIGN_CONFIG_MARKER";
    writeFileSync(configPath, `${marker}\n`, "utf8");
    try {
      expectConfigError(() => loadConfig(configPath), "CONFIG_INVALID_JSON", marker, configPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports invalid config schemas without echoing input values", () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-config-schema-"));
    const configPath = join(dir, "config.json");
    const marker = "BENIGN_UNKNOWN_PROFILE_FIELD";
    writeFileSync(configPath, JSON.stringify({ profiles: { default: { [marker]: true } } }), "utf8");
    try {
      expectConfigError(() => loadConfig(configPath), "CONFIG_INVALID_SCHEMA", marker, configPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function expectConfigError(
  action: () => unknown,
  code: ConfigLoadError["code"],
  ...privateFragments: string[]
): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ConfigLoadError);
  expect(error).toMatchObject({ code });
  const message = error instanceof Error ? error.message : String(error);
  for (const fragment of privateFragments) {
    expect(message).not.toContain(fragment);
  }
}
