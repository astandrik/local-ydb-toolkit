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
} from "@ydbjs/api/value";
import type {
  JsonValue,
  SqlPrimitiveName,
} from "./sql-parameter-types.js";
import {
  MAX_DATE32_DAYS,
  MAX_DATE_DAYS,
  MAX_DATETIME64_SECONDS,
  MAX_INTERVAL64_MICROS,
  MAX_TIMESTAMP64_MICROS,
  MAX_TIMESTAMP_MICROS,
  MIN_DATE32_DAYS,
  MIN_DATETIME64_SECONDS,
  MIN_TIMESTAMP64_MICROS,
  formatIsoDate,
  formatIsoDateTime,
  formatIsoInterval,
  parseIsoDate,
  parseIsoDateTime,
  parseIsoInterval,
  parseTzValue,
  parseWideIsoDate,
  parseWideIsoDateTime,
} from "./sql-temporal-codec.js";

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

export function primitiveTypeIdFor(name: SqlPrimitiveName): Type_PrimitiveTypeId {
  return PRIMITIVE_TYPE_IDS[name];
}

export function encodePrimitive(name: SqlPrimitiveName, value: JsonValue): TypedValue {
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
    case "Float": {
      const rounded = Math.fround(requireFiniteNumber(value, name));
      if (!Number.isFinite(rounded)) {
        throw new Error("Float value must fit the finite binary32 range");
      }
      encoded = primitive(type, "floatValue", rounded);
      break;
    }
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
      const days = parseWideIsoDate(value, name);
      requireRange(days, MIN_DATE32_DAYS, MAX_DATE32_DAYS, name);
      encoded = primitive(type, "int32Value", Number(days));
      break;
    }
    case "Datetime64": {
      const { seconds } = parseWideIsoDateTime(value, false, name);
      requireRange(seconds, MIN_DATETIME64_SECONDS, MAX_DATETIME64_SECONDS, name);
      encoded = primitive(type, "int64Value", seconds);
      break;
    }
    case "Timestamp64": {
      const { micros } = parseWideIsoDateTime(value, true, name);
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

export function encodeDecimal(
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

export function decodePrimitive(
  typeId: Type_PrimitiveTypeId,
  value: Value,
): JsonValue {
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
      return parseLosslessJson(expectValueCase(value, "textValue"));
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

export function decodeDecimal(
  precision: number,
  scale: number,
  value: Value,
): string {
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

function parseLosslessJson(text: string): JsonValue {
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let cursor = 0;
  let transformed = "";
  while (cursor < text.length) {
    if (text[cursor] === "\"") {
      const stringStart = cursor;
      cursor += 1;
      while (cursor < text.length) {
        if (text[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (text[cursor] === "\"") {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      transformed += text.slice(stringStart, cursor);
      continue;
    }
    const character = text[cursor]!;
    if (character === "-" || (character >= "0" && character <= "9")) {
      numberPattern.lastIndex = cursor;
      const match = numberPattern.exec(text);
      if (match) {
        const token = match[0];
        transformed += jsonNumberRoundTrips(token)
          ? token
          : JSON.stringify(token);
        cursor = numberPattern.lastIndex;
        continue;
      }
    }
    transformed += character;
    cursor += 1;
  }
  return JSON.parse(transformed) as JsonValue;
}

function jsonNumberRoundTrips(token: string): boolean {
  const numeric = Number(token);
  if (!Number.isFinite(numeric)) {
    return false;
  }
  const original = canonicalDecimal(token);
  if (numeric === 0 && original?.digits === "0") {
    return true;
  }
  const roundTripped = canonicalDecimal(String(numeric));
  return original !== undefined
    && roundTripped !== undefined
    && original.negative === roundTripped.negative
    && original.digits === roundTripped.digits
    && original.exponent === roundTripped.exponent;
}

function canonicalDecimal(text: string): {
  negative: boolean;
  digits: string;
  exponent: number;
} | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) {
    return undefined;
  }
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (digits.length === 0) {
    return { negative: false, digits: "0", exponent: 0 };
  }
  let exponent = Number(match[4] ?? "0") - fraction.length;
  let trailingZeroStart = digits.length;
  while (trailingZeroStart > 0 && digits[trailingZeroStart - 1] === "0") {
    trailingZeroStart -= 1;
  }
  const trailingZeros = digits.length - trailingZeroStart;
  if (trailingZeros > 0) {
    digits = digits.slice(0, trailingZeroStart);
    exponent += trailingZeros;
  }
  return {
    negative: match[1] === "-",
    digits,
    exponent,
  };
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
          nonZeroAfterDot += trailingZeros;
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

function typedValue(type: Type, value: Value): TypedValue {
  return { $typeName: "Ydb.TypedValue", type, value };
}

function ydbType(type: Type["type"]): Type {
  return { $typeName: "Ydb.Type", type };
}
