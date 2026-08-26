# local-ydb-toolkit

[![Website](https://img.shields.io/badge/Website-local--ydb--toolkit-0f766e)](https://local-ydb-toolkit.ydb-qdrant.tech/)
[![Official MCP Registry](https://img.shields.io/badge/Official%20MCP%20Registry-active-16a34a)](https://registry.modelcontextprotocol.io/?q=io.github.astandrik%2Flocal-ydb-mcp)
[![ModelScope MCP Plaza](https://img.shields.io/badge/ModelScope-MCP%20Plaza-624AFF)](https://modelscope.cn/mcp/servers/astandrik/local-ydb-mcp)
[![npm package](https://img.shields.io/npm/v/@astandrik/local-ydb-mcp?label=npm%20%40astandrik%2Flocal-ydb-mcp)](https://www.npmjs.com/package/@astandrik/local-ydb-mcp)
[![GitHub Action: setup-local-ydb](https://img.shields.io/badge/GitHub%20Action-setup--local--ydb-2088FF?logo=githubactions&logoColor=white)](https://github.com/astandrik/setup-local-ydb)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-setup--local--ydb-blue?logo=github)](https://github.com/marketplace/actions/setup-local-ydb)

Toolkit for operating `local-ydb` deployments across Codex, MCP clients, and GitHub Actions CI.

Website: [local-ydb-toolkit.ydb-qdrant.tech](https://local-ydb-toolkit.ydb-qdrant.tech/).

[Security policy](SECURITY.md) — supported versions, private vulnerability reporting, and the local process trust boundary.

[Privacy policy](https://local-ydb-toolkit.ydb-qdrant.tech/privacy) — data handling for the website and public skills-only package. For support, use [GitHub Issues](https://github.com/astandrik/local-ydb-toolkit/issues) and do not include credentials or other sensitive data.

It includes:

- a reusable Codex skill for local and SSH `local-ydb` operations;
- an unofficial local stdio MCP server published as `@astandrik/local-ydb-mcp`;
- a Marketplace GitHub Action, [`astandrik/setup-local-ydb`](https://github.com/astandrik/setup-local-ydb), for booting disposable YDB tenants in CI.

## Discovery and trust

The maintained listing hub, including third-party directory status and freshness notes, is on the [project website](https://local-ydb-toolkit.ydb-qdrant.tech/#mcp-registries). External scores, tool counts, and install metrics are directory snapshots, not security attestations.

## Relationship to `ydb/ydb-mcp`

Local YDB MCP is complementary to the official [`ydb-platform/ydb-mcp`](https://github.com/ydb-platform/ydb-mcp) server. Use `ydb/ydb-mcp` when an agent needs general YDB database-level tools such as ad hoc SQL queries, query explanations, directory listing, and path inspection against an existing YDB endpoint.

Use this toolkit when the agent needs to operate Docker-based `local-ydb` environments themselves: host prerequisite checks, root or tenant bootstrap, dynamic-node lifecycle, GraphShard checks, table DDL generation/validation/application for local deployments, auth hardening, storage workflows, dump/restore, and version upgrades. Its `local_ydb_sql` tool is deliberately narrower than `ydb/ydb-mcp`: it runs managed YQL only against the selected configured local-ydb profile. Mutating MCP tools are plan-first: read the one-time token from the plan response's `confirmation.token`, then repeat the exact request with `confirm: true` and that value in the `confirmationToken` request argument.

## Agent Plugin Quick Start

The repository is an Agent Plugins 1.0 package with a reusable `local-ydb` skill and the pinned local stdio MCP server. Add its repo marketplace and install the plugin with Codex:

```bash
codex plugin marketplace add astandrik/local-ydb-toolkit --ref main
codex plugin add local-ydb-toolkit@local-ydb-toolkit
```

Start a new Codex session after installation so the bundled skill and MCP server are loaded. The MCP launcher requires Node.js 20.19 or newer plus `npx`; its first start can access the npm registry to install the pinned `@astandrik/local-ydb-mcp@0.18.2` package.

Agent Plugins start a stdio server with the installed plugin root as its working directory. Use an absolute `configPath` on profile-based tool calls, or set `LOCAL_YDB_TOOLKIT_CONFIG` to an absolute path in the MCP client environment. An explicit path must name a readable regular JSON file no larger than 1 MiB; missing or invalid explicit files fail closed instead of selecting the default profile. Do not rely on a project-local `local-ydb.config.json` being discovered from the caller's repository.

The public OpenAI submission artifact is deliberately skills-only because public MCP-backed submissions require a production HTTPS MCP server. Local Docker/YDB operations remain in the repo-marketplace plugin and the npm stdio package.

## Claude Code Plugin

The repository also contains a Claude Code plugin manifest. Claude discovers the existing `skills/` directory and pinned `.mcp.json` server from their default plugin-root locations. Before the Claude Community review is complete, test the repository directly with a current Claude Code release:

```bash
claude plugin validate .
claude --plugin-dir .
```

The Claude Community submission is pending review and is not described as publicly installable until it appears in the community catalog. The same Node.js, absolute `configPath`, `LOCAL_YDB_TOOLKIT_CONFIG`, and exact-plan confirmation requirements apply.

## Gemini CLI / Antigravity Plugin

The root `gemini-extension.json` adapts the same `skills/local-ydb` skill and pinned local stdio MCP server for Gemini CLI extensions. Install the repository directly:

```bash
gemini extensions install https://github.com/astandrik/local-ydb-toolkit --ref=main --auto-update
```

Gemini CLI prompts for optional extension settings during installation. Set `LOCAL_YDB_TOOLKIT_CONFIG` to an absolute config path, or leave it blank and pass an absolute `configPath` on profile-based tool calls. `LOCAL_YDB_MCP_CONTENT_FORMAT` may be left blank for JSON or set to `toon`. The MCP launcher requires Node.js 20.19 or newer plus `npx`, and a new session is required after installation.

Google routes consumer Gemini CLI users through Antigravity CLI. Its supported migration command converts installed Gemini extensions, including bundled skills and MCP configuration, into native Antigravity plugins:

```bash
agy plugin import gemini
```

The migration utility searches the legacy Gemini extension directories, so its reported results can include other installed extensions as well.

The repository is not listed in the Gemini extension gallery until the owner adds the `gemini-cli-extension` GitHub topic and the daily crawler accepts the manifest. Direct installation and local validation do not imply gallery publication.

## Codex Skill Quick Start

The easiest install path for Codex is to ask Codex to install the skill from this repository:

```text
$skill-installer install https://github.com/astandrik/local-ydb-toolkit/tree/main/skills/local-ydb
```

Restart Codex if the skill does not appear immediately.

Manual fallback for Codex:

```bash
git clone https://github.com/astandrik/local-ydb-toolkit.git
cd local-ydb-toolkit
SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$SKILLS_DIR"
cp -R skills/local-ydb "$SKILLS_DIR/local-ydb"
```

## Use in GitHub Actions CI

Use [`astandrik/setup-local-ydb`](https://github.com/astandrik/setup-local-ydb) when a GitHub Actions job needs an ephemeral local YDB tenant:

```yaml
- uses: astandrik/setup-local-ydb@v1
  id: ydb
  with:
    version: 26.1.1.6
    tenant: /local/test

- run: |
    echo "$LOCAL_YDB_ENDPOINT"
    echo "$LOCAL_YDB_DATABASE"
```

The action starts `ghcr.io/ydb-platform/local-ydb`, creates the tenant database, waits for readiness, optionally enables native YDB auth, and exports `LOCAL_YDB_ENDPOINT`, `LOCAL_YDB_DATABASE`, and `LOCAL_YDB_MONITORING_URL` for later workflow steps. Add `auth: true` when tests need authenticated YDB behavior; in that mode it also exports `LOCAL_YDB_USER` and `LOCAL_YDB_PASSWORD_FILE` without exposing the raw password value.

This repository dogfoods the Marketplace action in CI. `.github/workflows/setup-local-ydb-smoke.yml` keeps a short action-level smoke test, while `.github/workflows/local-ydb-mcp-integration.yml` starts the real stdio MCP server and verifies prompts, read-only tools, schema DDL apply, the managed SQL query/explain/execute safety matrix, plan-only behavior, path-level dump/list/restore with restore hooks, and a confirmed dynamic-node add/remove against a live YDB tenant. The concise GitHub Developer Program artifact is in `docs/github-developer-program.md`.

## Skill Contents

```text
skills/local-ydb/
  SKILL.md
  agents/openai.yaml
  references/
    auth-hardening.md
    history-and-non-goals.md
    storage-migration.md
    topology.md
    verification.md
  scripts/
  assets/
```

The skill covers reusable operational guidance for:

- Docker-based `local-ydb` topologies using `ghcr.io/ydb-platform/local-ydb`
- CMS-created tenants and GraphShard behavior
- dynamic nodes and mandatory-auth node registration
- YDB native auth hardening and monitoring exposure
- storage pools, BSC placement checks, PDisks, dump/restore, and rebuild workflows
- upstream `ydb-platform/ydb` source lookup through `gh api`

The skill intentionally avoids private hostnames, IPs, user-specific paths, passwords, tokens, backup paths, and app-specific deployment details. Public examples use placeholders such as `/local/<tenant>`, `/path/to/root.password`, `<host>`, and `<public-domain>`.

## Node.js MCP Server

This repository also contains an unofficial local stdio MCP server for operating `local-ydb` targets. The MCP server itself runs locally; tools operate either on the local Docker host or over SSH to a named remote profile.

Official MCP Registry metadata is prepared in `server.json` under the name `io.github.astandrik/local-ydb-mcp`. This remains a local stdio server, not a remote MCP endpoint.

<!-- BEGIN GENERATED MCP TOOLS -->
## Tools

The server exposes 39 tools. This index is generated from the runtime tool registry; edit `toolDefinitions` and run `npm run docs:generate` to update it.

### Checks

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_inventory` | read-only | Read-only Docker inventory for a local-ydb target profile. Success returns ok=true, Docker CLI/daemon state, containers, volumes, and inspect data for configured containers that actually exist; Docker CLI, daemon, or inventory failures return ok=false with a reason and omit inventory arrays so failure cannot be mistaken for an empty host. SSH target or probe failures use docker-inventory-failed with conservative Docker availability flags. |
| `local_ydb_database_status` | read-only | Read-only YDB admin database status for the configured tenant path. Returns the command, stdout, stderr, and ok flag; use this for tenant state before bootstrap/restart troubleshooting, and use local_ydb_tenant_check for scheme reachability. |
| `local_ydb_healthcheck` | read-only | Read-only YDB monitoring healthcheck for the configured tenant or root database. Uses the official YDB CLI SelfCheck path, returns selfCheckResult, issue counts, issue types, capped raw output, and whether the database is healthy; a requested noCache/noMerge option rejected with the exact recognized two-line legacy parser signature is reported through optionResolution and warnings, while compatibilityFallback says whether a retry actually started. Use after local_ydb_status_report for database-level diagnostics. |
| `local_ydb_container_logs` | read-only | Read recent Docker logs from the configured static or primary dynamic local-ydb container. Use when bootstrap, restart, or readiness checks fail; target selects the container role and lines controls the tail length. |
| `local_ydb_status_report` | read-only | Read-only aggregate report for quick diagnosis. Runs local_ydb_inventory, local_ydb_auth_check, local_ydb_tenant_check, local_ydb_nodes_check, and local_ydb_healthcheck, returning each result; every component is isolated so an unexpected failure produces a safe component-shaped fallback and does not stop the remaining checks. |
| `local_ydb_tenant_check` | read-only | Read-only check that uses the YDB CLI to verify the configured tenant path is reachable. Use after bootstrap or restore to confirm tenant metadata before node or GraphShard checks. |
| `local_ydb_scheme` | read-only | Read-only YDB scheme list or describe with capped stdout/stderr. It uses the root database for rootDatabase paths and the tenant database otherwise; list supports recursive/long/onePerLine flags, describe supports stats, and incompatible flag combinations are rejected. |
| `local_ydb_nodes_check` | read-only | Read-only check of dynamic node registration through viewer/json nodelist. Use after starting, adding, or removing dynamic nodes; use local_ydb_tenant_check first when tenant reachability is unknown. |
| `local_ydb_graphshard_check` | read-only | Read-only GraphShard check through viewer/json capabilities and tabletinfo for the configured tenant. Returns graphShardExists, tablet ids, and viewer status details; use after tenant bootstrap when GraphShard support or tablet visibility is the specific question. |
| `local_ydb_auth_check` | read-only | Read-only auth audit that checks anonymous viewer whoami status and configured YDB CLI tenant access, using root credentials when rootPasswordFile is configured. Use after auth hardening or password rotation to verify the expected posture. |
| `local_ydb_storage_placement` | read-only | Read-only storage inspection that returns ReadStoragePool output and BSC physical placement. Use before adding or reducing storage groups to confirm the exact pool shape. |
| `local_ydb_storage_leftovers` | read-only | Read-only search for candidate leftover local-ydb Docker volumes, dumps, and PDisk/data paths. It scans Docker volume names plus profile.storageSearchPaths and deletes nothing; use before local_ydb_cleanup_storage to decide exact paths or volumes to remove. |
| `local_ydb_list_versions` | read-only | List published GHCR or Docker Hub tags for a local-ydb container image, with numeric version tags sorted newest first. Use before local_ydb_upgrade_version; registry pagination and authentication are restricted to trusted origins, and pageSize and maxPages bound pagination. |
| `local_ydb_pull_status` | read-only | Check the status of a background Docker image pull started by local_ydb_pull_image. For known jobs it returns a monotonic progressPercent based on completed known Docker layers rather than bytes: 0-99 while running, 100 after successful completion, and the last observed value after failure. |

### Schema

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_generate_schema` | read-only | Read-only structured YDB table DDL generator. It renders strict JSON specs for CREATE TABLE, ALTER TABLE, DROP TABLE, and secondary indexes, returns the generated script with official references and warnings, and can optionally validate through the YDB JS SDK without applying changes. |
| `local_ydb_apply_schema` | plan-first mutation | Validate or apply YDB table DDL through the official YDB JS SDK. It accepts raw YQL DDL for PRAGMA plus CREATE TABLE, ALTER TABLE, and DROP TABLE; action=apply validates first and executes only with confirm=true. |

### Sql

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_sql` | plan-first mutation | Run managed YQL v1 against the configured local-ydb target through Query Service. query uses SnapshotRO, explain returns plan/AST, and execute always runs EXPLAIN first and sends one NoTx execution only with confirm=true. A submitted token is retired when the repeated EXPLAIN fails. |

### Auth

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_permissions` | plan-first mutation | Inspect or change YDB scheme permissions for a path. The default list action is read-only; grant, revoke, set, clear, chown, and inheritance changes return a plan unless confirm=true. |
| `local_ydb_prepare_auth_config` | plan-first mutation | Generate a hardened YDB config from the current static-node config. Use before local_ydb_write_dynamic_auth_config and local_ydb_apply_auth_hardening; without confirm=true this returns the planned write only. |
| `local_ydb_write_dynamic_auth_config` | plan-first mutation | Write the text-proto dynamic-node auth token file needed for mandatory-auth startup. Use after choosing the SID for auth hardening; without confirm=true this returns the planned file write only. |
| `local_ydb_apply_auth_hardening` | plan-first mutation | Apply a reviewed hardened YDB config file only after a full check-only static profile and configured-binding compatibility preflight succeeds before any config or container mutation; immutable mismatches require destroy followed by bootstrap. It then restarts the static node and recreates and verifies every configured dynamic node in index order even when no dynamic-node token file is configured. Exact-container running stability and IC registration must both pass before metadata verification, and rollback uses restart or bootstrap reconciliation after restoring the static config. Use only after preparing and reviewing the config; without confirm=true this returns the preflight/apply/recreate plan only. |
| `local_ydb_set_root_password` | plan-first mutation | Rotate the runtime root password with ALTER USER and sync the host auth config and root password file to match. YDB may reject passwords that violate auth_config.password_complexity; this tool requires a non-empty password value. |

### Storage

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_add_storage_groups` | plan-first mutation | Increase NumGroups for one tenant storage pool using the current ReadStoragePool definition. Without confirm=true this returns the DefineStoragePool plan, rollback, target pool, and target count; when the update succeeds it verifies NumGroups and tenant metadata. |
| `local_ydb_reduce_storage_groups` | plan-first mutation | Reduce NumGroups for a tenant storage pool by dumping the tenant, rebuilding the profile stack with a smaller storagePoolCount, restoring the dump, and reapplying auth when needed. Before dump or destroy, it inspects every one-off dynamic node and preserves its exact gRPC, monitoring, and IC ports; an incomplete definition aborts the rebuild. |
| `local_ydb_cleanup_storage` | plan-first mutation | Delete only the explicitly supplied local-ydb host paths or Docker volumes. Use after inspecting local_ydb_storage_leftovers; without confirm=true this returns the cleanup plan and removes nothing. |

### Lifecycle

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_pull_image` | plan-first mutation | Plan or start a background Docker pull for a local-ydb image on the selected target. Without confirm=true it returns inspect and pull commands only; with confirm=true it returns a jobId for local_ydb_pull_status unless the image is already present. |
| `local_ydb_destroy_stack` | plan-first mutation | Remove tenant metadata, local-ydb containers, network, and storage for a profile, with optional host-path cleanup. Before returning or executing a standalone plan, every discovered extra dynamic node is bound to its exact inspected Docker container ID; an unavailable identity aborts planning, while a same-name replacement after confirmation is rejected and preserved. |
| `local_ydb_bootstrap_root_database` | plan-first mutation | Bootstrap a plain local YDB database at /local with only a static node. Use for generic local database requests that do not need a CMS tenant, GraphShard, or dynamic nodes; an existing running or stopped static container is reused only when its image, network, data mount, complete port bindings, required environment, restart policy, and disabled healthcheck match the profile. Without confirm=true this returns the plan without executing it. |
| `local_ydb_bootstrap` | plan-first mutation | Bootstrap a tenant topology: static node with GraphShard flags and loopback bindings for static plus every configured dynamic gRPC port, configured CMS tenant, and all dynamic nodes declared by profile.dynamicNodeCount. Before returning or executing a plan, configured container names must be distinct from the static container and all shared-network ports must be valid and unique. Nodes start in index order; before the next node starts, readiness requires the exact Docker container to be running, not restarting, stable by container ID and RestartCount across two checks, and registered by its IC port in viewer/json nodelist. An existing running or stopped static container is reused only after the full profile compatibility check, including every configured gRPC binding. Use only for tenant, GraphShard, dump/restore, or dynamic-node scenarios; without confirm=true this returns the full plan and creates nothing. |
| `local_ydb_check_prerequisites` | plan-first mutation | Check target-host prerequisites for the Docker CLI and daemon, curl, ruby, and the configured rootPasswordFile when present. An unreachable SSH target returns unavailable=[target] without claiming tools are missing or proposing installation. Without confirm=true it returns the current snapshot and any apt-get plan; confirm=true may install only supported curl/ruby packages, then returns a refreshed post-install snapshot, and never starts or installs Docker. |
| `local_ydb_create_tenant` | plan-first mutation | Create the configured CMS tenant when the static node is already running. Use before local_ydb_start_dynamic_node for tenant topologies; without confirm=true this returns the planned status/create command and creates nothing. |
| `local_ydb_start_dynamic_node` | plan-first mutation | Start the configured primary dynamic tenant node for an existing CMS tenant. Before returning or executing a plan, it rejects a primary name that aliases the static container and ports that collide in the shared network namespace, including static IC port 19001. After checking that the image is present, it runs the full check-only static compatibility preflight, including the current image ID, immediately before the dynamic container start; a mismatch fails closed and requires destroy followed by bootstrap. The dynamic container is created but not started until its resolved image ID matches the static container, closing a concurrent named-tag refresh race. Use after local_ydb_create_tenant or when admin status is PENDING_RESOURCES; use local_ydb_add_dynamic_nodes for extra nodes. Without confirm=true this returns a plan only. |
| `local_ydb_restart_stack` | plan-first mutation | Reconcile and restart the selected profile after inventory and a full check-only static compatibility preflight. Before stopping any container, require the existing static container to match the profile image, network, data mount, environment, restart policy, healthcheck, and exact loopback bindings for static gRPC, monitoring, and every configured dynamic gRPC port; configured binding changes require destroy followed by bootstrap. Then report missing configured and unexpected one-off dynamic containers, stop running dynamic containers before static, unconditionally recreate every configured node in index order including containers observed restarting, require each exact Docker container to be stably running plus registered by IC port, and restore only previously running unexpected containers without removing them. Each running unexpected container is bound to its full inspected Docker ID for both stop and recovery; a same-name replacement is rejected and left untouched. Because removed configured definitions cannot be recovered from inventory, rollback uses restart or bootstrap reconciliation. Without confirm=true this returns the restart plan only. |
| `local_ydb_upgrade_version` | plan-first mutation | Upgrade a file-backed, volume-backed local-ydb profile to a target image tag. Use only for version upgrades on profiles without bindMountPath; before dump or destroy it inspects every one-off dynamic node and preserves its exact gRPC, monitoring, and IC ports, aborting on an incomplete definition. The plan also binds the target tag to its resolved Docker image ID, rechecks it immediately before teardown, creates the replacement static container stopped and verifies its image ID before start, and verifies final container image IDs as well as tags. It then dumps, rebuilds, restores, regenerates auth artifacts in a private workspace when configured, and recreates extra nodes from those private bytes. The config is never updated automatically: after independent verification, set profiles.<name>.image manually. A verified mismatch leaves the profile unchanged; unavailable final inventory requires independent verification before that manual update. |

### Dynamic Nodes

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_add_dynamic_nodes` | plan-first mutation | Add one-off dynamic tenant nodes beyond the declarative profile.dynamicNodeCount topology, one at a time. By default the first suffix is dynamicNodeCount + 1; an explicit startIndex must be greater than dynamicNodeCount, and port overrides remain available. Every planned name must be distinct from the static container and all configured plus one-off ports must be valid and unique in the shared network namespace. After each image-presence check, it repeats the full check-only static compatibility preflight, including the current image ID, immediately before each node start; a mismatch stops that node and all later nodes and requires destroy followed by bootstrap. Each dynamic container is created but not started until its resolved image ID matches the static container, closing a concurrent named-tag refresh race. Without confirm=true it returns container/port plans; with confirm=true each node must have a stable running exact Docker container and its IC port in viewer/json nodelist before tenant metadata is checked. |
| `local_ydb_remove_dynamic_nodes` | plan-first mutation | Remove dynamic tenant suffix nodes one at a time, binding the plan and execution to each inspected Docker container ID, and verify nodelist disappearance when the node IC port can be resolved. A same-name replacement is rejected and is never removed by the old plan. Without containers, nodeIds, or startIndex, only one-off suffixes above profile.dynamicNodeCount are eligible and the highest suffix is removed first. Explicit selectors or startIndex may remove a configured suffix and create drift that bootstrap or restart restores. Rollback guidance uses bootstrap/restart for configured nodes and add_dynamic_nodes with matching suffixes and ports for one-off nodes. The primary dynamicContainer is always protected. |

### Backup Restore

| Tool | Mode | Description |
| --- | --- | --- |
| `local_ydb_list_dumps` | read-only | Read-only list of available tenant dumps under profile.dumpHostPath. Use before restore to choose a dumpName; it only reports top-level dump directories that contain the existing tenant dump folder. |
| `local_ydb_dump_tenant` | plan-first mutation | Dump the configured tenant or a tenant-relative path using a local-ydb helper container on the static container network. It creates profile.dumpHostPath/dumpName, excludes .sys objects, writes the dump under dumpName/tenant, and without confirm=true returns the mkdir/helper-container plan only. |
| `local_ydb_restore_tenant` | plan-first mutation | Restore the configured tenant or destination path from a dump under profile.dumpHostPath, with optional post-restore scheme describe and bounded count-query verification. Use after bootstrap or rebuild when the target tenant is ready; without confirm=true this returns the restore plan and does not write data. |

<!-- END GENERATED MCP TOOLS -->

The npm package requires Node.js 20.19 or newer.

Use the npm package directly from an MCP client:

```json
{
  "mcpServers": {
    "local-ydb": {
      "command": "npx",
      "args": ["-y", "--prefer-online", "@astandrik/local-ydb-mcp@latest"],
      "env": {
        "LOCAL_YDB_TOOLKIT_CONFIG": "/path/to/local-ydb.config.json",
        "LOCAL_YDB_MCP_CONTENT_FORMAT": "toon"
      }
    }
  }
}
```

This form checks the npm registry when the MCP server starts, so clients pick up newly published versions after restarting the MCP client.

Or install the command globally:

```bash
npm install -g @astandrik/local-ydb-mcp
```

```json
{
  "mcpServers": {
    "local-ydb": {
      "command": "local-ydb-mcp",
      "env": {
        "LOCAL_YDB_TOOLKIT_CONFIG": "/path/to/local-ydb.config.json",
        "LOCAL_YDB_MCP_CONTENT_FORMAT": "toon"
      }
    }
  }
}
```

For development from a checkout:

```bash
npm install
npm run build
```

Example MCP client config for a local checkout:

```json
{
  "mcpServers": {
    "local-ydb": {
      "command": "node",
      "args": ["/path/to/local-ydb-toolkit/packages/mcp-server/dist/index.js"],
      "env": {
        "LOCAL_YDB_TOOLKIT_CONFIG": "/path/to/local-ydb.config.json",
        "LOCAL_YDB_MCP_CONTENT_FORMAT": "toon"
      }
    }
  }
}
```

`LOCAL_YDB_MCP_CONTENT_FORMAT` is optional. Use `toon` to prefer TOON for the LLM-facing text content block while keeping MCP JSON-RPC and `structuredContent` as JSON; omit it or set `json` for the default pretty JSON text. If a payload cannot be represented as lossless, decodable TOON, the server falls back to pretty JSON for that text block.

Start from `examples/local-ydb.config.example.json` and keep private hosts, SSH keys, password files, and backup paths outside committed config.

Explicit configuration through `configPath` or `LOCAL_YDB_TOOLKIT_CONFIG` supports arbitrary absolute files. A present but empty environment value is still explicit and is rejected. The file must exist, be a readable regular file no larger than 1 MiB, match the strict configuration schema, and name an existing `profiles` entry in `defaultProfile`. Only an absent implicit `local-ydb.config.json` in the server's current working directory falls back to the built-in default profile; explicit configuration errors never do. Configuration errors expose a stable code without echoing file contents, parser snippets, or the absolute path.

### MCP Features

The MCP server exposes tools for local-ydb operations and prompts for guided
workflows. Prompt templates cover stack diagnosis, root database bootstrap,
database diagnostics, tenant topology bootstrap, schema generation/apply,
version upgrades, auth hardening, and storage group reduction. Prompts do not execute commands; they
return workflow instructions that guide the MCP client toward the existing
`local_ydb_*` tools. When supplied to a prompt, `configPath` must be an absolute
path, matching the tool-call contract.

Mutating tools remain plan-only until the plan response's `confirmation.token` is copied into the `confirmationToken` request argument and the exact request is repeated with `confirm: true`. Static MCP
resources are intentionally left for a separate follow-up so the server does not
expose private target configuration as context.

### Target Profiles

Profiles are selected by tool argument:

```json
{
  "profile": "remote-demo"
}
```

If omitted, the server uses `defaultProfile`. A profile can use:

- `mode: "local"` for commands on the local Docker host;
- `mode: "ssh"` for commands executed through `ssh -o BatchMode=yes -o ConnectTimeout=10`.

Tenant profiles may set `dynamicNodeCount` to the total number of declarative dynamic nodes, including the primary node. The value defaults to `1` and accepts `1..11`; root-only bootstrap ignores it. Node 1 uses `dynamicContainer` and the base `dynamicGrpc`, `dynamicMonitoring`, and `dynamicIc` ports. Nodes 2..N use `<dynamicContainer>-<index>` and each base port plus `index - 1`. All dynamic processes share the static container's network namespace, where the static node reserves IC port `19001`, so the complete configured topology must use distinct valid gRPC, monitoring, and IC ports that do not collide with that port. Tenant bootstrap publishes static gRPC and every configured dynamic gRPC port on loopback through the static container; one-off nodes do not change those immutable bindings.

SSH profiles use existing SSH agent/key/known_hosts configuration. The toolkit does not store SSH passwords.
On Linux Docker Engine, SDK-backed tools such as `local_ydb_sql` and `local_ydb_apply_schema` can reach gRPC ports that remain Docker-internal: the toolkit inspects the selected container, resolves its IPv4 address in `profile.network` (including a dynamic node using `network_mode=container:<static>`), and forwards the local SSH tunnel to that address. It verifies the tunnel with an authenticated YDB discovery request before sending the operation. Docker Desktop and rootless Docker fallbacks are not supported by this path; a target-resolution or readiness failure is reported with a fixed phase-specific diagnostic without exposing container addresses, SSH output, credentials, or paths.

### Operations

Read-only tools collect inventory, tenant state, YDB healthcheck/self-check output, schema objects, generated table DDL, schema permissions, node state, GraphShard state, auth posture, storage placement, leftover storage candidates, published `local-ydb` image tags, and background image-pull status.

`local_ydb_check_prerequisites` is the expected first step on a new host or profile. It reports the Docker CLI separately from Docker daemon reachability, along with `curl`, `ruby`, and auth-file prerequisites. Missing CLI/files and unavailable services are separate lists, and `ready=true` means every check is usable. An unreachable SSH target returns `ready=false`, `missing=[]`, and `unavailable=["target"]` without a package-install plan. With an accepted exact-plan confirmation, the tool can auto-install supported host helpers such as `curl` and `ruby` through `apt-get`, then reruns every prerequisite probe and returns that post-install snapshot; Docker installation and daemon startup remain manual.

`local_ydb_healthcheck` runs YDB's built-in `monitoring healthcheck --format json` against the configured tenant path by default. It returns `selfCheckResult`, whether the database is healthy, issue counts by status, issue types, capped raw stdout/stderr, and truncated `issue_log` entries. `noCache` and `noMerge` request the corresponding semantics; when an older CLI rejects either option with the recognized legacy parser signature, the tool records it in `optionResolution` and `warnings`. If the shared deadline still permits, the tool may retry after dropping only the rejected option; `compatibilityFallback` indicates whether such a retry actually started. Do not describe the result as fresh or unmerged unless the requested option remains in `optionResolution.effective`. Use it after `local_ydb_status_report` for database-level diagnostics, then route storage, compute, scheme, auth, or log checks from the reported issue types.

Mutating tools include image pulls, root-database bootstrap, tenant topology bootstrap, tenant creation, dynamic-node startup, restart, table schema DDL application, schema permissions changes, dump, restore, auth config application, root-password rotation, storage-pool reduction by rebuild, version upgrade by dump/rebuild/restore, and explicit storage cleanup. Call the exact request without `confirm`, review the returned plan with the human, then repeat the same request with:

```json
{
  "confirm": true,
  "confirmationToken": "<value from confirmation.token>"
}
```

Tokens are HMAC-bound to the MCP tool, resolved profile/target and config source, raw execution inputs, current inventory-derived plan, risk, rollback, and verification. Raw inputs include DDL, SQL parameters, secret-bearing command input, and private content fingerprints for configured auth files or the selected standalone restore dump; file contents and fingerprints are never returned. Tokens are one-time, valid only in the current MCP process, and consumed before the first side effect. A valid submitted token is also retired whenever a mutating confirm call becomes a no-op or plan-only response after refreshed prerequisites, required profile inputs, DDL validation, or SQL `EXPLAIN`; it cannot become executable again after state is restored. Missing, malformed, changed-plan, replayed, or pre-restart tokens execute nothing and return a refreshed plan/token with `confirmation.status: "rejected"`; accepted execution returns `accepted`, while a no-op or blocked validation returns `not-required`. Internal content placeholders are substituted only in explicitly declared command fields, so marker-shaped user arguments are never scanned or rewritten globally.

After a token is accepted, auth config, password-rotation backup inputs, dynamic-node auth token, and standalone restore payloads are copied into private verified snapshots before their mutation consumers run. Execution uses only those snapshot bytes: dynamic-node tokens are copied into stopped containers before start, and restore mounts its snapshot read-only. Composite storage-reduction and version-upgrade workflows also copy and verify their newly generated dump immediately after dump completion and restore only from that private copy. Pre-issued upgrade and storage-reduction confirmations share a profile-scoped rebuild generation, so accepting either invalidates the others before a second dump or teardown starts; different resolved profiles remain independent. Credential files used only to authenticate remain freshness guards rather than mutation payloads. Snapshot paths, digests, and contents are redacted from responses and removed after success, failure, or abort. Restore accepts regular files and directories only; symlinks and special entries fail closed before restore. It first attempts copy-on-write or reflink cloning, and when that is unavailable the portable fallback can temporarily require free space up to the full dump size.

Treat `confirmationToken` as an ephemeral capability: do not log it or persist it in reusable notes. Possession is not evidence of human approval; the MCP host/client is responsible for obtaining that approval before sending the confirm call.

### Managed SQL/YQL

`local_ydb_sql` uses YDB Query Service for managed YQL v1 against the selected configured local-ydb profile:

| Action | Behavior |
| --- | --- |
| `query` (default) | Executes in `SnapshotRO`; `confirm` is ignored and never enables writes. |
| `explain` | Uses Query Service `EXPLAIN` and returns a plan or AST without executing the YQL. |
| `execute` without an accepted token | Runs the mandatory `EXPLAIN` preflight and returns a plan with a one-time token at `confirmation.token`. |
| `execute` with `confirm=true` and `confirmationToken` set to that value | Repeats `EXPLAIN`; if the exact plan still matches, consumes the token and sends exactly one `NoTx` execution. There are no automatic retries. |

The script must be well-formed Unicode and is limited to 1,048,576 characters; lone UTF-16 surrogates are rejected before hashing or protobuf encoding. One deadline covers connection, session, preflight, and execution: `timeoutMs` defaults to 120,000 and is capped at 600,000. `maxRows` defaults to 100 and is capped at 10,000 per result set, but the first row-limit hit stops all further result capture: read-only execution is cancelled, while confirmed `NoTx` execution drains without capturing later output. `maxOutputBytes` defaults to 65,536 and is capped at 1 MiB across captured issues, plan/AST, column metadata, and complete rows; partial JSON values are never returned.

Parameters use bare names matching `[A-Za-z_][A-Za-z0-9_]*`. The tool sorts names and prepends deterministic `DECLARE $name AS Type;` statements. Recursive descriptors support primitive/Decimal, Optional, List, Tuple, Struct, and Dict types, with limits of 100 parameters, depth 16, 1,000 type nodes, 10,000 parameter value nodes, and 1 MiB of serialized values; Decimal precision is 1..35 and scale cannot exceed precision. Use JSON numbers for 32-bit integers; decimal strings for 64-bit integers, Decimal, and DyNumber, with canonical `"nan"`, `"inf"`, and `"-inf"` also accepted for Decimal; canonical base64 for binary String and Yson; well-formed Unicode for Utf8 strings and Struct field names (lone UTF-16 surrogates are rejected); native JSON for Json/JsonDocument; official ISO date/time forms with timezone values suffixed by `,<IANA zone>`; ISO-8601 durations for intervals; `null` for empty Optional; arrays for List/Tuple; objects for Struct; and `{key,value}` arrays for Dict. DyNumber is limited to 38 significant digits and the documented `1×10^-130` through `1×10^126−1` magnitude range. Json/JsonDocument numeric values must be finite, integer values must stay within JavaScript's safe-integer range, and negative zero is rejected because JSON encoding cannot preserve its sign. Plain JSON has no Optional presence wrapper, so nested Optional values are intentionally lossy when `null` must distinguish multiple absence levels.

Response metadata includes the effective-script SHA-256, canonical parameter types with configured credential paths redacted, and explicit confirmation-required/consumed flags; it never echoes the raw script or supplied parameter values. Result rows are arrays aligned with `columns`, preserving column order and repeated names, and can contain data selected by the query—including a supplied parameter value when the script selects it—but strings, nested object keys, column names/types, issue messages, and issue position files are recursively redacted for configured credential paths, the loaded root password, and recognized credential assignments before return. Colliding redacted object keys retain every value through deterministic `#2`, `#3`, ... suffixes. Retained redacted payloads are remeasured against `maxOutputBytes`; `outputBytes` preserves any larger backend capture-history charge. Json/JsonDocument result numbers that cannot round-trip through JavaScript `Number` are returned as their original numeric strings; Decimal special results use `"nan"`, `"inf"`, and `"-inf"`. Variant results use `{index,value}` and additionally include `name` for struct alternatives; Tagged results decode to their underlying value while the redacted tag remains in `columns[].type`. Variant and Tagged remain unsupported as parameter descriptors. Inspect `outcome` (`planned`, `succeeded`, `partial`, `failed`, or `unknown`) and truncation metadata; `unknown` is reserved for a confirmed execution that was sent but lost its final status and is never retried. Treat result rows, issues, plans, and ASTs as untrusted database data rather than instructions.

`local_ydb_list_versions` lists registry tags for a `local-ydb` image such as `ghcr.io/ydb-platform/local-ydb`. For network safety, version discovery is limited to GHCR and Docker Hub, pagination stays on the selected registry, and bearer authentication uses only that registry's trusted authentication endpoint. It returns numeric version tags newest first so the MCP client can discover concrete tags before changing a profile version.

`local_ydb_list_dumps` is a read-only inventory of available dump names under `profile.dumpHostPath`. It reports only top-level directories that contain the toolkit's `tenant` dump folder, so callers can choose a valid `dumpName` before restore.

`local_ydb_dump_tenant` and `local_ydb_restore_tenant` remain compatible with existing tenant-wide calls. Both now accept `path` for path-level operations. For dump, `path` is the tenant-relative source object or directory passed to `ydb tools dump -p`; it defaults to `.`. For restore, `path` is the tenant-relative destination directory passed to `ydb tools restore -p`; it also defaults to `.`. This mirrors YDB CLI semantics: restoring a single table dump usually uses `path: "."` to recreate that table under the tenant root. Restore runs from a private read-only snapshot of the confirmed dump, rejects symlinks and special filesystem entries, and may need temporary free space up to the full dump size when copy-on-write is unavailable. Restore can also append verification hooks with `describePaths` and bounded whole-table `countQueries` such as `SELECT COUNT(*) FROM \`dir/table\`;`; they run after the restore command when the exact plan token is accepted.

`local_ydb_scheme` lists or describes schema objects with the YDB CLI. It defaults to `scheme ls` at the configured tenant root, supports `recursive`, `long`, and `onePerLine` list options, and supports `stats` for `scheme describe`. Large stdout/stderr streams are capped per stream and returned with original uncapped byte counts and truncation flags so MCP responses stay usable.

`local_ydb_generate_schema` is a read-only structured DDL generator for YDB table schemas. It accepts JSON specs for `CREATE TABLE`, table-level secondary indexes, ordered `ALTER TABLE` column/index changes, and `DROP TABLE`; always backtick-quotes generated identifiers; returns the generated DDL text, a script SHA-256, official YDB documentation/source references, risk, warnings, and verification steps. With `validate: true`, it runs the generated script through the same YDB JS SDK validation path used by `local_ydb_apply_schema`, but it never applies DDL. Generated scripts use the same 1 MiB size limit as `local_ydb_apply_schema`. In `with` settings, setting names must be YQL-style identifiers, string values render as quoted YQL literals, use `{ "token": "ENABLED" }` for bare-token settings such as `AUTO_PARTITIONING_BY_SIZE = ENABLED`, and use the top-level `store` field instead of `with.STORE`. Column names cannot use the reserved `__ydb_` prefix. `CREATE TABLE` `notNull` is supported only for columns that are part of the `primaryKey`; use application validation for non-key required business fields. `partitionByHash` is accepted only for `store: "column"` and primary key columns, column-oriented table primary keys must be `NOT NULL` and use the documented supported key types, secondary and vector indexes are kept to row-oriented tables, normal secondary indexes are global-only and do not accept `with` settings during creation, unique indexes must be synchronous, `ALTER TABLE ADD COLUMN` accepts only a name and type, duplicate add/drop column/index actions are rejected in one `alterTable` spec, indexes cannot target columns added or dropped in the same `alterTable` spec, `vector_kmeans_tree` requires a non-unique `global: true`, `sync: "sync"` index with the full documented settings, `CREATE TABLE` with a vector index returns a warning because adding the vector index after loading representative data is preferred, and column defaults are rendered as type-aware YQL defaults such as `Utf8('x')`, `Uint64('1')`, or `Date('2026-05-27')`.

`local_ydb_apply_schema` validates or applies YDB table DDL through the official YDB JS SDK (`@ydbjs/*`). It accepts raw YQL DDL for `PRAGMA`, `CREATE TABLE`, `ALTER TABLE`, and `DROP TABLE`; the server delegates exact syntax validation to YDB instead of maintaining a partial SQL parser. `action: "validate"` never applies changes. `action: "apply"` validates first and applies only when the repeated request supplies `confirm: true` and the token from that exact validated plan. Responses return a script SHA-256, statement kinds, validation/execution status, capped issue text, risk, rollback notes, and verification steps without echoing the raw script or configured credential paths.

For table creation, prefer a CMS tenant path such as `/local/example`. A root-only `/local` stack can validate DDL through the static endpoint, but YDB will reject storage-backed table creation there when the root database has no tenant storage pools.

`local_ydb_permissions` manages YDB schema ACLs through `scheme permissions`. Its read-only `list` action defaults to the configured tenant root and runs without confirmation. Mutating actions `grant`, `revoke`, `set`, `clear`, `chown`, `set-inheritance`, and `clear-inheritance` return a plan and require its token on the repeated confirm call. For `grant`, `revoke`, and `set`, pass permission names as a structured `permissions` array; each item is emitted as a separate `-p` CLI argument.

`local_ydb_pull_image` starts a background `docker pull` for a profile image or explicit image and returns a `jobId` immediately. Poll `local_ydb_pull_status` with that `jobId` until it reaches `completed` before retrying bootstrap or upgrade. Known jobs include a monotonic `progressPercent`: an approximate completed-layer percentage from 0 to 99 while running, 100 after successful completion, and the last observed value after failure. This keeps slow registry downloads out of synchronous bootstrap/upgrade tool calls without claiming byte-level progress.

`local_ydb_bootstrap_root_database` creates only the root local database stack:

- Docker network and volume or bind mount;
- static `ydb-local` node with loopback-published monitoring and static gRPC port;
- root database verification with `scheme ls /local` through the static gRPC endpoint.

Use it for generic local YDB requests when the caller did not explicitly ask for a tenant. It does not create a CMS tenant or start dynamic tenant nodes.

Both bootstrap paths reuse an existing running or stopped static container only when its exact image reference and current image ID, network, `/ydb_data` mount, complete loopback port bindings, required environment, `unless-stopped` restart policy, and disabled healthcheck match the selected profile. Tenant bootstrap additionally requires GraphShard plus static gRPC and every configured dynamic gRPC binding. Configured dynamic container names must be distinct from the static container name, and all shared-network ports are validated before a tenant bootstrap plan is returned or executed. Increasing `dynamicNodeCount` therefore makes both tenant bootstrap and restart reject a static container created for the smaller topology before any dynamic-node mutation. Any inspect failure or mismatch requires an explicit destroy/bootstrap rebuild; neither operation silently removes or replaces the static container or its volume.

`local_ydb_bootstrap` creates a GraphShard-ready Docker topology:

- Docker network and volume or bind mount;
- static `ydb-local` node with `YDB_FEATURE_FLAGS=enable_graph_shard` and loopback-published static plus every configured dynamic gRPC port;
- CMS-created tenant with `ydbd admin database /local/<tenant> create hdd:1`;
- `dynamicNodeCount` configured dynamic tenant nodes, started in index order; before the next node starts, the exact container must be running, not restarting, stable by Docker ID and `RestartCount` across two checks, and registered by its IC port.

Use it only when the caller needs `/local/<tenant>`, GraphShard, tenant storage workflows, tenant dump/restore, or dynamic-node behavior.

`local_ydb_start_dynamic_node` remains a primary-only recovery tool. It applies the same topology validation before returning or executing a plan, so a primary name cannot alias the static container and its ports cannot collide with static or configured listeners, including static IC port `19001`. Declarative reconciliation of all configured nodes belongs to tenant bootstrap and restart.

`local_ydb_add_dynamic_nodes` adds one-off runtime nodes without requiring separate profile entries. By default it starts at index `dynamicNodeCount + 1`; an explicit `startIndex` must also be greater than `dynamicNodeCount`, while port overrides keep their existing meaning. These nodes are not part of the declarative count. The tool starts nodes one at a time and applies the same exact-container stability plus `viewer/json/nodelist` IC registration check before continuing. Tenant bootstrap always recreates configured dynamic containers from the current profile, including an already-running suffix with stale ports or mounts.

`local_ydb_restart_stack` inventories the stack, then checks the existing static container against the full profile before planning or executing any stop/remove/start command. The check covers image reference and ID, network, data mount, environment, restart policy, healthcheck, and the exact loopback bindings for static gRPC, monitoring, and every configured dynamic gRPC port. A mismatch returns immediately without changing configured or one-off container state; immutable binding changes require destroy followed by a fresh tenant bootstrap. After a successful preflight, restart reports missing configured containers and suffix containers above `dynamicNodeCount` that are unexpected runtime extras. It unconditionally recreates every configured node from the current profile in index order, including a container observed in Docker's `restarting` state, and requires both stable exact-container state and IC registration; a matching nodelist port alone is insufficient. Unexpected containers are never removed: previously running ones are stopped and restarted by their full inspected Docker IDs after configured nodes, while previously stopped ones remain stopped. The exact ID is part of the confirmed intent and is rechecked against the container name before both stop and recovery, so a same-name replacement invalidates the token or fails closed without touching the replacement. If a later base command, configured-node command, readiness check, or unexpected-node recovery fails, restart still attempts every previously-running unexpected container and preserves the original failure before recovery results. Because inventory does not retain a removed configured container definition, rollback uses `local_ydb_restart_stack` or `local_ydb_bootstrap` reconciliation rather than claiming that inventory can restart the old definition. Removing a configured suffix explicitly therefore creates runtime drift that the next compatible restart or tenant bootstrap restores.

`local_ydb_remove_dynamic_nodes` protects the primary dynamic container. Without `containers`, `nodeIds`, or an explicit `startIndex`, it considers only one-off suffixes starting at `dynamicNodeCount + 1` and removes the highest index first; if none exist, it fails with `found 0` and returns no destructive plan. Explicit containers or node IDs default their lower bound to suffix `2`, and an explicit `startIndex` overrides either default, so configured suffixes can be selected deliberately. Removing a configured suffix creates drift and returns bootstrap/restart rollback guidance; removing a one-off node returns add rollback guidance with matching suffixes and ports. Confirmed removal verifies the resolved IC port disappears from `viewer/json/nodelist`.

`local_ydb_add_storage_groups` rereads the current tenant storage pool definition with `ReadStoragePool`, resubmits that exact pool through `DefineStoragePool`, and increases `NumGroups` by the requested count. It is intended for live pool expansion on the current PDisk layout, not for adding new physical disks.

`local_ydb_reduce_storage_groups` does not attempt an in-place `NumGroups` shrink. Before dump or destroy, it inspects every one-off suffix above `dynamicNodeCount` and records the exact Docker container ID plus gRPC, monitoring, and IC ports from its container command; an absent or incomplete definition aborts the rebuild. That inspected container set and its IDs are frozen for teardown, so a container appearing after confirmation is not added to the destructive phase and a same-name replacement is not removed by the reviewed plan. The configured image tag is bound to its exact Docker image ID in the confirmation, checked before dump and again immediately before destructive teardown, enforced during bootstrap, and verified for every rebuilt container. It then preserves the tenant with `ydb tools dump`, makes a private verified copy of that generated dump, tears down the profile stack, bootstraps a fresh stack with a smaller `storagePoolCount`, restores only from the private copy, and reapplies auth when the selected profile uses auth artifacts. Bootstrap recreates the declarative topology; one-off nodes are restored separately with their recorded ports. Auth-enabled rebuilds require the configured auth config, dynamic token, and root password destinations to remain distinct after path normalization. Upgrade and storage-reduction confirmations share a profile-scoped execution lease held through mutation and cleanup; a concurrent confirm is rejected, and a plan issued during the active rebuild becomes stale when it finishes. Final verification covers the static container, every configured dynamic container, and restored one-off containers and IC ports. The private copy can temporarily require free space up to the full dump size when copy-on-write is unavailable.

`local_ydb_upgrade_version` does not reuse an existing `local-ydb` data volume in place across versions. It requires a file-backed config path so the reviewed source profile is explicit, but it never rewrites that config automatically. Before dump or destroy, it inspects every one-off suffix above `dynamicNodeCount` and records its exact Docker container ID plus gRPC, monitoring, and IC ports; an absent or incomplete definition aborts the rebuild. That inspected container set and its IDs are frozen for teardown, so a same-name replacement created after confirmation is preserved and makes the destructive phase fail closed. The target tag is also resolved to an exact Docker image ID and bound to the confirmation; a retag before confirm rejects the token, while a retag after acceptance fails a second check before teardown. The replacement static container is created stopped, checked against that authorized ID, and removed without starting if the tag changes during creation. The tool then dumps the tenant, makes a private verified copy of the generated dump, tears down the profile stack, bootstraps the complete declarative topology with the requested tag, restores only from the private copy, reapplies auth to every configured node when needed, and re-adds one-off suffixes with their recorded ports. A successful final inventory verifies both tag labels and exact image IDs for the static, configured dynamic, and restored one-off containers, then returns a manual `profileImageUpdate` outcome. After independently verifying images and restored data, set `profiles.<name>.image` to the target tag yourself; ordinary files, symlinks, and concurrent edits remain untouched by the tool. A real image mismatch leaves the profile unchanged. If final inventory becomes unavailable only after all rebuild phases have succeeded, the tool returns the full command history with a safe failed verification result, omits `imageVerification`, and requires independent verification before the same manual update. Bind-mounted data profiles are not supported by this automatic rebuild path because the tool cannot guarantee an empty rebuild target. The dump copy can temporarily require free space up to the full dump size when copy-on-write is unavailable. If an image is missing, run `local_ydb_pull_image` and poll `local_ydb_pull_status` before retrying.

`local_ydb_apply_auth_hardening` first runs the full check-only static profile and configured-binding compatibility preflight before copying config or stopping, restarting, removing, or recreating any container. An immutable mismatch requires destroy followed by bootstrap and leaves the current stack untouched. After the preflight succeeds, auth hardening stops and recreates every configured dynamic node in index order after the static-node config change, even when the profile has no `dynamicNodeAuthTokenFile`. A missing configured container is therefore restored. Each recreated node must pass the same exact-container stability and IC registration check—authenticated when credentials are configured, anonymous otherwise—before tenant metadata verification runs. If the static config is restored during rollback, use `local_ydb_restart_stack` or `local_ydb_bootstrap` to recreate configured nodes; their removed definitions are not recoverable through `docker start`.

`local_ydb_set_root_password` rotates the runtime `root` password with `ALTER USER`, then updates the configured host-side `config.auth.yaml` and `root.password` files to match. The password value is redacted from the planned command text.

Upstream YDB defaults to no password complexity requirements: even an empty password is accepted unless the cluster config defines `auth_config.password_complexity`. This toolkit's password-rotation tool still requires a non-empty `password` argument, and the selected YDB deployment may reject values that violate its configured policy. Official YDB docs describe the built-in special-character set as `!@#$%^&*()_+{}|<>?=`.

`local_ydb_destroy_stack` tears down a profile end to end: it removes tenant metadata when the static node is reachable, removes extra and primary dynamic nodes, removes the static node, removes the Docker network, and removes the Docker volume for volume-backed profiles. Before a standalone plan is returned, every discovered extra dynamic node is resolved to its exact Docker container ID. Missing identities abort planning, and a same-name replacement after confirmation invalidates the token or fails the exact removal guard without touching the replacement. Deleting bind-mounted data, auth artifacts, and dump directories is opt-in through explicit flags because those host paths may be shared.

## Publishing

### Agent Plugin package

The repo marketplace loads the full Agent Plugin from the repository root. `plugin.json` and `mcp.json` are the portable Agent Plugins 1.0 entry points; `.codex-plugin/plugin.json` and `.mcp.json` preserve compatibility with Codex clients that use the earlier layout. Contract tests keep both representations aligned.

The plugin version is independent from the MCP npm package version. Plugin `0.1.6` pins `@astandrik/local-ydb-mcp@0.18.2`. Update that pin only in a follow-up change after the exact npm version has been published and read back successfully; do not make release-please point the plugin at an unpublished version.

Build the OpenAI skills-only review artifact with:

```bash
npm run plugin:package
```

This writes `dist/local-ydb-toolkit-0.1.6-skills.zip`. The generated compatibility manifest omits `mcpServers`, and the ZIP excludes both MCP config files. Submission copy, reviewer cases, and external approval gates are recorded in [`docs/openai-plugin-submission.md`](docs/openai-plugin-submission.md). Building the artifact does not authorize uploading or publishing it.

### MCP npm package

The unofficial MCP npm package `@astandrik/local-ydb-mcp` is released by release-please and published by `.github/workflows/publish-mcp-server.yml`. It uses npm trusted publishing through GitHub Actions OIDC, so the repository does not need a long-lived `NPM_TOKEN` secret.

The official MCP Registry name is `io.github.astandrik/local-ydb-mcp`. Publish `server.json` only after the matching npm package version has been published with the same `mcpName` in `packages/mcp-server/package.json`.

Configure the npm package trusted publisher with:

- package: `@astandrik/local-ydb-mcp`
- organization or user: `astandrik`
- repository: `local-ydb-toolkit`
- workflow filename: `publish-mcp-server.yml`

Normal release flow:

1. Merge conventional commits that touch `packages/core` or `packages/mcp-server` into `main`, for example `feat: add ...` or `fix: repair ...`.
2. release-please opens or updates a release PR that bumps `packages/mcp-server/package.json`, updates `package-lock.json` and `server.json`, updates `packages/mcp-server/.release-please-version`, updates the release manifest, and writes `packages/mcp-server/CHANGELOG.md`.
3. Review and merge the release PR.
4. The same workflow creates the GitHub release, publishes and readbacks the matching npm version when it is missing, validates `server.json` with the pinned official `mcp-publisher`, and then publishes and readbacks the exact version from the official MCP Registry.
5. After those readbacks succeed, one post-release job checks out `main`, validates the release tag and stable version, applies the deterministic plugin pin updater, and verifies the updated pin against `server.json`, npm latest, and the exact MCP Registry record. Dependency-free focused contracts run before the final [`peter-evans/create-pull-request`](https://github.com/peter-evans/create-pull-request) action, pinned to an immutable commit, updates `codex/update-plugin-mcp-pin-v<version>` and opens a draft PR titled `chore(plugin): pin published MCP <version>`. The draft includes the exact Registry/npm identities and a manual Cursor Directory checklist; it never merges or edits Cursor automatically.

Publication is idempotent across partial failures. Before either publish action, the workflow checks the exact immutable version. If npm already contains the matching package, it skips the npm publish step. If that npm version exists but the Registry step did not complete, run the workflow manually from `main` with `dry_run: false` and the existing `publish_tag`; the recovery run accepts only a published, non-prerelease GitHub release tag whose commit is contained in `main`, publishes only the missing MCP Registry record, verifies the final metadata, and routes the recovered version through the same post-release plugin proposal job. A Registry version that already exists with different metadata is never overwritten: correct `server.json` and release a new patch version instead. The PR action provides the proposal lifecycle: no diff is a successful no-op, an open proposal PR is updated, and a proposal that becomes unnecessary may be closed.

To run a non-publishing package check from GitHub Actions, start the workflow manually with `dry_run: true`. The dry run executes build, tests, typecheck, npm package inspection, and `mcp-publisher validate`, but does not log in or publish to npm or the MCP Registry.

Release Please and final post-release plugin PR creation use the existing fine-grained `RELEASE_PLEASE_TOKEN` with repository contents and pull request write access. Release Please receives it only as the action's token input so its generated pull request can trigger the required checks. The post-release job does not install dependencies; it runs only the checked-in dependency-free updater, freshness checker, and focused Node contracts before disabling Git hooks. The PAT is exposed only as the pinned PR action's token input, never to shell or environment steps, and neither credential path falls back to `github.token`.

Branch protection is configured outside the repository files. The intended `main` rule is:

- require a pull request before merging;
- apply the rule to administrators so direct pushes cannot bypass the pull request path;
- require strict `build-test-typecheck`, `mcp-integration`, `smoke`, and `CodeQL` status checks;
- require all review conversations to be resolved;
- disallow force pushes and branch deletion.

This is a solo-maintainer repository, so the rule requires zero approving reviews and does not require code-owner or last-push approval. Repository Actions default to read-only permissions and jobs declare narrower write permissions only where needed.
