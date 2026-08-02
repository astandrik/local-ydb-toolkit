import { createHash } from "node:crypto";
import type { SqlParameter } from "../sql-parameter-types.js";
import { prepareSqlParameters } from "../sql-parameters.js";
import {
  executeQueryService,
  type QueryServiceExecutionResult,
  type QueryServiceRequest,
  type QueryServiceResultSet,
  type QueryServiceTruncationReason,
} from "../query-service.js";
import {
  createSdkOperationDeadline,
  normalizeSdkDatabasePath,
  normalizeSdkTimeoutMs,
  remainingSdkOperationTimeoutMs,
} from "./sdk-connection.js";
import { normalizeMaxOutputBytes } from "./output.js";
import {
  invalidSqlBackendResult,
  normalizeSqlBackendResult,
} from "./sql-result.js";
import type { ToolkitContext } from "./types.js";

const MAX_SCRIPT_CHARACTERS = 1_048_576;
const DEFAULT_MAX_ROWS = 100;
const MAX_ROWS = 10_000;

export type SqlAction = "query" | "explain" | "execute";
export type SqlOutcome = "planned" | "succeeded" | "partial" | "failed" | "unknown";

export interface SqlOptions {
  action?: SqlAction;
  script: string;
  databasePath?: string;
  timeoutMs?: number;
  maxRows?: number;
  maxOutputBytes?: number;
  parameters?: Record<string, SqlParameter>;
  confirm?: boolean;
  signal?: AbortSignal;
}

export interface SqlLimits {
  timeoutMs: number;
  maxRows: number;
  maxOutputBytes: number;
}

export interface SqlResponse {
  summary: string;
  action: SqlAction;
  databasePath: string;
  scriptSha256: string;
  parameterTypes: Record<string, string>;
  risk: "low" | "high";
  executed: boolean;
  outcome: SqlOutcome;
  confirmationRequired: boolean;
  confirmationConsumed: boolean;
  preflight?: QueryServiceExecutionResult;
  execution?: QueryServiceExecutionResult;
  resultSets: QueryServiceResultSet[];
  limits: SqlLimits;
  outputBytes: number;
  truncated: boolean;
  truncationReasons: QueryServiceTruncationReason[];
  plannedCommands: string[];
  rollback: string[];
  verification: string[];
}

export type SqlBackendExecutor = (
  ctx: ToolkitContext,
  request: QueryServiceRequest,
) => Promise<QueryServiceExecutionResult>;

export async function sql(
  ctx: ToolkitContext,
  options: SqlOptions,
  backendExecutor: SqlBackendExecutor = executeQueryService,
): Promise<SqlResponse> {
  const timeoutMs = normalizeSdkTimeoutMs(options.timeoutMs);
  const deadline = createSdkOperationDeadline(timeoutMs, options.signal);
  const action = normalizeAction(options.action);
  const script = normalizeScript(options.script);
  const maxRows = normalizeMaxRows(options.maxRows);
  const maxOutputBytes = normalizeMaxOutputBytes(options.maxOutputBytes);
  const databasePath = normalizeSdkDatabasePath(ctx, options.databasePath);
  const preparedParameters = prepareSqlParameters(options.parameters ?? {});
  const effectiveScript = preparedParameters.declarationPrefix + script;
  const scriptSha256 = createHash("sha256").update(effectiveScript).digest("hex");
  const limits: SqlLimits = {
    timeoutMs,
    maxRows,
    maxOutputBytes,
  };
  const run = async (
    mode: QueryServiceRequest["mode"],
    captureBudget = maxOutputBytes,
  ): Promise<SqlBackendCall> => {
    let backendCalled = false;
    try {
      const request: QueryServiceRequest = {
        databasePath,
        timeoutMs: remainingSdkOperationTimeoutMs(deadline),
        script: effectiveScript,
        parameters: preparedParameters.typedValues,
        mode,
        maxRows,
        maxOutputBytes: captureBudget,
        signal: deadline.signal,
      };
      backendCalled = true;
      const result = await backendExecutor(ctx, {
        ...request,
      });
      const normalized = normalizeSqlBackendResult(result, {
        captureBudget,
        maxRows,
        diagnosticRedactions: credentialPaths(ctx),
      });
      return {
        backendCalled,
        result: normalized ?? invalidSqlBackendResult(),
      };
    } catch {
      const cancelled = deadline.signal.aborted;
      return {
        backendCalled,
        result: {
          completion: cancelled ? "cancelled" : "failed",
          resultSets: [],
          capturedBytes: 0,
          truncationReasons: [],
          diagnostics: cancelled
            ? "Managed SQL backend request was cancelled."
            : "Managed SQL backend request failed.",
        },
      };
    }
  };
  const common = {
    action,
    databasePath,
    scriptSha256,
    parameterTypes: preparedParameters.parameterTypes,
    limits,
    plannedCommands: logicalPlannedCommands(action, databasePath, scriptSha256),
    rollback: action === "execute"
      ? ["Use a compensating YQL statement if the confirmed mutation must be reverted."]
      : [],
    verification: [
      "Inspect the returned result sets and Query Service completion.",
    ],
  };

  if (action === "query" || action === "explain") {
    const { result: execution } = await run(
      action === "query" ? "snapshotReadOnly" : "explain",
    );
    return responseWithResults({
      ...common,
      summary: readActionSummary(action, execution, databasePath),
      risk: "low",
      executed: true,
      outcome: outcomeFor(execution, false),
      confirmationRequired: false,
      confirmationConsumed: false,
      execution,
      resultSets: execution.resultSets,
      calls: [execution],
    });
  }

  const { result: preflight } = await run("explain");
  if (preflight.completion !== "success") {
    return responseWithResults({
      ...common,
      summary: preflight.completion === "partial"
        ? `Managed YQL execution preflight returned partial output against ${databasePath}; execution was blocked.`
        : `Managed YQL execution was blocked by failed preflight against ${databasePath}.`,
      risk: "high",
      executed: false,
      outcome: preflight.completion === "partial" ? "partial" : "failed",
      confirmationRequired: options.confirm !== true,
      confirmationConsumed: false,
      preflight,
      resultSets: preflight.resultSets,
      calls: [preflight],
    });
  }
  if (options.confirm !== true) {
    return responseWithResults({
      ...common,
      summary: `Planned managed YQL execution against ${databasePath}.`,
      risk: "high",
      executed: false,
      outcome: "planned",
      confirmationRequired: true,
      confirmationConsumed: false,
      preflight,
      resultSets: preflight.resultSets,
      calls: [preflight],
    });
  }

  const executionCall = await run(
    "noTx",
    Math.max(0, maxOutputBytes - preflight.capturedBytes),
  );
  if (!executionCall.backendCalled) {
    return responseWithResults({
      ...common,
      summary: executionCall.result.completion === "cancelled"
        ? `Managed YQL execution was cancelled after preflight against ${databasePath}.`
        : `Managed YQL execution did not start after preflight against ${databasePath}.`,
      risk: "high",
      executed: false,
      outcome: "failed",
      confirmationRequired: false,
      confirmationConsumed: false,
      preflight,
      resultSets: preflight.resultSets,
      calls: [preflight],
    });
  }
  const execution = executionCall.result;
  return responseWithResults({
    ...common,
    summary: mutationSummary(execution, databasePath),
    risk: "high",
    executed: true,
    outcome: outcomeFor(execution, true),
    confirmationRequired: false,
    confirmationConsumed: true,
    preflight,
    execution,
    resultSets: execution.resultSets,
    calls: [preflight, execution],
  });
}

function normalizeAction(action: SqlAction | undefined): SqlAction {
  const normalized = action ?? "query";
  if (
    normalized !== "query"
    && normalized !== "explain"
    && normalized !== "execute"
  ) {
    throw new Error("action must be query, explain, or execute");
  }
  return normalized;
}

function normalizeScript(script: string): string {
  if (typeof script !== "string" || script.trim().length === 0) {
    throw new Error("script must contain at least one non-whitespace character");
  }
  if (script.length > MAX_SCRIPT_CHARACTERS) {
    throw new Error(`script must contain at most ${MAX_SCRIPT_CHARACTERS} characters`);
  }
  return script;
}

function normalizeMaxRows(value: number | undefined): number {
  const maxRows = value ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new Error("maxRows must be a positive integer");
  }
  if (maxRows > MAX_ROWS) {
    throw new Error(`maxRows must be ${MAX_ROWS} or less`);
  }
  return maxRows;
}

interface ResponseWithResultsInput extends Omit<
  SqlResponse,
  "outputBytes" | "truncated" | "truncationReasons"
> {
  calls: QueryServiceExecutionResult[];
}

interface SqlBackendCall {
  backendCalled: boolean;
  result: QueryServiceExecutionResult;
}

function responseWithResults(input: ResponseWithResultsInput): SqlResponse {
  const { calls, ...response } = input;
  const truncationReasons = Array.from(new Set(
    calls.flatMap((call) => call.truncationReasons),
  ));
  return {
    ...response,
    outputBytes: calls.reduce(
      (total, call) => total + call.capturedBytes,
      0,
    ),
    truncated: truncationReasons.length > 0,
    truncationReasons,
  };
}

function logicalPlannedCommands(
  action: SqlAction,
  databasePath: string,
  scriptSha256: string,
): string[] {
  const identity = `${databasePath} (sha256:${scriptSha256})`;
  if (action === "query") {
    return [`Run SnapshotRO managed YQL against ${identity}.`];
  }
  if (action === "explain") {
    return [`Explain managed YQL against ${identity}.`];
  }
  return [
    `Explain managed YQL against ${identity}.`,
    `Execute managed YQL once with NoTx against ${identity}.`,
  ];
}

function outcomeFor(
  result: QueryServiceExecutionResult,
  allowMutationUnknown: boolean,
): SqlOutcome {
  switch (result.completion) {
    case "success":
      return "succeeded";
    case "partial":
      return "partial";
    case "mutationStatusUnknown":
      return allowMutationUnknown ? "unknown" : "failed";
    case "cancelled":
    case "failed":
      return "failed";
  }
}

function readActionSummary(
  action: "query" | "explain",
  result: QueryServiceExecutionResult,
  databasePath: string,
): string {
  const subject = action === "query" ? "query" : "explain";
  switch (result.completion) {
    case "success":
      return action === "query"
        ? `Executed managed YQL query against ${databasePath}.`
        : `Explained managed YQL against ${databasePath}.`;
    case "partial":
      return `Managed YQL ${subject} returned partial output against ${databasePath}.`;
    case "cancelled":
      return `Managed YQL ${subject} was cancelled against ${databasePath}.`;
    case "failed":
    case "mutationStatusUnknown":
      return `Managed YQL ${subject} failed against ${databasePath}.`;
  }
}

function mutationSummary(
  result: QueryServiceExecutionResult,
  databasePath: string,
): string {
  switch (result.completion) {
    case "success":
      return `Executed managed YQL mutation against ${databasePath}.`;
    case "partial":
      return `Managed YQL mutation completed with partial output against ${databasePath}.`;
    case "mutationStatusUnknown":
      return `Managed YQL mutation was sent, but its final status is unknown against ${databasePath}.`;
    case "cancelled":
      return `Managed YQL mutation was cancelled against ${databasePath}.`;
    case "failed":
      return `Managed YQL mutation failed against ${databasePath}.`;
  }
}

function credentialPaths(ctx: ToolkitContext): string[] {
  return [
    ctx.profile.authConfigPath,
    ctx.profile.dynamicNodeAuthTokenFile,
    ctx.profile.rootPasswordFile,
    ctx.profile.ssh?.identityFile,
  ].filter((path): path is string => Boolean(path));
}
