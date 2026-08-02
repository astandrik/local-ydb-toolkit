const SQL_TOOL = "local_ydb_sql";
const SCHEMA_TOOL = "local_ydb_apply_schema";
const TABLE_NAME = "managed_sql_smoke";
const CTAS_TABLE_NAME = "managed_sql_ctas_explain";

export function assertLiveToolRegistry(result) {
  assert(Array.isArray(result?.tools), "tools/list did not return a tools array.");
  assert(result.tools.length === 39, `Expected exactly 39 tools, received ${result.tools.length}.`);

  const sqlTool = result.tools.find((tool) => tool.name === SQL_TOOL);
  assert(sqlTool, `Missing MCP tool ${SQL_TOOL}.`);
  const expectedAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  };
  const annotations = sqlTool.annotations ?? {};
  const annotationKeys = Object.keys(annotations).sort();
  const expectedKeys = Object.keys(expectedAnnotations).sort();
  assert(
    JSON.stringify(annotationKeys) === JSON.stringify(expectedKeys)
      && expectedKeys.every((key) => annotations[key] === expectedAnnotations[key]),
    `${SQL_TOOL} annotations must be ${JSON.stringify(expectedAnnotations)}.`,
  );
}

export async function verifyManagedSqlLive({ callTool, profile, tenantPath }) {
  assert(typeof callTool === "function", "verifyManagedSqlLive requires callTool.");
  assert(typeof profile === "string" && profile.length > 0, "verifyManagedSqlLive requires profile.");
  assert(
    typeof tenantPath === "string" && tenantPath.startsWith("/"),
    "verifyManagedSqlLive requires an absolute tenantPath.",
  );

  const createScript = [
    `CREATE TABLE \`${TABLE_NAME}\` (`,
    "  id Uint64 NOT NULL,",
    "  value Utf8,",
    "  PRIMARY KEY (id)",
    ");",
  ].join("\n");
  const dropScript = `DROP TABLE \`${TABLE_NAME}\`;`;
  const upsertScript = `UPSERT INTO \`${TABLE_NAME}\` (id, value) VALUES (1, "confirmed");`;
  const countScript = `SELECT COUNT(*) AS count FROM \`${TABLE_NAME}\`;`;
  const sql = (arguments_) => callTool(SQL_TOOL, { profile, ...arguments_ });
  const applySchema = (script) => callTool(SCHEMA_TOOL, {
    profile,
    action: "apply",
    script,
    confirm: true,
  });

  let createAttempted = false;
  let failure;
  let cleanupFailure;
  try {
    createAttempted = true;
    const setup = await applySchema(createScript);
    assertSchemaApplied(setup, "managed SQL setup");

    const parameterized = await sql({
      action: "query",
      script: "SELECT $value AS value;",
      parameters: {
        value: {
          type: { kind: "primitive", name: "Int32" },
          value: 42,
        },
      },
    });
    assertSucceeded(parameterized, "parameterized SELECT");
    assert(
      parameterized.parameterTypes?.value === "Int32",
      "parameterized SELECT did not return canonical Int32 parameter metadata.",
    );
    assertCell(parameterized, 42, "parameterized SELECT did not return 42");

    const rejectedWrite = await sql({
      action: "query",
      script: upsertScript,
      confirm: true,
    });
    assert(
      rejectedWrite.executed === true
        && rejectedWrite.outcome === "failed"
        && rejectedWrite.confirmationConsumed === false,
      "SnapshotRO query did not reject DML without consuming confirmation.",
    );
    assertCount(
      await sql({ action: "query", script: countScript }),
      "0",
      "SnapshotRO DML changed table state",
    );

    const standaloneExplain = await sql({
      action: "explain",
      script: `SELECT id, value FROM \`${TABLE_NAME}\`;`,
    });
    assertExplainSucceeded(standaloneExplain, "standalone SELECT explain");

    const planOnly = await sql({
      action: "execute",
      script: upsertScript,
    });
    assert(
      planOnly.executed === false
        && planOnly.outcome === "planned"
        && planOnly.confirmationRequired === true
        && planOnly.confirmationConsumed === false
        && planOnly.preflight?.completion === "success"
        && planOnly.execution === undefined,
      "unconfirmed execute did not stop after successful mandatory EXPLAIN.",
    );
    assertCount(
      await sql({ action: "query", script: countScript }),
      "0",
      "plan-only execute changed table state",
    );

    const confirmed = await sql({
      action: "execute",
      script: upsertScript,
      confirm: true,
    });
    assert(
      confirmed.executed === true
        && confirmed.outcome === "succeeded"
        && confirmed.confirmationRequired === false
        && confirmed.confirmationConsumed === true
        && confirmed.preflight?.completion === "success"
        && confirmed.execution?.completion === "success",
      "confirmed execute did not report one successful execution after preflight.",
    );
    assertCount(
      await sql({ action: "query", script: countScript }),
      "1",
      "confirmed UPSERT was not visible exactly once",
    );

    const invalidConfirmed = await sql({
      action: "execute",
      script: "THIS IS NOT VALID YQL;",
      confirm: true,
    });
    assert(
      invalidConfirmed.executed === false
        && invalidConfirmed.outcome === "failed"
        && invalidConfirmed.confirmationConsumed === false
        && invalidConfirmed.preflight?.completion !== "success"
        && invalidConfirmed.execution === undefined,
      "failed mandatory EXPLAIN did not block invalid confirmed execution.",
    );

    const ddlExplain = await sql({
      action: "explain",
      script: `ALTER TABLE \`${TABLE_NAME}\` ADD COLUMN note Utf8;`,
    });
    assertExplainSucceeded(ddlExplain, "ordinary DDL explain");

    const ctasExplain = await sql({
      action: "explain",
      script: [
        `CREATE TABLE \`${CTAS_TABLE_NAME}\` (`,
        "  PRIMARY KEY (id)",
        ")",
        `AS SELECT id, value FROM \`${TABLE_NAME}\`;`,
      ].join("\n"),
    });
    assertExplainSucceeded(ctasExplain, "CTAS explain");

    const rowBounded = await sql({
      action: "query",
      script: "SELECT value FROM AS_TABLE($items) ORDER BY value;",
      maxRows: 2,
      maxOutputBytes: 65_536,
      parameters: {
        items: {
          type: {
            kind: "list",
            item: {
              kind: "struct",
              fields: [{
                name: "value",
                type: { kind: "primitive", name: "Int32" },
              }],
            },
          },
          value: [{ value: 0 }, { value: 1 }, { value: 2 }, { value: 3 }],
        },
      },
    });
    assert(
      rowBounded.outcome === "partial"
        && rowBounded.truncated === true
        && rowBounded.truncationReasons?.includes("rowLimit")
        && rowBounded.resultSets?.[0]?.rows?.length === 2,
      "maxRows did not bound the captured result set at two complete rows.",
    );

    const byteBounded = await sql({
      action: "query",
      script: "SELECT $large AS first;\nSELECT $large AS second;",
      maxOutputBytes: 256,
      parameters: {
        large: {
          type: { kind: "primitive", name: "Utf8" },
          value: "x".repeat(4_096),
        },
      },
    });
    assert(
      byteBounded.outcome === "partial"
        && byteBounded.truncated === true
        && byteBounded.truncationReasons?.includes("byteLimit")
        && Number.isInteger(byteBounded.outputBytes)
        && byteBounded.outputBytes <= 256,
      "maxOutputBytes did not bound the shared captured payload.",
    );
  } catch (error) {
    failure = error;
  } finally {
    if (createAttempted) {
      try {
        const cleanup = await applySchema(dropScript);
        assertSchemaApplied(cleanup, "managed SQL cleanup");
      } catch (error) {
        cleanupFailure = error;
      }
    }
  }

  if (failure && cleanupFailure) {
    throw new AggregateError(
      [failure, cleanupFailure],
      `Managed SQL verification failed: ${errorMessage(failure)}; cleanup also failed: ${errorMessage(cleanupFailure)}`,
    );
  }
  if (failure) {
    throw failure;
  }
  if (cleanupFailure) {
    throw cleanupFailure;
  }
}

function assertSchemaApplied(response, label) {
  assert(
    response?.executed === true && response.execution?.ok === true,
    `${label} did not complete successfully.`,
  );
}

function assertSucceeded(response, label) {
  assert(
    response?.outcome === "succeeded" && response.execution?.completion === "success",
    `${label} did not succeed.`,
  );
}

function assertExplainSucceeded(response, label) {
  assertSucceeded(response, label);
  assert(
    nonEmptyString(response.execution?.queryPlan) || nonEmptyString(response.execution?.queryAst),
    `${label} did not return a plan or AST.`,
  );
}

function assertCount(response, expected, message) {
  assertSucceeded(response, message);
  assertCell(response, expected, message);
}

function assertCell(response, expected, message) {
  assert(response?.resultSets?.[0]?.rows?.[0]?.[0] === expected, message);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
