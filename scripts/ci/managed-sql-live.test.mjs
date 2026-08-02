import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLiveToolRegistry,
  verifyManagedSqlLive,
} from "./managed-sql-live.mjs";

test("requires exactly 39 tools and the conservative mixed SQL annotations", () => {
  const tools = Array.from({ length: 38 }, (_, index) => ({
    name: `local_ydb_fixture_${index}`,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }));
  tools.push({
    name: "local_ydb_sql",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  });

  assert.doesNotThrow(() => assertLiveToolRegistry({ tools }));
  assert.throws(
    () => assertLiveToolRegistry({ tools: tools.slice(0, -1) }),
    /exactly 39 tools/,
  );
  assert.throws(
    () => assertLiveToolRegistry({
      tools: tools.map((tool) => (
        tool.name === "local_ydb_sql"
          ? { ...tool, annotations: { ...tool.annotations, readOnlyHint: true } }
          : tool
      )),
    }),
    /local_ydb_sql annotations/,
  );
});

test("runs the bounded managed SQL safety sequence and cleans up its table", async () => {
  const fixture = managedSqlFixture();
  const tableName = "managed_sql_fixture";

  await verifyManagedSqlLive({
    callTool: fixture.callTool,
    profile: "ci-action",
    tableName,
  });

  assert.equal(fixture.state.tableExists, false);
  assert.equal(fixture.state.confirmedUpserts, 1);
  assert.equal(
    fixture.calls.filter(({ name, args }) => (
      name === "local_ydb_sql"
      && args.action === "execute"
      && args.confirm === true
      && args.script.includes("UPSERT INTO")
    )).length,
    1,
  );
  assert.equal(
    fixture.calls.some(({ name, args }) => (
      name === "local_ydb_sql"
      && args.action === "query"
      && args.confirm === true
      && args.script.includes("UPSERT INTO")
    )),
    true,
  );
  assert.equal(
    fixture.calls.some(({ name, args }) => (
      name === "local_ydb_sql"
      && args.action === "query"
      && args.maxRows === 2
      && args.maxOutputBytes === 65_536
    )),
    true,
  );
  assert.equal(
    fixture.calls.some(({ name, args }) => (
      name === "local_ydb_sql"
      && args.action === "query"
      && args.maxOutputBytes === 256
    )),
    true,
  );
  assert.equal(
    fixture.calls.some(({ args }) => args.script?.startsWith(`CREATE TABLE \`${tableName}\``)),
    true,
  );
  assert.equal(
    fixture.calls.some(({ args }) => (
      args.action === "explain"
      && args.script?.startsWith(`CREATE TABLE \`${tableName}_ctas_explain\``)
    )),
    true,
  );
  assert.match(fixture.calls.at(-1).args.script, /^DROP TABLE /);
  assert.equal(fixture.calls.at(-1).args.script, `DROP TABLE \`${tableName}\`;`);
});

test("accepts successful ordinary DDL explain without a plan or AST", async () => {
  const fixture = managedSqlFixture({ omitDdlExplainPayload: true });

  await verifyManagedSqlLive({
    callTool: fixture.callTool,
    profile: "ci-action",
    tableName: "managed_sql_empty_ddl_explain_fixture",
  });
});

test("attempts schema cleanup when a managed SQL assertion fails after setup", async () => {
  const fixture = managedSqlFixture({ failStandaloneExplain: true });

  await assert.rejects(
    verifyManagedSqlLive({
      callTool: fixture.callTool,
      profile: "ci-action",
      tableName: "managed_sql_failure_fixture",
    }),
    /standalone explain fixture failed/,
  );

  assert.equal(fixture.state.tableExists, false);
  assert.match(fixture.calls.at(-1).args.script, /^DROP TABLE /);
});

test("does not drop a pre-existing table when its CREATE fails", async () => {
  const calls = [];
  let tableExists = true;
  const tableName = "managed_sql_preexisting_fixture";
  const callTool = async (name, args) => {
    calls.push({ name, args });
    assert.equal(name, "local_ydb_apply_schema");
    if (args.script.startsWith("CREATE TABLE ")) {
      return schemaApplyResponse({
        executed: false,
        validationOk: false,
        includeExecution: false,
      });
    }
    if (args.script.startsWith("DROP TABLE ")) {
      tableExists = false;
      return schemaApplyResponse();
    }
    throw new Error(`Unexpected schema fixture script: ${args.script}`);
  };

  await assert.rejects(
    verifyManagedSqlLive({
      callTool,
      profile: "ci-action",
      tableName,
    }),
    /managed SQL setup did not complete successfully/,
  );

  assert.equal(tableExists, true, "the helper dropped a table it did not create");
  assert.equal(
    calls.some(({ args }) => args.script.startsWith("DROP TABLE ")),
    false,
    "cleanup must not run until CREATE establishes ownership",
  );
});

test("generates a different safe table name for each live-helper run", async () => {
  const createScripts = [];
  const callTool = async (name, args) => {
    assert.equal(name, "local_ydb_apply_schema");
    if (args.script.startsWith("CREATE TABLE ")) {
      createScripts.push(args.script);
      return schemaApplyResponse({
        executed: false,
        validationOk: false,
        includeExecution: false,
      });
    }
    return schemaApplyResponse();
  };

  for (let run = 0; run < 2; run += 1) {
    await assert.rejects(
      verifyManagedSqlLive({
        callTool,
        profile: "ci-action",
      }),
      /managed SQL setup did not complete successfully/,
    );
  }

  const names = createScripts.map((script) => {
    const match = /^CREATE TABLE `([A-Za-z_][A-Za-z0-9_]*)`/.exec(script);
    assert(match, `unsafe generated table identifier: ${script}`);
    return match[1];
  });
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
});

test("rejects an unsafe injected table name before calling MCP", async () => {
  let calls = 0;

  await assert.rejects(
    verifyManagedSqlLive({
      callTool: async () => {
        calls += 1;
        return schemaApplyResponse();
      },
      profile: "ci-action",
      tableName: "managed_sql`; DROP TABLE users; --",
    }),
    /tableName/,
  );

  assert.equal(calls, 0);
});

function managedSqlFixture({
  failStandaloneExplain = false,
  omitDdlExplainPayload = false,
} = {}) {
  const calls = [];
  const state = {
    tableExists: false,
    rowCount: 0,
    confirmedUpserts: 0,
  };

  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "local_ydb_apply_schema") {
      if (args.script.startsWith("CREATE TABLE ")) {
        state.tableExists = true;
      } else if (args.script.startsWith("DROP TABLE ")) {
        state.tableExists = false;
        state.rowCount = 0;
      } else {
        throw new Error(`Unexpected schema fixture script: ${args.script}`);
      }
      return schemaApplyResponse();
    }

    assert.equal(name, "local_ydb_sql");
    if (args.script === "SELECT $value AS value;") {
      assert.deepEqual(args.parameters, {
        value: {
          type: { kind: "primitive", name: "Int32" },
          value: 42,
        },
      });
      return sqlResponse({
        action: "query",
        parameterTypes: { value: "Int32" },
        resultSets: [resultSet([{ name: "value", type: "Int32" }], [[42]])],
      });
    }
    if (args.action === "query" && args.script.includes("UPSERT INTO")) {
      assert.equal(args.confirm, true);
      return sqlResponse({
        action: "query",
        outcome: "failed",
        execution: executionResult({ completion: "failed", status: 400010 }),
      });
    }
    if (args.script.includes("COUNT(*)")) {
      return sqlResponse({
        action: "query",
        resultSets: [resultSet([{ name: "count", type: "Uint64" }], [[String(state.rowCount)]])],
      });
    }
    if (args.action === "explain" && args.script.startsWith("SELECT id")) {
      if (failStandaloneExplain) {
        throw new Error("standalone explain fixture failed");
      }
      return sqlResponse({
        action: "explain",
        execution: executionResult({ queryPlan: "{\"plan\":\"select\"}" }),
      });
    }
    if (args.action === "execute" && args.script.includes("UPSERT INTO")) {
      if (args.confirm !== true) {
        return sqlResponse({
          action: "execute",
          outcome: "planned",
          executed: false,
          confirmationRequired: true,
          preflight: executionResult({ queryPlan: "{\"plan\":\"upsert\"}" }),
          execution: null,
        });
      }
      state.confirmedUpserts += 1;
      state.rowCount = 1;
      return sqlResponse({
        action: "execute",
        confirmationConsumed: true,
        preflight: executionResult({ queryPlan: "{\"plan\":\"upsert\"}" }),
        execution: executionResult(),
      });
    }
    if (args.action === "execute" && args.script === "THIS IS NOT VALID YQL;") {
      return sqlResponse({
        action: "execute",
        outcome: "failed",
        executed: false,
        confirmationRequired: false,
        preflight: executionResult({ completion: "failed", status: 400010 }),
        execution: null,
      });
    }
    if (args.action === "explain" && args.script.startsWith("ALTER TABLE ")) {
      return sqlResponse({
        action: "explain",
        execution: executionResult(omitDdlExplainPayload
          ? {}
          : { queryPlan: "{\"plan\":\"ddl\"}" }),
      });
    }
    if (args.action === "explain" && args.script.startsWith("CREATE TABLE ")) {
      return sqlResponse({
        action: "explain",
        execution: executionResult({ queryAst: "(CtasPlan)" }),
      });
    }
    if (args.action === "query" && args.script.includes("AS_TABLE($items)")) {
      return sqlResponse({
        action: "query",
        outcome: "partial",
        resultSets: [{
          ...resultSet([{ name: "value", type: "Int32" }], [[0], [1]]),
          truncationReasons: ["rowLimit"],
        }],
        execution: executionResult({
          completion: "partial",
          resultSets: [{
            ...resultSet([{ name: "value", type: "Int32" }], [[0], [1]]),
            truncationReasons: ["rowLimit"],
          }],
          capturedBytes: 78,
          truncationReasons: ["rowLimit"],
        }),
        outputBytes: 78,
        truncated: true,
        truncationReasons: ["rowLimit"],
      });
    }
    if (args.action === "query" && args.script.includes("$large AS first")) {
      return sqlResponse({
        action: "query",
        outcome: "partial",
        resultSets: [],
        execution: executionResult({
          completion: "partial",
          capturedBytes: 256,
          truncationReasons: ["byteLimit"],
        }),
        outputBytes: 256,
        truncated: true,
        truncationReasons: ["byteLimit"],
      });
    }
    throw new Error(`Unexpected managed SQL fixture call: ${JSON.stringify({ name, args })}`);
  };

  return { callTool, calls, state };
}

function schemaApplyResponse({
  executed = true,
  validationOk = true,
  includeExecution = true,
} = {}) {
  return {
    summary: "Schema DDL apply succeeded.",
    action: "apply",
    databasePath: "/local/test",
    executed,
    risk: "high",
    plannedCommands: ["Apply schema DDL"],
    rollback: ["Drop the created table."],
    verification: ["Describe the table."],
    scriptSha256: "a".repeat(64),
    statements: { count: 1, kinds: ["CREATE TABLE"] },
    validation: {
      ok: validationOk,
      status: validationOk ? "SUCCESS" : "GENERIC_ERROR",
      issues: validationOk ? "" : "table already exists",
      issuesBytes: validationOk ? 0 : 20,
      issuesTruncated: false,
    },
    ...(includeExecution
      ? { execution: { ok: true, status: "SUCCESS", issues: "", issuesBytes: 0, issuesTruncated: false } }
      : {}),
    maxOutputBytes: 65_536,
  };
}

function sqlResponse({
  action,
  parameterTypes = {},
  outcome = "succeeded",
  executed = true,
  confirmationRequired = false,
  confirmationConsumed = false,
  preflight,
  execution = executionResult(),
  resultSets = execution?.resultSets ?? [],
  outputBytes = execution?.capturedBytes ?? 0,
  truncated = false,
  truncationReasons = [],
}) {
  return {
    summary: `Managed YQL ${action}.`,
    action,
    databasePath: "/local/test",
    scriptSha256: "b".repeat(64),
    parameterTypes,
    risk: action === "execute" ? "high" : "low",
    executed,
    outcome,
    confirmationRequired,
    confirmationConsumed,
    ...(preflight ? { preflight } : {}),
    ...(execution ? { execution } : {}),
    resultSets,
    limits: { timeoutMs: 120_000, maxRows: 100, maxOutputBytes: 65_536 },
    outputBytes,
    truncated,
    truncationReasons,
    plannedCommands: ["Run managed YQL."],
    rollback: action === "execute" ? ["Use compensating YQL."] : [],
    verification: ["Inspect result sets."],
  };
}

function executionResult({
  completion = "success",
  resultSets = [],
  capturedBytes = 0,
  truncationReasons = [],
  status = 400000,
  queryPlan,
  queryAst,
} = {}) {
  return {
    completion,
    resultSets,
    capturedBytes,
    truncationReasons,
    status,
    ...(queryPlan ? { queryPlan } : {}),
    ...(queryAst ? { queryAst } : {}),
  };
}

function resultSet(columns, rows) {
  return {
    index: 0,
    columns,
    rows,
    truncationReasons: [],
  };
}
