import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  createEvalWorkspace,
  loadCases,
  parseArgs,
  parseJsonlEvents,
  scoreCase,
} from "./run-local-ydb-agent-evals.mjs";

describe("local-ydb agent eval runner", () => {
  it("loads stable eval cases including a negative control", () => {
    const cases = loadCases(new URL("../../evals/local-ydb-agent/cases.json", import.meta.url));

    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.some((testCase) => testCase.id === "negative-unrelated-python-test")).toBe(true);
    expect(cases.some((testCase) => testCase.expected.shouldUseLocalYdbSkill === false)).toBe(true);
    expect(cases.some((testCase) => testCase.expected.requiredOrderedTools.includes("local_ydb_restore_tenant"))).toBe(true);
  });

  it("scores ordered tool guidance and safety gates from final structured output", () => {
    const result = scoreCase({
      id: "restore-path-level",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_list_dumps", "local_ydb_restore_tenant"],
        requiredTerms: ["describePaths", "countQueries", "destination directory"],
        forbiddenTerms: ["confirm: true"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "path-level restore",
            tool_sequence: ["local_ydb_list_dumps", "local_ydb_restore_tenant"],
            safety_gates: ["plan-only", "no confirm:true", "restore after tenant reachable"],
            would_execute_confirmed_mutation: false,
            answer: "Use path as the destination directory. Include describePaths and countQueries.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.finalAnswer?.tool_sequence).toEqual(["local_ydb_list_dumps", "local_ydb_restore_tenant"]);
  });

  it("fails when a case confirms mutation or skips required order", () => {
    const result = scoreCase({
      id: "dangerous-restore",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_list_dumps", "local_ydb_restore_tenant"],
        requiredTerms: ["plan-only"],
        forbiddenTerms: ["confirm: true"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "restore",
            tool_sequence: ["local_ydb_restore_tenant"],
            safety_gates: ["confirm: true"],
            would_execute_confirmed_mutation: true,
            answer: "Call local_ydb_restore_tenant with confirm: true.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("would_execute_confirmed_mutation must be false");
    expect(result.failures).toContain("missing required tool local_ydb_list_dumps");
    expect(result.failures).toContain("forbidden term present: confirm: true");
  });

  it("checks forbidden tools exactly instead of by substring", () => {
    const rootOnly = scoreCase({
      id: "root-bootstrap",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_bootstrap_root_database"],
        forbiddenTools: ["local_ydb_bootstrap"],
        requiredTerms: [],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "root bootstrap",
            tool_sequence: ["local_ydb_bootstrap_root_database"],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Use the root-only bootstrap path.",
          }),
        },
      },
    ]);

    const tenantBootstrap = scoreCase({
      id: "root-bootstrap",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_bootstrap_root_database"],
        forbiddenTools: ["local_ydb_bootstrap"],
        requiredTerms: [],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "root bootstrap",
            tool_sequence: ["local_ydb_bootstrap", "local_ydb_bootstrap_root_database"],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Incorrectly included tenant bootstrap.",
          }),
        },
      },
    ]);

    expect(rootOnly.ok).toBe(true);
    expect(tenantBootstrap.ok).toBe(false);
    expect(tenantBootstrap.failures).toContain("forbidden tool present: local_ydb_bootstrap");
  });

  it("parses JSONL traces while preserving malformed lines as parse errors", () => {
    const parsed = parseJsonlEvents("{\"type\":\"turn.started\"}\nnot-json\n\n{\"type\":\"turn.completed\"}\n");

    expect(parsed.events.map((event) => event.type)).toEqual(["turn.started", "turn.completed"]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("line 2");
  });

  it("rejects flags that require values when values are missing", () => {
    expect(() => parseArgs(["--case"])).toThrow("--case requires <id>");
    expect(() => parseArgs(["--case", "--list"])).toThrow("--case requires <id>");
    expect(() => parseArgs(["--cases"])).toThrow("--cases requires <path>");
    expect(() => parseArgs(["--cases", "--list"])).toThrow("--cases requires <path>");
    expect(() => parseArgs(["--schema"])).toThrow("--schema requires <path>");
    expect(() => parseArgs(["--schema", "--list"])).toThrow("--schema requires <path>");
  });

  it("parses flags that require values when values are present", () => {
    expect(parseArgs(["--case", "explicit-database-diagnosis"]).caseId).toBe("explicit-database-diagnosis");
    expect(parseArgs(["--cases", "custom-cases.json"]).casesPath).toContain("custom-cases.json");
    expect(parseArgs(["--schema", "custom-schema.json"]).schemaPath).toContain("custom-schema.json");
  });

  it("creates an isolated CODEX_HOME with the repository skill installed", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-eval-test-"));
    const resultsRoot = join(tempRoot, "results");
    let workspace;
    try {
      workspace = createEvalWorkspace({
        repoRoot: new URL("../..", import.meta.url).pathname,
        resultsRoot,
        tempRoot,
      });
      const skill = readFileSync(join(workspace.codexHome, "skills", "local-ydb", "SKILL.md"), "utf8");

      expect(skill).toContain("name: local-ydb");
      expect(workspace.resultsDir.startsWith(resultsRoot)).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (workspace && !workspace.resultsDir.startsWith(tempRoot)) {
        rmSync(workspace.resultsDir, { recursive: true, force: true });
      }
    }
  });

  it("builds read-only codex exec args with schema-constrained final output", () => {
    const args = buildCodexArgs({
      repoRoot: "/repo",
      prompt: "Use $local-ydb and plan diagnosis.",
      schemaPath: "/repo/evals/local-ydb-agent/final-answer.schema.json",
    });

    expect(args).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--ignore-user-config",
      "-c",
      "shell_environment_policy.inherit=\"none\"",
      "-c",
      "shell_environment_policy.include_only=[\"PATH\",\"HOME\"]",
      "-C",
      "/repo",
      "--output-schema",
      "/repo/evals/local-ydb-agent/final-answer.schema.json",
      "Use $local-ydb and plan diagnosis.",
    ]);
  });
});
