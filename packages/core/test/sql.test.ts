import { createHash } from "node:crypto";
import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import { describe, expect, it, vi } from "vitest";
import type {
  QueryServiceExecutionResult,
  QueryServiceRequest,
} from "../src/query-service.js";
import type { ToolkitContext } from "../src/operations/types.js";
import type { SqlResponse } from "../src/operations/sql.js";
import { ProcessConfirmationStore } from "../src/confirmation.js";
import { createContext } from "../src/operations/context.js";
import { ConfigSchema } from "../src/validation.js";

type SqlBackendExecutor = (
  ctx: ToolkitContext,
  request: QueryServiceRequest,
) => Promise<QueryServiceExecutionResult>;

type SqlFunction = (
  ctx: ToolkitContext,
  options: Record<string, unknown>,
  executor?: SqlBackendExecutor,
) => Promise<SqlResponse>;

async function loadSql(): Promise<SqlFunction> {
  const core = await import("../src/index.js") as Record<string, unknown>;
  expect(typeof core.sql).toBe("function");
  return core.sql as SqlFunction;
}

function successfulResult(
  overrides: Partial<QueryServiceExecutionResult> = {},
): QueryServiceExecutionResult {
  const completion = overrides.completion ?? "success";
  return {
    completion,
    resultSets: [],
    capturedBytes: 0,
    truncationReasons: [],
    ...(completion === "success" || completion === "partial"
      ? { status: StatusIds_StatusCode.SUCCESS }
      : {}),
    ...overrides,
  };
}

function testContext(): ToolkitContext {
  return createContext(undefined, undefined, ConfigSchema.parse({}));
}

function confirmationContext(): ToolkitContext {
  const context = testContext();
  return {
    ...context,
    confirmation: {
      store: new ProcessConfirmationStore(),
      toolName: "local_ydb_sql",
      configSource: { kind: "provided", config: context.config },
    },
  };
}

describe("managed SQL operation", () => {
  it("rejects invalid public options before calling the backend", async () => {
    // Production break caught: invalid actions, empty/oversized scripts, or
    // out-of-range resource limits can reach Query Service.
    const sql = await loadSql();
    const ctx = testContext();
    const backend: SqlBackendExecutor = async () => {
      throw new Error("backend must not be called");
    };
    const invalidOptions: Array<[Record<string, unknown>, RegExp]> = [
      [{ script: "", action: "query" }, /script must contain/],
      [{ script: " \n\t", action: "query" }, /script must contain/],
      [{ script: "SELECT \"\ud800\";", action: "query" }, /well-formed Unicode/],
      [{ script: "x".repeat(1_048_577), action: "query" }, /1048576/],
      [{ script: "SELECT 1;", action: "select" }, /action/],
      [{ script: "SELECT 1;", timeoutMs: 0 }, /timeoutMs/],
      [{ script: "SELECT 1;", timeoutMs: 600_001 }, /timeoutMs/],
      [{ script: "SELECT 1;", maxRows: 0 }, /maxRows/],
      [{ script: "SELECT 1;", maxRows: 10_001 }, /maxRows/],
      [{ script: "SELECT 1;", maxOutputBytes: 0 }, /maxOutputBytes/],
      [{ script: "SELECT 1;", maxOutputBytes: 1_048_577 }, /maxOutputBytes/],
    ];

    for (const [options, message] of invalidOptions) {
      await expect(sql(ctx, options, backend)).rejects.toThrow(message);
    }
  }, 10_000);

  it("defaults to one bounded SnapshotRO query and returns the full public envelope", async () => {
    // Production break caught: the default action can drift to an unsafe mode,
    // omit a public response field, or use limits other than the public defaults.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];
    const execution = successfulResult({
      resultSets: [{
        index: 0,
        columns: [{ name: "value", type: "Int32" }],
        rows: [[1]],
        truncationReasons: [],
      }],
      capturedBytes: 36,
    });
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      calls.push(request);
      return execution;
    };

    const response = await sql(ctx, { script: "SELECT 1;" }, backend);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      databasePath: "/local/example",
      script: "SELECT 1;",
      parameters: {},
      mode: "snapshotReadOnly",
      maxRows: 100,
      maxOutputBytes: 65_536,
    });
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(120_000);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(response).toMatchObject({
      action: "query",
      databasePath: "/local/example",
      scriptSha256: createHash("sha256").update("SELECT 1;").digest("hex"),
      parameterTypes: {},
      risk: "low",
      executed: true,
      outcome: "succeeded",
      confirmationRequired: false,
      confirmationConsumed: false,
      execution,
      resultSets: execution.resultSets,
      limits: {
        timeoutMs: 120_000,
        maxRows: 100,
        maxOutputBytes: 65_536,
      },
      outputBytes: 36,
      truncated: false,
      truncationReasons: [],
      plannedCommands: expect.any(Array),
      rollback: expect.any(Array),
      verification: expect.any(Array),
      summary: expect.any(String),
    });
    expect(JSON.stringify(response)).not.toContain("SELECT 1;");
  });

  it("never lets confirm upgrade query or explain beyond their fixed safe modes", async () => {
    // Production break caught: confirm=true can accidentally turn a query into
    // NoTx execution or make EXPLAIN consume the mutation confirmation.
    const sql = await loadSql();
    const ctx = testContext();

    for (const [action, expectedMode] of [
      ["query", "snapshotReadOnly"],
      ["explain", "explain"],
    ] as const) {
      const calls: QueryServiceRequest[] = [];
      const backend: SqlBackendExecutor = async (_ctx, request) => {
        calls.push(request);
        return successfulResult();
      };

      const response = await sql(ctx, {
        action,
        confirm: true,
        script: "SELECT 1;",
      }, backend);

      expect(calls.map((call) => call.mode)).toEqual([expectedMode]);
      expect(response).toMatchObject({
        action,
        risk: "low",
        executed: true,
        outcome: "succeeded",
        confirmationRequired: false,
        confirmationConsumed: false,
        execution: successfulResult(),
      });
      expect(response).not.toHaveProperty("preflight");
    }
  });

  it("submits DML-shaped query text only through SnapshotRO without lexical upgrading", async () => {
    // Production break caught: recognizing mutation keywords can bypass the
    // fixed query mode or turn confirm=true into NoTx authorization.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      calls.push(request);
      return successfulResult({ completion: "failed" });
    };

    const response = await sql(ctx, {
      action: "query",
      confirm: true,
      script: "UPSERT INTO items (id) VALUES (1);",
    }, backend);

    expect(calls.map((call) => call.mode)).toEqual(["snapshotReadOnly"]);
    expect(response).toMatchObject({
      executed: true,
      outcome: "failed",
      confirmationConsumed: false,
    });
  });

  it("preflights execute once and returns a plan without confirm=true", async () => {
    // Production break caught: an unconfirmed execute can skip EXPLAIN, send a
    // mutation, or report that confirmation was consumed.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];
    const preflight = successfulResult({
      queryPlan: "{\"Plan\":\"ok\"}",
      capturedBytes: 19,
    });
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      calls.push(request);
      return preflight;
    };

    const response = await sql(ctx, {
      action: "execute",
      script: "UPSERT INTO items (id) VALUES (1);",
    }, backend);

    expect(calls.map((call) => call.mode)).toEqual(["explain"]);
    expect(response).toMatchObject({
      action: "execute",
      risk: "high",
      executed: false,
      outcome: "planned",
      confirmationRequired: true,
      confirmationConsumed: false,
      preflight,
      resultSets: preflight.resultSets,
      outputBytes: 19,
    });
    expect(response).not.toHaveProperty("execution");
  });

  it("executes exactly one NoTx call after a successful confirmed preflight", async () => {
    // Production break caught: confirmed execute can omit preflight, run NoTx
    // more than once, or expose preflight rows instead of execution rows.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];
    const preflight = successfulResult({
      queryPlan: "12345",
      capturedBytes: 7,
    });
    const execution = successfulResult({
      resultSets: [{
        index: 0,
        columns: [{ name: "affected", type: "Uint64" }],
        rows: [["1"]],
        truncationReasons: [],
      }],
      capturedBytes: 42,
    });
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      calls.push(request);
      return request.mode === "explain" ? preflight : execution;
    };

    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "UPSERT INTO items (id) VALUES (1);",
    }, backend);

    expect(calls.map((call) => call.mode)).toEqual(["explain", "noTx"]);
    expect(response).toMatchObject({
      action: "execute",
      risk: "high",
      executed: true,
      outcome: "succeeded",
      confirmationRequired: false,
      confirmationConsumed: true,
      preflight,
      execution,
      resultSets: execution.resultSets,
      outputBytes: 49,
    });
    expect(response.outputBytes).toBe(
      preflight.capturedBytes + execution.capturedBytes,
    );
  });

  it("does not consume confirmation when Query Service fails before NoTx dispatch", async () => {
    // Production break caught: invoking the backend adapter is not proof that
    // executeQuery was dispatched, so setup failures must remain unexecuted.
    const sql = await loadSql();
    const ctx = testContext();
    const { executeQueryServiceWithSdk } = await import("../src/query-service.js");
    const calls: QueryServiceRequest[] = [];
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      calls.push(request);
      if (request.mode === "explain") {
        return successfulResult({
          queryPlan: "{\"Plan\":\"ok\"}",
          capturedBytes: 20,
        });
      }
      return executeQueryServiceWithSdk({
        connectionString: "grpc://127.0.0.1:2136/local",
        databasePath: request.databasePath ?? "/local",
        endpoint: "grpc://127.0.0.1:2136",
        timeoutMs: request.timeoutMs ?? 1_000,
        script: request.script,
        parameters: request.parameters,
        mode: request.mode,
        maxRows: request.maxRows,
        maxOutputBytes: request.maxOutputBytes,
        signal: request.signal,
      }, {
        createDriver: () => {
          throw new Error("driver construction failed before executeQuery");
        },
      });
    };

    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "UPSERT INTO items (id) VALUES (1);",
    }, backend);

    expect(calls.map((call) => call.mode)).toEqual(["explain", "noTx"]);
    expect(response).toMatchObject({
      executed: false,
      outcome: "failed",
      confirmationRequired: false,
      confirmationConsumed: false,
    });
    expect(response).not.toHaveProperty("execution");
    expect(JSON.stringify(response)).not.toContain("requestDispatched");
  });

  it("blocks confirmed execution for every non-successful preflight completion", async () => {
    // Production break caught: partial, cancelled, failed, or mutation-status
    // loss from EXPLAIN can be mistaken for permission to send NoTx.
    const sql = await loadSql();
    const ctx = testContext();

    for (const [completion, expectedOutcome] of [
      ["partial", "partial"],
      ["cancelled", "failed"],
      ["failed", "failed"],
      ["mutationStatusUnknown", "failed"],
    ] as const) {
      const calls: QueryServiceRequest[] = [];
      const preflight = successfulResult({
        completion,
        truncationReasons: completion === "partial" ? ["byteLimit"] : [],
      });
      const backend: SqlBackendExecutor = async (_ctx, request) => {
        calls.push(request);
        return preflight;
      };

      const response = await sql(ctx, {
        action: "execute",
        confirm: true,
        script: "DELETE FROM items;",
      }, backend);

      expect(calls.map((call) => call.mode)).toEqual(["explain"]);
      expect(response).toMatchObject({
        executed: false,
        outcome: expectedOutcome,
        confirmationRequired: false,
        confirmationConsumed: false,
        preflight,
      });
      expect(response).not.toHaveProperty("execution");
    }
  });

  it("retires a submitted token when the repeated execute preflight fails", async () => {
    const sql = await loadSql();
    const ctx = confirmationContext();
    let explainCalls = 0;
    let executionCalls = 0;
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      if (request.mode === "noTx") {
        executionCalls += 1;
        return successfulResult();
      }
      explainCalls += 1;
      return explainCalls === 2
        ? {
            completion: "failed",
            resultSets: [],
            capturedBytes: 0,
            truncationReasons: [],
          }
        : successfulResult();
    };
    const request = {
      action: "execute" as const,
      script: "DELETE FROM items WHERE id = 1;",
    };

    const planned = await sql(ctx, request, backend);
    const confirmedRequest = {
      ...request,
      confirm: true as const,
      confirmationToken: planned.confirmation?.token,
    };
    const blocked = await sql(ctx, confirmedRequest, backend);
    const replay = await sql(ctx, confirmedRequest, backend);

    expect(blocked).toMatchObject({
      executed: false,
      confirmation: { status: "not-required" },
    });
    expect(replay).toMatchObject({
      executed: false,
      confirmation: { status: "rejected", token: expect.any(String) },
    });
    expect(executionCalls).toBe(0);
  });

  it("blocks execution and hides error text when preflight throws", async () => {
    // Production break caught: a thrown EXPLAIN can escape as raw diagnostics
    // or fall through to a mutation attempt.
    const sql = await loadSql();
    const ctx = testContext();
    let calls = 0;
    const backend: SqlBackendExecutor = async () => {
      calls += 1;
      throw new Error("backend leaked /tmp/root.password and parameter-value");
    };

    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "DELETE FROM items;",
    }, backend);

    expect(calls).toBe(1);
    expect(response).toMatchObject({
      executed: false,
      outcome: "failed",
      confirmationConsumed: false,
      preflight: {
        completion: "failed",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
        diagnostics: expect.any(String),
      },
    });
    expect(response).not.toHaveProperty("execution");
    expect(JSON.stringify(response)).not.toContain("backend leaked");
    expect(JSON.stringify(response)).not.toContain("parameter-value");
  });

  it("shares one signal and passes only remaining deadline time to execution", async () => {
    // Production break caught: preflight and execution can receive independent
    // deadlines, effectively doubling the public timeout.
    const sql = await loadSql();
    const ctx = testContext();
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const calls: QueryServiceRequest[] = [];
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      calls.push(request);
      if (request.mode === "explain") {
        now.mockReturnValue(10_250);
      }
      return successfulResult();
    };

    try {
      await sql(ctx, {
        action: "execute",
        confirm: true,
        script: "DELETE FROM items;",
        timeoutMs: 1_000,
      }, backend);
    } finally {
      now.mockRestore();
    }

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.timeoutMs)).toEqual([1_000, 750]);
    expect(calls[0]?.signal).toBe(calls[1]?.signal);
  });

  it("starts the operation deadline before action and script normalization", async () => {
    // Production break caught: boundary preparation can happen before the
    // documented operation-entry timeout starts and extend the total deadline.
    const sql = await loadSql();
    const ctx = testContext();
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const calls: QueryServiceRequest[] = [];
    const options = {
      timeoutMs: 1_000,
      get action() {
        now.mockReturnValue(10_200);
        return "query";
      },
      get script() {
        now.mockReturnValue(10_250);
        return "SELECT 1;";
      },
    };

    try {
      await sql(ctx, options, async (_ctx, request) => {
        calls.push(request);
        return successfulResult();
      });
    } finally {
      now.mockRestore();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(750);
  });

  it("blocks NoTx when the shared signal is cancelled after preflight", async () => {
    // Production break caught: a confirmed mutation can be sent after caller
    // cancellation just because EXPLAIN had already succeeded.
    const sql = await loadSql();
    const ctx = testContext();
    const caller = new AbortController();
    const calls: QueryServiceRequest[] = [];
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      calls.push(request);
      caller.abort();
      return successfulResult();
    };

    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "DELETE FROM items;",
      signal: caller.signal,
    }, backend);

    expect(calls.map((call) => call.mode)).toEqual(["explain"]);
    expect(response).toMatchObject({
      executed: false,
      outcome: "failed",
      confirmationConsumed: false,
      preflight: successfulResult(),
    });
    expect(response).not.toHaveProperty("execution");
  });

  it("blocks NoTx when the absolute deadline expires before its abort event is delivered", async () => {
    // Production break caught: remaining timeout can clamp an already-expired
    // absolute deadline to 1 ms and send a confirmed mutation.
    const sql = await loadSql();
    const ctx = testContext();
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const calls: QueryServiceRequest[] = [];
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      calls.push(request);
      if (request.mode === "explain") {
        now.mockReturnValue(11_001);
      }
      return successfulResult();
    };

    let response: SqlResponse;
    try {
      response = await sql(ctx, {
        action: "execute",
        confirm: true,
        script: "DELETE FROM items;",
        timeoutMs: 1_000,
      }, backend);
    } finally {
      now.mockRestore();
    }

    expect(calls.map((call) => call.mode)).toEqual(["explain"]);
    expect(response!).toMatchObject({
      executed: false,
      outcome: "failed",
      confirmationConsumed: false,
      preflight: successfulResult(),
    });
    expect(response!).not.toHaveProperty("execution");
  });

  it("does not call the backend when the absolute deadline expires during synchronous preparation", async () => {
    // Production break caught: synchronous parameter/script preparation can
    // consume the deadline while the timeout signal has not fired yet.
    const sql = await loadSql();
    const ctx = testContext();
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(10_000)
      .mockReturnValue(11_001);
    let calls = 0;

    let response: SqlResponse;
    try {
      response = await sql(ctx, {
        script: "SELECT $value;",
        timeoutMs: 1_000,
        parameters: {
          value: {
            type: { kind: "primitive", name: "Utf8" },
            value: "prepared-before-first-call",
          },
        },
      }, async () => {
        calls += 1;
        return successfulResult();
      });
    } finally {
      now.mockRestore();
    }

    expect(calls).toBe(0);
    expect(response!).toMatchObject({
      executed: true,
      outcome: "failed",
      execution: {
        completion: "failed",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
      },
    });
  });

  it("gives confirmed execution only the bytes left after preflight, including zero", async () => {
    // Production break caught: preflight and execution can each consume the
    // full public byte cap, or a zero capture budget can suppress the mutation.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];
    const preflight = successfulResult({
      queryPlan: "12345",
      capturedBytes: 7,
    });
    const execution = successfulResult({
      completion: "partial",
      capturedBytes: 0,
      truncationReasons: ["byteLimit", "server"],
      resultSets: [{
        index: 0,
        columns: [],
        rows: [],
        truncationReasons: ["byteLimit", "server"],
      }],
    });
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      calls.push(request);
      return request.mode === "explain" ? preflight : execution;
    };

    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "DELETE FROM items;",
      maxOutputBytes: 7,
    }, backend);

    expect(calls.map((call) => call.maxOutputBytes)).toEqual([7, 0]);
    expect(calls.map((call) => call.mode)).toEqual(["explain", "noTx"]);
    expect(response).toMatchObject({
      executed: true,
      outputBytes: 7,
      truncated: true,
      truncationReasons: ["byteLimit", "server"],
    });
  });

  it("rejects over-budget and underreported preflight payloads before NoTx", async () => {
    // Production break caught: a backend can lie about captured bytes and
    // retain an arbitrarily larger plan while top-level accounting clamps it.
    const sql = await loadSql();
    const ctx = testContext();

    for (const malicious of [
      {
        completion: "success",
        resultSets: [],
        capturedBytes: 8,
        truncationReasons: [],
        queryPlan: "X".repeat(1_000),
      },
      {
        completion: "success",
        resultSets: [],
        capturedBytes: 1,
        truncationReasons: [],
        queryPlan: "abc",
      },
    ] as QueryServiceExecutionResult[]) {
      const calls: QueryServiceRequest[] = [];
      const response = await sql(ctx, {
        action: "execute",
        confirm: true,
        script: "DELETE FROM items;",
        maxOutputBytes: 7,
      }, async (_ctx, request) => {
        calls.push(request);
        return malicious;
      });

      expect(calls.map((call) => call.mode)).toEqual(["explain"]);
      expect(response).toMatchObject({
        executed: false,
        outcome: "failed",
        confirmationConsumed: false,
        preflight: {
          completion: "failed",
          resultSets: [],
          capturedBytes: 0,
          truncationReasons: [],
          diagnostics: "Managed SQL backend returned an invalid result.",
        },
        outputBytes: 0,
        truncated: false,
      });
      expect(response.preflight).not.toHaveProperty("queryPlan");
      expect(response).not.toHaveProperty("execution");
    }
  });

  it("rejects invalid completion, arrays, and captured byte counters", async () => {
    // Production break caught: TypeScript-only assumptions can let malformed
    // backend results reach outcome mapping or response aggregation.
    const sql = await loadSql();
    const ctx = testContext();
    const malformedResults: unknown[] = [
      {
        completion: "unexpected",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
      },
      {
        completion: "success",
        resultSets: null,
        capturedBytes: 0,
        truncationReasons: [],
      },
      {
        completion: "success",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: "byteLimit",
      },
      {
        completion: "success",
        resultSets: [],
        capturedBytes: -1,
        truncationReasons: [],
      },
      {
        completion: "success",
        resultSets: [],
        capturedBytes: Number.NaN,
        truncationReasons: [],
      },
    ];

    for (const malformed of malformedResults) {
      let calls = 0;
      const response = await sql(ctx, {
        action: "execute",
        confirm: true,
        script: "DELETE FROM items;",
      }, async () => {
        calls += 1;
        return malformed as QueryServiceExecutionResult;
      });

      expect(calls).toBe(1);
      expect(response).toMatchObject({
        executed: false,
        outcome: "failed",
        confirmationConsumed: false,
        preflight: {
          completion: "failed",
          resultSets: [],
          capturedBytes: 0,
          truncationReasons: [],
        },
      });
      expect(response).not.toHaveProperty("execution");
    }
  });

  it("blocks NoTx when a success preflight has an unknown or non-success status", async () => {
    // Production break caught: completion alone can authorize NoTx even when
    // the version-matched Query Service status contradicts it.
    const sql = await loadSql();
    const ctx = testContext();

    for (const status of [
      999_999 as StatusIds_StatusCode,
      StatusIds_StatusCode.BAD_REQUEST,
    ]) {
      const calls: QueryServiceRequest[] = [];
      const response = await sql(ctx, {
        action: "execute",
        confirm: true,
        script: "DELETE FROM items;",
      }, async (_ctx, request) => {
        calls.push(request);
        return successfulResult({ status });
      });

      expect(calls.map((call) => call.mode)).toEqual(["explain"]);
      expect(response).toMatchObject({
        executed: false,
        outcome: "failed",
        confirmationConsumed: false,
        preflight: {
          completion: "failed",
          resultSets: [],
          capturedBytes: 0,
          truncationReasons: [],
        },
      });
      expect(response).not.toHaveProperty("execution");
    }
  });

  it("blocks NoTx when a success preflight omits the Task 3 status", async () => {
    // Production break caught: an injected success completion without the
    // producer's mandatory SUCCESS status can authorize a confirmed mutation.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];
    const missingStatus: QueryServiceExecutionResult = {
      completion: "success",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: [],
    };
    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "DELETE FROM items;",
    }, async (_ctx, request) => {
      calls.push(request);
      return missingStatus;
    });

    expect(calls.map((call) => call.mode)).toEqual(["explain"]);
    expect(response).toMatchObject({
      executed: false,
      outcome: "failed",
      confirmationConsumed: false,
      preflight: {
        completion: "failed",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
      },
    });
    expect(response).not.toHaveProperty("execution");
  });

  it("rejects status-invalid preflights before traversing payload arrays", async () => {
    // Production break caught: missing or contradictory success/partial status
    // can force traversal of a large backend-owned payload before NoTx is
    // eventually blocked.
    const sql = await loadSql();
    const ctx = testContext();

    for (const [completion, status] of [
      ["success", undefined],
      ["success", StatusIds_StatusCode.BAD_REQUEST],
      ["partial", undefined],
      ["partial", StatusIds_StatusCode.BAD_REQUEST],
    ] as const) {
      let resultSetOwnKeysCalls = 0;
      let resultSetDescriptorReads = 0;
      let reasonOwnKeysCalls = 0;
      let reasonDescriptorReads = 0;
      const resultSets = new Proxy(
        Array.from({ length: 10_000 }, () => null),
        {
          ownKeys(target) {
            resultSetOwnKeysCalls += 1;
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, property) {
            resultSetDescriptorReads += 1;
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
        },
      );
      const truncationReasons = new Proxy(
        completion === "partial" ? ["byteLimit"] : [],
        {
          ownKeys(target) {
            reasonOwnKeysCalls += 1;
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, property) {
            reasonDescriptorReads += 1;
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
        },
      );
      const calls: QueryServiceRequest[] = [];

      const response = await sql(ctx, {
        action: "execute",
        confirm: true,
        script: "DELETE FROM items;",
      }, async (_ctx, request) => {
        calls.push(request);
        return {
          completion,
          resultSets,
          capturedBytes: 0,
          truncationReasons,
          ...(status !== undefined ? { status } : {}),
        } as unknown as QueryServiceExecutionResult;
      });

      expect(calls.map((call) => call.mode)).toEqual(["explain"]);
      expect(response).toMatchObject({
        executed: false,
        outcome: "failed",
        confirmationConsumed: false,
      });
      expect(response).not.toHaveProperty("execution");
      expect(resultSetOwnKeysCalls).toBe(0);
      expect(resultSetDescriptorReads).toBe(0);
      expect(reasonOwnKeysCalls).toBe(0);
      expect(reasonDescriptorReads).toBe(0);
    }
  });

  it("blocks NoTx without touching a stateful preflight column proxy", async () => {
    // Production break caught: a preflight column can pass byte measurement
    // with short descriptor values, swap in large retained values, and then
    // authorize a confirmed NoTx mutation.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];
    let fieldDescriptorReads = 0;
    let ownKeysCalls = 0;
    const column = new Proxy({ name: "x", type: "x" }, {
      ownKeys(target) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        fieldDescriptorReads += 1;
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property)!;
        return fieldDescriptorReads <= 4
          ? descriptor
          : { ...descriptor, value: "x".repeat(200_000) };
      },
    });
    const preflight = successfulResult({
      resultSets: [{
        index: 0,
        columns: [column],
        rows: [],
        truncationReasons: [],
      }],
      capturedBytes: 25,
    });

    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "DELETE FROM items;",
    }, async (_ctx, request) => {
      calls.push(request);
      return request.mode === "explain" ? preflight : successfulResult();
    });

    expect.soft(calls.map((call) => call.mode)).toEqual(["explain"]);
    expect.soft(response).toMatchObject({
      executed: false,
      outcome: "failed",
      confirmationConsumed: false,
    });
    expect.soft(response).not.toHaveProperty("execution");
    expect.soft(fieldDescriptorReads).toBe(0);
    expect(ownKeysCalls).toBe(0);
  });

  it("blocks NoTx when success preflight carries a truncation reason", async () => {
    // Production break caught: Task 3 classifies every retained truncation as
    // partial, so a success-shaped truncated preflight is backend corruption.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];
    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "DELETE FROM items;",
    }, async (_ctx, request) => {
      calls.push(request);
      return successfulResult({ truncationReasons: ["server"] });
    });

    expect(calls.map((call) => call.mode)).toEqual(["explain"]);
    expect(response).toMatchObject({
      executed: false,
      outcome: "failed",
      confirmationConsumed: false,
      preflight: {
        completion: "failed",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
      },
    });
    expect(response).not.toHaveProperty("execution");
  });

  it("rejects cyclic and excessively deep retained row values without traversal failure", async () => {
    // Production break caught: retaining backend-owned JSON recursively can
    // loop, overflow the stack, or allow NoTx after invalid preflight data.
    const sql = await loadSql();
    const ctx = testContext();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = 0;
    for (let depth = 0; depth < 1_000; depth += 1) {
      deep = [deep];
    }

    for (const value of [cyclic, deep]) {
      let calls = 0;
      const response = await sql(ctx, {
        action: "execute",
        confirm: true,
        script: "DELETE FROM items;",
        maxOutputBytes: 4_096,
      }, async () => {
        calls += 1;
        return successfulResult({
          capturedBytes: 4_096,
          resultSets: [{
            index: 0,
            columns: [{ name: "value", type: "Json" }],
            rows: [[value as never]],
            truncationReasons: [],
          }],
        });
      });

      expect(calls).toBe(1);
      expect(response).toMatchObject({
        executed: false,
        outcome: "failed",
        confirmationConsumed: false,
        preflight: {
          completion: "failed",
          resultSets: [],
          capturedBytes: 0,
        },
      });
      expect(response).not.toHaveProperty("execution");
    }
  });

  it("fails closed on zero-byte result-set amplification before confirmed NoTx", async () => {
    // Production break caught: a success-shaped preflight can return thousands
    // of uncharged limit envelopes and both amplify output and unlock NoTx.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];
    const amplified = successfulResult({
      resultSets: Array.from({ length: 10_000 }, (_, index) => ({
        index,
        columns: [],
        rows: [],
        truncationReasons: ["byteLimit"],
      })),
      capturedBytes: 0,
      truncationReasons: ["byteLimit"],
    });

    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "DELETE FROM items;",
      maxOutputBytes: 1,
    }, async (_ctx, request) => {
      calls.push(request);
      return amplified;
    });

    expect(calls.map((call) => call.mode)).toEqual(["explain"]);
    expect(response).toMatchObject({
      executed: false,
      outcome: "failed",
      confirmationConsumed: false,
      preflight: {
        completion: "failed",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
      },
      resultSets: [],
      outputBytes: 0,
    });
    expect(response).not.toHaveProperty("execution");
  });

  it("fails closed on repeated zero-byte envelopes with no execution capture budget", async () => {
    // Production break caught: after preflight consumes the whole byte budget,
    // a confirmed call can still amplify its response with uncharged envelopes.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];

    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "DELETE FROM items;",
      maxOutputBytes: 3,
    }, async (_ctx, request) => {
      calls.push(request);
      return request.mode === "explain"
        ? successfulResult({ queryPlan: "x", capturedBytes: 3 })
        : successfulResult({
            completion: "partial",
            resultSets: [
              {
                index: 0,
                columns: [],
                rows: [],
                truncationReasons: ["byteLimit"],
              },
              {
                index: 1,
                columns: [],
                rows: [],
                truncationReasons: ["byteLimit", "server"],
              },
            ],
            capturedBytes: 0,
            truncationReasons: ["byteLimit", "server"],
          });
    });

    expect(calls.map((call) => [call.mode, call.maxOutputBytes])).toEqual([
      ["explain", 3],
      ["noTx", 0],
    ]);
    expect(response).toMatchObject({
      executed: true,
      outcome: "failed",
      confirmationConsumed: true,
      execution: {
        completion: "failed",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
      },
      resultSets: [],
      outputBytes: 3,
      truncated: false,
    });
  });

  it("accepts honest Task 3 multi-payload accounting and empty truncation envelopes", async () => {
    // Production break caught: fail-closed validation can reject Task 3's
    // per-value accounting or charge an empty byteLimit envelope incorrectly.
    const sql = await loadSql();
    const ctx = testContext();
    const issueOne = {
      message: "warning",
      issueCode: 1,
      severity: 2,
      issues: [],
    };
    const issueTwo = {
      message: "note",
      issueCode: 2,
      severity: 1,
      position: { row: 1, column: 2, file: "query" },
      issues: [],
    };
    const honest = successfulResult({
      capturedBytes: 264,
      issues: [issueOne, issueTwo],
      queryPlan: "{}",
      resultSets: [{
        index: 0,
        columns: [{ name: "a", type: "Int32" }],
        rows: [[1]],
        truncationReasons: [],
      }, {
        index: 2,
        columns: [
          { name: "b", type: "Utf8" },
          { name: "b", type: "Utf8" },
        ],
        rows: [["x", "y"]],
        truncationReasons: [],
      }],
    });

    const query = await sql(ctx, {
      script: "SELECT 1;",
      maxOutputBytes: 264,
    }, async () => honest);
    expect(query.execution).toEqual(honest);
    expect(query.outputBytes).toBe(264);

    let executeCall = 0;
    const zeroBudgetExecution = successfulResult({
      completion: "partial",
      capturedBytes: 0,
      truncationReasons: ["byteLimit", "server"],
      resultSets: [{
        index: 0,
        columns: [],
        rows: [],
        truncationReasons: ["byteLimit", "server"],
      }],
    });
    const execute = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "DELETE FROM items;",
      maxOutputBytes: 3,
    }, async () => {
      executeCall += 1;
      return executeCall === 1
        ? successfulResult({ queryPlan: "x", capturedBytes: 3 })
        : zeroBudgetExecution;
    });

    expect(executeCall).toBe(2);
    expect(execute.execution).toEqual(zeroBudgetExecution);
    expect(execute).toMatchObject({
      executed: true,
      outcome: "partial",
      confirmationConsumed: true,
      outputBytes: 3,
      truncationReasons: ["byteLimit", "server"],
    });

    const serverEnvelope = successfulResult({
      completion: "partial",
      capturedBytes: 65,
      truncationReasons: ["server"],
      resultSets: [{
        index: 0,
        columns: [],
        rows: [],
        truncationReasons: ["server"],
      }],
    });
    const serverOnly = await sql(ctx, {
      script: "SELECT 1;",
      maxOutputBytes: 65,
    }, async () => serverEnvelope);
    expect(serverOnly.execution).toEqual(serverEnvelope);
    expect(serverOnly.outputBytes).toBe(65);
  });

  it("reuses deterministic declarations, encoded parameters, and the effective hash without echoing values", async () => {
    // Production break caught: preflight and execution can receive different
    // declaration order/values, or response metadata can echo sensitive input.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      calls.push(request);
      return successfulResult();
    };
    const inputScript = "  SELECT $a, $b;\n";
    const effectiveScript = [
      "DECLARE $a AS Utf8;",
      "DECLARE $b AS Uint64;",
      inputScript,
    ].join("\n");

    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      databasePath: " /local ",
      script: inputScript,
      parameters: {
        b: {
          type: { kind: "primitive", name: "Uint64" },
          value: "18446744073709551615",
        },
        a: {
          type: { kind: "primitive", name: "Utf8" },
          value: "sensitive-parameter-value",
        },
      },
    }, backend);

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.script)).toEqual([
      effectiveScript,
      effectiveScript,
    ]);
    expect(calls[0]?.parameters).toBe(calls[1]?.parameters);
    expect(Object.keys(calls[0]?.parameters ?? {})).toEqual(["$a", "$b"]);
    expect(response).toMatchObject({
      databasePath: "/local",
      scriptSha256: "d4bf145579602c28af1fcf1e7960c8087c3108011ed8d4e10e454a9b878855da",
      parameterTypes: {
        a: "Utf8",
        b: "Uint64",
      },
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("sensitive-parameter-value");
    expect(serialized).not.toContain("18446744073709551615");
    expect(serialized).not.toContain("DECLARE $a");
    expect(serialized).not.toContain(inputScript.trim());
    expect(serialized).not.toContain("serializedBytes");
  });

  it("redacts configured credential paths from returned parameter type metadata", async () => {
    // Production break caught: Struct field names are rendered into public
    // parameterTypes metadata and can expose configured credential paths.
    const sql = await loadSql();
    const rootPasswordFile = "/private/root.password";
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({
      profiles: {
        default: {
          rootPasswordFile,
        },
      },
    }));
    const response = await sql(ctx, {
      script: "SELECT $record;",
      parameters: {
        record: {
          type: {
            kind: "struct",
            fields: [{
              name: rootPasswordFile,
              type: { kind: "primitive", name: "Utf8" },
            }],
          },
          value: {
            [rootPasswordFile]: "safe-value",
          },
        },
      },
    }, async () => successfulResult());

    expect(response.parameterTypes).toEqual({
      record: "Struct<`<redacted>`:Utf8>",
    });
    expect(JSON.stringify(response)).not.toContain(rootPasswordFile);
  });

  it("redacts configured credential paths from returned textual payloads", async () => {
    // Production break caught: backend diagnostics, plans, ASTs, and nested
    // issues can reveal configured auth, password, token, or SSH identity paths.
    const sql = await loadSql();
    const credentialPaths = [
      "/private/auth.yaml",
      "/private/dynamic.token",
      "/private/root.password",
      "/private/id_ed25519",
    ];
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: credentialPaths[0],
          dynamicNodeAuthTokenFile: credentialPaths[1],
          rootPasswordFile: credentialPaths[2],
          ssh: {
            host: "example.invalid",
            identityFile: credentialPaths[3],
          },
        },
      },
    }));
    const backend: SqlBackendExecutor = async () => successfulResult({
      capturedBytes: 4_096,
      diagnostics: credentialPaths.join(" "),
      queryPlan: `plan ${credentialPaths[0]} ${credentialPaths[1]}`,
      queryAst: `ast ${credentialPaths[2]} ${credentialPaths[3]}`,
      issues: [{
        message: `top ${credentialPaths[0]}`,
        issueCode: 1,
        severity: 2,
        position: {
          row: 1,
          column: 2,
          file: credentialPaths[1],
        },
        endPosition: {
          row: 3,
          column: 4,
          file: credentialPaths[2],
        },
        issues: [{
          message: `nested ${credentialPaths[3]}`,
          issueCode: 5,
          severity: 6,
          position: {
            row: 7,
            column: 8,
            file: credentialPaths[0],
          },
          issues: [],
        }],
      }],
    });

    const response = await sql(ctx, {
      script: "SELECT 1;",
    }, backend);

    expect(response.execution?.diagnostics).toBe(
      "<redacted> <redacted> <redacted> <redacted>",
    );
    expect(response.execution?.queryPlan).toBe(
      "plan <redacted> <redacted>",
    );
    expect(response.execution?.queryAst).toBe(
      "ast <redacted> <redacted>",
    );
    expect(response.execution?.issues).toEqual([{
      message: "top <redacted>",
      issueCode: 1,
      severity: 2,
      position: {
        row: 1,
        column: 2,
        file: "<redacted>",
      },
      endPosition: {
        row: 3,
        column: 4,
        file: "<redacted>",
      },
      issues: [{
        message: "nested <redacted>",
        issueCode: 5,
        severity: 6,
        position: {
          row: 7,
          column: 8,
          file: "<redacted>",
        },
        issues: [],
      }],
    }]);
    for (const path of credentialPaths) {
      expect(JSON.stringify(response)).not.toContain(path);
    }
  });

  it("redacts configured credential paths recursively from result rows", async () => {
    // Production break caught: result rows bypassing the same credential-path
    // redaction as diagnostics/issues can expose local password and identity paths.
    const sql = await loadSql();
    const rootPasswordFile = "/private/root.password";
    const identityFile = "/private/id_ed25519";
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({
      profiles: {
        default: {
          rootPasswordFile,
          ssh: {
            host: "example.invalid",
            identityFile,
          },
        },
      },
    }));
    const backend: SqlBackendExecutor = async () => successfulResult({
      capturedBytes: 4_096,
      resultSets: [{
        index: 0,
        columns: [
          { name: "direct", type: "Utf8" },
          { name: "nested", type: "Json" },
          { name: "safe", type: "Utf8" },
        ],
        rows: [[
          `password file: ${rootPasswordFile}`,
          {
            paths: [
              identityFile,
              { deep: `both ${rootPasswordFile} and ${identityFile}` },
            ],
            metadata: {
              [identityFile]: rootPasswordFile,
            },
          },
          "ordinary row value",
        ]],
        truncationReasons: [],
      }],
    });

    const response = await sql(ctx, {
      script: "SELECT 'configured paths';",
    }, backend);

    expect(response.execution?.resultSets[0]?.rows).toEqual([[
      "password file: <redacted>",
      {
        paths: [
          "<redacted>",
          { deep: "both <redacted> and <redacted>" },
        ],
        metadata: {
          "<redacted>": "<redacted>",
        },
      },
      "ordinary row value",
    ]]);
    expect(JSON.stringify(response)).not.toContain(rootPasswordFile);
    expect(JSON.stringify(response)).not.toContain(identityFile);
  });

  it("maps every query and explain completion without allowing unknown", async () => {
    // Production break caught: low-risk actions can report success after a
    // partial/failing call, or expose mutation-only unknown outcome.
    const sql = await loadSql();
    const ctx = testContext();

    for (const action of ["query", "explain"] as const) {
      for (const [completion, expectedOutcome, expectedSummaryWord] of [
        ["success", "succeeded", action === "query" ? "executed" : "explained"],
        ["partial", "partial", "partial"],
        ["cancelled", "failed", "cancelled"],
        ["failed", "failed", "failed"],
        ["mutationStatusUnknown", "failed", "failed"],
      ] as const) {
        const result = successfulResult({
          completion,
          truncationReasons: completion === "partial" ? ["rowLimit"] : [],
        });
        const response = await sql(ctx, {
          action,
          script: "SELECT 1;",
        }, async () => result);

        expect(response).toMatchObject({
          action,
          risk: "low",
          executed: true,
          outcome: expectedOutcome,
          confirmationRequired: false,
          confirmationConsumed: false,
        });
        expect(response.summary.toLowerCase()).toContain(expectedSummaryWord);
      }
    }
  });

  it("maps confirmed NoTx completion and reserves unknown for mutation status loss", async () => {
    // Production break caught: a sent mutation can be retried/misreported after
    // status loss, or ordinary failures can be elevated to unknown.
    const sql = await loadSql();
    const ctx = testContext();

    for (const [completion, expectedOutcome, expectedSummaryWord] of [
      ["success", "succeeded", "executed"],
      ["partial", "partial", "partial"],
      ["cancelled", "failed", "cancelled"],
      ["failed", "failed", "failed"],
      ["mutationStatusUnknown", "unknown", "unknown"],
    ] as const) {
      let call = 0;
      const response = await sql(ctx, {
        action: "execute",
        confirm: true,
        script: "DELETE FROM items;",
      }, async () => {
        call += 1;
        return call === 1
          ? successfulResult()
          : successfulResult({
              completion,
              truncationReasons: completion === "partial" ? ["byteLimit"] : [],
            });
      });

      expect(call).toBe(2);
      expect(response).toMatchObject({
        risk: "high",
        executed: true,
        outcome: expectedOutcome,
        confirmationRequired: false,
        confirmationConsumed: true,
      });
      expect(response.summary.toLowerCase()).toContain(expectedSummaryWord);
    }
  });

  it("does not retry a confirmed NoTx call that throws", async () => {
    // Production break caught: an execution exception can trigger an automatic
    // retry and duplicate a mutation whose send status is not known here.
    const sql = await loadSql();
    const ctx = testContext();
    const calls: QueryServiceRequest[] = [];
    const response = await sql(ctx, {
      action: "execute",
      confirm: true,
      script: "DELETE FROM items;",
    }, async (_ctx, request) => {
      calls.push(request);
      if (request.mode === "noTx") {
        throw new Error("transport detail must stay private");
      }
      return successfulResult();
    });

    expect(calls.map((call) => call.mode)).toEqual(["explain", "noTx"]);
    expect(response).toMatchObject({
      executed: true,
      outcome: "failed",
      confirmationConsumed: true,
      execution: {
        completion: "failed",
        diagnostics: "Managed SQL backend request failed.",
      },
    });
    expect(JSON.stringify(response)).not.toContain("transport detail");
  });

  it("executes NoTx only with the token from the current EXPLAIN plan", async () => {
    const sql = await loadSql();
    const ctx = confirmationContext();
    const calls: QueryServiceRequest[] = [];
    const backend: SqlBackendExecutor = async (_ctx, request) => {
      calls.push(request);
      return successfulResult({
        diagnostics: request.mode === "explain" ? "exact-plan" : "",
      });
    };
    const request = {
      action: "execute",
      script: "DELETE FROM items WHERE id = $id;",
      parameters: {
        id: {
          type: { kind: "primitive", name: "Uint64" },
          value: "1",
        },
      },
    };

    const planned = await sql(ctx, request, backend);
    const accepted = await sql(ctx, {
      ...request,
      confirm: true,
      confirmationToken: planned.confirmation?.token,
    }, backend);

    expect(planned).toMatchObject({
      executed: false,
      confirmation: { status: "planned", token: expect.any(String) },
    });
    expect(accepted).toMatchObject({
      executed: true,
      confirmationConsumed: true,
      confirmation: { status: "accepted" },
    });
    expect(calls.map((call) => call.mode)).toEqual([
      "explain",
      "explain",
      "noTx",
    ]);
  });
});
