# @astandrik/local-ydb-mcp

Unofficial stdio MCP server for operating Docker-based `local-ydb` deployments.

Website: [local-ydb-toolkit.ydb-qdrant.tech](https://local-ydb-toolkit.ydb-qdrant.tech/).

## Relationship to `ydb/ydb-mcp`

This package is complementary to the official [`ydb-platform/ydb-mcp`](https://github.com/ydb-platform/ydb-mcp) server. Use `ydb/ydb-mcp` for general YDB database-level tools such as ad hoc SQL queries, query explanations, directory listing, and path inspection against an existing YDB endpoint.

Use `@astandrik/local-ydb-mcp` when an agent needs to operate Docker-based `local-ydb` environments themselves: host prerequisite checks, root or tenant bootstrap, database healthcheck diagnostics, dynamic-node lifecycle, GraphShard checks, table DDL generation/validation/application for local deployments, auth hardening, storage workflows, dump/restore, and version upgrades. Mutating tools are plan-first and require `confirm: true` before they execute changes.

## MCP Client Config

This package requires Node.js 20.19 or newer.

Use `npx` so clients can run the server without a manual checkout:

```json
{
  "mcpServers": {
    "local-ydb": {
      "command": "npx",
      "args": ["-y", "--prefer-online", "@astandrik/local-ydb-mcp@latest"],
      "env": {
        "LOCAL_YDB_TOOLKIT_CONFIG": "/path/to/local-ydb.config.json"
      }
    }
  }
}
```

This form checks the npm registry when the MCP server starts, so clients pick up newly published versions after restarting the MCP client.

The config file is optional. If `LOCAL_YDB_TOOLKIT_CONFIG` is not set, the server reads `local-ydb.config.json` from the current working directory. If that file is missing, it uses a default local profile.

Official MCP Registry metadata uses the name `io.github.astandrik/local-ydb-mcp` and is published from the repository root `server.json` after the matching npm version is available.

## MCP Features

The server exposes local-ydb operation tools and static MCP prompts. Prompt
templates guide stack diagnosis, root database bootstrap, tenant topology
bootstrap, database diagnostics, schema generation/apply, version upgrades,
auth hardening, and storage group reduction. Tenant dumps are mandatory for
data-preserving version upgrades and storage-group reduction; live or
production-like auth hardening requires a reviewed tenant dump or copied-volume
rehearsal. Prompts return workflow instructions only; they do not execute
commands.

Mutating tools remain plan-only unless called with `confirm: true`.

<!-- BEGIN GENERATED MCP TOOLS -->
## Tools

The server exposes 38 tools. This index is generated from the runtime tool registry; edit `toolDefinitions` and run `npm run docs:generate` to update it.

### Checks

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_inventory` | read-only | Read-only Docker inventory for a local-ydb target profile. Returns the public profile, Docker containers and volumes visible on the selected target, and inspect data for the configured static and primary dynamic containers; use before mutating tools to capture current stack state. |
| `local_ydb_database_status` | read-only | Read-only YDB admin database status for the configured tenant path. Returns the command, stdout, stderr, and ok flag; use this for tenant state before bootstrap/restart troubleshooting, and use local_ydb_tenant_check for scheme reachability. |
| `local_ydb_healthcheck` | read-only | Read-only YDB monitoring healthcheck for the configured tenant or root database. Uses the official YDB CLI SelfCheck path, returns selfCheckResult, issue counts, issue types, capped raw output, and whether the database is healthy; use after local_ydb_status_report for database-level diagnostics. |
| `local_ydb_container_logs` | read-only | Read recent Docker logs from the configured static or primary dynamic local-ydb container. Use when bootstrap, restart, or readiness checks fail; target selects the container role and lines controls the tail length. |
| `local_ydb_status_report` | read-only | Read-only aggregate report for quick diagnosis. Runs local_ydb_inventory, local_ydb_auth_check, local_ydb_tenant_check, local_ydb_nodes_check, and local_ydb_healthcheck, returning each result; use this first for broad stack health, then run focused checks for database status, GraphShard, storage, or logs. |
| `local_ydb_tenant_check` | read-only | Read-only check that uses the YDB CLI to verify the configured tenant path is reachable. Use after bootstrap or restore to confirm tenant metadata before node or GraphShard checks. |
| `local_ydb_scheme` | read-only | Read-only YDB scheme list or describe with capped stdout/stderr. It uses the root database for rootDatabase paths and the tenant database otherwise; list supports recursive/long/onePerLine flags, describe supports stats, and incompatible flag combinations are rejected. |
| `local_ydb_nodes_check` | read-only | Read-only check of dynamic node registration through viewer/json nodelist. Use after starting, adding, or removing dynamic nodes; use local_ydb_tenant_check first when tenant reachability is unknown. |
| `local_ydb_graphshard_check` | read-only | Read-only GraphShard check through viewer/json capabilities and tabletinfo for the configured tenant. Returns graphShardExists, tablet ids, and viewer status details; use after tenant bootstrap when GraphShard support or tablet visibility is the specific question. |
| `local_ydb_auth_check` | read-only | Read-only auth audit that checks anonymous viewer whoami status and configured YDB CLI tenant access, using root credentials when rootPasswordFile is configured. Use after auth hardening or password rotation to verify the expected posture. |
| `local_ydb_storage_placement` | read-only | Read-only storage inspection that returns ReadStoragePool output and BSC physical placement. Use before adding or reducing storage groups to confirm the exact pool shape. |
| `local_ydb_storage_leftovers` | read-only | Read-only search for candidate leftover local-ydb Docker volumes, dumps, and PDisk/data paths. It scans Docker volume names plus profile.storageSearchPaths and deletes nothing; use before local_ydb_cleanup_storage to decide exact paths or volumes to remove. |
| `local_ydb_list_versions` | read-only | List published registry tags for a local-ydb container image, with numeric version tags sorted newest first. Use before local_ydb_upgrade_version to choose a target tag; pageSize and maxPages bound registry pagination and the response reports truncation. |
| `local_ydb_pull_status` | read-only | Check the status of a background Docker image pull started by local_ydb_pull_image. |

### Schema

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_generate_schema` | read-only | Read-only structured YDB table DDL generator. It renders strict JSON specs for CREATE TABLE, ALTER TABLE, DROP TABLE, and secondary indexes, returns the generated script with official references and warnings, and can optionally validate through the YDB JS SDK without applying changes. |
| `local_ydb_apply_schema` | plan-first mutation | Validate or apply YDB table DDL through the official YDB JS SDK. It accepts raw YQL DDL for PRAGMA plus CREATE TABLE, ALTER TABLE, and DROP TABLE; action=apply validates first and executes only with confirm=true. |

### Auth

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_permissions` | plan-first mutation | Inspect or change YDB scheme permissions for a path. The default list action is read-only; grant, revoke, set, clear, chown, and inheritance changes return a plan unless confirm=true. |
| `local_ydb_prepare_auth_config` | plan-first mutation | Generate a hardened YDB config from the current static-node config. Use before local_ydb_write_dynamic_auth_config and local_ydb_apply_auth_hardening; without confirm=true this returns the planned write only. |
| `local_ydb_write_dynamic_auth_config` | plan-first mutation | Write the text-proto dynamic-node auth token file needed for mandatory-auth startup. Use after choosing the SID for auth hardening; without confirm=true this returns the planned file write only. |
| `local_ydb_apply_auth_hardening` | plan-first mutation | Apply a reviewed hardened YDB config file and restart local-ydb so auth settings take effect. Use only after preparing and reviewing the config; without confirm=true this returns the apply/restart plan only. |
| `local_ydb_set_root_password` | plan-first mutation | Rotate the runtime root password with ALTER USER and sync the host auth config and root password file to match. YDB may reject passwords that violate auth_config.password_complexity; this tool requires a non-empty password value. |

### Storage

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_add_storage_groups` | plan-first mutation | Increase NumGroups for one tenant storage pool using the current ReadStoragePool definition. Without confirm=true this returns the DefineStoragePool plan, rollback, target pool, and target count; when the update succeeds it verifies NumGroups and tenant metadata. |
| `local_ydb_reduce_storage_groups` | plan-first mutation | Reduce NumGroups for a tenant storage pool by dumping the tenant, rebuilding the profile stack with a smaller storagePoolCount, restoring the dump, and reapplying auth when needed. |
| `local_ydb_cleanup_storage` | plan-first mutation | Delete only the explicitly supplied local-ydb host paths or Docker volumes. Use after inspecting local_ydb_storage_leftovers; without confirm=true this returns the cleanup plan and removes nothing. |

### Lifecycle

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_pull_image` | plan-first mutation | Plan or start a background Docker pull for a local-ydb image on the selected target. Without confirm=true it returns inspect and pull commands only; with confirm=true it returns a jobId for local_ydb_pull_status unless the image is already present. |
| `local_ydb_destroy_stack` | plan-first mutation | Remove tenant metadata, local-ydb containers, network, and storage for a profile, with optional host-path cleanup. |
| `local_ydb_bootstrap_root_database` | plan-first mutation | Bootstrap a plain local YDB database at /local with only a static node. Use for generic local database requests that do not need a CMS tenant, GraphShard, or dynamic nodes; without confirm=true this returns the image preflight, Docker network/storage/static-node, and verification plan without executing it. |
| `local_ydb_bootstrap` | plan-first mutation | Bootstrap a tenant topology: static node with GraphShard flags, configured CMS tenant, and primary dynamic tenant node. Use only for tenant, GraphShard, dump/restore, or dynamic-node scenarios; without confirm=true this returns the full plan and creates nothing. |
| `local_ydb_check_prerequisites` | plan-first mutation | Check target-host prerequisites for Docker, curl, ruby, and the configured rootPasswordFile when present. Without confirm=true it returns checks, missing items, manual actions, and any apt-get install plan; with confirm=true it may install only supported curl/ruby packages and never installs Docker. |
| `local_ydb_create_tenant` | plan-first mutation | Create the configured CMS tenant when the static node is already running. Use before local_ydb_start_dynamic_node for tenant topologies; without confirm=true this returns the planned status/create command and creates nothing. |
| `local_ydb_start_dynamic_node` | plan-first mutation | Start the configured primary dynamic tenant node for an existing CMS tenant. Use after local_ydb_create_tenant or when admin status is PENDING_RESOURCES; use local_ydb_add_dynamic_nodes for extra nodes. Without confirm=true this returns a plan only. |
| `local_ydb_restart_stack` | plan-first mutation | Restart the selected profile by stopping dynamic and static containers, starting the static node, ensuring the configured tenant, then starting the dynamic node. Use after config or runtime changes; without confirm=true this returns the restart plan only. |
| `local_ydb_upgrade_version` | plan-first mutation | Upgrade a file-backed, volume-backed local-ydb profile to a target image tag. Use only for version upgrades on profiles without bindMountPath; it preflights source and target images, dumps, rebuilds, restores, reapplies auth when configured, recreates extra nodes, verifies container images, and persists the profile image after successful confirmed execution. |

### Dynamic Nodes

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_add_dynamic_nodes` | plan-first mutation | Add extra dynamic tenant nodes beyond the configured primary dynamic node, one at a time. Without confirm=true it returns container/port plans; with confirm=true it starts each node, verifies its IC port appears in viewer/json nodelist, and checks tenant metadata. |
| `local_ydb_remove_dynamic_nodes` | plan-first mutation | Remove extra dynamic tenant nodes one at a time and verify nodelist disappearance when the node IC port can be resolved. |

### Backup Restore

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_list_dumps` | read-only | Read-only list of available tenant dumps under profile.dumpHostPath. Use before restore to choose a dumpName; it only reports top-level dump directories that contain the existing tenant dump folder. |
| `local_ydb_dump_tenant` | plan-first mutation | Dump the configured tenant or a tenant-relative path using a local-ydb helper container on the static container network. It creates profile.dumpHostPath/dumpName, excludes .sys objects, writes the dump under dumpName/tenant, and without confirm=true returns the mkdir/helper-container plan only. |
| `local_ydb_restore_tenant` | plan-first mutation | Restore the configured tenant or destination path from a dump under profile.dumpHostPath, with optional post-restore scheme describe and bounded count-query verification. Use after bootstrap or rebuild when the target tenant is ready; without confirm=true this returns the restore plan and does not write data. |

<!-- END GENERATED MCP TOOLS -->

## Response Content Format

By default, tool responses keep the current MCP shape: `structuredContent` is a JSON object, and the second text content block is pretty-printed JSON. To prefer TOON for the LLM-facing text block only, set:

```json
{
  "env": {
    "LOCAL_YDB_MCP_CONTENT_FORMAT": "toon"
  }
}
```

Valid values are `json` and `toon`; omit the variable for the default `json` format. This does not change MCP JSON-RPC, tool input schemas, or `structuredContent`. In `toon` mode the server verifies that the encoded text decodes back to the same JSON data model; if not, it falls back to pretty JSON for that response text.

For a reproducible local comparison of representative response fixtures:

```bash
npm run compare:formats -w @astandrik/local-ydb-mcp
```

Manual agent smoke check: run the MCP server once with `LOCAL_YDB_MCP_CONTENT_FORMAT=json` and once with `toon`, then call the same tools in both sessions: `local_ydb_inventory`, `local_ydb_status_report`, `local_ydb_healthcheck`, `local_ydb_bootstrap_root_database` without `confirm`, `local_ydb_scheme`, `local_ydb_generate_schema` with `validate=true`, `local_ydb_apply_schema` with `action=validate`, `local_ydb_permissions` with a plan-only mutation, `local_ydb_list_versions`, and `local_ydb_nodes_check`. Record whether the agent extracts the same status, planned commands, risks, and next steps. Treat this as qualitative evidence; the benchmark command is the reproducible metric.

## Global Install

```bash
npm install -g @astandrik/local-ydb-mcp
```

```json
{
  "mcpServers": {
    "local-ydb": {
      "command": "local-ydb-mcp",
      "env": {
        "LOCAL_YDB_TOOLKIT_CONFIG": "/path/to/local-ydb.config.json"
      }
    }
  }
}
```

`local_ydb_generate_schema` is the read-only structured table-DDL generator. It renders strict JSON specs for `CREATE TABLE`, table-level secondary indexes, ordered `ALTER TABLE` column/index changes, and `DROP TABLE`; returns the generated DDL text, script SHA-256, official YDB references, warnings, risk, and verification steps; and can validate the generated script when `validate: true` is supplied. It never applies DDL and uses the same 1 MiB generated-script limit as `local_ydb_apply_schema`. In `with` settings, setting names must be YQL-style identifiers, strings render as quoted YQL literals, use `{ "token": "ENABLED" }` for bare-token settings, and use the top-level `store` field instead of `with.STORE`. Keep column names away from the reserved `__ydb_` prefix, use `CREATE TABLE` `notNull` only for columns that are part of the `primaryKey`, use `partitionByHash` only with `store: "column"` and primary key columns, keep column-oriented primary keys `NOT NULL` and within the documented supported key types, keep secondary/vector indexes on row-oriented tables, use global secondary indexes without creation-time `with` settings, keep unique indexes synchronous, keep `ALTER TABLE ADD COLUMN` to name/type only, reject duplicate add/drop column/index actions in one spec, keep indexes off columns added or dropped in the same `alterTable` spec, provide a non-unique `global: true`, `sync: "sync"` vector index with complete `vector_kmeans_tree` settings, expect a warning when creating a table with a vector index because adding the index after representative data is preferred, and rely on type-aware defaults such as `Utf8('x')`, `Uint64('1')`, or `Date('2026-05-27')`.

Mutating tools are plan-only unless called with `confirm: true`. `local_ydb_apply_schema` is the table-DDL apply path: it validates raw or generated YQL DDL through the official `@ydbjs/*` SDK, supports `PRAGMA`, `CREATE TABLE`, `ALTER TABLE`, and `DROP TABLE`, and applies only after validation succeeds and `confirm: true` is present. Responses report the script SHA-256 and capped YDB issue text without echoing the raw script or credential paths. For table creation, prefer a CMS tenant path such as `/local/example`; a root-only `/local` stack can validate DDL through the static endpoint, but YDB rejects storage-backed table creation there when the root database has no tenant storage pools.

The server includes a root-only `local_ydb_bootstrap_root_database` tool for starting `/local` with just the static node, a tenant-oriented `local_ydb_bootstrap` tool for GraphShard-ready dynamic-node topologies, a read-only `local_ydb_list_versions` tool for discovering published `local-ydb` image tags with numeric versions sorted newest first, background image-pull tools (`local_ydb_pull_image` and `local_ydb_pull_status`) for slow registry downloads, `local_ydb_generate_schema` and `local_ydb_apply_schema` for table DDL generation/validation/application, `local_ydb_list_dumps` plus dump/restore tools for tenant-wide or tenant-relative backup operations, and a high-risk `local_ydb_upgrade_version` tool that upgrades a file-backed profile by image preflight, dump, rebuild, restore, auth reapply, image verification, and persisting the profile image. Bind-mounted data profiles are not supported by the automatic upgrade path.

`local_ydb_dump_tenant` and `local_ydb_restore_tenant` accept `path` while preserving existing tenant-wide defaults. Dump `path` is the source object or directory for `ydb tools dump -p`; restore `path` is the destination directory for `ydb tools restore -p`. Use `local_ydb_list_dumps` before restore to choose a `dumpName`, and use optional `describePaths` plus bounded whole-table `countQueries` such as `SELECT COUNT(*) FROM \`dir/table\`;` when a restore needs post-command verification.
