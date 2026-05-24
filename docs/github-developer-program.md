# GitHub Developer Program Artifact

## setup-local-ydb

- Type: GitHub Action published on GitHub Marketplace.
- Purpose: provision a disposable local YDB tenant for GitHub Actions CI jobs.
- Repository: https://github.com/astandrik/setup-local-ydb
- Marketplace: https://github.com/marketplace/actions/setup-local-ydb
- Stable major tag: `astandrik/setup-local-ydb@v1`
- Immutable release: `astandrik/setup-local-ydb@v1.0.0`
- Support channel: GitHub Issues in the action repository.
- Security channel: private vulnerability reporting in the action repository.
- Proof of use: `local-ydb-toolkit` dogfoods `astandrik/setup-local-ydb@v1` in `.github/workflows/setup-local-ydb-smoke.yml`.

## Usage

```yaml
- uses: astandrik/setup-local-ydb@v1
  with:
    version: 26.1.1.6
    tenant: /local/test
```

Add `auth: true` only when the CI job needs native YDB auth behavior.
