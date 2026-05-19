# Glama Tool Quality Improvement Plan

## Goal

Improve the Glama Tool Definition Quality Score for Local YDB MCP without
changing the server's execution semantics, safety model, public tool names, or
private configuration boundaries.

Glama score page:

```text
https://glama.ai/mcp/servers/astandrik/local-ydb-toolkit/score
```

This plan treats Glama as a discovery and quality-feedback surface. The source
of truth for runtime behavior remains the MCP server implementation in
`packages/mcp-server` and the official MCP Registry metadata in `server.json`.

## Current Facts

- MCP package: `@astandrik/local-ydb-mcp`
- MCP registry name: `io.github.astandrik/local-ydb-mcp`
- Runtime: local `stdio` server run through `npx` or `local-ydb-mcp`
- Hosting attribute in Glama: local-only
- The server starts and has a Glama release.
- Glama reports good server-level coherence, but several individual tools score
  low on Tool Definition Quality.
- Mutating tools are plan-only unless called with `confirm: true`.
- Tool inputs may reference private local paths, SSH targets, password files,
  dump directories, or host-specific config paths.

Observed Glama feedback clusters:

- Missing MCP tool annotations make mutating tools rely entirely on prose to
  explain side effects.
- Several tool descriptions are too short to explain behavior, prerequisites,
  usage context, and alternatives.
- Repeated parameters such as `profile`, `configPath`, and `confirm` are not
  consistently described across input schemas.
- No tools expose an `outputSchema`, so Glama expects descriptions to compensate
  for result interpretation.

## Non-Goals

- Do not rename MCP tools.
- Do not remove or weaken the `confirm: true` execution gate.
- Do not make mutating tools execute by default.
- Do not change command planning, command execution, redaction, auth, storage,
  Docker, SSH, or cleanup behavior just to satisfy a directory score.
- Do not expose the user's active `local-ydb.config.json` as a public resource.
- Do not add remote hosting, HTTP transport, or Docker socket assumptions only
  for Glama.
- Do not include private hostnames, IPs, identity files, password paths, dump
  paths, or user-specific local paths in tool descriptions or examples.

## Safety Principles

- Prefer metadata-only improvements first: descriptions, input schema
  descriptions, and MCP annotations.
- Keep descriptions accurate to plan-first behavior. If a tool returns a plan
  unless `confirm: true`, say that directly.
- For mutating tools, explicitly describe side effects and prerequisites.
- For destructive tools, keep language conservative and make the opt-in nature
  of deletion obvious.
- Use existing tests and add focused metadata tests instead of relying on Glama
  rescan alone.

## Phase 0: Capture Baseline

Status: completed locally.

Record the current Glama grades before edits so changes can be evaluated
against a stable baseline.

Suggested snapshot:

```text
local_ydb_list_versions: A
local_ydb_pull_status: A
local_ydb_scheme: A
local_ydb_set_root_password: A
local_ydb_status_report: A
local_ydb_upgrade_version: A
local_ydb_remove_dynamic_nodes: A
local_ydb_inventory: B
local_ydb_pull_image: B
local_ydb_reduce_storage_groups: B
local_ydb_storage_leftovers: B
local_ydb_apply_auth_hardening: C
local_ydb_cleanup_storage: C
local_ydb_nodes_check: C
local_ydb_permissions: C
local_ydb_prepare_auth_config: C
local_ydb_restart_stack: C
local_ydb_restore_tenant: C
local_ydb_start_dynamic_node: C
local_ydb_storage_placement: C
local_ydb_tenant_check: C
local_ydb_write_dynamic_auth_config: C
```

Acceptance evidence:

- [x] Baseline grades are copied from Glama after the latest release is indexed.
- [x] Current tool list is compared with `localYdbTools` so no tool is missed.

Risk:

- Low. Observation only.

## Phase 1: Centralize Common Input Descriptions

Status: completed locally.

Add shared helpers for common input schema properties in
`packages/mcp-server/src/tools/input-schemas.ts`.

Recommended shared properties:

| Property | Description intent |
| --- | --- |
| `profile` | Named profile from `local-ydb.config.json`; defaults to `config.defaultProfile`. |
| `configPath` | Optional config file path for this call; allows switching configs without restarting the MCP server. |
| `confirm` | Must be `true` to execute planned commands; omitted or `false` returns plan-only output. |

Then replace ad hoc or empty definitions in all schema builders:

- `logsSchema`
- `pullImageSchema`
- `mutatingSchema`
- `addDynamicNodesSchema`
- `addStorageGroupsSchema`
- `reduceStorageGroupsSchema`
- `destroyStackSchema`
- `removeDynamicNodesSchema`
- `dumpSchema`
- `upgradeVersionSchema`
- `restoreSchema`
- `authHardeningSchema`
- `prepareAuthConfigSchema`
- `dynamicAuthConfigSchema`
- `setRootPasswordSchema`
- `cleanupSchema`

Acceptance evidence:

- [x] Every input property in `localYdbTools` has a non-empty `description`
  unless there is a deliberate documented exception.
- [x] Tests cover this as metadata, for example by iterating over
  `localYdbTools` and checking `tool.inputSchema.properties`.
- [x] `npm test -- packages/mcp-server/test/tools.test.ts` passes.

Risk:

- Low. This changes MCP metadata, not parsing or execution.

## Phase 2: Add MCP Tool Annotations

Status: completed locally.

Extend the tool definition model in
`packages/mcp-server/src/tools/registry.ts` so each tool can include MCP
`annotations`.

The SDK supports these hints:

```ts
{
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
```

Recommended defaults:

| Tool class | Annotation guidance |
| --- | --- |
| Pure checks and status tools | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |
| Registry/image lookup status | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |
| Plan-first mutating tools | `readOnlyHint: false`, `openWorldHint: true`; set `destructiveHint` by actual risk |
| Prompt-like planning helpers | Keep as tools only if they already are tools; do not invent annotations for prompts |

Suggested destructive hints:

| Tool | `destructiveHint` |
| --- | --- |
| `local_ydb_destroy_stack` | `true` |
| `local_ydb_cleanup_storage` | `true` |
| `local_ydb_reduce_storage_groups` | `true` |
| `local_ydb_remove_dynamic_nodes` | `true` |
| `local_ydb_restore_tenant` | `true` |
| `local_ydb_upgrade_version` | `true` |
| `local_ydb_set_root_password` | `false` or `true` only if treating credential rotation as destructive |
| bootstrap, create tenant, add nodes, add storage, restart, auth hardening | `false`, but describe side effects in prose |

Acceptance evidence:

- [x] `localYdbTools` includes annotations for every tool.
- [x] Read-only tools are marked read-only.
- [x] Tools that remove data, rebuild stacks, restore dumps, or tear down
  containers are marked destructive.
- [x] Tests verify annotations exist and match expected high-risk tools.
- [x] `npm test -- packages/mcp-server/test/tools.test.ts` passes.

Risk:

- Low to medium. Annotations are hints, but clients may use them to shape UX.
  Keep them accurate and conservative.

## Phase 3: Improve C-Grade Tool Descriptions

Status: completed locally for the initial C-grade target set.

Rewrite the lowest-scoring tool descriptions first. Keep each description short
enough for tool selection, but include:

- Purpose: what the tool does.
- Usage: when to choose it and when to choose a related tool instead.
- Behavior: whether it is read-only, plan-first, mutating, disruptive, or
  destructive.
- Parameters: any non-obvious parameter relationship or default.
- Result: what the caller should expect to get back.

Initial target tools:

- `local_ydb_apply_auth_hardening`
- `local_ydb_cleanup_storage`
- `local_ydb_nodes_check`
- `local_ydb_permissions`
- `local_ydb_prepare_auth_config`
- `local_ydb_restart_stack`
- `local_ydb_restore_tenant`
- `local_ydb_start_dynamic_node`
- `local_ydb_storage_placement`
- `local_ydb_tenant_check`
- `local_ydb_write_dynamic_auth_config`

Example rewrite pattern:

```text
Start the configured dynamic tenant node for an existing CMS tenant. Use after
local_ydb_create_tenant or when admin database status is PENDING_RESOURCES; use
local_ydb_add_dynamic_nodes for extra nodes. Without confirm=true this returns a
plan only; with confirm=true it starts a Docker container and verifies node
readiness.
```

Acceptance evidence:

- [x] Each C-grade tool description explicitly mentions read-only or
  `confirm=true` behavior.
- [x] Each mutating tool description names the main side effect.
- [x] Related-tool guidance is present where Glama called out ambiguity.
- [x] Tests assert minimum description coverage without requiring exact wording.
- [x] `npm test -- packages/mcp-server/test/tools.test.ts` passes.

Risk:

- Low to medium. Descriptions influence agent choices. Avoid overselling safety
  or implying execution behavior that the code does not implement.

## Phase 4: Add Optional Output Schemas Only If Useful

Status: deferred.

Glama notes missing output schemas, but adding broad output schemas for every
tool may create a maintenance burden if the returned MCP content is mostly
textual or intentionally operation-specific.

Start only if Phase 1-3 are not enough.

Candidate approach:

- Add a shared, conservative object output schema for operation-plan style
  tools only if the actual returned structured content is stable.
- Do not add inaccurate schemas just to satisfy scoring.
- Prefer documenting returned plan/verification text in descriptions when the
  output is not stable enough for a schema.

Acceptance evidence:

- [ ] Output schema matches actual tool results in tests.
- [ ] No output schema claims structured fields that can be omitted in real
  failures or partial results.

Risk:

- Medium. Incorrect output schemas are worse than no output schema because they
  mislead clients and agents.

## Phase 5: Release and Rescan

Status: local verification completed; release and Glama rescan are pending.

After metadata changes are merged:

1. Run local checks:

```bash
npm test
npm run typecheck
npm run build
```

2. Publish through the existing release flow.
3. Confirm npm latest contains the updated tool metadata.
4. Publish or update Official MCP Registry metadata only if package/server
   version changed.
5. Trigger or wait for Glama rescan.
6. Compare new Glama tool grades to the Phase 0 baseline.

Acceptance evidence:

- [ ] `npm view @astandrik/local-ydb-mcp version` matches the released package.
- [ ] Glama schema page shows non-empty descriptions for common parameters.
- [ ] Glama tool pages show annotations or stop flagging missing behavioral
  disclosure for mutating tools.
- [ ] Most former C-grade tools move to B or A.

Risk:

- Low. Release mechanics are already established, but Glama indexing may lag.

## Rollback

If a metadata change causes bad client behavior:

1. Revert the metadata commit.
2. Publish a patch release.
3. Republish official registry metadata for the patch version.
4. Ask Glama to rescan or wait for the next sync.

If only the Glama score does not improve:

- Keep accurate metadata if it helps real agents.
- Do not chase score-only changes that weaken safety or make descriptions
  misleading.

## Verification Checklist

- [x] `npm test -- packages/mcp-server/test/tools.test.ts`
- [x] `npm test`
- [x] `npm run typecheck`
- [x] `npm run build`
- [ ] `mcp-publisher validate server.json` if server version changes
- [ ] Manual Glama rescan or delayed score recheck

## References

- Glama score page:
  `https://glama.ai/mcp/servers/astandrik/local-ydb-toolkit/score`
- Glama TDQS article:
  `https://glama.ai/blog/2026-04-03-tool-definition-quality-score-tdqs`
- MCP SDK tool annotations source:
  `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts`
