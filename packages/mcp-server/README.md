# @local-ydb-toolkit/mcp-server

Stdio MCP server for operating Docker-based `local-ydb` deployments.

## MCP Client Config

Use `npx` so clients can run the server without a manual checkout:

```json
{
  "mcpServers": {
    "local-ydb": {
      "command": "npx",
      "args": ["-y", "@local-ydb-toolkit/mcp-server"],
      "env": {
        "LOCAL_YDB_TOOLKIT_CONFIG": "/path/to/local-ydb.config.json"
      }
    }
  }
}
```

The config file is optional. If `LOCAL_YDB_TOOLKIT_CONFIG` is not set, the server reads `local-ydb.config.json` from the current working directory. If that file is missing, it uses a default local profile.

## Global Install

```bash
npm install -g @local-ydb-toolkit/mcp-server
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
