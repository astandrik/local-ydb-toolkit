import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { bash, shellQuote } from "../api-client.js";
import type { ResolvedLocalYdbProfile } from "../validation.js";
import type { ToolkitContext } from "./types.js";

export const DEFAULT_SDK_TIMEOUT_MS = 120_000;
export const MAX_SDK_TIMEOUT_MS = 600_000;
const SSH_TUNNEL_READY_TIMEOUT_MS = 12_000;
const SSH_TUNNEL_READY_POLL_MS = 100;
const SSH_TUNNEL_CONNECT_TIMEOUT_MS = 250;

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
  const { rootDatabase } = ctx.profile;
  if (path !== rootDatabase && !path.startsWith(`${rootDatabase}/`)) {
    throw new Error(`databasePath must be ${rootDatabase} or a child path under ${rootDatabase}`);
  }
  return path;
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
  return Math.max(1, Math.ceil(deadline.expiresAtMs - Date.now()));
}

export async function withSdkConnection<T>(
  ctx: ToolkitContext,
  options: SdkConnectionOptions,
  run: (request: SdkConnectionRequest) => Promise<T>,
): Promise<T> {
  const databasePath = normalizeSdkDatabasePath(ctx, options.databasePath);
  const timeoutMs = normalizeSdkTimeoutMs(options.timeoutMs);
  options.deadline?.signal.throwIfAborted();
  const password = await readRootPassword(ctx, options.deadline);
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

  const localPort = await allocateLocalPort(options.deadline);
  const tunnel = await startSshTunnel(
    ctx.profile,
    localPort,
    remotePort,
    options.operationLabel ?? "YDB SDK operation",
    options.deadline,
  );
  try {
    const endpoint = `grpc://127.0.0.1:${localPort}`;
    return await run(sdkConnectionRequest(
      endpoint,
      databasePath,
      operationTimeoutMs(timeoutMs, options.deadline),
      ctx,
      password,
      options.deadline,
    ));
  } finally {
    tunnel.kill("SIGTERM");
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
  const { rootDatabase, tenantPath, ports } = ctx.profile;
  if (databasePath === tenantPath || databasePath.startsWith(`${tenantPath}/`)) {
    return ports.dynamicGrpc;
  }
  if (databasePath === rootDatabase || databasePath.startsWith(`${rootDatabase}/`)) {
    return ports.staticGrpc;
  }
  return ports.dynamicGrpc;
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
    return result.stdout.trimEnd();
  }
  try {
    return readFileSync(file, "utf8").trimEnd();
  } catch {
    throw new Error("Failed to read configured YDB root password file from the target profile");
  }
}

async function allocateLocalPort(
  deadline: SdkOperationDeadline | undefined,
): Promise<number> {
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
  remotePort: number,
  operationLabel: string,
  deadline: SdkOperationDeadline | undefined,
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
    await waitForSshTunnelReady(child, localPort, operationLabel, deadline);
  } catch (error) {
    child.kill("SIGTERM");
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
      if (child.exitCode !== null) {
        throw new Error(`Failed to establish SSH tunnel for ${operationLabel}`);
      }
      if (await canConnectToLocalPort(localPort, operationDeadline)) {
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

function canConnectToLocalPort(
  port: number,
  deadline: SdkOperationDeadline | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(Math.min(
      SSH_TUNNEL_CONNECT_TIMEOUT_MS,
      deadline
        ? remainingSdkOperationTimeoutMs(deadline)
        : SSH_TUNNEL_CONNECT_TIMEOUT_MS,
    ));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
