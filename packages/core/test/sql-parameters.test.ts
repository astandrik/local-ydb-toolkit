import { describe, expect, it } from "vitest";
import { Type_PrimitiveTypeId } from "@ydbjs/api/value";
import {
  MAX_SQL_PARAMETER_BYTES,
  decodeYdbValue,
  prepareSqlParameters,
} from "../src/sql-parameters.js";
import type { SqlParameterType } from "../src/sql-parameter-types.js";

describe("SQL parameter descriptors", () => {
  it("renders the exact recursive descriptor shape and sorted DECLARE prefix", async () => {
    // Production break caught: callers cannot bind stable parameter types when
    // descriptors render ambiguously or declarations depend on object order.
    const core = await import("../src/index.js") as Record<string, unknown>;

    expect(typeof core.renderYqlType).toBe("function");
    expect(typeof core.prepareSqlParameters).toBe("function");

    const renderYqlType = core.renderYqlType as (type: unknown) => string;
    const prepareSqlParameters = core.prepareSqlParameters as (
      parameters: Record<string, unknown>,
    ) => {
      declarationPrefix: string;
      parameterTypes: Record<string, string>;
    };

    expect(renderYqlType({
      kind: "list",
      item: {
        kind: "struct",
        fields: [
          { name: "id", type: { kind: "primitive", name: "Uint64" } },
          {
            name: "labels",
            type: {
              kind: "dict",
              key: { kind: "primitive", name: "Utf8" },
              value: { kind: "optional", item: { kind: "primitive", name: "Utf8" } },
            },
          },
        ],
      },
    })).toBe("List<Struct<`id`:Uint64, `labels`:Dict<Utf8, Optional<Utf8>>>>");

    const prepared = prepareSqlParameters({
      zeta: {
        type: { kind: "decimal", precision: 22, scale: 9 },
        value: "12.34",
      },
      alpha: {
        type: {
          kind: "tuple",
          items: [
            { kind: "primitive", name: "Bool" },
            { kind: "primitive", name: "Int32" },
          ],
        },
        value: [true, 7],
      },
    });

    expect(prepared.declarationPrefix).toBe(
      "DECLARE $alpha AS Tuple<Bool, Int32>;\nDECLARE $zeta AS Decimal(22, 9);\n",
    );
    expect(prepared.parameterTypes).toEqual({
      alpha: "Tuple<Bool, Int32>",
      zeta: "Decimal(22, 9)",
    });
    expect(prepared).not.toHaveProperty("parameterValues");
  });

  it("preserves __proto__ as an own metadata key and decoded struct field", () => {
    const parameters = Object.fromEntries([
      [
        "__proto__",
        {
          type: { kind: "primitive", name: "Int32" },
          value: 7,
        },
      ],
      [
        "struct",
        {
          type: {
            kind: "struct",
            fields: [
              { name: "__proto__", type: { kind: "primitive", name: "Utf8" } },
            ],
          },
          value: Object.fromEntries([["__proto__", "kept"]]),
        },
      ],
    ]);

    const prepared = prepareSqlParameters(parameters as never);
    expect(Object.hasOwn(prepared.parameterTypes, "__proto__")).toBe(true);
    expect(prepared.parameterTypes.__proto__).toBe("Int32");

    const decoded = decodeYdbValue(
      prepared.typedValues.$struct.type!,
      prepared.typedValues.$struct.value!,
    );
    expect(decoded).not.toBeNull();
    expect(Array.isArray(decoded)).toBe(false);
    expect(typeof decoded).toBe("object");
    expect(Object.hasOwn(decoded as object, "__proto__")).toBe(true);
    expect((decoded as Record<string, unknown>).__proto__).toBe("kept");
  });

  it("encodes primitive values with explicit YDB wire types", () => {
    // Production break caught: inferred JS types silently turn Uint64 into Int64,
    // lose 64-bit precision, or return byte arrays and bigint values that JSON cannot serialize.
    const prepared = prepareSqlParameters({
      bool: { type: { kind: "primitive", name: "Bool" }, value: true },
      int8: { type: { kind: "primitive", name: "Int8" }, value: -128 },
      uint32: { type: { kind: "primitive", name: "Uint32" }, value: 4_294_967_295 },
      int64: { type: { kind: "primitive", name: "Int64" }, value: "-9223372036854775808" },
      uint64: { type: { kind: "primitive", name: "Uint64" }, value: "18446744073709551615" },
      float: { type: { kind: "primitive", name: "Float" }, value: 1.25 },
      double: { type: { kind: "primitive", name: "Double" }, value: -2.5 },
      bytes: { type: { kind: "primitive", name: "String" }, value: "AAEC/w==" },
      text: { type: { kind: "primitive", name: "Utf8" }, value: "Привет" },
      json: {
        type: { kind: "primitive", name: "Json" },
        value: { enabled: true, count: 2 },
      },
      document: {
        type: { kind: "primitive", name: "JsonDocument" },
        value: ["a", null, 3],
      },
      yson: { type: { kind: "primitive", name: "Yson" }, value: "e2E9MX0=" },
      uuid: {
        type: { kind: "primitive", name: "Uuid" },
        value: "123e4567-e89b-12d3-a456-426614174000",
      },
    });

    expect(prepared.typedValues.$bool.type?.type).toEqual({
      case: "typeId",
      value: Type_PrimitiveTypeId.BOOL,
    });
    expect(prepared.typedValues.$bool.value?.value).toEqual({
      case: "boolValue",
      value: true,
    });
    expect(prepared.typedValues.$int8.value?.value).toEqual({
      case: "int32Value",
      value: -128,
    });
    expect(prepared.typedValues.$uint32.value?.value).toEqual({
      case: "uint32Value",
      value: 4_294_967_295,
    });
    expect(prepared.typedValues.$int64.value?.value).toEqual({
      case: "int64Value",
      value: -9_223_372_036_854_775_808n,
    });
    expect(prepared.typedValues.$uint64.value?.value).toEqual({
      case: "uint64Value",
      value: 18_446_744_073_709_551_615n,
    });
    expect(prepared.typedValues.$bytes.value?.value).toEqual({
      case: "bytesValue",
      value: Uint8Array.from([0, 1, 2, 255]),
    });
    expect(prepared.typedValues.$json.value?.value).toEqual({
      case: "textValue",
      value: "{\"enabled\":true,\"count\":2}",
    });
    expect(prepared.typedValues.$uuid.value?.value.case).toBe("low128");

    expect(prepared.typedValues.$text.value?.value).toEqual({
      case: "textValue",
      value: "Привет",
    });
    expect(prepared.typedValues.$document.value?.value).toEqual({
      case: "textValue",
      value: "[\"a\",null,3]",
    });
    expect(prepared.typedValues.$yson.value?.value).toEqual({
      case: "bytesValue",
      value: Uint8Array.from([123, 97, 61, 49, 125]),
    });
  });

  it("rejects ill-formed Unicode before encoding Utf8 parameters", () => {
    // Production break caught: protobuf replaces lone UTF-16 surrogates with
    // U+FFFD, silently sending a different Utf8 value than the MCP request.
    for (const value of ["\ud800", "\udc00", `left\ud800right`]) {
      expect(() => prepareSqlParameters({
        text: {
          type: { kind: "primitive", name: "Utf8" },
          value,
        },
      })).toThrow("Utf8 value must be well-formed Unicode");
    }

    expect(() => prepareSqlParameters({
      text: {
        type: { kind: "primitive", name: "Utf8" },
        value: "valid \ud83d\ude80 pair",
      },
    })).not.toThrow();
  });

  it("encodes Decimal and DyNumber without converting precision-sensitive strings to numbers", () => {
    // Production break caught: Number conversion rounds Decimal/DyNumber inputs
    // before they reach YDB and Decimal values need signed 128-bit wire halves.
    const prepared = prepareSqlParameters({
      amount: {
        type: { kind: "decimal", precision: 10, scale: 2 },
        value: "-12.34",
      },
      dynamic: {
        type: { kind: "primitive", name: "DyNumber" },
        value: "9.9999999999999999999999999999999999999E+125",
      },
      fixedDynamic: {
        type: { kind: "primitive", name: "DyNumber" },
        value: "0.000000000000000000000000000000000000001",
      },
    });

    expect(prepared.typedValues.$amount.type?.type).toEqual({
      case: "decimalType",
      value: expect.objectContaining({ precision: 10, scale: 2 }),
    });
    expect(prepared.typedValues.$amount.value?.value).toEqual({
      case: "low128",
      value: 18_446_744_073_709_550_382n,
    });
    expect(prepared.typedValues.$amount.value?.high128).toBe(
      18_446_744_073_709_551_615n,
    );
    expect(prepared.typedValues.$dynamic.type?.type).toEqual({
      case: "typeId",
      value: Type_PrimitiveTypeId.DYNUMBER,
    });
    expect(prepared.typedValues.$dynamic.value?.value).toEqual({
      case: "textValue",
      value: "9.9999999999999999999999999999999999999E+125",
    });
    expect(prepared.typedValues.$fixedDynamic.value?.value).toEqual({
      case: "textValue",
      value: "0.000000000000000000000000000000000000001",
    });
  });

  it("encodes YDB ISO date, time, timezone, and interval inputs with extended wire ranges", () => {
    // Production break caught: JS Date truncates microseconds and cannot represent
    // the full Date32/Datetime64/Timestamp64 domain; intervals need exact integer micros.
    const prepared = prepareSqlParameters({
      date: { type: { kind: "primitive", name: "Date" }, value: "1970-01-02" },
      datetime: {
        type: { kind: "primitive", name: "Datetime" },
        value: "1970-01-01T00:00:01Z",
      },
      timestamp: {
        type: { kind: "primitive", name: "Timestamp" },
        value: "1970-01-01T00:00:00.000001Z",
      },
      interval: {
        type: { kind: "primitive", name: "Interval" },
        value: "P1W2DT2H3M4.567890S",
      },
      tzDate: {
        type: { kind: "primitive", name: "TzDate" },
        value: "2025-01-02,Europe/Moscow",
      },
      tzDatetime: {
        type: { kind: "primitive", name: "TzDatetime" },
        value: "2025-01-02T03:04:05,Europe/Moscow",
      },
      tzTimestamp: {
        type: { kind: "primitive", name: "TzTimestamp" },
        value: "2025-01-02T03:04:05.000006,Europe/Moscow",
      },
      tzDateAlias: {
        type: { kind: "primitive", name: "TzDate" },
        value: "2025-01-02,Etc/UTC",
      },
      tzDatetimeAlias: {
        type: { kind: "primitive", name: "TzDatetime" },
        value: "2025-01-02T03:04:05,US/Eastern",
      },
      date32: { type: { kind: "primitive", name: "Date32" }, value: "1969-12-31" },
      datetime64: {
        type: { kind: "primitive", name: "Datetime64" },
        value: "1969-12-31T23:59:59Z",
      },
      timestamp64: {
        type: { kind: "primitive", name: "Timestamp64" },
        value: "1969-12-31T23:59:59.999999Z",
      },
      interval64: {
        type: { kind: "primitive", name: "Interval64" },
        value: "-P1D",
      },
    });

    expect(prepared.typedValues.$date.value?.value).toEqual({
      case: "uint32Value",
      value: 1,
    });
    expect(prepared.typedValues.$datetime.value?.value).toEqual({
      case: "uint32Value",
      value: 1,
    });
    expect(prepared.typedValues.$timestamp.value?.value).toEqual({
      case: "uint64Value",
      value: 1n,
    });
    expect(prepared.typedValues.$interval.value?.value).toEqual({
      case: "int64Value",
      value: 784_984_567_890n,
    });
    expect(prepared.typedValues.$tzDate.value?.value).toEqual({
      case: "textValue",
      value: "2025-01-02,Europe/Moscow",
    });
    expect(prepared.typedValues.$tzDatetime.value?.value).toEqual({
      case: "textValue",
      value: "2025-01-02T03:04:05,Europe/Moscow",
    });
    expect(prepared.typedValues.$tzTimestamp.value?.value).toEqual({
      case: "textValue",
      value: "2025-01-02T03:04:05.000006,Europe/Moscow",
    });
    expect(prepared.typedValues.$tzDateAlias.value?.value).toEqual({
      case: "textValue",
      value: "2025-01-02,Etc/UTC",
    });
    expect(prepared.typedValues.$tzDatetimeAlias.value?.value).toEqual({
      case: "textValue",
      value: "2025-01-02T03:04:05,US/Eastern",
    });
    expect(prepared.typedValues.$date32.value?.value).toEqual({
      case: "int32Value",
      value: -1,
    });
    expect(prepared.typedValues.$datetime64.value?.value).toEqual({
      case: "int64Value",
      value: -1n,
    });
    expect(prepared.typedValues.$timestamp64.value?.value).toEqual({
      case: "int64Value",
      value: -1n,
    });
    expect(prepared.typedValues.$interval64.value?.value).toEqual({
      case: "int64Value",
      value: -86_400_000_000n,
    });
    expect(Object.fromEntries([
      "date",
      "datetime",
      "timestamp",
      "interval",
      "tzDate",
      "tzDateAlias",
      "tzDatetime",
      "tzDatetimeAlias",
      "tzTimestamp",
      "date32",
      "datetime64",
      "timestamp64",
      "interval64",
    ].map((name) => {
      const typed = prepared.typedValues[`$${name}`];
      return [name, decodeYdbValue(typed.type!, typed.value!)];
    }))).toEqual({
      date: "1970-01-02",
      datetime: "1970-01-01T00:00:01Z",
      timestamp: "1970-01-01T00:00:00.000001Z",
      interval: "P9DT2H3M4.56789S",
      tzDate: "2025-01-02,Europe/Moscow",
      tzDateAlias: "2025-01-02,Etc/UTC",
      tzDatetime: "2025-01-02T03:04:05,Europe/Moscow",
      tzDatetimeAlias: "2025-01-02T03:04:05,US/Eastern",
      tzTimestamp: "2025-01-02T03:04:05.000006,Europe/Moscow",
      date32: "1969-12-31",
      datetime64: "1969-12-31T23:59:59Z",
      timestamp64: "1969-12-31T23:59:59.999999Z",
      interval64: "-P1D",
    });
  });

  it("rejects expanded ordinary years while preserving wide temporal years", () => {
    const invalidOrdinaryValues = [
      ["Date", "+002025-01-02"],
      ["Date", "02025-01-02"],
      ["Date", "002025-01-02"],
      ["Datetime", "+002025-01-02T03:04:05Z"],
      ["Datetime", "002025-01-02T03:04:05Z"],
      ["Timestamp", "+002025-01-02T03:04:05.000006Z"],
      ["Timestamp", "002025-01-02T03:04:05.000006Z"],
      ["TzDate", "+002025-01-02,Europe/Moscow"],
      ["TzDatetime", "002025-01-02T03:04:05,Europe/Moscow"],
      ["TzTimestamp", "+002025-01-02T03:04:05.000006,Europe/Moscow"],
    ] as const;

    for (const [name, value] of invalidOrdinaryValues) {
      expect(() => prepareSqlParameters({
        parameter: {
          type: { kind: "primitive", name },
          value,
        },
      })).toThrow(/ISO|YYYY-MM-DD/);
    }

    const prepared = prepareSqlParameters({
      date32: {
        type: { kind: "primitive", name: "Date32" },
        value: "+012345-06-07",
      },
      datetime64: {
        type: { kind: "primitive", name: "Datetime64" },
        value: "-000001-12-31T23:59:59Z",
      },
      timestamp64: {
        type: { kind: "primitive", name: "Timestamp64" },
        value: "+012345-06-07T08:09:10.000011Z",
      },
    });

    expect(prepared.typedValues.$date32.value?.value.case).toBe("int32Value");
    expect(prepared.typedValues.$datetime64.value?.value.case).toBe("int64Value");
    expect(prepared.typedValues.$timestamp64.value?.value.case).toBe("int64Value");
  });

  it("encodes nested List<Struct>, Optional, Tuple, and Dict values from their descriptors", () => {
    // Production break caught: type inference makes empty/null containers untyped
    // and heterogeneous structs optional, producing query parameter type mismatches.
    const prepared = prepareSqlParameters({
      rows: {
        type: {
          kind: "list",
          item: {
            kind: "struct",
            fields: [
              { name: "id", type: { kind: "primitive", name: "Uint64" } },
              {
                name: "note",
                type: { kind: "optional", item: { kind: "primitive", name: "Utf8" } },
              },
            ],
          },
        },
        value: [
          { id: "1", note: "first" },
          { id: "2", note: null },
        ],
      },
      optional: {
        type: { kind: "optional", item: { kind: "primitive", name: "Int32" } },
        value: null,
      },
      tuple: {
        type: {
          kind: "tuple",
          items: [
            { kind: "primitive", name: "Bool" },
            { kind: "primitive", name: "Int64" },
          ],
        },
        value: [true, "7"],
      },
      dict: {
        type: {
          kind: "dict",
          key: { kind: "primitive", name: "Utf8" },
          value: { kind: "primitive", name: "Uint64" },
        },
        value: [
          { key: "alpha", value: "1" },
          { key: "beta", value: "2" },
        ],
      },
      empty: {
        type: { kind: "list", item: { kind: "primitive", name: "Uuid" } },
        value: [],
      },
    });

    const rowsType = prepared.typedValues.$rows.type?.type;
    expect(rowsType?.case).toBe("listType");
    if (rowsType?.case !== "listType") {
      throw new Error("expected list type");
    }
    const structType = rowsType.value.item?.type;
    expect(structType?.case).toBe("structType");
    if (structType?.case !== "structType") {
      throw new Error("expected struct type");
    }
    expect(structType.value.members.map((member) => member.name)).toEqual(["id", "note"]);
    expect(prepared.typedValues.$rows.value?.items).toHaveLength(2);
    expect(prepared.typedValues.$rows.value?.items[0].items[0].value).toEqual({
      case: "uint64Value",
      value: 1n,
    });
    expect(prepared.typedValues.$rows.value?.items[1].items[1].value.case).toBe(
      "nullFlagValue",
    );
    expect(prepared.typedValues.$optional.value?.value.case).toBe("nullFlagValue");
    expect(prepared.typedValues.$tuple.value?.items.map((item) => item.value.case)).toEqual([
      "boolValue",
      "int64Value",
    ]);
    expect(prepared.typedValues.$dict.value?.pairs).toHaveLength(2);
    expect(prepared.typedValues.$dict.value?.pairs[1].key?.value).toEqual({
      case: "textValue",
      value: "beta",
    });
    expect(prepared.typedValues.$empty.type?.type.case).toBe("listType");
    expect(prepared.typedValues.$empty.value?.items).toEqual([]);
  });

  it("decodes YDB values recursively into JSON-safe forms", async () => {
    // Production break caught: protobuf bigint/bytes and Dict maps cannot cross
    // JSON/MCP boundaries, and nested results must follow their declared YDB types.
    const core = await import("../src/index.js") as Record<string, unknown>;
    expect(typeof core.decodeYdbValue).toBe("function");
    const decodeYdbValue = core.decodeYdbValue as (
      type: NonNullable<ReturnType<typeof prepareSqlParameters>["typedValues"][string]["type"]>,
      value: NonNullable<ReturnType<typeof prepareSqlParameters>["typedValues"][string]["value"]>,
    ) => unknown;

    const prepared = prepareSqlParameters({
      amount: {
        type: { kind: "decimal", precision: 10, scale: 2 },
        value: "-12.34",
      },
      timestamp: {
        type: { kind: "primitive", name: "Timestamp64" },
        value: "1969-12-31T23:59:59.999999Z",
      },
      bytes: { type: { kind: "primitive", name: "String" }, value: "AAEC/w==" },
      rows: {
        type: {
          kind: "list",
          item: {
            kind: "struct",
            fields: [
              { name: "id", type: { kind: "primitive", name: "Uint64" } },
              {
                name: "note",
                type: { kind: "optional", item: { kind: "primitive", name: "Utf8" } },
              },
            ],
          },
        },
        value: [{ id: "1", note: null }],
      },
      tuple: {
        type: {
          kind: "tuple",
          items: [
            { kind: "primitive", name: "Bool" },
            { kind: "primitive", name: "Int64" },
          ],
        },
        value: [true, "7"],
      },
      dict: {
        type: {
          kind: "dict",
          key: { kind: "primitive", name: "Utf8" },
          value: { kind: "primitive", name: "Uint64" },
        },
        value: [{ key: "alpha", value: "1" }],
      },
    });

    const decoded = Object.fromEntries(Object.entries(prepared.typedValues).map(
      ([name, typed]) => [
        name.slice(1),
        decodeYdbValue(typed.type!, typed.value!),
      ],
    ));
    expect(decoded).toEqual({
      amount: "-12.34",
      bytes: "AAEC/w==",
      dict: [{ key: "alpha", value: "1" }],
      rows: [{ id: "1", note: null }],
      timestamp: "1969-12-31T23:59:59.999999Z",
      tuple: [true, "7"],
    });
    expect(() => JSON.stringify(decoded)).not.toThrow();
  });

  it("decodes renderer-supported special result types", () => {
    // Production break caught: Query Service accepts these column types while
    // the value decoder used to reject them after the response was dispatched.
    const value = {} as Parameters<typeof decodeYdbValue>[1];
    const specialTypes = [
      ["voidType", null],
      ["nullType", null],
      ["emptyListType", []],
      ["emptyDictType", []],
    ] as const;

    for (const [typeCase, expected] of specialTypes) {
      const type = {
        $typeName: "Ydb.Type",
        type: { case: typeCase, value: 0 },
      } as Parameters<typeof decodeYdbValue>[0];
      expect(decodeYdbValue(type, value)).toEqual(expected);
    }
  });

  it("decodes YDB Decimal special values as JSON-safe strings", () => {
    // Production break caught: the reserved NaN and infinity encodings exceed
    // finite precision but remain valid Decimal query results.
    const type = {
      $typeName: "Ydb.Type",
      type: {
        case: "decimalType",
        value: {
          $typeName: "Ydb.DecimalType",
          precision: 10,
          scale: 2,
        },
      },
    } as Parameters<typeof decodeYdbValue>[0];
    const infinity = 10n ** 35n;
    const cases = [
      [infinity, "inf"],
      [-infinity, "-inf"],
      [infinity + 1n, "nan"],
    ] as const;

    for (const [scaled, expected] of cases) {
      const unsigned = scaled < 0 ? (1n << 128n) + scaled : scaled;
      const value = {
        $typeName: "Ydb.Value",
        value: {
          case: "low128",
          value: unsigned & ((1n << 64n) - 1n),
        },
        items: [],
        pairs: [],
        variantIndex: 0,
        high128: unsigned >> 64n,
      } as Parameters<typeof decodeYdbValue>[1];

      expect(decodeYdbValue(type, value)).toBe(expected);
    }
  });

  it("preserves JSON numbers that cannot round-trip through JavaScript Number", () => {
    // Production break caught: JSON.parse silently rounds unsafe integers and
    // long numeric lexemes before they cross the MCP JSON boundary.
    const numberWithManyTrailingZeros = `1.234567890123456789${"0".repeat(512)}`;
    const prepared = prepareSqlParameters({
      json: {
        type: { kind: "primitive", name: "Json" },
        value: null,
      },
    });
    const type = prepared.typedValues.$json.type!;
    const baseValue = prepared.typedValues.$json.value!;
    const value = {
      ...baseValue,
      value: {
        case: "textValue" as const,
        value: `{"safe":42,"unsafe":9007199254740993,"decimal":1.234567890123456789,"trailing":${numberWithManyTrailingZeros},"overflow":1e400,"label":"9007199254740993"}`,
      },
    };

    expect(decodeYdbValue(type, value)).toEqual({
      safe: 42,
      unsafe: "9007199254740993",
      decimal: "1.234567890123456789",
      trailing: numberWithManyTrailingZeros,
      overflow: "1e400",
      label: "9007199254740993",
    });
  });

  it("preserves negative-zero JSON result numbers across response serialization", () => {
    const resultText = "{\"negativeInteger\":-0,\"negativeFraction\":-0.0,\"negativeExponent\":-0e10,\"positiveInteger\":0,\"positiveFraction\":0.0}";
    const expected = {
      negativeInteger: "-0",
      negativeFraction: "-0.0",
      negativeExponent: "-0e10",
      positiveInteger: 0,
      positiveFraction: 0,
    };

    for (const name of ["Json", "JsonDocument"] as const) {
      const prepared = prepareSqlParameters({
        value: {
          type: { kind: "primitive", name },
          value: null,
        },
      });
      const baseValue = prepared.typedValues.$value.value!;
      const decoded = decodeYdbValue(
        prepared.typedValues.$value.type!,
        {
          ...baseValue,
          value: { case: "textValue", value: resultText },
        },
      );

      expect(decoded).toEqual(expected);
      expect(JSON.stringify(decoded)).toBe(JSON.stringify(expected));
    }
  });

  it("preserves signed zero in Float and Double results across response serialization", () => {
    // Production break caught: returning JavaScript -0 lets JSON-RPC serialize
    // a database negative zero as positive zero.
    for (const name of ["Float", "Double"] as const) {
      const prepared = prepareSqlParameters({
        value: {
          type: { kind: "primitive", name },
          value: 1,
        },
      });
      const typed = prepared.typedValues.$value;
      const valueCase = name === "Float" ? "floatValue" : "doubleValue";
      const negativeZero = decodeYdbValue(typed.type!, {
        ...typed.value!,
        value: { case: valueCase, value: -0 },
      });
      const positiveZero = decodeYdbValue(typed.type!, {
        ...typed.value!,
        value: { case: valueCase, value: 0 },
      });

      expect(negativeZero).toBe("-0");
      expect(JSON.stringify(negativeZero)).toBe("\"-0\"");
      expect(positiveZero).toBe(0);
      expect(Object.is(positiveZero, -0)).toBe(false);
    }
  });

  it("rejects unsafe integers recursively in JSON parameters", () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    expect(() => prepareSqlParameters({
      json: {
        type: { kind: "primitive", name: "Json" },
        value: { nested: [{ value: unsafeInteger }] },
      },
    })).toThrow(/Json values must contain only safe integers/);

    expect(() => prepareSqlParameters({
      jsonDocument: {
        type: { kind: "primitive", name: "JsonDocument" },
        value: [Number.MIN_SAFE_INTEGER - 1],
      },
    })).toThrow(/JsonDocument values must contain only safe integers/);

    expect(() => prepareSqlParameters({
      json: {
        type: { kind: "primitive", name: "Json" },
        value: { minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
      },
      double: {
        type: { kind: "primitive", name: "Double" },
        value: unsafeInteger,
      },
    })).not.toThrow();
  });

  it("rejects negative zero recursively in JSON parameters", () => {
    // Production break caught: JSON.stringify silently serializes JavaScript
    // negative zero as positive zero before the value is sent to YDB.
    expect(() => prepareSqlParameters({
      json: {
        type: { kind: "primitive", name: "Json" },
        value: { nested: [-0] },
      },
    })).toThrow(/Json values must not contain negative zero/);

    expect(() => prepareSqlParameters({
      jsonDocument: {
        type: { kind: "primitive", name: "JsonDocument" },
        value: [{ nested: -0 }],
      },
    })).toThrow(/JsonDocument values must not contain negative zero/);

    expect(() => prepareSqlParameters({
      json: {
        type: { kind: "primitive", name: "Json" },
        value: { zero: 0, nested: [0] },
      },
    })).not.toThrow();
  });

  it("rejects out-of-range primitives and non-canonical scalar encodings", () => {
    // Production break caught: protobuf constructors accept truncated/out-of-range
    // numerics and Node's base64/UUID parsing is deliberately permissive.
    const invalid = (type: SqlParameterType, value: unknown, pattern: RegExp) => {
      expect(() => prepareSqlParameters({
        parameter: { type, value } as never,
      })).toThrow(pattern);
    };

    invalid({ kind: "primitive", name: "Bool" }, "true", /Bool.*boolean/);
    invalid({ kind: "primitive", name: "Int8" }, -129, /Int8.*-128.*127/);
    invalid({ kind: "primitive", name: "Int8" }, 128, /Int8.*-128.*127/);
    invalid({ kind: "primitive", name: "Uint8" }, 256, /Uint8.*0.*255/);
    invalid({ kind: "primitive", name: "Int16" }, 32_768, /Int16/);
    invalid({ kind: "primitive", name: "Uint16" }, 65_536, /Uint16/);
    invalid({ kind: "primitive", name: "Int32" }, 2_147_483_648, /Int32/);
    invalid({ kind: "primitive", name: "Uint32" }, 4_294_967_296, /Uint32/);
    invalid(
      { kind: "primitive", name: "Int64" },
      "-9223372036854775809",
      /Int64.*-9223372036854775808.*9223372036854775807/,
    );
    invalid(
      { kind: "primitive", name: "Uint64" },
      "18446744073709551616",
      /Uint64.*0.*18446744073709551615/,
    );
    invalid({ kind: "primitive", name: "Int64" }, 1, /Int64.*string/);
    invalid({ kind: "primitive", name: "Float" }, Number.NaN, /JSON-only|Float.*finite/);
    invalid({ kind: "primitive", name: "Float" }, Number.MAX_VALUE, /Float.*binary32/);
    invalid({ kind: "primitive", name: "Double" }, Infinity, /JSON-only|Double.*finite/);
    invalid({ kind: "primitive", name: "String" }, "AAEC/w=", /canonical base64/);
    invalid({ kind: "primitive", name: "Yson" }, "***", /canonical base64/);
    invalid(
      { kind: "primitive", name: "Uuid" },
      "123E4567-E89B-12D3-A456-426614174000",
      /canonical UUID/,
    );
    invalid({ kind: "primitive", name: "DyNumber" }, "1E127", /DyNumber/);
    invalid(
      { kind: "primitive", name: "DyNumber" },
      `0.${"0".repeat(39)}1`,
      /DyNumber/,
    );
    invalid(
      { kind: "decimal", precision: 5, scale: 2 },
      "1000.00",
      /precision 5/,
    );
    invalid(
      { kind: "decimal", precision: 5, scale: 2 },
      "1.234",
      /fractional digits/,
    );
    invalid({ kind: "primitive", name: "Date" }, "2106-01-01", /Date.*between/);
    invalid({ kind: "primitive", name: "Date32" }, "+148108-01-01", /Date32.*between/);
    invalid({ kind: "primitive", name: "Timestamp" }, "2025-02-29T00:00:00Z", /calendar date/);
    invalid({ kind: "primitive", name: "Interval" }, "P50000D", /Interval.*between/);
    invalid({ kind: "primitive", name: "Interval64" }, "P1Y", /without years or months/);
    invalid(
      { kind: "primitive", name: "TzDate" },
      "2025-01-01,Mars/Olympus_Mons",
      /unknown timezone/,
    );
  });

  it("accepts each exact global parameter bound", () => {
    const primitive: SqlParameterType = { kind: "primitive", name: "Int32" };

    const exactCount = prepareSqlParameters(Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `p${index}`,
        { type: primitive, value: index },
      ]),
    ));
    expect(Object.keys(exactCount.typedValues)).toHaveLength(100);

    let exactDepth: SqlParameterType = primitive;
    for (let index = 0; index < 15; index += 1) {
      exactDepth = { kind: "optional", item: exactDepth };
    }
    expect(() => prepareSqlParameters({
      deep: { type: exactDepth, value: null },
    })).not.toThrow();

    const exactNodes = prepareSqlParameters({
      nodes: {
        type: {
          kind: "tuple",
          items: Array.from({ length: 999 }, () => primitive),
        },
        value: Array.from({ length: 999 }, () => 0),
      },
    });
    expect(exactNodes.typedValues.$nodes.value?.items).toHaveLength(999);

    const exactValueNodes = prepareSqlParameters({
      firstValues: {
        type: { kind: "list", item: primitive },
        value: Array.from({ length: 4_999 }, () => 0),
      },
      secondValues: {
        type: { kind: "list", item: primitive },
        value: Array.from({ length: 4_999 }, () => 0),
      },
    });
    expect(exactValueNodes.typedValues.$firstValues.value?.items).toHaveLength(4_999);
    expect(exactValueNodes.typedValues.$secondValues.value?.items).toHaveLength(4_999);

    const emptyPayload = {
      payload: {
        type: { kind: "primitive" as const, name: "Utf8" as const },
        value: "",
      },
    };
    const serializedOverhead = Buffer.byteLength(JSON.stringify(emptyPayload));
    const exactBytes = prepareSqlParameters({
      payload: {
        ...emptyPayload.payload,
        value: "x".repeat(MAX_SQL_PARAMETER_BYTES - serializedOverhead),
      },
    });
    expect(exactBytes.serializedBytes).toBe(MAX_SQL_PARAMETER_BYTES);
  });

  it("enforces JSON-only values, recursive shapes, and every global parameter bound", () => {
    // Production break caught: unbounded recursive descriptors/parameter payloads
    // can exhaust the MCP process, while loose shapes misalign YDB item ordering.
    const primitive: SqlParameterType = { kind: "primitive", name: "Int32" };
    expect(() => prepareSqlParameters(Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `p${index}`,
        { type: primitive, value: index },
      ]),
    ))).toThrow(/at most 100 entries/);

    let tooDeep: SqlParameterType = primitive;
    for (let index = 0; index < 16; index += 1) {
      tooDeep = { kind: "optional", item: tooDeep };
    }
    expect(() => prepareSqlParameters({
      deep: { type: tooDeep, value: null },
    })).toThrow(/depth.*at most 16/);

    expect(() => prepareSqlParameters({
      nodes: {
        type: {
          kind: "tuple",
          items: Array.from({ length: 1_000 }, () => primitive),
        },
        value: Array.from({ length: 1_000 }, () => 0),
      },
    })).toThrow(/at most 1000 nodes/);

    expect(() => prepareSqlParameters({
      firstValues: {
        type: { kind: "list", item: primitive },
        value: Array.from({ length: 5_000 }, () => 0),
      },
      secondValues: {
        type: { kind: "list", item: primitive },
        value: Array.from({ length: 5_000 }, () => 0),
      },
    })).toThrow(/value.*at most 10000 nodes/);

    expect(() => prepareSqlParameters({
      payload: {
        type: { kind: "primitive", name: "Utf8" },
        value: "x".repeat(MAX_SQL_PARAMETER_BYTES),
      },
    })).toThrow(/at most 1048576 bytes/);

    expect(() => prepareSqlParameters({
      json: {
        type: { kind: "primitive", name: "Json" },
        value: { missing: undefined },
      } as never,
    })).toThrow(/JSON-only/);
    expect(() => prepareSqlParameters({
      list: { type: { kind: "list", item: primitive }, value: {} },
    } as never)).toThrow(/List value must be an array/);
    expect(() => prepareSqlParameters({
      tuple: {
        type: { kind: "tuple", items: [primitive, primitive] },
        value: [1],
      },
    } as never)).toThrow(/exactly 2 items/);
    expect(() => prepareSqlParameters({
      struct: {
        type: {
          kind: "struct",
          fields: [
            { name: "id", type: primitive },
            { name: "id", type: primitive },
          ],
        },
        value: { id: 1 },
      },
    })).toThrow(/duplicate struct field: id/);
    expect(() => prepareSqlParameters({
      dict: {
        type: { kind: "dict", key: primitive, value: primitive },
        value: [{ key: 1, payload: 2 }],
      },
    } as never)).toThrow(/exactly key and value/);
    expect(() => prepareSqlParameters({
      "not-valid": { type: primitive, value: 1 },
    })).toThrow(/invalid SQL parameter name/);
    expect(() => prepareSqlParameters({
      decimal: {
        type: { kind: "decimal", precision: 36, scale: 0 },
        value: "1",
      },
    })).toThrow(/precision.*1 and 35/);
  });
});
