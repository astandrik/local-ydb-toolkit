import { Driver, type DriverOptions } from "@ydbjs/core";
import { AnonymousCredentialsProvider } from "@ydbjs/auth/anonymous";
import { StaticCredentialsProvider } from "@ydbjs/auth/static";
import {
  ExecMode,
  QueryServiceDefinition,
  SchemaInclusionMode,
  StatsMode,
  Syntax,
} from "@ydbjs/api/query";
import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import {
  ResultSet_Format,
  Type_PrimitiveTypeId,
  type ResultSet,
  type Type,
  type TypedValue,
} from "@ydbjs/api/value";
import {
  createSdkOperationDeadline,
  normalizeSdkTimeoutMs,
  withSdkConnection,
  type SdkConnectionRequest,
} from "./operations/sdk-connection.js";
import type { ToolkitContext } from "./operations/types.js";
import type { JsonValue } from "./sql-parameter-types.js";
import { decodeYdbValue } from "./sql-parameters.js";
import { redactText } from "./auth.js";

const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_CAPTURED_ISSUE_DEPTH = 32;
const MAX_CAPTURED_ISSUE_NODES = 1_000;

export type QueryServiceMode = "explain" | "snapshotReadOnly" | "noTx";

export interface QueryServiceSdkRequest extends SdkConnectionRequest {
  script: string;
  parameters: Record<string, TypedValue>;
  mode: QueryServiceMode;
  maxRows: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface QueryServiceRequest {
  databasePath?: string;
  timeoutMs?: number;
  script: string;
  parameters: Record<string, TypedValue>;
  mode: QueryServiceMode;
  maxRows: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface QueryServiceExecutionResult {
  completion: "success" | "partial" | "cancelled" | "failed" | "mutationStatusUnknown";
  resultSets: QueryServiceResultSet[];
  capturedBytes: number;
  truncationReasons: QueryServiceTruncationReason[];
  issues?: QueryServiceIssue[];
  queryPlan?: string;
  queryAst?: string;
  status?: StatusIds_StatusCode;
  diagnostics?: string;
}

export interface QueryServiceIssue {
  message: string;
  issueCode: number;
  severity: number;
  position?: QueryServiceIssuePosition;
  endPosition?: QueryServiceIssuePosition;
  issues: QueryServiceIssue[];
}

export interface QueryServiceIssuePosition {
  row: number;
  column: number;
  file: string;
}

export interface QueryServiceResultSet {
  index: number;
  columns: Array<{ name: string; type: string }>;
  rows: JsonValue[][];
  truncationReasons: QueryServiceTruncationReason[];
}

export type QueryServiceTruncationReason = "rowLimit" | "byteLimit" | "server";

interface QueryResponse {
  status: StatusIds_StatusCode;
  issues?: QueryIssueMessage[];
  execStats?: {
    queryPlan: string;
    queryAst: string;
  };
}

interface QueryIssueMessage {
  message: string;
  issueCode: number;
  severity: number;
  position?: QueryServiceIssuePosition;
  endPosition?: QueryServiceIssuePosition;
  issues: QueryIssueMessage[];
}

interface QueryServiceClient {
  createSession(
    request: Record<string, never>,
    options?: { signal?: AbortSignal },
  ): Promise<QueryResponse & { sessionId: string; nodeId: bigint }>;
  attachSession(
    request: { sessionId: string },
    options?: { signal?: AbortSignal },
  ): AsyncIterable<QueryResponse>;
  executeQuery(
    request: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<QueryResponse & { resultSetIndex?: bigint; resultSet?: ResultSet }>;
  deleteSession(
    request: { sessionId: string },
    options?: { signal?: AbortSignal },
  ): Promise<QueryResponse>;
}

interface QueryDriver {
  ready(signal?: AbortSignal): Promise<void>;
  createClient(definition: typeof QueryServiceDefinition, nodeId?: bigint): QueryServiceClient;
  close(): void;
}

interface QueryServiceDependencies {
  createDriver?: (connectionString: string, options: DriverOptions) => QueryDriver;
}

export type QueryServiceExecutor = (
  request: QueryServiceSdkRequest,
) => Promise<QueryServiceExecutionResult>;

export async function executeQueryService(
  ctx: ToolkitContext,
  request: QueryServiceRequest,
  executor: QueryServiceExecutor = executeQueryServiceWithSdk,
): Promise<QueryServiceExecutionResult> {
  const timeoutMs = normalizeSdkTimeoutMs(request.timeoutMs);
  const deadline = createSdkOperationDeadline(timeoutMs, request.signal);
  try {
    return await withSdkConnection(ctx, {
      databasePath: request.databasePath,
      timeoutMs,
      operationLabel: "managed SQL query",
      deadline,
    }, (connection) => executor({
      ...connection,
      script: request.script,
      parameters: request.parameters,
      mode: request.mode,
      maxRows: request.maxRows,
      maxOutputBytes: request.maxOutputBytes,
      signal: deadline.signal,
    }));
  } catch {
    if (deadline.signal.aborted) {
      return {
        completion: "cancelled",
        resultSets: [],
        capturedBytes: 0,
        truncationReasons: [],
        diagnostics: "Query Service request was cancelled.",
      };
    }
    throw new Error("Query Service connection setup failed.");
  }
}

export async function executeQueryServiceWithSdk(
  request: QueryServiceSdkRequest,
  dependencies: QueryServiceDependencies = {},
): Promise<QueryServiceExecutionResult> {
  const internalController = new AbortController();
  const operationDeadline = request.deadline
    ?? createSdkOperationDeadline(request.timeoutMs, request.signal);
  const operationSignal = AbortSignal.any([
    operationDeadline.signal,
    internalController.signal,
    ...(request.signal && request.signal !== operationDeadline.signal
      ? [request.signal]
      : []),
  ]);
  const driver = (dependencies.createDriver ?? createQueryDriver)(
    request.connectionString,
    driverOptions(request),
  );
  let sessionId: string | undefined;
  let nodeClient: QueryServiceClient | undefined;
  let attachMonitor: Promise<void> | undefined;
  let executionFinished = false;
  const resultSets = new Map<number, ResultSetCapture>();
  const capturedIssues: QueryServiceIssue[] = [];
  const payloadTruncationReasons = new Set<QueryServiceTruncationReason>();
  let queryPlan: string | undefined;
  let queryAst: string | undefined;
  let capturedBytes = 0;
  let limitReached = false;
  let payloadCaptureStopped = false;
  let finalStatus = StatusIds_StatusCode.SUCCESS;
  let streamFailed = false;
  let requestSent = false;
  let sessionMonitorFailed = false;
  let receivedPart = false;
  const payloadRedactions = request.rootPassword ? [request.rootPassword] : [];

  try {
    await driver.ready(operationSignal);
    const baseClient = driver.createClient(QueryServiceDefinition);
    const created = await baseClient.createSession({}, { signal: operationSignal });
    ensureSuccess(created, "create session");
    if (!created.sessionId) {
      throw new Error("Query Service did not return a session identifier");
    }
    sessionId = created.sessionId;
    nodeClient = driver.createClient(QueryServiceDefinition, created.nodeId);

    const attachIterator = nodeClient.attachSession(
      { sessionId },
      { signal: operationSignal },
    )[Symbol.asyncIterator]();
    const firstState = await attachIterator.next();
    if (firstState.done) {
      throw new Error("Query Service attach stream ended before validation");
    }
    ensureSuccess(firstState.value, "attach session");
    attachMonitor = monitorAttachedSession(
      attachIterator,
      internalController,
      () => executionFinished,
      () => {
        sessionMonitorFailed = true;
      },
    );

    const responseStream = nodeClient.executeQuery(
      buildExecuteRequest(request, sessionId),
      { signal: operationSignal },
    );
    requestSent = true;
    try {
      for await (const part of responseStream) {
        receivedPart = true;
        if (!payloadCaptureStopped) {
          for (const issue of part.issues ?? []) {
            const capturedIssue = captureBoundedIssue(
              issue,
              payloadRedactions,
              request.maxOutputBytes - capturedBytes,
            );
            if (!capturedIssue.issue) {
              limitReached = true;
              payloadCaptureStopped = true;
              payloadTruncationReasons.add("byteLimit");
              break;
            }
            capturedIssues.push(capturedIssue.issue);
            capturedBytes += capturedIssue.bytes;
          }
        }
        if (!payloadCaptureStopped && part.execStats?.queryPlan) {
          const redactedPlan = redactText(
            part.execStats.queryPlan,
            payloadRedactions,
          );
          const planBytes = jsonBytes(redactedPlan);
          if (planBytes > request.maxOutputBytes - capturedBytes) {
            limitReached = true;
            payloadCaptureStopped = true;
            payloadTruncationReasons.add("byteLimit");
          } else {
            queryPlan = redactedPlan;
            capturedBytes += planBytes;
          }
        }
        if (!payloadCaptureStopped && part.execStats?.queryAst) {
          const redactedAst = redactText(
            part.execStats.queryAst,
            payloadRedactions,
          );
          const astBytes = jsonBytes(redactedAst);
          if (astBytes > request.maxOutputBytes - capturedBytes) {
            limitReached = true;
            payloadCaptureStopped = true;
            payloadTruncationReasons.add("byteLimit");
          } else {
            queryAst = redactedAst;
            capturedBytes += astBytes;
          }
        }
        if (part.status !== StatusIds_StatusCode.SUCCESS) {
          finalStatus = part.status;
          break;
        }
        if (part.resultSet && !payloadCaptureStopped) {
          const captured = captureResultSetPart(
            resultSets,
            part.resultSetIndex ?? 0n,
            part.resultSet,
            request.maxRows,
            request.maxOutputBytes - capturedBytes,
          );
          capturedBytes += captured.bytes;
          if (captured.limitReached !== undefined) {
            limitReached = true;
            payloadCaptureStopped = true;
            if (captured.limitReached === "byteLimit") {
              payloadTruncationReasons.add("byteLimit");
            }
            if (request.mode !== "noTx") {
              internalController.abort(new Error("Query Service output limit reached"));
              break;
            }
          }
        }
        if (limitReached && request.mode !== "noTx") {
          internalController.abort(new Error("Query Service output limit reached"));
          break;
        }
      }
    } catch {
      if (
        request.signal?.aborted !== true
        && !operationDeadline.signal.aborted
        && !limitReached
      ) {
        streamFailed = true;
      }
    }
    if (
      !receivedPart
      && request.signal?.aborted !== true
      && !operationDeadline.signal.aborted
      && !limitReached
    ) {
      streamFailed = true;
    }
    const externallyCancelled = operationDeadline.signal.aborted
      || request.signal?.aborted === true;
    if (
      internalController.signal.aborted
      && !externallyCancelled
      && !limitReached
    ) {
      streamFailed = true;
    }
    executionFinished = true;
    internalController.abort();
    await attachMonitor;
    const transportCompletion = request.mode === "noTx" && requestSent
      ? "mutationStatusUnknown"
      : "failed";
    const sentMutationCancelled = request.mode === "noTx"
      && requestSent
      && externallyCancelled;
    const truncationReasons = collectTruncationReasons(
      resultSets,
      payloadTruncationReasons,
    );
    let completion: QueryServiceExecutionResult["completion"];
    if (finalStatus !== StatusIds_StatusCode.SUCCESS) {
      completion = "failed";
    } else if (sentMutationCancelled) {
      completion = "mutationStatusUnknown";
    } else if (externallyCancelled) {
      completion = "cancelled";
    } else if (streamFailed) {
      completion = transportCompletion;
    } else if (limitReached || truncationReasons.length > 0) {
      completion = "partial";
    } else {
      completion = "success";
    }

    let diagnostics: string | undefined;
    if (finalStatus !== StatusIds_StatusCode.SUCCESS) {
      diagnostics = "Query Service returned a non-success status.";
    } else if (sentMutationCancelled) {
      diagnostics = "Mutation was sent but its final Query Service status was not received.";
    } else if (externallyCancelled) {
      diagnostics = "Query Service request was cancelled.";
    } else if (streamFailed && sessionMonitorFailed) {
      diagnostics = transportCompletion === "mutationStatusUnknown"
        ? "Mutation was sent but its attached session was lost before final status."
        : "Query Service attached session was lost before final query status.";
    } else if (streamFailed) {
      diagnostics = transportCompletion === "mutationStatusUnknown"
        ? "Mutation was sent but its final Query Service status was not received."
        : "Query Service stream ended without a final status.";
    }

    return {
      completion,
      resultSets: Array.from(resultSets.values())
        .sort((left, right) => left.output.index - right.output.index)
        .map(({ output }) => output),
      capturedBytes,
      truncationReasons,
      ...(capturedIssues.length > 0 ? { issues: capturedIssues } : {}),
      ...(queryPlan !== undefined ? { queryPlan } : {}),
      ...(queryAst !== undefined ? { queryAst } : {}),
      ...(externallyCancelled || streamFailed ? {} : { status: finalStatus }),
      ...(diagnostics ? { diagnostics } : {}),
    };
  } catch {
    const externallyCancelled = operationDeadline.signal.aborted
      || request.signal?.aborted === true;
    const sentMutationCancelled = request.mode === "noTx"
      && requestSent
      && externallyCancelled;
    let completion: QueryServiceExecutionResult["completion"] = "failed";
    let diagnostics = "Query Service session setup failed.";
    if (sentMutationCancelled) {
      completion = "mutationStatusUnknown";
      diagnostics = "Mutation was sent but its final Query Service status was not received.";
    } else if (externallyCancelled) {
      completion = "cancelled";
      diagnostics = "Query Service request was cancelled.";
    }
    return {
      completion,
      resultSets: Array.from(resultSets.values())
        .sort((left, right) => left.output.index - right.output.index)
        .map(({ output }) => output),
      capturedBytes,
      truncationReasons: collectTruncationReasons(
        resultSets,
        payloadTruncationReasons,
      ),
      ...(capturedIssues.length > 0 ? { issues: capturedIssues } : {}),
      ...(queryPlan !== undefined ? { queryPlan } : {}),
      ...(queryAst !== undefined ? { queryAst } : {}),
      diagnostics,
    };
  } finally {
    executionFinished = true;
    internalController.abort();
    if (attachMonitor) {
      await attachMonitor.catch(() => undefined);
    }
    if (sessionId && nodeClient) {
      try {
        await nodeClient.deleteSession(
          { sessionId },
          { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
        );
      } catch {
        // Session cleanup is best effort; driver and tunnel cleanup still run.
      }
    }
    driver.close();
  }
}

interface ResultSetCapture {
  output: QueryServiceResultSet;
  types: Type[];
  columnMetadata?: Array<{ name: string; type: string }>;
}

function captureResultSetPart(
  captures: Map<number, ResultSetCapture>,
  rawIndex: bigint,
  part: ResultSet,
  maxRows: number,
  remainingBytes: number,
): {
  bytes: number;
  limitReached?: Extract<QueryServiceTruncationReason, "rowLimit" | "byteLimit">;
} {
  if (part.columns.length === 0 && part.rows.length === 0 && !part.truncated) {
    return { bytes: 0 };
  }
  const index = Number(rawIndex);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("Query Service returned an invalid result-set index");
  }
  if (
    !captures.has(index)
    && part.columns.length === 0
    && part.rows.length === 0
    && part.truncated
  ) {
    const output: QueryServiceResultSet = {
      index,
      columns: [],
      rows: [],
      truncationReasons: ["server"],
    };
    const envelopeBytes = jsonBytes(output);
    if (envelopeBytes > remainingBytes) {
      return { bytes: 0, limitReached: "byteLimit" };
    }
    captures.set(index, {
      output,
      types: [],
      columnMetadata: undefined,
    });
    return { bytes: envelopeBytes };
  }
  let capture = captures.get(index);
  let capturedBytes = 0;
  let limitReached: "rowLimit" | "byteLimit" | undefined;
  if (!capture) {
    capture = {
      output: {
        index,
        columns: [],
        rows: [],
        truncationReasons: [],
      },
      types: [],
      columnMetadata: undefined,
    };
    captures.set(index, capture);
  }
  if (part.columns.length > 0) {
    const columns = part.columns.map((column) => {
      if (!column.type) {
        throw new Error("Query Service returned a column without a type");
      }
      return {
        name: column.name,
        type: renderYdbType(column.type),
      };
    });
    if (capture.types.length === 0) {
      capture.types = part.columns.map((column) => column.type!);
      capture.columnMetadata = columns;
      const columnBytes = jsonBytes(columns);
      if (columnBytes <= remainingBytes) {
        capture.output.columns = columns;
        capturedBytes += columnBytes;
        remainingBytes -= columnBytes;
      } else {
        addTruncationReason(capture.output, "byteLimit");
        limitReached = "byteLimit";
      }
    } else if (
      JSON.stringify(capture.columnMetadata) !== JSON.stringify(columns)
    ) {
      throw new Error("Query Service changed result-set columns between parts");
    }
  }
  if (part.rows.length > 0 && capture.types.length === 0) {
    throw new Error("Query Service returned rows before result-set columns");
  }
  for (const row of part.rows) {
    if (limitReached === "byteLimit") {
      break;
    }
    if (capture.output.rows.length >= maxRows) {
      addTruncationReason(capture.output, "rowLimit");
      limitReached = "rowLimit";
      break;
    }
    if (row.items.length !== capture.types.length) {
      throw new Error("Query Service returned a row with the wrong column count");
    }
    const decoded = row.items.map((value, columnIndex) =>
      decodeYdbValue(capture.types[columnIndex], value));
    const rowBytes = jsonBytes(decoded);
    if (rowBytes > remainingBytes) {
      addTruncationReason(capture.output, "byteLimit");
      limitReached = "byteLimit";
      break;
    }
    capture.output.rows.push(decoded);
    capturedBytes += rowBytes;
    remainingBytes -= rowBytes;
  }
  if (part.truncated) {
    addTruncationReason(capture.output, "server");
  }
  return { bytes: capturedBytes, limitReached };
}

function collectTruncationReasons(
  captures: Map<number, ResultSetCapture>,
  additionalReasons: ReadonlySet<QueryServiceTruncationReason> = new Set(),
): QueryServiceTruncationReason[] {
  return Array.from(new Set(
    [
      ...additionalReasons,
      ...Array.from(captures.values()).flatMap(({ output }) => output.truncationReasons),
    ],
  ));
}

interface IssueCaptureResult {
  issue?: QueryServiceIssue;
  bytes: number;
}

interface IssueTraversalFrame {
  children: unknown[];
  output: QueryServiceIssue;
  depth: number;
  nextChildIndex: number;
}

function captureBoundedIssue(
  root: unknown,
  redactions: string[],
  remainingBytes: number,
): IssueCaptureResult {
  if (remainingBytes <= 0) {
    return { bytes: 0 };
  }
  const rootNode = captureBoundedIssueNode(root, redactions, remainingBytes);
  if (!rootNode) {
    return { bytes: 0 };
  }
  let capturedBytes = rootNode.bytes;
  let capturedNodes = 1;
  const seen = new Set<object>([rootNode.identity]);
  const stack: IssueTraversalFrame[] = [{
    children: rootNode.children,
    output: rootNode.output,
    depth: 1,
    nextChildIndex: 0,
  }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.nextChildIndex >= frame.children.length) {
      stack.pop();
      continue;
    }
    const child = frame.children[frame.nextChildIndex];
    frame.nextChildIndex += 1;
    if (
      frame.depth >= MAX_CAPTURED_ISSUE_DEPTH
      || capturedNodes >= MAX_CAPTURED_ISSUE_NODES
      || (
        child !== null
        && typeof child === "object"
        && seen.has(child)
      )
    ) {
      return { bytes: 0 };
    }
    const childNode = captureBoundedIssueNode(
      child,
      redactions,
      remainingBytes - capturedBytes,
    );
    if (!childNode) {
      return { bytes: 0 };
    }
    const separatorBytes = frame.output.issues.length > 0 ? 1 : 0;
    if (
      childNode.bytes + separatorBytes
      > remainingBytes - capturedBytes
    ) {
      return { bytes: 0 };
    }
    capturedBytes += childNode.bytes + separatorBytes;
    capturedNodes += 1;
    seen.add(childNode.identity);
    frame.output.issues.push(childNode.output);
    stack.push({
      children: childNode.children,
      output: childNode.output,
      depth: frame.depth + 1,
      nextChildIndex: 0,
    });
  }

  return {
    issue: rootNode.output,
    bytes: capturedBytes,
  };
}

function captureBoundedIssueNode(
  value: unknown,
  redactions: string[],
  remainingBytes: number,
): {
  identity: object;
  children: unknown[];
  output: QueryServiceIssue;
  bytes: number;
} | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const issue = value as Partial<QueryIssueMessage>;
  const message = issue.message;
  const issueCode = issue.issueCode;
  const severity = issue.severity;
  const children = issue.issues;
  if (
    typeof message !== "string"
    || typeof issueCode !== "number"
    || typeof severity !== "number"
    || !Array.isArray(children)
  ) {
    return undefined;
  }
  const position = captureBoundedIssuePosition(
    issue.position,
    remainingBytes,
  );
  const endPosition = captureBoundedIssuePosition(
    issue.endPosition,
    remainingBytes,
  );
  if (
    message.length > remainingBytes
    || position === null
    || endPosition === null
  ) {
    return undefined;
  }
  const output: QueryServiceIssue = {
    message: redactText(message, redactions),
    issueCode,
    severity,
    ...(position ? { position } : {}),
    ...(endPosition ? { endPosition } : {}),
    issues: [],
  };
  const bytes = jsonBytes(output);
  return bytes <= remainingBytes
    ? {
        identity: value,
        children,
        output,
        bytes,
      }
    : undefined;
}

function captureBoundedIssuePosition(
  value: unknown,
  remainingBytes: number,
): QueryServiceIssuePosition | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const position = value as Partial<QueryServiceIssuePosition>;
  const row = position.row;
  const column = position.column;
  const file = position.file;
  if (
    typeof row !== "number"
    || typeof column !== "number"
    || typeof file !== "string"
    || file.length > remainingBytes
  ) {
    return null;
  }
  return { row, column, file };
}

function addTruncationReason(
  resultSet: QueryServiceResultSet,
  reason: QueryServiceTruncationReason,
): void {
  if (!resultSet.truncationReasons.includes(reason)) {
    resultSet.truncationReasons.push(reason);
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function renderYdbType(type: Type): string {
  switch (type.type.case) {
    case "typeId":
      return primitiveTypeName(type.type.value);
    case "decimalType":
      return `Decimal(${type.type.value.precision}, ${type.type.value.scale})`;
    case "optionalType":
      return `Optional<${renderRequiredType(type.type.value.item)}>`;
    case "listType":
      return `List<${renderRequiredType(type.type.value.item)}>`;
    case "tupleType":
      return `Tuple<${type.type.value.elements.map(renderYdbType).join(", ")}>`;
    case "structType":
      return `Struct<${type.type.value.members.map((member) =>
        `${quoteYqlIdentifier(member.name)}:${renderRequiredType(member.type)}`).join(", ")}>`;
    case "dictType":
      return `Dict<${renderRequiredType(type.type.value.key)}, ${renderRequiredType(type.type.value.payload)}>`;
    case "voidType":
      return "Void";
    case "nullType":
      return "Null";
    case "emptyListType":
      return "EmptyList";
    case "emptyDictType":
      return "EmptyDict";
    default:
      throw new Error(`Unsupported YDB result type: ${String(type.type.case)}`);
  }
}

function renderRequiredType(type: Type | undefined): string {
  if (!type) {
    throw new Error("Query Service returned an incomplete column type");
  }
  return renderYdbType(type);
}

function quoteYqlIdentifier(identifier: string): string {
  return `\`${identifier
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}\``;
}

function primitiveTypeName(typeId: Type_PrimitiveTypeId): string {
  const names: Partial<Record<Type_PrimitiveTypeId, string>> = {
    [Type_PrimitiveTypeId.BOOL]: "Bool",
    [Type_PrimitiveTypeId.INT8]: "Int8",
    [Type_PrimitiveTypeId.INT16]: "Int16",
    [Type_PrimitiveTypeId.INT32]: "Int32",
    [Type_PrimitiveTypeId.INT64]: "Int64",
    [Type_PrimitiveTypeId.UINT8]: "Uint8",
    [Type_PrimitiveTypeId.UINT16]: "Uint16",
    [Type_PrimitiveTypeId.UINT32]: "Uint32",
    [Type_PrimitiveTypeId.UINT64]: "Uint64",
    [Type_PrimitiveTypeId.FLOAT]: "Float",
    [Type_PrimitiveTypeId.DOUBLE]: "Double",
    [Type_PrimitiveTypeId.STRING]: "String",
    [Type_PrimitiveTypeId.UTF8]: "Utf8",
    [Type_PrimitiveTypeId.YSON]: "Yson",
    [Type_PrimitiveTypeId.JSON]: "Json",
    [Type_PrimitiveTypeId.JSON_DOCUMENT]: "JsonDocument",
    [Type_PrimitiveTypeId.UUID]: "Uuid",
    [Type_PrimitiveTypeId.DATE]: "Date",
    [Type_PrimitiveTypeId.DATETIME]: "Datetime",
    [Type_PrimitiveTypeId.TIMESTAMP]: "Timestamp",
    [Type_PrimitiveTypeId.INTERVAL]: "Interval",
    [Type_PrimitiveTypeId.TZ_DATE]: "TzDate",
    [Type_PrimitiveTypeId.TZ_DATETIME]: "TzDatetime",
    [Type_PrimitiveTypeId.TZ_TIMESTAMP]: "TzTimestamp",
    [Type_PrimitiveTypeId.DATE32]: "Date32",
    [Type_PrimitiveTypeId.DATETIME64]: "Datetime64",
    [Type_PrimitiveTypeId.TIMESTAMP64]: "Timestamp64",
    [Type_PrimitiveTypeId.INTERVAL64]: "Interval64",
    [Type_PrimitiveTypeId.DYNUMBER]: "DyNumber",
  };
  const name = names[typeId];
  if (!name) {
    throw new Error(`Unsupported YDB primitive result type: ${typeId}`);
  }
  return name;
}

function createQueryDriver(connectionString: string, options: DriverOptions): QueryDriver {
  const driver = new Driver(connectionString, options);
  return {
    ready: (signal) => driver.ready(signal),
    createClient: (definition, nodeId) => driver.createClient(
      definition,
      nodeId,
    ) as unknown as QueryServiceClient,
    close: () => driver.close(),
  };
}

function driverOptions(request: QueryServiceSdkRequest): DriverOptions {
  const credentialsProvider = request.rootPassword
    ? new StaticCredentialsProvider({
        username: request.rootUser ?? "root",
        password: request.rootPassword,
      }, request.endpoint)
    : new AnonymousCredentialsProvider();
  return {
    credentialsProvider,
    "ydb.sdk.ready_timeout_ms": request.timeoutMs,
    "ydb.sdk.enable_discovery": false,
  };
}

function buildExecuteRequest(
  request: QueryServiceSdkRequest,
  sessionId: string,
): Record<string, unknown> {
  const executeRequest: Record<string, unknown> = {
    sessionId,
    execMode: request.mode === "explain" ? ExecMode.EXPLAIN : ExecMode.EXECUTE,
    query: {
      case: "queryContent",
      value: {
        syntax: Syntax.YQL_V1,
        text: request.script,
      },
    },
    parameters: request.parameters,
    statsMode: request.mode === "explain" ? StatsMode.FULL : StatsMode.NONE,
    concurrentResultSets: false,
    responsePartLimitBytes: 0n,
    poolId: "",
    statsPeriodMs: 0n,
    schemaInclusionMode: SchemaInclusionMode.ALWAYS,
    resultSetFormat: ResultSet_Format.VALUE,
  };
  if (request.mode === "snapshotReadOnly") {
    executeRequest.txControl = {
      txSelector: {
        case: "beginTx",
        value: {
          txMode: {
            case: "snapshotReadOnly",
            value: {},
          },
        },
      },
      commitTx: true,
    };
  }
  return executeRequest;
}

function ensureSuccess(response: QueryResponse, action: string): void {
  if (response.status !== StatusIds_StatusCode.SUCCESS) {
    throw new Error(`Query Service failed to ${action}`);
  }
}

async function monitorAttachedSession(
  iterator: AsyncIterator<QueryResponse>,
  controller: AbortController,
  isExecutionFinished: () => boolean,
  onFailure: () => void,
): Promise<void> {
  try {
    for (;;) {
      const state = await iterator.next();
      if (state.done) {
        if (!isExecutionFinished()) {
          onFailure();
          controller.abort(new Error("Query Service attach stream ended"));
        }
        return;
      }
      ensureSuccess(state.value, "maintain attached session");
    }
  } catch (error) {
    if (!isExecutionFinished() && !controller.signal.aborted) {
      onFailure();
      controller.abort(error);
    }
  }
}
