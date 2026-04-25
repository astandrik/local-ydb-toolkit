# Auth Hardening Reference

## Target Posture

Recommended hardened posture for demo-style local-ydb deployments:

- internal-only: YDB static-node gRPC `2136`
- internal-only: dynamic-node gRPC ports such as `2137`, `2138`, `2139`
- loopback-only: YDB monitoring backend `127.0.0.1:8765`
- optional public monitoring only through HTTPS reverse proxy
- YDB native auth enabled with `security_config.enforce_user_token_requirement: true`
- monitoring/viewer/admin ACLs restricted to admin SIDs such as `root` and `root@builtin`

This posture intentionally does not provide public direct YDB client access.

## User Credentials

Static username/password examples should use generic placeholders:

```bash
YDB_STATIC_CREDENTIALS_USER=<app-user>
YDB_STATIC_CREDENTIALS_PASSWORD_FILE=/run/secrets/<app-user>.password
YDB_STATIC_CREDENTIALS_AUTH_ENDPOINT=grpc://ydb-local:2136
```

Use environment-variable passwords only as a fallback when a password file is not available. For private-CA TLS, set `YDB_SSL_ROOT_CERTIFICATES_FILE`.

Keep password files, tokens, CA private keys, and host-specific secret paths outside git.

## Dynamic Node Auth

For a mandatory-auth local-ydb dynamic node, `--auth-token-file` is a text protobuf for `NKikimrProto.TAuthConfig`, not a raw access-token file. Two fields matter during startup:

- `NodeRegistrationToken` is used while registering the dynamic node.
- `StaffApiUserToken` is used later when the node fetches dynamic config through `GetNodeConfig`.

The file shape is:

```text
StaffApiUserToken: "<allowed-node-sid>"
NodeRegistrationToken: "<allowed-node-sid>"
```

This can avoid mounting password files into dynamic-node containers when the SID is already allowed by `security_config.register_dynamic_node_allowed_sids`. Certificate-based node authorization is still the stricter production pattern.

To check what SID a username/password token represents without printing the token:

```bash
sudo cat /path/to/root.password | docker exec -i ydb-local bash -lc '
  umask 077
  cat >/tmp/root.password
  /ydb -e grpc://localhost:2136 -d /local \
    --user root \
    --password-file /tmp/root.password \
    auth get-token -f >/tmp/root.token
  /ydbd --server localhost:2136 --token-file /tmp/root.token whoami
  rc=$?
  rm -f /tmp/root.password /tmp/root.token
  exit $rc
'
```

## Rollout Sequence

For production-like changes, use a copied volume first when possible.

1. Save current container definitions and current YDB config.
2. Back up the Docker volume or bind-mounted data directory before patching config.
3. Create or verify users before enforcing auth.
4. Grant application users only the tenant access they need, commonly `ydb.generic.use` on `/local/<tenant>`.
5. Patch YDB config to enforce native auth and tighten viewer, monitoring, admin, bootstrap, and dynamic-node registration SIDs.
6. Stop containers in dependency order: clients, dynamic nodes, static node.
7. Start containers in dependency order: static node, dynamic nodes, clients.
8. Verify tenant state, GraphShard, anonymous denial, and authenticated behavior before declaring success.

Before mutating live config or volumes, provide a rollback plan: previous run commands, previous image tag, volume backup, and config restore point.

## Monitoring Exposure

YDB itself should remain the source of truth for authorization. A reverse proxy may provide HTTPS transport and routing, but do not rely on proxy Basic Auth as the only protection for YDB monitoring data.

If the YDB frontend is proxied under a path prefix, it can call several top-level backend routes. Proxy route families may include:

- `/login`
- `/logout`
- `/viewer`
- `/node/`
- `/storage/`
- `/operation/`
- `/query/`
- `/scheme/`
- `/pdisk/`
- `/vdisk/`

Protected JSON endpoints such as `/viewer/json/tenants` should reject anonymous requests with `401` in the hardened topology. Bearer-token testing against these endpoints may return `Token is not supported`; prefer the built-in YDB UI login flow unless official YDB docs for the deployed version say otherwise.

Observed login shape on some builds:

- `POST /login` accepts JSON with `{"user":"root","password":"..."}`
- cookie-based requests to protected viewer endpoints work after login
- protected endpoints may redirect with `307`; use `curl -L` in scripts

## TLS Findings

Treat public `grpcs` as a separate topology requiring its own runbook, rehearsal, certificates, and rollback plan.

Important findings to verify on the deployed version:

- The default `initialize_local_ydb` entrypoint may not bring up a usable `grpcs` listener for every topology.
- A manual `/ydbd server ... --grpcs-port ...` startup path may be required in rehearsals.
- YDB discovery can fall back to `FQDNHostName()` when public host and public SSL port are not set, causing internal Docker hostnames to be advertised and TLS hostname validation to fail.
- Explicit public host and public gRPCs port may be needed to avoid discovery mismatches.

## Pitfalls

- `security_config.default_users` is bootstrap-oriented; existing volumes need explicit user verification or creation.
- Empty viewer, monitoring, or admin SID lists can be too permissive depending on YDB config semantics. Fill them deliberately.
- Dynamic-node registration can break if `register_dynamic_node_allowed_sids` does not include the SID used by the node registration path.
- In an auth-enabled deployment, a new dynamic node can register successfully and still fail its later config/bootstrap fetch. `Access denied without user token` means no suitable token reached the config fetch path. `Cannot get node config. Access denied. Node is not authorized` means a token reached the path but its SID is not allowed.
- Do not assume `--user root --password-file ...` or a global `--token-file` on `ydbd server` authorizes dynamic config fetch. Validate the current server behavior.
- Do not write `StaffApiUserToken` unquoted or as a raw token file. Generate text protobuf with quoted string values and inspect a redacted copy if parsing fails.
- Do not treat a registered node ID as proof that the node is usable; verify logs, `nodelist`, tenant metadata, and client health.
- When a dynamic-node attempt fails in a restart loop, prefer `docker update --restart=no <name>` followed by `docker stop <name>` to preserve logs. Do not remove working or newly registered containers until the replacement node is healthy.
- `YDB_ANONYMOUS_CREDENTIALS=1` in the static-node environment does not override `security_config.enforce_user_token_requirement: true`, but it is still confusing in docs. Explain the interaction if it remains present.
- Do not expose plaintext YDB gRPC publicly as a convenience shortcut.
