import {
  Primitive,
  PrimitiveType,
  Uuid,
} from "@ydbjs/value/primitive";
import {
  Type_PrimitiveTypeId,
  type Type,
  type TypedValue,
  type Value,
  type ValuePair,
} from "@ydbjs/api/value";
import type {
  JsonValue,
  SqlParameter,
  SqlParameterType,
  SqlPrimitiveName,
} from "./sql-parameter-types.js";

const MAX_DATE_DAYS = 49_673n;
const MAX_TIMESTAMP_MICROS = 4_291_747_200_000_000n;
const MIN_DATE32_DAYS = -53_375_809n;
const MAX_DATE32_DAYS = 53_375_807n;
const MIN_DATETIME64_SECONDS = -4_611_669_897_600n;
const MAX_DATETIME64_SECONDS = 4_611_669_811_199n;
const MIN_TIMESTAMP64_MICROS = -4_611_669_897_600_000_000n;
const MAX_TIMESTAMP64_MICROS = 4_611_669_811_199_999_999n;
const MAX_INTERVAL64_MICROS = 9_223_339_708_799_999_999n;

const PRIMITIVE_TYPE_IDS: Record<SqlPrimitiveName, Type_PrimitiveTypeId> = {
  Bool: Type_PrimitiveTypeId.BOOL,
  Int8: Type_PrimitiveTypeId.INT8,
  Int16: Type_PrimitiveTypeId.INT16,
  Int32: Type_PrimitiveTypeId.INT32,
  Int64: Type_PrimitiveTypeId.INT64,
  Uint8: Type_PrimitiveTypeId.UINT8,
  Uint16: Type_PrimitiveTypeId.UINT16,
  Uint32: Type_PrimitiveTypeId.UINT32,
  Uint64: Type_PrimitiveTypeId.UINT64,
  Float: Type_PrimitiveTypeId.FLOAT,
  Double: Type_PrimitiveTypeId.DOUBLE,
  String: Type_PrimitiveTypeId.STRING,
  Utf8: Type_PrimitiveTypeId.UTF8,
  Json: Type_PrimitiveTypeId.JSON,
  JsonDocument: Type_PrimitiveTypeId.JSON_DOCUMENT,
  Yson: Type_PrimitiveTypeId.YSON,
  Uuid: Type_PrimitiveTypeId.UUID,
  Date: Type_PrimitiveTypeId.DATE,
  Datetime: Type_PrimitiveTypeId.DATETIME,
  Timestamp: Type_PrimitiveTypeId.TIMESTAMP,
  Interval: Type_PrimitiveTypeId.INTERVAL,
  TzDate: Type_PrimitiveTypeId.TZ_DATE,
  TzDatetime: Type_PrimitiveTypeId.TZ_DATETIME,
  TzTimestamp: Type_PrimitiveTypeId.TZ_TIMESTAMP,
  Date32: Type_PrimitiveTypeId.DATE32,
  Datetime64: Type_PrimitiveTypeId.DATETIME64,
  Timestamp64: Type_PrimitiveTypeId.TIMESTAMP64,
  Interval64: Type_PrimitiveTypeId.INTERVAL64,
  DyNumber: Type_PrimitiveTypeId.DYNUMBER,
};

export function encodeSqlParameterValue(parameter: SqlParameter): TypedValue {
  const encoded = encodeValue(parameter.type, parameter.value);
  return typedValue(encoded.type, encoded.value);
}

export function decodeYdbValue(type: Type, value: Value): JsonValue {
  switch (type.type.case) {
    case "typeId":
      return decodePrimitive(type.type.value, value);
    case "decimalType":
      return decodeDecimal(type.type.value.precision, type.type.value.scale, value);
    case "optionalType": {
      if (!type.type.value.item) {
        throw new Error("YDB Optional type is missing its item type");
      }
      if (value.value.case === "nullFlagValue") {
        return null;
      }
      if (value.value.case === "nestedValue") {
        return decodeYdbValue(type.type.value.item, value.value.value);
      }
      return decodeYdbValue(type.type.value.item, value);
    }
    case "listType": {
      const itemType = type.type.value.item;
      if (!itemType) {
        throw new Error("YDB List type is missing its item type");
      }
      return value.items.map((item) => decodeYdbValue(itemType, item));
    }
    case "tupleType": {
      const elements = type.type.value.elements;
      if (value.items.length !== elements.length) {
        throw new Error("YDB Tuple value length does not match its type");
      }
      return value.items.map((item, index) => decodeYdbValue(
        requireType(elements[index], "Tuple item"),
        item,
      ));
    }
    case "structType": {
      if (value.items.length !== type.type.value.members.length) {
        throw new Error("YDB Struct value length does not match its type");
      }
      const decoded: Record<string, JsonValue> = {};
      type.type.value.members.forEach((member, index) => {
        decoded[member.name] = decodeYdbValue(
          requireType(member.type, `Struct field ${member.name}`),
          value.items[index],
        );
      });
      return decoded;
    }
    case "dictType": {
      const keyType = requireType(type.type.value.key, "Dict key");
      const valueType = requireType(type.type.value.payload, "Dict value");
      return value.pairs.map((pair) => ({
        key: decodeYdbValue(keyType, requireValue(pair.key, "Dict key")),
        value: decodeYdbValue(valueType, requireValue(pair.payload, "Dict value")),
      }));
    }
    default:
      throw new Error(`Unsupported YDB result type: ${String(type.type.case)}`);
  }
}

function encodeValue(
  type: SqlParameterType,
  value: JsonValue,
): { type: Type; value: Value } {
  if (type.kind === "decimal") {
    const typed = encodeDecimal(type.precision, type.scale, value);
    return { type: typed.type!, value: typed.value! };
  }
  if (type.kind === "primitive") {
    const typed = encodePrimitive(type.name, value);
    return { type: typed.type!, value: typed.value! };
  }
  switch (type.kind) {
    case "optional": {
      const optionalType = ydbType({
        case: "optionalType",
        value: { $typeName: "Ydb.OptionalType", item: encodeType(type.item) },
      });
      return value === null
        ? { type: optionalType, value: nullValue() }
        : { type: optionalType, value: encodeValue(type.item, value).value };
    }
    case "list":
      if (!Array.isArray(value)) {
        throw new Error("List value must be an array");
      }
      return {
        type: ydbType({
          case: "listType",
          value: { $typeName: "Ydb.ListType", item: encodeType(type.item) },
        }),
        value: collectionValue(value.map((item) => encodeValue(type.item, item).value)),
      };
    case "tuple":
      if (!Array.isArray(value) || value.length !== type.items.length) {
        throw new Error(`Tuple value must contain exactly ${type.items.length} items`);
      }
      return {
        type: ydbType({
          case: "tupleType",
          value: {
            $typeName: "Ydb.TupleType",
            elements: type.items.map(encodeType),
          },
        }),
        value: collectionValue(type.items.map(
          (itemType, index) => encodeValue(itemType, value[index]).value,
        )),
      };
    case "struct": {
      if (!isPlainObject(value)) {
        throw new Error("Struct value must be an object");
      }
      const expectedNames = type.fields.map((field) => field.name);
      const actualNames = Object.keys(value);
      const missing = expectedNames.filter((name) => !Object.hasOwn(value, name));
      const extra = actualNames.filter((name) => !expectedNames.includes(name));
      if (missing.length > 0 || extra.length > 0) {
        throw new Error(
          "Struct value fields do not match descriptor"
          + `${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}`
          + `${extra.length > 0 ? `; extra: ${extra.join(", ")}` : ""}`,
        );
      }
      return {
        type: ydbType({
          case: "structType",
          value: {
            $typeName: "Ydb.StructType",
            members: type.fields.map((field) => ({
              $typeName: "Ydb.StructMember",
              name: field.name,
              type: encodeType(field.type),
            })),
          },
        }),
        value: collectionValue(type.fields.map(
          (field) => encodeValue(field.type, value[field.name] as JsonValue).value,
        )),
      };
    }
    case "dict": {
      if (!Array.isArray(value)) {
        throw new Error("Dict value must be an array of {key,value} entries");
      }
      const pairs: ValuePair[] = value.map((entry) => {
        if (
          !isPlainObject(entry)
          || !Object.hasOwn(entry, "key")
          || !Object.hasOwn(entry, "value")
          || Object.keys(entry).some((key) => key !== "key" && key !== "value")
        ) {
          throw new Error("Dict entries must contain exactly key and value");
        }
        return {
          $typeName: "Ydb.ValuePair",
          key: encodeValue(type.key, entry.key as JsonValue).value,
          payload: encodeValue(type.value, entry.value as JsonValue).value,
        };
      });
      return {
        type: ydbType({
          case: "dictType",
          value: {
            $typeName: "Ydb.DictType",
            key: encodeType(type.key),
            payload: encodeType(type.value),
          },
        }),
        value: collectionValue([], pairs),
      };
    }
  }
}

function encodeType(type: SqlParameterType): Type {
  switch (type.kind) {
    case "primitive":
      return new PrimitiveType(PRIMITIVE_TYPE_IDS[type.name]).encode();
    case "decimal":
      return ydbType({
        case: "decimalType",
        value: {
          $typeName: "Ydb.DecimalType",
          precision: type.precision,
          scale: type.scale,
        },
      });
    case "optional":
      return ydbType({
        case: "optionalType",
        value: { $typeName: "Ydb.OptionalType", item: encodeType(type.item) },
      });
    case "list":
      return ydbType({
        case: "listType",
        value: { $typeName: "Ydb.ListType", item: encodeType(type.item) },
      });
    case "tuple":
      return ydbType({
        case: "tupleType",
        value: { $typeName: "Ydb.TupleType", elements: type.items.map(encodeType) },
      });
    case "struct":
      return ydbType({
        case: "structType",
        value: {
          $typeName: "Ydb.StructType",
          members: type.fields.map((field) => ({
            $typeName: "Ydb.StructMember",
            name: field.name,
            type: encodeType(field.type),
          })),
        },
      });
    case "dict":
      return ydbType({
        case: "dictType",
        value: {
          $typeName: "Ydb.DictType",
          key: encodeType(type.key),
          payload: encodeType(type.value),
        },
      });
  }
}

function encodePrimitive(name: SqlPrimitiveName, value: JsonValue): TypedValue {
  const type = new PrimitiveType(PRIMITIVE_TYPE_IDS[name]);
  if (name === "Uuid") {
    const uuidValue = requireString(value, name);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuidValue)) {
      throw new Error("Uuid value must be a canonical UUID");
    }
    const uuid = new Uuid(uuidValue);
    return typedValue(uuid.type.encode(), uuid.encode());
  }

  let encoded: Primitive;
  switch (name) {
    case "Bool":
      if (typeof value !== "boolean") {
        throw new Error("Bool value must be a boolean");
      }
      encoded = primitive(type, "boolValue", value);
      break;
    case "Int8":
      encoded = primitive(type, "int32Value", requireInteger(value, name, -128, 127));
      break;
    case "Int16":
      encoded = primitive(type, "int32Value", requireInteger(value, name, -32_768, 32_767));
      break;
    case "Int32":
      encoded = primitive(
        type,
        "int32Value",
        requireInteger(value, name, -2_147_483_648, 2_147_483_647),
      );
      break;
    case "Uint8":
      encoded = primitive(type, "uint32Value", requireInteger(value, name, 0, 255));
      break;
    case "Uint16":
      encoded = primitive(type, "uint32Value", requireInteger(value, name, 0, 65_535));
      break;
    case "Uint32":
      encoded = primitive(
        type,
        "uint32Value",
        requireInteger(value, name, 0, 4_294_967_295),
      );
      break;
    case "Int64": {
      const integer = requireIntegerString(value, name, -(1n << 63n), (1n << 63n) - 1n);
      encoded = primitive(type, "int64Value", integer);
      break;
    }
    case "Uint64": {
      const integer = requireIntegerString(value, name, 0n, (1n << 64n) - 1n);
      encoded = primitive(type, "uint64Value", integer);
      break;
    }
    case "Float":
      encoded = primitive(type, "floatValue", requireFiniteNumber(value, name));
      break;
    case "Double":
      encoded = primitive(type, "doubleValue", requireFiniteNumber(value, name));
      break;
    case "String":
    case "Yson":
      encoded = primitive(
        type,
        "bytesValue",
        decodeCanonicalBase64(value, name),
      );
      break;
    case "Utf8":
      encoded = primitive(type, "textValue", requireString(value, name));
      break;
    case "Json":
    case "JsonDocument":
      encoded = primitive(type, "textValue", JSON.stringify(value));
      break;
    case "DyNumber":
      encoded = primitive(type, "textValue", requireDyNumber(value));
      break;
    case "Date": {
      const days = parseIsoDate(value, name);
      requireRange(days, 0n, MAX_DATE_DAYS - 1n, name);
      encoded = primitive(type, "uint32Value", Number(days));
      break;
    }
    case "Datetime": {
      const { seconds } = parseIsoDateTime(value, false, name);
      requireRange(seconds, 0n, MAX_TIMESTAMP_MICROS / 1_000_000n - 1n, name);
      encoded = primitive(type, "uint32Value", Number(seconds));
      break;
    }
    case "Timestamp": {
      const { micros } = parseIsoDateTime(value, true, name);
      requireRange(micros, 0n, MAX_TIMESTAMP_MICROS - 1n, name);
      encoded = primitive(type, "uint64Value", micros);
      break;
    }
    case "Interval": {
      const micros = parseIsoInterval(value, name);
      requireRange(
        micros,
        -MAX_TIMESTAMP_MICROS + 1n,
        MAX_TIMESTAMP_MICROS - 1n,
        name,
      );
      encoded = primitive(type, "int64Value", micros);
      break;
    }
    case "TzDate":
      encoded = primitive(type, "textValue", parseTzValue(value, "date", name));
      break;
    case "TzDatetime":
      encoded = primitive(type, "textValue", parseTzValue(value, "datetime", name));
      break;
    case "TzTimestamp":
      encoded = primitive(type, "textValue", parseTzValue(value, "timestamp", name));
      break;
    case "Date32": {
      const days = parseIsoDate(value, name);
      requireRange(days, MIN_DATE32_DAYS, MAX_DATE32_DAYS, name);
      encoded = primitive(type, "int32Value", Number(days));
      break;
    }
    case "Datetime64": {
      const { seconds } = parseIsoDateTime(value, false, name);
      requireRange(seconds, MIN_DATETIME64_SECONDS, MAX_DATETIME64_SECONDS, name);
      encoded = primitive(type, "int64Value", seconds);
      break;
    }
    case "Timestamp64": {
      const { micros } = parseIsoDateTime(value, true, name);
      requireRange(micros, MIN_TIMESTAMP64_MICROS, MAX_TIMESTAMP64_MICROS, name);
      encoded = primitive(type, "int64Value", micros);
      break;
    }
    case "Interval64": {
      const micros = parseIsoInterval(value, name);
      requireRange(micros, -MAX_INTERVAL64_MICROS, MAX_INTERVAL64_MICROS, name);
      encoded = primitive(type, "int64Value", micros);
      break;
    }
  }
  return typedValue(type.encode(), encoded.encode());
}

function primitive(
  type: PrimitiveType,
  caseName: "boolValue",
  value: boolean,
): Primitive;
function primitive(
  type: PrimitiveType,
  caseName: "int32Value" | "uint32Value" | "floatValue" | "doubleValue",
  value: number,
): Primitive;
function primitive(
  type: PrimitiveType,
  caseName: "int64Value" | "uint64Value",
  value: bigint,
): Primitive;
function primitive(
  type: PrimitiveType,
  caseName: "bytesValue",
  value: Uint8Array,
): Primitive;
function primitive(
  type: PrimitiveType,
  caseName: "textValue",
  value: string,
): Primitive;
function primitive(
  type: PrimitiveType,
  caseName: string,
  value: boolean | number | bigint | Uint8Array | string,
): Primitive {
  return new Primitive({
    value: { case: caseName, value } as never,
  }, type);
}

function encodeDecimal(
  precision: number,
  scale: number,
  value: JsonValue,
): TypedValue {
  if (typeof value !== "string") {
    throw new Error("Decimal value must be a string");
  }
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new Error("Decimal value must use canonical base-10 notation");
  }
  const fraction = match[3] ?? "";
  if (fraction.length > scale) {
    throw new Error(`Decimal value has more than ${scale} fractional digits`);
  }
  const magnitude = BigInt(match[2]) * 10n ** BigInt(scale)
    + BigInt(fraction.padEnd(scale, "0") || "0");
  if (magnitude > 10n ** BigInt(precision) - 1n) {
    throw new Error(`Decimal value exceeds precision ${precision}`);
  }
  const scaled = match[1] === "-" ? -magnitude : magnitude;
  const unsigned = scaled < 0 ? (1n << 128n) + scaled : scaled;
  const low128 = unsigned & ((1n << 64n) - 1n);
  const high128 = unsigned >> 64n;
  const transportType = new PrimitiveType(Type_PrimitiveTypeId.UUID);
  const encoded = new Primitive({
    value: { case: "low128", value: low128 },
    high128,
  }, transportType);
  return typedValue(ydbType({
    case: "decimalType",
    value: { $typeName: "Ydb.DecimalType", precision, scale },
  }), encoded.encode());
}

function decodePrimitive(typeId: Type_PrimitiveTypeId, value: Value): JsonValue {
  switch (typeId) {
    case Type_PrimitiveTypeId.BOOL:
      return expectValueCase(value, "boolValue");
    case Type_PrimitiveTypeId.INT8:
    case Type_PrimitiveTypeId.INT16:
    case Type_PrimitiveTypeId.INT32:
      return expectValueCase(value, "int32Value");
    case Type_PrimitiveTypeId.UINT8:
    case Type_PrimitiveTypeId.UINT16:
    case Type_PrimitiveTypeId.UINT32:
      return expectValueCase(value, "uint32Value");
    case Type_PrimitiveTypeId.INT64:
      return expectValueCase(value, "int64Value").toString();
    case Type_PrimitiveTypeId.UINT64:
      return expectValueCase(value, "uint64Value").toString();
    case Type_PrimitiveTypeId.FLOAT:
      return jsonSafeNumber(expectValueCase(value, "floatValue"));
    case Type_PrimitiveTypeId.DOUBLE:
      return jsonSafeNumber(expectValueCase(value, "doubleValue"));
    case Type_PrimitiveTypeId.STRING:
    case Type_PrimitiveTypeId.YSON:
      return Buffer.from(expectValueCase(value, "bytesValue")).toString("base64");
    case Type_PrimitiveTypeId.UTF8:
    case Type_PrimitiveTypeId.DYNUMBER:
    case Type_PrimitiveTypeId.TZ_DATE:
    case Type_PrimitiveTypeId.TZ_DATETIME:
    case Type_PrimitiveTypeId.TZ_TIMESTAMP:
      return expectValueCase(value, "textValue");
    case Type_PrimitiveTypeId.JSON:
    case Type_PrimitiveTypeId.JSON_DOCUMENT:
      return JSON.parse(expectValueCase(value, "textValue")) as JsonValue;
    case Type_PrimitiveTypeId.UUID:
      return uuidFromBigInts(
        expectValueCase(value, "low128"),
        value.high128,
      );
    case Type_PrimitiveTypeId.DATE:
      return formatIsoDate(BigInt(expectValueCase(value, "uint32Value")));
    case Type_PrimitiveTypeId.DATETIME:
      return formatIsoDateTime(
        BigInt(expectValueCase(value, "uint32Value")) * 1_000_000n,
        false,
      );
    case Type_PrimitiveTypeId.TIMESTAMP:
      return formatIsoDateTime(expectValueCase(value, "uint64Value"), true);
    case Type_PrimitiveTypeId.INTERVAL:
      return formatIsoInterval(expectValueCase(value, "int64Value"));
    case Type_PrimitiveTypeId.DATE32:
      return formatIsoDate(BigInt(expectValueCase(value, "int32Value")));
    case Type_PrimitiveTypeId.DATETIME64:
      return formatIsoDateTime(
        expectValueCase(value, "int64Value") * 1_000_000n,
        false,
      );
    case Type_PrimitiveTypeId.TIMESTAMP64:
      return formatIsoDateTime(expectValueCase(value, "int64Value"), true);
    case Type_PrimitiveTypeId.INTERVAL64:
      return formatIsoInterval(expectValueCase(value, "int64Value"));
    default:
      throw new Error(`Unsupported YDB primitive type id: ${typeId}`);
  }
}

function decodeDecimal(precision: number, scale: number, value: Value): string {
  const low = expectValueCase(value, "low128");
  const unsigned = (value.high128 << 64n) | low;
  const scaled = value.high128 >= 1n << 63n
    ? unsigned - (1n << 128n)
    : unsigned;
  const negative = scaled < 0;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const rendered = scale === 0
    ? digits
    : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const result = negative ? `-${rendered}` : rendered;
  if ((negative ? -scaled : scaled) > 10n ** BigInt(precision) - 1n) {
    throw new Error("YDB Decimal value exceeds its declared precision");
  }
  return result;
}

function parseIsoDate(value: JsonValue, label: string): bigint {
  if (typeof value !== "string") {
    throw new Error(`${label} value must be an ISO date string`);
  }
  const match = /^([+-]?\d{4,6})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`${label} value must use YYYY-MM-DD`);
  }
  const year = BigInt(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`${label} value is not a valid calendar date`);
  }
  return civilToDays(year, month, day);
}

function parseIsoDateTime(
  value: JsonValue,
  fractional: boolean,
  label: string,
): { seconds: bigint; micros: bigint } {
  if (typeof value !== "string") {
    throw new Error(`${label} value must be an ISO UTC date-time string`);
  }
  const match = /^([+-]?\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/
    .exec(value);
  if (!match || (!fractional && match[7] !== undefined)) {
    throw new Error(`${label} value must be an ISO UTC date-time string`);
  }
  const days = parseIsoDate(`${match[1]}-${match[2]}-${match[3]}`, label);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`${label} value is not a valid clock time`);
  }
  const seconds = days * 86_400n + BigInt(hour * 3_600 + minute * 60 + second);
  const subsecond = BigInt((match[7] ?? "").padEnd(6, "0") || "0");
  return { seconds, micros: seconds * 1_000_000n + subsecond };
}

function parseIsoInterval(value: JsonValue, label: string): bigint {
  if (typeof value !== "string") {
    throw new Error(`${label} value must be an ISO 8601 interval string`);
  }
  const match = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,6}))?S)?)?$/
    .exec(value);
  if (!match || match.slice(2).every((part) => part === undefined)) {
    throw new Error(`${label} value must be an ISO 8601 interval without years or months`);
  }
  const seconds = BigInt(match[2] ?? 0) * 7n * 86_400n
    + BigInt(match[3] ?? 0) * 86_400n
    + BigInt(match[4] ?? 0) * 3_600n
    + BigInt(match[5] ?? 0) * 60n
    + BigInt(match[6] ?? 0);
  const fraction = BigInt((match[7] ?? "").padEnd(6, "0") || "0");
  const micros = seconds * 1_000_000n + fraction;
  return match[1] ? -micros : micros;
}

function parseTzValue(
  value: JsonValue,
  kind: "date" | "datetime" | "timestamp",
  label: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} value must be a timezone-qualified string`);
  }
  const comma = value.lastIndexOf(",");
  if (comma <= 0 || comma === value.length - 1) {
    throw new Error(`${label} value must end with an IANA timezone name`);
  }
  const dateTime = value.slice(0, comma);
  const timeZone = value.slice(comma + 1);
  let canonicalTimeZone: string;
  try {
    canonicalTimeZone = new Intl.DateTimeFormat("en-US", { timeZone })
      .resolvedOptions().timeZone;
  } catch {
    throw new Error(`${label} value has an unknown timezone: ${timeZone}`);
  }
  if (canonicalTimeZone !== timeZone) {
    throw new Error(`${label} timezone must be canonical: ${canonicalTimeZone}`);
  }
  if (kind === "date") {
    requireRange(parseIsoDate(dateTime, label), 0n, MAX_DATE_DAYS - 1n, label);
  } else {
    const parsed = parseIsoDateTime(`${dateTime}Z`, kind === "timestamp", label);
    requireRange(parsed.micros, 0n, MAX_TIMESTAMP_MICROS - 1n, label);
  }
  return value;
}

function formatIsoDate(days: bigint): string {
  const { year, month, day } = daysToCivil(days);
  return `${formatYear(year)}-${pad2(month)}-${pad2(day)}`;
}

function formatIsoDateTime(micros: bigint, fractional: boolean): string {
  const seconds = floorDiv(micros, 1_000_000n);
  const subsecond = micros - seconds * 1_000_000n;
  const days = floorDiv(seconds, 86_400n);
  const secondOfDay = seconds - days * 86_400n;
  const hour = Number(secondOfDay / 3_600n);
  const minute = Number(secondOfDay % 3_600n / 60n);
  const second = Number(secondOfDay % 60n);
  const suffix = fractional ? `.${subsecond.toString().padStart(6, "0")}` : "";
  return `${formatIsoDate(days)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}${suffix}Z`;
}

function formatIsoInterval(microsValue: bigint): string {
  const negative = microsValue < 0n;
  let micros = negative ? -microsValue : microsValue;
  const days = micros / 86_400_000_000n;
  micros %= 86_400_000_000n;
  const hours = micros / 3_600_000_000n;
  micros %= 3_600_000_000n;
  const minutes = micros / 60_000_000n;
  micros %= 60_000_000n;
  const seconds = micros / 1_000_000n;
  const fraction = micros % 1_000_000n;
  let result = "P";
  if (days > 0n) {
    result += `${days}D`;
  }
  if (hours > 0n || minutes > 0n || seconds > 0n || fraction > 0n || days === 0n) {
    result += "T";
    if (hours > 0n) result += `${hours}H`;
    if (minutes > 0n) result += `${minutes}M`;
    const fractionText = fraction === 0n
      ? ""
      : `.${fraction.toString().padStart(6, "0").replace(/0+$/, "")}`;
    result += `${seconds}${fractionText}S`;
  }
  return negative && microsValue !== 0n ? `-${result}` : result;
}

function civilToDays(yearValue: bigint, month: number, day: number): bigint {
  let year = yearValue;
  if (month <= 2) year -= 1n;
  const era = floorDiv(year, 400n);
  const yearOfEra = year - era * 400n;
  const adjustedMonth = BigInt(month + (month > 2 ? -3 : 9));
  const dayOfYear = (153n * adjustedMonth + 2n) / 5n + BigInt(day - 1);
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n
    - yearOfEra / 100n + dayOfYear;
  return era * 146_097n + dayOfEra - 719_468n;
}

function daysToCivil(days: bigint): { year: bigint; month: number; day: number } {
  const z = days + 719_468n;
  const era = floorDiv(z, 146_097n);
  const dayOfEra = z - era * 146_097n;
  const yearOfEra = (
    dayOfEra - dayOfEra / 1_460n + dayOfEra / 36_524n - dayOfEra / 146_096n
  ) / 365n;
  let year = yearOfEra + era * 400n;
  const dayOfYear = dayOfEra - (
    365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n
  );
  const monthPrime = (5n * dayOfYear + 2n) / 153n;
  const day = Number(dayOfYear - (153n * monthPrime + 2n) / 5n + 1n);
  const month = Number(monthPrime + (monthPrime < 10n ? 3n : -9n));
  if (month <= 2) year += 1n;
  return { year, month, day };
}

function daysInMonth(year: bigint, month: number): number {
  if (month === 2) {
    const leap = year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function uuidFromBigInts(low128: bigint, high128: bigint): string {
  const bytes = Buffer.alloc(16);
  bytes.writeBigUInt64LE(low128, 0);
  bytes.writeBigUInt64LE(high128, 8);
  [bytes[0], bytes[3]] = [bytes[3], bytes[0]];
  [bytes[1], bytes[2]] = [bytes[2], bytes[1]];
  [bytes[4], bytes[5]] = [bytes[5], bytes[4]];
  [bytes[6], bytes[7]] = [bytes[7], bytes[6]];
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface ValueCaseMap {
  boolValue: boolean;
  int32Value: number;
  uint32Value: number;
  int64Value: bigint;
  uint64Value: bigint;
  floatValue: number;
  doubleValue: number;
  bytesValue: Uint8Array;
  textValue: string;
  nullFlagValue: number;
  nestedValue: Value;
  low128: bigint;
}

function expectValueCase<C extends keyof ValueCaseMap>(
  value: Value,
  expected: C,
): ValueCaseMap[C] {
  if (value.value.case !== expected) {
    throw new Error(`YDB value expected ${expected}, got ${String(value.value.case)}`);
  }
  return value.value.value as ValueCaseMap[C];
}

function jsonSafeNumber(value: number): JsonValue {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return value;
}

function requireInteger(
  value: JsonValue,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${label} value must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireIntegerString(
  value: JsonValue,
  label: string,
  minimum: bigint,
  maximum: bigint,
): bigint {
  if (
    typeof value !== "string"
    || !/^-?(?:0|[1-9]\d*)$/.test(value)
    || value === "-0"
  ) {
    throw new Error(`${label} value must be a canonical integer string`);
  }
  const integer = BigInt(value);
  if (integer < minimum || integer > maximum) {
    throw new Error(`${label} value must be between ${minimum} and ${maximum}`);
  }
  return integer;
}

function requireFiniteNumber(value: JsonValue, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} value must be a finite number`);
  }
  return value;
}

function requireString(value: JsonValue, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} value must be a string`);
  }
  return value;
}

function decodeCanonicalBase64(value: JsonValue, label: string): Uint8Array {
  const text = requireString(value, label);
  const decoded = Buffer.from(text, "base64");
  if (decoded.toString("base64") !== text) {
    throw new Error(`${label} value must use canonical base64`);
  }
  return Uint8Array.from(decoded);
}

function requireDyNumber(value: JsonValue): string {
  const text = requireString(value, "DyNumber");
  let cursor = 0;
  if (text[cursor] === "-" || text[cursor] === "+") cursor += 1;
  if (cursor === text.length) {
    throw new Error("DyNumber value is invalid");
  }
  let hasDot = false;
  let hasDigit = false;
  let beforeDot = 0;
  let nonZeroAfterDot = 0;
  let hasNonZeroAfterDot = false;
  let zeroAfterDot = 0;
  let trailingZeros = 0;
  let exponent = 0;
  for (; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (character === ".") {
      if (hasDot) throw new Error("DyNumber value is invalid");
      hasDot = true;
      continue;
    }
    if (character === "e" || character === "E") {
      const exponentText = text.slice(cursor + 1);
      if (!/^[+-]?\d+$/.test(exponentText)) {
        throw new Error("DyNumber value is invalid");
      }
      exponent = Number(exponentText);
      if (!Number.isInteger(exponent) || exponent < -32_768 || exponent > 32_767) {
        throw new Error("DyNumber exponent is out of range");
      }
      cursor = text.length;
      break;
    }
    if (character < "0" || character > "9") {
      throw new Error("DyNumber value is invalid");
    }
    hasDigit = true;
    const isZero = character === "0";
    if (!hasDot && isZero && beforeDot === 0) continue;
    if (!hasDot) {
      beforeDot += 1;
    } else {
      if (!isZero) hasNonZeroAfterDot = true;
      if (hasNonZeroAfterDot) {
        if (isZero) {
          trailingZeros += 1;
        } else {
          nonZeroAfterDot += trailingZeros + 1;
          trailingZeros = 0;
        }
      } else {
        zeroAfterDot += 1;
        if (beforeDot > 0) trailingZeros += 1;
      }
    }
  }
  if (!hasDigit) throw new Error("DyNumber value is invalid");
  let effectivePower = exponent;
  if (beforeDot > 0) {
    effectivePower += beforeDot;
  } else if (hasNonZeroAfterDot) {
    effectivePower -= zeroAfterDot;
  } else {
    return text;
  }
  if (
    beforeDot + zeroAfterDot + nonZeroAfterDot > 38
    || effectivePower < -129
    || effectivePower > 126
  ) {
    throw new Error("DyNumber value is outside the supported precision or exponent range");
  }
  return text;
}

function requireType(type: Type | undefined, label: string): Type {
  if (!type) throw new Error(`${label} type is missing`);
  return type;
}

function requireValue(value: Value | undefined, label: string): Value {
  if (!value) throw new Error(`${label} value is missing`);
  return value;
}

function requireRange(
  value: bigint,
  minimum: bigint,
  maximum: bigint,
  label: string,
): void {
  if (value < minimum || value > maximum) {
    throw new Error(`${label} value must be between ${minimum} and ${maximum}`);
  }
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder < 0n ? quotient - 1n : quotient;
}

function formatYear(year: bigint): string {
  if (year >= 0n && year <= 9_999n) {
    return year.toString().padStart(4, "0");
  }
  const sign = year < 0n ? "-" : "+";
  const magnitude = year < 0n ? -year : year;
  return `${sign}${magnitude.toString().padStart(6, "0")}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function typedValue(type: Type, value: Value): TypedValue {
  return { $typeName: "Ydb.TypedValue", type, value };
}

function ydbType(type: Type["type"]): Type {
  return { $typeName: "Ydb.Type", type };
}

function collectionValue(items: Value[], pairs: ValuePair[] = []): Value {
  return {
    $typeName: "Ydb.Value",
    value: { case: undefined },
    items,
    pairs,
    variantIndex: 0,
    high128: 0n,
  };
}

function nullValue(): Value {
  return {
    ...collectionValue([]),
    value: { case: "nullFlagValue", value: 0 },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
