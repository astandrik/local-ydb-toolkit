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
  diagnosticRedactions: string[] = [],
): QueryServiceExecutionResult | undefined {
  return normalizeSqlBackendResult(result, {
    captureBudget,
    maxRows: 100,
    diagnosticRedactions,
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
  it("remeasures redacted rows against the public capture budget", () => {
    // Production break caught: a short configured redaction can expand one
    // retained row beyond the backend-reported raw byte count while still
    // fitting the public maxOutputBytes budget.
    const normalized = normalize({
      completion: "success",
      resultSets: [{
        index: 0,
        columns: [{ name: "value", type: "Utf8" }],
        rows: [["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]],
        truncationReasons: [],
      }],
      capturedBytes: 200,
      truncationReasons: [],
      status: StatusIds_StatusCode.SUCCESS,
    }, 1_000, ["x"]);

    expect(normalized?.capturedBytes).toBeGreaterThan(200);
    expect(normalized?.capturedBytes).toBeLessThanOrEqual(1_000);
    expect(normalized?.resultSets[0]?.rows).toEqual([[
      "<redacted>".repeat(50),
    ]]);
  });

  it("rejects redacted rows that exceed the public capture budget", () => {
    expect(normalize({
      completion: "success",
      resultSets: [{
        index: 0,
        columns: [{ name: "value", type: "Utf8" }],
        rows: [["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]],
        truncationReasons: [],
      }],
      capturedBytes: 200,
      truncationReasons: [],
      status: StatusIds_StatusCode.SUCCESS,
    }, 200, ["x"])).toBeUndefined();
  });

  it("redacts column metadata before retaining it", () => {
    const normalized = normalize({
      completion: "success",
      resultSets: [{
        index: 0,
        columns: [{
          name: "/private/root.password",
          type: "Tagged<Utf8, \"/private/id_ed25519\">",
        }],
        rows: [["safe"]],
        truncationReasons: [],
      }],
      capturedBytes: 200,
      truncationReasons: [],
      status: StatusIds_StatusCode.SUCCESS,
    }, 1_000, [
      "/private/root.password",
      "/private/id_ed25519",
    ]);

    expect(normalized?.resultSets[0]?.columns).toEqual([{
      name: "<redacted>",
      type: "Tagged<Utf8, \"<redacted>\">",
    }]);
    expect(JSON.stringify(normalized)).not.toContain("/private/");
  });

  it("preserves every value when redacted object keys collide", () => {
    const normalized = normalize({
      completion: "success",
      resultSets: [{
        index: 0,
        columns: [{ name: "value", type: "Json" }],
        rows: [[{
          "token=one": "first",
          "token=two": "second",
          "token=<redacted>": "third",
        }]],
        truncationReasons: [],
      }],
      capturedBytes: 200,
      truncationReasons: [],
      status: StatusIds_StatusCode.SUCCESS,
    }, 1_000);

    expect(normalized?.resultSets[0]?.rows).toEqual([[
      {
        "token=<redacted>": "first",
        "token=<redacted>#2": "second",
        "token=<redacted>#3": "third",
      },
    ]]);
  });

  it("rejects an empty result set without a Task 3 truncation envelope", () => {
    // Production break caught: zero-byte empty result sets that Task 3 never
    // retains can amplify the public response without consuming the budget.
    expect(normalize({
      completion: "success",
      resultSets: [emptyResultSet(0, [])],
      capturedBytes: 0,
      truncationReasons: [],
      status: StatusIds_StatusCode.SUCCESS,
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
      status: StatusIds_StatusCode.SUCCESS,
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
      },
      {
        completion: "partial",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: ["byteLimit"],
      },
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
    expect(normalize({
      completion: "cancelled",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: [],
    })).toBeDefined();
    expect(normalize({
      completion: "mutationStatusUnknown",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: [],
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
      status: StatusIds_StatusCode.SUCCESS,
    })).toBeUndefined();
    expect(normalize({
      completion: "partial",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: [],
      status: StatusIds_StatusCode.SUCCESS,
    })).toBeUndefined();

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
      status: StatusIds_StatusCode.SUCCESS,
    }, 64)).toBeUndefined();
    expect(laterColumnDescriptorReads).toBe(0);
  });

  it("rejects an oversized column array before full enumeration or copy", () => {
    // Production break caught: inspectDenseArray can enumerate and copy all
    // 600,000 raw columns before the one-byte reported payload guard rejects.
    const sharedColumn = { name: "value", type: "Int32" };
    const target = Array.from({ length: 600_000 }, () => sharedColumn);
    let ownKeysCalls = 0;
    let descriptorReads = 0;
    const columns = new Proxy(target, {
      ownKeys(array) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(array);
      },
      getOwnPropertyDescriptor(array, property) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(array, property);
      },
    });

    expect(normalize({
      completion: "success",
      resultSets: [{
        index: 0,
        columns,
        rows: [],
        truncationReasons: [],
      }],
      capturedBytes: 1,
      truncationReasons: [],
      status: StatusIds_StatusCode.SUCCESS,
    }, 1_048_576)).toBeUndefined();
    expect(descriptorReads).toBeLessThanOrEqual(2);
    expect(ownKeysCalls).toBe(0);
  });

  it("rejects byte-fitting non-column entries before full enumeration or copy", () => {
    // Production break caught: 500,000 numeric entries fit the JSON byte cap
    // but are not exact column records and must not reach full array copying.
    const target = Array.from({ length: 500_000 }, () => 0);
    let ownKeysCalls = 0;
    let descriptorReads = 0;
    const columns = new Proxy(target, {
      ownKeys(array) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(array);
      },
      getOwnPropertyDescriptor(array, property) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(array, property);
      },
    });

    expect(normalize({
      completion: "success",
      resultSets: [{
        index: 0,
        columns: columns as never,
        rows: [],
        truncationReasons: [],
      }],
      capturedBytes: 1_000_001,
      truncationReasons: [],
      status: StatusIds_StatusCode.SUCCESS,
    }, 1_048_576)).toBeUndefined();
    expect(descriptorReads).toBeLessThanOrEqual(2);
    expect(ownKeysCalls).toBe(0);
  });

  it("rejects a stateful column-array length before any proxy traversal", () => {
    // Production break caught: separate measure/inspect passes can observe a
    // one-column array first and then retain 100,000 columns under a 25-byte
    // captured counter.
    const sharedColumn = { name: "x", type: "x" };
    const target = Array.from({ length: 100_000 }, () => sharedColumn);
    let lengthDescriptorReads = 0;
    let indexDescriptorReads = 0;
    let ownKeysCalls = 0;
    const columns = new Proxy(target, {
      ownKeys(array) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(array);
      },
      getOwnPropertyDescriptor(array, property) {
        if (property === "length") {
          lengthDescriptorReads += 1;
          const descriptor = Reflect.getOwnPropertyDescriptor(array, property)!;
          return lengthDescriptorReads === 1
            ? { ...descriptor, value: 1 }
            : descriptor;
        }
        indexDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(array, property);
      },
    });

    const normalized = normalize({
      completion: "success",
      resultSets: [{
        index: 0,
        columns,
        rows: [],
        truncationReasons: [],
      }],
      capturedBytes: 25,
      truncationReasons: [],
      status: StatusIds_StatusCode.SUCCESS,
    }, 1_048_576);

    expect.soft(normalized === undefined).toBe(true);
    expect.soft(lengthDescriptorReads).toBe(0);
    expect.soft(indexDescriptorReads).toBe(0);
    expect(ownKeysCalls).toBe(0);
  });

  it("rejects stateful column descriptors before retaining swapped values", () => {
    // Production break caught: a column can expose short strings to the byte
    // measurement passes and large strings to the later normalization pass.
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

    const normalized = normalize({
      completion: "success",
      resultSets: [{
        index: 0,
        columns: [column],
        rows: [],
        truncationReasons: [],
      }],
      capturedBytes: 25,
      truncationReasons: [],
      status: StatusIds_StatusCode.SUCCESS,
    }, 1_048_576);

    expect.soft(normalized === undefined).toBe(true);
    expect.soft(fieldDescriptorReads).toBe(0);
    expect(ownKeysCalls).toBe(0);
  });

  it("preserves dense-array, exact-record, and accessor rejection for columns", () => {
    const sparseColumns = new Array(1);
    const extraArrayProperty = [{ name: "x", type: "Int32" }];
    Object.defineProperty(extraArrayProperty, "extra", {
      value: true,
      enumerable: true,
    });
    const accessorIndex: unknown[] = [];
    Object.defineProperty(accessorIndex, "0", {
      get: () => ({ name: "x", type: "Int32" }),
      enumerable: true,
    });
    accessorIndex.length = 1;
    const extraColumnProperty = [{
      name: "x",
      type: "Int32",
      extra: true,
    }];
    const accessorColumn = [{
      get name() {
        return "x";
      },
      type: "Int32",
    }];

    for (const columns of [
      sparseColumns,
      extraArrayProperty,
      accessorIndex,
      extraColumnProperty,
      accessorColumn,
    ]) {
      expect(normalize({
        completion: "success",
        resultSets: [{
          index: 0,
          columns,
          rows: [],
          truncationReasons: [],
        }],
        capturedBytes: 29,
        truncationReasons: [],
        status: StatusIds_StatusCode.SUCCESS,
      }, 29)).toBeUndefined();
    }
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
