# Agent Context Architecture

`local-ydb-toolkit` is structured as a small, reusable context layer for coding agents. The goal is progressive disclosure: give the agent enough routing context to choose the right material, then let it load deeper references and live state only when the task needs them.

## Layers

`skills/local-ydb/SKILL.md` is the routing layer. It defines when the skill applies, which reference file to read for each task type, and the core safety rules that should stay in context.

`skills/local-ydb/references/` holds deeper task-specific context. Topology, auth hardening, storage migration, verification, history, and MCP tool scenarios live in separate files so agents do not need to load every runbook for every request.

The MCP server is the live-state and verification layer. Read-only tools inspect inventory, status, logs, schema, permissions, nodes, GraphShard, auth posture, storage placement, leftover storage, image tags, and image-pull jobs. Mutating tools return an explicit plan unless `confirm: true` is supplied.

## Workflow

The intended agent flow is:

1. Read `SKILL.md` to identify the task type and safety constraints.
2. Open only the reference files selected by that task.
3. Use read-only MCP tools to establish current state before changing anything.
4. For mutations, inspect the plan-only response first.
5. Execute with `confirm: true` only after the plan, rollback notes, and verification steps match the target.
6. Verify through MCP tools or documented checks before reporting completion.

## Safety Model

Static docs describe reusable operational knowledge. MCP tools provide current state. Mutating operations stay plan-first so an agent can reason about commands, risk, rollback, and verification before touching Docker, YDB, auth files, storage, or remote hosts.

This keeps the context portable across agent harnesses while avoiding one large prompt that becomes stale, hard to search, and hard to test.
