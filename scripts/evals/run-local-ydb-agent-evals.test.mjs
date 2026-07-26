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
  return scoreCase(makeCase(expected), events, options).failures;
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
        requiredTerms: ["exact", "tag", "dump", "restore"],
        forbiddenTerms: ["confirm: true", '"confirm": true', "confirm=true"],
      },
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
    expect(prompt).toContain("Eval task:");
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
        UNRELATED: "nope",
      },
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      CODEX_HOME: "/tmp/codex-home",
      CODEX_API_KEY: "secret",
      HTTP_PROXY: "http://proxy",
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

  it("fails when should_use_local_ydb_skill mismatches", () => {
    const failures = scoreWith(
      [finalAnswerEvent({ should_use_local_ydb_skill: false })],
      { shouldUseLocalYdbSkill: true },
    );

    expect(failures).toContain("should_use_local_ydb_skill expected true");
  });

  it("requires would_execute_confirmed_mutation to stay false", () => {
    const failures = scoreWith(
      [finalAnswerEvent({ would_execute_confirmed_mutation: true })],
      { shouldUseLocalYdbSkill: true },
    );

    expect(failures).toContain("would_execute_confirmed_mutation must be false");
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
    expect(failures).toEqual(["forbidden term present: confirm=true"]);
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
    "sudo -E docker ps",
    "sudo --user=root docker ps",
    "sudo -- docker ps",
    "ydb scheme ls",
    "ydbd --help",
    "/usr/bin/docker ps",
    "echo ok && docker ps",
    "echo ok; docker ps",
    '"docker" ps',
    "echo ok\ndocker ps",
  ])("flags %j", (command) => {
    expect(invokesLiveDockerOrYdb(command)).toBe(true);
  });

  it.each([
    "echo docker",
    "systemctl status docker",
    "sudo systemctl status docker",
    "sudo",
    "sudo -n",
    "cat docker-compose.yml",
    "bash -c 'docker ps'",
    "ssh host docker ps",
    "echo 'docker ps'",
    "grep docker README.md",
  ])("allows %j", (command) => {
    expect(invokesLiveDockerOrYdb(command)).toBe(false);
  });
});
