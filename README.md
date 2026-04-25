# local-ydb-toolkit

Reusable Codex skill for operating `local-ydb` deployments.

## Quick Start

The easiest install path for Codex is to ask Codex to install the skill from this repository:

```text
$skill-installer install https://github.com/astandrik/local-ydb-toolkit/tree/main/skills/local-ydb
```

Restart Codex if the skill does not appear immediately.

Manual fallback for Codex:

```bash
git clone https://github.com/astandrik/local-ydb-toolkit.git
cd local-ydb-toolkit
SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$SKILLS_DIR"
cp -R skills/local-ydb "$SKILLS_DIR/local-ydb"
```

## Skill Contents

```text
skills/local-ydb/
  SKILL.md
  agents/openai.yaml
  references/
    auth-hardening.md
    history-and-non-goals.md
    storage-migration.md
    topology.md
    verification.md
  scripts/
  assets/
```

The skill covers reusable operational guidance for:

- Docker-based `local-ydb` topologies using `ghcr.io/ydb-platform/local-ydb`
- CMS-created tenants and GraphShard behavior
- dynamic nodes and mandatory-auth node registration
- YDB native auth hardening and monitoring exposure
- storage pools, BSC placement checks, PDisks, dump/restore, and rebuild workflows
- upstream `ydb-platform/ydb` source lookup through `gh api`

The skill intentionally avoids private hostnames, IPs, user-specific paths, passwords, tokens, backup paths, and app-specific deployment details. Public examples use placeholders such as `/local/<tenant>`, `/path/to/root.password`, `<host>`, and `<public-domain>`.
