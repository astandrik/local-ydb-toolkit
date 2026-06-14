import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildCodexEnv,
  codexExitCode,
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

  it("rejects unsafe case ids before using them as output paths", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-eval-cases-"));
    const casesPath = join(tempRoot, "cases.json");
    try {
      writeFileSync(casesPath, JSON.stringify([
        {
          id: "../escape",
          prompt: "Plan safely.",
          expected: {
            shouldUseLocalYdbSkill: true,
          },
        },
      ]), "utf8");

      expect(() => loadCases(casesPath)).toThrow("safe slug");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects expected fields that are not arrays of strings", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-eval-cases-"));
    const casesPath = join(tempRoot, "cases.json");
    try {
      writeFileSync(casesPath, JSON.stringify([
        {
          id: "invalid-required-tools",
          prompt: "Plan safely.",
          expected: {
            shouldUseLocalYdbSkill: true,
            requiredOrderedTools: "local_ydb_status_report",
          },
        },
      ]), "utf8");

      expect(() => loadCases(casesPath)).toThrow("expected.requiredOrderedTools must be an array of strings");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps high-level tool expectations for upgrade and storage rebuild cases", () => {
    const cases = loadCases(new URL("../../evals/local-ydb-agent/cases.json", import.meta.url));
    const versionUpgrade = cases.find((testCase) => testCase.id === "version-upgrade-backup-first");
    const storageReduction = cases.find((testCase) => testCase.id === "storage-reduction-rebuild");

    expect(versionUpgrade?.expected.requiredOrderedTools).toEqual([
      "local_ydb_list_versions",
      "local_ydb_pull_image",
      "local_ydb_pull_status",
      "local_ydb_upgrade_version",
    ]);
    expect(storageReduction?.expected.requiredOrderedTools).toEqual([
      "local_ydb_storage_placement",
      "local_ydb_reduce_storage_groups",
    ]);
  });

  it("keeps pull polling and dynamic auth token planning in relevant eval cases", () => {
    const cases = loadCases(new URL("../../evals/local-ydb-agent/cases.json", import.meta.url));
    const versionUpgrade = cases.find((testCase) => testCase.id === "version-upgrade-backup-first");
    const authHardening = cases.find((testCase) => testCase.id === "auth-hardening-backup-first");

    expect(versionUpgrade?.expected.requiredOrderedTools).toEqual([
      "local_ydb_list_versions",
      "local_ydb_pull_image",
      "local_ydb_pull_status",
      "local_ydb_upgrade_version",
    ]);
    expect(authHardening?.expected.requiredOrderedTools).toEqual([
      "local_ydb_dump_tenant",
      "local_ydb_prepare_auth_config",
      "local_ydb_write_dynamic_auth_config",
      "local_ydb_apply_auth_hardening",
      "local_ydb_auth_check",
    ]);
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

  it("does not treat safe confirmed-mutation warnings as forbidden confirmed use", () => {
    const result = scoreCase({
      id: "safe-warning",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
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
            task_type: "restore planning",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Do not use confirm: true during this plan-only eval.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(true);
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

  it("passes a negative-control answer that correctly avoids local-ydb use", () => {
    const cases = loadCases(new URL("../../evals/local-ydb-agent/cases.json", import.meta.url));
    const negativeCase = cases.find((testCase) => testCase.id === "negative-unrelated-python-test");

    const result = scoreCase(negativeCase, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: false,
            task_type: "unrelated unit test",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Write a small unit test that asserts reversing a sample string returns the expected value.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(true);
  });

  it("fails negative controls that still propose local-ydb tools", () => {
    const result = scoreCase({
      id: "negative",
      expected: {
        shouldUseLocalYdbSkill: false,
        requiredOrderedTools: [],
        requiredTerms: ["unit test"],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: false,
            task_type: "unit test",
            tool_sequence: ["local_ydb_status_report"],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Write a unit test.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("negative control must not include local-ydb tools");
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

  it("lists cases without validating a requested case id or requiring credentials", () => {
    const scriptPath = fileURLToPath(new URL("./run-local-ydb-agent-evals.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [scriptPath, "--list", "--case", "does-not-exist"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("explicit-database-diagnosis");
    expect(result.stderr).toBe("");
  });

  it("treats signal-terminated Codex processes as failed", () => {
    expect(codexExitCode({ status: null, signal: "SIGTERM", error: undefined })).toBe(1);
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

  it("cleans up a temporary eval workspace when setup fails", () => {
    const badRepoRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-bad-repo-"));
    const resultsRoot = join(badRepoRoot, "results");
    const before = new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith("local-ydb-agent-evals-")));
    try {
      expect(() => createEvalWorkspace({ repoRoot: badRepoRoot, resultsRoot })).toThrow("local-ydb skill not found");

      const after = readdirSync(tmpdir()).filter((entry) => entry.startsWith("local-ydb-agent-evals-"));
      const leaked = after.filter((entry) => !before.has(entry));
      expect(leaked).toEqual([]);
      expect(existsSync(resultsRoot)).toBe(false);
    } finally {
      rmSync(badRepoRoot, { recursive: true, force: true });
    }
  });

  it("builds a minimal Codex environment without forwarding unrelated variables", () => {
    const env = buildCodexEnv({
      path: "/usr/bin",
      homeDir: "/tmp/home",
      codexHome: "/tmp/codex-home",
      apiKey: "test-key",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      CODEX_HOME: "/tmp/codex-home",
      CODEX_API_KEY: "test-key",
    });
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
      "--ignore-rules",
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
