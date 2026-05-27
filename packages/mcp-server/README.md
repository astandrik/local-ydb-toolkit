# @astandrik/local-ydb-mcp

Unofficial stdio MCP server for operating Docker-based `local-ydb` deployments.

## Relationship to `ydb/ydb-mcp`

This package is complementary to the official [`ydb-platform/ydb-mcp`](https://github.com/ydb-platform/ydb-mcp) server. Use `ydb/ydb-mcp` for YDB database-level tools such as SQL queries, query explanations, directory listing, and path inspection against an existing YDB endpoint.

Use `@astandrik/local-ydb-mcp` when an agent needs to operate Docker-based `local-ydb` environments themselves: host prerequisite checks, root or tenant bootstrap, dynamic-node lifecycle, GraphShard checks, auth hardening, storage workflows, dump/restore, and version upgrades. Mutating tools are plan-first and require `confirm: true` before they execute changes.

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

Official MCP Registry metadata uses the name `io.github.astandrik/local-ydb-mcp` and is published from the repository root `server.json` after the matching npm version is available.

## MCP Features

The server exposes local-ydb operation tools and static MCP prompts. Prompt
templates guide stack diagnosis, root database bootstrap, tenant topology
bootstrap, version upgrades, auth hardening, and storage group reduction.
Prompts return workflow instructions only; they do not execute commands.

Mutating tools remain plan-only unless called with `confirm: true`.

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

Manual agent smoke check: run the MCP server once with `LOCAL_YDB_MCP_CONTENT_FORMAT=json` and once with `toon`, then call the same tools in both sessions: `local_ydb_inventory`, `local_ydb_status_report`, `local_ydb_bootstrap_root_database` without `confirm`, `local_ydb_scheme`, `local_ydb_permissions` with a plan-only mutation, `local_ydb_list_versions`, and `local_ydb_nodes_check`. Record whether the agent extracts the same status, planned commands, risks, and next steps. Treat this as qualitative evidence; the benchmark command is the reproducible metric.

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
