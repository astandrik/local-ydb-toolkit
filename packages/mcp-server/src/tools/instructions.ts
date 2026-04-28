import { localYdbToolIndex } from "./registry.js";

const localYdbToolIndexInstructions = localYdbToolIndex
  .map(([group, names]) => `${group}: ${names.join(", ")}`)
  .join("; ");

export const localYdbInstructions = [
  `Available local-ydb tools by category: ${localYdbToolIndexInstructions}.`,
  "Use local_ydb_check_prerequisites first on a new local or remote target to verify Docker, host helpers, and auth-file prerequisites before deeper checks.",
  "If local_ydb_check_prerequisites reports installable missing packages, review the plan first and then run it with confirm=true to install supported host helpers such as curl or ruby; Docker still requires manual installation.",
  "Use local_ydb_status_report or local_ydb_inventory first to establish the current stack state before mutating anything.",
  "Use local_ydb_list_versions to inspect published local-ydb image tags before choosing a target version for upgrade.",
  "Use local_ydb_pull_image with confirm=true before bootstrap or upgrade when an image is missing, then poll local_ydb_pull_status until it completes.",
  "For generic requests such as \"start local YDB\" or \"create a local database\" where the user does not explicitly ask for a tenant, GraphShard, or dynamic node, choose local_ydb_bootstrap_root_database.",
  "Use local_ydb_bootstrap only when a CMS tenant plus dynamic node topology is explicitly required, for example /local/<tenant>, GraphShard, tenant storage, tenant dump/restore, or dynamic-node testing.",
  "For bootstrap or restart issues, inspect local_ydb_database_status and local_ydb_container_logs before retrying.",
  "Prefer exact image tags for local-ydb stacks and avoid mixing static and dynamic image versions in one stack.",
  "For volume-backed version upgrades, prefer local_ydb_upgrade_version, which requires a file-backed config path, verifies source and target images are present, then uses dump, rebuild, restore, auth reapply, extra-node recreation, image verification, and profile image persistence instead of reusing an old volume in place; bindMountPath profiles are not supported.",
  "On a fresh /local/<tenant> database, admin database status can be PENDING_RESOURCES before the first dynamic node registers; treat status success as the readiness gate for the first dynamic-node start.",
  "For storage-pool expansion, reread the current pool definition first and increase NumGroups on that exact pool instead of guessing a partial DefineStoragePool shape.",
  "For storage-pool reduction, do not try to live-decrease NumGroups; dump the tenant, rebuild the stack with a smaller storagePoolCount, restore, and then reapply auth if the profile uses it.",
  "For full teardown, remove tenant metadata first when the static node is reachable, then remove containers, network, and storage; keep shared host paths opt-in.",
  "When adding extra dynamic nodes, start and verify one node at a time before adding the next.",
  "When removing extra dynamic nodes, remove one node at a time and confirm its IC port disappears from nodelist before removing another.",
  "For auth rollout, prepare the config and dynamic auth token first, then apply auth hardening; after auth, anonymous viewer checks should return 401 while authenticated tenant checks should still pass.",
].join(" ");
