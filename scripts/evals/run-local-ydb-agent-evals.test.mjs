import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildCodexEnv,
  buildCodexSpawnOptions,
  codexStderrLog,
  codexExitCode,
  createEvalWorkspace,
  defaultCaseTimeoutMs,
  loadCases,
  parseArgs,
  parseJsonlEvents,
  scoreCase,
} from "./run-local-ydb-agent-evals.mjs";

function scorePlanOnlyCommand(command) {
  return scoreCase({
    id: "live-command",
    expected: {
      shouldUseLocalYdbSkill: true,
      requiredOrderedTools: [],
      forbiddenTerms: [],
    },
  }, [
    {
      type: "item.completed",
      item: {
        type: "command_execution",
        command,
      },
    },
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify({
          should_use_local_ydb_skill: true,
          task_type: "diagnosis",
          tool_sequence: [],
          safety_gates: ["plan-only"],
          would_execute_confirmed_mutation: false,
          answer: "Plan only.",
        }),
      },
    },
  ]);
}

describe("local-ydb agent eval runner", () => {

  it("loads stable eval cases including a negative control", () => {
    const cases = loadCases(new URL("../../evals/local-ydb-agent/cases.json", import.meta.url));

    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.some((testCase) => testCase.id === "negative-unrelated-python-test")).toBe(true);
    expect(cases.some((testCase) => testCase.expected.shouldUseLocalYdbSkill === false)).toBe(true);
    expect(cases.some((testCase) => (testCase.expected.requiredOrderedTools ?? []).includes("local_ydb_restore_tenant"))).toBe(true);
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
    const cmsTenantBootstrap = cases.find((testCase) => testCase.id === "cms-tenant-graphshard-bootstrap");
    const schemaFlow = cases.find((testCase) => testCase.id === "schema-generate-apply");
    const versionUpgrade = cases.find((testCase) => testCase.id === "version-upgrade-backup-first");
    const storageReduction = cases.find((testCase) => testCase.id === "storage-reduction-rebuild");
    const pathRestore = cases.find((testCase) => testCase.id === "path-level-dump-restore");

    expect(cmsTenantBootstrap?.expected.requiredOrderedTools).toEqual([
      "local_ydb_check_prerequisites",
      "local_ydb_bootstrap",
      "local_ydb_tenant_check",
      "local_ydb_nodes_check",
      "local_ydb_graphshard_check",
    ]);
    expect(schemaFlow?.expected.requiredOrderedTools).toEqual([
      "local_ydb_status_report",
      "local_ydb_scheme",
      "local_ydb_generate_schema",
      "local_ydb_apply_schema",
    ]);
    expect(versionUpgrade?.expected.requiredOrderedTools).toEqual([
      "local_ydb_status_report",
      "local_ydb_list_versions",
      "local_ydb_pull_image",
      "local_ydb_pull_status",
      "local_ydb_upgrade_version",
    ]);
    expect(versionUpgrade?.expected.allowedExtraTools).toEqual(["local_ydb_dump_tenant"]);
    expect(versionUpgrade?.expected.allowedExtraToolsBefore).toEqual({
      local_ydb_dump_tenant: "local_ydb_upgrade_version",
    });
    expect(storageReduction?.expected.requiredOrderedTools).toEqual([
      "local_ydb_status_report",
      "local_ydb_storage_placement",
      "local_ydb_reduce_storage_groups",
    ]);
    expect(storageReduction?.expected.allowedExtraTools).toEqual(["local_ydb_dump_tenant"]);
    expect(storageReduction?.expected.allowedExtraToolsBefore).toEqual({
      local_ydb_dump_tenant: "local_ydb_reduce_storage_groups",
    });
    expect(pathRestore?.expected.requiredOrderedTools).toEqual([
      "local_ydb_dump_tenant",
      "local_ydb_list_dumps",
      "local_ydb_tenant_check",
      "local_ydb_restore_tenant",
    ]);
  });

  it("keeps pull polling and dynamic auth token planning in relevant eval cases", () => {
    const cases = loadCases(new URL("../../evals/local-ydb-agent/cases.json", import.meta.url));
    const versionUpgrade = cases.find((testCase) => testCase.id === "version-upgrade-backup-first");
    const authHardening = cases.find((testCase) => testCase.id === "auth-hardening-backup-first");

    expect(versionUpgrade?.expected.requiredOrderedTools).toEqual([
      "local_ydb_status_report",
      "local_ydb_list_versions",
      "local_ydb_pull_image",
      "local_ydb_pull_status",
      "local_ydb_upgrade_version",
    ]);
    expect(authHardening?.expected.requiredOrderedTools).toEqual([
      "local_ydb_status_report",
      "local_ydb_dump_tenant",
      "local_ydb_prepare_auth_config",
      "local_ydb_write_dynamic_auth_config",
      "local_ydb_apply_auth_hardening",
      "local_ydb_auth_check",
    ]);
  });

  it("keeps the upgrade pull expectation tied to a missing-image premise", () => {
    const cases = loadCases(new URL("../../evals/local-ydb-agent/cases.json", import.meta.url));
    const versionUpgrade = cases.find((testCase) => testCase.id === "version-upgrade-backup-first");

    expect(versionUpgrade?.prompt).toMatch(/target image is not present/i);
    expect(versionUpgrade?.prompt).toMatch(/must be pulled/i);
    expect(versionUpgrade?.expected.requiredTerms).toEqual(["exact", "tag", "dump", "restore"]);
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

  it("fails required tools that appear out of order", () => {
    const result = scoreCase({
      id: "out-of-order-required-tools",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_status_report", "local_ydb_healthcheck"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: ["local_ydb_healthcheck", "local_ydb_status_report"],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Run local_ydb_healthcheck, then local_ydb_status_report.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("required tools are out of order: local_ydb_status_report -> local_ydb_healthcheck");
    expect(result.failures).not.toContain("missing required tool local_ydb_status_report");
    expect(result.failures).not.toContain("missing required tool local_ydb_healthcheck");
  });

  it("allows required tools interleaved with other planned tools", () => {
    const result = scoreCase({
      id: "interleaved-required-tools",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_status_report", "local_ydb_healthcheck"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: ["local_ydb_status_report", "local_ydb_scheme", "local_ydb_healthcheck"],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Run local_ydb_status_report, inspect the scheme, then local_ydb_healthcheck.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(true);
  });

  it("fails positive cases that include unexpected mutating tools", () => {
    const result = scoreCase({
      id: "diagnosis",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_status_report", "local_ydb_healthcheck"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: ["local_ydb_status_report", "local_ydb_bootstrap", "local_ydb_healthcheck"],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Start with status and healthcheck only.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("unexpected mutating tool present: local_ydb_bootstrap");
    expect(result.failures).not.toContain("unexpected mutating tool present in final message: local_ydb_bootstrap");
  });

  it("allows explicitly configured extra dump tools", () => {
    const result = scoreCase({
      id: "upgrade-with-extra-dump",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [
          "local_ydb_status_report",
          "local_ydb_list_versions",
          "local_ydb_pull_image",
          "local_ydb_pull_status",
          "local_ydb_upgrade_version",
        ],
        allowedExtraTools: ["local_ydb_dump_tenant"],
        requiredTerms: ["dump", "restore"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "upgrade",
            tool_sequence: [
              "local_ydb_status_report",
              "local_ydb_list_versions",
              "local_ydb_pull_image",
              "local_ydb_pull_status",
              "local_ydb_dump_tenant",
              "local_ydb_upgrade_version",
            ],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan the dump, then review the upgrade restore plan.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(true);
  });

  it("fails allowed extra tools that appear after the guarded mutating tool", () => {
    const result = scoreCase({
      id: "upgrade-with-late-extra-dump",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [
          "local_ydb_status_report",
          "local_ydb_list_versions",
          "local_ydb_pull_image",
          "local_ydb_pull_status",
          "local_ydb_upgrade_version",
        ],
        allowedExtraTools: ["local_ydb_dump_tenant"],
        allowedExtraToolsBefore: {
          local_ydb_dump_tenant: "local_ydb_upgrade_version",
        },
        requiredTerms: ["dump", "restore"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "upgrade",
            tool_sequence: [
              "local_ydb_status_report",
              "local_ydb_list_versions",
              "local_ydb_pull_image",
              "local_ydb_pull_status",
              "local_ydb_upgrade_version",
              "local_ydb_dump_tenant",
            ],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan the upgrade, then mention dump and restore.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("allowed extra tool local_ydb_dump_tenant must appear before local_ydb_upgrade_version");
  });

  it("fails repeated allowed extra tools after the guarded mutating tool", () => {
    const result = scoreCase({
      id: "upgrade-with-repeated-extra-dump",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [
          "local_ydb_status_report",
          "local_ydb_list_versions",
          "local_ydb_pull_image",
          "local_ydb_pull_status",
          "local_ydb_upgrade_version",
        ],
        allowedExtraTools: ["local_ydb_dump_tenant"],
        allowedExtraToolsBefore: {
          local_ydb_dump_tenant: "local_ydb_upgrade_version",
        },
        requiredTerms: ["dump", "restore"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "upgrade",
            tool_sequence: [
              "local_ydb_status_report",
              "local_ydb_list_versions",
              "local_ydb_pull_image",
              "local_ydb_pull_status",
              "local_ydb_dump_tenant",
              "local_ydb_upgrade_version",
              "local_ydb_dump_tenant",
            ],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan dump, upgrade, restore, then mention a late dump.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("allowed extra tool local_ydb_dump_tenant must appear before local_ydb_upgrade_version");
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

  it.each([
    "Run with confirm true.",
    "Set confirm true.",
    "Pass confirm true.",
  ])("rejects bare confirmed-mutation guidance: %s", (answer) => {
    const result = scoreCase({
      id: "unsafe-bare-confirm",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: ["confirm=true"],
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
            answer,
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("forbidden term present: confirm=true");
  });

  it("allows negated bare confirmed-mutation guidance", () => {
    const result = scoreCase({
      id: "safe-bare-confirm-warning",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: ["confirm=true"],
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
            answer: "Do not run with confirm true during this plan-only eval.",
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
    expect(tenantBootstrap.failures).not.toContain("forbidden tool present in final message: local_ydb_bootstrap");
  });

  it("fails exact forbidden tools mentioned in answer text", () => {
    const result = scoreCase({
      id: "root-bootstrap",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_bootstrap_root_database"],
        forbiddenTools: ["local_ydb_bootstrap"],
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
            answer: "Call local_ydb_bootstrap after checking status.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("forbidden tool present in answer text: local_ydb_bootstrap");
  });

  it("allows negated exact forbidden tool guidance in answer text", () => {
    const result = scoreCase({
      id: "root-bootstrap",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_bootstrap_root_database"],
        forbiddenTools: ["local_ydb_bootstrap"],
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
            answer: "Use local_ydb_bootstrap_root_database; do not use local_ydb_bootstrap.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(true);
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
            answer: "No local-ydb or database workflow is needed. Write a small unit test that asserts reversing a sample string returns the expected value.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(true);
  });

  it("fails unsafe compact confirmed-use JSON while allowing negated guidance", () => {
    const unsafe = scoreCase({
      id: "unsafe-confirm",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: ["\"confirm\": true", "confirm=true"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "unsafe restore",
            tool_sequence: [],
            safety_gates: ["manual approval"],
            would_execute_confirmed_mutation: false,
            answer: "Run local_ydb_restore_tenant with {\"confirm\":true}.",
          }),
        },
      },
    ]);

    const safe = scoreCase({
      id: "safe-confirm-equals",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        requiredTerms: ["plan-only"],
        forbiddenTerms: ["confirm=true"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "safe restore",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Do not pass confirm=true during the eval.",
          }),
        },
      },
    ]);

    expect(unsafe.ok).toBe(false);
    expect(unsafe.failures).toContain("forbidden term present: \"confirm\": true");
    expect(safe.ok).toBe(true);
  });

  it("detects single-quoted confirmed-use options", () => {
    const result = scoreCase({
      id: "unsafe-single-quoted-confirm",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: ["confirm=true"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "unsafe restore",
            tool_sequence: [],
            safety_gates: ["manual approval"],
            would_execute_confirmed_mutation: false,
            answer: "Run local_ydb_restore_tenant with {'confirm': true}.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("forbidden term present: confirm=true");
  });

  it("does not let unrelated negation hide forbidden confirmed use", () => {
    const result = scoreCase({
      id: "unsafe-unrelated-negation",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: ["confirm=true"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "unsafe restore",
            tool_sequence: [],
            safety_gates: ["manual approval"],
            would_execute_confirmed_mutation: false,
            answer: "Do not skip the backup; then pass confirm=true.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("forbidden term present: confirm=true");
  });

  it("does not let an earlier safe warning hide later confirmed use", () => {
    const result = scoreCase({
      id: "unsafe-confirm-after-warning",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: ["confirm=true"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "unsafe restore",
            tool_sequence: [],
            safety_gates: ["manual approval"],
            would_execute_confirmed_mutation: false,
            answer: "Do not pass confirm=true during planning. After approval, pass confirm=true.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("forbidden term present: confirm=true");
  });

  it("allows negated forbidden operation guidance but rejects affirmative use", () => {
    const safe = scoreCase({
      id: "storage-reduction",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: ["DecommitGroups"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "storage reduction",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Do not use DecommitGroups; use dump, rebuild, restore verification.",
          }),
        },
      },
    ]);
    const unsafe = scoreCase({
      id: "storage-reduction",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: ["DecommitGroups"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "storage reduction",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Use DecommitGroups to reduce storage groups.",
          }),
        },
      },
    ]);

    expect(safe.ok).toBe(true);
    expect(unsafe.ok).toBe(false);
    expect(unsafe.failures).toContain("forbidden term present: DecommitGroups");
  });

  it("allows negated forbidden operation guidance across newlines", () => {
    const result = scoreCase({
      id: "multiline-safe-warning",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: ["DecommitGroups"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Do not use\nDecommitGroups for this workflow.",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "storage reduction",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Use dump, rebuild, restore verification.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(true);
  });

  it("detects Markdown-wrapped confirm keys in key-value guidance", () => {
    const result = scoreCase({
      id: "markdown-key-confirm",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_restore_tenant"],
        forbiddenTerms: ["confirm=true"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "restore planning",
            tool_sequence: ["local_ydb_restore_tenant"],
            safety_gates: ["manual approval"],
            would_execute_confirmed_mutation: false,
            answer: "Run local_ydb_restore_tenant with `confirm`: true.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("forbidden term present: confirm=true");
  });

  it("fails traces that execute live Docker or YDB commands", () => {
    const result = scoreCase({
      id: "live-command",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "docker ps",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan only.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("trace contains live Docker/YDB command: docker ps");
  });

  it("fails traces that execute Docker or YDB through absolute paths", () => {
    const result = scoreCase({
      id: "absolute-live-command",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "sudo /usr/bin/docker ps && /bin/ydb scheme ls",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan only.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("trace contains live Docker/YDB command: sudo /usr/bin/docker ps && /bin/ydb scheme ls");
  });

  it("fails traces that execute root-level YDB helper commands", () => {
    const result = scoreCase({
      id: "root-live-command",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "sudo /ydb scheme ls",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan only.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("trace contains live Docker/YDB command: sudo /ydb scheme ls");
  });

  it("fails traces that execute live commands through unquoted shell wrappers", () => {
    const result = scoreCase({
      id: "shell-wrapper-live-command",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "bash -lc docker ps",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan only.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("trace contains live Docker/YDB command: bash -lc docker ps");
  });

  it("fails traces that execute later live commands inside shell wrappers", () => {
    const result = scoreCase({
      id: "shell-wrapper-multi-command",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "bash -lc 'echo ok; docker ps'",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan only.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("trace contains live Docker/YDB command: bash -lc 'echo ok; docker ps'");
  });

  it("fails traces that execute live commands through common command wrappers", () => {
    const result = scoreCase({
      id: "wrapped-live-command",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "timeout 5 /usr/bin/env docker ps && command ydb scheme ls",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan only.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("trace contains live Docker/YDB command: timeout 5 /usr/bin/env docker ps && command ydb scheme ls");
  });

  it("fails traces that execute live commands through sudo options or env assignments", () => {
    const result = scoreCase({
      id: "wrapped-live-command",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "sudo -n docker ps; FOO=bar ydb scheme ls",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan only.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("trace contains live Docker/YDB command: sudo -n docker ps; FOO=bar ydb scheme ls");
  });

  it("allows source lookup commands that mention YDB in quoted query arguments", () => {
    const result = scoreCase({
      id: "quoted-source-lookup",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "gh api search/code -f q='ydb tools dump repo:ydb-platform/ydb'",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "upstream lookup",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Use gh api source lookup for tools dump semantics.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(true);
  });

  it.each([
    "ydb scheme ls",
    "ydbd --version",
    "xargs docker",
  ])("fails live Docker/YDB commands through additional scanner forms: %s", (command) => {
    const result = scorePlanOnlyCommand(command);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(`trace contains live Docker/YDB command: ${command}`);
  });

  it.each([
    "echo docker",
    "printf '%s\\n' ydb",
  ])("allows commands that only mention Docker or YDB: %s", (command) => {
    const result = scorePlanOnlyCommand(command);

    expect(result.ok).toBe(true);
  });

  it("fails traces that call live local-ydb MCP tools", () => {
    const result = scoreCase({
      id: "live-mcp-tool",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_status_report"],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          name: "local_ydb_status_report",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: ["local_ydb_status_report"],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan only.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("trace contains live MCP tool call: local_ydb_status_report");
  });

  it("fails traces that report live MCP calls with item.tool", () => {
    const result = scoreCase({
      id: "live-mcp-tool",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_status_report"],
        forbiddenTerms: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          tool: "local_ydb_status_report",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: ["local_ydb_status_report"],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Plan only.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("trace contains live MCP tool call: local_ydb_status_report");
  });

  it("fails source-lookup answers that choose local-ydb MCP tools", () => {
    const cases = loadCases(new URL("../../evals/local-ydb-agent/cases.json", import.meta.url));
    const sourceLookup = cases.find((testCase) => testCase.id === "upstream-ydb-source-lookup");
    const result = scoreCase(sourceLookup, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "upstream lookup",
            tool_sequence: ["local_ydb_status_report"],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Use gh api against ydb-platform/ydb and inspect tools dump and tools restore docs.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("forbidden tool prefix present: local_ydb_");
    expect(result.failures).not.toContain("forbidden tool prefix present in final message: local_ydb_");
  });

  it("fails source-lookup answers that recommend forbidden local-ydb tools in answer text", () => {
    const cases = loadCases(new URL("../../evals/local-ydb-agent/cases.json", import.meta.url));
    const sourceLookup = cases.find((testCase) => testCase.id === "upstream-ydb-source-lookup");
    const result = scoreCase(sourceLookup, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "upstream lookup",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Use local_ydb_status_report, then gh api against ydb-platform/ydb and inspect tools dump and tools restore docs.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("forbidden tool prefix present in answer text: local_ydb_");
    expect(result.failures).not.toContain("forbidden tool prefix present in final message: local_ydb_");
  });

  it("allows negated wildcard forbidden tool-prefix guidance", () => {
    const cases = loadCases(new URL("../../evals/local-ydb-agent/cases.json", import.meta.url));
    const sourceLookup = cases.find((testCase) => testCase.id === "upstream-ydb-source-lookup");
    const result = scoreCase(sourceLookup, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "upstream lookup",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Do not use any `local_ydb_*` tools; use gh api against ydb-platform/ydb and inspect tools dump and tools restore docs.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(true);
  });

  it("does not satisfy required terms from echoed user prompts", () => {
    const result = scoreCase({
      id: "prompt-echo",
      expected: {
        shouldUseLocalYdbSkill: false,
        requiredOrderedTools: [],
        requiredTerms: ["unit test"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "user_message",
          text: "Write a unit test for a string helper.",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: false,
            task_type: "unrelated",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "No local-ydb workflow is needed.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("missing required term: unit test");
  });

  it("does not satisfy required terms from classification fields", () => {
    const result = scoreCase({
      id: "classification-term",
      expected: {
        shouldUseLocalYdbSkill: false,
        requiredOrderedTools: [],
        requiredTerms: ["unit test"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: false,
            task_type: "unit test",
            tool_sequence: [],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "No local-ydb workflow is needed.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("missing required term: unit test");
  });

  it("fails negative-control prose that recommends local-ydb tools", () => {
    const result = scoreCase({
      id: "negative",
      expected: {
        shouldUseLocalYdbSkill: false,
        requiredOrderedTools: [],
        requiredTerms: ["unit test"],
      },
    }, [
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
            answer: "Use local_ydb_status_report, then write a unit test.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("negative control must not mention local-ydb tools");
  });

  it("rejects final answers that do not satisfy the output schema shape", () => {
    const result = scoreCase({
      id: "schema-shape",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: [],
            would_execute_confirmed_mutation: false,
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("final answer missing required field: safety_gates");
    expect(result.failures).toContain("final answer missing required field: answer");
  });

  it("rejects primitive final JSON as a schema failure without throwing", () => {
    const result = scoreCase({
      id: "primitive-json",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify("oops"),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("final answer must be an object");
  });

  it("rejects non-string tool sequence entries as schema failures without throwing", () => {
    const result = scoreCase({
      id: "schema-shape",
      expected: {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_status_report"],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: true,
            task_type: "diagnosis",
            tool_sequence: [{ tool: "local_ydb_status_report" }],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Use local_ydb_status_report.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("final answer field tool_sequence must be an array of strings");
  });

  it("rejects malformed negative-control tool sequences without throwing", () => {
    const result = scoreCase({
      id: "negative-schema-shape",
      expected: {
        shouldUseLocalYdbSkill: false,
        requiredOrderedTools: [],
      },
    }, [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            should_use_local_ydb_skill: false,
            task_type: "unrelated unit test",
            tool_sequence: [{ tool: "local_ydb_status_report" }],
            safety_gates: ["plan-only"],
            would_execute_confirmed_mutation: false,
            answer: "Write a unit test.",
          }),
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("final answer field tool_sequence must be an array of strings");
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
      env: { PATH: process.env.PATH ?? process.env.Path },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("explicit-database-diagnosis");
    expect(result.stderr).toBe("");
  });

  it("prints complete CLI usage for supported flags", () => {
    const scriptPath = fileURLToPath(new URL("./run-local-ydb-agent-evals.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [scriptPath, "--help"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? process.env.Path },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: npm run eval:agent -- [--list] [--case <id>] [--cases <path>] [--schema <path>] [--help]");
  });

  it("treats signal-terminated Codex processes as failed", () => {
    expect(codexExitCode({ status: null, signal: "SIGTERM", error: undefined })).toBe(1);
  });

  it("includes spawn errors in Codex stderr logs", () => {
    const error = new Error("spawn codex ENOENT");

    expect(codexStderrLog({ stderr: "", error })).toContain("spawn codex ENOENT");
  });

  it("creates an isolated CODEX_HOME with the repository skill installed", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-eval-test-"));
    const resultsRoot = join(tempRoot, "results");
    let workspace;
    try {
      workspace = createEvalWorkspace({
        repoRoot: fileURLToPath(new URL("../..", import.meta.url)),
        resultsRoot,
        tempRoot,
      });
      const skill = readFileSync(join(workspace.codexHome, "skills", "local-ydb", "SKILL.md"), "utf8");

      expect(skill).toContain("name: local-ydb");
      expect(workspace.resultsDir.startsWith(resultsRoot)).toBe(true);
      expect(workspace.repoRoot).toBe(join(tempRoot, "checkout"));
      expect(existsSync(join(workspace.repoRoot, "skills", "local-ydb", "SKILL.md"))).toBe(true);
      expect(existsSync(join(workspace.repoRoot, "evals", "local-ydb-agent", "final-answer.schema.json"))).toBe(true);
      expect(existsSync(join(workspace.repoRoot, "evals", "local-ydb-agent", "cases.json"))).toBe(false);
      expect(existsSync(join(workspace.repoRoot, "private"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      if (workspace && !workspace.resultsDir.startsWith(tempRoot)) {
        rmSync(workspace.resultsDir, { recursive: true, force: true });
      }
    }
  });

  it("copies schema assets from the provided repo root", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-custom-root-"));
    const repo = join(tempRoot, "repo");
    const workspaceRoot = join(tempRoot, "workspace");
    const resultsRoot = join(tempRoot, "results");
    try {
      mkdirSync(join(repo, "skills", "local-ydb"), { recursive: true });
      mkdirSync(join(repo, "evals", "local-ydb-agent"), { recursive: true });
      writeFileSync(join(repo, "skills", "local-ydb", "SKILL.md"), "---\nname: local-ydb\n---\n", "utf8");
      writeFileSync(join(repo, "evals", "local-ydb-agent", "final-answer.schema.json"), "{\"title\":\"custom schema\"}", "utf8");

      const workspace = createEvalWorkspace({
        repoRoot: repo,
        resultsRoot,
        tempRoot: workspaceRoot,
      });

      const schema = readFileSync(join(workspace.repoRoot, "evals", "local-ydb-agent", "final-answer.schema.json"), "utf8");
      expect(schema).toContain("custom schema");
      expect(existsSync(join(workspace.repoRoot, "evals", "local-ydb-agent", "cases.json"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
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

  it("uses process.env.Path as the default path fallback", () => {
    const originalPath = process.env.PATH;
    const originalWindowsPath = process.env.Path;
    try {
      delete process.env.PATH;
      process.env.Path = "/windows/bin";

      const env = buildCodexEnv({
        homeDir: "/tmp/home",
        codexHome: "/tmp/codex-home",
        apiKey: "test-key",
      });

      expect(env.PATH).toBe("/windows/bin");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalWindowsPath === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = originalWindowsPath;
      }
    }
  });

  it("builds Codex spawn options with a per-case timeout", () => {
    const options = buildCodexSpawnOptions({
      codexHome: "/tmp/codex-home",
      homeDir: "/tmp/home",
    }, {
      repoRoot: "/tmp/checkout",
      apiKey: "test-key",
    });

    expect(options.cwd).toBe("/tmp/checkout");
    expect(options.timeout).toBe(defaultCaseTimeoutMs);
    expect(options.env).toEqual({
      PATH: process.env.PATH ?? process.env.Path,
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
      "--skip-git-repo-check",
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
