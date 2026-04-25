# History and Non-Goals Reference

## Reusable Knowledge

Keep these facts in reusable docs:

- `/local` does not automatically get GraphShard.
- `/local/<tenant>` should be CMS-created when GraphShard-backed charts are required.
- Dynamic nodes may need `--network container:ydb-local` in generated-config topologies.
- Graph data should be requested through `/node/<dynamic-node-id>/viewer/json/graph`.
- `POSTGRES_USER` and `POSTGRES_PASSWORD` do not protect native YDB gRPC.
- Do not hardcode dynamic node IDs.
- Rehearse volume upgrades and auth hardening on a copy first.
- Verify physical storage placement through BSC before deleting old PDisks or volumes.

## Artifact Noise

Move these out of reusable runbooks unless writing private operational history:

- timestamped backup directories
- concrete password-file host paths
- personal home-directory paths
- one-off remote IP checks
- rehearsal container names that no longer exist
- old image tags used only during cutover
- exact lockout or password drift incidents
- shell transcripts that only prove a past investigation
- application-specific table names, image names, and health endpoints

## Known Stale Claims

Audit docs for these stale or contradictory claims:

- Plans to expose public direct YDB gRPC over TLS may be obsolete if the final hardened topology intentionally keeps YDB gRPC internal-only.
- Commands using unauthenticated `/viewer/json` conflict with mandatory auth unless marked as local-dev/pre-auth examples.
- Old storage allocation counts can become stale after pool expansion or rebuilds.
- App-specific smoke checks do not prove YDB tenant metadata or storage placement.

## Recommended Hardened Outcome

A generic hardened local-ydb deployment usually means:

- YDB monitoring UI only through protected HTTPS reverse proxy if public exposure is needed
- YDB-enforced admin auth for monitoring and admin operations
- YDB gRPC internal-only by default
- explicit users and grants for any clients
- no committed passwords, tokens, private keys, hostnames, IPs, or one-off cutover logs

Do not assume safe public direct YDB client access exists.

## Documentation Cleanup Pattern

When cleaning `local-ydb` docs:

1. Keep the public runbook focused on commands, invariants, and checks a future operator can reuse.
2. Move rollout narratives and dead-end experiments to a single context summary or private ops note.
3. Replace concrete secrets, host paths, IPs, domains, and users with placeholders.
4. Mark unauthenticated commands as local-dev only if the hardened topology requires auth.
5. State non-goals explicitly instead of leaving contradicted old plans in place.
