# local-ydb-toolkit - Agent Instructions

## Build & Run
- `npm ci` - Install exact workspace dependencies for CI-parity checks.
- `npm install` - Install workspace dependencies during local development.
- `npm run build` - Build `@local-ydb-toolkit/core` and then `@astandrik/local-ydb-mcp`.
- `npm run build -w @local-ydb-toolkit/core` - Build only the core package.
- `npm run build -w @astandrik/local-ydb-mcp` - Build only the MCP server package.
- `npm run typecheck` - Type-check all workspaces with package-specific `tsconfig.typecheck.json` files.
- `npm run compare:formats -w @astandrik/local-ydb-mcp` - Compare JSON and TOON response sizes when changing MCP response formatting.
- `node packages/mcp-server/dist/index.js` - Start the stdio MCP server after a successful build.

## Overview
This repository contains a reusable Codex skill for operating `local-ydb` deployments, a TypeScript npm workspace that exposes the same operations through a local stdio MCP server, and CI assets for the `astandrik/setup-local-ydb` GitHub Action. The runtime package is split between a core operation library and an MCP server wrapper.

## Testing
- `npm test` - Run all Vitest tests matching `packages/**/*.test.ts`.
- `npm test -- packages/core/test/validation.test.ts` - Run one core test file.
- `npm test -- packages/mcp-server/test/tools.test.ts` - Run one MCP server test file.
- `npm test -- -t "config validation"` - Run tests matching a Vitest name pattern.

Run `npm test` and `npm run typecheck` before handing off TypeScript changes.
GitHub CI uses Node 24 and runs `npm ci`, `npm run build`, `npm test`, and `npm run typecheck`.
The live MCP integration workflow also builds the server, starts YDB through `astandrik/setup-local-ydb@v1`, and runs `node scripts/ci/verify-live-mcp-server.mjs`; treat that as Docker/YDB integration coverage, not a default local check.

## Project Structure
- `packages/core/` - TypeScript library for config validation, command execution, local-ydb checks, and mutating operation plans.
- `packages/mcp-server/` - Stdio MCP server that registers public `local_ydb_*` tools and delegates to `@local-ydb-toolkit/core`.
- `packages/mcp-server/src/tools/` - MCP tool registry, argument schemas, input schemas, instructions, and handler context.
- `packages/mcp-server/src/prompts.ts` - Guided MCP prompt templates for diagnosis, bootstrap, upgrades, auth hardening, and storage reduction.
- `packages/mcp-server/src/response-format.ts` and `packages/mcp-server/src/responses.ts` - MCP response shaping, including optional TOON text content while keeping `structuredContent` JSON.
- `skills/local-ydb/` - Codex skill content, references, agent metadata, scripts, and assets.
- `examples/local-ydb.config.example.json` - Example local and SSH target profiles; keep real secrets and host details out of committed configs.
- `scripts/ci/` - GitHub Actions verification scripts for live MCP and setup-local-ydb smoke coverage.
- `.github/workflows/` - CI, live MCP integration, setup-local-ydb smoke, and release/publish workflows.
- `server.json` - Official MCP Registry metadata for `io.github.astandrik/local-ydb-mcp`.
- `MCP_TOOL_TEST_SCENARIOS.md` - Manual MCP tool scenarios.
- `vitest.config.ts` - Vitest configuration and workspace alias for `@local-ydb-toolkit/core`.
- `../local-ydb-toolkit-ui` - Sibling checkout for the public website when present; keep website-facing product metadata in sync when this repo changes public discovery or install surfaces.

## Code Style
- Use strict TypeScript with ES modules and `NodeNext`; relative TypeScript imports include the emitted `.js` suffix.
- Validate boundary inputs with Zod and keep exported operation response types explicit.
- Keep mutating operations plan-first: tools return planned commands unless `confirm: true` is supplied.
- Redact password files, identity files, and other sensitive paths before returning command text.
- Keep MCP tool responses dual-purpose: readable `content` for agents and machine-readable `structuredContent` for clients.
- Keep TOON optional and limited to LLM-facing text content; MCP JSON-RPC payloads and `structuredContent` remain JSON.

### Example
```ts
export interface OperationPlan {
  risk: "low" | "medium" | "high";
  plannedCommands: string[];
  rollback: string[];
  verification: string[];
}
```

## Upstream YDB Source Lookup
- When behavior depends on YDB server, CLI, Docker image, CMS tenants, GraphShard, storage/BSC, auth, viewer JSON, healthcheck, dump/restore, or YQL DDL semantics, verify against upstream [`ydb-platform/ydb`](https://github.com/ydb-platform/ydb) instead of relying on memory.
- Prefer `gh api search/code` and `gh api repos/ydb-platform/ydb/contents/...` for source reads. Use stable search terms such as command names, proto fields, endpoint paths, env vars, error strings, or feature flags. Pin a commit SHA in docs when behavior is version-specific.
- Useful upstream entry points:
  - `.github/docker/Dockerfile`, `.github/docker/files/initialize_local_ydb`, `.github/docker/files/health_check`, and `ydb/public/tools/local_ydb/` for `ghcr.io/ydb-platform/local-ydb` image behavior.
  - `ydb/apps/ydb/` and `ydb/public/lib/ydb_cli/` for `/ydb` CLI commands; dump/restore lives under `ydb/public/lib/ydb_cli/dump/`, scheme and permissions under `ydb/public/lib/ydb_cli/commands/ydb_service_scheme.cpp`, monitoring healthcheck under `ydb/public/lib/ydb_cli/commands/ydb_service_monitoring.cpp`.
  - `ydb/apps/ydbd/` and `ydb/core/driver_lib/cli_utils/` for `/ydbd` admin commands; database tenant commands are in `cli_cmds_tenant.cpp`, blobstorage config commands in `cli_cmds_bs.cpp`.
  - `ydb/public/api/protos/ydb_cms.proto`, `ydb/public/api/grpc/ydb_cms_v1.proto`, and `ydb/core/cms/console/` for CMS database create/status/remove behavior.
  - `ydb/core/graph/`, `ydb/core/viewer/viewer_capabilities.h`, and SchemeShard tenant code under `ydb/core/tx/schemeshard/` for GraphShard behavior and capability reporting.
  - `ydb/core/protos/blobstorage_config.proto` and `ydb/core/mind/bscontroller/` for `ReadStoragePool`, `DefineStoragePool`, `QueryBaseConfig`, PDisk, and group-placement behavior.
  - `ydb/core/viewer/` for `/viewer/json/*` endpoints such as `nodelist`, `whoami`, `capabilities`, and healthcheck routing.
  - `ydb/core/protos/auth.proto`, `ydb/core/protos/config.proto`, and `ydb/docs/en/core/reference/configuration/security_config.md` for auth token fields and `security_config` behavior.
  - `ydb/public/api/protos/ydb_scheme.proto`, `ydb/public/api/protos/ydb_table.proto`, `ydb/docs/en/core/yql/reference/syntax/`, and `yql/essentials/parser/` for schema, table, and YQL DDL semantics.

## MCP and Documentation Consistency
- When changing a public tool, update the core operation surface, MCP args/input schema/registry wiring, tests, README operation docs, and `MCP_TOOL_TEST_SCENARIOS.md` together.
- When changing prompts, update `packages/mcp-server/src/prompts.ts`, prompt tests or docs-consistency tests, and README prompt descriptions together.
- When changing response formatting, verify JSON and TOON behavior and keep lossy or non-round-trippable TOON output falling back to pretty JSON.
- Keep `server.json`, `packages/mcp-server/package.json` `version`/`mcpName`, release-please metadata, and package README aligned during release metadata changes.
- When changing public positioning, badges, directory/trust listings, install commands, npm or GitHub Action names, registry metadata, README discovery links, or agent-facing docs, check whether the website repo in `../local-ydb-toolkit-ui` needs the same update. Typical website sync points are `src/lib/product-data.ts`, `src/lib/agent-markdown.ts`, `src/lib/mcp-server.ts`, the homepage UI, and related tests.
- For website sync work, run the website repo's own checks before handoff: `npm test`, `npm run lint`, `npx tsc --noEmit --incremental false`, and `npm run build`. Deploy the website only when the user asks for deployment or the current task explicitly includes it.
- In completion reports for public-facing changes, state whether the website was updated, checked as not applicable, or left as a follow-up.

## Boundaries
- Always do: Keep public examples generic, run focused tests plus typecheck for TypeScript changes, preserve plan-only behavior for mutating tools, and sync tests/docs with public MCP behavior changes.
- Ask first: Adding dependencies, changing MCP tool names or schemas, changing config defaults, changing `server.json` registry identity, modifying auth or storage behavior, or altering destructive cleanup logic.
- Never do: Commit private hosts, SSH keys, password files, backup paths, local user paths, or real `local-ydb.config*.json` files; edit `node_modules/` or generated `dist/`; remove the `confirm: true` execution gate; expose secrets in JSON, TOON, logs, `content`, or `structuredContent`.

## Documentation
- `README.md` - Install flow, MCP server setup, target profile overview, and operation descriptions.
- `skills/local-ydb/references/` - Operational references for topology, auth hardening, storage migration, verification, and history.
- `MCP_TOOL_TEST_SCENARIOS.md` - Manual scenario coverage for MCP tools.
