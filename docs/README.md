# Mintlify documentation source

Mintlify builds the public documentation from this directory.

Deployment settings:

- repository: `astandrik/local-ydb-toolkit`
- deployment branch: `main`
- monorepo documentation path: `/docs`

Use the reviewed CLI version without adding it to the repository dependency graph:

```bash
npx --yes mint@4.2.804 validate --telemetry false
npx --yes mint@4.2.804 broken-links --telemetry false
npx --yes mint@4.2.804 a11y --telemetry false
npx --yes mint@4.2.804 dev --no-open
```

Review upstream release notes, package metadata, and the resulting validation
output before changing the pin. The initial `4.2.804` install reports deprecated
transitive packages, including `inflight`, `glob@7`, `prebuild-install@7`, and
`puppeteer@24.3.1`; none are added to this repository's manifests or lockfile.

The public documentation MCP is generated at `/mcp` on the deployed docs domain
and is read-only. The separate `https://mcp.mintlify.com` OAuth server can edit
documentation and create pull requests. Treat that server as write-capable,
scope it to this deployment, and review every resulting diff before merge.

Changing the GitHub App repository scope, deployment branch, monorepo path,
custom domain, or OAuth connection is an external control-plane action. Inspect
the exact target and retain the disconnect or revoke path before changing it.
