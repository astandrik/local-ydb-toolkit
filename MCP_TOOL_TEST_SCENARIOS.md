# MCP Tool Test Scenarios

Concrete scenarios for testing every `local_ydb_*` MCP tool in this repository.

These scenarios are intentionally opinionated and reflect what actually worked in this repo during local runs.

## Scope

This document covers all public `local_ydb_*` tools currently registered by the MCP server:

- `local_ydb_inventory`
- `local_ydb_database_status`
- `local_ydb_container_logs`
- `local_ydb_destroy_stack`
- `local_ydb_status_report`
- `local_ydb_tenant_check`
- `local_ydb_scheme`
- `local_ydb_permissions`
- `local_ydb_nodes_check`
- `local_ydb_graphshard_check`
- `local_ydb_auth_check`
- `local_ydb_storage_placement`
- `local_ydb_add_storage_groups`
- `local_ydb_reduce_storage_groups`
- `local_ydb_storage_leftovers`
- `local_ydb_list_versions`
- `local_ydb_pull_image`
- `local_ydb_pull_status`
- `local_ydb_bootstrap_root_database`
- `local_ydb_bootstrap`
- `local_ydb_create_tenant`
- `local_ydb_start_dynamic_node`
- `local_ydb_add_dynamic_nodes`
- `local_ydb_remove_dynamic_nodes`
- `local_ydb_restart_stack`
- `local_ydb_upgrade_version`
- `local_ydb_dump_tenant`
- `local_ydb_restore_tenant`
- `local_ydb_prepare_auth_config`
- `local_ydb_write_dynamic_auth_config`
- `local_ydb_apply_auth_hardening`
- `local_ydb_set_root_password`
- `local_ydb_cleanup_storage`

## Profiles

Use these profiles from `examples/local-ydb.config.example.json`:

- `ghcr261-clean`: isolated clean stack on `ghcr.io/ydb-platform/local-ydb:26.1.1.6`
- `ghcr261-auth`: same stack, but with auth artifacts enabled
- `local`: auth-enabled working stack on the default ports

Treat `ghcr-rebuild-clean` and `ghcr-rebuild-auth` as historical rehearsal profiles. Prefer the `ghcr261-*` pair for current testing.

## Global Rules

- Run `local_ydb_check_prerequisites` first on a new host or profile.
- If `local_ydb_check_prerequisites` reports installable packages, review its plan-only output and then use `confirm: true` to install supported host helpers before trying deeper checks.
- Run read-only tools first.
- Use `local_ydb_list_versions` before `local_ydb_upgrade_version` when you need to verify the exact registry tag to deploy.
- If an image is not already present on the target host, use `local_ydb_pull_image(confirm=true)` and poll `local_ydb_pull_status` before bootstrap or upgrade.
- For mutating tools, call plan-only once before `confirm: true` unless you are deliberately smoke-testing an idempotent path.
- Do not test `cleanup_storage` against active volumes or paths.
- Do not mix static and dynamic image tags inside one profile.
- For stable GHCR tests, use the exact patch tag `ghcr.io/ydb-platform/local-ydb:26.1.1.6`.

## Scenario 0: Prerequisites

Goal: verify the target host has the required base tools before any Docker or YDB checks.

Profile:
`ghcr261-clean`

Calls:

```json
{ "tool": "local_ydb_check_prerequisites", "arguments": { "profile": "ghcr261-clean", "confirm": false } }
```

Optional install path on supported apt-based hosts:

```json
{ "tool": "local_ydb_check_prerequisites", "arguments": { "profile": "ghcr261-clean", "confirm": true } }
```

Expected:

- the check reports whether `docker`, `curl`, and `ruby` are available
- auth-enabled profiles also report whether `rootPasswordFile` exists
- plan-only output includes `apt-get` install commands only for supported auto-install packages
- `docker` may appear in `missing`, but it remains a manual prerequisite

Avoid:

- treating `inventory = 0 containers` as proof that Docker is installed on a remote host
- using `confirm: true` blindly on a host where `apt-get` should not be touched

## Scenario 1: Preflight Read-Only Coverage

Goal: verify the selected profile is wired correctly and all read-only endpoints work.

Profile:
`ghcr261-clean`

Calls:

```json
{ "tool": "local_ydb_inventory", "arguments": { "profile": "ghcr261-clean" } }
{ "tool": "local_ydb_storage_leftovers", "arguments": { "profile": "ghcr261-clean" } }
{ "tool": "local_ydb_status_report", "arguments": { "profile": "ghcr261-clean" } }
{ "tool": "local_ydb_scheme", "arguments": { "profile": "ghcr261-clean" } }
{ "tool": "local_ydb_scheme", "arguments": { "profile": "ghcr261-clean", "action": "list", "recursive": true, "onePerLine": true } }
{ "tool": "local_ydb_scheme", "arguments": { "profile": "ghcr261-clean", "action": "describe", "path": "/local/example", "stats": true } }
{ "tool": "local_ydb_permissions", "arguments": { "profile": "ghcr261-clean" } }
```

Expected:

- `inventory` returns the profile shape and current container list.
- `storage_leftovers` reports candidate volumes/paths without mutating them.
- `status_report` returns a structured snapshot even when the stack is not yet healthy.
- `scheme` defaults to the tenant root, returns `command`, capped `stdout`/`stderr`, original uncapped byte counts, and truncation flags.
- `permissions` defaults to the tenant root for read-only ACL inspection and returns the owner, direct permissions, and effective permissions from the YDB CLI output.
- recursive scheme listings should use `maxOutputBytes` when the tenant has many objects.

Avoid:

- Treating `status_report.tenant=not-ok` as a transport failure. It often just means the stack is not bootstrapped yet.
- Passing list-only flags such as `recursive` to `action=describe`, or `stats` to `action=list`.

## Scenario 1A: Schema Permissions

Goal: verify ACL command construction and confirm-gating without accidentally changing an active stack.

Profile:
`ghcr261-auth`

Calls:

```json
{ "tool": "local_ydb_permissions", "arguments": { "profile": "ghcr261-auth", "action": "list", "path": "/local/example" } }
{ "tool": "local_ydb_permissions", "arguments": { "profile": "ghcr261-auth", "action": "grant", "path": "/local/example", "subject": "testuser", "permissions": ["ydb.generic.read"], "confirm": false } }
{ "tool": "local_ydb_permissions", "arguments": { "profile": "ghcr261-auth", "action": "revoke", "path": "/local/example", "subject": "testuser", "permissions": ["ydb.generic.read"], "confirm": false } }
{ "tool": "local_ydb_permissions", "arguments": { "profile": "ghcr261-auth", "action": "set", "path": "/local/example", "subject": "testuser", "permissions": ["ydb.generic.read", "ydb.generic.list"], "confirm": false } }
{ "tool": "local_ydb_permissions", "arguments": { "profile": "ghcr261-auth", "action": "clear", "path": "/local/example", "confirm": false } }
{ "tool": "local_ydb_permissions", "arguments": { "profile": "ghcr261-auth", "action": "chown", "path": "/local/example", "owner": "root", "confirm": false } }
{ "tool": "local_ydb_permissions", "arguments": { "profile": "ghcr261-auth", "action": "clear-inheritance", "path": "/local/example", "confirm": false } }
{ "tool": "local_ydb_permissions", "arguments": { "profile": "ghcr261-auth", "action": "set-inheritance", "path": "/local/example", "confirm": false } }
```

Expected:

- `action=list` executes without `confirm` and returns capped stdout/stderr plus byte counts.
- mutating actions return `executed=false`, planned command text, rollback notes, and verification steps when `confirm` is omitted or false.
- `grant`, `revoke`, and `set` render each permission as a separate `-p` argument.
- authenticated profiles redact configured password-file paths in planned command text.

Avoid:

- using `confirm: true` for `clear`, `chown`, or inheritance changes unless the target path and rollback are already captured by `action=list`.
- passing a comma-separated permission string; use the structured `permissions` array.

## Scenario 1B: Published Image Tags

Goal: verify that the registry tag listing tool can discover concrete `local-ydb` image versions before an upgrade.

Calls:

```json
{ "tool": "local_ydb_list_versions", "arguments": {} }
{ "tool": "local_ydb_list_versions", "arguments": { "image": "ghcr.io/ydb-platform/local-ydb", "pageSize": 50, "maxPages": 2 } }
```

Expected:

- the response includes `image`, `registry`, `repository`, `tags`, `count`, and `truncated`
- the default image resolves to `ghcr.io/ydb-platform/local-ydb`
- `tags` includes concrete patch tags when the registry publishes them
- numeric version tags are sorted newest first; mutable aliases such as `latest`, `nightly`, and `trunk` follow the numeric versions
- `truncated` becomes `true` only when the configured page limit is reached before the registry finishes pagination

Avoid:

- assuming `latest` is the only safe upgrade target
- using a short major/minor tag in production-like checks when an exact patch tag is available

## Scenario 1C: Background Image Pull

Goal: start slow registry downloads outside synchronous bootstrap or upgrade calls.

Calls:

```json
{ "tool": "local_ydb_pull_image", "arguments": { "profile": "ghcr261-clean", "image": "ghcr.io/ydb-platform/local-ydb:26.1.1.6", "confirm": false } }
{ "tool": "local_ydb_pull_image", "arguments": { "profile": "ghcr261-clean", "image": "ghcr.io/ydb-platform/local-ydb:26.1.1.6", "confirm": true } }
{ "tool": "local_ydb_pull_status", "arguments": { "jobId": "<jobId-from-pull-image>" } }
```

Expected:

- plan-only output includes `docker image inspect` and `docker pull`
- with `confirm: true`, the tool returns quickly with `status: running` and a `jobId`, unless the image is already present
- status polling eventually returns `completed` or `failed`
- bootstrap and upgrade image preflight failures point back to `local_ydb_pull_image` instead of hanging inside `docker run`

Avoid:

- relying on `docker run` to implicitly pull large images inside a synchronous MCP tool call
- treating a 120-second MCP client timeout during image download as a YDB bootstrap failure

## Scenario 2: Fresh Root Database Bootstrap

Goal: validate network/volume/static-node bring-up for plain `/local` without creating a CMS tenant or dynamic node.

Profile:
`ghcr261-clean`

Calls:

```json
{ "tool": "local_ydb_bootstrap_root_database", "arguments": { "profile": "ghcr261-clean", "confirm": false } }
{ "tool": "local_ydb_bootstrap_root_database", "arguments": { "profile": "ghcr261-clean", "confirm": true } }
{ "tool": "local_ydb_scheme", "arguments": { "profile": "ghcr261-clean", "path": "/local" } }
```

Expected:

- plan-only output starts the static container only
- no `admin database /local/... create` command is planned
- no dynamic-node container is created
- `scheme ls /local` succeeds through the static gRPC endpoint

Avoid:

- using the tenant bootstrap tool when the task only needs `/local`
- treating a missing configured tenant as a root database failure

## Scenario 3: Fresh Tenant Bootstrap on an Isolated GHCR Stack

Goal: validate network/volume/static/dynamic bring-up on a clean profile.

Profile:
`ghcr261-clean`

Calls:

```json
{ "tool": "local_ydb_bootstrap", "arguments": { "profile": "ghcr261-clean", "confirm": false } }
{ "tool": "local_ydb_bootstrap", "arguments": { "profile": "ghcr261-clean", "confirm": true } }
```

Expected:

- Docker network and volume are created.
- Static container starts.
- `admin database /local/example status` succeeds; `PENDING_RESOURCES` is acceptable before the first dynamic node fully serves traffic.
- Dynamic container is recreated with the current launch command if needed.
- Final checks succeed:
  `scheme ls /local/example`, viewer capabilities, dynamic node registration.

What made this work:

- exact image tag `ghcr.io/ydb-platform/local-ydb:26.1.1.6`
- dynamic launch sanitizes `grpc_config.ca/cert/key` from the generated config before calling `/ydbd server`
- dynamic launch disables TLS with:
  `GRPC_TLS_PORT=`
  `YDB_GRPC_ENABLE_TLS=0`

Avoid:

- using `ghcr.io/ydb-platform/local-ydb:26.1`
- reusing a stale dynamic container with `docker start` if its original launch command was broken

## Scenario 3A: Explicit Tenant and Dynamic-Node Smoke Test

Goal: exercise tenant creation and dynamic start as separate tools.

Profile:
`ghcr261-clean`

Calls:

```json
{ "tool": "local_ydb_create_tenant", "arguments": { "profile": "ghcr261-clean", "confirm": false } }
{ "tool": "local_ydb_create_tenant", "arguments": { "profile": "ghcr261-clean", "confirm": true } }
{ "tool": "local_ydb_database_status", "arguments": { "profile": "ghcr261-clean" } }
{ "tool": "local_ydb_start_dynamic_node", "arguments": { "profile": "ghcr261-clean", "confirm": false } }
{ "tool": "local_ydb_start_dynamic_node", "arguments": { "profile": "ghcr261-clean", "confirm": true } }
{ "tool": "local_ydb_tenant_check", "arguments": { "profile": "ghcr261-clean" } }
```

Expected:

- `create_tenant` waits until `admin database ... status` is readable. It should not insist on `RUNNING` before the first dynamic node.
- `database_status` can show `PENDING_RESOURCES` before dynamic registration and `RUNNING` afterwards.
- `start_dynamic_node` recreates the container if it is stale or exited.
- `tenant_check` succeeds only after the dynamic node is actually serving the tenant gRPC path.

Avoid:

- assuming `create OK` alone means the tenant is resolvable by NodeBroker

## Scenario 4: Runtime Diagnostics

Goal: cover the focused read-only diagnostics used when bootstrap fails.

Profile:
`ghcr261-clean`

Calls:

```json
{ "tool": "local_ydb_database_status", "arguments": { "profile": "ghcr261-clean" } }
{ "tool": "local_ydb_container_logs", "arguments": { "profile": "ghcr261-clean", "target": "static", "lines": 120 } }
{ "tool": "local_ydb_container_logs", "arguments": { "profile": "ghcr261-clean", "target": "dynamic", "lines": 120 } }
{ "tool": "local_ydb_nodes_check", "arguments": { "profile": "ghcr261-clean" } }
{ "tool": "local_ydb_graphshard_check", "arguments": { "profile": "ghcr261-clean" } }
{ "tool": "local_ydb_storage_placement", "arguments": { "profile": "ghcr261-clean" } }
```

Expected:

- `container_logs(dynamic)` shows whether the node:
  registered,
  fetched config,
  crashed on TLS/cert,
  or failed tenant resolution.
- `container_logs(static)` shows `NodeBroker` and `SchemeShard` evidence for create/resolve problems.
- `nodes_check` and `graphshard_check` become useful after the stack is healthy or after auth is enabled with a valid viewer session path.
- `storage_placement` proves the tenant’s groups are on `/ydb_data/pdisks/1`.

Avoid:

- using generic `docker logs` or shell-only inspection before trying `local_ydb_container_logs`

## Scenario 5: Idempotent Restart

Goal: confirm the restart tool is safe and uses the current launch command.

Profile:
`ghcr261-clean`

Calls:

```json
{ "tool": "local_ydb_restart_stack", "arguments": { "profile": "ghcr261-clean", "confirm": false } }
{ "tool": "local_ydb_restart_stack", "arguments": { "profile": "ghcr261-clean", "confirm": true } }
{ "tool": "local_ydb_status_report", "arguments": { "profile": "ghcr261-clean" } }
```

Expected:

- static node restarts first
- tenant status is checked before dynamic node is started again
- dynamic node is recreated if it is not already `Running`
- post-restart `status_report` returns `tenant=ok`, `nodes=ok`

Avoid:

- trusting a plain `docker start <dynamic>` path for a container created with old flags

## Scenario 6: Dump and Restore

Goal: prove backup/restore on a clean GHCR stack.

Profiles:

- source: `local`
- target: `ghcr261-clean`

Calls:

```json
{ "tool": "local_ydb_dump_tenant", "arguments": { "profile": "local", "confirm": true, "dumpName": "pre-auth-mcp-20260425" } }
{ "tool": "local_ydb_restore_tenant", "arguments": { "profile": "ghcr261-clean", "confirm": true, "dumpName": "pre-auth-mcp-20260425" } }
{ "tool": "local_ydb_tenant_check", "arguments": { "profile": "ghcr261-clean" } }
{ "tool": "local_ydb_graphshard_check", "arguments": { "profile": "ghcr261-clean" } }
```

Expected:

- dump helper container runs with `--entrypoint /bin/bash`
- restore helper container runs with `--entrypoint /bin/bash`
- restored tenant returns `.metadata  .sys`
- GraphShard exists after restore

Avoid:

- assuming the helper image entrypoint can run arbitrary shell commands without `--entrypoint /bin/bash`

## Scenario 7: Auth Artifact Preparation

Goal: test the two new preparation tools before mutating the running stack.

Profile:
`ghcr261-auth`

Calls:

```json
{ "tool": "local_ydb_prepare_auth_config", "arguments": { "profile": "ghcr261-auth", "confirm": false } }
{ "tool": "local_ydb_prepare_auth_config", "arguments": { "profile": "ghcr261-auth", "confirm": true } }
{ "tool": "local_ydb_write_dynamic_auth_config", "arguments": { "profile": "ghcr261-auth", "confirm": false } }
{ "tool": "local_ydb_write_dynamic_auth_config", "arguments": { "profile": "ghcr261-auth", "confirm": true } }
```

Expected:

- `prepare_auth_config` writes:
  `/tmp/local-ydb-auth/config.auth.yaml`
  `/tmp/local-ydb-auth/root.password`
- generated auth config includes:
  `enforce_user_token_requirement: true`
  `viewer_allowed_sids`
  `monitoring_allowed_sids`
  `administration_allowed_sids`
  `register_dynamic_node_allowed_sids`
- viewer/admin allowed SIDs include both `root` and `root@builtin`
- `write_dynamic_auth_config` writes:
  `StaffApiUserToken: "root@builtin"`
  `NodeRegistrationToken: "root@builtin"`

Avoid:

- assuming the viewer/admin SID is only `root@builtin`
- assuming the default root token identifies as `root@builtin`; in our run `whoami` reported `User SID: root`

## Scenario 8: Auth Rollout

Goal: turn a healthy clean stack into a working auth-enabled stack.

Profile:
`ghcr261-auth`

Calls:

```json
{ "tool": "local_ydb_apply_auth_hardening", "arguments": { "profile": "ghcr261-auth", "confirm": false } }
{ "tool": "local_ydb_apply_auth_hardening", "arguments": { "profile": "ghcr261-auth", "confirm": true } }
```

Expected:

- the reviewed config is copied into the static container
- dynamic node is stopped
- static node is restarted
- tenant status remains readable via password
- dynamic node is recreated with:
  `--auth-token-file /run/local-ydb/dynamic-node-auth.pb`
  sanitized dynamic config
  TLS disabled for local mode

Avoid:

- restarting a stale dynamic auth container without recreation
- using a hardcoded login URL on `8765` when the profile runs on another monitoring port

## Scenario 9: Post-Auth Verification

Goal: prove the auth rollout actually worked.

Profile:
`ghcr261-auth`

Calls:

```json
{ "tool": "local_ydb_auth_check", "arguments": { "profile": "ghcr261-auth" } }
{ "tool": "local_ydb_status_report", "arguments": { "profile": "ghcr261-auth" } }
{ "tool": "local_ydb_nodes_check", "arguments": { "profile": "ghcr261-auth" } }
{ "tool": "local_ydb_graphshard_check", "arguments": { "profile": "ghcr261-auth" } }
{ "tool": "local_ydb_database_status", "arguments": { "profile": "ghcr261-auth" } }
```

Expected:

- `auth_check.viewerWhoamiStatus == 401`
- authenticated tenant metadata still works
- `status_report` returns `tenant=ok`, `nodes=ok`
- `nodes_check` returns the dynamic node
- `graphshard_check` reports `GraphShardExists=true`
- `database_status` returns `State: RUNNING`

Avoid:

- treating a `401` on `/viewer/json/whoami` as an error after auth; it is the expected anonymous result

## Scenario 9A: Root Password Rotation

Goal: change the root password through one MCP tool without exposing it in plan output.

Profile:
`ghcr261-auth`

Calls:

```json
{ "tool": "local_ydb_set_root_password", "arguments": { "profile": "ghcr261-auth", "password": "<new-password>", "confirm": false } }
```

Expected:

- plan-only output does not print the raw password
- the tool rotates the runtime password with `ALTER USER`
- the generated host auth config and `root.password` file are updated after the runtime password change
- post-change anonymous `viewer/json/whoami` should still return `401`
- authenticated tenant checks should work with the new password

Avoid:

- storing the password directly in committed config
- changing the password on a profile that lacks `authConfigPath` or `rootPasswordFile`

## Scenario 10: Add Extra Dynamic Nodes

Goal: add multiple dynamic nodes to a healthy auth-enabled stack without creating extra profile entries.

Profile:
`ghcr261-auth`

Calls:

```json
{ "tool": "local_ydb_add_dynamic_nodes", "arguments": { "profile": "ghcr261-auth", "count": 2, "confirm": false } }
{ "tool": "local_ydb_add_dynamic_nodes", "arguments": { "profile": "ghcr261-auth", "count": 2, "confirm": true } }
{ "tool": "local_ydb_nodes_check", "arguments": { "profile": "ghcr261-auth" } }
{ "tool": "local_ydb_tenant_check", "arguments": { "profile": "ghcr261-auth" } }
{ "tool": "local_ydb_container_logs", "arguments": { "profile": "ghcr261-auth", "target": "dynamic", "lines": 80 } }
```

Expected:

- plan-only output creates `ydb-dyn-example-ghcr261-2` and `ydb-dyn-example-ghcr261-3`
- default ports are derived from the profile:
  `2258/9067/19303` and `2259/9068/19304`
- dynamic containers mount `/tmp/local-ydb-auth/dynamic-node-auth.pb` when auth is enabled
- `confirm=true` starts one node, verifies its IC port appears in `nodelist`, then starts the next
- `nodes_check` reports three dynamic nodes total after adding two extra nodes to the one-node baseline
- tenant metadata remains reachable

Avoid:

- using `startIndex: 1`; that conflicts with the profile's main dynamic container
- adding many nodes at once on a live auth stack without first checking logs and `nodelist`

Rollback:

```bash
docker rm -f ydb-dyn-example-ghcr261-2 ydb-dyn-example-ghcr261-3
```

## Scenario 11: Remove Extra Dynamic Nodes

Goal: remove one or more extra dynamic nodes from a healthy stack without touching the base dynamic node.

Profile:
`ghcr261-auth`

Calls:

```json
{ "tool": "local_ydb_remove_dynamic_nodes", "arguments": { "profile": "ghcr261-auth", "confirm": false } }
{ "tool": "local_ydb_remove_dynamic_nodes", "arguments": { "profile": "ghcr261-auth", "confirm": true } }
{ "tool": "local_ydb_nodes_check", "arguments": { "profile": "ghcr261-auth" } }
```

Expected:

- plan-only output targets the highest-index extra node first, such as `ydb-dyn-example-ghcr261-3`
- `confirm=true` removes that container and verifies its IC port disappears from authenticated `nodelist`
- the base dynamic node `ydb-dyn-example-ghcr261` remains running
- tenant metadata remains reachable after removal

Optional explicit targeting:

```json
{ "tool": "local_ydb_remove_dynamic_nodes", "arguments": { "profile": "ghcr261-auth", "confirm": false, "containers": ["ydb-dyn-example-ghcr261-2"] } }
{ "tool": "local_ydb_remove_dynamic_nodes", "arguments": { "profile": "ghcr261-auth", "confirm": false, "nodeIds": [50001] } }
```

Avoid:

- treating the profile's main `dynamicContainer` as removable through this tool
- using `nodeIds` for the base dynamic node; only IDs that resolve to extra dynamic-node containers are removable
- removing multiple extra nodes at once on a live stack without checking `nodelist` after each removal

## Scenario 12: Add Storage Groups

Goal: increase `NumGroups` for a tenant storage pool by rereading and redefining the current pool shape.

Profile:
`ghcr261-auth`

Calls:

```json
{ "tool": "local_ydb_add_storage_groups", "arguments": { "profile": "ghcr261-auth", "count": 1, "confirm": false } }
{ "tool": "local_ydb_add_storage_groups", "arguments": { "profile": "ghcr261-auth", "count": 1, "confirm": true } }
{ "tool": "local_ydb_storage_placement", "arguments": { "profile": "ghcr261-auth" } }
{ "tool": "local_ydb_tenant_check", "arguments": { "profile": "ghcr261-auth" } }
```

Expected:

- plan-only output targets tenant pool `/local/example:hdd`
- the generated `DefineStoragePool` request preserves the current pool fields and increases only `NumGroups`
- `confirm=true` succeeds without breaking tenant metadata
- post-change `ReadStoragePool` reports a higher `NumGroups` for the tenant pool
- `QueryBaseConfig` reflects the updated group set on the current PDisk layout

Avoid:

- treating `DecommitGroups` or `storage_units_to_remove` as a pool expansion path
- using a partial `DefineStoragePool` shape that drops `PDiskFilter`, `ScopeId`, or `ItemConfigGeneration`

## Scenario 13: Destroy Stack

Goal: remove tenant metadata, local-ydb nodes, Docker network, and profile storage from one tool.

Recommended disposable profile:
`ghcr-rebuild-clean`

Calls:

```json
{ "tool": "local_ydb_destroy_stack", "arguments": { "profile": "ghcr-rebuild-clean", "confirm": false } }
```

Optional shared-host-path cleanup:

```json
{ "tool": "local_ydb_destroy_stack", "arguments": { "profile": "ghcr-rebuild-clean", "confirm": false, "removeDumpHostPath": true, "removeAuthArtifacts": true } }
```

Expected:

- plan-only output removes tenant metadata first when the static node is reachable
- extra dynamic nodes are removed before the profile's main dynamic container
- the static container, Docker network, and Docker volume are removed
- bind-mounted data is not deleted unless `removeBindMountPath: true`
- auth files and dump directories are not deleted unless explicitly requested

Avoid:

- enabling host-path deletion flags on shared paths without checking whether other profiles use them
- using this tool with `confirm=true` on a profile you still need without first taking a dump

## Scenario 14: Reduce Storage Groups By Rebuild

Goal: reduce a tenant pool from a larger `NumGroups` back to a smaller one without relying on an unverified live shrink path.

Profile:
`ghcr261-auth`

Calls:

```json
{ "tool": "local_ydb_reduce_storage_groups", "arguments": { "profile": "ghcr261-auth", "count": 1, "dumpName": "shrink-smoke", "confirm": false } }
```

Expected:

- plan-only output starts with a tenant dump
- the stack is rebuilt with `admin database /local/example create hdd:1`
- auth-enabled profiles re-run:
  `local_ydb_prepare_auth_config`
  `local_ydb_write_dynamic_auth_config`
  `local_ydb_apply_auth_hardening`
- extra dynamic-node suffixes are re-added after restore/auth reapply

Avoid:

- treating `DefineStoragePool { NumGroups: smaller }` as a proven live shrink path
- deleting auth artifacts during the rebuild path for an auth-enabled profile

## Scenario 15: Cleanup Candidates

Goal: test the dangerous cleanup tool only on disposable targets.

Recommended disposable targets:

- stale rehearsal volumes discovered by `storage_leftovers`
- old test dump directories under `/tmp/local-ydb-dump/...`
- explicitly unused side-by-side rehearsal volumes such as `ydb-local-data-ghcr-clean` only after you have decided they are no longer needed

Calls:

```json
{ "tool": "local_ydb_storage_leftovers", "arguments": { "profile": "ghcr261-auth" } }
{ "tool": "local_ydb_cleanup_storage", "arguments": { "profile": "ghcr261-auth", "confirm": false, "volumes": ["<known-disposable-volume>"] } }
{ "tool": "local_ydb_cleanup_storage", "arguments": { "profile": "ghcr261-auth", "confirm": false, "paths": ["/tmp/local-ydb-dump/<known-disposable-dump>"] } }
```

Expected:

- plan-only output includes the exact `docker volume rm` or `rm -rf` target
- unsafe targets like `/tmp`, `/var/lib/docker`, or unrelated names are rejected by validation

Avoid:

- using `cleanup_storage(confirm=true)` against any active profile volume or the current auth stack

## Scenario 14A: Version Upgrade By Rebuild

Goal: upgrade a working profile to a specific image tag without reusing the old volume in place.

Profile:
`ghcr261-auth`

Calls:

```json
{ "tool": "local_ydb_upgrade_version", "arguments": { "profile": "ghcr261-auth", "version": "26.1.1.6", "confirm": false } }
```

Optional execution path on a disposable stack:

```json
{ "tool": "local_ydb_upgrade_version", "arguments": { "profile": "ghcr261-auth", "version": "<target-tag>", "dumpName": "upgrade-smoke", "confirm": true } }
```

Expected:

- the plan starts with source and target image preflight checks
- if either image is missing, run `local_ydb_pull_image` first and retry after `local_ydb_pull_status` reports completion
- after image preflight, the upgrade path performs dump, destroy, bootstrap, restore, auth reapply, and extra dynamic-node recreation in that order
- auth-enabled profiles re-run:
  `local_ydb_prepare_auth_config`
  `local_ydb_write_dynamic_auth_config`
  `local_ydb_apply_auth_hardening`
- final verification checks tenant metadata, the recreated containers' image tags, and persists `profiles.<name>.image` in the file-backed config

Avoid:

- using this tool against a profile pinned by image digest
- using this tool against a profile with `bindMountPath`; automatic version upgrade only supports volume-backed rebuilds
- treating it as an in-place rolling upgrade of the existing volume
- skipping the explicit target tag check from `local_ydb_list_versions`

## Coverage Matrix

- Bootstrap and lifecycle:
  `local_ydb_bootstrap_root_database`, `local_ydb_bootstrap`, `local_ydb_create_tenant`, `local_ydb_start_dynamic_node`, `local_ydb_add_dynamic_nodes`, `local_ydb_remove_dynamic_nodes`, `local_ydb_restart_stack`
- Version discovery:
  `local_ydb_list_versions`
- Image pulls:
  `local_ydb_pull_image`, `local_ydb_pull_status`
- Storage-pool expansion:
  `local_ydb_add_storage_groups`
- Storage-pool reduction by rebuild:
  `local_ydb_reduce_storage_groups`
- Version upgrade by rebuild:
  `local_ydb_upgrade_version`
- Full teardown:
  `local_ydb_destroy_stack`
- Backup and restore:
  `local_ydb_dump_tenant`, `local_ydb_restore_tenant`
- Auth rollout:
  `local_ydb_prepare_auth_config`, `local_ydb_write_dynamic_auth_config`, `local_ydb_apply_auth_hardening`, `local_ydb_set_root_password`, `local_ydb_permissions`, `local_ydb_auth_check`
- Read-only diagnostics:
  `local_ydb_inventory`, `local_ydb_database_status`, `local_ydb_container_logs`, `local_ydb_status_report`, `local_ydb_tenant_check`, `local_ydb_scheme`, `local_ydb_permissions`, `local_ydb_nodes_check`, `local_ydb_graphshard_check`, `local_ydb_storage_placement`, `local_ydb_storage_leftovers`
- Cleanup:
  `local_ydb_cleanup_storage`

## Known Working Baseline

Field-proven successful stack in this repo:

- image: `ghcr.io/ydb-platform/local-ydb:26.1.1.6`
- clean profile: `ghcr261-clean`
- auth profile: `ghcr261-auth`
- dump name used successfully: `pre-auth-mcp-20260425`
- auth files:
  `/tmp/local-ydb-auth/config.auth.yaml`
  `/tmp/local-ydb-auth/root.password`
  `/tmp/local-ydb-auth/dynamic-node-auth.pb`

Successful end state:

- anonymous `viewer/json/whoami` returns `401`
- authenticated `scheme ls /local/example` succeeds
- authenticated `nodelist` returns the dynamic node
- authenticated `capabilities` reports `GraphShardExists=true`
