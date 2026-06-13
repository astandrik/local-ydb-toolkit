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

export interface DumpTenantOptions extends MutatingOptions {
  dumpName?: string;
  path?: string;
}

export interface RestoreVerificationCountQuery {
  label?: string;
  query: string;
}

export interface RestoreTenantOptions extends MutatingOptions {
  dumpName?: string;
  path?: string;
  describePaths?: string[];
  countQueries?: RestoreVerificationCountQuery[];
}

export interface DumpEntry {
  name: string;
  hostPath: string;
  tenantDumpPath: string;
}

export interface ListDumpsResponse {
  summary: string;
  ok: boolean;
  command: string;
  dumpHostPath: string;
  dumps: DumpEntry[];
  stdout: string;
  stderr: string;
}

export type RestoreVerificationHook =
  | { type: "schemeDescribe"; path: string; resolvedPath: string }
  | { type: "countQuery"; label?: string; query: string };

export interface DumpTenantResponse extends OperationResponse {
  dumpName: string;
  path: string;
  sourcePath: string;
  dumpPath: string;
}

export interface RestoreTenantResponse extends OperationResponse {
  dumpName?: string;
  path?: string;
  targetPath?: string;
  verificationHooks: RestoreVerificationHook[];
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

export interface HealthcheckOptions {
  databasePath?: string;
  noCache?: boolean;
  noMerge?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxIssues?: number;
}

export type SchemaAction = "validate" | "apply";

export type SchemaStatementKind = "PRAGMA" | "CREATE TABLE" | "ALTER TABLE" | "DROP TABLE";

export interface SchemaSdkExecuteRequest {
  mode: "validate" | "execute";
  connectionString: string;
  databasePath: string;
  endpoint: string;
  script: string;
  timeoutMs: number;
  rootUser?: string;
  rootPassword?: string;
}

export interface SchemaSdkExecuteResult {
  ok: boolean;
  status: string;
  issues: string;
}

export type SchemaSdkExecutor = (request: SchemaSdkExecuteRequest) => Promise<SchemaSdkExecuteResult>;

export interface ApplySchemaOptions extends MutatingOptions {
  action?: SchemaAction;
  databasePath?: string;
  script: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sdkExecutor?: SchemaSdkExecutor;
}

export interface SchemaOperationResult {
  ok: boolean;
  status: string;
  /** Captured SDK/YDB issue text, potentially capped to maxOutputBytes. */
  issues: string;
  /** Byte length of the original uncapped issue text. */
  issuesBytes: number;
  /** Whether issues was truncated due to maxOutputBytes. */
  issuesTruncated: boolean;
}

export interface ApplySchemaResponse extends OperationPlan {
  summary: string;
  action: SchemaAction;
  databasePath: string;
  executed: boolean;
  scriptSha256: string;
  statements: {
    count: number;
    kinds: SchemaStatementKind[];
  };
  validation: SchemaOperationResult;
  execution?: SchemaOperationResult;
  /** Maximum bytes returned in validation/execution issue fields. */
  maxOutputBytes: number;
}

export type GeneratedSchemaStatementKind = "CREATE TABLE" | "ALTER TABLE" | "DROP TABLE";

export interface SchemaColumnSpec {
  name: string;
  type: string;
  notNull?: boolean;
  default?: string | number | boolean;
}

export interface SchemaIndexSpec {
  name: string;
  columns: string[];
  cover?: string[];
  global?: boolean;
  local?: boolean;
  unique?: boolean;
  sync?: "sync" | "async";
  using?: "secondary" | "vector_kmeans_tree";
  with?: Record<string, SchemaSettingValue>;
}

export interface SchemaSettingTokenValue {
  token: string;
}

export type SchemaSettingValue = string | number | boolean | SchemaSettingTokenValue;

export interface CreateTableSchemaStatementSpec {
  kind: "createTable";
  tableName: string;
  ifNotExists?: boolean;
  columns: SchemaColumnSpec[];
  primaryKey: string[];
  indexes?: SchemaIndexSpec[];
  partitionByHash?: string[];
  store?: "row" | "column";
  with?: Record<string, SchemaSettingValue>;
}

export type AlterTableSchemaAction =
  | { kind: "addColumn"; column: SchemaColumnSpec }
  | { kind: "dropColumn"; name: string }
  | { kind: "addIndex"; index: SchemaIndexSpec }
  | { kind: "dropIndex"; name: string };

export interface AlterTableSchemaStatementSpec {
  kind: "alterTable";
  tableName: string;
  actions: AlterTableSchemaAction[];
}

export interface DropTableSchemaStatementSpec {
  kind: "dropTable";
  tableName: string;
}

export type SchemaStatementSpec =
  | CreateTableSchemaStatementSpec
  | AlterTableSchemaStatementSpec
  | DropTableSchemaStatementSpec;

export interface GenerateSchemaOptions {
  databasePath?: string;
  statements: SchemaStatementSpec[];
  validate?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sdkExecutor?: SchemaSdkExecutor;
}

export interface SchemaReference {
  label: string;
  url: string;
}

export interface GenerateSchemaResponse {
  summary: string;
  databasePath: string;
  script: string;
  scriptSha256: string;
  statements: {
    count: number;
    kinds: GeneratedSchemaStatementKind[];
  };
  references: SchemaReference[];
  warnings: string[];
  applyRisk: OperationPlan["risk"];
  verification: string[];
  validation?: SchemaOperationResult;
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

export interface HealthcheckResponse {
  summary: string;
  ok: boolean;
  commandOk: boolean;
  healthy: boolean;
  databasePath: string;
  command: string;
  selfCheckResult?: string;
  issueCount: number;
  issueStatusCounts: Record<string, number>;
  issueTypes: string[];
  issues: unknown[];
  issuesTruncated: boolean;
  parseError?: string;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  maxOutputBytes: number;
  maxIssues: number;
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
