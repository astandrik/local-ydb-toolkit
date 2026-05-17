# LobeHub MCP Score Plan

## Goal

Improve the LobeHub marketplace listing for the local YDB MCP server without
changing the server's safety model or exposing private target configuration.

LobeHub listing:

```text
https://lobehub.com/mcp/astandrik-local-ydb-toolkit?activeTab=score
```

This plan treats LobeHub as a marketplace and discovery surface, not as the
source of truth for MCP compatibility. The official MCP Registry metadata
remains `server.json` at the repository root.

## Current facts

- MCP package: `@astandrik/local-ydb-mcp`
- MCP registry name: `io.github.astandrik/local-ydb-mcp`
- Runtime: local `stdio` server run through `npx` or `local-ydb-mcp`
- Current server capability: `tools`
- Current request handlers:
  - `tools/list`
  - `tools/call`
- Current root instructions are exposed through server initialization
  `instructions`, but they are not MCP prompts.
- Mutating tools are plan-only unless called with `confirm: true`.
- The config path may point to private hostnames, SSH targets, identity files,
  password files, dump directories, or local user paths.

## Why this matters

LobeHub is useful for discoverability and trust signals because it presents MCP
servers with install snippets, feature badges, quality scoring, and source links.
Its score is not a runtime requirement, but a weak marketplace score can make a
working server look incomplete.

The requested items are mostly metadata and MCP surface-area improvements:

1. Claim the listing as owner.
2. Expose MCP prompts for common local-ydb workflows.
3. Expose MCP resources for safe, read-only reference context.

## Non-goals

- Do not remove the `confirm: true` execution gate.
- Do not add remote hosting or HTTP transport only to satisfy a marketplace.
- Do not expose the user's active `local-ydb.config.json` as a resource.
- Do not expose private hostnames, SSH paths, password files, dump paths, or
  local user paths through resources or prompts.
- Do not rename tools or change public tool schemas for LobeHub scoring.

## Phase 1: Claim the LobeHub listing

Status: completed in the repository; external LobeHub rescan and claim
verification are still pending.

Add the LobeHub MCP badge to the root `README.md`, near the existing marketplace
badge:

```md
[![MCP Badge](https://lobehub.com/badge/mcp/astandrik-local-ydb-toolkit)](https://lobehub.com/mcp/astandrik-local-ydb-toolkit)
```

If LobeHub offers a full card badge and the compact badge does not claim the
listing, use the full badge they show on the score tab:

```md
[![MCP Badge](https://lobehub.com/badge/mcp-full/astandrik-local-ydb-toolkit)](https://lobehub.com/mcp/astandrik-local-ydb-toolkit)
```

Acceptance evidence:

- [x] Badge is present in root `README.md`.
- [ ] LobeHub rescans the repository and the listing no longer shows
  `Not Claimed by Owner`.

Risk:

- Low. README-only marketplace metadata.

## Phase 2: Add MCP prompts

Expose static workflow prompts through MCP `prompts/list` and `prompts/get`.

Server changes:

- Add `prompts: {}` to server capabilities.
- Add request handlers for:
  - `ListPromptsRequestSchema`
  - `GetPromptRequestSchema`
- Keep prompt definitions in a separate module, for example:
  `packages/mcp-server/src/prompts.ts`
- Export prompt definitions from `packages/mcp-server/src/index.ts` for tests.

Recommended first prompts:

| Prompt | Purpose | Arguments |
| --- | --- | --- |
| `local_ydb_diagnose` | Inspect current stack health before repair. | optional `profile` |
| `local_ydb_bootstrap_root` | Start a plain `/local` database for generic local YDB use. | optional `profile` |
| `local_ydb_bootstrap_tenant` | Start a CMS tenant and dynamic-node topology. | optional `profile`, optional `tenant` |
| `local_ydb_upgrade_version` | Plan a version upgrade using image preflight, dump, rebuild, restore, and verification. | optional `profile`, required `targetImage` |
| `local_ydb_auth_hardening` | Guide native auth hardening with config preparation and verification. | optional `profile` |
| `local_ydb_storage_reduction` | Guide storage group reduction by dump, rebuild, restore, and auth reapply. | optional `profile`, required `targetGroupCount` |

Prompt content rules:

- Prompts should describe the workflow and the expected tool sequence.
- Prompts should remind the agent to inspect first with
  `local_ydb_status_report` or `local_ydb_inventory`.
- Prompts should keep destructive or mutating actions plan-only unless the user
  explicitly asks to run with `confirm: true`.
- Prompts should avoid hardcoded local paths, hostnames, passwords, or private
  profile names.
- Prompts should refer to resources by URI when relevant, for example
  `local-ydb://reference/auth-hardening`.

Acceptance evidence:

- `prompts/list` returns at least one prompt.
- `prompts/get` returns valid prompt messages for every listed prompt.
- Unknown prompt names return a standard invalid-params style error.
- Existing tools still list and call as before.

Risk:

- Low to medium. The runtime behavior remains unchanged, but prompt wording can
  influence agent behavior. Keep the same safety constraints as the current root
  instructions.

## Phase 3: Add MCP resources

Expose safe, static read-only context through MCP resources. Start with direct
resources only. Do not add resource templates until there is a real use case.

Server changes:

- Add `resources: {}` to server capabilities.
- Add request handlers for:
  - `ListResourcesRequestSchema`
  - `ReadResourceRequestSchema`
- Optionally add `ListResourceTemplatesRequestSchema` returning an empty list if
  clients expect the method when resources are supported.
- Keep resource definitions in a separate module, for example:
  `packages/mcp-server/src/resources.ts`

Recommended first resources:

| URI | MIME type | Source |
| --- | --- | --- |
| `local-ydb://instructions` | `text/plain` | Current `localYdbInstructions` |
| `local-ydb://tools` | `application/json` | Public tool names, descriptions, groups, and schemas |
| `local-ydb://reference/topology` | `text/markdown` | `skills/local-ydb/references/topology.md` |
| `local-ydb://reference/auth-hardening` | `text/markdown` | `skills/local-ydb/references/auth-hardening.md` |
| `local-ydb://reference/storage-migration` | `text/markdown` | `skills/local-ydb/references/storage-migration.md` |
| `local-ydb://reference/verification` | `text/markdown` | `skills/local-ydb/references/verification.md` |
| `local-ydb://config/example` | `application/json` | `examples/local-ydb.config.example.json` |

Resource safety rules:

- Include only repository-owned static files or generated metadata from public
  tool definitions.
- Do not read `LOCAL_YDB_TOOLKIT_CONFIG`.
- Do not read `local-ydb.config.json` from the current working directory.
- Do not include command outputs, logs, inventory, active profile details, SSH
  config, auth files, password files, or dump directories in resources.
- If a future live resource is added, it must redact sensitive paths and should
  be implemented as an explicit tool or opt-in resource, not as an automatic
  default resource.

Acceptance evidence:

- `resources/list` returns at least one resource.
- `resources/read` returns valid content for every listed URI.
- Unknown resource URIs return a standard invalid-params style error.
- Resource contents contain no local private paths from the developer machine.

Risk:

- Medium if live configuration is exposed. Low if limited to static repository
  references and public tool metadata.

## Phase 4: Documentation updates

Update root `README.md` and `packages/mcp-server/README.md` after prompts and
resources are implemented.

Recommended additions:

- LobeHub badge in root `README.md`.
- Short "MCP features" section:
  - tools for operating local-ydb deployments;
  - prompts for guided operational workflows;
  - resources for static reference context;
  - mutating tools remain plan-only unless `confirm: true`.
- Mention that resources intentionally do not expose the active private config.

Acceptance evidence:

- README describes tools, prompts, and resources consistently with the server.
- LobeHub rescan shows `Includes Prompts` and `Includes Resources`.

Risk:

- Low. Documentation only.

## Phase 5: Verification

Local checks:

```bash
npm run build
npm test
npm run typecheck
```

Protocol checks:

- Use MCP Inspector or a small SDK client to verify:
  - initialize capabilities include `tools`, `prompts`, and `resources`;
  - `tools/list` still returns all existing tools;
  - `prompts/list` and `prompts/get` work;
  - `resources/list` and `resources/read` work;
  - unknown prompt/resource requests fail cleanly.

Marketplace checks:

- After release and npm publication, restart an MCP client using:

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

- Confirm the server still lists tools and can call a read-only check.
- Wait for LobeHub to rescan the repository or trigger a claim/status check if
  available.

## Suggested implementation order

1. Add the LobeHub badge to claim the owner listing.
2. Add prompt definitions and handlers.
3. Add resource definitions and handlers with static safe resources only.
4. Add tests for prompt/resource list and lookup behavior.
5. Update READMEs.
6. Run build, tests, and typecheck.
7. Release the next npm package version.
8. Recheck the LobeHub score tab after indexing.

## Open decisions

- Whether to keep prompt names aligned with tool names using the
  `local_ydb_*` prefix, or use shorter user-facing prompt names.
- Whether `resources/templates/list` should return an empty list immediately or
  remain unsupported until templates exist.
- Whether to include all reference markdown files as resources in the first
  pass or start with only `instructions`, `tools`, and `config/example`.

Recommended choices:

- Use the `local_ydb_*` prompt prefix for discoverability and consistency.
- Return an empty `resourceTemplates` list only if client testing shows it is
  useful.
- Start with static resources that are clearly safe, then expand after testing
  in real MCP clients.
