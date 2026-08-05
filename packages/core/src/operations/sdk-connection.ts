import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection, createServer, isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Driver, type DriverOptions } from "@ydbjs/core";
import { AnonymousCredentialsProvider } from "@ydbjs/auth/anonymous";
import { StaticCredentialsProvider } from "@ydbjs/auth/static";
import { bash, shellQuote } from "../api-client.js";
import type { ResolvedLocalYdbProfile } from "../validation.js";
import {
  SdkConnectionPhaseError,
  type SdkConnectionPhase,
} from "./sdk-connection-errors.js";
import type { ToolkitContext } from "./types.js";

export const DEFAULT_SDK_TIMEOUT_MS = 120_000;
export const MAX_SDK_TIMEOUT_MS = 600_000;
const SSH_TUNNEL_READY_TIMEOUT_MS = 12_000;
const SSH_TUNNEL_READY_POLL_MS = 100;
const SSH_TUNNEL_CONNECT_TIMEOUT_MS = 250;
const SSH_TUNNEL_SHUTDOWN_GRACE_MS = 1_000;
const DOCKER_CONTAINER_INSPECT_FORMAT = [
  "{\"id\":{{json .Id}},",
  "\"name\":{{json .Name}},",
  "\"networkMode\":{{json .HostConfig.NetworkMode}},",
  "\"networks\":{{json .NetworkSettings.Networks}}}",
].join("");

export interface SdkConnectionRequest {
  connectionString: string;
  databasePath: string;
  endpoint: string;
  timeoutMs: number;
  rootUser?: string;
  rootPassword?: string;
  deadline?: SdkOperationDeadline;
}

export interface SdkOperationDeadline {
  signal: AbortSignal;
  expiresAtMs: number;
}

export interface SdkConnectionOptions {
  databasePath?: string;
  timeoutMs?: number;
  /** Avoid an SSH tunnel when an injected executor does not open an SDK connection. */
  useSshTunnel?: boolean;
  operationLabel?: string;
  deadline?: SdkOperationDeadline;
}

export function normalizeSdkDatabasePath(ctx: ToolkitContext, databasePath: string | undefined): string {
  const path = databasePath === undefined ? ctx.profile.tenantPath : databasePath.trim();
  if (!path) {
    throw new Error("databasePath must be non-empty");
  }
  if (!path.startsWith("/")) {
    throw new Error("databasePath must be an absolute YDB database path");
  }
  validateDatabasePathUrlSegments(path);
  const { rootDatabase } = ctx.profile;
  if (path !== rootDatabase && !path.startsWith(`${rootDatabase}/`)) {
    throw new Error(`databasePath must be ${rootDatabase} or a child path under ${rootDatabase}`);
  }
  return path;
}

function validateDatabasePathUrlSegments(path: string): void {
  if (path.includes("?") || path.includes("#")) {
    throw new Error("databasePath must not contain URL query or fragment separators");
  }
  for (const segment of path.slice(1).split("/")) {
    if (segment.length === 0) {
      throw new Error("databasePath must not contain empty path segments");
    }
    let decodedSegment: string;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      throw new Error("databasePath must contain valid percent encoding");
    }
    if (
      decodedSegment === "."
      || decodedSegment === ".."
      || decodedSegment.includes("/")
      || decodedSegment.includes("\\")
    ) {
      throw new Error("databasePath contains an unsafe URL path segment");
    }
  }
}

export function normalizeSdkTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return DEFAULT_SDK_TIMEOUT_MS;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SDK_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be a positive integer no greater than ${MAX_SDK_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

export function createSdkOperationDeadline(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): SdkOperationDeadline {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: callerSignal
      ? AbortSignal.any([timeoutSignal, callerSignal])
      : timeoutSignal,
    expiresAtMs: Date.now() + timeoutMs,
  };
}

export function remainingSdkOperationTimeoutMs(
  deadline: SdkOperationDeadline,
): number {
  deadline.signal.throwIfAborted();
  const remainingMs = Math.ceil(deadline.expiresAtMs - Date.now());
  if (remainingMs <= 0) {
    throw new Error("SDK operation deadline expired");
  }
  return remainingMs;
}

export async function withSdkConnection<T>(
  ctx: ToolkitContext,
  options: SdkConnectionOptions,
  run: (request: SdkConnectionRequest) => Promise<T>,
): Promise<T> {
  const databasePath = normalizeSdkDatabasePath(ctx, options.databasePath);
  const timeoutMs = normalizeSdkTimeoutMs(options.timeoutMs);
  if (options.deadline) {
    remainingSdkOperationTimeoutMs(options.deadline);
  }
  const password = ctx.profile.mode === "ssh"
    ? await runSdkConnectionPhase(
        "remoteCredentialRead",
        () => readRootPassword(ctx, options.deadline),
      )
    : await readRootPassword(ctx, options.deadline);
  options.deadline?.signal.throwIfAborted();
  const remotePort = sdkGrpcPort(ctx, databasePath);

  if (ctx.profile.mode !== "ssh" || options.useSshTunnel === false) {
    const endpoint = `grpc://127.0.0.1:${remotePort}`;
    return run(sdkConnectionRequest(
      endpoint,
      databasePath,
      operationTimeoutMs(timeoutMs, options.deadline),
      ctx,
      password,
      options.deadline,
    ));
  }

  const targetHost = await runSdkConnectionPhase(
    "dockerTargetResolution",
    () => resolveSshSdkTarget(ctx, databasePath, options.deadline),
  );
  const localPort = await runSdkConnectionPhase(
    "sshListenerSetup",
    () => allocateLocalPort(options.deadline),
  );
  const tunnel = await runSdkConnectionPhase(
    "sshListenerSetup",
    () => startSshTunnel(
      ctx.profile,
      localPort,
      targetHost,
      remotePort,
      options.operationLabel ?? "YDB SDK operation",
      options.deadline,
    ),
  );
  try {
    const endpoint = `grpc://127.0.0.1:${localPort}`;
    const connection = sdkConnectionRequest(
      endpoint,
      databasePath,
      operationTimeoutMs(timeoutMs, options.deadline),
      ctx,
      password,
      options.deadline,
    );
    await runSdkConnectionPhase(
      "ydbTargetReadiness",
      () => probeYdbTarget(connection),
    );
    return await run(connection);
  } finally {
    await stopSshTunnel(tunnel, options.deadline);
  }
}

async function runSdkConnectionPhase<T>(
  phase: SdkConnectionPhase,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SdkConnectionPhaseError) {
      throw error;
    }
    throw new SdkConnectionPhaseError(phase);
  }
}

function sdkConnectionRequest(
  endpoint: string,
  databasePath: string,
  timeoutMs: number,
  ctx: ToolkitContext,
  password: string | undefined,
  deadline: SdkOperationDeadline | undefined,
): SdkConnectionRequest {
  return {
    connectionString: `${endpoint}${databasePath}`,
    databasePath,
    endpoint,
    timeoutMs,
    rootUser: password ? ctx.profile.rootUser : undefined,
    rootPassword: password,
    ...(deadline ? { deadline } : {}),
  };
}

function operationTimeoutMs(
  timeoutMs: number,
  deadline: SdkOperationDeadline | undefined,
): number {
  return deadline ? remainingSdkOperationTimeoutMs(deadline) : timeoutMs;
}

function sdkGrpcPort(ctx: ToolkitContext, databasePath: string): number {
  const { rootDatabase, ports } = ctx.profile;
  if (isTenantDatabasePath(ctx, databasePath)) {
    return ports.dynamicGrpc;
  }
  if (databasePath === rootDatabase || databasePath.startsWith(`${rootDatabase}/`)) {
    return ports.staticGrpc;
  }
  return ports.dynamicGrpc;
}

interface DockerContainerInspect {
  id: string;
  name: string;
  networkMode: string;
  networks: Record<string, unknown>;
}

async function resolveSshSdkTarget(
  ctx: ToolkitContext,
  databasePath: string,
  deadline: SdkOperationDeadline | undefined,
): Promise<string> {
  const tenantTarget = isTenantDatabasePath(ctx, databasePath);
  const targetContainer = tenantTarget
    ? ctx.profile.dynamicContainer
    : ctx.profile.staticContainer;
  const target = await inspectDockerContainer(ctx, targetContainer, deadline);

  if (target.networkMode === "host") {
    return "127.0.0.1";
  }
  if (target.networkMode.startsWith("container:")) {
    if (!tenantTarget) {
      throw new Error("Root SDK target cannot use another container namespace");
    }
    const ownerReference = target.networkMode.slice("container:".length);
    const owner = await inspectDockerContainer(
      ctx,
      ctx.profile.staticContainer,
      deadline,
    );
    if (!matchesContainerReference(
      ownerReference,
      owner,
      ctx.profile.staticContainer,
    )) {
      throw new Error("Dynamic SDK target uses an unexpected container namespace");
    }
    return configuredNetworkAddress(owner, ctx.profile.network);
  }
  return configuredNetworkAddress(target, ctx.profile.network);
}

function isTenantDatabasePath(
  ctx: ToolkitContext,
  databasePath: string,
): boolean {
  return databasePath === ctx.profile.tenantPath
    || databasePath.startsWith(`${ctx.profile.tenantPath}/`);
}

async function inspectDockerContainer(
  ctx: ToolkitContext,
  container: string,
  deadline: SdkOperationDeadline | undefined,
): Promise<DockerContainerInspect> {
  const result = await ctx.client.run(ctx.client.docker(
    [
      "inspect",
      "--type", "container",
      "--format", DOCKER_CONTAINER_INSPECT_FORMAT,
      container,
    ],
    {
      description: "Inspect Docker SDK target",
      ...(deadline
        ? {
            timeoutMs: remainingSdkOperationTimeoutMs(deadline),
            signal: deadline.signal,
          }
        : {}),
    },
  ));
  deadline?.signal.throwIfAborted();
  if (!result.ok) {
    throw new Error("Docker SDK target inspect failed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("Docker SDK target inspect returned invalid JSON");
  }
  const inspect = parseDockerContainerInspect(parsed);
  if (!matchesRequestedContainer(container, inspect)) {
    throw new Error("Docker SDK target inspect returned a different container");
  }
  return inspect;
}

function parseDockerContainerInspect(value: unknown): DockerContainerInspect {
  if (!isRecord(value)) {
    throw new Error("Docker SDK target inspect entry is invalid");
  }
  if (
    typeof value.id !== "string"
    || value.id.length === 0
    || typeof value.name !== "string"
    || value.name.length === 0
    || typeof value.networkMode !== "string"
    || value.networkMode.length === 0
    || !isRecord(value.networks)
  ) {
    throw new Error("Docker SDK target inspect fields are invalid");
  }
  return {
    id: value.id,
    name: value.name.replace(/^\//, ""),
    networkMode: value.networkMode,
    networks: value.networks,
  };
}

function configuredNetworkAddress(
  container: DockerContainerInspect,
  network: string,
): string {
  const networkSettings = container.networks[network];
  if (
    !isRecord(networkSettings)
    || typeof networkSettings.IPAddress !== "string"
    || isIP(networkSettings.IPAddress) !== 4
  ) {
    throw new Error("Docker SDK target does not have a valid IPv4 address");
  }
  return networkSettings.IPAddress;
}

function matchesContainerReference(
  rawReference: string,
  owner: DockerContainerInspect,
  configuredName: string,
): boolean {
  const reference = rawReference.replace(/^\//, "");
  return reference.length > 0 && (
    reference === owner.id
    || (reference.length >= 12 && owner.id.startsWith(reference))
    || reference === owner.name
    || reference === configuredName.replace(/^\//, "")
  );
}

function matchesRequestedContainer(
  rawRequested: string,
  inspect: DockerContainerInspect,
): boolean {
  const requested = rawRequested.replace(/^\//, "");
  return requested === inspect.name
    || requested === inspect.id
    || (requested.length >= 12 && inspect.id.startsWith(requested));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readRootPassword(
  ctx: ToolkitContext,
  deadline: SdkOperationDeadline | undefined,
): Promise<string | undefined> {
  const file = ctx.profile.rootPasswordFile;
  if (!file) {
    return undefined;
  }
  if (ctx.profile.mode === "ssh") {
    const result = await ctx.client.run(bash(`cat ${shellQuote(file)}`, {
      description: "Read YDB root password file",
      redactions: [file],
      ...(deadline
        ? {
            timeoutMs: remainingSdkOperationTimeoutMs(deadline),
            signal: deadline.signal,
          }
        : {}),
    }));
    deadline?.signal.throwIfAborted();
    if (!result.ok) {
      throw new Error("Failed to read configured YDB root password file from the target profile");
    }
    return stripPasswordFileTerminator(result.stdout);
  }
  try {
    return stripPasswordFileTerminator(readFileSync(file, "utf8"));
  } catch {
    throw new Error("Failed to read configured YDB root password file from the target profile");
  }
}

function stripPasswordFileTerminator(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

async function allocateLocalPort(
  deadline: SdkOperationDeadline | undefined,
): Promise<number> {
  deadline?.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      deadline?.signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => {
      if (server.listening) {
        server.close();
      }
      finish(() => reject(deadline?.signal.reason));
    };
    deadline?.signal.addEventListener("abort", onAbort, { once: true });
    server.once("error", (error) => finish(() => reject(error)));
    server.listen(0, "127.0.0.1", () => {
      if (settled) {
        server.close();
        return;
      }
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => finish(() =>
          reject(new Error("Failed to allocate a local SSH tunnel port"))));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          finish(() => reject(error));
        } else {
          finish(() => resolve(port));
        }
      });
    });
  });
}

async function startSshTunnel(
  profile: ResolvedLocalYdbProfile,
  localPort: number,
  targetHost: string,
  remotePort: number,
  operationLabel: string,
  deadline: SdkOperationDeadline | undefined,
): Promise<ChildProcessWithoutNullStreams> {
  const ssh = profile.ssh;
  if (!ssh) {
    throw new Error("ssh profile settings are required");
  }
  deadline?.signal.throwIfAborted();
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ExitOnForwardFailure=yes",
    "-N",
    "-L", `127.0.0.1:${localPort}:${targetHost}:${remotePort}`,
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
    await waitForSshTunnelReady(child, localPort, operationLabel, deadline);
  } catch (error) {
    await stopSshTunnel(child, deadline);
    throw error;
  }
  return child;
}

async function waitForSshTunnelReady(
  child: ChildProcessWithoutNullStreams,
  localPort: number,
  operationLabel: string,
  operationDeadline: SdkOperationDeadline | undefined,
): Promise<void> {
  let childFailure: Error | undefined;
  const onError = () => {
    childFailure = new Error(`Failed to start SSH tunnel for ${operationLabel}`);
  };
  const onExit = () => {
    childFailure = new Error(`Failed to establish SSH tunnel for ${operationLabel}`);
  };
  child.once("error", onError);
  child.once("exit", onExit);
  try {
    const tunnelDeadline = Date.now() + SSH_TUNNEL_READY_TIMEOUT_MS;
    while (Date.now() < tunnelDeadline) {
      operationDeadline?.signal.throwIfAborted();
      if (childFailure) {
        throw childFailure;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Failed to establish SSH tunnel for ${operationLabel}`);
      }
      if (await canConnectToLocalPort(localPort, operationDeadline)) {
        if (
          childFailure
          || child.exitCode !== null
          || child.signalCode !== null
        ) {
          throw childFailure
            ?? new Error(`Failed to establish SSH tunnel for ${operationLabel}`);
        }
        return;
      }
      await delay(
        Math.min(
          SSH_TUNNEL_READY_POLL_MS,
          operationDeadline
            ? remainingSdkOperationTimeoutMs(operationDeadline)
            : SSH_TUNNEL_READY_POLL_MS,
        ),
        undefined,
        operationDeadline ? { signal: operationDeadline.signal } : undefined,
      );
    }
    throw new Error(`Timed out establishing SSH tunnel for ${operationLabel}`);
  } finally {
    child.off("error", onError);
    child.off("exit", onExit);
  }
}

async function probeYdbTarget(request: SdkConnectionRequest): Promise<void> {
  const timeoutMs = Math.min(
    SSH_TUNNEL_READY_TIMEOUT_MS,
    operationTimeoutMs(request.timeoutMs, request.deadline),
  );
  const credentialsProvider = request.rootPassword
    ? new StaticCredentialsProvider({
        username: request.rootUser ?? "root",
        password: request.rootPassword,
      }, request.endpoint)
    : new AnonymousCredentialsProvider();
  const options: DriverOptions = {
    credentialsProvider,
    "ydb.sdk.ready_timeout_ms": timeoutMs,
    "ydb.sdk.discovery_timeout_ms": Math.min(timeoutMs, 10_000),
    "ydb.sdk.enable_discovery": true,
  };
  const driver = new Driver(request.connectionString, options);
  const readySignal = request.deadline
    ? AbortSignal.any([
        request.deadline.signal,
        AbortSignal.timeout(timeoutMs),
      ])
    : AbortSignal.timeout(timeoutMs);
  try {
    await driver.ready(readySignal);
  } finally {
    driver.close();
  }
}

async function stopSshTunnel(
  child: ChildProcessWithoutNullStreams,
  deadline?: SdkOperationDeadline,
): Promise<void> {
  if (
    child.pid === undefined
    || child.exitCode !== null
    || child.signalCode !== null
  ) {
    return;
  }
  if (!signalSshTunnel(child, "SIGTERM")) {
    return;
  }
  const termination = observeChildTermination(child);
  const graceMs = remainingSshTunnelShutdownGraceMs(deadline);
  if (graceMs > 0) {
    const graceController = new AbortController();
    const graceSignal = deadline
      ? AbortSignal.any([graceController.signal, deadline.signal])
      : graceController.signal;
    const stoppedDuringGrace = await Promise.race([
      termination.exited.then(() => true),
      delay(graceMs, undefined, { signal: graceSignal }).then(
        () => false,
        () => false,
      ),
    ]);
    graceController.abort();
    if (stoppedDuringGrace) {
      return;
    }
  }
  if (!signalSshTunnel(child, "SIGKILL")) {
    termination.cancel();
    return;
  }
  await termination.exited;
}

function remainingSshTunnelShutdownGraceMs(
  deadline: SdkOperationDeadline | undefined,
): number {
  if (!deadline) {
    return SSH_TUNNEL_SHUTDOWN_GRACE_MS;
  }
  if (deadline.signal.aborted) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(
      SSH_TUNNEL_SHUTDOWN_GRACE_MS,
      Math.ceil(deadline.expiresAtMs - Date.now()),
    ),
  );
}

function signalSshTunnel(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function observeChildTermination(
  child: ChildProcessWithoutNullStreams,
): { exited: Promise<void>; cancel: () => void } {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: Promise.resolve(), cancel: () => undefined };
  }
  let onExit: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    onExit = resolve;
    child.once("exit", onExit);
  });
  return {
    exited,
    cancel: () => child.off("exit", onExit),
  };
}

function canConnectToLocalPort(
  port: number,
  deadline: SdkOperationDeadline | undefined,
): Promise<boolean> {
  const timeoutMs = Math.min(
    SSH_TUNNEL_CONNECT_TIMEOUT_MS,
    deadline
      ? remainingSdkOperationTimeoutMs(deadline)
      : SSH_TUNNEL_CONNECT_TIMEOUT_MS,
  );
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
