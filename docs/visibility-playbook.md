# AI/MCP Visibility Playbook

This playbook keeps external update copy in one repo-tracked place. It is intended for manual publishing to third-party directories and video platforms. Do not add private hosts, SSH keys, password files, tokens, backup paths, or customer-specific examples.

Canonical public URLs:

- Repository: https://github.com/astandrik/local-ydb-toolkit
- Docs site: https://astandrik.github.io/local-ydb-toolkit/
- MCP npm package: https://www.npmjs.com/package/@astandrik/local-ydb-mcp
- GitHub Action: https://github.com/astandrik/setup-local-ydb
- GitHub Marketplace Action: https://github.com/marketplace/actions/setup-local-ydb
- Official MCP Registry name: `io.github.astandrik/local-ydb-mcp`

## Core Positioning

Use this short description where a directory has limited space:

```text
Plan-first stdio MCP server for Docker-based local-ydb diagnostics, bootstrap, schema DDL, auth, storage, backup/restore, and upgrades.
```

Use this longer description where a directory accepts a paragraph:

```text
Local YDB MCP is an unofficial TypeScript stdio MCP server for AI coding agents that need to operate Docker-based local-ydb environments. It supports local and SSH-backed target profiles, root database bootstrap, CMS tenant and dynamic-node topology bootstrap, database healthcheck diagnostics, GraphShard checks, schema DDL generation/validation/application, auth hardening, storage workflows, dump/restore, version upgrades, and plan-first mutating operations. Mutating tools return planned commands unless called with confirm: true.
```

Use this install snippet:

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

## Directory Updates

### Glama

Suggested listing title:

```text
Local YDB MCP
```

Suggested summary:

```text
Plan-first stdio MCP server for Docker-based local-ydb diagnostics, bootstrap, schema DDL, auth, storage, backup/restore, and upgrades.
```

Suggested details:

```text
Local YDB MCP gives AI coding agents a safe operational interface for local-ydb stacks. It collects Docker inventory, YDB healthcheck output, tenant state, node state, GraphShard state, auth posture, scheme objects, storage placement, and logs. Mutating operations are plan-first and require confirm: true before execution.

Use it with @astandrik/local-ydb-mcp from npm. Pair it with the official ydb-platform/ydb-mcp server when the agent also needs database-level query tools.
```

Links to include:

```text
Docs: https://astandrik.github.io/local-ydb-toolkit/
Repository: https://github.com/astandrik/local-ydb-toolkit
npm: https://www.npmjs.com/package/@astandrik/local-ydb-mcp
```

### Skiln

Suggested summary:

```text
Local YDB MCP is a plan-first local stdio MCP server that lets AI agents inspect, bootstrap, diagnose, harden, back up, restore, and upgrade Docker-based local-ydb deployments through local or SSH-backed profiles.
```

Suggested tags:

```text
mcp-server, official-registry, devops, database, docker, ydb, local-ydb, ai-agents
```

Suggested install text:

```text
npx -y --prefer-online @astandrik/local-ydb-mcp@latest
```

### CuratedMCP

Suggested title:

```text
Local-YDB MCP server
```

Suggested subtitle:

```text
Plan-first MCP tools for Docker local-ydb operations
```

Suggested body:

```text
Use Local-YDB MCP when an AI coding agent needs to operate the local-ydb environment itself: prerequisite checks, bootstrap, YDB healthcheck diagnostics, dynamic-node lifecycle, GraphShard checks, schema DDL generation and validation, auth hardening, storage workflows, dump/restore, and version upgrades. Mutations require confirm: true.
```

Suggested install:

```text
npx -y --prefer-online @astandrik/local-ydb-mcp@latest
```

### MCP.so

Suggested description:

```text
TypeScript stdio MCP server for operating Docker-based local-ydb deployments via local or SSH-backed profiles. Supports bootstrap, diagnostics, auth hardening, schema DDL generation/validation/application, storage workflows, dump/restore, upgrades, and plan-first mutating operations.
```

Suggested tags:

```text
local-ydb, ydb, database, devops, docker, mcp, ai-agents, github-actions
```

### MCPBench

Suggested description:

```text
Plan-first stdio MCP server for Docker-based local-ydb diagnostics, bootstrap, schema DDL, auth, storage, backup/restore, and upgrades. Mutating tools return plans by default and execute only with confirm: true.
```

Suggested docs link:

```text
https://astandrik.github.io/local-ydb-toolkit/
```

### Awesome MCP Servers

Suggested entry:

```markdown
- [Local YDB MCP](https://github.com/astandrik/local-ydb-toolkit) - Plan-first stdio MCP server for Docker-based local-ydb diagnostics, bootstrap, schema DDL, auth, storage, backup/restore, and upgrades. Supports local and SSH-backed profiles and keeps mutating tools gated behind `confirm: true`.
```

### npm

The npm package reads `packages/mcp-server/README.md` and `packages/mcp-server/package.json`. Keep these fields aligned:

```json
{
  "description": "Plan-first stdio MCP server for Docker-based local-ydb diagnostics, bootstrap, schema DDL, auth, storage, backup/restore, and upgrades.",
  "keywords": [
    "local-ydb",
    "ydb",
    "mcp",
    "model-context-protocol",
    "codex",
    "ai-agents",
    "docker",
    "database",
    "devops",
    "github-actions"
  ]
}
```

### GitHub Marketplace Action

Suggested Marketplace short description for `astandrik/setup-local-ydb`:

```text
Start a disposable local YDB tenant for GitHub Actions CI jobs.
```

Suggested Marketplace long description:

```text
setup-local-ydb starts ghcr.io/ydb-platform/local-ydb in GitHub Actions, creates a tenant database, waits for readiness, and exports LOCAL_YDB_ENDPOINT, LOCAL_YDB_DATABASE, and LOCAL_YDB_MONITORING_URL for later workflow steps. Enable auth: true when tests need native YDB authentication behavior; the action exports LOCAL_YDB_USER and LOCAL_YDB_PASSWORD_FILE without printing the raw password.
```

Suggested workflow snippet:

```yaml
- uses: astandrik/setup-local-ydb@v1
  id: ydb
  with:
    version: 26.1.1.6
    tenant: /local/test
```

## YouTube Demo Scripts

These scripts are intentionally short. Put the product name and target phrase in the title, description, and spoken transcript. Include links to the docs site, repository, npm package, and GitHub Action.

### Video 1: Install Local YDB MCP in an AI coding agent

Title:

```text
Install Local YDB MCP for AI Coding Agents
```

Description:

```text
Local YDB MCP is a plan-first stdio MCP server for Docker-based local-ydb diagnostics, bootstrap, schema DDL, auth, storage, backup/restore, and upgrades.

Docs: https://astandrik.github.io/local-ydb-toolkit/
Repository: https://github.com/astandrik/local-ydb-toolkit
npm: https://www.npmjs.com/package/@astandrik/local-ydb-mcp
```

Transcript outline:

```text
1. Introduce the problem: AI coding agents can query code, but local database lifecycle operations need guardrails.
2. State the solution: @astandrik/local-ydb-mcp runs as a local stdio MCP server for Docker-based local-ydb.
3. Show the MCP client config with npx -y --prefer-online @astandrik/local-ydb-mcp@latest.
4. Explain LOCAL_YDB_TOOLKIT_CONFIG and LOCAL_YDB_MCP_CONTENT_FORMAT.
5. Show that read-only diagnostics are the first step.
6. Explain that mutating tools return plans and require confirm: true.
7. Point viewers to the docs site and repository.
```

### Video 2: Run local YDB in GitHub Actions

Title:

```text
Run Local YDB in GitHub Actions with setup-local-ydb
```

Description:

```text
Use astandrik/setup-local-ydb to start a disposable local YDB tenant in GitHub Actions CI jobs.

Docs: https://astandrik.github.io/local-ydb-toolkit/setup-local-ydb-github-actions.html
Action: https://github.com/astandrik/setup-local-ydb
Marketplace: https://github.com/marketplace/actions/setup-local-ydb
```

Transcript outline:

```text
1. Explain when CI needs a disposable local YDB tenant.
2. Add the astandrik/setup-local-ydb@v1 workflow step.
3. Set version: 26.1.1.6 and tenant: /local/test.
4. Show LOCAL_YDB_ENDPOINT and LOCAL_YDB_DATABASE being consumed by tests.
5. Explain auth: true for tests that need native YDB auth behavior.
6. Mention that local-ydb-toolkit dogfoods the action in CI.
7. Link to the GitHub Action and docs page.
```

### Video 3: Diagnose local-ydb with MCP tools

Title:

```text
Diagnose local-ydb with MCP Tools
```

Description:

```text
Use @astandrik/local-ydb-mcp read-only tools to diagnose Docker local-ydb stacks before repair.

Docs: https://astandrik.github.io/local-ydb-toolkit/diagnose-local-ydb-mcp.html
Repository: https://github.com/astandrik/local-ydb-toolkit
```

Transcript outline:

```text
1. Explain why local-ydb repair should start with evidence instead of immediate mutation.
2. Run local_ydb_status_report to capture Docker, tenant, node, auth, and health context.
3. Run local_ydb_healthcheck for the official YDB self-check signal.
4. Route STORAGE issues to local_ydb_storage_placement and logs.
5. Route COMPUTE or node issues to local_ydb_nodes_check and tenant checks.
6. Route DATABASE or SCHEME issues to local_ydb_database_status and local_ydb_scheme.
7. Route auth symptoms to local_ydb_auth_check.
8. Close with the plan-first rule: no repair executes without confirm: true.
```

## Review Cadence

Review this playbook after each release that changes public tool behavior, prompt coverage, registry metadata, install instructions, or GitHub Action behavior.

When updating external listings, keep claims limited to behavior present in the repository and avoid implying that `llms.txt`, schema markup, or directory listings guarantee AI citations.
