import type { CommandResult, LocalYdbApiClient } from "../api-client.js";
import type { LocalYdbConfig, ResolvedLocalYdbProfile } from "../validation.js";

export interface ToolkitContext {
  config: LocalYdbConfig;
  configPath?: string;
  profile: ResolvedLocalYdbProfile;
  client: LocalYdbApiClient;
}

export interface OperationPlan {
  risk: "low" | "medium" | "high";
  plannedCommands: string[];
  rollback: string[];
  verification: string[];
}

export interface OperationResponse extends OperationPlan {
  summary: string;
  executed: boolean;
  results?: CommandResult[];
}

export interface MutatingOptions {
  confirm?: boolean;
}

export type ImagePullStatus = "planned" | "already-present" | "running" | "completed" | "failed" | "unknown";

export interface ListVersionsOptions {
  image?: string;
  pageSize?: number;
  maxPages?: number;
  fetchImpl?: typeof fetch;
}

export interface ImagePullOptions extends MutatingOptions {
  image?: string;
}

export interface ImagePullStatusOptions {
  jobId: string;
}

export interface AddDynamicNodesOptions extends MutatingOptions {
  count?: number;
  startIndex?: number;
  grpcPortStart?: number;
  monitoringPortStart?: number;
  icPortStart?: number;
}

export interface RemoveDynamicNodesOptions extends MutatingOptions {
  count?: number;
  startIndex?: number;
  containers?: string[];
  nodeIds?: number[];
}

export interface AddStorageGroupsOptions extends MutatingOptions {
  count?: number;
  poolName?: string;
}

export interface ReduceStorageGroupsOptions extends MutatingOptions {
  count?: number;
  dumpName?: string;
  poolName?: string;
}

export interface UpgradeVersionOptions extends MutatingOptions {
  version?: string;
  dumpName?: string;
}

export type SchemeAction = "list" | "describe";

export interface SchemeOptions {
  action?: SchemeAction;
  path?: string;
  recursive?: boolean;
  long?: boolean;
  onePerLine?: boolean;
  stats?: boolean;
  maxOutputBytes?: number;
}

export type PermissionsAction =
  | "list"
  | "grant"
  | "revoke"
  | "set"
  | "clear"
  | "chown"
  | "set-inheritance"
  | "clear-inheritance";

export interface PermissionsOptions extends MutatingOptions {
  action?: PermissionsAction;
  path?: string;
  subject?: string;
  permissions?: string[];
  owner?: string;
  maxOutputBytes?: number;
}

export interface SetRootPasswordOptions extends MutatingOptions {
  password?: string;
}

export interface DestroyStackOptions extends MutatingOptions {
  removeBindMountPath?: boolean;
  removeAuthArtifacts?: boolean;
  removeDumpHostPath?: boolean;
}

export interface DynamicNodePlan {
  container: string;
  index: number;
  grpcPort: number;
  monitoringPort: number;
  icPort: number;
}

export interface DynamicNodeTarget {
  container: string;
  index: number;
  icPort?: number;
  nodeId?: number;
}

export interface DynamicNodeCheck {
  container: string;
  icPort: number;
  ok: boolean;
  attempts: number;
  observedPorts: number[];
  error?: string;
}

export interface AddDynamicNodesResponse extends OperationResponse {
  nodes: DynamicNodePlan[];
  nodeChecks?: DynamicNodeCheck[];
}

export interface RemoveDynamicNodesResponse extends OperationResponse {
  nodes: DynamicNodeTarget[];
  nodeChecks?: DynamicNodeCheck[];
}

export interface AddStorageGroupsResponse extends OperationResponse {
  pool: {
    name: string;
    boxId: number;
    storagePoolId: number;
    numGroups: number;
    targetNumGroups: number;
    itemConfigGeneration?: number;
  };
  observedNumGroups?: number;
}

export interface ReduceStorageGroupsResponse extends OperationResponse {
  pool: {
    name: string;
    boxId: number;
    storagePoolId: number;
    numGroups: number;
    targetNumGroups: number;
    itemConfigGeneration?: number;
  };
  dumpName: string;
  authReapplyPlanned: boolean;
  extraDynamicNodes: string[];
  observedNumGroups?: number;
}

export interface DestroyStackResponse extends OperationResponse {
  tenantRemovePlanned: boolean;
  extraDynamicNodes: string[];
  removesBindMountPath: boolean;
  removesAuthArtifacts: boolean;
  removesDumpHostPath: boolean;
}

export interface PrerequisiteCheck {
  name: string;
  kind: "command" | "file";
  ok: boolean;
  detail: string;
}

export interface CheckPrerequisitesResponse extends OperationResponse {
  checks: PrerequisiteCheck[];
  missing: string[];
  installablePackages: string[];
  packageManager?: string;
  manualActions: string[];
}

export interface ListVersionsResponse {
  summary: string;
  image: string;
  registry: string;
  repository: string;
  tags: string[];
  count: number;
  truncated: boolean;
}

export interface ImagePullResponse extends OperationResponse {
  image: string;
  status: ImagePullStatus;
  jobId?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface ImagePullStatusResponse {
  summary: string;
  found: boolean;
  jobId: string;
  status: ImagePullStatus;
  image?: string;
  profile?: string;
  command?: string;
  startedAt?: string;
  updatedAt?: string;
  exitCode?: number | null;
  ok?: boolean;
  timedOut?: boolean;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface UpgradeVersionResponse extends OperationResponse {
  sourceImage: string;
  targetImage: string;
  dumpName: string;
  authReapplyPlanned: boolean;
  extraDynamicNodes: string[];
  profileImageUpdate?: {
    configPath: string;
    profile: string;
    sourceImage: string;
    targetImage: string;
    executed: boolean;
    ok: boolean;
    error?: string;
  };
  imageVerification?: {
    expectedImage: string;
    missing: string[];
    mismatches: string[];
  };
}

export interface SchemeResponse {
  summary: string;
  ok: boolean;
  action: SchemeAction;
  path: string;
  command: string;
  /** Captured stdout, potentially capped to maxOutputBytes. */
  stdout: string;
  /** Captured stderr, potentially capped to maxOutputBytes. */
  stderr: string;
  /** Byte length of the original uncapped stdout stream. */
  stdoutBytes: number;
  /** Byte length of the original uncapped stderr stream. */
  stderrBytes: number;
  /** Whether stdout was truncated due to maxOutputBytes. */
  stdoutTruncated: boolean;
  /** Whether stderr was truncated due to maxOutputBytes. */
  stderrTruncated: boolean;
  /** Maximum bytes returned in each stdout/stderr field. */
  maxOutputBytes: number;
}

export interface PermissionsListResponse {
  summary: string;
  ok: boolean;
  action: "list";
  path: string;
  command: string;
  /** Captured stdout, potentially capped to maxOutputBytes. */
  stdout: string;
  /** Captured stderr, potentially capped to maxOutputBytes. */
  stderr: string;
  /** Byte length of the original uncapped stdout stream. */
  stdoutBytes: number;
  /** Byte length of the original uncapped stderr stream. */
  stderrBytes: number;
  /** Whether stdout was truncated due to maxOutputBytes. */
  stdoutTruncated: boolean;
  /** Whether stderr was truncated due to maxOutputBytes. */
  stderrTruncated: boolean;
  /** Maximum bytes returned in each stdout/stderr field. */
  maxOutputBytes: number;
}

export interface PermissionsMutationResponse extends OperationResponse {
  action: Exclude<PermissionsAction, "list">;
  path: string;
  subject?: string;
  permissions?: string[];
  owner?: string;
}

export type PermissionsResponse = PermissionsListResponse | PermissionsMutationResponse;
