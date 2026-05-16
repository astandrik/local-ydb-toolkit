# MCP Registry Publication Plan

## Goal

Publish the local stdio MCP server from this repository to the official MCP
Registry as an installable npm package server.

This should not be published as a remote MCP server. The server runs locally in
the user's MCP client process and operates local or SSH-configured `local-ydb`
targets.

## Current facts

- Repository: `https://github.com/astandrik/local-ydb-toolkit`
- Repository ID: `1220812874`
- MCP package: `@astandrik/local-ydb-mcp`
- Current npm version: `0.7.2`
- Current published npm `0.7.2` metadata does not include `mcpName`.
- Runtime: Node.js `>=18`
- Transport: `stdio`
- Binary: `local-ydb-mcp`
- Config file behavior: `LOCAL_YDB_TOOLKIT_CONFIG` is optional. If it is not
  set, the server tries `./local-ydb.config.json`; if that file is missing, it
  uses the default local profile.
- Existing npm install form:

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

## Proposed registry identity

Use the GitHub namespace because this is a public GitHub-hosted package:

```text
io.github.astandrik/local-ydb-mcp
```

Recommended title:

```text
Local YDB MCP
```

Recommended description:

```text
Operate local-ydb deployments through local or SSH-backed MCP tools.
```

The description is intentionally under the registry schema's 100-character
limit.

## Blocking prerequisite

Do not attempt to publish the current npm `0.7.2` package to the official MCP
Registry. The official registry verifies npm package ownership by reading
`mcpName` from the published package metadata, and `0.7.2` was published without
that field.

First ship a new npm MCP package version containing:

```json
{
  "mcpName": "io.github.astandrik/local-ydb-mcp"
}
```

in `packages/mcp-server/package.json`.

If no other package changes are included, the next practical package version is
`0.7.3`. In the examples below, replace `<next-package-version>` with the exact
published package version, for example `0.7.3`.

## Proposed server.json

Create `server.json` at the repository root:

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.astandrik/local-ydb-mcp",
  "title": "Local YDB MCP",
  "description": "Operate local-ydb deployments through local or SSH-backed MCP tools.",
  "version": "<next-package-version>",
  "websiteUrl": "https://github.com/astandrik/local-ydb-toolkit#readme",
  "repository": {
    "url": "https://github.com/astandrik/local-ydb-toolkit",
    "source": "github",
    "id": "1220812874",
    "subfolder": "packages/mcp-server"
  },
  "packages": [
    {
      "registryType": "npm",
      "registryBaseUrl": "https://registry.npmjs.org",
      "identifier": "@astandrik/local-ydb-mcp",
      "version": "<next-package-version>",
      "runtimeHint": "npx",
      "runtimeArguments": [
        {
          "type": "named",
          "name": "-y"
        },
        {
          "type": "named",
          "name": "--prefer-online"
        }
      ],
      "environmentVariables": [
        {
          "name": "LOCAL_YDB_TOOLKIT_CONFIG",
          "description": "Optional path to a local-ydb-toolkit config JSON file.",
          "format": "filepath",
          "isRequired": false,
          "placeholder": "/path/to/local-ydb.config.json"
        }
      ],
      "transport": {
        "type": "stdio"
      }
    }
  ]
}
```

Do not put `@astandrik/local-ydb-mcp@<version>` in `runtimeArguments`. The
registry package `identifier` and `version` already define the npm package to
run; `runtimeArguments` should contain only runtime flags such as `npx -y` and
`--prefer-online`.

## Validation steps

Run from the repository root:

```bash
npm run build
npm test
npm run typecheck
mcp-publisher validate server.json
```

If `mcp-publisher` is not installed, use the official release binary matching
the local OS/architecture, or install it with Homebrew where available.

## Authentication

Use GitHub authentication for the `io.github.astandrik/*` namespace:

```bash
mcp-publisher login github
```

This is preferable to DNS/HTTP auth for this repository because the namespace is
GitHub-based and the repository is public.

## Publication

Publish from the repository root:

```bash
mcp-publisher publish
```

Then verify:

```bash
curl 'https://registry.modelcontextprotocol.io/v0.1/servers?search=local-ydb-mcp'
curl 'https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.astandrik%2Flocal-ydb-mcp'
```

Expected result:

```text
name: io.github.astandrik/local-ydb-mcp
status: active
isLatest: true
package: @astandrik/local-ydb-mcp@<next-package-version>
transport: stdio
```

## Implementation plan

1. Add `mcpName: "io.github.astandrik/local-ydb-mcp"` to
   `packages/mcp-server/package.json`.
2. Add root `server.json` with the registry identity above and the next exact
   package version.
3. Update `package-lock.json` after the package metadata change.
4. Run `npm run build`, `npm test`, `npm run typecheck`, and
   `mcp-publisher validate server.json`.
5. Release and publish the next npm version through the existing
   release-please / trusted publishing flow.
6. After npm publication is visible, run `mcp-publisher login github` and
   `mcp-publisher publish` from the repository root.
7. Verify the official Registry search API returns the server as active and
   latest.
8. Optionally automate future Registry publication in
   `.github/workflows/publish-mcp-server.yml` after npm publish by installing
   `mcp-publisher`, running `mcp-publisher login github-oidc`, validating
   `server.json`, and publishing it. The existing publish job already grants
   `id-token: write`, which is the required GitHub OIDC permission.

## Follow-up after publication

- Add a README section with the official registry name.
- Add a short release note/changelog entry if this repository tracks registry
  publication as a distribution channel.
- Keep `server.json.version` and `packages[0].version` aligned with the npm MCP
  package version. For registry-only metadata fixes after a package release, use
  a unique server prerelease version such as `<package-version>-1` while leaving
  `packages[0].version` pinned to the already-published package.
- Check aggregator indexing later:
  - official MCP Registry search
  - PulseMCP
  - Glama
