import { describe, expect, it } from "vitest";
import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import {
  ExecMode,
  SchemaInclusionMode,
  Syntax,
} from "@ydbjs/api/query";
import { ResultSet_Format } from "@ydbjs/api/value";
import { prepareSqlParameters } from "../src/sql-parameters.js";
import { createContext } from "../src/operations/context.js";
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

    expect(calls).toEqual([{
      connectionString: "grpc://127.0.0.1:2137/local/example",
      databasePath: "/local/example",
      endpoint: "grpc://127.0.0.1:2137",
      timeoutMs: 1_500,
      rootUser: undefined,
      rootPassword: undefined,
      script: "SELECT 1;",
      parameters: {},
      mode: "explain",
      maxRows: 10,
      maxOutputBytes: 4_096,
      signal,
    }]);
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

function requestCapturingDriver(requests: Array<Record<string, unknown>>) {
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
      yield { status: SUCCESS, issues: [], resultSetIndex: 0n };
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
