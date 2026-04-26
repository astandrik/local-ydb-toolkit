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

This repository also contains a local stdio MCP server for operating `local-ydb` targets. The MCP server itself runs locally; tools operate either on the local Docker host or over SSH to a named remote profile.

Install and build:

```bash
npm install
npm run build
```

Example MCP client config:

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

Read-only tools collect inventory, tenant state, node state, GraphShard state, auth posture, storage placement, and leftover storage candidates.

Mutating tools include bootstrap, tenant creation, dynamic-node startup, restart, dump, restore, auth config application, and explicit storage cleanup. They are plan-only unless called with:

```json
{
  "confirm": true
}
```

Without `confirm: true`, mutating tools return planned commands, risk, rollback notes, and verification steps.

`local_ydb_bootstrap` creates a GraphShard-ready Docker topology:

- Docker network and volume or bind mount;
- static `ydb-local` node with `YDB_FEATURE_FLAGS=enable_graph_shard`;
- CMS-created tenant with `ydbd admin database /local/<tenant> create hdd:1`;
- one dynamic tenant node.

`local_ydb_add_dynamic_nodes` adds extra dynamic tenant nodes from the selected profile without requiring separate profile entries. It derives container names and ports from the base dynamic node by default, starts nodes one at a time, and verifies each new IC port through `viewer/json/nodelist` before continuing.

`local_ydb_remove_dynamic_nodes` removes extra dynamic tenant nodes from the selected profile. By default it removes the highest-index extra node first, verifies the removed node's IC port disappears from `viewer/json/nodelist`, and leaves the base dynamic node untouched.

`local_ydb_add_storage_groups` rereads the current tenant storage pool definition with `ReadStoragePool`, resubmits that exact pool through `DefineStoragePool`, and increases `NumGroups` by the requested count. It is intended for live pool expansion on the current PDisk layout, not for adding new physical disks.

`local_ydb_destroy_stack` tears down a profile end to end: it removes tenant metadata when the static node is reachable, removes extra and primary dynamic nodes, removes the static node, removes the Docker network, and removes the Docker volume for volume-backed profiles. Deleting bind-mounted data, auth artifacts, and dump directories is opt-in through explicit flags because those host paths may be shared.
