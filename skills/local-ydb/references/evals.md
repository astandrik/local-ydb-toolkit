# local-ydb Agent Evals

Use the agent eval suite when changing `skills/local-ydb`, MCP server instructions, MCP prompts, or public tool-selection guidance.

The suite is plan-only. It checks whether Codex chooses the right local-ydb workflow, preserves plan-first safety gates, avoids `confirm=true`, and ignores unrelated prompts. Real Docker/YDB behavior stays covered by the live MCP integration workflow. Full runs require the `codex` CLI and `CODEX_API_KEY`.

## Local Commands

```bash
npm run eval:agent -- --list
CODEX_API_KEY=... npm run eval:agent -- --case explicit-database-diagnosis
CODEX_API_KEY=... npm run eval:agent
```

Results are written to `eval-results/local-ydb-agent/<timestamp>/` and are intentionally ignored by git.

## Adding Cases

Add cases to `evals/local-ydb-agent/cases.json`. Keep each case focused on one behavior and prefer deterministic checks:

- `requiredOrderedTools` for expected MCP tool order.
- `requiredTerms` for safety or semantics that must appear.
- `forbiddenTerms` for dangerous actions such as confirmed mutation.
- `shouldUseLocalYdbSkill: false` for negative controls.

The final answer shape is constrained by `evals/local-ydb-agent/final-answer.schema.json`.
