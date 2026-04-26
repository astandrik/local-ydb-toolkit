# MCP Server Package - Agent Instructions

## Build & Run
- `npm run build` - Compile `src/index.ts` to `dist/index.js`.
- `npm run typecheck` - Type-check server source, tests, and the referenced core source without emitting files.
- `cd ../.. && npm run build -w @local-ydb-toolkit/mcp-server` - Build this workspace from the repo root.
- `node dist/index.js` - Start the stdio MCP server after building from this package directory.

## Overview
`packages/mcp-server` exposes local-ydb operations as MCP tools. It owns tool names, JSON input schemas, request handlers, stdio server startup, and test-only helper access to tool handlers.

## Testing
- `cd ../.. && npm test -- packages/mcp-server/test/tools.test.ts` - Run MCP tool registration and handler tests.
- `cd ../.. && npm test -- -t "mcp tools"` - Run tests matching the MCP tools suite.
- `cd ../.. && npm run typecheck -w @local-ydb-toolkit/mcp-server` - Type-check this workspace from the repo root.

## Project Structure
- `src/index.ts` - Server construction, tool definitions, argument schemas, handlers, result formatting, and CLI entry point.
- `test/tools.test.ts` - Vitest tests for public tool registration, plan-only behavior, and server instructions.
- `package.json` - Declares the `local-ydb-mcp` bin at `./dist/index.js`.

## Code Style
- Keep MCP argument validation near the tool schema it supports.
- Parse handler arguments with Zod before calling core operations.
- Return both human-readable `content` and machine-readable `structuredContent`.
- Keep public tool names stable and prefixed with `local_ydb_`.

### Example
```ts
const MutatingArgs = ProfileArgs.extend({
  confirm: z.boolean().optional()
});

function mutatingSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      confirm: { type: "boolean", description: "Must be true to execute commands. Omit or false for plan-only output." }
    },
    additionalProperties: false
  };
}
```

## Boundaries
- Always do: Update `localYdbTools`, `handlers`, schemas, and `test/tools.test.ts` together when adding or changing a tool.
- Ask first: Renaming/removing a public MCP tool, changing result shapes, changing server instructions, or adding dependencies.
- Never do: Execute mutating operations without the core `confirm: true` gate, expose secrets in `content` or `structuredContent`, or drop `additionalProperties: false` from tool schemas without a compatibility reason.
