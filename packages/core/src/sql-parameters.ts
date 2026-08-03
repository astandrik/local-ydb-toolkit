import type { Type, TypedValue, Value } from "@ydbjs/api/value";
import type {
  JsonValue,
  PreparedSqlParameters,
  SqlParameter,
  SqlParameterType,
  SqlPrimitiveName,
} from "./sql-parameter-types.js";
import {
  decodeYdbValue as decodeValue,
  encodeSqlParameterValue,
} from "./sql-value-codec.js";

export const MAX_SQL_PARAMETERS = 100;
export const MAX_SQL_PARAMETER_DEPTH = 16;
export const MAX_SQL_PARAMETER_NODES = 1_000;
export const MAX_SQL_PARAMETER_VALUE_NODES = 10_000;
export const MAX_SQL_PARAMETER_BYTES = 1_048_576;

const PRIMITIVE_NAMES = new Set<SqlPrimitiveName>([
  "Bool",
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "Uint8",
  "Uint16",
  "Uint32",
  "Uint64",
  "Float",
  "Double",
  "String",
  "Utf8",
  "Json",
  "JsonDocument",
  "Yson",
  "Uuid",
  "Date",
  "Datetime",
  "Timestamp",
  "Interval",
  "TzDate",
  "TzDatetime",
  "TzTimestamp",
  "Date32",
  "Datetime64",
  "Timestamp64",
  "Interval64",
  "DyNumber",
]);

export function renderYqlType(type: SqlParameterType): string {
  switch (type.kind) {
    case "primitive":
      if (!PRIMITIVE_NAMES.has(type.name)) {
        throw new Error(`Unsupported YDB primitive type: ${String(type.name)}`);
      }
      return type.name;
    case "decimal":
      validateDecimalType(type.precision, type.scale);
      return `Decimal(${type.precision}, ${type.scale})`;
    case "optional":
      return `Optional<${renderYqlType(type.item)}>`;
    case "list":
      return `List<${renderYqlType(type.item)}>`;
    case "tuple":
      if (!Array.isArray(type.items)) {
        throw new Error("tuple items must be an array");
      }
      return `Tuple<${type.items.map(renderYqlType).join(", ")}>`;
    case "struct": {
      if (!Array.isArray(type.fields)) {
        throw new Error("struct fields must be an array");
      }
      const seen = new Set<string>();
      return `Struct<${type.fields.map((field) => {
        if (typeof field.name !== "string" || field.name.length === 0) {
          throw new Error("struct field names must be non-empty strings");
        }
        if (seen.has(field.name)) {
          throw new Error(`duplicate struct field: ${field.name}`);
        }
        seen.add(field.name);
        return `${quoteIdentifier(field.name)}:${renderYqlType(field.type)}`;
      }).join(", ")}>`;
    }
    case "dict":
      return `Dict<${renderYqlType(type.key)}, ${renderYqlType(type.value)}>`;
    default:
      throw new Error("Unsupported YDB parameter descriptor");
  }
}

export function prepareSqlParameters(
  parameters: Record<string, SqlParameter>,
): PreparedSqlParameters {
  if (!isPlainObject(parameters)) {
    throw new Error("parameters must be a JSON object");
  }
  const serialized = serializeJsonParameters(parameters);
  const serializedBytes = Buffer.byteLength(serialized);
  if (serializedBytes > MAX_SQL_PARAMETER_BYTES) {
    throw new Error(`serialized parameters must be at most ${MAX_SQL_PARAMETER_BYTES} bytes`);
  }

  const names = Object.keys(parameters).sort();
  if (names.length > MAX_SQL_PARAMETERS) {
    throw new Error(`parameters must contain at most ${MAX_SQL_PARAMETERS} entries`);
  }

  const descriptorBudget = { nodes: 0 };
  const valueBudget = { nodes: 0 };
  const parameterTypeEntries: Array<[string, string]> = [];
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid SQL parameter name: ${name}`);
    }
    const parameter = parameters[name];
    if (!isPlainObject(parameter) || !("type" in parameter) || !("value" in parameter)) {
      throw new Error(`parameter ${name} must contain type and value`);
    }
    validateDescriptor(parameter.type, 1, descriptorBudget);
    countParameterValueNodes(parameter.value, valueBudget);
    parameterTypeEntries.push([name, renderYqlType(parameter.type)]);
  }

  const typedValues: Record<string, TypedValue> = {};
  for (const name of names) {
    const parameter = parameters[name]!;
    typedValues[`$${name}`] = encodeSqlParameterValue(parameter);
  }
  const parameterTypes = Object.fromEntries(parameterTypeEntries);

  return {
    typedValues,
    parameterTypes,
    declarationPrefix: names
      .map((name) => `DECLARE $${name} AS ${parameterTypes[name]};`)
      .join("\n") + (names.length === 0 ? "" : "\n"),
    serializedBytes,
  };
}

function countParameterValueNodes(
  value: JsonValue,
  budget: { nodes: number },
): void {
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    budget.nodes += 1;
    if (budget.nodes > MAX_SQL_PARAMETER_VALUE_NODES) {
      throw new Error(
        `SQL parameter values must contain at most ${MAX_SQL_PARAMETER_VALUE_NODES} nodes`,
      );
    }
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push(current[index]!);
      }
    } else if (current !== null && typeof current === "object") {
      const values = Object.values(current);
      for (let index = values.length - 1; index >= 0; index -= 1) {
        pending.push(values[index]!);
      }
    }
  }
}

export function decodeYdbValue(type: Type, value: Value): JsonValue {
  return decodeValue(type, value);
}

function validateDescriptor(
  type: SqlParameterType,
  depth: number,
  budget: { nodes: number },
): void {
  if (!isPlainObject(type) || typeof type.kind !== "string") {
    throw new Error("SQL parameter type must be a descriptor object");
  }
  if (depth > MAX_SQL_PARAMETER_DEPTH) {
    throw new Error(`SQL parameter descriptor depth must be at most ${MAX_SQL_PARAMETER_DEPTH}`);
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_SQL_PARAMETER_NODES) {
    throw new Error(`SQL parameter descriptors must contain at most ${MAX_SQL_PARAMETER_NODES} nodes`);
  }

  switch (type.kind) {
    case "primitive":
      if (!PRIMITIVE_NAMES.has(type.name)) {
        throw new Error(`Unsupported YDB primitive type: ${String(type.name)}`);
      }
      return;
    case "decimal":
      validateDecimalType(type.precision, type.scale);
      return;
    case "optional":
    case "list":
      validateDescriptor(type.item, depth + 1, budget);
      return;
    case "tuple":
      if (!Array.isArray(type.items)) {
        throw new Error("tuple items must be an array");
      }
      type.items.forEach((item) => validateDescriptor(item, depth + 1, budget));
      return;
    case "struct": {
      if (!Array.isArray(type.fields)) {
        throw new Error("struct fields must be an array");
      }
      const seen = new Set<string>();
      for (const field of type.fields) {
        if (!isPlainObject(field) || typeof field.name !== "string" || field.name.length === 0) {
          throw new Error("struct field names must be non-empty strings");
        }
        if (seen.has(field.name)) {
          throw new Error(`duplicate struct field: ${field.name}`);
        }
        seen.add(field.name);
        validateDescriptor(field.type, depth + 1, budget);
      }
      return;
    }
    case "dict":
      validateDescriptor(type.key, depth + 1, budget);
      validateDescriptor(type.value, depth + 1, budget);
      return;
    default:
      throw new Error(
        `Unsupported YDB parameter descriptor kind: ${String(
          (type as { kind?: unknown }).kind,
        )}`,
      );
  }
}

function serializeJsonParameters(parameters: Record<string, SqlParameter>): string {
  try {
    validateJsonOnly(parameters, "parameters", new Set());
    const serialized = JSON.stringify(parameters);
    if (serialized === undefined) {
      throw new Error("not JSON serializable");
    }
    return serialized;
  } catch (error) {
    throw new Error(
      `parameters must contain JSON-only values: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateJsonOnly(value: unknown, path: string, seen: Set<object>): void {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must contain finite JSON numbers`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} contains a non-JSON value`);
  }
  if (seen.has(value)) {
    throw new Error(`${path} contains a cycle`);
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new Error(`${path} contains a non-JSON object`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonOnly(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      validateJsonOnly(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function validateDecimalType(precision: number, scale: number): void {
  if (!Number.isInteger(precision) || precision < 1 || precision > 35) {
    throw new Error("Decimal precision must be an integer between 1 and 35");
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
    throw new Error("Decimal scale must be an integer between 0 and precision");
  }
}

function quoteIdentifier(identifier: string): string {
  return `\`${identifier
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}\``;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
