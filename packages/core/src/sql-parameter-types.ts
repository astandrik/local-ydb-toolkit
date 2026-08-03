import type { TypedValue } from "@ydbjs/api/value";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SqlPrimitiveName =
  | "Bool"
  | "Int8"
  | "Int16"
  | "Int32"
  | "Int64"
  | "Uint8"
  | "Uint16"
  | "Uint32"
  | "Uint64"
  | "Float"
  | "Double"
  | "String"
  | "Utf8"
  | "Json"
  | "JsonDocument"
  | "Yson"
  | "Uuid"
  | "Date"
  | "Datetime"
  | "Timestamp"
  | "Interval"
  | "TzDate"
  | "TzDatetime"
  | "TzTimestamp"
  | "Date32"
  | "Datetime64"
  | "Timestamp64"
  | "Interval64"
  | "DyNumber";

export interface SqlPrimitiveType {
  kind: "primitive";
  name: SqlPrimitiveName;
}

export interface SqlDecimalType {
  kind: "decimal";
  precision: number;
  scale: number;
}

export interface SqlOptionalType {
  kind: "optional";
  item: SqlParameterType;
}

export interface SqlListType {
  kind: "list";
  item: SqlParameterType;
}

export interface SqlTupleType {
  kind: "tuple";
  items: SqlParameterType[];
}

export interface SqlStructField {
  name: string;
  type: SqlParameterType;
}

export interface SqlStructType {
  kind: "struct";
  fields: SqlStructField[];
}

export interface SqlDictType {
  kind: "dict";
  key: SqlParameterType;
  value: SqlParameterType;
}

export type SqlParameterType =
  | SqlPrimitiveType
  | SqlDecimalType
  | SqlOptionalType
  | SqlListType
  | SqlTupleType
  | SqlStructType
  | SqlDictType;

export interface SqlParameter {
  type: SqlParameterType;
  value: JsonValue;
}

export interface PreparedSqlParameters {
  typedValues: Record<string, TypedValue>;
  parameterTypes: Record<string, string>;
  declarationPrefix: string;
  serializedBytes: number;
}
