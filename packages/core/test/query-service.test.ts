import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import {
  ExecMode,
  SchemaInclusionMode,
  StatsMode,
  Syntax,
} from "@ydbjs/api/query";
import { ResultSet_Format } from "@ydbjs/api/value";
import { prepareSqlParameters } from "../src/sql-parameters.js";
import { createContext } from "../src/operations/context.js";
import { ShellCommandExecutor } from "../src/api-client.js";
import { ConfigSchema } from "../src/validation.js";

const SUCCESS = StatusIds_StatusCode.SUCCESS;

describe("low-level Query Service adapter", () => {
  it("runs one node-bound session lifecycle and cleans up in order", async () => {
    // Production break caught: a query can be sent before the session is
    // attached to its owning node, or cleanup can omit the session/driver.
    const core = await import("../src/query-service.js").catch(() => ({})) as Record<string, unknown>;
    expect(typeof core.executeQueryServiceWithSdk).toBe("function");

    const events: string[] = [];
    const baseClient = {
      async createSession() {
        events.push("create");
        return { status: SUCCESS, issues: [], sessionId: "session-1", nodeId: 7n };
      },
    };
    const nodeClient = {
      attachSession(_request: unknown, options?: { signal?: AbortSignal }) {
        events.push("attach");
        return stableAttach(options?.signal);
      },
      async *executeQuery() {
        events.push("execute");
        yield { status: SUCCESS, issues: [], resultSetIndex: 0n };
      },
      async deleteSession() {
        events.push("delete");
        return { status: SUCCESS, issues: [] };
      },
    };
    const driver = {
      async ready() {
        events.push("ready");
      },
      createClient(_definition: unknown, nodeId?: bigint) {
        events.push(nodeId === undefined ? "base-client" : `node-client:${nodeId}`);
        return nodeId === undefined ? baseClient : nodeClient;
      },
      close() {
        events.push("close");
      },
    };

    const executeQueryServiceWithSdk = core.executeQueryServiceWithSdk as (
      request: Record<string, unknown>,
      dependencies: Record<string, unknown>,
    ) => Promise<{ completion: string }>;
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "SELECT 1;",
      parameters: {},
      mode: "explain",
      maxRows: 10,
      maxOutputBytes: 1_024,
    }, {
      createDriver: () => driver,
    });

    expect(result.completion).toBe("success");
    expect(events).toEqual([
      "ready",
      "base-client",
      "create",
      "node-client:7",
      "attach",
      "execute",
      "delete",
      "close",
    ]);
  });

  it("preserves a definitive query result when driver cleanup throws", async () => {
    // Production break caught: synchronous driver cleanup can replace a final
    // Query Service status with a generic adapter failure.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const driver = driverForParts([{
      status: SUCCESS,
      issues: [],
      resultSetIndex: 0n,
    }]);
    driver.close = () => {
      throw new Error("close boom");
    };

    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "SELECT 1;",
      parameters: {},
      mode: "snapshotReadOnly",
      maxRows: 10,
      maxOutputBytes: 1_024,
    }, {
      createDriver: () => driver as never,
    });

    expect(result).toMatchObject({
      completion: "success",
      status: SUCCESS,
    });
  });

  it("builds exact explain, SnapshotRO, and implicit NoTx requests", async () => {
    // Production break caught: read-only queries can accidentally run without
    // SnapshotRO, mutations can inherit a transaction, or PG/concurrent output
    // can be enabled by an SDK default.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const requests: Array<Record<string, unknown>> = [];

    for (const mode of ["explain", "snapshotReadOnly", "noTx"] as const) {
      const driver = requestCapturingDriver(requests);
      await executeQueryServiceWithSdk({
        connectionString: "grpc://127.0.0.1:2136/local",
        databasePath: "/local",
        endpoint: "grpc://127.0.0.1:2136",
        timeoutMs: 1_000,
        script: "SELECT $value;",
        parameters: { $value: { marker: mode } as never },
        mode,
        maxRows: 10,
        maxOutputBytes: 1_024,
      }, {
        createDriver: () => driver as never,
      });
    }

    const common = {
      sessionId: "session-1",
      query: {
        case: "queryContent",
        value: {
          syntax: Syntax.YQL_V1,
          text: "SELECT $value;",
        },
      },
      statsMode: 10,
      concurrentResultSets: false,
      responsePartLimitBytes: 0n,
      poolId: "",
      statsPeriodMs: 0n,
      schemaInclusionMode: SchemaInclusionMode.ALWAYS,
      resultSetFormat: ResultSet_Format.VALUE,
    };
    expect(requests).toEqual([
      {
        ...common,
        statsMode: StatsMode.FULL,
        execMode: ExecMode.EXPLAIN,
        parameters: { $value: { marker: "explain" } },
      },
      {
        ...common,
        execMode: ExecMode.EXECUTE,
        txControl: {
          txSelector: {
            case: "beginTx",
            value: {
              txMode: {
                case: "snapshotReadOnly",
                value: {},
              },
            },
          },
          commitTx: true,
        },
        parameters: { $value: { marker: "snapshotReadOnly" } },
      },
      {
        ...common,
        execMode: ExecMode.EXECUTE,
        parameters: { $value: { marker: "noTx" } },
      },
    ]);
  });

  it("captures complete EXPLAIN issues, plan, and AST inside the shared byte budget", async () => {
    // Production break caught: EXPLAIN silently discarded its only useful
    // payload, or plan metadata bypassed the output budget and was sliced.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const issue = {
      message: "optimizer warning <redacted>",
      issueCode: 42,
      severity: 2,
      issues: [],
    };
    const queryPlan = "{\"secret\":\"<redacted>\"}";
    const queryAst = "(literal <redacted>)";
    const parts = [{
      status: SUCCESS,
      issues: [{
        message: "optimizer warning do-not-leak",
        issueCode: issue.issueCode,
        severity: issue.severity,
        issues: [],
      }],
      execStats: {
        queryPlan: "{\"secret\":\"do-not-leak\"}",
        queryAst: "(literal do-not-leak)",
      },
      resultSetIndex: 0n,
    }];
    const requests: Array<Record<string, unknown>> = [];
    const full = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      rootPassword: "do-not-leak",
      script: "SELECT * FROM t;",
      parameters: {},
      mode: "explain",
      maxRows: 10,
      maxOutputBytes: 1_024,
    }, {
      createDriver: () => requestCapturingDriver(requests, parts) as never,
    });

    expect(requests[0]?.statsMode).toBe(StatsMode.FULL);
    expect(full.issues).toEqual([issue]);
    expect(full.queryPlan).toBe(queryPlan);
    expect(full.queryAst).toBe(queryAst);
    expect(full.capturedBytes).toBe(133);
    expect(JSON.stringify(full)).not.toContain("do-not-leak");

    const bounded = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      rootPassword: "do-not-leak",
      script: "SELECT * FROM t;",
      parameters: {},
      mode: "explain",
      maxRows: 10,
      // The redacted issue fits (82 bytes); the 29-byte plan does not.
      maxOutputBytes: 100,
    }, {
      createDriver: () => driverForParts(parts) as never,
    });

    expect(bounded.completion).toBe("partial");
    expect(bounded.issues).toEqual([issue]);
    expect(bounded.queryPlan).toBeUndefined();
    expect(bounded.queryAst).toBeUndefined();
    expect(bounded.capturedBytes).toBe(82);
    expect(bounded.truncationReasons).toEqual(["byteLimit"]);
  });

  it("redacts the root password from result-set metadata and rows before retention", async () => {
    // Production break caught: the SDK adapter knows the authentication secret,
    // but result-set capture previously retained decoded values and names verbatim.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const rootPassword = "do-not-leak-result";
    const typedValue = prepareSqlParameters({
      secret: {
        type: { kind: "primitive", name: "Utf8" },
        value: rootPassword,
      },
    }).typedValues.$secret;

    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      rootPassword,
      script: "SELECT secret;",
      parameters: {},
      mode: "snapshotReadOnly",
      maxRows: 10,
      maxOutputBytes: 1_024,
    }, {
      createDriver: () => driverForParts([
        queryPart(0, [{ name: rootPassword, typedValue }]),
      ]) as never,
    });

    expect(result.resultSets).toEqual([{
      index: 0,
      columns: [{ name: "<redacted>", type: "Utf8" }],
      rows: [["<redacted>"]],
      truncationReasons: [],
    }]);
    expect(JSON.stringify(result)).not.toContain(rootPassword);
  });

  it("accounts repeated plan and AST parts while retaining only the latest values", async () => {
    // Compatibility evidence: Task 3 charges every received metadata value but
    // overwrites the public plan/AST fields, so captured bytes can legitimately
    // exceed the JSON bytes visible in the final retained payload.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "EXPLAIN SELECT 1;",
      parameters: {},
      mode: "explain",
      maxRows: 10,
      maxOutputBytes: 12,
    }, {
      createDriver: () => driverForParts([
        {
          status: SUCCESS,
          issues: [],
          execStats: { queryPlan: "a", queryAst: "x" },
        },
        {
          status: SUCCESS,
          issues: [],
          execStats: { queryPlan: "b", queryAst: "y" },
        },
      ]) as never,
    });

    expect(result).toMatchObject({
      completion: "success",
      queryPlan: "b",
      queryAst: "y",
      capturedBytes: 12,
      truncationReasons: [],
      status: SUCCESS,
    });
  });

  it("omits a complete top-level issue before traversing an over-deep tree", async () => {
    // Production break caught: recursive issue copying could overflow the JS
    // stack before maxOutputBytes was checked.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    let accessedMessages = 0;
    const deepIssue = buildDeepIssueTree(10_000, () => {
      accessedMessages += 1;
    });
    const keptIssue = {
      message: "kept",
      issueCode: 1,
      severity: 2,
      issues: [],
    };
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "EXPLAIN SELECT 1;",
      parameters: {},
      mode: "explain",
      maxRows: 10,
      maxOutputBytes: 1_000_000,
    }, {
      createDriver: () => driverForParts([{
        status: SUCCESS,
        issues: [keptIssue, deepIssue],
        resultSetIndex: 0n,
      }]) as never,
    });

    expect(result.completion).toBe("partial");
    expect(result.issues).toEqual([keptIssue]);
    expect(result.capturedBytes).toBe(57);
    expect(result.capturedBytes).toBeLessThanOrEqual(1_000_000);
    expect(result.truncationReasons).toEqual(["byteLimit"]);
    expect(accessedMessages).toBeLessThanOrEqual(32);
  });

  it("omits a complete top-level issue before copying an over-wide tree", async () => {
    // Production break caught: a server-controlled sibling array was fully
    // materialized and redacted before any output bound was applied.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    let accessedMessages = 0;
    const wideIssue = buildWideIssueTree(10_000, () => {
      accessedMessages += 1;
    });
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "EXPLAIN SELECT 1;",
      parameters: {},
      mode: "explain",
      maxRows: 10,
      maxOutputBytes: 1_000_000,
    }, {
      createDriver: () => driverForParts([{
        status: SUCCESS,
        issues: [wideIssue],
        resultSetIndex: 0n,
      }]) as never,
    });

    expect(result.completion).toBe("partial");
    expect(result.issues).toBeUndefined();
    expect(result.capturedBytes).toBe(0);
    expect(result.capturedBytes).toBeLessThanOrEqual(1_000_000);
    expect(result.truncationReasons).toEqual(["byteLimit"]);
    expect(accessedMessages).toBeLessThanOrEqual(1_000);
  });

  it("accounts for a complete nested issue including sibling separators", async () => {
    // Production break caught: incremental accounting can undercount commas
    // and retain JSON whose actual encoding exceeds maxOutputBytes.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const nestedIssue = {
      message: "root",
      issueCode: 1,
      severity: 2,
      issues: [
        { message: "a", issueCode: 2, severity: 2, issues: [] },
        { message: "b", issueCode: 3, severity: 2, issues: [] },
      ],
    };
    const execute = (maxOutputBytes: number) => executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "EXPLAIN SELECT 1;",
      parameters: {},
      mode: "explain",
      maxRows: 10,
      maxOutputBytes,
    }, {
      createDriver: () => driverForParts([{
        status: SUCCESS,
        issues: [nestedIssue],
        resultSetIndex: 0n,
      }]) as never,
    });

    const exact = await execute(166);
    const oneByteShort = await execute(165);

    expect(exact.issues).toEqual([nestedIssue]);
    expect(exact.capturedBytes).toBe(166);
    expect(oneByteShort.issues).toBeUndefined();
    expect(oneByteShort.capturedBytes).toBe(0);
    expect(oneByteShort.truncationReasons).toEqual(["byteLimit"]);
  });

  it("incrementally decodes ordered columns and rows across result-set parts", async () => {
    // Production break caught: continuation parts can lose their first-part
    // schema, merge rows into the wrong result set, or expose bigint values.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const prepared = prepareSqlParameters({
      id1: { type: { kind: "primitive", name: "Uint64" }, value: "1" },
      id2: { type: { kind: "primitive", name: "Uint64" }, value: "2" },
      name: { type: { kind: "primitive", name: "Utf8" }, value: "alice" },
    });
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "SELECT 1;",
      parameters: {},
      mode: "snapshotReadOnly",
      maxRows: 10,
      maxOutputBytes: 4_096,
    }, {
      createDriver: () => driverForParts([
        queryPart(0, [{
          name: "id",
          typedValue: prepared.typedValues.$id1,
        }]),
        queryPart(0, [{
          typedValue: prepared.typedValues.$id2,
        }]),
        queryPart(1, [{
          name: "name",
          typedValue: prepared.typedValues.$name,
        }]),
      ]) as never,
    });

    expect(result.completion).toBe("success");
    expect(result.resultSets).toEqual([
      {
        index: 0,
        columns: [{ name: "id", type: "Uint64" }],
        rows: [["1"], ["2"]],
        truncationReasons: [],
      },
      {
        index: 1,
        columns: [{ name: "name", type: "Utf8" }],
        rows: [["alice"]],
        truncationReasons: [],
      },
    ]);
  });

  it("decodes Variant and Tagged result columns without failing the query", async () => {
    // Production break caught: valid YQL Variant/Tagged columns used to turn a
    // successful read into a failed adapter call after dispatch.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const prepared = prepareSqlParameters({
      number: { type: { kind: "primitive", name: "Int32" }, value: 42 },
      text: { type: { kind: "primitive", name: "Utf8" }, value: "alice" },
    });
    const numberType = prepared.typedValues.$number.type!;
    const textType = prepared.typedValues.$text.type!;
    const tupleVariantType = {
      $typeName: "Ydb.Type",
      type: {
        case: "variantType",
        value: {
          $typeName: "Ydb.VariantType",
          type: {
            case: "tupleItems",
            value: {
              $typeName: "Ydb.TupleType",
              elements: [numberType, textType],
            },
          },
        },
      },
    };
    const structVariantType = {
      $typeName: "Ydb.Type",
      type: {
        case: "variantType",
        value: {
          $typeName: "Ydb.VariantType",
          type: {
            case: "structItems",
            value: {
              $typeName: "Ydb.StructType",
              members: [
                { $typeName: "Ydb.StructMember", name: "number", type: numberType },
                { $typeName: "Ydb.StructMember", name: "text", type: textType },
              ],
            },
          },
        },
      },
    };
    const taggedType = {
      $typeName: "Ydb.Type",
      type: {
        case: "taggedType",
        value: {
          $typeName: "Ydb.TaggedType",
          tag: "label",
          type: textType,
        },
      },
    };
    const optionalVariantType = {
      $typeName: "Ydb.Type",
      type: {
        case: "optionalType",
        value: {
          $typeName: "Ydb.OptionalType",
          item: tupleVariantType,
        },
      },
    };
    const variantValue = (index: number, value: unknown) => ({
      $typeName: "Ydb.Value",
      value: { case: "nestedValue", value },
      items: [],
      pairs: [],
      variantIndex: index,
      high128: 0n,
    });

    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "SELECT Variant(...), Tagged(...);",
      parameters: {},
      mode: "snapshotReadOnly",
      maxRows: 10,
      maxOutputBytes: 4_096,
    }, {
      createDriver: () => driverForParts([
        {
          status: SUCCESS,
          issues: [],
          resultSetIndex: 0n,
          resultSet: {
            columns: [
              { name: "tuple_variant", type: tupleVariantType },
              { name: "struct_variant", type: structVariantType },
              { name: "tagged", type: taggedType },
              { name: "optional_variant", type: optionalVariantType },
            ],
            rows: [{
              items: [
                variantValue(1, prepared.typedValues.$text.value),
                variantValue(0, prepared.typedValues.$number.value),
                prepared.typedValues.$text.value,
                // Optional unwraps one transport layer before Variant's
                // mandatory nested value, matching the upstream SDK parser.
                variantValue(
                  0,
                  variantValue(0, prepared.typedValues.$number.value),
                ),
              ],
              pairs: [],
              value: { case: undefined },
              variantIndex: 0,
              high128: 0n,
            }],
            truncated: false,
            format: ResultSet_Format.VALUE,
            data: new Uint8Array(),
          },
        },
      ]) as never,
    });

    expect(result.diagnostics).toBeUndefined();
    expect(result.completion).toBe("success");
    expect(result.resultSets).toEqual([{
      index: 0,
      columns: [
        { name: "tuple_variant", type: "Variant<Tuple<Int32, Utf8>>" },
        {
          name: "struct_variant",
          type: "Variant<Struct<`number`:Int32, `text`:Utf8>>",
        },
        { name: "tagged", type: "Tagged<Utf8, 'label'>" },
        {
          name: "optional_variant",
          type: "Optional<Variant<Tuple<Int32, Utf8>>>",
        },
      ],
      rows: [[
        { index: 1, value: "alice" },
        { index: 0, name: "number", value: 42 },
        "alice",
        { index: 0, value: 42 },
      ]],
      truncationReasons: [],
    }]);
  });

  it("cancels read-only streaming after a per-result-set row limit", async () => {
    // Production break caught: a bounded read can continue consuming unbounded
    // rows, or return a row beyond maxRows without marking the partial result.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const prepared = prepareSqlParameters({
      one: { type: { kind: "primitive", name: "Int32" }, value: 1 },
      two: { type: { kind: "primitive", name: "Int32" }, value: 2 },
      three: { type: { kind: "primitive", name: "Int32" }, value: 3 },
    });
    let yieldedParts = 0;
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "SELECT value FROM series;",
      parameters: {},
      mode: "snapshotReadOnly",
      maxRows: 1,
      maxOutputBytes: 4_096,
    }, {
      createDriver: () => driverForParts([
        queryPart(0, [{ name: "value", typedValue: prepared.typedValues.$one }]),
        queryPart(0, [{ typedValue: prepared.typedValues.$two }]),
        queryPart(0, [{ typedValue: prepared.typedValues.$three }]),
      ], () => {
        yieldedParts += 1;
      }) as never,
    });

    expect(result.completion).toBe("partial");
    expect(result.resultSets[0]?.rows).toEqual([[1]]);
    expect(result.resultSets[0]?.truncationReasons).toEqual(["rowLimit"]);
    expect(result.truncationReasons).toEqual(["rowLimit"]);
    expect(yieldedParts).toBe(2);
  });

  it("keeps only complete JSON values within one total byte budget", async () => {
    // Production break caught: captured output can exceed maxOutputBytes or
    // splice a JSON row when the remaining budget is smaller than that row.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const prepared = prepareSqlParameters({
      first: { type: { kind: "primitive", name: "Utf8" }, value: "abc" },
      second: {
        type: { kind: "primitive", name: "Utf8" },
        value: "this row does not fit",
      },
      third: { type: { kind: "primitive", name: "Utf8" }, value: "unread" },
    });
    let yieldedParts = 0;
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "SELECT text FROM values;",
      parameters: {},
      mode: "snapshotReadOnly",
      maxRows: 10,
      // Column metadata is 31 bytes and ["abc"] is 7 bytes.
      maxOutputBytes: 38,
    }, {
      createDriver: () => driverForParts([
        queryPart(0, [{ name: "text", typedValue: prepared.typedValues.$first }]),
        queryPart(0, [{ typedValue: prepared.typedValues.$second }]),
        queryPart(0, [{ typedValue: prepared.typedValues.$third }]),
      ], () => {
        yieldedParts += 1;
      }) as never,
    });

    expect(result.completion).toBe("partial");
    expect(result.capturedBytes).toBe(38);
    expect(result.resultSets[0]?.rows).toEqual([["abc"]]);
    expect(result.resultSets[0]?.truncationReasons).toEqual(["byteLimit"]);
    expect(result.truncationReasons).toEqual(["byteLimit"]);
    expect(yieldedParts).toBe(2);
  });

  it("stops mutation capture at the byte limit but drains to final status", async () => {
    // Production break caught: cancelling a sent mutation on output overflow
    // loses its final status, while capturing after overflow violates the bound.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const prepared = prepareSqlParameters({
      first: { type: { kind: "primitive", name: "Utf8" }, value: "abc" },
      overflow: {
        type: { kind: "primitive", name: "Utf8" },
        value: "this row does not fit",
      },
    });
    let yieldedParts = 0;
    let executeCalls = 0;
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "UPSERT INTO t(id) VALUES (1);",
      parameters: {},
      mode: "noTx",
      maxRows: 10,
      maxOutputBytes: 38,
    }, {
      createDriver: () => driverForParts([
        queryPart(0, [{ name: "text", typedValue: prepared.typedValues.$first }]),
        queryPart(0, [{ typedValue: prepared.typedValues.$overflow }]),
        {
          status: StatusIds_StatusCode.BAD_REQUEST,
          issues: [],
          resultSetIndex: 0n,
        },
      ], () => {
        yieldedParts += 1;
      }, () => {
        executeCalls += 1;
      }) as never,
    });

    expect(result.completion).toBe("failed");
    expect(result.status).toBe(StatusIds_StatusCode.BAD_REQUEST);
    expect(result.capturedBytes).toBe(38);
    expect(result.resultSets[0]?.rows).toEqual([["abc"]]);
    expect(result.resultSets[0]?.truncationReasons).toEqual(["byteLimit"]);
    expect(yieldedParts).toBe(3);
    expect(executeCalls).toBe(1);
  });

  it("stops all mutation capture at the row limit but drains final status", async () => {
    // Production break caught: a NoTx row cap stopped only one result set, so
    // later server-controlled result-set indexes could keep growing output.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const prepared = prepareSqlParameters({
      one: { type: { kind: "primitive", name: "Int32" }, value: 1 },
      two: { type: { kind: "primitive", name: "Int32" }, value: 2 },
      later: { type: { kind: "primitive", name: "Int32" }, value: 99 },
    });
    let yieldedParts = 0;
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "UPSERT INTO t(id) VALUES (1);",
      parameters: {},
      mode: "noTx",
      maxRows: 1,
      maxOutputBytes: 4_096,
    }, {
      createDriver: () => driverForParts([
        queryPart(0, [{ name: "value", typedValue: prepared.typedValues.$one }]),
        queryPart(0, [{ typedValue: prepared.typedValues.$two }]),
        queryPart(1, [{ name: "later", typedValue: prepared.typedValues.$later }]),
        {
          status: StatusIds_StatusCode.BAD_REQUEST,
          issues: [],
          resultSetIndex: 1n,
        },
      ], () => {
        yieldedParts += 1;
      }) as never,
    });

    expect(result.completion).toBe("failed");
    expect(result.status).toBe(StatusIds_StatusCode.BAD_REQUEST);
    expect(result.resultSets).toEqual([{
      index: 0,
      columns: [{ name: "value", type: "Int32" }],
      rows: [[1]],
      truncationReasons: ["rowLimit"],
    }]);
    expect(result.truncationReasons).toEqual(["rowLimit"]);
    expect(yieldedParts).toBe(4);
  });

  it("keeps a post-limit mutation transport failure status unknown", async () => {
    // Production break caught: once a NoTx capture limit was reached, a later
    // stream failure was suppressed and the indeterminate mutation looked partial.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const prepared = prepareSqlParameters({
      one: { type: { kind: "primitive", name: "Int32" }, value: 1 },
      two: { type: { kind: "primitive", name: "Int32" }, value: 2 },
    });
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "UPSERT INTO t(id) VALUES (1) RETURNING id;",
      parameters: {},
      mode: "noTx",
      maxRows: 1,
      maxOutputBytes: 4_096,
    }, {
      createDriver: () => transportLossDriver(
        queryPart(0, [
          { name: "value", typedValue: prepared.typedValues.$one },
          { typedValue: prepared.typedValues.$two },
        ]),
        () => undefined,
      ) as never,
    });

    expect(result).toMatchObject({
      completion: "mutationStatusUnknown",
      diagnostics: "Mutation was sent but its final Query Service status was not received.",
      truncationReasons: ["rowLimit"],
    });
    expect(result.status).toBeUndefined();
    expect(result.resultSets[0]?.rows).toEqual([[1]]);
  });

  it("links caller and total-deadline cancellation but gives cleanup a fresh signal", async () => {
    // Production break caught: cancellation can be ignored by the query stream,
    // or the already-aborted operation signal can prevent session cleanup.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const prepared = prepareSqlParameters({
      value: { type: { kind: "primitive", name: "Int32" }, value: 1 },
    });

    for (const cancellation of ["caller", "deadline"] as const) {
      const caller = new AbortController();
      const cleanupSignals: AbortSignal[] = [];
      const result = await executeQueryServiceWithSdk({
        connectionString: "grpc://127.0.0.1:2136/local",
        databasePath: "/local",
        endpoint: "grpc://127.0.0.1:2136",
        timeoutMs: cancellation === "deadline" ? 10 : 1_000,
        script: "SELECT 1;",
        parameters: {},
        mode: "snapshotReadOnly",
        maxRows: 10,
        maxOutputBytes: 4_096,
        signal: caller.signal,
      }, {
        createDriver: () => cancellationDriver(
          queryPart(0, [{
            name: "value",
            typedValue: prepared.typedValues.$value,
          }]),
          cancellation === "caller" ? () => caller.abort() : undefined,
          cleanupSignals,
        ) as never,
      });

      expect(result.completion).toBe("cancelled");
      expect(result.resultSets[0]?.rows).toEqual([[1]]);
      expect(result.diagnostics).toBe("Query Service request was cancelled.");
      expect(cleanupSignals).toHaveLength(1);
      expect(cleanupSignals[0]?.aborted).toBe(false);
    }
  });

  it("reports cancellation before send but unknown status after a NoTx mutation is sent", async () => {
    // Production break caught: caller/deadline loss after sending NoTx was
    // labelled cancelled, which could invite an unsafe automatic retry.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const beforeSend = new AbortController();
    const before = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "UPSERT INTO t(id) VALUES (1);",
      parameters: {},
      mode: "noTx",
      maxRows: 10,
      maxOutputBytes: 1_024,
      signal: beforeSend.signal,
    }, {
      createDriver: () => cancellationBeforeSendDriver(() => beforeSend.abort()) as never,
    });

    const afterSend = new AbortController();
    const afterCaller = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "UPSERT INTO t(id) VALUES (2);",
      parameters: {},
      mode: "noTx",
      maxRows: 10,
      maxOutputBytes: 1_024,
      signal: afterSend.signal,
    }, {
      createDriver: () => driverForParts([], undefined, () => afterSend.abort()) as never,
    });

    const afterDeadline = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 10,
      script: "UPSERT INTO t(id) VALUES (3);",
      parameters: {},
      mode: "noTx",
      maxRows: 10,
      maxOutputBytes: 1_024,
    }, {
      createDriver: () => cancellationAfterSendDriver() as never,
    });

    expect(before.completion).toBe("cancelled");
    expect(afterCaller.completion).toBe("mutationStatusUnknown");
    expect(afterDeadline.completion).toBe("mutationStatusUnknown");
    expect(afterCaller.diagnostics).toBe(
      "Mutation was sent but its final Query Service status was not received.",
    );
    expect(afterDeadline.diagnostics).toBe(
      "Mutation was sent but its final Query Service status was not received.",
    );
  });

  it("does not send NoTx when cancellation arrives during initial session attach", async () => {
    // Production break caught: attach can finish after the caller aborts, and
    // an already-aborted streaming signal must not be handed to executeQuery.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const caller = new AbortController();
    let executeInvocations = 0;
    const baseClient = {
      async createSession() {
        return { status: SUCCESS, issues: [], sessionId: "session-1", nodeId: 7n };
      },
    };
    const nodeClient = {
      async *attachSession() {
        caller.abort();
        yield { status: SUCCESS, issues: [] };
      },
      executeQuery() {
        executeInvocations += 1;
        return (async function* emptyQueryStream() {})();
      },
      async deleteSession() {
        return { status: SUCCESS, issues: [] };
      },
    };

    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "UPSERT INTO t(id) VALUES (1);",
      parameters: {},
      mode: "noTx",
      maxRows: 10,
      maxOutputBytes: 1_024,
      signal: caller.signal,
    }, {
      createDriver: () => ({
        async ready() {},
        createClient(_definition: unknown, nodeId?: bigint) {
          return nodeId === undefined ? baseClient : nodeClient;
        },
        close() {},
      }) as never,
    });

    expect(caller.signal.aborted).toBe(true);
    expect(executeInvocations).toBe(0);
    expect(result).toMatchObject({
      completion: "cancelled",
      diagnostics: "Query Service request was cancelled.",
    });
  });

  it("distinguishes read transport failure from a sent mutation with lost final status", async () => {
    // Production break caught: a transport loss after sending a mutation can
    // be reported as an ordinary failure and invite an unsafe automatic retry.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const prepared = prepareSqlParameters({
      value: { type: { kind: "primitive", name: "Int32" }, value: 1 },
    });
    let executeCalls = 0;

    const readResult = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "SELECT $secret;",
      parameters: { $secret: prepared.typedValues.$value },
      mode: "snapshotReadOnly",
      maxRows: 10,
      maxOutputBytes: 4_096,
    }, {
      createDriver: () => transportLossDriver(
        queryPart(0, [{
          name: "value",
          typedValue: prepared.typedValues.$value,
        }]),
        () => {
          executeCalls += 1;
        },
      ) as never,
    });
    const mutationResult = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "UPSERT INTO t(id) VALUES ($secret);",
      parameters: { $secret: prepared.typedValues.$value },
      mode: "noTx",
      maxRows: 10,
      maxOutputBytes: 4_096,
    }, {
      createDriver: () => transportLossDriver(
        queryPart(0, [{
          name: "value",
          typedValue: prepared.typedValues.$value,
        }]),
        () => {
          executeCalls += 1;
        },
      ) as never,
    });

    expect(readResult.completion).toBe("failed");
    expect(readResult.diagnostics).toBe(
      "Query Service stream ended without a final status.",
    );
    expect(mutationResult.completion).toBe("mutationStatusUnknown");
    expect(mutationResult.diagnostics).toBe(
      "Mutation was sent but its final Query Service status was not received.",
    );
    expect(executeCalls).toBe(2);
    expect(JSON.stringify([readResult, mutationResult])).not.toContain("$secret");
    expect(JSON.stringify([readResult, mutationResult])).not.toContain("credential");
  });

  it("keeps a sent mutation unknown when result decoding fails", async () => {
    // Characterization for review feedback: post-dispatch capture errors are
    // already contained by the stream boundary and must never invite a retry.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const unsupportedType = {
      $typeName: "Ydb.Type",
      type: {
        case: "taggedType",
        value: {
          $typeName: "Ydb.TaggedType",
          tag: "unsupported",
        },
      },
    };
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "UPSERT INTO t(id) VALUES (1) RETURNING id;",
      parameters: {},
      mode: "noTx",
      maxRows: 10,
      maxOutputBytes: 4_096,
    }, {
      createDriver: () => driverForParts([{
        status: SUCCESS,
        issues: [],
        resultSetIndex: 0n,
        resultSet: {
          columns: [{ name: "value", type: unsupportedType }],
          rows: [{
            items: [{}],
            pairs: [],
            value: { case: undefined },
            variantIndex: 0,
            high128: 0n,
          }],
          truncated: false,
          format: ResultSet_Format.VALUE,
          data: new Uint8Array(),
        },
      }]) as never,
    });

    expect(result).toMatchObject({
      completion: "mutationStatusUnknown",
      diagnostics: "Mutation was sent but its final Query Service status was not received.",
    });
    expect(result.status).toBeUndefined();
  });

  it("uses the background attach monitor to stop work when the session is lost", async () => {
    // Production break caught: only validating the first attach state leaves a
    // query running after the owning node reports that its session is gone.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    let executeFinished = false;
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "SELECT 1;",
      parameters: {},
      mode: "snapshotReadOnly",
      maxRows: 10,
      maxOutputBytes: 4_096,
    }, {
      createDriver: () => sessionLossDriver(() => {
        executeFinished = true;
      }) as never,
    });

    expect(result.completion).toBe("failed");
    expect(result.diagnostics).toBe(
      "Query Service attached session was lost before final query status.",
    );
    expect(executeFinished).toBe(true);
  });

  it("reuses the shared SDK connection normalization before opening Query Service", async () => {
    // Production break caught: SQL can bypass the shared root/tenant endpoint,
    // timeout, credential, SSH tunnel, and tunnel-cleanup lifecycle.
    const core = await import("../src/query-service.js") as Record<string, unknown>;
    expect(typeof core.executeQueryService).toBe("function");
    const calls: Array<Record<string, unknown>> = [];
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));
    const signal = new AbortController().signal;

    const executeQueryService = core.executeQueryService as (
      context: unknown,
      request: Record<string, unknown>,
      executor: (request: Record<string, unknown>) => Promise<unknown>,
    ) => Promise<unknown>;
    await executeQueryService(ctx, {
      databasePath: "/local/example",
      timeoutMs: 1_500,
      script: "SELECT 1;",
      parameters: {},
      mode: "explain",
      maxRows: 10,
      maxOutputBytes: 4_096,
      signal,
    }, async (request) => {
      calls.push(request);
      return {
        completion: "success",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
        status: SUCCESS,
      };
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      connectionString: "grpc://127.0.0.1:2137/local/example",
      databasePath: "/local/example",
      endpoint: "grpc://127.0.0.1:2137",
      rootUser: undefined,
      rootPassword: undefined,
      script: "SELECT 1;",
      parameters: {},
      mode: "explain",
      maxRows: 10,
      maxOutputBytes: 4_096,
    });
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(1_500);
    const deadline = calls[0]?.deadline as { signal: AbortSignal };
    expect(calls[0]?.signal).toBe(deadline.signal);
  });

  it("starts the total deadline before remote credential setup", async () => {
    // Production break caught: password and SSH setup previously happened
    // before the Query Service timeout started, extending the total operation.
    let passwordCommandTimeoutMs: number | undefined;
    let queryCalls = 0;
    const ctx = createContext(undefined, {
      display: () => "redacted",
      async run(_profile, spec) {
        passwordCommandTimeoutMs = spec.timeoutMs;
        await delay(20);
        return {
          command: "redacted",
          exitCode: 0,
          stdout: "test-password\n",
          stderr: "",
          ok: true,
          timedOut: false,
        };
      },
    }, ConfigSchema.parse({
      profiles: {
        default: {
          mode: "ssh",
          ssh: { host: "test.invalid" },
          rootPasswordFile: "/test/root.password",
        },
      },
    }));

    const { executeQueryService } = await import("../src/query-service.js");
    const result = await executeQueryService(ctx, {
      timeoutMs: 5,
      script: "SELECT 1;",
      parameters: {},
      mode: "snapshotReadOnly",
      maxRows: 10,
      maxOutputBytes: 1_024,
    }, async () => {
      queryCalls += 1;
      throw new Error("query executor must not run after the deadline");
    });

    expect(result.completion).toBe("cancelled");
    expect(result.diagnostics).toBe("Query Service request was cancelled.");
    expect(passwordCommandTimeoutMs).toBeGreaterThan(0);
    expect(passwordCommandTimeoutMs).toBeLessThanOrEqual(5);
    expect(queryCalls).toBe(0);
  });

  it("aborts an in-flight remote password command before SQL is sent", async () => {
    // Production break caught: caller cancellation only changed the eventual
    // classification while the real SSH child kept running until timeout.
    const tempDir = mkdtempSync(join(tmpdir(), "local-ydb-command-abort-"));
    const sshPath = join(tempDir, "ssh");
    const pidFile = join(tempDir, "ssh.pid");
    const originalPath = process.env.PATH;
    const originalPidFile = process.env.LOCAL_YDB_TEST_SSH_PID_FILE;
    writeFileSync(sshPath, [
      "#!/bin/sh",
      "echo $$ > \"$LOCAL_YDB_TEST_SSH_PID_FILE\"",
      "trap 'exit 0' TERM INT",
      "while :; do :; done",
      "",
    ].join("\n"), "utf8");
    chmodSync(sshPath, 0o755);
    process.env.PATH = `${tempDir}:${originalPath ?? ""}`;
    process.env.LOCAL_YDB_TEST_SSH_PID_FILE = pidFile;

    try {
      const ctx = createContext(undefined, new ShellCommandExecutor(), ConfigSchema.parse({
        profiles: {
          default: {
            mode: "ssh",
            ssh: { host: "test.invalid" },
            rootPasswordFile: "/test/root.password",
          },
        },
      }));
      const caller = new AbortController();
      let queryCalls = 0;
      const { executeQueryService } = await import("../src/query-service.js");
      const operation = executeQueryService(ctx, {
        timeoutMs: 1_000,
        script: "SELECT 1;",
        parameters: {},
        mode: "snapshotReadOnly",
        maxRows: 10,
        maxOutputBytes: 1_024,
        signal: caller.signal,
      }, async () => {
        queryCalls += 1;
        throw new Error("query executor must not run");
      });

      await waitForFile(pidFile);
      const childPid = Number(readFileSync(pidFile, "utf8").trim());
      const abortedAt = Date.now();
      caller.abort();
      const result = await operation;

      expect(Date.now() - abortedAt).toBeLessThan(250);
      expect(result.completion).toBe("cancelled");
      expect(result.diagnostics).toBe("Query Service request was cancelled.");
      expect(queryCalls).toBe(0);
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPidFile === undefined) {
        delete process.env.LOCAL_YDB_TEST_SSH_PID_FILE;
      } else {
        process.env.LOCAL_YDB_TEST_SSH_PID_FILE = originalPidFile;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("sanitizes session-setup failures and still closes the driver", async () => {
    // Production break caught: SDK setup exceptions can leak credential paths
    // through diagnostics or bypass driver cleanup before any request is sent.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    let closed = false;
    let executeCalls = 0;
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      rootUser: "root",
      rootPassword: "test-only-value",
      script: "SELECT 1;",
      parameters: {},
      mode: "explain",
      maxRows: 10,
      maxOutputBytes: 4_096,
    }, {
      createDriver: () => ({
        async ready() {},
        createClient() {
          return {
            async createSession() {
              throw new Error("configured credential path test-only-value");
            },
            async *attachSession() {},
            async *executeQuery() {
              executeCalls += 1;
            },
            async deleteSession() {
              return { status: SUCCESS, issues: [] };
            },
          };
        },
        close() {
          closed = true;
        },
      }),
    });

    expect(result).toEqual({
      completion: "failed",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: [],
      diagnostics: "Query Service session setup failed.",
    });
    expect(executeCalls).toBe(0);
    expect(closed).toBe(true);
    expect(JSON.stringify(result)).not.toContain("credential path");
    expect(JSON.stringify(result)).not.toContain("test-only-value");
  });

  it("does not treat an empty clean stream as a known mutation success", async () => {
    // Production break caught: a stream that closes before any status can make
    // a sent mutation look successful even though its final outcome is unknown.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "UPSERT INTO t(id) VALUES (1);",
      parameters: {},
      mode: "noTx",
      maxRows: 10,
      maxOutputBytes: 4_096,
    }, {
      createDriver: () => driverForParts([]) as never,
    });

    expect(result.completion).toBe("mutationStatusUnknown");
    expect(result.status).toBeUndefined();
    expect(result.diagnostics).toBe(
      "Mutation was sent but its final Query Service status was not received.",
    );
  });

  it("does not retain unbounded empty result-set envelopes", async () => {
    // Production break caught: empty result-set parts can create an unbounded
    // per-index map without consuming any row or byte capture budget.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const emptyParts = Array.from({ length: 100 }, (_, index) => ({
      status: SUCCESS,
      issues: [],
      resultSetIndex: BigInt(index),
      resultSet: {
        columns: [],
        rows: [],
        truncated: false,
        format: ResultSet_Format.VALUE,
        data: new Uint8Array(),
      },
    }));
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "SELECT 1;",
      parameters: {},
      mode: "snapshotReadOnly",
      maxRows: 1,
      maxOutputBytes: 1,
    }, {
      createDriver: () => driverForParts(emptyParts) as never,
    });

    expect(result.completion).toBe("success");
    expect(result.resultSets).toEqual([]);
    expect(result.capturedBytes).toBe(0);
  });

  it("atomically charges truncated empty result-set envelopes", async () => {
    // Production break caught: truncated=true created one retained object per
    // server-controlled index while consuming zero output bytes.
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    let yieldedParts = 0;
    const truncatedParts = Array.from({ length: 100 }, (_, index) => ({
      status: SUCCESS,
      issues: [],
      resultSetIndex: BigInt(index),
      resultSet: {
        columns: [],
        rows: [],
        truncated: true,
        format: ResultSet_Format.VALUE,
        data: new Uint8Array(),
      },
    }));
    const result = await executeQueryServiceWithSdk({
      connectionString: "grpc://127.0.0.1:2136/local",
      databasePath: "/local",
      endpoint: "grpc://127.0.0.1:2136",
      timeoutMs: 1_000,
      script: "UPSERT INTO t(id) VALUES (1);",
      parameters: {},
      mode: "noTx",
      maxRows: 1,
      // Exact JSON size of the retained index-0 envelope with "server".
      maxOutputBytes: 65,
    }, {
      createDriver: () => driverForParts(truncatedParts, () => {
        yieldedParts += 1;
      }) as never,
    });

    expect(result.completion).toBe("partial");
    expect(result.resultSets).toEqual([{
      index: 0,
      columns: [],
      rows: [],
      truncationReasons: ["server"],
    }]);
    expect(result.capturedBytes).toBe(65);
    expect(result.truncationReasons).toEqual(["byteLimit", "server"]);
    expect(yieldedParts).toBe(100);
  });
});

async function* stableAttach(signal: AbortSignal | undefined) {
  yield { status: SUCCESS, issues: [] };
  if (signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function requestCapturingDriver(
  requests: Array<Record<string, unknown>>,
  parts: unknown[] = [{ status: SUCCESS, issues: [], resultSetIndex: 0n }],
) {
  const baseClient = {
    async createSession() {
      return { status: SUCCESS, issues: [], sessionId: "session-1", nodeId: 7n };
    },
  };
  const nodeClient = {
    attachSession(_request: unknown, options?: { signal?: AbortSignal }) {
      return stableAttach(options?.signal);
    },
    async *executeQuery(request: Record<string, unknown>) {
      requests.push(request);
      yield* parts;
    },
    async deleteSession() {
      return { status: SUCCESS, issues: [] };
    },
  };
  return {
    async ready() {},
    createClient(_definition: unknown, nodeId?: bigint) {
      return nodeId === undefined ? baseClient : nodeClient;
    },
    close() {},
  };
}

function driverForParts(
  parts: unknown[],
  onYield?: () => void,
  onExecute?: () => void,
) {
  const baseClient = {
    async createSession() {
      return { status: SUCCESS, issues: [], sessionId: "session-1", nodeId: 7n };
    },
  };
  const nodeClient = {
    attachSession(_request: unknown, options?: { signal?: AbortSignal }) {
      return stableAttach(options?.signal);
    },
    async *executeQuery(_request: unknown, options?: { signal?: AbortSignal }) {
      onExecute?.();
      for (const part of parts) {
        if (options?.signal?.aborted) {
          return;
        }
        onYield?.();
        yield part;
      }
    },
    async deleteSession() {
      return { status: SUCCESS, issues: [] };
    },
  };
  return {
    async ready() {},
    createClient(_definition: unknown, nodeId?: bigint) {
      return nodeId === undefined ? baseClient : nodeClient;
    },
    close() {},
  };
}

function queryPart(
  index: number,
  rows: Array<{
    name?: string;
    typedValue: {
      type?: unknown;
      value?: unknown;
    };
  }>,
) {
  const namedRows = rows.filter((row) => row.name !== undefined);
  return {
    status: SUCCESS,
    issues: [],
    resultSetIndex: BigInt(index),
    resultSet: {
      columns: namedRows.map((row) => ({
        name: row.name,
        type: row.typedValue.type,
      })),
      rows: rows.map((row) => ({
        items: [row.typedValue.value],
        pairs: [],
        value: { case: undefined },
        variantIndex: 0,
        high128: 0n,
      })),
      truncated: false,
      format: ResultSet_Format.VALUE,
      data: new Uint8Array(),
    },
  };
}

function buildDeepIssueTree(
  depth: number,
  onMessageAccess: () => void,
): Record<string, unknown> {
  let issue: Record<string, unknown> = issueWithObservedMessage(
    "deep",
    [],
    onMessageAccess,
  );
  for (let index = 1; index < depth; index += 1) {
    issue = issueWithObservedMessage("deep", [issue], onMessageAccess);
  }
  return issue;
}

function buildWideIssueTree(
  width: number,
  onMessageAccess: () => void,
): Record<string, unknown> {
  return issueWithObservedMessage(
    "wide-root",
    Array.from({ length: width }, () =>
      issueWithObservedMessage("wide-child", [], onMessageAccess)),
    onMessageAccess,
  );
}

function issueWithObservedMessage(
  message: string,
  issues: Array<Record<string, unknown>>,
  onMessageAccess: () => void,
): Record<string, unknown> {
  return {
    get message() {
      onMessageAccess();
      return message;
    },
    issueCode: 1,
    severity: 2,
    issues,
  };
}

function cancellationDriver(
  part: unknown,
  cancelCaller: (() => void) | undefined,
  cleanupSignals: AbortSignal[],
) {
  const baseClient = {
    async createSession() {
      return { status: SUCCESS, issues: [], sessionId: "session-1", nodeId: 7n };
    },
  };
  const nodeClient = {
    attachSession(_request: unknown, options?: { signal?: AbortSignal }) {
      return stableAttach(options?.signal);
    },
    async *executeQuery(_request: unknown, options?: { signal?: AbortSignal }) {
      cancelCaller?.();
      yield part;
      if (!options?.signal?.aborted) {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
    async deleteSession(_request: unknown, options?: { signal?: AbortSignal }) {
      cleanupSignals.push(options!.signal!);
      return { status: SUCCESS, issues: [] };
    },
  };
  return {
    async ready() {},
    createClient(_definition: unknown, nodeId?: bigint) {
      return nodeId === undefined ? baseClient : nodeClient;
    },
    close() {},
  };
}

function cancellationBeforeSendDriver(cancel: () => void) {
  return {
    async ready() {
      cancel();
      throw new Error("cancelled before send");
    },
    createClient() {
      throw new Error("client must not be created");
    },
    close() {},
  };
}

function cancellationAfterSendDriver() {
  const baseClient = {
    async createSession() {
      return { status: SUCCESS, issues: [], sessionId: "session-1", nodeId: 7n };
    },
  };
  const nodeClient = {
    attachSession(_request: unknown, options?: { signal?: AbortSignal }) {
      return stableAttach(options?.signal);
    },
    async *executeQuery(_request: unknown, options?: { signal?: AbortSignal }) {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    async deleteSession() {
      return { status: SUCCESS, issues: [] };
    },
  };
  return {
    async ready() {},
    createClient(_definition: unknown, nodeId?: bigint) {
      return nodeId === undefined ? baseClient : nodeClient;
    },
    close() {},
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for test file: ${path}`);
    }
    await delay(5);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function transportLossDriver(part: unknown, onExecute: () => void) {
  const baseClient = {
    async createSession() {
      return { status: SUCCESS, issues: [], sessionId: "session-1", nodeId: 7n };
    },
  };
  const nodeClient = {
    attachSession(_request: unknown, options?: { signal?: AbortSignal }) {
      return stableAttach(options?.signal);
    },
    async *executeQuery() {
      onExecute();
      yield part;
      throw new Error("transport failure leaked credential");
    },
    async deleteSession() {
      return { status: SUCCESS, issues: [] };
    },
  };
  return {
    async ready() {},
    createClient(_definition: unknown, nodeId?: bigint) {
      return nodeId === undefined ? baseClient : nodeClient;
    },
    close() {},
  };
}

function sessionLossDriver(onExecuteFinished: () => void) {
  const baseClient = {
    async createSession() {
      return { status: SUCCESS, issues: [], sessionId: "session-1", nodeId: 7n };
    },
  };
  const nodeClient = {
    async *attachSession() {
      yield { status: SUCCESS, issues: [] };
      yield { status: StatusIds_StatusCode.BAD_SESSION, issues: [] };
    },
    async *executeQuery(_request: unknown, options?: { signal?: AbortSignal }) {
      if (!options?.signal?.aborted) {
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      onExecuteFinished();
    },
    async deleteSession() {
      return { status: SUCCESS, issues: [] };
    },
  };
  return {
    async ready() {},
    createClient(_definition: unknown, nodeId?: bigint) {
      return nodeId === undefined ? baseClient : nodeClient;
    },
    close() {},
  };
}
