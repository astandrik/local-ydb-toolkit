# Core Package - Agent Instructions

## Build & Run
- `npm run build` - Compile `src/**/*.ts` to `dist/` for this package.
- `npm run typecheck` - Type-check `src/**/*.ts` and `test/**/*.ts` without emitting files.
- `cd ../.. && npm run build -w @local-ydb-toolkit/core` - Build this workspace from the repo root.
- `cd ../.. && npm run typecheck -w @local-ydb-toolkit/core` - Type-check this workspace from the repo root.

## Overview
`packages/core` is the reusable TypeScript operation library. It owns local-ydb profile validation, command execution, Docker/YDB API parsing, safety checks, and the plan-or-execute behavior used by the MCP server.

## Testing
- `cd ../.. && npm test -- packages/core/test/validation.test.ts` - Run config validation tests.
- `cd ../.. && npm test -- packages/core/test/api-client.test.ts` - Run command/API parsing tests.
- `cd ../.. && npm test -- packages/core/test/operations.test.ts` - Run operation planning tests.
- `cd ../.. && npm test -- -t "mutating operations"` - Run tests matching a Vitest name pattern.

## Project Structure
- `src/index.ts` - Public barrel export for the package.
- `src/validation.ts` - Zod config schemas, defaults, profile normalization, and config loading.
- `src/api-client.ts` - Command specs, command execution, redaction, shell rendering, and local-ydb API parsing.
- `src/auth.ts` - Redaction and auth-related helpers.
- `src/operations.ts` - Public operation exports.
- `src/operations/` - Checks, stack lifecycle, tenant, storage, auth, dynamic-node, and shared operation helpers.
- `test/` - Vitest coverage for schemas, parsers, and operation planning behavior.

## Code Style
- Keep exported interfaces explicit and colocated with the operation surface they describe.
- Use `unknown` at external boundaries, then narrow with Zod or small type guards.
- Prefer typed command specs over concatenating command strings at call sites; use redactions for sensitive values.
- Use plan helpers (`runMutating`, `planOnly`) instead of open-coding mutating operation responses.

### Example
```ts
export function normalizeProfile(name: string, profile: LocalYdbProfile): ResolvedLocalYdbProfile {
  const monitoringBaseUrl = profile.monitoringBaseUrl === "http://127.0.0.1:8765" && profile.ports.monitoring !== 8765
    ? `http://127.0.0.1:${profile.ports.monitoring}`
    : profile.monitoringBaseUrl;
  return {
    ...profile,
    monitoringBaseUrl,
    name,
    dynamicContainer: profile.dynamicContainer ?? `ydb-dyn-${sanitizeTenantName(profile.tenantPath)}`
  };
}
```

## Boundaries
- Always do: Preserve redaction of secrets, keep destructive targets guarded by validation, and add or update operation tests for behavior changes.
- Ask first: Changing `ConfigSchema` defaults, changing public exported types, changing command execution semantics, or broadening cleanup target rules.
- Never do: Return unredacted password or identity-file paths, bypass `confirm: true` for mutating operations, or loosen unsafe cleanup protections.
