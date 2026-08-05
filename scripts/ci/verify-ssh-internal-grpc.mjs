import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  cleanupSshInternalGrpcFixture,
  prepareSshInternalGrpcFixture,
} from "./prepare-ssh-internal-grpc-fixture.mjs";

const profile = "ci-ssh-internal-grpc";
const safeSqlDiagnosticKinds = new Map([
  ["Remote YDB credential read failed.", "remoteCredentialRead"],
  ["Docker SDK target resolution failed.", "dockerTargetResolution"],
  ["SSH listener setup failed.", "sshListenerSetup"],
  ["YDB target readiness check failed.", "ydbTargetReadiness"],
  ["Query Service connection setup failed.", "connectionSetup"],
  ["Query Service session creation failed.", "sessionCreation"],
  ["Query Service session attach failed.", "sessionAttach"],
  ["Query execution failed.", "queryExecution"],
  ["Query Service returned a non-success status.", "nonSuccessStatus"],
  ["Query Service stream ended without a final status.", "streamEnded"],
  ["Query Service attached session was lost before final query status.", "sessionLost"],
]);
const fixture = await prepareSshInternalGrpcFixture();
const stderrChunks = [];
let client;
let tempDir;
let primaryError;
let cleanupError;

try {
  tempDir = await mkdtemp(join(tmpdir(), "local-ydb-ssh-internal-grpc-"));
  const configPath = join(tempDir, "local-ydb.config.json");
  const mcpServerPath = resolve("packages/mcp-server/dist/index.js");
  const config = {
    defaultProfile: profile,
    profiles: {
      [profile]: {
        mode: "ssh",
        ssh: {
          host: "127.0.0.1",
          user: fixture.sshUser,
          port: fixture.sshPort,
          identityFile: fixture.identityFile,
        },
        image: fixture.image,
        staticContainer: fixture.staticContainer,
        dynamicContainer: fixture.dynamicContainer,
        network: fixture.network,
        volume: fixture.volume,
        tenantPath: fixture.database,
        rootUser: fixture.rootUser,
        rootPasswordFile: fixture.remotePasswordFile,
        monitoringBaseUrl: "http://127.0.0.1:1",
        dumpHostPath: join(tempDir, "dumps"),
        ports: {
          staticGrpc: fixture.staticGrpcPort,
          dynamicGrpc: fixture.dynamicGrpcPort,
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const transportEnv = {
    ...stringEnv(process.env),
    PATH: `${fixture.sshBin}:${process.env.PATH ?? ""}`,
    LOCAL_YDB_TOOLKIT_CONFIG: configPath,
    LOCAL_YDB_MCP_CONTENT_FORMAT: "json",
  };
  delete transportEnv.SSH_AUTH_SOCK;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    cwd: process.cwd(),
    env: transportEnv,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  client = new Client(
    { name: "local-ydb-toolkit-ssh-ci", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport, { timeout: 60_000 });

  const query = await callTool(client, "local_ydb_sql", {
    profile,
    action: "query",
    script: "SELECT $value AS value;",
    parameters: {
      value: {
        type: { kind: "primitive", name: "Int32" },
        value: 42,
      },
    },
  });
  assert(
    query.outcome === "succeeded"
      && query.execution?.completion === "success"
      && query.parameterTypes?.value === "Int32"
      && query.resultSets?.[0]?.rows?.[0]?.[0] === 42,
    `SSH SnapshotRO query did not return 42 (${JSON.stringify(safeSqlState(query))}).`,
  );
  await assertNoTunnelProcesses(fixture.identityFile);

  const explain = await callTool(client, "local_ydb_sql", {
    profile,
    action: "explain",
    script: "SELECT 1 AS value;",
  });
  assert(
    explain.outcome === "succeeded"
      && explain.execution?.completion === "success"
      && (nonEmpty(explain.execution?.queryPlan) || nonEmpty(explain.execution?.queryAst)),
    "SSH standalone EXPLAIN did not return a plan or AST.",
  );
  await assertNoTunnelProcesses(fixture.identityFile);

  const planOnly = await callTool(client, "local_ydb_sql", {
    profile,
    action: "execute",
    script: "SELECT 1 AS value;",
    confirm: false,
  });
  assert(
    planOnly.executed === false
      && planOnly.outcome === "planned"
      && planOnly.confirmationRequired === true
      && planOnly.confirmationConsumed === false
      && planOnly.preflight?.completion === "success"
      && planOnly.execution === undefined,
    "SSH plan-only execute did not stop after mandatory EXPLAIN.",
  );
  await assertNoTunnelProcesses(fixture.identityFile);

  const schemaValidation = await callTool(client, "local_ydb_apply_schema", {
    profile,
    action: "validate",
    script: [
      "CREATE TABLE `issue_120_schema_validate` (",
      "  `id` Uint64 NOT NULL,",
      "  PRIMARY KEY (`id`)",
      ");",
    ].join("\n"),
  });
  assert(
    schemaValidation.action === "validate"
      && schemaValidation.executed === false
      && schemaValidation.validation?.ok === true,
    "SSH schema validation failed.",
  );
  await assertNoTunnelProcesses(fixture.identityFile);

  const timedOut = await callTool(client, "local_ydb_sql", {
    profile,
    action: "query",
    script: "SELECT 1;",
    timeoutMs: 1,
  });
  assert(timedOut.outcome !== "succeeded", "The one-millisecond SSH query unexpectedly succeeded.");
  await assertNoTunnelProcesses(fixture.identityFile);

  const caller = new AbortController();
  const abortedCall = callTool(client, "local_ydb_sql", {
    profile,
    action: "query",
    script: "SELECT 1;",
  }, { signal: caller.signal }).then(
    () => "fulfilled",
    () => "rejected",
  );
  let abortedTunnelPort;
  try {
    abortedTunnelPort = await waitForTunnelProcess(fixture.identityFile);
    caller.abort();
    const aborted = await abortedCall;
    assert(aborted === "rejected", "The MCP SQL call ignored caller cancellation.");
  } finally {
    caller.abort();
    await abortedCall;
  }
  await assertNoTunnelProcesses(fixture.identityFile);
  await assertPortClosed(abortedTunnelPort);

  const password = (await readFile(fixture.localPasswordFile, "utf8")).replace(/\r?\n$/, "");
  assert(password.length > 0, "The authenticated fixture password is empty.");
  const serialized = JSON.stringify({ query, explain, planOnly, schemaValidation, timedOut });
  assertNoSensitiveText(serialized, fixture, password, "tool response", [tempDir]);
} catch (error) {
  primaryError = error;
} finally {
  if (client) {
    await client.close().catch((error) => {
      cleanupError ??= error;
    });
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch((error) => {
      cleanupError ??= error;
    });
  }
  await cleanupSshInternalGrpcFixture(fixture).catch((error) => {
    cleanupError ??= error;
  });
}

const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
let stderrError;
if (stderr) {
  try {
    const password = (await readFile(fixture.localPasswordFile, "utf8")).replace(/\r?\n$/, "");
    assertNoSensitiveText(stderr, fixture, password, "MCP stderr", [tempDir]);
    console.log(`MCP stderr was captured (${Buffer.byteLength(stderr)} bytes) and suppressed.`);
  } catch (error) {
    stderrError = error;
  }
}

const failures = [primaryError, cleanupError, stderrError].filter(Boolean);
if (failures.length === 1) {
  throw failures[0];
}
if (failures.length > 1) {
  throw new AggregateError(failures, "SSH Docker-internal gRPC integration failed.");
}
console.log("Authenticated SSH Docker-internal gRPC integration passed.");

async function callTool(clientInstance, name, args, requestOptions = {}) {
  console.log(`::group::tools/call ${name}`);
  try {
    const result = await clientInstance.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 180_000, ...requestOptions },
    );
    if (result.isError) {
      throw new Error(`${name} returned an MCP error.`);
    }
    const data = "structuredContent" in result
      ? result.structuredContent
      : result.toolResult;
    assertPlainObject(data, `${name} did not return structured content.`);
    console.log(JSON.stringify({ tool: name, structuredContent: true }));
    return data;
  } finally {
    console.log("::endgroup::");
  }
}

async function assertNoTunnelProcesses(identityFile) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await currentTunnelPort(identityFile) === undefined) {
      return;
    }
    await delay(50);
  }
  throw new Error("An SSH tunnel process remained after the MCP operation completed.");
}

async function waitForTunnelProcess(identityFile) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = await currentTunnelPort(identityFile);
    if (port !== undefined) {
      return port;
    }
    await delay(10);
  }
  throw new Error("The cancellable MCP call completed before an SSH tunnel was observed.");
}

async function currentTunnelPort(identityFile) {
  const result = await run("ps", ["-ww", "-eo", "args="]);
  const tunnel = result.stdout.split(/\r?\n/).find((line) =>
    line.includes("ssh")
    && line.includes("ExitOnForwardFailure=yes")
    && line.includes(identityFile));
  if (!tunnel) {
    return undefined;
  }
  const match = /127\.0\.0\.1:(\d+):(?:127\.0\.0\.1|(?:\d{1,3}\.){3}\d{1,3}):\d+/.exec(tunnel);
  if (!match) {
    throw new Error("The SSH tunnel command did not contain a recognizable forwarding address.");
  }
  return Number(match[1]);
}

async function assertPortClosed(port) {
  const open = await new Promise((resolvePromise) => {
    const socket = new Socket();
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
  if (open) {
    throw new Error(`SSH listener ${port} remained after caller cancellation.`);
  }
}

async function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.resume();
    child.once("error", rejectPromise);
    child.once("close", (exitCode) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
      };
      if (exitCode === 0) {
        resolvePromise(result);
      } else {
        rejectPromise(new Error(`${command} failed with exit code ${exitCode}.`));
      }
    });
  });
}

function assertNoSensitiveText(text, fixtureValue, password, label, extraSensitive = []) {
  for (const sensitive of [
    fixtureValue.fixtureDir,
    fixtureValue.identityFile,
    fixtureValue.localPasswordFile,
    fixtureValue.remotePasswordFile,
    fixtureValue.staticTargetAddress,
    password,
    ...extraSensitive,
  ]) {
    if (sensitive && text.includes(sensitive)) {
      throw new Error(`Sensitive fixture data leaked into ${label}.`);
    }
  }
  if (/\b127\.0\.0\.1:\d+\b/.test(text)) {
    throw new Error(`An SSH forwarding address leaked into ${label}.`);
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function safeSqlState(response) {
  const resultSets = Array.isArray(response.resultSets) ? response.resultSets : [];
  const rows = Array.isArray(resultSets[0]?.rows) ? resultSets[0].rows : [];
  const cell = Array.isArray(rows[0]) ? rows[0][0] : undefined;
  const diagnostic = response.execution?.diagnostics;
  return {
    outcome: safeEnum(
      response.outcome,
      ["planned", "succeeded", "partial", "failed", "unknown"],
    ),
    completion: safeEnum(
      response.execution?.completion,
      ["success", "partial", "cancelled", "failed", "mutationStatusUnknown"],
    ),
    parameterType: response.parameterTypes?.value === "Int32" ? "Int32" : "unexpected",
    diagnosticKind: typeof diagnostic === "string"
      ? safeSqlDiagnosticKinds.get(diagnostic) ?? "unexpected"
      : "none",
    resultSetCount: resultSets.length,
    firstResultRowCount: rows.length,
    firstCellType: safeValueType(cell),
  };
}

function safeEnum(value, allowed) {
  return typeof value === "string" && allowed.includes(value) ? value : "unexpected";
}

function safeValueType(value) {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function stringEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter((entry) => typeof entry[1] === "string"),
  );
}

function assertPlainObject(value, message) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), message);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
