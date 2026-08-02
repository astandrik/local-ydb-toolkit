import type {
  Type,
  TypedValue,
  Value,
  ValuePair,
} from "@ydbjs/api/value";
import type {
  JsonValue,
  SqlParameter,
  SqlParameterType,
} from "./sql-parameter-types.js";
import {
  decodeDecimal,
  decodePrimitive,
  encodeDecimal,
  encodePrimitive,
  primitiveTypeIdFor,
} from "./sql-scalar-codec.js";

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
      return Object.fromEntries(type.type.value.members.map((member, index) => [
        member.name,
        decodeYdbValue(
          requireType(member.type, `Struct field ${member.name}`),
          value.items[index],
        ),
      ]));
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
      return ydbType({ case: "typeId", value: primitiveTypeIdFor(type.name) });
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

function requireType(type: Type | undefined, label: string): Type {
  if (!type) throw new Error(`${label} type is missing`);
  return type;
}

function requireValue(value: Value | undefined, label: string): Value {
  if (!value) throw new Error(`${label} value is missing`);
  return value;
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
