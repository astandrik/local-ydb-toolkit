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
}

export interface SdkConnectionOptions {
  databasePath?: string;
  timeoutMs?: number;
  /** Avoid an SSH tunnel when an injected executor does not open an SDK connection. */
  useSshTunnel?: boolean;
  operationLabel?: string;
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

export async function withSdkConnection<T>(
  ctx: ToolkitContext,
  options: SdkConnectionOptions,
  run: (request: SdkConnectionRequest) => Promise<T>,
): Promise<T> {
  const databasePath = normalizeSdkDatabasePath(ctx, options.databasePath);
  const timeoutMs = normalizeSdkTimeoutMs(options.timeoutMs);
  const password = await readRootPassword(ctx);
  const remotePort = sdkGrpcPort(ctx, databasePath);

  if (ctx.profile.mode !== "ssh" || options.useSshTunnel === false) {
    const endpoint = `grpc://127.0.0.1:${remotePort}`;
    return run(sdkConnectionRequest(endpoint, databasePath, timeoutMs, ctx, password));
  }

  const localPort = await allocateLocalPort();
  const tunnel = await startSshTunnel(ctx.profile, localPort, remotePort, options.operationLabel ?? "YDB SDK operation");
  try {
    const endpoint = `grpc://127.0.0.1:${localPort}`;
    return await run(sdkConnectionRequest(endpoint, databasePath, timeoutMs, ctx, password));
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
): SdkConnectionRequest {
  return {
    connectionString: `${endpoint}${databasePath}`,
    databasePath,
    endpoint,
    timeoutMs,
    rootUser: password ? ctx.profile.rootUser : undefined,
    rootPassword: password,
  };
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
  operationLabel: string,
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
    await waitForSshTunnelReady(child, localPort, operationLabel);
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
    const deadline = Date.now() + SSH_TUNNEL_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (childFailure) {
        throw childFailure;
      }
      if (child.exitCode !== null) {
        throw new Error(`Failed to establish SSH tunnel for ${operationLabel}`);
      }
      if (await canConnectToLocalPort(localPort)) {
        return;
      }
      await delay(SSH_TUNNEL_READY_POLL_MS);
    }
    throw new Error(`Timed out establishing SSH tunnel for ${operationLabel}`);
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
