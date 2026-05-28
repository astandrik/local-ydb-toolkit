# local-ydb Diagnostics Coverage

This audit covers the current local-ydb-toolkit diagnostic surface against upstream YDB diagnostics that are practical for Docker-based `local-ydb` targets.

## Summary

The toolkit already covers the local operational layer well: Docker inventory and logs, tenant status, scheme reachability, dynamic node registration, GraphShard visibility, auth posture, storage pool placement, and storage leftovers.

The main missing database-level signal was YDB's built-in self-diagnostic healthcheck. That gap is now covered by `local_ydb_healthcheck`, which wraps `ydb monitoring healthcheck --format json` and returns `selfCheckResult`, issue counts, issue types, capped raw output, and bounded issue details.

## Coverage Matrix

| Upstream diagnostic area | Toolkit coverage | Gap before this change | Action |
| --- | --- | --- | --- |
| YDB SelfCheck / `monitoring healthcheck` | `local_ydb_healthcheck`; included in `local_ydb_status_report` | No first-class tool for official database health status or issue hierarchy | Added read-only tool and database diagnostics prompt |
| Docker process and log state | `local_ydb_inventory`, `local_ydb_container_logs` | Covered for configured static and primary dynamic containers | Keep as first local-runtime checks |
| Tenant and database status | `local_ydb_database_status`, `local_ydb_tenant_check`, `local_ydb_status_report` | Covered, but `status_report` lacked official health status | Additive healthcheck field in status report |
| Scheme and metadata inspection | `local_ydb_scheme`, `local_ydb_permissions` | Covered for list/describe and ACL diagnostics | No change |
| Dynamic node registration | `local_ydb_nodes_check` using viewer nodelist and tenantinfo | Covered for local tenant topology | No change |
| GraphShard capability and tablet visibility | `local_ydb_graphshard_check` | Covered for configured tenant | No change |
| Auth posture | `local_ydb_auth_check` plus auth workflow prompts | Covered for anonymous viewer and configured CLI access | No change |
| Storage pool and physical placement | `local_ydb_storage_placement`, `local_ydb_storage_leftovers` | Covered for BSC placement and local leftovers | No change |
| Metrics and Embedded UI charts | Viewer JSON probes, GraphShard checks, monitoring URL in profile | No full Prometheus/Grafana setup or metric browser | Follow-up only; keep toolkit focused on targeted diagnostics |
| Query performance and plans | `local_ydb_apply_schema` validation; official `ydb/ydb-mcp` recommended for SQL/query tools | No deep query-plan analysis or tracing wrapper | Out of scope for local-ydb operations server; use official YDB MCP or YDB CLI |
| DStool disk operations | Storage placement/read-only BSC inspection | No wrappers for broader cluster disk repair or mutating DStool operations | Out of scope for v1; local-ydb storage mutation stays plan-first and narrow |
| ydbops cluster maintenance | Restart/bootstrap/upgrade tools for local-ydb profiles | No generic cluster maintenance orchestration | Out of scope; this toolkit targets Docker local-ydb stacks |

## Diagnostic Flow

Start broad and read-only:

1. `local_ydb_check_prerequisites` on a new host or profile.
2. `local_ydb_status_report` to capture Docker, auth, tenant, nodes, and health context.
3. `local_ydb_healthcheck` with `noCache: true` only when the user needs a fresh server-side self-check.

Then route by healthcheck issue type:

- `STORAGE`: run `local_ydb_storage_placement`, then inspect static/dynamic logs.
- `COMPUTE`, `COMPUTE_POOL`, tablet-related issues: run `local_ydb_nodes_check`, `local_ydb_tenant_check`, and dynamic logs.
- `DATABASE` or scheme symptoms: run `local_ydb_database_status` and `local_ydb_scheme`.
- Auth symptoms: run `local_ydb_auth_check`.

Do not repair automatically from diagnostics. Mutating tools remain plan-first and require `confirm: true`.

## References

- YDB CLI healthcheck documentation: https://github.com/ydb-platform/ydb/blob/main/ydb/docs/en/core/reference/ydb-cli/commands/monitoring-healthcheck.md
- YDB Health Check API: https://github.com/ydb-platform/ydb/blob/main/ydb/docs/en/core/reference/ydb-sdk/health-check-api.md
- YDB Monitoring API proto: https://github.com/ydb-platform/ydb/blob/main/ydb/public/api/protos/ydb_monitoring.proto
- YDB Monitoring gRPC service proto: https://github.com/ydb-platform/ydb/blob/main/ydb/public/api/grpc/ydb_monitoring_v1.proto
