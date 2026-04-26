import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const DEFAULT_IMAGE = "ghcr.io/ydb-platform/local-ydb:26.1.1.6";

export const PortsSchema = z.object({
  staticGrpc: z.number().int().positive().default(2136),
  monitoring: z.number().int().positive().default(8765),
  dynamicGrpc: z.number().int().positive().default(2137),
  dynamicMonitoring: z.number().int().positive().default(8766),
  dynamicIc: z.number().int().positive().default(19002)
}).default({});

export const SshProfileSchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1).optional(),
  port: z.number().int().positive().optional(),
  identityFile: z.string().min(1).optional()
});

export const ProfileSchema = z.object({
  mode: z.enum(["local", "ssh"]).default("local"),
  ssh: SshProfileSchema.optional(),
  image: z.string().min(1).default(DEFAULT_IMAGE),
  staticContainer: z.string().min(1).default("ydb-local"),
  dynamicContainer: z.string().min(1).optional(),
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
}).superRefine((profile, ctx) => {
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

export function loadConfig(configPath = process.env.LOCAL_YDB_TOOLKIT_CONFIG): LocalYdbConfig {
  const path = configPath ? resolve(configPath) : resolve(process.cwd(), "local-ydb.config.json");
  if (!existsSync(path)) {
    return ConfigSchema.parse({});
  }
  return ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function resolveProfile(config: LocalYdbConfig, profileName?: string): ResolvedLocalYdbProfile {
  const name = profileName ?? config.defaultProfile;
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`Unknown local-ydb profile: ${name}`);
  }
  return normalizeProfile(name, profile);
}
