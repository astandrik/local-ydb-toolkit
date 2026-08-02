import { describe, expect, it } from "vitest";
import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import {
  normalizeSqlBackendResult,
} from "../src/operations/sql-result.js";
import type {
  QueryServiceExecutionResult,
  QueryServiceResultSet,
} from "../src/query-service.js";

function normalize(
  result: QueryServiceExecutionResult,
  captureBudget = 1,
): QueryServiceExecutionResult | undefined {
  return normalizeSqlBackendResult(result, {
    captureBudget,
    maxRows: 100,
    diagnosticRedactions: [],
  });
}

function emptyResultSet(
  index: number,
  truncationReasons: QueryServiceResultSet["truncationReasons"],
): QueryServiceResultSet {
  return {
    index,
    columns: [],
    rows: [],
    truncationReasons,
  };
}

describe("managed SQL backend result normalization", () => {
  it("rejects an empty result set without a Task 3 truncation envelope", () => {
    // Production break caught: zero-byte empty result sets that Task 3 never
    // retains can amplify the public response without consuming the budget.
    expect(normalize({
      completion: "success",
      resultSets: [emptyResultSet(0, [])],
      capturedBytes: 0,
      truncationReasons: [],
    })).toBeUndefined();
  });

  it("allows only one uncharged empty byte-limit envelope per call", () => {
    // Production break caught: each individually valid zero-byte envelope can
    // be repeated across server-controlled result-set indexes.
    const oneEnvelope: QueryServiceExecutionResult = {
      completion: "partial",
      resultSets: [emptyResultSet(0, ["byteLimit", "server"])],
      capturedBytes: 0,
      truncationReasons: ["byteLimit", "server"],
    };
    const repeatedEnvelope: QueryServiceExecutionResult = {
      ...oneEnvelope,
      resultSets: [
        emptyResultSet(0, ["byteLimit"]),
        emptyResultSet(1, ["byteLimit", "server"]),
      ],
    };

    expect(normalize(oneEnvelope, 0)).toEqual(oneEnvelope);
    expect(normalize(repeatedEnvelope, 0)).toBeUndefined();
  });

  it("rejects unknown or completion-inconsistent Query Service statuses", () => {
    // Production break caught: a numeric value can satisfy the TypeScript enum
    // shape at runtime or contradict the completion used by the state machine.
    const invalid: QueryServiceExecutionResult[] = [
      {
        completion: "success",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
        status: 999_999 as StatusIds_StatusCode,
      },
      {
        completion: "success",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
        status: StatusIds_StatusCode.BAD_REQUEST,
      },
      {
        completion: "partial",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: ["byteLimit"],
        status: StatusIds_StatusCode.BAD_REQUEST,
      },
      {
        completion: "cancelled",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
        status: StatusIds_StatusCode.CANCELLED,
      },
      {
        completion: "mutationStatusUnknown",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
        status: StatusIds_StatusCode.UNDETERMINED,
      },
      {
        completion: "failed",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
        status: StatusIds_StatusCode.SUCCESS,
      },
    ];

    for (const result of invalid) {
      expect(normalize(result)).toBeUndefined();
    }
    expect(normalize({
      completion: "success",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: [],
      status: StatusIds_StatusCode.SUCCESS,
    })).toBeDefined();
    expect(normalize({
      completion: "partial",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: ["byteLimit"],
      status: StatusIds_StatusCode.SUCCESS,
    })).toBeDefined();
    expect(normalize({
      completion: "failed",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: [],
      status: StatusIds_StatusCode.BAD_REQUEST,
    })).toBeDefined();
  });

  it("rejects completion and truncation combinations Task 3 cannot emit", () => {
    // Production break caught: a success with truncation can unlock NoTx, and
    // a reason-free partial completion has no Task 3 capture-limit source.
    expect(normalize({
      completion: "success",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: ["server"],
    })).toBeUndefined();
    expect(normalize({
      completion: "partial",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: [],
    })).toBeUndefined();

    expect(normalize({
      completion: "partial",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: ["byteLimit"],
    })).toBeDefined();
    expect(normalize({
      completion: "failed",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: ["server"],
    })).toBeDefined();
  });

  it("bounds raw column metadata before mapping the normalized column list", () => {
    // Production break caught: a large backend-owned column array can be fully
    // mapped before its first oversized metadata value fails the byte budget.
    let laterColumnDescriptorReads = 0;
    const observedColumn = () => new Proxy(
      { name: "later", type: "Int32" },
      {
        getOwnPropertyDescriptor(target, property) {
          laterColumnDescriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    const columns = [
      { name: "x".repeat(1_000), type: "Int32" },
      ...Array.from({ length: 59 }, observedColumn),
    ];

    expect(normalize({
      completion: "success",
      resultSets: [{
        index: 0,
        columns,
        rows: [],
        truncationReasons: [],
      }],
      capturedBytes: 64,
      truncationReasons: [],
    }, 64)).toBeUndefined();
    expect(laterColumnDescriptorReads).toBe(0);
  });

  it("accepts Task 3 history bytes from overwritten plan and AST parts", () => {
    // Compatibility evidence paired with the Query Service stream test: the
    // final two retained one-character strings encode to six bytes, while two
    // earlier overwritten strings make the honest captured counter twelve.
    const result: QueryServiceExecutionResult = {
      completion: "success",
      resultSets: [],
      capturedBytes: 12,
      truncationReasons: [],
      queryPlan: "b",
      queryAst: "y",
      status: StatusIds_StatusCode.SUCCESS,
    };

    expect(normalize(result, 12)).toEqual(result);
  });
});
