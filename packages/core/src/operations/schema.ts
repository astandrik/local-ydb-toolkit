import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Driver } from "@ydbjs/core";
import { ExplainYqlRequest_Mode, ScriptingServiceDefinition } from "@ydbjs/api/scripting";
import {
  OperationParams_OperationMode,
  OperationServiceDefinition,
  StatusIds_StatusCode,
  type Operation,
} from "@ydbjs/api/operation";
import { AnonymousCredentialsProvider } from "@ydbjs/auth/anonymous";
import { StaticCredentialsProvider } from "@ydbjs/auth/static";
import { YDBError } from "@ydbjs/error";
import { bash, shellQuote } from "../api-client.js";
import type { ResolvedLocalYdbProfile } from "../validation.js";
import { capText, normalizeMaxOutputBytes } from "./output.js";
import type {
  ApplySchemaOptions,
  ApplySchemaResponse,
  OperationPlan,
  SchemaOperationResult,
  SchemaSdkExecuteRequest,
  SchemaSdkExecuteResult,
  SchemaStatementKind,
  ToolkitContext,
} from "./types.js";

const DEFAULT_SCHEMA_TIMEOUT_MS = 120_000;
const MAX_SCHEMA_TIMEOUT_MS = 600_000;
export const MAX_SCHEMA_SCRIPT_CHARS = 1_048_576;
const SSH_TUNNEL_READY_TIMEOUT_MS = 12_000;
const SSH_TUNNEL_READY_POLL_MS = 100;
const SSH_TUNNEL_CONNECT_TIMEOUT_MS = 250;
const ALLOWED_STATEMENT_MESSAGE = "Only PRAGMA, CREATE TABLE, ALTER TABLE, and DROP TABLE schema statements are supported by local_ydb_apply_schema v1.";

export async function applySchema(
  ctx: ToolkitContext,
  options: ApplySchemaOptions,
): Promise<ApplySchemaResponse> {
  const action = options.action ?? "validate";
  if (action !== "validate" && action !== "apply") {
    throw new Error(`Unsupported schema action: ${String(action)}`);
  }
  const script = validateScript(options.script);
  const databasePath = normalizeDatabasePath(ctx, options.databasePath);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const maxOutputBytes = normalizeMaxOutputBytes(options.maxOutputBytes);
  const schemaAnalysis = analyzeSchemaScript(script);
  const statements = {
    count: schemaAnalysis.count,
    kinds: schemaAnalysis.kinds,
  };
  const scriptSha256 = createHash("sha256").update(script).digest("hex");
  const risk = schemaRisk(action, statements.kinds, schemaAnalysis.hasDestructiveAlterDrop);
  const plannedCommands = schemaPlannedCommands(action, databasePath, scriptSha256);
  const rollback = schemaRollback(statements.kinds);
  const verification = schemaVerification(databasePath);
  const sdkExecutor = options.sdkExecutor ?? executeSchemaWithSdk;

  return withSchemaConnection(ctx, databasePath, timeoutMs, sdkExecutor, async (baseRequest) => {
    const validation = normalizeSchemaResult(
      await sdkExecutor({ ...baseRequest, mode: "validate", script }),
      maxOutputBytes,
    );
    if (action === "validate") {
      return {
        summary: validation.ok
          ? `Schema DDL validation for ${databasePath} succeeded.`
          : `Schema DDL validation for ${databasePath} failed.`,
        action,
        databasePath,
        executed: false,
        risk,
        plannedCommands,
        rollback,
        verification,
        scriptSha256,
        statements,
        validation,
        maxOutputBytes,
      };
    }

    if (!validation.ok || !options.confirm) {
      return {
        summary: validation.ok
          ? `Schema DDL apply for ${databasePath} planned. Not executed because confirm=true was not provided.`
          : `Schema DDL apply for ${databasePath} was not executed because validation failed.`,
        action,
        databasePath,
        executed: false,
        risk,
        plannedCommands,
        rollback,
        verification,
        scriptSha256,
        statements,
        validation,
        maxOutputBytes,
      };
    }

    const execution = normalizeSchemaResult(
      await sdkExecutor({ ...baseRequest, mode: "execute", script }),
      maxOutputBytes,
    );
    return {
      summary: execution.ok
        ? `Schema DDL apply for ${databasePath} succeeded.`
        : `Schema DDL apply for ${databasePath} failed.`,
      action,
      databasePath,
      executed: true,
      risk,
      plannedCommands,
      rollback,
      verification,
      scriptSha256,
      statements,
      validation,
      execution,
      maxOutputBytes,
    };
  });
}

function validateScript(script: string | undefined): string {
  if (typeof script !== "string" || script.trim().length === 0) {
    throw new Error("script must be a non-empty YDB DDL string");
  }
  if (script.length > MAX_SCHEMA_SCRIPT_CHARS) {
    throw new Error(`script must be at most ${MAX_SCHEMA_SCRIPT_CHARS} characters`);
  }
  return script;
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

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_SCHEMA_TIMEOUT_MS;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SCHEMA_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be a positive integer no greater than ${MAX_SCHEMA_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function analyzeSchemaScript(script: string): { count: number; kinds: SchemaStatementKind[]; hasDestructiveAlterDrop: boolean } {
  const statements = splitStatements(script)
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length === 0) {
    throw new Error("script must contain at least one schema statement");
  }

  return {
    count: statements.length,
    kinds: uniqueStatementKinds(statements.map(statementKind)),
    hasDestructiveAlterDrop: statements.some(isDestructiveAlterDrop),
  };
}

function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | "\"" | "`" | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index] ?? "";
    const next = script[index + 1] ?? "";

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        current += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
        current += " ";
      }
      continue;
    }
    if (!quote && char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!quote && char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    current += char;
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = undefined;
        }
      } else if (char === "\\" && (quote === "'" || quote === "\"") && next) {
        current += next;
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === ";") {
      statements.push(current.slice(0, -1));
      current = "";
    }
  }
  if (current.trim()) {
    statements.push(current);
  }
  return statements;
}

function statementKind(statement: string): SchemaStatementKind {
  const tokens = statementTokens(statement);
  const first = tokens[0];
  const second = tokens[1];

  if (first === "PRAGMA") {
    return "PRAGMA";
  }
  if (first === "CREATE" && second === "TABLE") {
    return "CREATE TABLE";
  }
  if (first === "ALTER" && second === "TABLE") {
    return "ALTER TABLE";
  }
  if (first === "DROP" && second === "TABLE") {
    return "DROP TABLE";
  }
  throw new Error(`${ALLOWED_STATEMENT_MESSAGE} Unsupported statement starts with ${tokens.slice(0, 2).join(" ") || "empty input"}.`);
}

function statementTokens(statement: string): string[] {
  const tokens: string[] = [];
  let quote: "'" | "\"" | "`" | undefined;
  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index] ?? "";
    const next = statement[index + 1] ?? "";

    if (quote) {
      if (char === quote) {
        if (next === quote) {
          index += 1;
        } else {
          quote = undefined;
        }
      } else if (char === "\\" && (quote === "'" || quote === "\"") && next) {
        index += 1;
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < statement.length && /[A-Za-z0-9_-]/.test(statement[end] ?? "")) {
        end += 1;
      }
      tokens.push(statement.slice(index, end).replace(/^\uFEFF/, "").toUpperCase());
      index = end - 1;
    }
  }
  return tokens.filter(Boolean);
}

function uniqueStatementKinds(kinds: SchemaStatementKind[]): SchemaStatementKind[] {
  const ordered: SchemaStatementKind[] = [];
  for (const kind of kinds) {
    if (!ordered.includes(kind)) {
      ordered.push(kind);
    }
  }
  return ordered;
}

function isDestructiveAlterDrop(statement: string): boolean {
  const tokens = statementTokens(statement);
  return tokens[0] === "ALTER" && tokens[1] === "TABLE" && tokens.includes("DROP");
}

function schemaRisk(
  action: "validate" | "apply",
  kinds: SchemaStatementKind[],
  hasDestructiveAlterDrop = false,
): OperationPlan["risk"] {
  if (action === "validate") {
    return "low";
  }
  return kinds.includes("DROP TABLE") || hasDestructiveAlterDrop ? "high" : "medium";
}

function schemaPlannedCommands(action: "validate" | "apply", databasePath: string, scriptSha256: string): string[] {
  const commands = [`Validate YDB schema DDL sha256:${scriptSha256} at ${databasePath} with the YDB JS SDK`];
  if (action === "apply") {
    commands.push(`Apply YDB schema DDL sha256:${scriptSha256} to ${databasePath} with the YDB JS SDK`);
  }
  return commands;
}

function schemaRollback(kinds: SchemaStatementKind[]): string[] {
  if (kinds.includes("DROP TABLE")) {
    return ["No automatic rollback is available for DROP TABLE; restore the tenant from a known-good dump or recreate the dropped table and data explicitly."];
  }
  return ["No automatic rollback is available for schema DDL; apply an explicit inverse DDL change or restore from a known-good dump if needed."];
}

function schemaVerification(databasePath: string): string[] {
  return [
    `local_ydb_scheme action=list path=${databasePath}`,
    "Describe changed tables with local_ydb_scheme action=describe",
    "Run an application-level smoke read/write against the changed schema",
  ];
}

function normalizeSchemaResult(result: SchemaSdkExecuteResult, maxOutputBytes: number): SchemaOperationResult {
  const issues = capText(result.issues, maxOutputBytes);
  return {
    ok: result.ok,
    status: result.status,
    issues: issues.text,
    issuesBytes: issues.bytes,
    issuesTruncated: issues.truncated,
  };
}

async function withSchemaConnection<T>(
  ctx: ToolkitContext,
  databasePath: string,
  timeoutMs: number,
  sdkExecutor: (request: SchemaSdkExecuteRequest) => Promise<SchemaSdkExecuteResult>,
  run: (request: Omit<SchemaSdkExecuteRequest, "mode" | "script">) => Promise<T>,
): Promise<T> {
  const password = await readRootPassword(ctx);
  const remotePort = schemaGrpcPort(ctx, databasePath);
  const endpointPath = databasePath;

  if (ctx.profile.mode !== "ssh" || sdkExecutor !== executeSchemaWithSdk) {
    const endpoint = `grpc://127.0.0.1:${remotePort}`;
    return run({
      connectionString: `${endpoint}${endpointPath}`,
      databasePath,
      endpoint,
      timeoutMs,
      rootUser: password ? ctx.profile.rootUser : undefined,
      rootPassword: password,
    });
  }

  const localPort = await allocateLocalPort();
  const tunnel = await startSshTunnel(ctx.profile, localPort, remotePort);
  try {
    const endpoint = `grpc://127.0.0.1:${localPort}`;
    return await run({
      connectionString: `${endpoint}${endpointPath}`,
      databasePath,
      endpoint,
      timeoutMs,
      rootUser: password ? ctx.profile.rootUser : undefined,
      rootPassword: password,
    });
  } finally {
    tunnel.kill("SIGTERM");
  }
}

function schemaGrpcPort(ctx: ToolkitContext, databasePath: string): number {
  const { rootDatabase, tenantPath, ports } = ctx.profile;
  if (databasePath === tenantPath || databasePath.startsWith(`${tenantPath}/`)) {
    return ports.dynamicGrpc;
  }
  if (databasePath === rootDatabase || databasePath.startsWith(`${rootDatabase}/`)) {
    return ports.staticGrpc;
  }
  return ports.dynamicGrpc;
}

async function readRootPassword(ctx: ToolkitContext): Promise<string | undefined> {
  const file = ctx.profile.rootPasswordFile;
  if (!file) {
    return undefined;
  }
  if (ctx.profile.mode === "ssh") {
    const result = await ctx.client.run(bash(`cat ${shellQuote(file)}`, {
      description: "Read YDB root password file",
      redactions: [file],
    }));
    if (!result.ok) {
      throw new Error("Failed to read configured YDB root password file from the target profile");
    }
    return result.stdout.trimEnd();
  }
  try {
    return readFileSync(file, "utf8").trimEnd();
  } catch {
    throw new Error("Failed to read configured YDB root password file from the target profile");
  }
}

async function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local SSH tunnel port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function startSshTunnel(
  profile: ResolvedLocalYdbProfile,
  localPort: number,
  remotePort: number,
): Promise<ChildProcessWithoutNullStreams> {
  const ssh = profile.ssh;
  if (!ssh) {
    throw new Error("ssh profile settings are required");
  }
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ExitOnForwardFailure=yes",
    "-N",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
  ];
  if (ssh.port) {
    args.push("-p", String(ssh.port));
  }
  if (ssh.identityFile) {
    args.push("-i", ssh.identityFile);
  }
  args.push(ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host);

  const child = spawn("ssh", args);
  child.stdout.resume();
  child.stderr.resume();
  try {
    await waitForSshTunnelReady(child, localPort);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return child;
}

async function waitForSshTunnelReady(child: ChildProcessWithoutNullStreams, localPort: number): Promise<void> {
  let childFailure: Error | undefined;
  const onError = () => {
    childFailure = new Error("Failed to start SSH tunnel for YDB schema operation");
  };
  const onExit = () => {
    childFailure = new Error("Failed to establish SSH tunnel for YDB schema operation");
  };
  child.once("error", onError);
  child.once("exit", onExit);
  try {
    const deadline = Date.now() + SSH_TUNNEL_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (childFailure) {
        throw childFailure;
      }
      if (child.exitCode !== null) {
        throw new Error("Failed to establish SSH tunnel for YDB schema operation");
      }
      if (await canConnectToLocalPort(localPort)) {
        return;
      }
      await delay(SSH_TUNNEL_READY_POLL_MS);
    }
    throw new Error("Timed out establishing SSH tunnel for YDB schema operation");
  } finally {
    child.off("error", onError);
    child.off("exit", onExit);
  }
}

function canConnectToLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(SSH_TUNNEL_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export async function executeSchemaWithSdk(request: SchemaSdkExecuteRequest): Promise<SchemaSdkExecuteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const credentialsProvider = request.rootPassword
    ? new StaticCredentialsProvider({
        username: request.rootUser ?? "root",
        password: request.rootPassword,
      }, request.endpoint)
    : new AnonymousCredentialsProvider();
  const driver = new Driver(request.connectionString, {
    credentialsProvider,
    "ydb.sdk.ready_timeout_ms": request.timeoutMs,
    "ydb.sdk.enable_discovery": false,
  });

  try {
    await driver.ready(controller.signal);
    const scriptingClient = driver.createClient(ScriptingServiceDefinition);
    const operationClient = driver.createClient(OperationServiceDefinition);
    const operation = request.mode === "validate"
      ? (await scriptingClient.explainYql({
          script: request.script,
          mode: ExplainYqlRequest_Mode.VALIDATE,
          operationParams: asyncOperationParams(request.timeoutMs),
        }, { signal: controller.signal })).operation
      : (await scriptingClient.executeYql({
          script: request.script,
          operationParams: asyncOperationParams(request.timeoutMs),
        }, { signal: controller.signal })).operation;
    if (!operation) {
      return {
        ok: false,
        status: "CLIENT_ERROR",
        issues: "YDB scripting response did not include an operation.",
      };
    }
    return await pollSchemaOperation(
      (id) => operationClient.getOperation({ id }, { signal: controller.signal }),
      operation,
      controller.signal,
    );
  } catch (error) {
    return sdkErrorResult(error);
  } finally {
    clearTimeout(timer);
    driver.close();
  }
}

function asyncOperationParams(timeoutMs: number) {
  return {
    operationMode: OperationParams_OperationMode.ASYNC,
    cancelAfter: durationFromMs(timeoutMs),
  };
}

async function pollSchemaOperation(
  getOperation: (id: string) => Promise<{ operation?: Operation }>,
  initialOperation: Operation,
  signal: AbortSignal,
): Promise<SchemaSdkExecuteResult> {
  let operation = initialOperation;
  while (!operation.ready) {
    if (!operation.id) {
      return operationResult(operation, "YDB schema operation was not ready and did not return an operation id.");
    }
    await delay(250, undefined, { signal });
    const response = await getOperation(operation.id);
    if (!response.operation) {
      return operationResult(operation, "YDB GetOperation response did not include an operation.");
    }
    operation = response.operation;
  }
  return operationResult(operation);
}

function operationResult(operation: Operation, extraIssue?: string): SchemaSdkExecuteResult {
  const issues = [issueText(operation.issues), extraIssue].filter(Boolean).join("\n");
  return {
    ok: operation.ready && operation.status === StatusIds_StatusCode.SUCCESS,
    status: statusName(operation.status),
    issues,
  };
}

function durationFromMs(timeoutMs: number): { seconds: bigint; nanos: number } {
  return {
    seconds: BigInt(Math.floor(timeoutMs / 1000)),
    nanos: (timeoutMs % 1000) * 1_000_000,
  };
}

function sdkErrorResult(error: unknown): SchemaSdkExecuteResult {
  if (error instanceof YDBError) {
    return {
      ok: false,
      status: statusName(error.code),
      issues: error.message,
    };
  }
  return {
    ok: false,
    status: "CLIENT_ERROR",
    issues: error instanceof Error ? error.message : String(error),
  };
}

function statusName(status: StatusIds_StatusCode): string {
  return StatusIds_StatusCode[status] ?? String(status);
}

function issueText(issues: Array<{ message?: string; issueCode?: number; severity?: number; issues?: unknown[] }>): string {
  return issues.map(formatIssue).filter(Boolean).join("\n");
}

function formatIssue(issue: { message?: string; issueCode?: number; severity?: number; issues?: unknown[] }): string {
  const head = [
    issue.severity === undefined ? undefined : `severity=${issue.severity}`,
    issue.issueCode === undefined ? undefined : `code=${issue.issueCode}`,
    issue.message,
  ].filter(Boolean).join(" ");
  const children = (issue.issues ?? [])
    .map((child) => formatIssue(child as { message?: string; issueCode?: number; severity?: number; issues?: unknown[] }))
    .filter(Boolean);
  return [head, ...children].filter(Boolean).join("\n");
}
