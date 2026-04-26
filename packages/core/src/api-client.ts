import { spawn } from "node:child_process";
import { redactCommand, redactText } from "./auth.js";
import type { ResolvedLocalYdbProfile } from "./validation.js";

export interface CommandSpec {
  command: string;
  args?: string[];
  stdin?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  description?: string;
  redactions?: string[];
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ok: boolean;
  timedOut: boolean;
}

export interface CommandExecutor {
  run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult>;
  display(profile: ResolvedLocalYdbProfile, spec: CommandSpec): string;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandToShell(spec: CommandSpec): string {
  return [spec.command, ...(spec.args ?? [])].map(shellQuote).join(" ");
}

export function bash(script: string, options: Omit<CommandSpec, "command" | "args"> = {}): CommandSpec {
  return {
    ...options,
    command: "bash",
    args: ["-lc", script]
  };
}

export class ShellCommandExecutor implements CommandExecutor {
  display(profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    const redactions = collectRedactions(profile, spec);
    if (profile.mode === "ssh") {
      const args = sshArgs(profile, commandToShell(spec));
      return redactCommand(["ssh", ...args].map(shellQuote).join(" "), redactions);
    }
    return redactCommand(commandToShell(spec), redactions);
  }

  run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    const redactions = collectRedactions(profile, spec);
    const timeoutMs = spec.timeoutMs ?? 30_000;
    const command = profile.mode === "ssh" ? "ssh" : spec.command;
    const args = profile.mode === "ssh" ? sshArgs(profile, commandToShell(spec)) : spec.args ?? [];
    const displayCommand = this.display(profile, spec);

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        const result: CommandResult = {
          command: displayCommand,
          exitCode,
          stdout: redactText(stdout, redactions),
          stderr: redactText(stderr, redactions),
          ok: exitCode === 0,
          timedOut
        };
        resolve(result);
      });
      if (spec.stdin) {
        child.stdin.end(spec.stdin);
      } else {
        child.stdin.end();
      }
    });
  }
}

function sshArgs(profile: ResolvedLocalYdbProfile, remoteCommand: string): string[] {
  const ssh = profile.ssh;
  if (!ssh) {
    throw new Error("ssh profile settings are required");
  }
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  if (ssh.port) {
    args.push("-p", String(ssh.port));
  }
  if (ssh.identityFile) {
    args.push("-i", ssh.identityFile);
  }
  args.push(ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host, remoteCommand);
  return args;
}

function collectRedactions(profile: ResolvedLocalYdbProfile, spec: CommandSpec): string[] {
  return [
    profile.rootPasswordFile,
    profile.ssh?.identityFile,
    ...(spec.redactions ?? [])
  ].filter((value): value is string => Boolean(value));
}

export interface DockerContainerSummary {
  id?: string;
  image?: string;
  names?: string;
  state?: string;
  status?: string;
  ports?: string;
  networks?: string;
}

export function parseDockerPsJsonLines(output: string): DockerContainerSummary[] {
  return output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, string>)
    .map((item) => ({
      id: item.ID,
      image: item.Image,
      names: item.Names,
      state: item.State,
      status: item.Status,
      ports: item.Ports,
      networks: item.Networks
    }));
}

export function parseDockerVolumeLines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export interface BscPlacement {
  groupIds: number[];
  pdiskIds: number[];
  paths: string[];
}

export interface StoragePoolSummary {
  rawBlock: string;
  boxId?: number;
  storagePoolId?: number;
  name?: string;
  kind?: string;
  numGroups?: number;
  itemConfigGeneration?: number;
}

export function parseBscPlacement(output: string): BscPlacement {
  return {
    groupIds: uniqueNumbers(output.matchAll(/\bGroupId:\s*(\d+)/g)),
    pdiskIds: uniqueNumbers(output.matchAll(/\bPDiskId:\s*(\d+)/g)),
    paths: Array.from(output.matchAll(/\bPath:\s*"([^"]+)"/g), (match) => match[1])
  };
}

export function parseReadStoragePools(output: string): StoragePoolSummary[] {
  const pools: StoragePoolSummary[] = [];
  const marker = "StoragePool {";
  let offset = 0;

  while ((offset = output.indexOf(marker, offset)) !== -1) {
    let depth = 0;
    let end = -1;
    for (let index = offset; index < output.length; index += 1) {
      const char = output[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end === -1) {
      break;
    }
    const rawBlock = output.slice(offset, end);
    pools.push({
      rawBlock,
      boxId: matchNumber(rawBlock, /\bBoxId:\s*(\d+)/),
      storagePoolId: matchNumber(rawBlock, /\bStoragePoolId:\s*(\d+)/),
      name: matchString(rawBlock, /\bName:\s*"([^"]+)"/),
      kind: matchString(rawBlock, /\bKind:\s*"([^"]+)"/),
      numGroups: matchNumber(rawBlock, /\bNumGroups:\s*(\d+)/),
      itemConfigGeneration: matchNumber(rawBlock, /\bItemConfigGeneration:\s*(\d+)/)
    });
    offset = end;
  }

  return pools;
}

function uniqueNumbers(matches: IterableIterator<RegExpMatchArray>): number[] {
  return Array.from(new Set(Array.from(matches, (match) => Number(match[1])))).sort((a, b) => a - b);
}

function matchNumber(text: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : undefined;
}

function matchString(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return match?.[1];
}

export class LocalYdbApiClient {
  constructor(
    readonly profile: ResolvedLocalYdbProfile,
    readonly executor: CommandExecutor = new ShellCommandExecutor()
  ) {}

  display(spec: CommandSpec): string {
    return this.executor.display(this.profile, spec);
  }

  run(spec: CommandSpec): Promise<CommandResult> {
    return this.executor.run(this.profile, spec);
  }

  docker(args: string[], options: Omit<CommandSpec, "command" | "args"> = {}): CommandSpec {
    return { ...options, command: "docker", args };
  }

  dockerExec(container: string, args: string[], options: Omit<CommandSpec, "command" | "args"> = {}): CommandSpec {
    return this.docker(["exec", container, ...args], options);
  }

  async dockerPs(): Promise<DockerContainerSummary[]> {
    const result = await this.run(this.docker(["ps", "-a", "--format", "{{json .}}"], {
      allowFailure: true,
      description: "List Docker containers"
    }));
    if (!result.ok || !result.stdout.trim()) {
      return [];
    }
    return parseDockerPsJsonLines(result.stdout);
  }

  async dockerVolumes(): Promise<string[]> {
    const result = await this.run(this.docker(["volume", "ls", "--format", "{{.Name}}"], {
      allowFailure: true,
      description: "List Docker volumes"
    }));
    return result.ok ? parseDockerVolumeLines(result.stdout) : [];
  }

  async dockerInspect(names: string[]): Promise<unknown[]> {
    const result = await this.run(this.docker(["inspect", ...names], {
      allowFailure: true,
      description: "Inspect local-ydb containers"
    }));
    if (!result.ok || !result.stdout.trim()) {
      return [];
    }
    return JSON.parse(result.stdout) as unknown[];
  }

  async viewerGet(pathAndQuery: string, authenticated = false): Promise<{ status: "ok" | "error"; data?: unknown; error?: string }> {
    const url = `${this.profile.monitoringBaseUrl}${pathAndQuery}`;
    const result = await this.run(authenticated && this.profile.rootPasswordFile
      ? authenticatedCurlJson(url, this.profile.monitoringBaseUrl, this.profile.rootUser, this.profile.rootPasswordFile)
      : bash(`curl -fsSL -L ${shellQuote(url)}`, { allowFailure: true, description: "Fetch YDB viewer JSON" }));
    if (!result.ok) {
      return { status: "error", error: result.stderr || result.stdout };
    }
    try {
      return { status: "ok", data: JSON.parse(result.stdout) };
    } catch (error) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async viewerStatus(pathAndQuery: string): Promise<number | null> {
    const url = `${this.profile.monitoringBaseUrl}${pathAndQuery}`;
    const result = await this.run(bash(`tmp=$(mktemp); code=$(curl -sS -o "$tmp" -w '%{http_code}' ${shellQuote(url)} || true); rm -f "$tmp"; printf '%s' "$code"`, {
      allowFailure: true,
      description: "Fetch YDB viewer HTTP status"
    }));
    const code = Number(result.stdout.trim());
    return Number.isFinite(code) ? code : null;
  }
}

function authenticatedCurlJson(url: string, monitoringBaseUrl: string, user: string, passwordFile: string): CommandSpec {
  const loginUrl = new URL("/login", monitoringBaseUrl).toString();
  return bash([
    "set -euo pipefail",
    "cookie=$(mktemp)",
    "trap 'rm -f \"$cookie\"' EXIT",
    `pass=$(cat ${shellQuote(passwordFile)})`,
    `user=${shellQuote(user)}`,
    "data=$(printf '{\"user\":\"%s\",\"password\":\"%s\"}' \"$user\" \"$pass\")",
    `curl -fsS -c "$cookie" -H 'Content-Type: application/json' -X POST --data "$data" ${shellQuote(loginUrl)} >/dev/null`,
    `curl -fsSL -b "$cookie" -L ${shellQuote(url)}`
  ].join("\n"), {
    allowFailure: true,
    description: "Fetch authenticated YDB viewer JSON",
    redactions: [passwordFile]
  });
}
