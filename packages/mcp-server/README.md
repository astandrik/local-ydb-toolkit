# @astandrik/local-ydb-mcp

Unofficial stdio MCP server for operating Docker-based `local-ydb` deployments.

## MCP Client Config

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

Mutating tools are plan-only unless called with `confirm: true`.

The server includes a root-only `local_ydb_bootstrap_root_database` tool for starting `/local` with just the static node, a tenant-oriented `local_ydb_bootstrap` tool for GraphShard-ready dynamic-node topologies, a read-only `local_ydb_list_versions` tool for discovering published `local-ydb` image tags with numeric versions sorted newest first, background image-pull tools (`local_ydb_pull_image` and `local_ydb_pull_status`) for slow registry downloads, and a high-risk `local_ydb_upgrade_version` tool that upgrades a file-backed profile by image preflight, dump, rebuild, restore, auth reapply, image verification, and persisting the profile image. Bind-mounted data profiles are not supported by the automatic upgrade path.
