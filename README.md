# local-ydb-toolkit

[![Website](https://img.shields.io/badge/Website-local--ydb--toolkit-0f766e)](https://local-ydb-toolkit.ydb-qdrant.tech/)
[![Official MCP Registry](https://img.shields.io/badge/Official%20MCP%20Registry-active-16a34a)](https://registry.modelcontextprotocol.io/?q=io.github.astandrik%2Flocal-ydb-mcp)
[![npm package](https://img.shields.io/npm/v/@astandrik/local-ydb-mcp?label=npm%20%40astandrik%2Flocal-ydb-mcp)](https://www.npmjs.com/package/@astandrik/local-ydb-mcp)
[![GitHub Action: setup-local-ydb](https://img.shields.io/badge/GitHub%20Action-setup--local--ydb-2088FF?logo=githubactions&logoColor=white)](https://github.com/astandrik/setup-local-ydb)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-setup--local--ydb-blue?logo=github)](https://github.com/marketplace/actions/setup-local-ydb)

Toolkit for operating `local-ydb` deployments across Codex, MCP clients, and GitHub Actions CI.

Website: [local-ydb-toolkit.ydb-qdrant.tech](https://local-ydb-toolkit.ydb-qdrant.tech/).

It includes:

- a reusable Codex skill for local and SSH `local-ydb` operations;
- an unofficial local stdio MCP server published as `@astandrik/local-ydb-mcp`;
- a Marketplace GitHub Action, [`astandrik/setup-local-ydb`](https://github.com/astandrik/setup-local-ydb), for booting disposable YDB tenants in CI.

## Discovery and trust

Full listing hub: [local-ydb-toolkit.ydb-qdrant.tech/#mcp-registries](https://local-ydb-toolkit.ydb-qdrant.tech/#mcp-registries).

| Surface | Badges |
| --- | --- |
| Official registries and lists | [![Official MCP Registry](https://img.shields.io/badge/Official%20MCP%20Registry-active-16a34a)](https://registry.modelcontextprotocol.io/?q=io.github.astandrik%2Flocal-ydb-mcp) [![Listed on Awesome MCP Servers](https://img.shields.io/badge/Awesome%20MCP%20Servers-listed-blue?logo=github)](https://github.com/punkpeye/awesome-mcp-servers#databases) [![Listed on Awesome Skills](https://img.shields.io/badge/Awesome%20Skills-listed-111827)](https://www.awesomeskills.dev/en/skill/astandrik-local-ydb-toolkit) |
| Trust and audit | <a href="https://wmcp.sh/mcp/grade/npm%3A%40astandrik%2Flocal-ydb-mcp"><img alt="MCP Trust Grade A" src="https://wmcp.sh/mcp/grade/npm%3A%40astandrik%2Flocal-ydb-mcp/badge.svg"></a> [![Audited by MCP Sentinel](https://img.shields.io/badge/MCP%20Sentinel-audited-16a34a)](https://mcp-sentinelweb-production.up.railway.app/servers/astandrik-local-ydb-mcp) [![Listed on CuratedMCP](https://www.curatedmcp.com/api/badge/local-ydb-unofficial-mcp-server)](https://www.curatedmcp.com/marketplace/local-ydb-unofficial-mcp-server) [![local-ydb-toolkit MCP server](https://glama.ai/mcp/servers/astandrik/local-ydb-toolkit/badges/score.svg)](https://glama.ai/mcp/servers/astandrik/local-ydb-toolkit) [![PolicyLayer](https://img.shields.io/badge/PolicyLayer-policy%20catalog-7c3aed)](https://policylayer.com/tools/local-ydb) |
| MCP directories | [![Listed on Enterprise DNA](https://img.shields.io/badge/Enterprise%20DNA-listed-111827)](https://enterprisedna.co/directories/mcp/astandrik-local-ydb-toolkit/) [![Available on LobeHub](https://lobehub.com/badge/mcp/astandrik-local-ydb-toolkit)](https://lobehub.com/mcp/astandrik-local-ydb-toolkit) [![Listed on MCP.so](https://img.shields.io/badge/MCP.so-listed-2563eb)](https://mcp.so/server/local-ydb-mcp/astandrik) [![Listed on MCP Toplist](https://img.shields.io/badge/MCP%20Toplist-listed-0ea5e9)](https://mcptoplist.com/server/io.github.astandrik%2Flocal-ydb-mcp) [![Listed on Claude Code Marketplaces](https://img.shields.io/badge/Claude%20Code%20Marketplaces-listed-8b5cf6)](https://claudemarketplaces.com/mcp/io.github.astandrik/local-ydb-mcp) [![Available on CodeGuilds](https://img.shields.io/badge/Available_on-CodeGuilds-6366f1)](https://codeguilds.dev/packages/local-ydb-toolkit) [![Listed on Skiln](https://img.shields.io/badge/Skiln-listed-0f766e)](https://skiln.co/mcp/mcp-io-github-astandrik-local-ydb-mcp) [![Listed on Timeahead MCPScore](https://img.shields.io/badge/Timeahead%20MCPScore-listed-f97316)](https://timeahead.in/mcp/local-ydb-mcp) |

## Relationship to `ydb/ydb-mcp`

Local YDB MCP is complementary to the official [`ydb-platform/ydb-mcp`](https://github.com/ydb-platform/ydb-mcp) server. Use `ydb/ydb-mcp` when an agent needs general YDB database-level tools such as ad hoc SQL queries, query explanations, directory listing, and path inspection against an existing YDB endpoint.

Use this toolkit when the agent needs to operate Docker-based `local-ydb` environments themselves: host prerequisite checks, root or tenant bootstrap, dynamic-node lifecycle, GraphShard checks, table DDL generation/validation/application for local deployments, auth hardening, storage workflows, dump/restore, and version upgrades. Mutating MCP tools are plan-first and require `confirm: true` before they execute changes.

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

This repository dogfoods the Marketplace action in CI. `.github/workflows/setup-local-ydb-smoke.yml` keeps a short action-level smoke test, while `.github/workflows/local-ydb-mcp-integration.yml` starts the real stdio MCP server and verifies prompts, read-only tools, schema DDL apply, plan-only behavior, path-level dump/list/restore with restore hooks, and a confirmed dynamic-node add/remove against a live YDB tenant. The concise GitHub Developer Program artifact is in `docs/github-developer-program.md`.

The reusable agent guidance is also covered by a plan-only Codex eval suite. It requires the `codex` CLI and `CODEX_API_KEY` for actual runs. Run `npm run eval:agent -- --list` to inspect scenarios, `CODEX_API_KEY=... npm run eval:agent -- --case explicit-database-diagnosis` for a smoke case, or `CODEX_API_KEY=... npm run eval:agent` for the full suite. Results are written to ignored `eval-results/local-ydb-agent/<timestamp>/`; `.github/workflows/local-ydb-agent-evals.yml` installs Codex CLI and runs the same suite manually through `workflow_dispatch` when the repository has a `CODEX_API_KEY` secret.

## Skill Contents

```text
skills/local-ydb/
  SKILL.md
  agents/openai.yaml
  references/
    auth-hardening.md
    evals.md
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

### MCP Features

The MCP server exposes tools for local-ydb operations and prompts for guided
workflows. Prompt templates cover stack diagnosis, root database bootstrap,
database diagnostics, tenant topology bootstrap, schema generation/apply,
version upgrades, auth hardening, and storage group reduction. Prompts do not execute commands; they
return workflow instructions that guide the MCP client toward the existing
`local_ydb_*` tools.

Mutating tools remain plan-only unless called with `confirm: true`. Static MCP
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

SSH profiles use existing SSH agent/key/known_hosts configuration. The toolkit does not store SSH passwords.

### Operations

Read-only tools collect inventory, tenant state, YDB healthcheck/self-check output, schema objects, generated table DDL, schema permissions, node state, GraphShard state, auth posture, storage placement, leftover storage candidates, published `local-ydb` image tags, and background image-pull status.

`local_ydb_check_prerequisites` is the expected first step on a new host or profile. It checks `docker`, `curl`, `ruby`, and auth-file prerequisites. With `confirm: true`, it can auto-install supported host helpers such as `curl` and `ruby` through `apt-get`; Docker is reported but must still be installed manually.

`local_ydb_healthcheck` runs YDB's built-in `monitoring healthcheck --format json` against the configured tenant path by default. It returns `selfCheckResult`, whether the database is healthy, issue counts by status, issue types, capped raw stdout/stderr, and truncated `issue_log` entries. Use it after `local_ydb_status_report` for database-level diagnostics, then route storage, compute, scheme, auth, or log checks from the reported issue types.

Mutating tools include image pulls, root-database bootstrap, tenant topology bootstrap, tenant creation, dynamic-node startup, restart, table schema DDL application, schema permissions changes, dump, restore, auth config application, root-password rotation, storage-pool reduction by rebuild, version upgrade by dump/rebuild/restore, and explicit storage cleanup. They are plan-only unless called with:

```json
{
  "confirm": true
}
```

Without `confirm: true`, mutating tools return planned commands, risk, rollback notes, and verification steps.

`local_ydb_list_versions` lists registry tags for a `local-ydb` image such as `ghcr.io/ydb-platform/local-ydb`. It follows OCI/Docker Registry V2 pagination and bearer-token challenges, then returns numeric version tags newest first so the MCP client can discover concrete tags before changing a profile version.

`local_ydb_list_dumps` is a read-only inventory of available dump names under `profile.dumpHostPath`. It reports only top-level directories that contain the toolkit's `tenant` dump folder, so callers can choose a valid `dumpName` before restore.

`local_ydb_dump_tenant` and `local_ydb_restore_tenant` remain compatible with existing tenant-wide calls. Both now accept `path` for path-level operations. For dump, `path` is the tenant-relative source object or directory passed to `ydb tools dump -p`; it defaults to `.`. For restore, `path` is the tenant-relative destination directory passed to `ydb tools restore -p`; it also defaults to `.`. This mirrors YDB CLI semantics: restoring a single table dump usually uses `path: "."` to recreate that table under the tenant root. Restore can also append verification hooks with `describePaths` and bounded whole-table `countQueries` such as `SELECT COUNT(*) FROM \`dir/table\`;`; they run after the restore command when `confirm: true` is supplied.

`local_ydb_scheme` lists or describes schema objects with the YDB CLI. It defaults to `scheme ls` at the configured tenant root, supports `recursive`, `long`, and `onePerLine` list options, and supports `stats` for `scheme describe`. Large stdout/stderr streams are capped per stream and returned with original uncapped byte counts and truncation flags so MCP responses stay usable.

`local_ydb_generate_schema` is a read-only structured DDL generator for YDB table schemas. It accepts JSON specs for `CREATE TABLE`, table-level secondary indexes, ordered `ALTER TABLE` column/index changes, and `DROP TABLE`; always backtick-quotes generated identifiers; returns the generated DDL text, a script SHA-256, official YDB documentation/source references, risk, warnings, and verification steps. With `validate: true`, it runs the generated script through the same YDB JS SDK validation path used by `local_ydb_apply_schema`, but it never applies DDL. Generated scripts use the same 1 MiB size limit as `local_ydb_apply_schema`. In `with` settings, setting names must be YQL-style identifiers, string values render as quoted YQL literals, use `{ "token": "ENABLED" }` for bare-token settings such as `AUTO_PARTITIONING_BY_SIZE = ENABLED`, and use the top-level `store` field instead of `with.STORE`. Column names cannot use the reserved `__ydb_` prefix. `CREATE TABLE` `notNull` is supported only for columns that are part of the `primaryKey`; use application validation for non-key required business fields. `partitionByHash` is accepted only for `store: "column"` and primary key columns, column-oriented table primary keys must be `NOT NULL` and use the documented supported key types, secondary and vector indexes are kept to row-oriented tables, normal secondary indexes are global-only and do not accept `with` settings during creation, unique indexes must be synchronous, `ALTER TABLE ADD COLUMN` accepts only a name and type, duplicate add/drop column/index actions are rejected in one `alterTable` spec, indexes cannot target columns added or dropped in the same `alterTable` spec, `vector_kmeans_tree` requires a non-unique `global: true`, `sync: "sync"` index with the full documented settings, `CREATE TABLE` with a vector index returns a warning because adding the vector index after loading representative data is preferred, and column defaults are rendered as type-aware YQL defaults such as `Utf8('x')`, `Uint64('1')`, or `Date('2026-05-27')`.

`local_ydb_apply_schema` validates or applies YDB table DDL through the official YDB JS SDK (`@ydbjs/*`). It accepts raw YQL DDL for `PRAGMA`, `CREATE TABLE`, `ALTER TABLE`, and `DROP TABLE`; the server delegates exact syntax validation to YDB instead of maintaining a partial SQL parser. `action: "validate"` never applies changes. `action: "apply"` validates first and applies only when `confirm: true` is supplied. Responses return a script SHA-256, statement kinds, validation/execution status, capped issue text, risk, rollback notes, and verification steps without echoing the raw script or configured credential paths.

For table creation, prefer a CMS tenant path such as `/local/example`. A root-only `/local` stack can validate DDL through the static endpoint, but YDB will reject storage-backed table creation there when the root database has no tenant storage pools.

`local_ydb_permissions` manages YDB schema ACLs through `scheme permissions`. Its read-only `list` action defaults to the configured tenant root and runs without `confirm`. Mutating actions `grant`, `revoke`, `set`, `clear`, `chown`, `set-inheritance`, and `clear-inheritance` return a plan unless `confirm: true` is supplied. For `grant`, `revoke`, and `set`, pass permission names as a structured `permissions` array; each item is emitted as a separate `-p` CLI argument.

`local_ydb_pull_image` starts a background `docker pull` for a profile image or explicit image and returns a `jobId` immediately. Poll `local_ydb_pull_status` with that `jobId` until it reaches `completed` before retrying bootstrap or upgrade. This keeps slow registry downloads out of synchronous bootstrap/upgrade tool calls.

`local_ydb_bootstrap_root_database` creates only the root local database stack:

- Docker network and volume or bind mount;
- static `ydb-local` node with loopback-published monitoring and static gRPC port;
- root database verification with `scheme ls /local` through the static gRPC endpoint.

Use it for generic local YDB requests when the caller did not explicitly ask for a tenant. It does not create a CMS tenant or start dynamic tenant nodes.

`local_ydb_bootstrap` creates a GraphShard-ready Docker topology:

- Docker network and volume or bind mount;
- static `ydb-local` node with `YDB_FEATURE_FLAGS=enable_graph_shard` and loopback-published static and dynamic gRPC ports;
- CMS-created tenant with `ydbd admin database /local/<tenant> create hdd:1`;
- one dynamic tenant node.

Use it only when the caller needs `/local/<tenant>`, GraphShard, tenant storage workflows, tenant dump/restore, or dynamic-node behavior.

`local_ydb_add_dynamic_nodes` adds extra dynamic tenant nodes from the selected profile without requiring separate profile entries. It derives container names and ports from the base dynamic node by default, starts nodes one at a time, and verifies each new IC port through `viewer/json/nodelist` before continuing.

`local_ydb_remove_dynamic_nodes` removes extra dynamic tenant nodes from the selected profile. By default it removes the highest-index extra node first, and it can target explicit extra containers or YDB node IDs. It verifies the removed node's IC port disappears from `viewer/json/nodelist` and leaves the base dynamic node untouched.

`local_ydb_add_storage_groups` rereads the current tenant storage pool definition with `ReadStoragePool`, resubmits that exact pool through `DefineStoragePool`, and increases `NumGroups` by the requested count. It is intended for live pool expansion on the current PDisk layout, not for adding new physical disks.

`local_ydb_reduce_storage_groups` does not attempt an in-place `NumGroups` shrink. It preserves the tenant with `ydb tools dump`, tears down the profile stack, bootstraps a fresh stack with a smaller `storagePoolCount`, restores the dump, and reapplies auth when the selected profile uses auth artifacts.

`local_ydb_upgrade_version` does not reuse an existing `local-ydb` data volume in place across versions. It requires a file-backed config path so it can persist `profiles.<name>.image` to the target tag after image verification. It first verifies that the source and target images are already present on the target host, then dumps the tenant, tears down the profile stack, bootstraps a fresh stack with the requested tag, restores the dump, reapplies auth when needed, re-adds extra dynamic nodes, verifies that the recreated containers use the target image, and updates the selected profile image in the config. Bind-mounted data profiles are not supported by this automatic upgrade path because the tool cannot guarantee an empty rebuild target. If an image is missing, run `local_ydb_pull_image` and poll `local_ydb_pull_status` before retrying.

`local_ydb_set_root_password` rotates the runtime `root` password with `ALTER USER`, then updates the configured host-side `config.auth.yaml` and `root.password` files to match. The password value is redacted from the planned command text.

Upstream YDB defaults to no password complexity requirements: even an empty password is accepted unless the cluster config defines `auth_config.password_complexity`. This toolkit's password-rotation tool still requires a non-empty `password` argument, and the selected YDB deployment may reject values that violate its configured policy. Official YDB docs describe the built-in special-character set as `!@#$%^&*()_+{}|<>?=`.

`local_ydb_destroy_stack` tears down a profile end to end: it removes tenant metadata when the static node is reachable, removes extra and primary dynamic nodes, removes the static node, removes the Docker network, and removes the Docker volume for volume-backed profiles. Deleting bind-mounted data, auth artifacts, and dump directories is opt-in through explicit flags because those host paths may be shared.

## Publishing

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
4. The same workflow creates the GitHub release and publishes `@astandrik/local-ydb-mcp` to npm.

To run a non-publishing package check from GitHub Actions, start the workflow manually with `dry_run: true`.

The release-please workflow can use the default `GITHUB_TOKEN`. If release PRs must trigger CI checks immediately when release-please updates them, create a fine-grained `RELEASE_PLEASE_TOKEN` secret with repository contents and pull request write access.

Branch protection is configured outside the repository files. The intended `main` rule is:

- require a pull request before merging;
- require one approving review;
- require approval from code owners, with `.github/CODEOWNERS` assigning all paths to `@astandrik`;
- require stale approvals to be refreshed after new commits.

For this solo-maintainer repository, admin bypass is left enabled. GitHub does not count a pull request author's own approval toward required reviews, so enforcing the same rule on admins would require a second maintainer to merge PRs authored by `@astandrik`. If a second maintainer is added, enable "Do not allow bypassing the above settings" to make the PR-only rule strict for admins too.
