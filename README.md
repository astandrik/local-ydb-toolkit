# local-ydb-toolkit

Reusable Codex skill for operating `local-ydb` deployments.

## Quick Start

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

Use the npm package directly from an MCP client:

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
        "LOCAL_YDB_TOOLKIT_CONFIG": "/path/to/local-ydb.config.json"
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
        "LOCAL_YDB_TOOLKIT_CONFIG": "/path/to/local-ydb.config.json"
      }
    }
  }
}
```

Start from `examples/local-ydb.config.example.json` and keep private hosts, SSH keys, password files, and backup paths outside committed config.

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

Read-only tools collect inventory, tenant state, schema objects, schema permissions, node state, GraphShard state, auth posture, storage placement, leftover storage candidates, published `local-ydb` image tags, and background image-pull status.

`local_ydb_check_prerequisites` is the expected first step on a new host or profile. It checks `docker`, `curl`, `ruby`, and auth-file prerequisites. With `confirm: true`, it can auto-install supported host helpers such as `curl` and `ruby` through `apt-get`; Docker is reported but must still be installed manually.

Mutating tools include image pulls, bootstrap, tenant creation, dynamic-node startup, restart, schema permissions changes, dump, restore, auth config application, root-password rotation, storage-pool reduction by rebuild, version upgrade by dump/rebuild/restore, and explicit storage cleanup. They are plan-only unless called with:

```json
{
  "confirm": true
}
```

Without `confirm: true`, mutating tools return planned commands, risk, rollback notes, and verification steps.

`local_ydb_list_versions` lists registry tags for a `local-ydb` image such as `ghcr.io/ydb-platform/local-ydb`. It follows OCI/Docker Registry V2 pagination and bearer-token challenges, then returns numeric version tags newest first so the MCP client can discover concrete tags before changing a profile version.

`local_ydb_scheme` lists or describes schema objects with the YDB CLI. It defaults to `scheme ls` at the configured tenant root, supports `recursive`, `long`, and `onePerLine` list options, and supports `stats` for `scheme describe`. Large stdout/stderr streams are capped per stream and returned with original uncapped byte counts and truncation flags so MCP responses stay usable.

`local_ydb_permissions` manages YDB schema ACLs through `scheme permissions`. Its read-only `list` action defaults to the configured tenant root and runs without `confirm`. Mutating actions `grant`, `revoke`, `set`, `clear`, `chown`, `set-inheritance`, and `clear-inheritance` return a plan unless `confirm: true` is supplied. For `grant`, `revoke`, and `set`, pass permission names as a structured `permissions` array; each item is emitted as a separate `-p` CLI argument.

`local_ydb_pull_image` starts a background `docker pull` for a profile image or explicit image and returns a `jobId` immediately. Poll `local_ydb_pull_status` with that `jobId` until it reaches `completed` before retrying bootstrap or upgrade. This keeps slow registry downloads out of synchronous bootstrap/upgrade tool calls.

`local_ydb_bootstrap` creates a GraphShard-ready Docker topology:

- Docker network and volume or bind mount;
- static `ydb-local` node with `YDB_FEATURE_FLAGS=enable_graph_shard`;
- CMS-created tenant with `ydbd admin database /local/<tenant> create hdd:1`;
- one dynamic tenant node.

`local_ydb_add_dynamic_nodes` adds extra dynamic tenant nodes from the selected profile without requiring separate profile entries. It derives container names and ports from the base dynamic node by default, starts nodes one at a time, and verifies each new IC port through `viewer/json/nodelist` before continuing.

`local_ydb_remove_dynamic_nodes` removes extra dynamic tenant nodes from the selected profile. By default it removes the highest-index extra node first, and it can target explicit extra containers or YDB node IDs. It verifies the removed node's IC port disappears from `viewer/json/nodelist` and leaves the base dynamic node untouched.

`local_ydb_add_storage_groups` rereads the current tenant storage pool definition with `ReadStoragePool`, resubmits that exact pool through `DefineStoragePool`, and increases `NumGroups` by the requested count. It is intended for live pool expansion on the current PDisk layout, not for adding new physical disks.

`local_ydb_reduce_storage_groups` does not attempt an in-place `NumGroups` shrink. It preserves the tenant with `ydb tools dump`, tears down the profile stack, bootstraps a fresh stack with a smaller `storagePoolCount`, restores the dump, and reapplies auth when the selected profile uses auth artifacts.

`local_ydb_upgrade_version` does not reuse an existing `local-ydb` data volume in place across versions. It requires a file-backed config path so it can persist `profiles.<name>.image` to the target tag after image verification. It first verifies that the source and target images are already present on the target host, then dumps the tenant, tears down the profile stack, bootstraps a fresh stack with the requested tag, restores the dump, reapplies auth when needed, re-adds extra dynamic nodes, verifies that the recreated containers use the target image, and updates the selected profile image in the config. Bind-mounted data profiles are not supported by this automatic upgrade path because the tool cannot guarantee an empty rebuild target. If an image is missing, run `local_ydb_pull_image` and poll `local_ydb_pull_status` before retrying.

`local_ydb_set_root_password` rotates the runtime `root` password with `ALTER USER`, then updates the configured host-side `config.auth.yaml` and `root.password` files to match. The password value is redacted from the planned command text.

`local_ydb_destroy_stack` tears down a profile end to end: it removes tenant metadata when the static node is reachable, removes extra and primary dynamic nodes, removes the static node, removes the Docker network, and removes the Docker volume for volume-backed profiles. Deleting bind-mounted data, auth artifacts, and dump directories is opt-in through explicit flags because those host paths may be shared.

## Publishing

The unofficial MCP npm package `@astandrik/local-ydb-mcp` is released by release-please and published by `.github/workflows/publish-mcp-server.yml`. It uses npm trusted publishing through GitHub Actions OIDC, so the repository does not need a long-lived `NPM_TOKEN` secret.

Configure the npm package trusted publisher with:

- package: `@astandrik/local-ydb-mcp`
- organization or user: `astandrik`
- repository: `local-ydb-toolkit`
- workflow filename: `publish-mcp-server.yml`

Normal release flow:

1. Merge conventional commits that touch `packages/core` or `packages/mcp-server` into `main`, for example `feat: add ...` or `fix: repair ...`.
2. release-please opens or updates a release PR that bumps `packages/mcp-server/package.json`, updates `packages/mcp-server/.release-please-version`, updates the release manifest, and writes `packages/mcp-server/CHANGELOG.md`.
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
