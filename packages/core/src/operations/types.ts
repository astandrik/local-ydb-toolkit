import type { CommandResult, LocalYdbApiClient } from "../api-client.js";
import type { LocalYdbConfig, ResolvedLocalYdbProfile } from "../validation.js";

export interface ToolkitContext {
  config: LocalYdbConfig;
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
