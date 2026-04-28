import { z } from "zod";

export const ProfileArgs = z.object({
  profile: z.string().optional(),
  configPath: z.string().optional(),
});

export const LogsArgs = ProfileArgs.extend({
  target: z.enum(["static", "dynamic"]),
  lines: z.number().int().positive().optional(),
});

export const SchemeArgs = ProfileArgs.extend({
  action: z.enum(["list", "describe"]).optional(),
  path: z.string().min(1).optional(),
  recursive: z.boolean().optional(),
  long: z.boolean().optional(),
  onePerLine: z.boolean().optional(),
  stats: z.boolean().optional(),
  maxOutputBytes: z.number().int().positive().max(1_048_576).optional(),
});

export const PermissionsArgs = ProfileArgs.extend({
  action: z.enum([
    "list",
    "grant",
    "revoke",
    "set",
    "clear",
    "chown",
    "set-inheritance",
    "clear-inheritance",
  ]).optional(),
  path: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  permissions: z.array(z.string().min(1)).nonempty().optional(),
  owner: z.string().min(1).optional(),
  maxOutputBytes: z.number().int().positive().max(1_048_576).optional(),
  confirm: z.boolean().optional(),
});

export const MutatingArgs = ProfileArgs.extend({
  confirm: z.boolean().optional(),
});

export const AddDynamicNodesArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  startIndex: z.number().int().min(2).optional(),
  grpcPortStart: z.number().int().positive().max(65535).optional(),
  monitoringPortStart: z.number().int().positive().max(65535).optional(),
  icPortStart: z.number().int().positive().max(65535).optional(),
});

export const RemoveDynamicNodesArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  startIndex: z.number().int().min(2).optional(),
  containers: z.array(z.string()).optional(),
  nodeIds: z.array(z.number().int().positive()).max(10).optional(),
});

export const AddStorageGroupsArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  poolName: z.string().optional(),
});

export const ReduceStorageGroupsArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  dumpName: z.string().optional(),
  poolName: z.string().optional(),
});

export const DestroyStackArgs = MutatingArgs.extend({
  removeBindMountPath: z.boolean().optional(),
  removeAuthArtifacts: z.boolean().optional(),
  removeDumpHostPath: z.boolean().optional(),
});

export const DumpArgs = MutatingArgs.extend({
  dumpName: z.string().optional(),
});

export const RestoreArgs = MutatingArgs.extend({
  dumpName: z.string(),
});

export const AuthHardeningArgs = MutatingArgs.extend({
  configHostPath: z.string().optional(),
});

export const PrepareAuthConfigArgs = MutatingArgs.extend({
  configHostPath: z.string().optional(),
  sid: z.string().optional(),
});

export const DynamicAuthConfigArgs = MutatingArgs.extend({
  sid: z.string().optional(),
  tokenHostPath: z.string().optional(),
});

export const SetRootPasswordArgs = MutatingArgs.extend({
  password: z.string().min(1),
});

export const CleanupArgs = MutatingArgs.extend({
  paths: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
});

export const ListVersionsArgs = z.object({
  image: z.string().optional(),
  pageSize: z.number().int().positive().max(1000).optional(),
  maxPages: z.number().int().positive().max(100).optional(),
});

export const PullImageArgs = MutatingArgs.extend({
  image: z.string().min(1).optional(),
});

export const PullStatusArgs = z.object({
  jobId: z.string().min(1),
});

export const UpgradeVersionArgs = MutatingArgs.extend({
  version: z.string().min(1),
  dumpName: z.string().optional(),
});
