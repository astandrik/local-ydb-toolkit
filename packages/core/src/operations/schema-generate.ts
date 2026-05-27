import { createHash } from "node:crypto";
import { applySchema } from "./schema.js";
import type {
  AlterTableSchemaAction,
  CreateTableSchemaStatementSpec,
  GenerateSchemaOptions,
  GenerateSchemaResponse,
  GeneratedSchemaStatementKind,
  OperationPlan,
  SchemaColumnSpec,
  SchemaIndexSpec,
  SchemaReference,
  SchemaSettingValue,
  SchemaStatementSpec,
  ToolkitContext,
} from "./types.js";

const SCHEMA_REFERENCES: SchemaReference[] = [
  {
    label: "YDB CREATE TABLE syntax",
    url: "https://ydb.tech/docs/en/yql/reference/syntax/create_table/",
  },
  {
    label: "YDB ALTER TABLE syntax",
    url: "https://ydb.tech/docs/en/yql/reference/syntax/alter_table/",
  },
  {
    label: "YDB secondary index syntax",
    url: "https://ydb.tech/docs/en/yql/reference/syntax/alter_table/indexes",
  },
  {
    label: "YDB primitive data types",
    url: "https://ydb.tech/docs/en/yql/reference/types/primitive",
  },
  {
    label: "YDB lexical structure and identifiers",
    url: "https://ydb.tech/docs/en/yql/reference/syntax/lexer",
  },
  {
    label: "ydb-platform/ydb upstream repository",
    url: "https://github.com/ydb-platform/ydb",
  },
];

const SIMPLE_TYPES = new Map([
  ["bool", "Bool"],
  ["int8", "Int8"],
  ["int16", "Int16"],
  ["int32", "Int32"],
  ["int64", "Int64"],
  ["uint8", "Uint8"],
  ["uint16", "Uint16"],
  ["uint32", "Uint32"],
  ["uint64", "Uint64"],
  ["float", "Float"],
  ["double", "Double"],
  ["dynumber", "DyNumber"],
  ["string", "String"],
  ["utf8", "Utf8"],
  ["json", "Json"],
  ["jsondocument", "JsonDocument"],
  ["yson", "Yson"],
  ["uuid", "Uuid"],
  ["date", "Date"],
  ["date32", "Date32"],
  ["datetime", "Datetime"],
  ["datetime64", "Datetime64"],
  ["timestamp", "Timestamp"],
  ["timestamp64", "Timestamp64"],
  ["interval", "Interval"],
  ["interval64", "Interval64"],
]);

const NUMERIC_DEFAULT_TYPES = new Set([
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
  "DyNumber",
]);

const INTEGER_DEFAULT_TYPES = new Set([
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "Uint8",
  "Uint16",
  "Uint32",
  "Uint64",
]);

const STRING_CONSTRUCTOR_DEFAULT_TYPES = new Set([
  "Utf8",
  "Json",
  "JsonDocument",
  "Yson",
  "Uuid",
  "Date",
  "Date32",
  "Datetime",
  "Datetime64",
  "Timestamp",
  "Timestamp64",
  "Interval",
  "Interval64",
]);

const BARE_SETTING_TOKEN = Symbol("BARE_SETTING_TOKEN");

interface BareSettingToken {
  [BARE_SETTING_TOKEN]: true;
  value: string;
}

type PublicSettingValue = SchemaSettingValue | BareSettingToken;

export async function generateSchema(
  ctx: ToolkitContext,
  options: GenerateSchemaOptions,
): Promise<GenerateSchemaResponse> {
  const statements = normalizeStatements(options.statements);
  const databasePath = normalizeDatabasePath(ctx, options.databasePath);
  const rendered = statements.map(renderStatement);
  const script = rendered.map(({ sql }) => sql).join("\n\n");
  const warnings = unique(rendered.flatMap(({ warnings }) => warnings));
  const kinds = unique(rendered.map(({ kind }) => kind));
  const statementCount = rendered.reduce((count, statement) => count + statement.statementCount, 0);
  const applyRisk = generatedSchemaRisk(kinds, warnings);
  const scriptSha256 = createHash("sha256").update(script).digest("hex");
  const verification = schemaGenerationVerification(databasePath);
  const response: GenerateSchemaResponse = {
    summary: `Generated ${statementCount} YDB schema ${statementCount === 1 ? "statement" : "statements"} for ${databasePath}.`,
    databasePath,
    script,
    scriptSha256,
    statements: {
      count: statementCount,
      kinds,
    },
    references: SCHEMA_REFERENCES,
    warnings,
    applyRisk,
    verification,
  };

  if (options.validate) {
    const validation = await applySchema(ctx, {
      action: "validate",
      databasePath,
      script,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      sdkExecutor: options.sdkExecutor,
    });
    response.validation = validation.validation;
  }

  return response;
}

function normalizeStatements(statements: SchemaStatementSpec[] | undefined): SchemaStatementSpec[] {
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new Error("statements must contain at least one schema statement");
  }
  return statements;
}

function normalizeDatabasePath(ctx: ToolkitContext, databasePath: string | undefined): string {
  const path = databasePath === undefined ? ctx.profile.tenantPath : databasePath.trim();
  if (!path) {
    throw new Error("databasePath must be non-empty");
  }
  if (!path.startsWith("/")) {
    throw new Error("databasePath must be an absolute YDB database path");
  }
  const { rootDatabase } = ctx.profile;
  if (path !== rootDatabase && !path.startsWith(`${rootDatabase}/`)) {
    throw new Error(`databasePath must be ${rootDatabase} or a child path under ${rootDatabase}`);
  }
  return path;
}

function renderStatement(statement: SchemaStatementSpec): {
  kind: GeneratedSchemaStatementKind;
  sql: string;
  statementCount: number;
  warnings: string[];
} {
  switch (statement.kind) {
    case "createTable":
      return {
        kind: "CREATE TABLE",
        sql: renderCreateTable(statement),
        statementCount: 1,
        warnings: createTableWarnings(statement),
      };
    case "alterTable":
      return renderAlterTable(statement.tableName, statement.actions);
    case "dropTable":
      return {
        kind: "DROP TABLE",
        sql: `DROP TABLE ${quoteTableName(statement.tableName)};`,
        statementCount: 1,
        warnings: ["Generated DROP TABLE. Apply only after confirming table and data loss is acceptable."],
      };
    default:
      throw new Error(`Unsupported schema statement kind: ${String((statement as { kind?: unknown }).kind)}`);
  }
}

function renderCreateTable(statement: CreateTableSchemaStatementSpec): string {
  const columns = normalizeColumns(statement.columns);
  const primaryKey = normalizeNameList(statement.primaryKey, "primaryKey");
  const indexes = statement.indexes ?? [];
  const columnNames = new Set(columns.map(({ name }) => normalizeIdentifier(name)));
  const primaryKeyNames = new Set(primaryKey);
  const partitionByHash = statement.partitionByHash === undefined
    ? []
    : normalizeNameList(statement.partitionByHash, "partitionByHash");

  if (statement.store === "column" && indexes.length > 0) {
    throw new Error("Secondary indexes are supported only for row-oriented tables");
  }
  if (partitionByHash.length > 0 && statement.store !== "column") {
    throw new Error("partitionByHash is supported only for column-oriented tables; set store to \"column\"");
  }
  for (const key of primaryKey) {
    if (!columnNames.has(key)) {
      throw new Error(`primaryKey column ${key} must exist in columns`);
    }
  }
  for (const index of indexes) {
    validateIndexColumns(index, columnNames);
  }
  for (const column of partitionByHash) {
    if (!columnNames.has(column)) {
      throw new Error(`partitionByHash column ${column} must exist in columns`);
    }
    if (!primaryKeyNames.has(column)) {
      throw new Error(`partitionByHash column ${column} must be part of primaryKey`);
    }
  }
  rejectReservedTableWithSettings(statement.with);

  const tableItems = [
    ...columns.map((column) => `  ${renderColumn(column)}`),
    ...indexes.map((index) => `  ${renderIndex(index)}`),
    `  PRIMARY KEY (${primaryKey.map(quoteIdentifier).join(", ")})`,
  ];
  const withSettings = renderWithSettings({
    ...(statement.store ? { STORE: bareSettingToken(statement.store.toUpperCase()) } : {}),
    ...(statement.with ?? {}),
  }, "upper");
  const clauses = [
    `CREATE TABLE ${statement.ifNotExists ? "IF NOT EXISTS " : ""}${quoteTableName(statement.tableName)} (`,
    tableItems.map((line, index) => index === tableItems.length - 1 ? line : `${line},`).join("\n"),
    ")",
  ];
  if (partitionByHash.length > 0) {
    clauses.push(`PARTITION BY HASH (${partitionByHash.map(quoteIdentifier).join(", ")})`);
  }
  if (withSettings.length > 0) {
    clauses.push("WITH (");
    clauses.push(withSettings.map((line, index) => index === withSettings.length - 1 ? `  ${line}` : `  ${line},`).join("\n"));
    clauses.push(")");
  }
  return `${clauses.join("\n")};`;
}

function renderAlterTable(tableName: string, actions: AlterTableSchemaAction[] | undefined): {
  kind: GeneratedSchemaStatementKind;
  sql: string;
  statementCount: number;
  warnings: string[];
} {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("alterTable actions must contain at least one action");
  }
  validateAlterTableActions(actions);
  const warnings: string[] = [];
  const renderedStatements = actions.map((action) => {
    const prefix = `ALTER TABLE ${quoteTableName(tableName)}`;
    switch (action.kind) {
      case "addColumn":
        return `${prefix}\n  ADD COLUMN ${renderColumn(action.column)};`;
      case "dropColumn":
        warnings.push("Generated ALTER TABLE DROP COLUMN. Apply only after confirming data loss is acceptable.");
        return `${prefix}\n  DROP COLUMN ${quoteIdentifier(action.name)};`;
      case "addIndex":
        return `${prefix}\n  ADD ${renderIndex(action.index)};`;
      case "dropIndex":
        warnings.push("Generated ALTER TABLE DROP INDEX. Query plans using this index may regress.");
        return `${prefix}\n  DROP INDEX ${quoteIdentifier(action.name)};`;
      default:
        throw new Error(`Unsupported ALTER TABLE action kind: ${String((action as { kind?: unknown }).kind)}`);
    }
  });
  return {
    kind: "ALTER TABLE",
    sql: renderedStatements.join("\n\n"),
    statementCount: renderedStatements.length,
    warnings,
  };
}

function validateAlterTableActions(actions: AlterTableSchemaAction[]): void {
  const addedColumns = new Set<string>();
  const droppedColumns = new Set<string>();
  for (const action of actions) {
    if (action.kind === "addColumn") {
      addedColumns.add(normalizeIdentifier(action.column.name));
    } else if (action.kind === "dropColumn") {
      droppedColumns.add(normalizeIdentifier(action.name));
    }
  }

  for (const action of actions) {
    if (action.kind === "addIndex") {
      validateAlterIndexReferences(action.index, addedColumns, "added in the same alterTable spec; apply the addColumn first, then generate a separate addIndex statement");
      validateAlterIndexReferences(action.index, droppedColumns, "dropped in the same alterTable spec");
    }
  }
}

function validateAlterIndexReferences(index: SchemaIndexSpec, disallowedColumns: Set<string>, reason: string): void {
  for (const column of normalizeNameList(index.columns, `index ${index.name} columns`)) {
    if (disallowedColumns.has(column)) {
      throw new Error(`index ${index.name} cannot reference column ${column} ${reason}`);
    }
  }
  if (index.cover !== undefined) {
    for (const column of normalizeNameList(index.cover, `index ${index.name} cover`)) {
      if (disallowedColumns.has(column)) {
        throw new Error(`index ${index.name} cannot cover column ${column} ${reason}`);
      }
    }
  }
}

function normalizeColumns(columns: SchemaColumnSpec[] | undefined): SchemaColumnSpec[] {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("columns must contain at least one column");
  }
  const names = new Set<string>();
  for (const column of columns) {
    const name = normalizeIdentifier(column.name);
    if (names.has(name)) {
      throw new Error(`Duplicate column name: ${name}`);
    }
    names.add(name);
    normalizeColumnType(column.type);
  }
  return columns;
}

function renderColumn(column: SchemaColumnSpec): string {
  const columnType = normalizeColumnType(column.type);
  const parts = [
    quoteIdentifier(column.name),
    columnType,
  ];
  if (column.notNull) {
    parts.push("NOT NULL");
  }
  if (column.default !== undefined) {
    parts.push("DEFAULT", renderDefaultLiteral(column.default, columnType));
  }
  return parts.join(" ");
}

function renderIndex(index: SchemaIndexSpec): string {
  const columns = normalizeNameList(index.columns, `index ${index.name} columns`);
  if (index.global && index.local) {
    throw new Error(`index ${index.name} cannot be both global and local`);
  }
  validateIndexMode(index);
  const parts = ["INDEX", quoteIdentifier(index.name)];
  if (index.global) {
    parts.push("GLOBAL");
  }
  if (index.local) {
    parts.push("LOCAL");
  }
  if (index.unique) {
    parts.push("UNIQUE");
  }
  if (index.sync) {
    parts.push(index.sync.toUpperCase());
  }
  if (index.using) {
    if (index.using === "vector_kmeans_tree") {
      validateVectorIndex(index);
    }
    parts.push("USING", index.using);
  }
  parts.push("ON", `(${columns.map(quoteIdentifier).join(", ")})`);
  if (index.cover && index.cover.length > 0) {
    parts.push("COVER", `(${normalizeNameList(index.cover, `index ${index.name} cover`).map(quoteIdentifier).join(", ")})`);
  }
  const withSettings = renderWithSettings(index.with ?? {}, "preserve");
  if (withSettings.length > 0) {
    parts.push("WITH", `(${withSettings.join(", ")})`);
  }
  return parts.join(" ");
}

function validateIndexMode(index: SchemaIndexSpec): void {
  const indexType = index.using ?? "secondary";
  if (indexType === "secondary" && index.local) {
    throw new Error(`secondary index ${index.name} cannot be local`);
  }
  if (indexType === "secondary" && index.with !== undefined) {
    throw new Error(`secondary index ${index.name} cannot have WITH settings`);
  }
  if (index.unique && index.sync === "async") {
    throw new Error(`unique index ${index.name} must be sync`);
  }
}

function validateVectorIndex(index: SchemaIndexSpec): void {
  if (!index.global) {
    throw new Error(`vector_kmeans_tree index ${index.name} must be global`);
  }
  if (index.local) {
    throw new Error(`vector_kmeans_tree index ${index.name} cannot be local`);
  }
  if (index.unique) {
    throw new Error(`vector_kmeans_tree index ${index.name} cannot be unique`);
  }
  if (index.sync !== "sync") {
    throw new Error(`vector_kmeans_tree index ${index.name} must be sync`);
  }
  const settings = index.with ?? {};
  const vectorDimension = requireVectorNumberSetting(index.name, settings, "vector_dimension", 1, 16_384);
  const clusters = requireVectorNumberSetting(index.name, settings, "clusters", 2, 2_048);
  const levels = requireVectorNumberSetting(index.name, settings, "levels", 1, 16);
  requireVectorStringSetting(index.name, settings, "vector_type", ["float", "uint8", "int8"]);

  const hasDistance = settings.distance !== undefined;
  const hasSimilarity = settings.similarity !== undefined;
  if (hasDistance === hasSimilarity) {
    throw new Error(`vector_kmeans_tree index ${index.name} requires exactly one of distance or similarity`);
  }
  if (hasDistance) {
    requireVectorStringSetting(index.name, settings, "distance", ["cosine", "manhattan", "euclidean"]);
  }
  if (hasSimilarity) {
    requireVectorStringSetting(index.name, settings, "similarity", ["inner_product", "cosine"]);
  }
  if (vectorDimension * clusters > 4_194_304) {
    throw new Error(`vector_kmeans_tree index ${index.name} vector_dimension * clusters must be at most 4194304`);
  }
  if (clusters ** levels > 1_073_741_824) {
    throw new Error(`vector_kmeans_tree index ${index.name} clusters ** levels must be at most 1073741824`);
  }
}

function createTableWarnings(statement: CreateTableSchemaStatementSpec): string[] {
  if ((statement.indexes ?? []).some((index) => index.using === "vector_kmeans_tree")) {
    return [
      "Generated CREATE TABLE with a vector index. YDB recommends adding vector indexes after loading representative data; a vector index created on an empty table can degrade to full scans.",
    ];
  }
  return [];
}

function requireVectorNumberSetting(
  indexName: string,
  settings: Record<string, SchemaSettingValue>,
  key: string,
  min: number,
  max: number,
): number {
  const value = settings[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`vector_kmeans_tree index ${indexName} requires numeric ${key} between ${min} and ${max}`);
  }
  return value;
}

function requireVectorStringSetting(
  indexName: string,
  settings: Record<string, SchemaSettingValue>,
  key: string,
  allowed: string[],
): string {
  const value = settings[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`vector_kmeans_tree index ${indexName} requires ${key} to be one of ${allowed.join(", ")}`);
  }
  return value;
}

function validateIndexColumns(index: SchemaIndexSpec, columnNames: Set<string>): void {
  for (const column of normalizeNameList(index.columns, `index ${index.name} columns`)) {
    if (!columnNames.has(column)) {
      throw new Error(`index ${index.name} column ${column} must exist in columns`);
    }
  }
  if (index.cover !== undefined) {
    for (const column of normalizeNameList(index.cover, `index ${index.name} cover`)) {
      if (!columnNames.has(column)) {
        throw new Error(`index ${index.name} cover column ${column} must exist in columns`);
      }
    }
  }
}

function normalizeNameList(names: string[] | undefined, label: string): string[] {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`${label} must contain at least one name`);
  }
  return names.map(normalizeIdentifier);
}

function quoteTableName(tableName: string): string {
  const name = normalizeIdentifier(tableName);
  const segments = name.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid YDB table path: ${tableName}`);
  }
  return quoteIdentifier(name);
}

function quoteIdentifier(identifier: string): string {
  const name = normalizeIdentifier(identifier);
  return `\`${name
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}\``;
}

function normalizeIdentifier(identifier: string | undefined): string {
  if (typeof identifier !== "string") {
    throw new Error("YDB identifiers must be strings");
  }
  const name = identifier.trim();
  if (!name) {
    throw new Error("YDB identifiers must be non-empty");
  }
  return name;
}

function normalizeColumnType(type: string): string {
  if (typeof type !== "string") {
    throw new Error("YDB column types must be strings");
  }
  const normalized = type.trim();
  const simple = SIMPLE_TYPES.get(normalized.toLowerCase());
  if (simple) {
    return simple;
  }
  const decimal = normalized.match(/^Decimal\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (!decimal) {
    throw new Error(`Unsupported YDB column type: ${type}`);
  }
  const precision = Number(decimal[1]);
  const scale = Number(decimal[2]);
  if (!Number.isInteger(precision) || precision < 1 || precision > 35) {
    throw new Error("Decimal precision must be between 1 and 35");
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
    throw new Error("Decimal scale must be between 0 and precision");
  }
  return `Decimal(${precision}, ${scale})`;
}

function renderWithSettings(settings: Record<string, PublicSettingValue>, nameCase: "preserve" | "upper"): string[] {
  return Object.entries(settings).map(([key, value]) => `${normalizeSettingName(key, nameCase)} = ${renderSettingValue(value)}`);
}

function normalizeSettingName(name: string, nameCase: "preserve" | "upper"): string {
  const normalized = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid YDB setting name: ${name}`);
  }
  return nameCase === "upper" ? normalized.toUpperCase() : normalized;
}

function renderSettingValue(value: PublicSettingValue): string {
  if (isBareSettingToken(value)) {
    return normalizeSettingToken(value.value);
  }
  if (isSettingTokenValue(value)) {
    return normalizeSettingToken(value.token);
  }
  if (typeof value === "object" && value !== null) {
    throw new Error("YDB setting object values must be { token: string }");
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("YDB numeric setting values must be finite");
    }
    return String(value);
  }
  return renderLiteral(value);
}

function bareSettingToken(value: string): BareSettingToken {
  return {
    [BARE_SETTING_TOKEN]: true,
    value,
  };
}

function isBareSettingToken(value: PublicSettingValue): value is BareSettingToken {
  return typeof value === "object" && value !== null && BARE_SETTING_TOKEN in value;
}

function isSettingTokenValue(value: PublicSettingValue): value is { token: string } {
  return typeof value === "object" && value !== null && "token" in value && typeof value.token === "string";
}

function normalizeSettingToken(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid YDB setting token: ${value}`);
  }
  return value;
}

function rejectReservedTableWithSettings(settings: Record<string, SchemaSettingValue> | undefined): void {
  if (settings !== undefined && Object.keys(settings).some((name) => normalizeIdentifier(name).toUpperCase() === "STORE")) {
    throw new Error("Use the store field instead of with.STORE");
  }
}

function renderLiteral(value: string | number | boolean): string {
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("YDB numeric literals must be finite");
    }
    return String(value);
  }
  return quoteStringLiteral(value);
}

function renderDefaultLiteral(value: string | number | boolean, columnType: string): string {
  if (columnType === "Bool") {
    if (typeof value !== "boolean") {
      throw new Error("Bool column defaults must be boolean values");
    }
    return renderLiteral(value);
  }
  if (columnType === "String") {
    return quoteStringLiteral(expectDefaultString(value, columnType));
  }
  const decimal = columnType.match(/^Decimal\((\d+), (\d+)\)$/);
  if (decimal) {
    return `Decimal(${quoteStringLiteral(defaultValueText(value, columnType))}, ${decimal[1]}, ${decimal[2]})`;
  }
  if (NUMERIC_DEFAULT_TYPES.has(columnType)) {
    if (typeof value === "boolean") {
      throw new Error(`${columnType} column defaults must be numeric values`);
    }
    if (INTEGER_DEFAULT_TYPES.has(columnType) && typeof value === "number" && !Number.isInteger(value)) {
      throw new Error(`${columnType} column defaults must be integer values`);
    }
    return `${columnType}(${quoteStringLiteral(defaultValueText(value, columnType))})`;
  }
  if (STRING_CONSTRUCTOR_DEFAULT_TYPES.has(columnType)) {
    return `${columnType}(${quoteStringLiteral(expectDefaultString(value, columnType))})`;
  }
  throw new Error(`Unsupported default value for YDB column type: ${columnType}`);
}

function defaultValueText(value: string | number | boolean, columnType: string): string {
  if (typeof value === "boolean") {
    throw new Error(`${columnType} column defaults must not be boolean values`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${columnType} column defaults must be finite values`);
    }
    return String(value);
  }
  const text = value.trim();
  if (!text) {
    throw new Error(`${columnType} column defaults must be non-empty strings`);
  }
  return text;
}

function expectDefaultString(value: string | number | boolean, columnType: string): string {
  if (typeof value !== "string") {
    throw new Error(`${columnType} column defaults must be string values`);
  }
  return value;
}

function quoteStringLiteral(value: string): string {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    switch (char) {
      case "\\":
        escaped += "\\\\";
        break;
      case "'":
        escaped += "\\'";
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      case "\b":
        escaped += "\\b";
        break;
      case "\f":
        escaped += "\\f";
        break;
      default: {
        const code = char.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) {
          escaped += `\\x${code.toString(16).padStart(2, "0")}`;
        } else {
          escaped += char;
        }
      }
    }
  }
  return `'${escaped}'`;
}

function generatedSchemaRisk(
  kinds: GeneratedSchemaStatementKind[],
  warnings: string[],
): OperationPlan["risk"] {
  if (kinds.includes("DROP TABLE") || warnings.some((warning) => warning.includes("DROP"))) {
    return "high";
  }
  if (kinds.includes("ALTER TABLE")) {
    return "medium";
  }
  return "low";
}

function schemaGenerationVerification(databasePath: string): string[] {
  return [
    "Review the generated script and warnings before applying it.",
    `local_ydb_apply_schema action=validate databasePath=${databasePath}`,
    "If validation succeeds, call local_ydb_apply_schema action=apply confirm=false to review the exact apply plan.",
    "Use confirm=true only after explicit approval of that plan.",
    "Describe changed tables with local_ydb_scheme action=describe after apply.",
  ];
}

function unique<T>(values: T[]): T[] {
  const result: T[] = [];
  for (const value of values) {
    if (!result.includes(value)) {
      result.push(value);
    }
  }
  return result;
}
