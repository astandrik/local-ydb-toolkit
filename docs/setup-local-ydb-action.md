# GitHub Action: setup-local-ydb

## Summary

Create a separate public repository, `astandrik/setup-local-ydb`, for a GitHub Action that boots a `local-ydb` Docker stack for CI jobs. Keep `local-ydb-toolkit` focused on the Codex skill, core operation library, and MCP server; add only a README badge and a short "Use in GitHub Actions CI" section here.

The action should be a JavaScript action, not a Docker action. It needs to control Docker on the runner host, start `ghcr.io/ydb-platform/local-ydb`, wait for readiness, create a `/local/<tenant>` database, optionally apply native YDB auth, run health checks, and expose endpoint/database values to following workflow steps.

## Key Decisions

- Repository: `astandrik/setup-local-ydb`, public, with root-level `action.yml`.
- Marketplace shape: unique action name and clean action repository identity; avoid mixing this with the existing MCP/npm release workflows.
- Runtime: JavaScript action using `node20` for broad GitHub Actions compatibility.
- Initial scope: Linux GitHub-hosted and Linux self-hosted runners with Docker available.
- Out of scope for v1: SSH profiles, MCP tool wrappers, TOON output, storage migration, version upgrade, dump/restore, and remote-host operations.
- Default image: use an exact `local-ydb` tag by default, currently `ghcr.io/ydb-platform/local-ydb:26.1.1.6`.
- `version: latest`: support only as explicit opt-in and expose the resolved tag as an output.

## Public Interface

Example usage:

```yaml
- uses: astandrik/setup-local-ydb@v1
  id: ydb
  with:
    version: 26.1.1.6
    tenant: /local/test
```

Add `auth: true` when the CI job needs native YDB auth behavior.

Inputs:

- `version`: exact `local-ydb` tag or `latest`; default `26.1.1.6`.
- `tenant`: tenant database path; default `/local/test`.
- `auth`: boolean; default `false`.
- `cleanup`: boolean; default `true`; removes action-created Docker resources in the post step.
- `static-grpc-port`: optional host port; auto-select a free port when omitted.
- `dynamic-grpc-port`: optional host port; auto-select a free port when omitted.
- `monitoring-port`: optional host port; auto-select a free port when omitted.
- `container-prefix`: optional; default derived from GitHub run/job identifiers to avoid collisions on reused runners.

Outputs:

- `endpoint`: dynamic tenant endpoint, for example `grpc://127.0.0.1:<dynamic-port>`.
- `static-endpoint`: root endpoint, for example `grpc://127.0.0.1:<static-port>`.
- `database`: tenant path.
- `monitoring-url`: loopback monitoring URL.
- `image`: full Docker image reference.
- `resolved-version`: concrete tag used by the run.
- `username`: only when `auth: true`.
- `password-file`: only when `auth: true`; never output the password value.

Environment written through `GITHUB_ENV`:

- `LOCAL_YDB_ENDPOINT`
- `LOCAL_YDB_DATABASE`
- `LOCAL_YDB_MONITORING_URL`
- `LOCAL_YDB_USER` when auth is enabled.
- `LOCAL_YDB_PASSWORD_FILE` when auth is enabled.

## Implementation Plan

1. Create `astandrik/setup-local-ydb` with TypeScript source, `action.yml`, bundled `dist/`, README, license, and a small release process based on tags.
2. Implement `src/main.ts` as a thin CI wrapper around the existing `local-ydb-toolkit` behavior:
   - validate inputs;
   - verify Docker is available;
   - resolve image/version;
   - allocate ports when omitted;
   - build a temporary local profile;
   - bootstrap the tenant topology;
   - optionally prepare and apply auth hardening;
   - run health checks;
   - write outputs and `GITHUB_ENV`.
3. Reuse core operation semantics from `local-ydb-toolkit`; do not reuse the MCP server layer. Current relevant sources are:
   - defaults and profile validation in `packages/core/src/validation.ts`;
   - tenant bootstrap in `packages/core/src/operations/stack.ts`;
   - auth hardening in `packages/core/src/operations/auth-operations.ts`.
4. Decide packaging before implementation:
   - fastest path: vendor or bundle the needed core runtime into the action `dist`;
   - cleaner long-term path: publish `@local-ydb-toolkit/core` as a public npm package and depend on a pinned version.
5. Implement `src/post.ts` cleanup:
   - remove dynamic container;
   - remove static container;
   - remove Docker network;
   - remove Docker volume;
   - leave resources intact when `cleanup: false`.
6. Add failure diagnostics:
   - grouped `docker ps -a`;
   - static and dynamic container logs tail;
   - last readiness command and stderr;
   - redaction for password file paths and secret values.
7. Update this repository with:
   - README badge/link to `astandrik/setup-local-ydb`;
   - short "Use in GitHub Actions CI" section;
   - example workflow with an exact version and unauthenticated quick start;
   - optional dogfood smoke workflow outside the action repository.

## Test Plan

Unit tests:

- input parsing for booleans, tenant path, ports, and `latest`;
- generated profile/container/network/volume names;
- output and environment writing for auth and non-auth modes;
- cleanup plan behavior when `cleanup` is true or false;
- redaction of password values and sensitive paths.

Dry-run operation tests:

- unauthenticated tenant bootstrap;
- authenticated tenant bootstrap;
- custom tenant path;
- custom and auto-selected ports;
- action failure diagnostics.

Smoke tests before `v1`:

- `auth: false` on `ubuntu-latest` boots `/local/test` and `scheme ls` succeeds.
- `auth: true` on `ubuntu-latest` boots `/local/test`, anonymous viewer returns `401`, and authenticated metadata checks succeed.
- post cleanup removes all action-created Docker resources.

## Risks And Defaults

- Prefer exact YDB image tags. Floating aliases can disappear or change behavior unexpectedly.
- Keep all exposed ports bound to `127.0.0.1`.
- Do not output raw passwords, tokens, private paths, or full auth config.
- Do not support SSH profiles in v1; CI users need a local service on the runner.
- Treat auth support as useful but optional. The minimal successful v1 is a reliable unauthenticated local CI database with a clear path to auth.
