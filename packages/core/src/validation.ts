import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const DEFAULT_IMAGE = "ghcr.io/ydb-platform/local-ydb:stable-26-1-1";
export const MAX_CONFIG_FILE_BYTES = 1_048_576;
const CONFIG_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

export type ConfigLoadErrorCode =
  | "CONFIG_PATH_NOT_ABSOLUTE"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_NOT_FILE"
  | "CONFIG_TOO_LARGE"
  | "CONFIG_READ_FAILED"
  | "CONFIG_INVALID_JSON"
  | "CONFIG_INVALID_SCHEMA";

export type ConfigSource =
  | { kind: "built-in" }
  | {
      kind: "argument" | "environment" | "implicit";
      path: string;
      contentSha256: string;
    };

export interface LoadedConfigDocument {
  config: LocalYdbConfig;
  source: ConfigSource;
}

const CONFIG_LOAD_ERROR_MESSAGES: Record<ConfigLoadErrorCode, string> = {
  CONFIG_PATH_NOT_ABSOLUTE: "Explicit local-ydb config paths must be absolute.",
  CONFIG_NOT_FOUND: "Explicit local-ydb config file was not found.",
  CONFIG_NOT_FILE: "Local-ydb config path must reference a regular file.",
  CONFIG_TOO_LARGE: `Local-ydb config file exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit.`,
  CONFIG_READ_FAILED: "Local-ydb config file could not be read.",
  CONFIG_INVALID_JSON: "Local-ydb config file is not valid JSON.",
  CONFIG_INVALID_SCHEMA: "Local-ydb config file does not match the supported schema.",
};

export class ConfigLoadError extends Error {
  readonly code: ConfigLoadErrorCode;

  constructor(code: ConfigLoadErrorCode) {
    super(CONFIG_LOAD_ERROR_MESSAGES[code]);
    this.name = "ConfigLoadError";
    this.code = code;
  }
}

export const PortsSchema = z.object({
  staticGrpc: z.number().int().positive().default(2136),
  monitoring: z.number().int().positive().default(8765),
  dynamicGrpc: z.number().int().positive().default(2137),
  dynamicMonitoring: z.number().int().positive().default(8766),
  dynamicIc: z.number().int().positive().default(19002)
}).strict().default({});

export const SshProfileSchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  identityFile: z.string().min(1).optional()
}).strict();

export const ProfileSchema = z.object({
  mode: z.enum(["local", "ssh"]).default("local"),
  ssh: SshProfileSchema.optional(),
  image: z.string().min(1).default(DEFAULT_IMAGE),
  staticContainer: z.string().min(1).default("ydb-local"),
  dynamicContainer: z.string().min(1).optional(),
  dynamicNodeCount: z.number().int().min(1).max(11).default(1),
  authConfigPath: z.string().min(1).optional(),
  dynamicNodeAuthTokenFile: z.string().min(1).optional(),
  dynamicNodeAuthSid: z.string().min(1).optional(),
  network: z.string().min(1).default("ydb-net"),
  volume: z.string().min(1).default("ydb-local-data"),
  bindMountPath: z.string().min(1).optional(),
  tenantPath: z.string().regex(/^\/local\/[^/]+(?:\/[^/]+)*$/).default("/local/example"),
  rootDatabase: z.string().min(1).default("/local"),
  storagePoolKind: z.string().min(1).default("hdd"),
  storagePoolCount: z.number().int().positive().default(1),
  ports: PortsSchema,
  monitoringBaseUrl: z.string().url().default("http://127.0.0.1:8765"),
  rootUser: z.string().min(1).default("root"),
  rootPasswordFile: z.string().min(1).optional(),
  dumpHostPath: z.string().min(1).default("/tmp/local-ydb-dump"),
  storageSearchPaths: z.array(z.string().min(1)).default(["/var/lib/docker/volumes", "/tmp"])
}).strict().superRefine((profile, ctx) => {
  if (profile.mode === "ssh" && !profile.ssh) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ssh"],
      message: "ssh settings are required when mode is ssh"
    });
  }
});

export const ConfigSchema = z.object({
  defaultProfile: z.string().min(1).default("default"),
  profiles: z.record(ProfileSchema).default({
    default: {
      mode: "local"
    }
  })
}).strict().superRefine((config, ctx) => {
  if (!Object.hasOwn(config.profiles, config.defaultProfile)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultProfile"],
      message: "defaultProfile must reference a configured profile"
    });
  }
});

export type LocalYdbConfig = z.infer<typeof ConfigSchema>;
export type LocalYdbProfile = z.infer<typeof ProfileSchema>;
export type LocalYdbPorts = z.infer<typeof PortsSchema>;
export type SshProfile = z.infer<typeof SshProfileSchema>;

export interface ResolvedLocalYdbProfile extends LocalYdbProfile {
  name: string;
  dynamicContainer: string;
}

export function sanitizeTenantName(tenantPath: string): string {
  return tenantPath.replace(/^\/local\/?/, "").replace(/[^a-zA-Z0-9_.-]+/g, "-") || "example";
}

export function normalizeProfile(name: string, profile: LocalYdbProfile): ResolvedLocalYdbProfile {
  const monitoringBaseUrl = profile.monitoringBaseUrl === "http://127.0.0.1:8765" && profile.ports.monitoring !== 8765
    ? `http://127.0.0.1:${profile.ports.monitoring}`
    : profile.monitoringBaseUrl;
  return {
    ...profile,
    monitoringBaseUrl,
    name,
    dynamicContainer: profile.dynamicContainer ?? `ydb-dyn-${sanitizeTenantName(profile.tenantPath)}`
  };
}

export function resolveConfigPath(configPath = process.env.LOCAL_YDB_TOOLKIT_CONFIG): string {
  if (configPath !== undefined) {
    if (!isAbsolute(configPath)) {
      throw new ConfigLoadError("CONFIG_PATH_NOT_ABSOLUTE");
    }
    return resolve(configPath);
  }
  return resolve(process.cwd(), "local-ydb.config.json");
}

export function loadConfig(configPath?: string): LocalYdbConfig {
  return loadConfigDocument(configPath).config;
}

export function loadConfigDocument(configPath?: string): LoadedConfigDocument {
  const argumentSource = configPath !== undefined;
  const environmentPath = process.env.LOCAL_YDB_TOOLKIT_CONFIG;
  const configuredPath = configPath !== undefined
    ? configPath
    : environmentPath;
  const explicit = configuredPath !== undefined;
  if (explicit && !isAbsolute(configuredPath)) {
    throw new ConfigLoadError("CONFIG_PATH_NOT_ABSOLUTE");
  }
  const path = configuredPath ?? resolve(process.cwd(), "local-ydb.config.json");

  let descriptor: number;
  try {
    descriptor = openSync(path, CONFIG_OPEN_FLAGS);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      if (explicit) {
        throw new ConfigLoadError("CONFIG_NOT_FOUND");
      }
      return {
        config: ConfigSchema.parse({}),
        source: { kind: "built-in" },
      };
    }
    const darwinSocketError = process.platform === "darwin"
      && error instanceof Error
      && "errno" in error
      && error.errno === -osConstants.errno.EOPNOTSUPP;
    // Linux reports sockets as ENXIO; Darwin uses EOPNOTSUPP, which Node exposes via errno.
    if (
      isFileSystemError(error, "EISDIR")
      || isFileSystemError(error, "ENXIO")
      || darwinSocketError
    ) {
      throw new ConfigLoadError("CONFIG_NOT_FILE");
    }
    throw new ConfigLoadError("CONFIG_READ_FAILED");
  }

  try {
    let stats: ReturnType<typeof fstatSync>;
    try {
      stats = fstatSync(descriptor);
    } catch {
      throw new ConfigLoadError("CONFIG_READ_FAILED");
    }
    if (!stats.isFile()) {
      throw new ConfigLoadError("CONFIG_NOT_FILE");
    }
    if (stats.size > MAX_CONFIG_FILE_BYTES) {
      throw new ConfigLoadError("CONFIG_TOO_LARGE");
    }

    let buffer = Buffer.alloc(Math.min(
      MAX_CONFIG_FILE_BYTES + 1,
      Math.max(4_096, stats.size + 1),
    ));
    let bytesRead = 0;
    try {
      while (true) {
        if (bytesRead === buffer.length) {
          if (buffer.length === MAX_CONFIG_FILE_BYTES + 1) {
            break;
          }
          const expanded = Buffer.alloc(Math.min(
            MAX_CONFIG_FILE_BYTES + 1,
            buffer.length * 2,
          ));
          buffer.copy(expanded);
          buffer = expanded;
        }
        const count = readSync(
          descriptor,
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          null,
        );
        if (count === 0) {
          break;
        }
        bytesRead += count;
      }
    } catch {
      throw new ConfigLoadError("CONFIG_READ_FAILED");
    }
    if (bytesRead > MAX_CONFIG_FILE_BYTES) {
      throw new ConfigLoadError("CONFIG_TOO_LARGE");
    }

    const text = buffer.toString("utf8", 0, bytesRead);
    return {
      config: parseConfigText(text),
      source: {
        kind: argumentSource
          ? "argument"
          : environmentPath !== undefined
            ? "environment"
            : "implicit",
        path,
        contentSha256: createHash("sha256").update(text).digest("hex"),
      },
    };
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // The read result or safe ConfigLoadError remains authoritative.
    }
  }
}

function parseConfigText(text: string): LocalYdbConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigLoadError("CONFIG_INVALID_JSON");
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigLoadError("CONFIG_INVALID_SCHEMA");
  }
  return result.data;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function resolveProfile(config: LocalYdbConfig, profileName?: string): ResolvedLocalYdbProfile {
  const name = profileName ?? config.defaultProfile;
  const profile = Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
  if (!profile) {
    throw new Error(`Unknown local-ydb profile: ${name}`);
  }
  return normalizeProfile(name, profile);
}
