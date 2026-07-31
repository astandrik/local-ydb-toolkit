# local-ydb Agent Evals

Use the agent eval suite when changing `skills/local-ydb` or public tool-selection guidance. When MCP server instructions or prompts change, update the mirrored skill guidance and cases first; the eval runner executes against an isolated checkout containing only the skill and eval schema.

The suite is plan-only. It checks whether Codex chooses the right local-ydb workflow, preserves plan-first safety gates, avoids `confirm=true`, and ignores unrelated prompts. Real Docker/YDB behavior stays covered by the live MCP integration workflow. Full runs require the `codex` CLI and `CODEX_API_KEY`. The suite is intentionally local-only for now; do not add a GitHub Actions workflow that passes `CODEX_API_KEY` into repository-controlled scripts without a separate security design.

The runner installs the skill into a single discovery root (`$CODEX_HOME/skills`) because current Codex CLI versions read both `$CODEX_HOME/skills` and `$HOME/.agents/skills`; a dual install would advertise `local-ydb` twice and skew selection. Runs that omit `--model` follow the current CLI/service default and record `codexModel: "default"` in the summary — pin `--model` when comparing score history across runs.

## Local Commands

```bash
npm run eval:agent -- --list
CODEX_API_KEY=... npm run eval:agent -- --case explicit-database-diagnosis
CODEX_API_KEY=... npm run eval:agent
```

Results are written to `eval-results/local-ydb-agent/<timestamp>-<random-suffix>/` and are intentionally ignored by git.

## Adding Cases

Add cases to `evals/local-ydb-agent/cases.json`. Keep each case focused on one behavior and prefer deterministic checks:

- `requiredOrderedTools` for expected MCP tool order.
- `requiredTerms` for safety or semantics that must appear.
- `forbiddenTerms` for dangerous actions such as confirmed mutation.
- `shouldUseLocalYdbSkill: false` for negative controls.

The final answer shape is constrained by `evals/local-ydb-agent/final-answer.schema.json`.

## Scoring Contract

The suite scores two things: the schema-constrained final answer and the full event trace (interim agent messages, command executions, MCP tool calls, file changes). It is deliberately not a language or shell parser.

- Term checks are literal, case-insensitive substring matches; tool-name checks use word-boundary matching. Negation, prose order, connectors, and paraphrase are out of scope — a negated "do not pass confirm=true" still trips `forbiddenTerms`, and prose around the structured answer is not analyzed for tool order.
- `allowedExtraToolsBefore` maps an allowed extra tool to the required tool it must precede. Keys must be listed in `allowedExtraTools` and values in `requiredOrderedTools`; the loader rejects dangling references so a typo cannot silently disable the constraint.
- Any `file_change` event (including patch-style item types), any live `local_ydb_*` MCP tool call, and any live Docker/YDB command in the trace fails a plan-only case.
- The command tripwire flags `docker`, `ydb`, or `ydbd` in command position: the start of a command or right after a `;`, `|`, `&`, or newline separator, optionally behind the standard direct-command prefixes — environment assignments (`VAR=value`) and `sudo` (its common options and the `--` separator are consumed) — or an absolute path. Wrapper chains (`bash -c`), `ssh`, command substitution, pipelines into shells, and quoting/obfuscation tricks are out of scope.
- Reading the installed skill is treated as activation: a negative control fails if any trace command touches the `skills/local-ydb` path, even when the final answer self-reports `should_use_local_ydb_skill: false`.

The threat model is an agent that accidentally violates plan-only rules, not an adversary trying to evade detection. Stronger isolation belongs to sandboxing the eval environment, not to growing the scanner.
