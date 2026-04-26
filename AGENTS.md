# local-ydb-toolkit - Agent Instructions

## Build & Run
- `npm install` - Install workspace dependencies from `package-lock.json`.
- `npm run build` - Build `@local-ydb-toolkit/core` and then `@astandrik/local-ydb-mcp`.
- `npm run build -w @local-ydb-toolkit/core` - Build only the core package.
- `npm run build -w @astandrik/local-ydb-mcp` - Build only the MCP server package.
- `npm run typecheck` - Type-check all workspaces with package-specific `tsconfig.typecheck.json` files.
- `node packages/mcp-server/dist/index.js` - Start the stdio MCP server after a successful build.

## Overview
This repository contains a reusable Codex skill for operating `local-ydb` deployments plus a TypeScript npm workspace that exposes the same operations through a local stdio MCP server. The runtime package is split between a core operation library and an MCP server wrapper.

## Testing
- `npm test` - Run all Vitest tests matching `packages/**/*.test.ts`.
- `npm test -- packages/core/test/validation.test.ts` - Run one core test file.
- `npm test -- packages/mcp-server/test/tools.test.ts` - Run one MCP server test file.
- `npm test -- -t "config validation"` - Run tests matching a Vitest name pattern.

Run `npm test` and `npm run typecheck` before handing off TypeScript changes.

## Project Structure
- `packages/core/` - TypeScript library for config validation, command execution, local-ydb checks, and mutating operation plans.
- `packages/mcp-server/` - Stdio MCP server that registers public `local_ydb_*` tools and delegates to `@local-ydb-toolkit/core`.
- `skills/local-ydb/` - Codex skill content, references, agent metadata, scripts, and assets.
- `examples/local-ydb.config.example.json` - Example local and SSH target profiles; keep real secrets and host details out of committed configs.
- `MCP_TOOL_TEST_SCENARIOS.md` - Manual MCP tool scenarios.
- `vitest.config.ts` - Vitest configuration and workspace alias for `@local-ydb-toolkit/core`.

## Code Style
- Use strict TypeScript with ES modules and `NodeNext`; relative TypeScript imports include the emitted `.js` suffix.
- Validate boundary inputs with Zod and keep exported operation response types explicit.
- Keep mutating operations plan-first: tools return planned commands unless `confirm: true` is supplied.
- Redact password files, identity files, and other sensitive paths before returning command text.

### Example
```ts
export interface OperationPlan {
  risk: "low" | "medium" | "high";
  plannedCommands: string[];
  rollback: string[];
  verification: string[];
}
```

## Boundaries
- Always do: Keep public examples generic, run focused tests plus typecheck for TypeScript changes, and preserve plan-only behavior for mutating tools.
- Ask first: Adding dependencies, changing MCP tool names or schemas, changing config defaults, modifying auth or storage behavior, or altering destructive cleanup logic.
- Never do: Commit private hosts, SSH keys, password files, backup paths, or local user paths; edit `node_modules/` or generated `dist/`; remove the `confirm: true` execution gate.

## Documentation
- `README.md` - Install flow, MCP server setup, target profile overview, and operation descriptions.
- `skills/local-ydb/references/` - Operational references for topology, auth hardening, storage migration, verification, and history.
- `MCP_TOOL_TEST_SCENARIOS.md` - Manual scenario coverage for MCP tools.
