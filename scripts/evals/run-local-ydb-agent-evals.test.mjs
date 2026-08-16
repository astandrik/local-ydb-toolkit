import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildCodexEnv,
  buildCodexSpawnOptions,
  buildPrompt,
  codexExitCode,
  codexStderrLog,
  createEvalWorkspace,
  defaultCaseTimeoutMs,
  invokesLiveDockerOrYdb,
  loadCases,
  parseArgs,
  parseJsonlEvents,
  scoreCase,
} from "./run-local-ydb-agent-evals.mjs";

function makeCase(expected, id = "test-case") {
  return { id, name: "Test case", prompt: "Prompt", expected };
}

function agentMessageEvent(text) {
  return { type: "item.completed", item: { type: "agent_message", text } };
}

function validAnswer(overrides = {}) {
  return {
    should_use_local_ydb_skill: true,
    task_type: "diagnosis",
    tool_sequence: [],
    safety_gates: [],
    would_execute_confirmed_mutation: false,
    answer: "plan",
    ...overrides,
  };
}

function finalAnswerEvent(overrides = {}) {
  return agentMessageEvent(JSON.stringify(validAnswer(overrides)));
}

function scoreWith(events, expected, options = {}) {
  const { omitSkillActivation = false, ...scoreOptions } = options;
  const activationEvents =
    expected.shouldUseLocalYdbSkill && !omitSkillActivation
      ? [
          {
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "cat $CODEX_HOME/skills/local-ydb/SKILL.md",
            },
          },
        ]
      : [];
  return scoreCase(makeCase(expected), [...activationEvents, ...events], scoreOptions)
    .failures;
}

function scorePlanCommand(command, expected = { shouldUseLocalYdbSkill: true }) {
  return scoreWith(
    [
      { type: "item.completed", item: { type: "command_execution", command } },
      finalAnswerEvent(),
    ],
    expected,
  );
}

describe("loadCases", () => {
  const stableCasesPath = fileURLToPath(
    new URL("../../evals/local-ydb-agent/cases.json", import.meta.url),
  );

  function writeCases(root, cases) {
    const casesPath = join(root, "cases.json");
    writeFileSync(casesPath, JSON.stringify(cases));
    return casesPath;
  }

  function minimalCase(overrides = {}) {
    return {
      id: "minimal-case",
      name: "Minimal case",
      prompt: "Prompt",
      expected: { shouldUseLocalYdbSkill: true },
      ...overrides,
    };
  }

  it("loads the stable suite and keeps the negative control explicit", () => {
    const cases = loadCases(stableCasesPath);

    expect(cases.map((testCase) => testCase.id)).toEqual([
      "explicit-database-diagnosis",
      "root-bootstrap-default",
      "cms-tenant-graphshard-bootstrap",
      "schema-generate-apply",
      "version-upgrade-backup-first",
      "storage-reduction-rebuild",
      "path-level-dump-restore",
      "auth-hardening-backup-first",
      "auth-hardening-copied-volume-rehearsal",
      "cleanup-storage-plan-only",
      "upstream-ydb-source-lookup",
      "negative-unrelated-python-test",
    ]);
    expect(
      cases.find((testCase) => testCase.id === "negative-unrelated-python-test"),
    ).toMatchObject({
      expected: {
        shouldUseLocalYdbSkill: false,
        requiredOrderedTools: [],
      },
    });
  });

  it("keeps content checks attached to the upgrade case", () => {
    const cases = loadCases(stableCasesPath);

    expect(
      cases.find((testCase) => testCase.id === "version-upgrade-backup-first"),
    ).toMatchObject({
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
        requiredTerms: ["dump", "restore", "until completed"],
        requiredToolEntryTerms: {
          local_ydb_pull_image: [
            "image=ghcr.io/ydb-platform/local-ydb:26.1.1.7",
          ],
          local_ydb_pull_status: ["jobId=<returned-jobId>"],
          local_ydb_upgrade_version: ["version=26.1.1.7"],
        },
        forbiddenTerms: ["confirm: true", '"confirm": true', "confirm=true"],
      },
    });
  });

  it("keeps workflow-critical verification steps in the stable cases", () => {
    const cases = loadCases(stableCasesPath);
    const requiredTools = (id) =>
      cases.find((testCase) => testCase.id === id).expected.requiredOrderedTools;

    expect(requiredTools("cms-tenant-graphshard-bootstrap")).toEqual([
      "local_ydb_check_prerequisites",
      "local_ydb_bootstrap",
      "local_ydb_database_status",
      "local_ydb_tenant_check",
      "local_ydb_nodes_check",
      "local_ydb_graphshard_check",
    ]);
    expect(
      cases.find((testCase) => testCase.id === "cms-tenant-graphshard-bootstrap")
        .expected,
    ).toMatchObject({
      requiredTerms: [
        "CMS",
        "GraphShard",
        "dynamic",
        "profile=analytics configured databasePath=/local/analytics",
      ],
      requiredToolEntryTerms: {
        local_ydb_check_prerequisites: ["profile=analytics"],
        local_ydb_bootstrap: ["profile=analytics"],
        local_ydb_database_status: ["profile=analytics"],
        local_ydb_tenant_check: ["profile=analytics"],
        local_ydb_nodes_check: ["profile=analytics"],
        local_ydb_graphshard_check: ["profile=analytics"],
      },
    });
    expect(requiredTools("schema-generate-apply")).toEqual([
      "local_ydb_status_report",
      "local_ydb_scheme",
      "local_ydb_generate_schema",
      "local_ydb_apply_schema",
      "local_ydb_apply_schema",
      "local_ydb_scheme",
    ]);
    expect(
      cases.find((testCase) => testCase.id === "schema-generate-apply").expected
        .requiredTerms,
    ).toEqual(["plan"]);
    expect(
      cases.find((testCase) => testCase.id === "schema-generate-apply").expected
        .requiredToolEntryTerms,
    ).toEqual({
      local_ydb_generate_schema: [
        [
          "statements=[{kind=createTable,tableName=<table>,columns=<columns>,primaryKey=<primary-key>,store=row,indexes=[{name=<index>,columns=<index-columns>,using=secondary,global=true}]}]",
          "validate=true",
        ],
      ],
      local_ydb_apply_schema: [
        ["action=validate", "script=<generated-script>"],
        ["action=apply", "script=<generated-script>"],
      ],
      local_ydb_scheme: [
        "action=list",
        ["action=describe", "path=<table>"],
      ],
    });
    expect(
      cases.find((testCase) => testCase.id === "version-upgrade-backup-first")
        .expected.requiredToolEntryTerms,
    ).toEqual({
      local_ydb_pull_image: [
        "image=ghcr.io/ydb-platform/local-ydb:26.1.1.7",
      ],
      local_ydb_pull_status: ["jobId=<returned-jobId>"],
      local_ydb_upgrade_version: ["version=26.1.1.7"],
    });
    expect(
      cases.find((testCase) => testCase.id === "storage-reduction-rebuild")
        .expected.requiredToolEntryTerms,
    ).toEqual({
      local_ydb_reduce_storage_groups: [
        ["count=1", "poolName=<returned-poolName>"],
      ],
    });
    expect(
      cases.find((testCase) => testCase.id === "path-level-dump-restore")
        .expected.requiredTerms,
    ).toEqual([
      "local_ydb_dump_tenant path=smoke_src",
      "local_ydb_restore_tenant path=smoke_dst",
      "describePaths",
      "countQueries",
    ]);
    expect(
      cases.find((testCase) => testCase.id === "path-level-dump-restore")
        .expected.requiredToolEntryTerms,
    ).toEqual({
      local_ydb_dump_tenant: ["path=smoke_src"],
      local_ydb_restore_tenant: [
        [
          "path=smoke_dst",
          "dumpName=<selected-dumpName>",
          "describePaths=<verification-paths>",
          "countQueries=<verification-queries>",
        ],
      ],
    });
    expect(requiredTools("auth-hardening-backup-first")).toEqual([
      "local_ydb_status_report",
      "local_ydb_dump_tenant",
      "local_ydb_prepare_auth_config",
      "local_ydb_write_dynamic_auth_config",
      "local_ydb_apply_auth_hardening",
      "local_ydb_auth_check",
      "local_ydb_status_report",
    ]);
    expect(
      cases.find((testCase) => testCase.id === "auth-hardening-backup-first")
        .prompt,
    ).toContain("instead of the copied-volume rehearsal alternative");
    expect(
      cases.find((testCase) => testCase.id === "auth-hardening-backup-first")
        .expected.requiredToolEntryTerms,
    ).toEqual({
      local_ydb_dump_tenant: ["dumpName=pre-auth-hardening"],
      local_ydb_prepare_auth_config: [
        [
          "configHostPath=<prepared-config-host-path>",
          "sid=<selected-sid>",
        ],
      ],
      local_ydb_write_dynamic_auth_config: [
        ["sid=<selected-sid>", "tokenHostPath=<dynamic-token-host-path>"],
      ],
      local_ydb_apply_auth_hardening: [
        "configHostPath=<prepared-config-host-path>",
      ],
    });
    expect(
      cases.find((testCase) => testCase.id === "version-upgrade-backup-first")
        .prompt,
    ).toContain("Use local_ydb_status_report as the selected current-state preflight");
    expect(
      cases
        .filter((testCase) => testCase.expected.requiresPlanFirstGate)
        .map((testCase) => testCase.id),
    ).toEqual([
      "root-bootstrap-default",
      "cms-tenant-graphshard-bootstrap",
      "schema-generate-apply",
      "version-upgrade-backup-first",
      "storage-reduction-rebuild",
      "path-level-dump-restore",
      "auth-hardening-backup-first",
      "auth-hardening-copied-volume-rehearsal",
      "cleanup-storage-plan-only",
    ]);
    expect(
      cases.find((testCase) => testCase.id === "cleanup-storage-plan-only")
        .expected.requiredToolEntryTerms,
    ).toEqual({
      local_ydb_cleanup_storage: [
        [
          "paths=<reviewed-leftover-paths>",
          "volumes=<reviewed-leftover-volumes>",
        ],
      ],
    });
    expect(requiredTools("auth-hardening-copied-volume-rehearsal")).toEqual([
      "local_ydb_status_report",
      "local_ydb_prepare_auth_config",
      "local_ydb_write_dynamic_auth_config",
      "local_ydb_apply_auth_hardening",
      "local_ydb_auth_check",
      "local_ydb_status_report",
    ]);
    expect(
      cases.find(
        (testCase) => testCase.id === "auth-hardening-copied-volume-rehearsal",
      ).expected.requiredToolEntryTerms,
    ).toEqual({
      local_ydb_status_report: [
        "profile=auth-rehearsal",
        "profile=auth-rehearsal",
      ],
      local_ydb_prepare_auth_config: [
        [
          "profile=auth-rehearsal",
          "configHostPath=<rehearsal-config-host-path>",
          "sid=<rehearsal-sid>",
        ],
      ],
      local_ydb_write_dynamic_auth_config: [
        [
          "profile=auth-rehearsal",
          "sid=<rehearsal-sid>",
          "tokenHostPath=<rehearsal-token-host-path>",
        ],
      ],
      local_ydb_apply_auth_hardening: [
        [
          "profile=auth-rehearsal",
          "configHostPath=<rehearsal-config-host-path>",
        ],
      ],
      local_ydb_auth_check: ["profile=auth-rehearsal"],
    });
  });

  it("rejects an empty suite", () => {
    const root = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-"));
    try {
      expect(() => loadCases(writeCases(root, []))).toThrow(
        /must contain at least one case/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe case ids", () => {
    const root = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-"));
    try {
      const casesPath = writeCases(root, [minimalCase({ id: "../escape" })]);
      expect(() => loadCases(casesPath)).toThrow(/safe slug/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-string entries in term arrays", () => {
    const root = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-"));
    try {
      const casesPath = writeCases(root, [
        minimalCase({
          expected: {
            shouldUseLocalYdbSkill: true,
            forbiddenTerms: ["docker", 7],
          },
        }),
      ]);
      expect(() => loadCases(casesPath)).toThrow(
        /expected\.forbiddenTerms must be an array of non-empty strings/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects empty strings in term arrays", () => {
    const root = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-"));
    try {
      const casesPath = writeCases(root, [
        minimalCase({
          expected: {
            shouldUseLocalYdbSkill: true,
            requiredTerms: [""],
          },
        }),
      ]);
      expect(() => loadCases(casesPath)).toThrow(
        /expected\.requiredTerms must be an array of non-empty strings/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown expected fields", () => {
    const root = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-"));
    try {
      const casesPath = writeCases(root, [
        minimalCase({
          expected: {
            shouldUseLocalYdbSkill: true,
            forbiddenTool: "local_ydb_upgrade_version",
          },
        }),
      ]);
      expect(() => loadCases(casesPath)).toThrow(
        /unknown expected field: forbiddenTool/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown top-level case fields", () => {
    const root = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-"));
    try {
      const casesPath = writeCases(root, [
        minimalCase({ timeout: 120000 }),
      ]);
      expect(() => loadCases(casesPath)).toThrow(/unknown field: timeout/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects allowedExtraToolsBefore keys that are not declared extras", () => {
    const root = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-"));
    try {
      const casesPath = writeCases(root, [
        minimalCase({
          expected: {
            shouldUseLocalYdbSkill: true,
            requiredOrderedTools: ["local_ydb_upgrade_version"],
            allowedExtraToolsBefore: {
              local_ydb_dump_tenant: "local_ydb_upgrade_version",
            },
          },
        }),
      ]);
      expect(() => loadCases(casesPath)).toThrow(
        /allowedExtraToolsBefore key must be listed in allowedExtraTools: local_ydb_dump_tenant/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects allowedExtraToolsBefore targets that are not required tools", () => {
    const root = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-"));
    try {
      const casesPath = writeCases(root, [
        minimalCase({
          expected: {
            shouldUseLocalYdbSkill: true,
            requiredOrderedTools: ["local_ydb_status_report"],
            allowedExtraTools: ["local_ydb_dump_tenant"],
            allowedExtraToolsBefore: {
              local_ydb_dump_tenant: "local_ydb_upgrade_version",
            },
          },
        }),
      ]);
      expect(() => loadCases(casesPath)).toThrow(
        /allowedExtraToolsBefore target must be listed in requiredOrderedTools: local_ydb_upgrade_version/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects tool-entry terms without enough required tool occurrences", () => {
    const root = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-"));
    try {
      const casesPath = writeCases(root, [
        minimalCase({
          expected: {
            shouldUseLocalYdbSkill: true,
            requiredOrderedTools: ["local_ydb_apply_schema"],
            requiredToolEntryTerms: {
              local_ydb_apply_schema: ["action=validate", "action=apply"],
            },
          },
        }),
      ]);
      expect(() => loadCases(casesPath)).toThrow(
        /requiredToolEntryTerms has 2 terms for 1 required occurrences: local_ydb_apply_schema/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseJsonlEvents", () => {
  it("collects malformed lines as errors instead of throwing", () => {
    const parsed = parseJsonlEvents('{"ok":true}\nnot json\n');

    expect(parsed.events).toEqual([{ ok: true }]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatch(/^line 2: /);
  });
});

describe("parseArgs", () => {
  it("rejects options that are missing values", () => {
    expect(() => parseArgs(["--case"])).toThrow(/--case requires <id>/);
    expect(() => parseArgs(["--cases"])).toThrow(/--cases requires <path>/);
    expect(() => parseArgs(["--schema"])).toThrow(/--schema requires <path>/);
    expect(() => parseArgs(["--model"])).toThrow(/--model requires <name>/);
  });

  it("rejects dash-prefixed option values", () => {
    expect(() => parseArgs(["--case", "--list"])).toThrow(
      /--case requires <id>/,
    );
    expect(() => parseArgs(["--cases", "--case", "x"])).toThrow(
      /--cases requires <path>/,
    );
    expect(() => parseArgs(["--schema", "--case", "x"])).toThrow(
      /--schema requires <path>/,
    );
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument: --bogus/);
  });

  it("accepts options with values", () => {
    expect(
      parseArgs([
        "--case",
        "version-upgrade-backup-first",
        "--cases",
        "cases.json",
        "--schema",
        "schema.json",
        "--model",
        "gpt-5.3-codex-spark",
      ]),
    ).toEqual({
      list: false,
      caseId: "version-upgrade-backup-first",
      casesPath: resolve("cases.json"),
      schemaPath: resolve("schema.json"),
      model: "gpt-5.3-codex-spark",
    });
  });
});

describe("script CLI", () => {
  const scriptPath = fileURLToPath(
    new URL("./run-local-ydb-agent-evals.mjs", import.meta.url),
  );

  it("lists stable cases without requiring Codex credentials", () => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--list", "--case", "missing-case"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("explicit-database-diagnosis");
    expect(result.stdout).toContain("negative-unrelated-python-test");
  });

  it("rejects an unknown --case before requiring credentials", () => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--case", "missing-case"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown eval case: missing-case");
  });

  it("prints usage without requiring Codex credentials", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--help"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Usage: npm run eval:agent -- [--list] [--case <id>] [--cases <path>] [--schema <path>] [--model <name>] [--help]",
    );
  });
});

describe("codex process helpers", () => {
  it("maps signal termination to exit code 1", () => {
    expect(codexExitCode({ status: null, signal: "SIGTERM" })).toBe(1);
  });

  it("keeps a numeric exit code", () => {
    expect(codexExitCode({ status: 3, signal: null })).toBe(3);
  });

  it("prefers the spawn error message when stderr is empty", () => {
    expect(
      codexStderrLog({
        stderr: "",
        error: new Error('spawn "codex" failed'),
      }),
    ).toContain('spawn "codex" failed');
  });

  it("returns trimmed stderr", () => {
    expect(codexStderrLog({ stderr: "boom\n", error: undefined })).toBe(
      "boom\n",
    );
  });
});

describe("buildPrompt", () => {
  it("embeds the case prompt and the plan-only rules", () => {
    const prompt = buildPrompt(
      makeCase({ shouldUseLocalYdbSkill: true }, "case-id"),
    );

    expect(prompt).toContain("plan-only eval");
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain("space-separated key=value argument summaries");
    expect(prompt).toContain("one non-whitespace token");
    expect(prompt).toContain("do not use a JSON argument object");
    expect(prompt).toContain("Eval task:");
    expect(prompt).not.toContain("local-ydb");
    expect(prompt).not.toContain("unrelated tasks");
  });

  it("documents the canonical tool-sequence argument syntax in the output schema", () => {
    const schemaPath = fileURLToPath(
      new URL("../../evals/local-ydb-agent/final-answer.schema.json", import.meta.url),
    );
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

    expect(schema.properties.tool_sequence.items.description).toContain(
      "space-separated key=value argument summaries",
    );
    expect(schema.properties.tool_sequence.items.description).toContain(
      "one non-whitespace token",
    );
    expect(schema.properties.tool_sequence.items.description).toContain(
      "do not use a JSON argument object",
    );
  });
});

describe("createEvalWorkspace", () => {
  function makeRepo(root) {
    const repoRoot = join(root, "repo");
    mkdirSync(join(repoRoot, "skills", "local-ydb"), { recursive: true });
    mkdirSync(join(repoRoot, "evals", "local-ydb-agent"), { recursive: true });
    writeFileSync(join(repoRoot, "skills", "local-ydb", "SKILL.md"), "skill\n");
    writeFileSync(
      join(repoRoot, "evals", "local-ydb-agent", "final-answer.schema.json"),
      '{"type":"object"}\n',
    );
    return repoRoot;
  }

  it("copies the skill and schema into an isolated workspace", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-test-"));
    const repoRoot = makeRepo(tempRoot);

    const workspace = createEvalWorkspace({
      repoRoot,
      tempRoot: join(tempRoot, "work"),
      resultsRoot: join(tempRoot, "results"),
    });
    try {
      expect(workspace.ownsTempRoot).toBe(false);
      expect(workspace.repoRoot).toBe(join(tempRoot, "work", "checkout"));
      expect(workspace.schemaPath).toBe(
        join(
          tempRoot,
          "work",
          "checkout",
          "evals",
          "local-ydb-agent",
          "final-answer.schema.json",
        ),
      );
      expect(
        readFileSync(
          join(workspace.codexHome, "skills", "local-ydb", "SKILL.md"),
          "utf8",
        ),
      ).toBe("skill\n");
      // The skill must be installed into exactly one discovery root so
      // current Codex CLI versions advertise a single local-ydb entry.
      expect(
        existsSync(join(workspace.homeDir, ".agents", "skills")),
      ).toBe(false);
      expect(
        readFileSync(
          join(workspace.repoRoot, "skills", "local-ydb", "SKILL.md"),
          "utf8",
        ),
      ).toBe("skill\n");
      expect(readFileSync(workspace.schemaPath, "utf8")).toBe(
        '{"type":"object"}\n',
      );
      expect(existsSync(workspace.resultsDir)).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("cleans up its results dir when setup fails", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-test-"));
    const repoRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-repo-"));
    const resultsRoot = join(tempRoot, "results");
    try {
      expect(() =>
        createEvalWorkspace({
          repoRoot,
          tempRoot: join(tempRoot, "work"),
          resultsRoot,
        }),
      ).toThrow(/skill not found/);
      expect(existsSync(resultsRoot)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("removes an owned temp root when setup fails", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-repo-"));
    const leftoversBefore = readdirSync(tmpdir()).filter((entry) =>
      entry.startsWith("local-ydb-agent-evals-"),
    ).length;
    try {
      expect(() => createEvalWorkspace({ repoRoot })).toThrow(
        /skill not found/,
      );
      const leftoversAfter = readdirSync(tmpdir()).filter((entry) =>
        entry.startsWith("local-ydb-agent-evals-"),
      ).length;
      expect(leftoversAfter).toBe(leftoversBefore);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("creates unique results dirs for consecutive runs", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-test-"));
    const repoRoot = makeRepo(tempRoot);

    const first = createEvalWorkspace({
      repoRoot,
      tempRoot: join(tempRoot, "work-a"),
      resultsRoot: join(tempRoot, "results"),
    });
    const second = createEvalWorkspace({
      repoRoot,
      tempRoot: join(tempRoot, "work-b"),
      resultsRoot: join(tempRoot, "results"),
    });
    try {
      expect(first.resultsDir).not.toBe(second.resultsDir);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("owns its temp root only when no custom tempRoot is provided", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-test-"));
    const repoRoot = makeRepo(tempRoot);

    const owned = createEvalWorkspace({
      repoRoot,
      resultsRoot: join(tempRoot, "results"),
    });
    const unowned = createEvalWorkspace({
      repoRoot,
      tempRoot: join(tempRoot, "work"),
      resultsRoot: join(tempRoot, "results"),
    });
    try {
      expect(owned.ownsTempRoot).toBe(true);
      expect(unowned.ownsTempRoot).toBe(false);
      expect(existsSync(owned.tempRoot)).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(owned.tempRoot, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("buildCodexEnv", () => {
  it("builds a minimal env and forwards only transport vars", () => {
    const env = buildCodexEnv({
      path: "/usr/bin",
      homeDir: "/home/tester",
      codexHome: "/tmp/codex-home",
      apiKey: "secret",
      transportEnv: {
        HTTP_PROXY: "http://proxy",
        ALL_PROXY: "socks5://proxy",
        CODEX_CA_CERTIFICATE: "/tmp/company-ca.pem",
        UNRELATED: "nope",
      },
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      CODEX_HOME: "/tmp/codex-home",
      CODEX_API_KEY: "secret",
      HTTP_PROXY: "http://proxy",
      ALL_PROXY: "socks5://proxy",
      CODEX_CA_CERTIFICATE: "/tmp/company-ca.pem",
    });
  });

  it("falls back to process.env.Path when PATH is absent", () => {
    const originalPath = process.env.PATH;
    const originalPathFallback = process.env.Path;
    delete process.env.PATH;
    process.env.Path = "/fallback/bin";
    try {
      const env = buildCodexEnv({
        homeDir: "/home/tester",
        codexHome: "/tmp/codex-home",
        apiKey: "secret",
        transportEnv: {},
      });
      expect(env.PATH).toBe("/fallback/bin");
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPathFallback === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = originalPathFallback;
      }
    }
  });
});

describe("buildCodexArgs", () => {
  it("puts --model before the prompt", () => {
    const args = buildCodexArgs({
      repoRoot: "/repo",
      prompt: "do things",
      schemaPath: "/tmp/schema.json",
      model: "gpt-5.3-codex-spark",
    });

    expect(args[0]).toBe("exec");
    expect(args).toContain("--output-schema");
    expect(args[args.indexOf("--output-schema") + 1]).toBe("/tmp/schema.json");
    expect(args[args.indexOf("-C") + 1]).toBe("/repo");
    expect(args[args.length - 3]).toBe("--model");
    expect(args[args.length - 2]).toBe("gpt-5.3-codex-spark");
    expect(args[args.length - 1]).toBe("do things");
  });

  it("omits --model when no model is pinned", () => {
    const args = buildCodexArgs({
      repoRoot: "/repo",
      prompt: "do things",
      schemaPath: "/tmp/schema.json",
    });

    expect(args).not.toContain("--model");
    expect(args[args.length - 1]).toBe("do things");
  });
});

describe("buildCodexSpawnOptions", () => {
  const workspace = { homeDir: "/tmp/home", codexHome: "/tmp/codex-home" };

  it("uses the default timeout when the case does not override it", () => {
    const options = buildCodexSpawnOptions(workspace, {
      repoRoot: "/tmp/checkout",
      apiKey: "secret",
    });

    expect(options.timeout).toBe(defaultCaseTimeoutMs);
    expect(options.cwd).toBe("/tmp/checkout");
    expect(options.env.HOME).toBe("/tmp/home");
    expect(options.env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(options.env.CODEX_API_KEY).toBe("secret");
  });

  it("honors a timeout override", () => {
    const options = buildCodexSpawnOptions(workspace, {
      repoRoot: "/tmp/checkout",
      apiKey: "secret",
      timeoutMs: 1000,
    });

    expect(options.timeout).toBe(1000);
  });
});

describe("scoreCase", () => {
  it("passes when ordered tools and safety gates are present", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: [
            "local_ydb_status_report",
            "local_ydb_healthcheck",
          ],
          safety_gates: ["read-only plan"],
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [
          "local_ydb_status_report",
          "local_ydb_healthcheck",
        ],
        requiredTerms: ["read-only"],
        forbiddenTerms: ["confirm=true"],
      },
    );

    expect(failures).toEqual([]);
  });

  it("parses the leading tool name from enriched sequence entries", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: [
            "local_ydb_status_report profile=local",
            "local_ydb_apply_schema action=validate",
            "local_ydb_apply_schema action=apply",
          ],
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [
          "local_ydb_status_report",
          "local_ydb_apply_schema",
          "local_ydb_apply_schema",
        ],
        requiredToolEntryTerms: {
          local_ydb_apply_schema: ["action=validate", "action=apply"],
        },
      },
    );

    expect(failures).toEqual([]);
  });

  it("rejects JSON argument objects in the canonical tool sequence", () => {
    const entry =
      'local_ydb_apply_schema {"action":"validate","script":"<generated-script>"}';
    const failures = scoreWith(
      [finalAnswerEvent({ tool_sequence: [entry] })],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_apply_schema"],
      },
    );

    expect(failures).toContain(
      `tool sequence entry must use key=value arguments, not JSON: ${entry}`,
    );
  });

  it("matches required tool argument values at complete boundaries", () => {
    for (const { tool, term, extendedValue } of [
      {
        tool: "local_ydb_reduce_storage_groups",
        term: "count=1",
        extendedValue: "count=10",
      },
      {
        tool: "local_ydb_status_report",
        term: "profile=auth-rehearsal",
        extendedValue: "profile=auth-rehearsal-live",
      },
      {
        tool: "local_ydb_status_report",
        term: "profile=auth-rehearsal",
        extendedValue: "profile=auth-rehearsal~live",
      },
    ]) {
      const expected = {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [tool],
        requiredToolEntryTerms: { [tool]: [term] },
      };

      expect(
        scoreWith(
          [finalAnswerEvent({ tool_sequence: [`${tool} ${extendedValue}`] })],
          expected,
        ),
      ).toContain(
        `tool sequence entry ${tool} #1 missing required term: ${term}`,
      );
      expect(
        scoreWith(
          [finalAnswerEvent({ tool_sequence: [`${tool} ${term}`] })],
          expected,
        ),
      ).toEqual([]);
    }
  });

  it("requires a nonempty single-token value for wildcard tool arguments", () => {
    const tool = "local_ydb_generate_schema";
    const expected = {
      shouldUseLocalYdbSkill: true,
      requiredOrderedTools: [tool],
      requiredToolEntryTerms: { [tool]: ["statements="] },
    };

    expect(
      scoreWith(
        [finalAnswerEvent({ tool_sequence: [`${tool} statements=`] })],
        expected,
      ),
    ).toContain(
      `tool sequence entry ${tool} #1 missing required term: statements=`,
    );
    expect(
      scoreWith(
        [
          finalAnswerEvent({
            tool_sequence: [`${tool} statements=[{kind=createTable}]`],
          }),
        ],
        expected,
      ),
    ).toEqual([]);
  });

  it("rejects duplicate tool argument keys", () => {
    for (const { tool, requiredTerm, entry, duplicateKey } of [
      {
        tool: "local_ydb_status_report",
        requiredTerm: "profile=auth-rehearsal",
        entry:
          "local_ydb_status_report profile=auth-rehearsal profile=live",
        duplicateKey: "profile",
      },
      {
        tool: "local_ydb_reduce_storage_groups",
        requiredTerm: "count=1",
        entry: "local_ydb_reduce_storage_groups count=1 count=10",
        duplicateKey: "count",
      },
    ]) {
      const failures = scoreWith(
        [finalAnswerEvent({ tool_sequence: [entry] })],
        {
          shouldUseLocalYdbSkill: true,
          requiredOrderedTools: [tool],
          requiredToolEntryTerms: { [tool]: [requiredTerm] },
        },
      );

      expect(failures, entry).toContain(
        `tool sequence entry has duplicate argument key ${duplicateKey}: ${entry}`,
      );
    }
  });

  it("rejects malformed tool arguments", () => {
    const entry =
      "local_ydb_reduce_storage_groups count=1 poolName=<returned-poolName> count:10";
    const failures = scoreWith(
      [finalAnswerEvent({ tool_sequence: [entry] })],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_reduce_storage_groups"],
        requiredToolEntryTerms: {
          local_ydb_reduce_storage_groups: [
            "count=1",
            "poolName=<returned-poolName>",
          ],
        },
      },
    );

    expect(failures).toContain(
      `tool sequence entry has malformed argument count:10: ${entry}`,
    );
  });

  it("fails when should_use_local_ydb_skill mismatches", () => {
    const failures = scoreWith(
      [finalAnswerEvent({ should_use_local_ydb_skill: false })],
      { shouldUseLocalYdbSkill: true },
    );

    expect(failures).toContain("should_use_local_ydb_skill expected true");
  });

  it("requires trace evidence for positive skill activation", () => {
    const failures = scoreWith(
      [finalAnswerEvent()],
      { shouldUseLocalYdbSkill: true },
      { omitSkillActivation: true },
    );

    expect(failures).toContain(
      "positive case has no local-ydb skill activation evidence",
    );

    const listingFailures = scoreWith(
      [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "ls $CODEX_HOME/skills/local-ydb",
          },
        },
        finalAnswerEvent(),
      ],
      { shouldUseLocalYdbSkill: true },
      { omitSkillActivation: true },
    );
    expect(listingFailures).toContain(
      "positive case has no local-ydb skill activation evidence",
    );

    const echoedReaderFailures = scoreWith(
      [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "echo cat $CODEX_HOME/skills/local-ydb/SKILL.md",
          },
        },
        finalAnswerEvent(),
      ],
      { shouldUseLocalYdbSkill: true },
      { omitSkillActivation: true },
    );
    expect(echoedReaderFailures).toContain(
      "positive case has no local-ydb skill activation evidence",
    );

    const failedReaderFailures = scoreWith(
      [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "cat /does-not-exist/skills/local-ydb/SKILL.md",
            exit_code: 1,
            status: "failed",
          },
        },
        finalAnswerEvent(),
      ],
      { shouldUseLocalYdbSkill: true },
      { omitSkillActivation: true },
    );
    expect(failedReaderFailures).toContain(
      "positive case has no local-ydb skill activation evidence",
    );
  });

  it("requires would_execute_confirmed_mutation to stay false", () => {
    const failures = scoreWith(
      [finalAnswerEvent({ would_execute_confirmed_mutation: true })],
      { shouldUseLocalYdbSkill: true },
    );

    expect(failures).toContain("would_execute_confirmed_mutation must be false");
  });

  it("requires an explicit plan-first gate for mutating cases", () => {
    const missingGate = scoreWith(
      [finalAnswerEvent({ answer: "Describe the mutation." })],
      {
        shouldUseLocalYdbSkill: true,
        requiresPlanFirstGate: true,
      },
    );
    expect(missingGate).toContain("missing explicit plan-first safety gate");

    for (const safetyGate of [
      "plan-only",
      "no confirmed mutation",
      "requires explicit approval",
      "run without confirm",
    ]) {
      const failures = scoreWith(
        [finalAnswerEvent({ safety_gates: [safetyGate] })],
        {
          shouldUseLocalYdbSkill: true,
          requiresPlanFirstGate: true,
        },
      );
      expect(failures, safetyGate).toEqual([]);
    }
  });

  it("rejects compact confirmed-mutation argument spellings", () => {
    for (const confirmation of [
      "confirm:true",
      '"confirm":true',
      "confirm : 'true'",
      "confirm true",
      "'confirm' 'true'",
    ]) {
      const failures = scoreWith(
        [
          finalAnswerEvent({
            tool_sequence: [`local_ydb_cleanup_storage ${confirmation}`],
          }),
        ],
        {
          shouldUseLocalYdbSkill: true,
          requiredOrderedTools: ["local_ydb_cleanup_storage"],
        },
      );
      expect(failures, confirmation).toContain(
        "confirmed mutation argument present",
      );
    }

    const falseConfirmation = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: ["local_ydb_cleanup_storage confirm=false"],
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_cleanup_storage"],
      },
    );
    expect(falseConfirmation).toEqual([]);
  });

  it("fails on missing and out-of-order required tools", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: [
            "local_ydb_upgrade_version",
            "local_ydb_status_report",
          ],
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [
          "local_ydb_status_report",
          "local_ydb_list_dumps",
          "local_ydb_upgrade_version",
          "local_ydb_status_report",
        ],
      },
    );

    expect(failures).toContain("missing required tool local_ydb_list_dumps");
    expect(
      failures.some((failure) =>
        failure.startsWith("required tools are out of order: "),
      ),
    ).toBe(true);
  });

  it("repeated required tools accept successive occurrences", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: [
            "local_ydb_status_report",
            "local_ydb_upgrade_version",
            "local_ydb_status_report",
          ],
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [
          "local_ydb_status_report",
          "local_ydb_upgrade_version",
          "local_ydb_status_report",
        ],
      },
    );

    expect(failures).toEqual([]);
  });

  it("rejects excess required tool occurrences unless explicitly allowed", () => {
    const tool = "local_ydb_apply_schema";
    const sequence = [
      `${tool} action=validate script=<generated-script>`,
      `${tool} action=apply script=<unreviewed-script>`,
    ];
    const failures = scoreWith(
      [finalAnswerEvent({ tool_sequence: sequence })],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [tool],
      },
    );

    expect(failures).toContain(
      `required tool ${tool} appears 2 times; expected at most 1`,
    );
    expect(
      scoreWith(
        [finalAnswerEvent({ tool_sequence: sequence })],
        {
          shouldUseLocalYdbSkill: true,
          requiredOrderedTools: [tool],
          allowedExtraTools: [tool],
        },
      ),
    ).toEqual([]);
  });

  it("requires the final schema describe after plan-only apply", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: [
            "local_ydb_status_report",
            "local_ydb_scheme",
            "local_ydb_generate_schema",
            "local_ydb_apply_schema",
            "local_ydb_apply_schema",
          ],
          answer: "Use action=validate, then action=apply for the plan.",
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [
          "local_ydb_status_report",
          "local_ydb_scheme",
          "local_ydb_generate_schema",
          "local_ydb_apply_schema",
          "local_ydb_apply_schema",
          "local_ydb_scheme",
        ],
        requiredTerms: ["action=validate", "action=apply", "plan"],
      },
    );

    expect(failures).toContain(
      "required tools are out of order: local_ydb_status_report -> local_ydb_scheme -> local_ydb_generate_schema -> local_ydb_apply_schema -> local_ydb_apply_schema -> local_ydb_scheme",
    );
  });

  it("requires call-specific dump source and restore destination guidance", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          answer:
            "Use local_ydb_dump_tenant path=smoke_dst, then local_ydb_restore_tenant path=smoke_src.",
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredTerms: [
          "local_ydb_dump_tenant path=smoke_src",
          "local_ydb_restore_tenant path=smoke_dst",
        ],
      },
    );

    expect(failures).toContain(
      "missing required term: local_ydb_dump_tenant path=smoke_src",
    );
    expect(failures).toContain(
      "missing required term: local_ydb_restore_tenant path=smoke_dst",
    );
  });

  it("binds schema action terms to the corresponding tool entries", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: [
            "local_ydb_apply_schema action=apply",
            "local_ydb_apply_schema action=validate",
          ],
          answer: "Use action=validate before action=apply.",
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [
          "local_ydb_apply_schema",
          "local_ydb_apply_schema",
        ],
        requiredToolEntryTerms: {
          local_ydb_apply_schema: ["action=validate", "action=apply"],
        },
      },
    );

    expect(failures).toContain(
      "tool sequence entry local_ydb_apply_schema #1 missing required term: action=validate",
    );
    expect(failures).toContain(
      "tool sequence entry local_ydb_apply_schema #2 missing required term: action=apply",
    );
  });

  it("requires every term in an occurrence term group on the same tool entry", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: ["local_ydb_restore_tenant path=smoke_dst"],
          answer: "Use dumpName=<selected-dumpName> from the listing.",
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_restore_tenant"],
        requiredToolEntryTerms: {
          local_ydb_restore_tenant: [
            ["path=smoke_dst", "dumpName=<selected-dumpName>"],
          ],
        },
      },
    );

    expect(failures).toContain(
      "tool sequence entry local_ydb_restore_tenant #1 missing required term: dumpName=<selected-dumpName>",
    );
  });

  it("rejects a tool that first runs before a repeated prerequisite", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: ["A", "B", "C", "A", "C"],
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["A", "B", "A", "C"],
      },
    );

    expect(failures).toContain(
      "required tools are out of order: A -> B -> A -> C",
    );
  });

  it("flags unexpected tools in sequence and answer text", () => {
    const sequenceFailures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: [
            "local_ydb_status_report",
            "local_ydb_apply_schema",
          ],
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_status_report"],
      },
    );
    expect(sequenceFailures).toContain(
      "unexpected tool present: local_ydb_apply_schema",
    );

    const sequenceDetailsFailures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: [
            "local_ydb_status_report then local_ydb_apply_schema",
          ],
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_status_report"],
      },
    );
    expect(sequenceDetailsFailures).toContain(
      "unexpected tool present in sequence details: local_ydb_apply_schema",
    );

    const answerFailures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: ["local_ydb_status_report"],
          answer: "I would also run local_ydb_apply_schema afterwards.",
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: ["local_ydb_status_report"],
      },
    );
    expect(answerFailures).toContain(
      "unexpected tool recommended in answer text: local_ydb_apply_schema",
    );
  });

  it("allows extras before the guarded tool but not after", () => {
    const expected = {
      shouldUseLocalYdbSkill: true,
      requiredOrderedTools: [
        "local_ydb_status_report",
        "local_ydb_upgrade_version",
      ],
      allowedExtraTools: ["local_ydb_dump_tenant"],
      allowedExtraToolsBefore: {
        local_ydb_dump_tenant: "local_ydb_upgrade_version",
      },
    };
    const run = (sequence) =>
      scoreWith([finalAnswerEvent({ tool_sequence: sequence })], expected);

    expect(
      run([
        "local_ydb_status_report",
        "local_ydb_dump_tenant",
        "local_ydb_upgrade_version",
      ]),
    ).toEqual([]);
    expect(
      run([
        "local_ydb_status_report",
        "local_ydb_upgrade_version",
        "local_ydb_dump_tenant",
      ]),
    ).toContain(
      "allowed extra tool local_ydb_dump_tenant must appear before local_ydb_upgrade_version",
    );
  });

  it("flags forbidden tools by exact name without matching longer names", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: [
            "local_ydb_bootstrap_root_database",
            "local_ydb_bootstrap",
          ],
          answer:
            "Run local_ydb_bootstrap_root_database first, then local_ydb_bootstrap.",
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [
          "local_ydb_bootstrap_root_database",
          "local_ydb_bootstrap",
        ],
        forbiddenTools: ["local_ydb_bootstrap"],
      },
    );

    // local_ydb_bootstrap_root_database is not flagged: the match is exact.
    expect(failures).toEqual([
      "forbidden tool present: local_ydb_bootstrap",
      "forbidden tool present in answer text: local_ydb_bootstrap",
    ]);
  });

  it("flags forbidden tool prefixes", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          answer: "I would call local_ydb_destroy_stack here.",
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        forbiddenToolPrefixes: ["local_ydb_destroy"],
      },
    );

    expect(failures).toContain(
      "forbidden tool prefix present in answer text: local_ydb_destroy",
    );
  });

  it("checks required and forbidden terms literally", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          answer: "The plan stays read-only and I would never pass confirm=true.",
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredTerms: ["read-only"],
        forbiddenTerms: ["confirm=true"],
      },
    );

    // A negated mention still counts as a hit: matching is literal by contract.
    expect(failures).toContain("confirmed mutation argument present");
    expect(failures).toContain("forbidden term present: confirm=true");
  });

  it("reports missing required terms", () => {
    const failures = scoreWith([finalAnswerEvent({ answer: "All good." })], {
      shouldUseLocalYdbSkill: true,
      requiredTerms: ["read-only"],
    });

    expect(failures).toEqual(["missing required term: read-only"]);
  });

  it("scans interim agent messages for forbidden terms", () => {
    const failures = scoreWith(
      [
        agentMessageEvent("Working on it, I would apply confirm=true here."),
        finalAnswerEvent(),
      ],
      {
        shouldUseLocalYdbSkill: true,
        forbiddenTerms: ["confirm=true"],
      },
    );

    expect(failures).toContain(
      "forbidden term present in earlier agent message: confirm=true",
    );
  });

  it("scans interim agent messages for local-ydb mentions in negative controls", () => {
    const failures = scoreWith(
      [
        agentMessageEvent("Let me check whether local_ydb_status_report applies."),
        finalAnswerEvent({ should_use_local_ydb_skill: false, task_type: "other" }),
      ],
      { shouldUseLocalYdbSkill: false },
    );

    expect(failures).toContain(
      "local-ydb tool mentioned in earlier agent message",
    );
  });

  it("rejects explicit local-ydb skill recommendations in negative controls", () => {
    for (const recommendation of [
      "Use the $local-ydb skill.",
      "Use the local-ydb skill.",
      "Use the local YDB skill.",
      "Select skill local-ydb.",
      "Select skill local YDB.",
    ]) {
      const finalFailures = scoreWith(
        [
          finalAnswerEvent({
            should_use_local_ydb_skill: false,
            task_type: "other",
            answer: recommendation,
          }),
        ],
        { shouldUseLocalYdbSkill: false },
      );
      expect(finalFailures, recommendation).toContain(
        "negative control must not recommend the local-ydb skill",
      );

      const interimFailures = scoreWith(
        [
          agentMessageEvent(recommendation),
          finalAnswerEvent({
            should_use_local_ydb_skill: false,
            task_type: "other",
          }),
        ],
        { shouldUseLocalYdbSkill: false },
      );
      expect(interimFailures, recommendation).toContain(
        "local-ydb skill recommended in earlier agent message",
      );
    }
  });

  it("keeps the negative control strict", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          should_use_local_ydb_skill: false,
          task_type: "other",
          tool_sequence: ["local_ydb_status_report"],
          answer: "I would use local_ydb_status_report.",
        }),
      ],
      { shouldUseLocalYdbSkill: false },
    );

    expect(failures).toContain(
      "negative control must not include local-ydb tools",
    );
    expect(failures).toContain(
      "negative control must not mention local-ydb tools",
    );
  });

  it("scans free-form tool sequence entries for tools and forbidden terms", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          should_use_local_ydb_skill: false,
          task_type: "other",
          tool_sequence: ["Run local_ydb_cleanup_storage with confirm=true"],
          answer: "Write a unit test.",
        }),
      ],
      {
        shouldUseLocalYdbSkill: false,
        forbiddenTerms: ["confirm=true"],
      },
    );

    expect(failures).toContain(
      "negative control must not include local-ydb tools",
    );
    expect(failures).toContain(
      "forbidden term present in tool sequence: confirm=true",
    );
  });

  it("scans task_type for tools and forbidden terms", () => {
    const failures = scoreWith(
      [
        finalAnswerEvent({
          should_use_local_ydb_skill: false,
          task_type: "Run local_ydb_cleanup_storage with confirm=true",
          answer: "Write a unit test.",
        }),
      ],
      {
        shouldUseLocalYdbSkill: false,
        forbiddenTerms: ["confirm=true"],
      },
    );

    expect(failures).toContain(
      "negative control must not mention local-ydb tools",
    );
    expect(failures).toContain("forbidden term present: confirm=true");
  });

  it("fails a negative control that reads the installed skill", () => {
    const failures = scoreWith(
      [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "cat $CODEX_HOME/skills/local-ydb/SKILL.md",
          },
        },
        finalAnswerEvent({
          should_use_local_ydb_skill: false,
          task_type: "other",
          answer: "Here is a small unit test.",
        }),
      ],
      { shouldUseLocalYdbSkill: false },
    );

    expect(failures).toContain(
      "trace reads the local-ydb skill in a negative control: cat $CODEX_HOME/skills/local-ydb/SKILL.md",
    );

    // Reading the skill is expected in positive cases: not flagged there.
    const positive = scoreWith(
      [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "cat $CODEX_HOME/skills/local-ydb/SKILL.md",
          },
        },
        finalAnswerEvent(),
      ],
      { shouldUseLocalYdbSkill: true },
    );
    expect(positive).toEqual([]);
  });

  it("recognizes numbered skill reads in positive and negative cases", () => {
    const command = "nl -ba skills/local-ydb/SKILL.md";
    const commandEvent = {
      type: "item.completed",
      item: { type: "command_execution", command, exit_code: 0 },
    };

    expect(
      scoreWith(
        [commandEvent, finalAnswerEvent()],
        { shouldUseLocalYdbSkill: true },
        { omitSkillActivation: true },
      ),
    ).toEqual([]);

    expect(
      scoreWith(
        [
          commandEvent,
          finalAnswerEvent({
            should_use_local_ydb_skill: false,
            task_type: "other",
          }),
        ],
        { shouldUseLocalYdbSkill: false },
      ),
    ).toContain(
      `trace reads the local-ydb skill in a negative control: ${command}`,
    );

    const optionValueCommand = "nl -s skills/local-ydb/SKILL.md README.md";
    const optionValueEvent = {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: optionValueCommand,
        exit_code: 0,
      },
    };
    expect(
      scoreWith(
        [optionValueEvent, finalAnswerEvent()],
        { shouldUseLocalYdbSkill: true },
        { omitSkillActivation: true },
      ),
    ).toContain("positive case has no local-ydb skill activation evidence");
    expect(
      scoreWith(
        [
          optionValueEvent,
          finalAnswerEvent({
            should_use_local_ydb_skill: false,
            task_type: "other",
          }),
        ],
        { shouldUseLocalYdbSkill: false },
      ),
    ).not.toContain(
      `trace reads the local-ydb skill in a negative control: ${optionValueCommand}`,
    );
  });

  it("fails a negative control that expands the installed skill", () => {
    for (const command of ["cat skills/*/SKILL.md"]) {
      const failures = scoreWith(
        [
          {
            type: "item.completed",
            item: { type: "command_execution", command },
          },
          finalAnswerEvent({
            should_use_local_ydb_skill: false,
            task_type: "other",
            answer: "Here is a small unit test.",
          }),
        ],
        { shouldUseLocalYdbSkill: false },
      );

      expect(failures).toContain(
        `trace reads the local-ydb skill in a negative control: ${command}`,
      );
    }
  });

  it("ties the skill path to the segment that reads it", () => {
    const failures = scoreWith(
      [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "echo skills/local-ydb/SKILL.md; cat README.md",
            exit_code: 0,
            status: "completed",
          },
        },
        finalAnswerEvent(),
      ],
      { shouldUseLocalYdbSkill: true },
      { omitSkillActivation: true },
    );

    expect(failures).toContain(
      "positive case has no local-ydb skill activation evidence",
    );
  });

  it("ignores skill paths inside unquoted shell comments", () => {
    const command =
      "cat skills/local-ydb/references/evals.md # skills/local-ydb/SKILL.md";
    const commandEvent = {
      type: "item.completed",
      item: { type: "command_execution", command, exit_code: 0 },
    };

    expect(
      scoreWith(
        [commandEvent, finalAnswerEvent()],
        { shouldUseLocalYdbSkill: true },
        { omitSkillActivation: true },
      ),
    ).toContain("positive case has no local-ydb skill activation evidence");
    expect(
      scoreWith(
        [
          commandEvent,
          finalAnswerEvent({
            should_use_local_ydb_skill: false,
            task_type: "other",
          }),
        ],
        { shouldUseLocalYdbSkill: false },
      ),
    ).not.toContain(
      `trace reads the local-ydb skill in a negative control: ${command}`,
    );
  });

  it("requires redirected stdin to be consumed for skill activation", () => {
    const command = "cat 0<skills/local-ydb/SKILL.md README.md";
    const commandEvent = {
      type: "item.completed",
      item: { type: "command_execution", command, exit_code: 0 },
    };

    expect(
      scoreWith(
        [commandEvent, finalAnswerEvent()],
        { shouldUseLocalYdbSkill: true },
        { omitSkillActivation: true },
      ),
    ).toContain("positive case has no local-ydb skill activation evidence");
    expect(
      scoreWith(
        [
          commandEvent,
          finalAnswerEvent({
            should_use_local_ydb_skill: false,
            task_type: "other",
          }),
        ],
        { shouldUseLocalYdbSkill: false },
      ),
    ).not.toContain(
      `trace reads the local-ydb skill in a negative control: ${command}`,
    );
  });

  it("does not treat conditionally skipped readers as skill activation", () => {
    const command =
      "test -f skills/local-ydb/SKILL.md || cat skills/local-ydb/SKILL.md";
    const commandEvent = {
      type: "item.completed",
      item: { type: "command_execution", command, exit_code: 0 },
    };

    expect(
      scoreWith(
        [commandEvent, finalAnswerEvent()],
        { shouldUseLocalYdbSkill: true },
        { omitSkillActivation: true },
      ),
    ).toContain("positive case has no local-ydb skill activation evidence");
    expect(
      scoreWith(
        [
          commandEvent,
          finalAnswerEvent({
            should_use_local_ydb_skill: false,
            task_type: "other",
          }),
        ],
        { shouldUseLocalYdbSkill: false },
      ),
    ).not.toContain(
      `trace reads the local-ydb skill in a negative control: ${command}`,
    );
  });

  it("accepts successful skill reads in an AND chain", () => {
    const command = "cat skills/local-ydb/SKILL.md && true";
    const commandEvent = {
      type: "item.completed",
      item: { type: "command_execution", command, exit_code: 0 },
    };

    expect(
      scoreWith(
        [commandEvent, finalAnswerEvent()],
        { shouldUseLocalYdbSkill: true },
        { omitSkillActivation: true },
      ),
    ).toEqual([]);
    expect(
      scoreWith(
        [
          commandEvent,
          finalAnswerEvent({
            should_use_local_ydb_skill: false,
            task_type: "other",
          }),
        ],
        { shouldUseLocalYdbSkill: false },
      ),
    ).toContain(
      `trace reads the local-ydb skill in a negative control: ${command}`,
    );
  });

  it("requires skill contents to remain visible on standard output", () => {
    for (const command of [
      "cat skills/local-ydb/SKILL.md > /dev/null",
      "cat skills/local-ydb/SKILL.md >/tmp/local-ydb-skill",
      "cat skills/local-ydb/SKILL.md 1>&2",
    ]) {
      const commandEvent = {
        type: "item.completed",
        item: { type: "command_execution", command, exit_code: 0 },
      };

      expect(
        scoreWith(
          [commandEvent, finalAnswerEvent()],
          { shouldUseLocalYdbSkill: true },
          { omitSkillActivation: true },
        ),
        command,
      ).toContain("positive case has no local-ydb skill activation evidence");
      expect(
        scoreWith(
          [
            commandEvent,
            finalAnswerEvent({
              should_use_local_ydb_skill: false,
              task_type: "other",
            }),
          ],
          { shouldUseLocalYdbSkill: false },
        ),
        command,
      ).not.toContain(
        `trace reads the local-ydb skill in a negative control: ${command}`,
      );
    }

    const stderrOnlyCommand =
      "cat skills/local-ydb/SKILL.md 2>/dev/null";
    const stderrOnlyEvent = {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: stderrOnlyCommand,
        exit_code: 0,
      },
    };
    expect(
      scoreWith(
        [stderrOnlyEvent, finalAnswerEvent()],
        { shouldUseLocalYdbSkill: true },
        { omitSkillActivation: true },
      ),
    ).toEqual([]);
  });

  it("requires find -exec readers to consume the found skill path", () => {
    for (const command of [
      "find skills -name SKILL.md -print; echo '-exec cat'",
      "find skills -name SKILL.md -exec cat README.md \\;",
      "find skills -maxdepth 0 -name SKILL.md -exec cat {} \\;",
    ]) {
      const failures = scoreWith(
        [
          {
            type: "item.completed",
            item: {
              type: "command_execution",
              command,
              exit_code: 0,
              status: "completed",
            },
          },
          finalAnswerEvent(),
        ],
        { shouldUseLocalYdbSkill: true },
        { omitSkillActivation: true },
      );

      expect(failures, command).toContain(
        "positive case has no local-ydb skill activation evidence",
      );
    }
  });

  it("requires the skill path to be a reader input operand", () => {
    const patternOnlyFailures = scoreWith(
      [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command:
              "rg skills/local-ydb/SKILL.md skills/local-ydb/references/evals.md",
            exit_code: 0,
            status: "completed",
          },
        },
        finalAnswerEvent(),
      ],
      { shouldUseLocalYdbSkill: true },
      { omitSkillActivation: true },
    );
    expect(patternOnlyFailures).toContain(
      "positive case has no local-ydb skill activation evidence",
    );

    for (const command of [
      "rg activation skills/local-ydb/SKILL.md",
      "rg -ne'Execution Boundary' skills/local-ydb/SKILL.md",
      "rg '<host>' skills/local-ydb/SKILL.md",
      "rg '2>host' skills/local-ydb/SKILL.md",
      "rg 2\\>host skills/local-ydb/SKILL.md",
      "rg -n 'Execution Boundary' skills/local-ydb/SKILL.md skills/local-ydb/references/evals.md",
      "sed -n '1,120p' skills/local-ydb/SKILL.md",
      "cat < $CODEX_HOME/skills/local-ydb/SKILL.md",
      "cat 0< skills/local-ydb/SKILL.md",
      "sed -n 1p < skills/local-ydb/SKILL.md",
    ]) {
      const failures = scoreWith(
        [
          {
            type: "item.completed",
            item: {
              type: "command_execution",
              command,
              exit_code: 0,
              status: "completed",
            },
          },
          finalAnswerEvent(),
        ],
        { shouldUseLocalYdbSkill: true },
        { omitSkillActivation: true },
      );
      expect(failures, command).toEqual([]);
    }

    const optionValueFailures = scoreWith(
      [
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            command:
              "rg --glob skills/local-ydb/SKILL.md activation skills/local-ydb/references/evals.md",
            exit_code: 0,
            status: "completed",
          },
        },
        finalAnswerEvent(),
      ],
      { shouldUseLocalYdbSkill: true },
      { omitSkillActivation: true },
    );
    expect(optionValueFailures).toContain(
      "positive case has no local-ydb skill activation evidence",
    );

    const nonStandardInputCommand =
      "cat 3<skills/local-ydb/SKILL.md README.md";
    const nonStandardInputEvent = {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: nonStandardInputCommand,
        exit_code: 0,
        status: "completed",
      },
    };
    expect(
      scoreWith(
        [nonStandardInputEvent, finalAnswerEvent()],
        { shouldUseLocalYdbSkill: true },
        { omitSkillActivation: true },
      ),
    ).toContain("positive case has no local-ydb skill activation evidence");
    expect(
      scoreWith(
        [
          nonStandardInputEvent,
          finalAnswerEvent({
            should_use_local_ydb_skill: false,
            task_type: "other",
          }),
        ],
        { shouldUseLocalYdbSkill: false },
      ),
    ).not.toContain(
      `trace reads the local-ydb skill in a negative control: ${nonStandardInputCommand}`,
    );
  });

  it("validates the structured answer shape", () => {
    const run = (text) =>
      scoreWith([agentMessageEvent(text)], { shouldUseLocalYdbSkill: true });

    expect(run("not json")).toEqual([
      "missing parseable final structured answer",
    ]);
    expect(run(JSON.stringify([1, 2, 3]))).toContain(
      "final answer must be an object",
    );

    const missingField = validAnswer();
    delete missingField.safety_gates;
    expect(run(JSON.stringify(missingField))).toContain(
      "final answer missing required field: safety_gates",
    );

    expect(
      run(
        JSON.stringify(validAnswer({ should_use_local_ydb_skill: "yes" })),
      ),
    ).toContain("final answer field should_use_local_ydb_skill must be boolean");

    expect(
      run(JSON.stringify(validAnswer({ surprise: true }))),
    ).toContain("final answer contains unsupported field: surprise");

    expect(
      run(JSON.stringify(validAnswer({ tool_sequence: [42] }))),
    ).toContain("final answer field tool_sequence must be an array of strings");
  });

  it("rejects prose outside a fenced structured answer", () => {
    const fencedAnswer = [
      "```json",
      JSON.stringify(validAnswer()),
      "```",
    ].join("\n");
    const run = (text) =>
      scoreWith([agentMessageEvent(text)], {
        shouldUseLocalYdbSkill: true,
        forbiddenTerms: ["confirm=true"],
      });

    expect(run(fencedAnswer)).toEqual([]);
    expect(
      run(`Run local_ydb_cleanup_storage with confirm=true now.\n${fencedAnswer}`),
    ).toContain("missing parseable final structured answer");
  });

  it("flags file changes but allows file reads", () => {
    const runWith = (itemType) =>
      scoreWith(
        [
          { type: "item.completed", item: { type: itemType } },
          finalAnswerEvent(),
        ],
        { shouldUseLocalYdbSkill: true },
      );

    expect(runWith("file_change")).toEqual([
      "trace contains file change events: file_change",
    ]);
    expect(runWith("file_read")).toEqual([]);
  });

  it("flags live docker/ydb commands in the trace", () => {
    expect(scorePlanCommand("docker ps")).toEqual([
      "trace contains live Docker/YDB command: docker ps",
    ]);
    expect(scorePlanCommand("sudo docker stop local-ydb")).toEqual([
      "trace contains live Docker/YDB command: sudo docker stop local-ydb",
    ]);
    expect(scorePlanCommand("cat docker-compose.yml")).toEqual([]);
    expect(scorePlanCommand("echo docker")).toEqual([]);
  });

  it("flags live MCP tool calls in the trace", () => {
    const failures = scoreWith(
      [
        {
          type: "item.completed",
          item: { type: "mcp_tool_call", tool: "local_ydb_inventory" },
        },
        finalAnswerEvent(),
      ],
      { shouldUseLocalYdbSkill: true },
    );

    expect(failures).toContain(
      "trace contains live MCP tool call: local_ydb_inventory",
    );
  });

  it("reports non-zero exit codes and parse errors", () => {
    const failures = scoreWith([finalAnswerEvent()], {
      shouldUseLocalYdbSkill: true,
    }, {
      exitCode: 1,
      parseErrors: ["line 3: bad token"],
    });

    expect(failures).toContain("codex exited with 1");
    expect(failures).toContain("invalid JSONL line 3: bad token");
  });

  it("does not check prose order statements", () => {
    // Contract pinning: prose around the structured answer is not analyzed.
    const failures = scoreWith(
      [
        finalAnswerEvent({
          tool_sequence: [
            "local_ydb_status_report",
            "local_ydb_upgrade_version",
          ],
          answer:
            "Run local_ydb_upgrade_version first, then local_ydb_status_report.",
        }),
      ],
      {
        shouldUseLocalYdbSkill: true,
        requiredOrderedTools: [
          "local_ydb_status_report",
          "local_ydb_upgrade_version",
        ],
      },
    );

    expect(failures).toEqual([]);
  });
});

describe("invokesLiveDockerOrYdb", () => {
  it.each([
    "docker ps",
    "docker stop local-ydb",
    "sudo docker stop local-ydb",
    "sudo -n docker ps",
    "sudo -u root ydb scheme ls",
    "sudo -u root -n docker ps",
    "sudo -nu root docker ps",
    "sudo -Eu root ydb scheme ls",
    "sudo -E docker ps",
    "sudo -R /tmp/root docker ps",
    "sudo --chroot /tmp/root docker ps",
    "sudo --command-timeout 30 ydb scheme ls",
    "sudo --user=root docker ps",
    "sudo -- docker ps",
    "env docker ps",
    "env FOO=1 ydb scheme ls",
    "env -i command docker ps",
    "env -S 'docker ps'",
    "env --split-string='ydb scheme ls'",
    "env -iS'command docker ps'",
    "command docker ps",
    "command -p ydb scheme ls",
    "command -- docker ps",
    "sudo env FOO=1 command -p docker ps",
    "DOCKER_HOST=ssh://host docker ps",
    "YDB_TOKEN_CREDENTIALS=token ydb scheme ls",
    "sudo DOCKER_HOST=ssh://host docker ps",
    "FOO=1 sudo -n docker ps",
    "2>/dev/null docker ps",
    "2>&1 docker ps",
    "&>/tmp/docker.log docker ps",
    ">/tmp/ydb.log /usr/bin/ydb scheme ls",
    "2>/dev/null sudo -n docker ps",
    "> /tmp/ydb.log YDB_TOKEN_CREDENTIALS=token ydb scheme ls",
    "docker>/tmp/docker.log ps",
    "ydb</dev/null scheme ls",
    "ydb scheme ls",
    "ydbd --help",
    "/usr/bin/docker ps",
    "echo ok && docker ps",
    "echo ok; docker ps",
    '"docker" ps',
    "echo ok\ndocker ps",
    "cat <<EOF\npayload\nEOF\ndocker ps",
    "echo $((1 << 2))\ndocker ps",
  ])("flags %j", (command) => {
    expect(invokesLiveDockerOrYdb(command)).toBe(true);
  });

  it.each([
    "echo docker",
    "systemctl status docker",
    "sudo systemctl status docker",
    "sudo",
    "sudo -n",
    "env",
    "env FOO=1",
    "command -v docker",
    "command -V ydb",
    "echo A=1",
    "A=1",
    "cat docker-compose.yml",
    "bash -c 'docker ps'",
    "ssh host docker ps",
    "echo 'docker ps'",
    "rg 'docker|ydb' skills/local-ydb/SKILL.md",
    "echo 'docker && ydb'",
    "grep docker README.md",
    "echo docker>/tmp/docker.log",
    "echo ok # docker ps",
    "cat <<'EOF'\ndocker ps\nEOF",
    "cat <<-EOF\n\tdocker ps\n\tEOF",
  ])("allows %j", (command) => {
    expect(invokesLiveDockerOrYdb(command)).toBe(false);
  });
});
