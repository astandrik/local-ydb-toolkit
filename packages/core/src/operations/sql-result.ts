import { types as utilTypes } from "node:util";
import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import { redactText } from "../auth.js";
import type { JsonValue } from "../sql-parameter-types.js";
import type {
  QueryServiceExecutionResult,
  QueryServiceIssue,
  QueryServiceIssuePosition,
  QueryServiceResultSet,
  QueryServiceTruncationReason,
} from "../query-service.js";

const COMPLETIONS = new Set([
  "success",
  "partial",
  "cancelled",
  "failed",
  "mutationStatusUnknown",
]);
const TRUNCATION_REASONS = new Set<QueryServiceTruncationReason>([
  "rowLimit",
  "byteLimit",
  "server",
]);
const STATUS_CODES = new Set(
  Object.values(StatusIds_StatusCode)
    .filter((value): value is StatusIds_StatusCode =>
      typeof value === "number"),
);
const MAX_DIAGNOSTICS_BYTES = 4_096;
const MAX_RESULT_SETS = 10_000;
const MAX_TOP_LEVEL_ISSUES = 10_000;
const MAX_ISSUE_DEPTH = 32;
const MAX_ISSUE_NODES = 1_000;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 600_000;

const TOP_LEVEL_FIELDS = new Set([
  "completion",
  "resultSets",
  "capturedBytes",
  "truncationReasons",
  "issues",
  "queryPlan",
  "queryAst",
  "status",
  "diagnostics",
]);
const RESULT_SET_FIELDS = new Set([
  "index",
  "columns",
  "rows",
  "truncationReasons",
]);
const COLUMN_FIELDS = new Set(["name", "type"]);
const ISSUE_FIELDS = new Set([
  "message",
  "issueCode",
  "severity",
  "position",
  "endPosition",
  "issues",
]);
const POSITION_FIELDS = new Set(["row", "column", "file"]);

export interface SqlBackendResultNormalizationOptions {
  captureBudget: number;
  maxRows: number;
  diagnosticRedactions: string[];
}

export function invalidSqlBackendResult(): QueryServiceExecutionResult {
  return {
    completion: "failed",
    resultSets: [],
    capturedBytes: 0,
    truncationReasons: [],
    diagnostics: "Managed SQL backend returned an invalid result.",
  };
}

export function normalizeSqlBackendResult(
  value: unknown,
  options: SqlBackendResultNormalizationOptions,
): QueryServiceExecutionResult | undefined {
  try {
    return normalizeSqlBackendResultUnsafe(value, options);
  } catch {
    return undefined;
  }
}

function normalizeSqlBackendResultUnsafe(
  value: unknown,
  options: SqlBackendResultNormalizationOptions,
): QueryServiceExecutionResult | undefined {
  if (
    !Number.isSafeInteger(options.captureBudget)
    || options.captureBudget < 0
    || !Number.isSafeInteger(options.maxRows)
    || options.maxRows < 0
  ) {
    return undefined;
  }
  const record = inspectExactRecord(
    value,
    TOP_LEVEL_FIELDS,
    ["completion", "resultSets", "capturedBytes", "truncationReasons"],
  );
  if (!record) {
    return undefined;
  }

  const completion = record.get("completion");
  const capturedBytes = record.get("capturedBytes");
  if (
    typeof completion !== "string"
    || !COMPLETIONS.has(completion)
    || typeof capturedBytes !== "number"
    || !Number.isSafeInteger(capturedBytes)
    || capturedBytes < 0
    || capturedBytes > options.captureBudget
  ) {
    return undefined;
  }

  let status: StatusIds_StatusCode | undefined;
  if (record.has("status")) {
    const rawStatus = record.get("status");
    if (
      typeof rawStatus !== "number"
      || !Number.isSafeInteger(rawStatus)
      || !STATUS_CODES.has(rawStatus)
    ) {
      return undefined;
    }
    status = rawStatus;
  }
  if (!completionMatchesStatus(
    completion as QueryServiceExecutionResult["completion"],
    status,
  )) {
    return undefined;
  }

  const topReasons = normalizeTruncationReasons(record.get("truncationReasons"));
  const rawResultSets = inspectDenseArray(
    record.get("resultSets"),
    MAX_RESULT_SETS,
  );
  if (!topReasons || !rawResultSets) {
    return undefined;
  }
  if (
    (completion === "success" && topReasons.length > 0)
    || (completion === "partial" && topReasons.length === 0)
  ) {
    return undefined;
  }

  let measuredPayloadBytes = 0;
  const consumePayload = (payload: unknown, depth = MAX_JSON_DEPTH): boolean => {
    const remainingReportedBytes = capturedBytes - measuredPayloadBytes;
    const measured = measureJsonValue(
      payload,
      remainingReportedBytes,
      depth,
    );
    if (measured === undefined) {
      return false;
    }
    measuredPayloadBytes += measured;
    return true;
  };
  const consumeColumnPayload = (
    payload: unknown,
    maxLength: number,
  ): QueryServiceResultSet["columns"] | undefined => {
    const remainingReportedBytes = capturedBytes - measuredPayloadBytes;
    const snapshot = snapshotColumnArray(
      payload,
      remainingReportedBytes,
      maxLength,
    );
    if (!snapshot) {
      return undefined;
    }
    measuredPayloadBytes += snapshot.bytes;
    return snapshot.columns;
  };

  const normalizedResultSets: QueryServiceResultSet[] = [];
  const seenResultSetIndexes = new Set<number>();
  const resultSetState: ResultSetNormalizationState = {
    unchargedLimitEnvelopeSeen: false,
  };
  for (const rawResultSet of rawResultSets) {
    const normalized = normalizeResultSet(
      rawResultSet,
      options.maxRows,
      options.captureBudget,
      consumePayload,
      consumeColumnPayload,
      options.diagnosticRedactions,
      resultSetState,
    );
    if (!normalized || seenResultSetIndexes.has(normalized.index)) {
      return undefined;
    }
    seenResultSetIndexes.add(normalized.index);
    for (const reason of normalized.truncationReasons) {
      if (!topReasons.includes(reason)) {
        return undefined;
      }
    }
    normalizedResultSets.push(normalized);
  }

  let normalizedIssues: QueryServiceIssue[] | undefined;
  if (record.has("issues")) {
    const rawIssues = inspectDenseArray(
      record.get("issues"),
      MAX_TOP_LEVEL_ISSUES,
    );
    if (!rawIssues) {
      return undefined;
    }
    normalizedIssues = [];
    for (const rawIssue of rawIssues) {
      if (
        !validateIssue(rawIssue)
        || !consumePayload(rawIssue, MAX_ISSUE_DEPTH)
      ) {
        return undefined;
      }
      normalizedIssues.push(redactIssue(
        structuredClone(rawIssue) as QueryServiceIssue,
        options.diagnosticRedactions,
      ));
    }
  }

  const queryPlan = normalizeCapturedString(
    record,
    "queryPlan",
    consumePayload,
    options.diagnosticRedactions,
  );
  if (queryPlan === null) {
    return undefined;
  }
  const queryAst = normalizeCapturedString(
    record,
    "queryAst",
    consumePayload,
    options.diagnosticRedactions,
  );
  if (queryAst === null) {
    return undefined;
  }
  if (measuredPayloadBytes > capturedBytes) {
    return undefined;
  }

  let diagnostics: string | undefined;
  if (record.has("diagnostics")) {
    const rawDiagnostics = record.get("diagnostics");
    if (
      typeof rawDiagnostics !== "string"
      || jsonStringBytes(
        rawDiagnostics,
        MAX_DIAGNOSTICS_BYTES,
      ) === undefined
    ) {
      return undefined;
    }
    const redacted = redactText(
      rawDiagnostics,
      options.diagnosticRedactions,
    );
    if (
      jsonStringBytes(redacted, MAX_DIAGNOSTICS_BYTES) === undefined
    ) {
      return undefined;
    }
    diagnostics = redacted;
  }

  return {
    completion: completion as QueryServiceExecutionResult["completion"],
    resultSets: normalizedResultSets,
    capturedBytes,
    truncationReasons: topReasons,
    ...(normalizedIssues ? { issues: normalizedIssues } : {}),
    ...(queryPlan !== undefined ? { queryPlan } : {}),
    ...(queryAst !== undefined ? { queryAst } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };
}

function completionMatchesStatus(
  completion: QueryServiceExecutionResult["completion"],
  status: StatusIds_StatusCode | undefined,
): boolean {
  switch (completion) {
    case "success":
    case "partial":
      return status === StatusIds_StatusCode.SUCCESS;
    case "cancelled":
    case "mutationStatusUnknown":
      return status === undefined;
    case "failed":
      return status !== StatusIds_StatusCode.SUCCESS;
  }
}

function normalizeResultSet(
  value: unknown,
  maxRows: number,
  captureBudget: number,
  consumePayload: (payload: unknown, depth?: number) => boolean,
  consumeColumnPayload: (
    payload: unknown,
    maxLength: number,
  ) => QueryServiceResultSet["columns"] | undefined,
  redactions: string[],
  state: ResultSetNormalizationState,
): QueryServiceResultSet | undefined {
  const record = inspectExactRecord(
    value,
    RESULT_SET_FIELDS,
    ["index", "columns", "rows", "truncationReasons"],
  );
  if (!record) {
    return undefined;
  }
  const index = record.get("index");
  if (
    typeof index !== "number"
    || !Number.isSafeInteger(index)
    || index < 0
  ) {
    return undefined;
  }
  const reasons = normalizeTruncationReasons(record.get("truncationReasons"));
  const nodeLimit = jsonNodeLimit(captureBudget);
  const columns = consumeColumnPayload(record.get("columns"), nodeLimit);
  const rawRows = inspectDenseArray(record.get("rows"), maxRows);
  if (!reasons || !columns || !rawRows) {
    return undefined;
  }

  const rows: JsonValue[][] = [];
  for (const rawRow of rawRows) {
    const row = inspectDenseArray(rawRow, columns.length);
    if (!row || row.length !== columns.length) {
      return undefined;
    }
    const redactedRow = redactJsonValue(
      structuredClone(rawRow) as JsonValue[],
      redactions,
    ) as JsonValue[];
    if (!consumePayload(redactedRow)) {
      return undefined;
    }
    rows.push(redactedRow);
  }

  if (columns.length === 0 && rawRows.length > 0) {
    return undefined;
  }

  const normalized: QueryServiceResultSet = {
    index,
    columns,
    rows,
    truncationReasons: reasons,
  };
  if (columns.length === 0 && rows.length === 0) {
    const unchargedLimitEnvelope = reasons.includes("byteLimit")
      && reasons.every((reason) =>
        reason === "byteLimit" || reason === "server");
    if (unchargedLimitEnvelope) {
      if (state.unchargedLimitEnvelopeSeen) {
        return undefined;
      }
      state.unchargedLimitEnvelopeSeen = true;
    } else if (
      reasons.length !== 1
      || reasons[0] !== "server"
      || !consumePayload(value)
    ) {
      return undefined;
    }
  }
  return normalized;
}

interface ResultSetNormalizationState {
  unchargedLimitEnvelopeSeen: boolean;
}

function normalizeCapturedString(
  record: Map<string, unknown>,
  field: "queryPlan" | "queryAst",
  consumePayload: (payload: unknown, depth?: number) => boolean,
  redactions: string[],
): string | null | undefined {
  if (!record.has(field)) {
    return undefined;
  }
  const value = record.get(field);
  if (typeof value !== "string") {
    return null;
  }
  const redacted = redactText(value, redactions);
  if (!consumePayload(redacted)) {
    return null;
  }
  return redacted;
}

function normalizeTruncationReasons(
  value: unknown,
): QueryServiceTruncationReason[] | undefined {
  const rawReasons = inspectDenseArray(value, TRUNCATION_REASONS.size);
  if (!rawReasons) {
    return undefined;
  }
  const reasons: QueryServiceTruncationReason[] = [];
  for (const reason of rawReasons) {
    if (
      typeof reason !== "string"
      || !TRUNCATION_REASONS.has(reason as QueryServiceTruncationReason)
    ) {
      return undefined;
    }
    if (!reasons.includes(reason as QueryServiceTruncationReason)) {
      reasons.push(reason as QueryServiceTruncationReason);
    }
  }
  return reasons;
}

function validateIssue(root: unknown): boolean {
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{
    value: root,
    depth: 1,
  }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (
      current.depth > MAX_ISSUE_DEPTH
      || !current.value
      || typeof current.value !== "object"
      || seen.has(current.value)
    ) {
      return false;
    }
    seen.add(current.value);
    nodes += 1;
    if (nodes > MAX_ISSUE_NODES) {
      return false;
    }
    const issue = inspectExactRecord(
      current.value,
      ISSUE_FIELDS,
      ["message", "issueCode", "severity", "issues"],
    );
    if (
      !issue
      || typeof issue.get("message") !== "string"
      || !isSafeInteger(issue.get("issueCode"))
      || !isSafeInteger(issue.get("severity"))
      || (
        issue.has("position")
        && !validateIssuePosition(issue.get("position"))
      )
      || (
        issue.has("endPosition")
        && !validateIssuePosition(issue.get("endPosition"))
      )
    ) {
      return false;
    }
    const children = inspectDenseArray(
      issue.get("issues"),
      MAX_ISSUE_NODES - nodes,
    );
    if (!children) {
      return false;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        value: children[index],
        depth: current.depth + 1,
      });
    }
  }
  return true;
}

function validateIssuePosition(value: unknown): boolean {
  const position = inspectExactRecord(
    value,
    POSITION_FIELDS,
    ["row", "column", "file"],
  );
  return Boolean(
    position
    && isSafeInteger(position.get("row"))
    && isSafeInteger(position.get("column"))
    && typeof position.get("file") === "string",
  );
}

function redactIssue(
  issue: QueryServiceIssue,
  redactions: string[],
): QueryServiceIssue {
  return {
    ...issue,
    message: redactText(issue.message, redactions),
    ...(issue.position
      ? { position: redactIssuePosition(issue.position, redactions) }
      : {}),
    ...(issue.endPosition
      ? { endPosition: redactIssuePosition(issue.endPosition, redactions) }
      : {}),
    issues: issue.issues.map((child) => redactIssue(child, redactions)),
  };
}

function redactIssuePosition(
  position: QueryServiceIssuePosition,
  redactions: string[],
): QueryServiceIssuePosition {
  return {
    ...position,
    file: redactText(position.file, redactions),
  };
}

function redactJsonValue(value: JsonValue, redactions: string[]): JsonValue {
  if (typeof value === "string") {
    return redactText(value, redactions);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, redactions));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactText(key, redactions),
      redactJsonValue(item, redactions),
    ]));
  }
  return value;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function inspectExactRecord(
  value: unknown,
  allowedFields: ReadonlySet<string>,
  requiredFields: readonly string[],
): Map<string, unknown> | undefined {
  const record = inspectRecord(value, allowedFields.size);
  if (!record) {
    return undefined;
  }
  for (const field of record.keys()) {
    if (!allowedFields.has(field)) {
      return undefined;
    }
  }
  for (const field of requiredFields) {
    if (!record.has(field)) {
      return undefined;
    }
  }
  return record;
}

function inspectRecord(
  value: unknown,
  maxProperties: number,
): Map<string, unknown> | undefined {
  if (
    !value
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || Array.isArray(value)
  ) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxProperties) {
    return undefined;
  }
  const entries = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      return undefined;
    }
    entries.set(key, descriptor.value);
  }
  return entries;
}

function inspectDenseArray(
  value: unknown,
  maxLength: number,
): unknown[] | undefined {
  if (
    !value
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || !Array.isArray(value)
  ) {
    return undefined;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (
    typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > maxLength
  ) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || !keys.includes("length")) {
    return undefined;
  }
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      return undefined;
    }
    items.push(descriptor.value);
  }
  return items;
}

interface ColumnArraySnapshot {
  columns: QueryServiceResultSet["columns"];
  bytes: number;
}

function snapshotColumnArray(
  value: unknown,
  maxBytes: number,
  maxLength: number,
): ColumnArraySnapshot | undefined {
  if (
    !value
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || !Array.isArray(value)
    || !Number.isSafeInteger(maxBytes)
    || maxBytes < 0
  ) {
    return undefined;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > maxLength
  ) {
    return undefined;
  }
  let bytes = length === 0 ? 0 : addBytes(0, length + 1, maxBytes);
  if (bytes > maxBytes) {
    return undefined;
  }
  const columns: QueryServiceResultSet["columns"] = [];
  const seenColumns = new Set<object>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      return undefined;
    }
    const rawColumn = descriptor.value;
    if (
      !rawColumn
      || typeof rawColumn !== "object"
      || utilTypes.isProxy(rawColumn)
      || Array.isArray(rawColumn)
      || seenColumns.has(rawColumn)
    ) {
      return undefined;
    }
    seenColumns.add(rawColumn);
    const column = snapshotColumnRecord(rawColumn, maxBytes - bytes);
    if (!column) {
      return undefined;
    }
    bytes = addBytes(bytes, column.bytes, maxBytes);
    columns.push(column.value);
  }
  if (!hasExactDenseArrayKeys(value, length)) {
    return undefined;
  }
  return bytes <= maxBytes ? { columns, bytes } : undefined;
}

function snapshotColumnRecord(
  value: object,
  maxBytes: number,
): {
  value: QueryServiceResultSet["columns"][number];
  bytes: number;
} | undefined {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  const nameDescriptor = Object.getOwnPropertyDescriptor(value, "name");
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (
    !nameDescriptor
    || !nameDescriptor.enumerable
    || !("value" in nameDescriptor)
    || typeof nameDescriptor.value !== "string"
    || !typeDescriptor
    || !typeDescriptor.enumerable
    || !("value" in typeDescriptor)
    || typeof typeDescriptor.value !== "string"
  ) {
    return undefined;
  }

  let bytes = addBytes(0, 17, maxBytes);
  const nameBytes = jsonStringBytes(
    nameDescriptor.value,
    maxBytes - bytes,
  );
  if (nameBytes === undefined) {
    return undefined;
  }
  bytes = addBytes(bytes, nameBytes, maxBytes);
  const typeBytes = jsonStringBytes(
    typeDescriptor.value,
    maxBytes - bytes,
  );
  if (typeBytes === undefined) {
    return undefined;
  }
  bytes = addBytes(bytes, typeBytes, maxBytes);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== COLUMN_FIELDS.size
    || !keys.includes("name")
    || !keys.includes("type")
  ) {
    return undefined;
  }
  return bytes <= maxBytes
    ? {
        value: {
          name: nameDescriptor.value,
          type: typeDescriptor.value,
        },
        bytes,
      }
    : undefined;
}

function hasExactDenseArrayKeys(value: unknown[], length: number): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) {
    return false;
  }
  let lengthSeen = false;
  for (const key of keys) {
    if (key === "length") {
      lengthSeen = true;
      continue;
    }
    if (typeof key !== "string") {
      return false;
    }
    const index = Number(key);
    if (
      !Number.isSafeInteger(index)
      || index < 0
      || index >= length
      || String(index) !== key
    ) {
      return false;
    }
  }
  return lengthSeen;
}

function measureJsonValue(
  root: unknown,
  maxBytes: number,
  maxDepth: number,
): number | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return undefined;
  }
  const nodeLimit = jsonNodeLimit(maxBytes);
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{
    value: root,
    depth: 1,
  }];
  let bytes = 0;
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > nodeLimit || current.depth > maxDepth) {
      return undefined;
    }
    const value = current.value;
    if (value === null) {
      bytes = addBytes(bytes, 4, maxBytes);
    } else if (typeof value === "boolean") {
      bytes = addBytes(bytes, value ? 4 : 5, maxBytes);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return undefined;
      }
      bytes = addBytes(bytes, String(Object.is(value, -0) ? 0 : value).length, maxBytes);
    } else if (typeof value === "string") {
      const stringBytes = jsonStringBytes(value, maxBytes - bytes);
      if (stringBytes === undefined) {
        return undefined;
      }
      bytes += stringBytes;
    } else if (Array.isArray(value)) {
      if (seen.has(value)) {
        return undefined;
      }
      seen.add(value);
      const items = inspectDenseArray(value, nodeLimit - nodes);
      if (!items) {
        return undefined;
      }
      bytes = addBytes(
        bytes,
        2 + Math.max(0, items.length - 1),
        maxBytes,
      );
      for (let index = items.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: items[index],
          depth: current.depth + 1,
        });
      }
    } else if (value && typeof value === "object") {
      if (seen.has(value)) {
        return undefined;
      }
      seen.add(value);
      const entries = inspectRecord(value, nodeLimit - nodes);
      if (!entries) {
        return undefined;
      }
      bytes = addBytes(
        bytes,
        2 + Math.max(0, entries.size - 1),
        maxBytes,
      );
      const values: unknown[] = [];
      for (const [key, item] of entries) {
        const keyBytes = jsonStringBytes(key, maxBytes - bytes);
        if (keyBytes === undefined) {
          return undefined;
        }
        bytes = addBytes(bytes, keyBytes + 1, maxBytes);
        values.push(item);
      }
      for (let index = values.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: values[index],
          depth: current.depth + 1,
        });
      }
    } else {
      return undefined;
    }
    if (bytes > maxBytes) {
      return undefined;
    }
  }
  return bytes;
}

function jsonNodeLimit(maxBytes: number): number {
  return Math.min(
    MAX_JSON_NODES,
    Math.max(1, Math.floor(maxBytes) + 1),
  );
}

function addBytes(current: number, added: number, maxBytes: number): number {
  const total = current + added;
  return total > maxBytes ? maxBytes + 1 : total;
}

function jsonStringBytes(
  value: string,
  maxBytes: number,
): number | undefined {
  if (maxBytes < 2) {
    return undefined;
  }
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (
      codeUnit === 0x08
      || codeUnit === 0x09
      || codeUnit === 0x0a
      || codeUnit === 0x0c
      || codeUnit === 0x0d
    ) {
      bytes += 2;
    } else if (codeUnit < 0x20) {
      bytes += 6;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) {
      return undefined;
    }
  }
  return bytes;
}
