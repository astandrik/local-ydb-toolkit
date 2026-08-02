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

  await verifyManagedSqlLive({
    callTool: fixture.callTool,
    profile: "ci-action",
    tenantPath: "/local/test",
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
  assert.match(fixture.calls.at(-1).args.script, /^DROP TABLE /);
});

test("attempts schema cleanup when a managed SQL assertion fails after setup", async () => {
  const fixture = managedSqlFixture({ failStandaloneExplain: true });

  await assert.rejects(
    verifyManagedSqlLive({
      callTool: fixture.callTool,
      profile: "ci-action",
      tenantPath: "/local/test",
    }),
    /standalone explain fixture failed/,
  );

  assert.equal(fixture.state.tableExists, false);
  assert.match(fixture.calls.at(-1).args.script, /^DROP TABLE /);
});

function managedSqlFixture({ failStandaloneExplain = false } = {}) {
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
        execution: executionResult({ queryPlan: "{\"plan\":\"ddl\"}" }),
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

function schemaApplyResponse() {
  return {
    summary: "Schema DDL apply succeeded.",
    action: "apply",
    databasePath: "/local/test",
    executed: true,
    risk: "high",
    plannedCommands: ["Apply schema DDL"],
    rollback: ["Drop the created table."],
    verification: ["Describe the table."],
    scriptSha256: "a".repeat(64),
    statements: { count: 1, kinds: ["CREATE TABLE"] },
    validation: { ok: true, status: "SUCCESS", issues: "", issuesBytes: 0, issuesTruncated: false },
    execution: { ok: true, status: "SUCCESS", issues: "", issuesBytes: 0, issuesTruncated: false },
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
