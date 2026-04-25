---
name: local-ydb
description: Operate local-ydb deployments, especially Docker setups using ghcr.io/ydb-platform/local-ydb, CMS-created tenants, GraphShard metrics, dynamic nodes, YDB static credentials, auth hardening, monitoring exposure, storage pool changes, single-disk rebuilds, rollback planning, upstream ydb-platform/ydb source lookup through gh api, and troubleshooting local-ydb readiness, TLS, anonymous access, or viewer/json graph endpoints.
---

# Local YDB

## Purpose

Use this skill to inspect, document, run, harden, or troubleshoot `local-ydb` deployments. Keep reusable operational recipes separate from one-off cutover notes, host paths, timestamps, and secrets.

## First Steps

1. Identify the task type: documentation cleanup, local bootstrap, live inspection, auth hardening, storage expansion, monitoring exposure, TLS investigation, or troubleshooting.
2. Determine whether the target is repo documentation, a local Docker stack, or a live remote host. Treat live Docker/YDB changes as medium to high risk; collect read-only state first and ask before destructive or externally visible mutations.
3. Check nearby project docs before editing reusable runbooks. Prefer existing setup, runbook, and auth notes over inventing a new topology.
4. Keep secrets and private host details out of public docs and skill output. Use placeholders for password files, private keys, IPs, domains, users, and backup paths unless the user explicitly asks for private operational notes.

## Reference Selection

- Read `references/topology.md` when starting or documenting static nodes, dynamic nodes, tenants, GraphShard, storage pools, or upstream YDB source lookups.
- Read `references/auth-hardening.md` when working on mandatory auth, static username/password credentials, monitoring access, reverse-proxy exposure, or TLS.
- Read `references/storage-migration.md` when adding PDisks, changing storage placement, moving storage onto one physical disk, creating replacement tenants, migrating data, decommissioning groups, reclaiming space, cleaning old Docker volumes/PDisks/dumps, or debugging why UI and BSC disagree about storage.
- Read `references/verification.md` when checking health, tenant state, GraphShard, graph data, storage, or auth behavior.
- Read `references/history-and-non-goals.md` when cleaning docs, deciding what is reusable versus artifact noise, or reconciling stale hardening plans with final topology.

## Core Rules

- Do not assume `/local` has GraphShard. `YDB_FEATURE_FLAGS=enable_graph_shard` is necessary but not sufficient; use a CMS-created tenant such as `/local/<tenant>`.
- Do not create GraphShard tenants with SQL. Use the public CMS gRPC API.
- When `local-ydb` behavior is unclear, search upstream `ydb-platform/ydb` source with `gh api search/code` and read matching files through `gh api repos/ydb-platform/ydb/contents/...`; use pinned commits from project docs when matching documented proto shapes.
- Do not hardcode dynamic node IDs. Discover them through monitoring/node-list APIs.
- Do not treat `POSTGRES_USER` or `POSTGRES_PASSWORD` as native YDB gRPC protection. They are for PostgreSQL compatibility.
- Do not publish YDB gRPC publicly unless the user explicitly requests that topology and accepts the risk. The hardened default is YDB gRPC internal-only, with monitoring exposed only through a protected HTTPS reverse proxy when needed.
- Do not claim anonymous `viewer/json` commands work after mandatory auth. In a hardened topology anonymous `viewer/json` should return `401`; commands need an authenticated UI/session path or must be marked as pre-auth/local-dev examples.
- When adding dynamic nodes to a mandatory-auth deployment, start one new node first, verify it reaches `nodelist`, then add the next. If a new node registers but cannot fetch dynamic config, preserve evidence and stop the broken container; do not delete working or recently registered containers before a replacement is healthy.
- Do not reuse an old data volume for an in-place version upgrade unless the upgrade has been rehearsed on a copy.
- Do not assume `admin database ... status` or UI `StorageGroups` means groups are physically placed where you want them. Use BSC `QueryBaseConfig` to confirm actual `Group -> PDisk` placement.
- Do not assume `DecommitGroups` reduces tenant storage allocation. It changes physical/virtual group state; it does not shrink `hdd:N/N`.
- Do not assume `storage_units_to_remove` is a working runtime path just because it exists in public proto. Verify current server-side implementation before using it on live YDB.
- Do not remove or recreate a PDisk file just because tenant groups were moved away from it. Root or scheme state may still live there.
- Do not treat `ReassignGroupDisk` success or `OperatingStatus: FULL` alone as proof that a live tenant survived a storage move. After any group movement, verify tenant metadata with `scheme ls`, `scheme describe`, and small table reads before touching the next group.
- For "put all storage on disk X" requests, prefer dump + fresh single-disk rebuild + restore over live `ReassignGroupDisk` for non-empty tenant groups. Delete old disks only after restored counts, metadata reads, auth, and BSC placement all pass.
- Before declaring old storage deleted, check both bind-mounted paths and Docker volumes. Old local-ydb volumes can use more than one historical name.
- When using `ghcr.io/ydb-platform/local-ydb` as a helper container for `ydb tools restore`, override the image entrypoint to `/bin/bash`. The default `local_ydb` entrypoint does not execute arbitrary shell restore scripts.
- Do not commit secret material, live password-file paths, private backup paths, or one-off remote-host cutover logs into reusable docs.

## Output Style

For docs cleanup, split content into:

- reusable runbook: topology, commands, verification, caveats;
- private or historical notes: timestamps, concrete backup paths, rehearsal logs, lockouts, failed experiments;
- explicit non-goals: public direct YDB gRPC, production TLS, automatic migrations, or one-off host assumptions.

For live operations, provide a short plan with impact and rollback before changing containers, volumes, YDB config, auth settings, storage pools, or public networking.
