import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addStorageGroups,
  addDynamicNodes,
  applyAuthHardening,
  bootstrap,
  bootstrapRootDatabase,
  checkPrerequisites,
  cleanupStorage,
  commandToShell,
  createContext,
  createTenant,
  destroyStack,
  dumpTenant,
  healthcheck,
  inventory,
  listDumps,
  nodesCheck,
  prepareAuthConfig,
  pullImage,
  pullImageStatus,
  redactCommand,
  reduceStorageGroups,
  removeDynamicNodes,
  restartStack,
  restoreTenant,
  ShellCommandExecutor,
  shellQuote,
  startDynamicNode,
  statusReport,
  tenantCheck,
  setRootPassword,
  writeDynamicNodeAuthConfig,
  type CommandExecutor,
  type CommandOutputObserver,
  type CommandResult,
  type CommandSpec,
  type ResolvedLocalYdbProfile
} from "../src/index.js";
import { ConfigSchema } from "../src/validation.js";

const STABLE_DYNAMIC_CONTAINER_STATE = "container-id\ttrue\tfalse\t0";

function commandResult(command: string, overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command,
    exitCode: 0,
    stdout: "",
    stderr: "",
    ok: true,
    timedOut: false,
    ...overrides
  };
}

class RecordingExecutor implements CommandExecutor {
  readonly commands: string[] = [];

  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    const command = this.display(profile, spec);
    this.commands.push(command);
    return {
      command,
      exitCode: 0,
      stdout: command.includes("{{.RestartCount}}") ? STABLE_DYNAMIC_CONTAINER_STATE : "",
      stderr: "",
      ok: true,
      timedOut: false
    };
  }
}

class DeferredImagePullExecutor implements CommandExecutor {
  private outputObserver: CommandOutputObserver | undefined;
  private resolvePull: ((result: CommandResult) => void) | undefined;
  private pullCommand = "";

  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

  run(
    profile: ResolvedLocalYdbProfile,
    spec: CommandSpec,
    outputObserver?: CommandOutputObserver
  ): Promise<CommandResult> {
    const command = this.display(profile, spec);
    if (command.startsWith("docker image inspect ")) {
      return Promise.resolve(commandResult(command, { exitCode: 1, ok: false }));
    }
    if (command.startsWith("docker pull ")) {
      this.pullCommand = command;
      this.outputObserver = outputObserver;
      return new Promise((resolve) => {
        this.resolvePull = resolve;
      });
    }
    return Promise.resolve(commandResult(command));
  }

  emit(stream: "stdout" | "stderr", chunk: string): void {
    if (!this.outputObserver) {
      throw new Error("Image pull output observer is not attached");
    }
    this.outputObserver(stream, chunk);
  }

  finish(ok: boolean): void {
    if (!this.resolvePull) {
      throw new Error("Image pull is not running");
    }
    this.resolvePull(commandResult(this.pullCommand, {
      exitCode: ok ? 0 : 1,
      ok,
      stderr: ok ? "" : "pull failed"
    }));
  }
}

async function startDeferredImagePull(image: string): Promise<{
  executor: DeferredImagePullExecutor;
  jobId: string;
}> {
  const executor = new DeferredImagePullExecutor();
  const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
  const response = await pullImage(ctx, { confirm: true, image });
  if (!response.jobId) {
    throw new Error("Expected background image pull to return a jobId");
  }
  return { executor, jobId: response.jobId };
}

afterEach(() => {
  vi.useRealTimers();
});

async function withRunTimers<T>(operation: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const pending = operation();
  await vi.runAllTimersAsync();
  return pending;
}

function confirmDynamicPorts(ctx: ReturnType<typeof createContext>, ports: number[]): void {
  ctx.client.viewerGet = async (path) => path.includes("nodelist")
    ? { status: "ok", data: ports.map((Port, index) => ({ Id: 50_000 + index, Port })) }
    : { status: "ok", data: { TenantInfo: [{ AliveNodes: ports.length, NodeIds: ports.map((_, index) => 50_000 + index) }] } };
}

function createTempExecutableDir(files: Record<string, string>): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "local-ydb-test-bin-"));
  for (const [name, content] of Object.entries(files)) {
    const fullPath = join(path, name);
    writeFileSync(fullPath, content, "utf8");
    chmodSync(fullPath, 0o755);
  }
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true })
  };
}

class ScriptRewritingShellExecutor implements CommandExecutor {
  private readonly executor = new ShellCommandExecutor();

  constructor(private readonly rewrite: (script: string) => string) {
  }

  display(profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return this.executor.display(profile, this.rewriteSpec(spec));
  }

  run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    return this.executor.run(profile, this.rewriteSpec(spec));
  }

  private rewriteSpec(spec: CommandSpec): CommandSpec {
    if (spec.command !== "bash" || spec.args?.[0] !== "-lc" || typeof spec.args[1] !== "string") {
      return spec;
    }
    return {
      ...spec,
      args: ["-lc", this.rewrite(spec.args[1])]
    };
  }
}

describe("read-only checks", () => {
  it("reports a missing Docker CLI without probing the daemon", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 127,
        stdout: "",
        stderr: "docker: command not found",
        ok: false,
        timedOut: false
      };
    };

    const response = await inventory(ctx);

    expect(response).toMatchObject({
      ok: false,
      docker: {
        cliAvailable: false,
        daemonReachable: false
      },
      reason: "docker-cli-missing"
    });
    expect("containers" in response).toBe(false);
    expect(executor.commands.some((command) => command.includes("docker info"))).toBe(false);
    expect(JSON.stringify(response)).not.toContain("command not found");
  });

  it("reports an unreachable SSH target as an inventory failure without Docker install advice", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          mode: "ssh",
          ssh: {
            host: "unreachable.example",
            identityFile: "/private/ssh/id_test"
          }
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command: `ssh -i /private/ssh/id_test unreachable.example ${command}`,
        exitCode: 255,
        stdout: "",
        stderr: "ssh: private transport details",
        ok: false,
        timedOut: false
      };
    };

    const inventoryResponse = await inventory(ctx);
    const prerequisitesResponse = await checkPrerequisites(ctx);

    expect(inventoryResponse).toMatchObject({
      ok: false,
      reason: "docker-inventory-failed",
      docker: {
        cliAvailable: false,
        daemonReachable: false
      }
    });
    expect(prerequisitesResponse).toMatchObject({
      ready: false,
      missing: [],
      unavailable: ["target"],
      installablePackages: [],
      plannedCommands: []
    });
    expect(prerequisitesResponse.manualActions.join("\n")).not.toContain("Install and configure Docker");
    expect(executor.commands.filter((command) => command.includes("command -v curl"))).toHaveLength(0);
    expect(JSON.stringify({ inventoryResponse, prerequisitesResponse })).not.toContain("private transport details");
    expect(JSON.stringify({ inventoryResponse, prerequisitesResponse })).not.toContain("/private/ssh/id_test");
  });

  it.each([
    { label: "SSH command-v exit 1", stage: "cli", exitCode: 1, timedOut: false, reject: false, targetUnavailable: false },
    { label: "SSH command-v exit 255", stage: "cli", exitCode: 255, timedOut: false, reject: false, targetUnavailable: true },
    { label: "SSH command-v timeout", stage: "cli", exitCode: null, timedOut: true, reject: false, targetUnavailable: true },
    { label: "SSH spawn rejection", stage: "cli", exitCode: null, timedOut: false, reject: true, targetUnavailable: true },
    { label: "SSH daemon transport loss", stage: "daemon", exitCode: 255, timedOut: false, reject: false, targetUnavailable: true },
    { label: "unexpected SSH probe exit", stage: "cli", exitCode: 2, timedOut: false, reject: false, targetUnavailable: true }
  ] as const)("classifies $label without exposing transport details", async (scenario) => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          mode: "ssh",
          ssh: {
            host: "private-target.example",
            identityFile: "/private/ssh/id_probe"
          }
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      const isCli = command.includes("command -v docker");
      const isDaemon = command.includes("docker info");
      if ((scenario.stage === "cli" && isCli) || (scenario.stage === "daemon" && isDaemon)) {
        if (scenario.reject) {
          throw new Error("private spawn rejection");
        }
        return {
          command: `ssh -i /private/ssh/id_probe private-target.example ${command}`,
          exitCode: scenario.exitCode,
          stdout: "private stdout",
          stderr: "private ssh stderr",
          ok: false,
          timedOut: scenario.timedOut
        };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const inventoryResponse = await inventory(ctx);
    const prerequisitesResponse = await checkPrerequisites(ctx);

    expect(inventoryResponse.ok).toBe(false);
    if (!inventoryResponse.ok) {
      expect(inventoryResponse.reason).toBe(scenario.targetUnavailable ? "docker-inventory-failed" : "docker-cli-missing");
    }
    expect(prerequisitesResponse.missing).toEqual(scenario.targetUnavailable ? [] : ["docker"]);
    expect(prerequisitesResponse.unavailable).toEqual(scenario.targetUnavailable ? ["target"] : []);
    expect(executor.commands.some((command) => command.includes("command -v curl"))).toBe(!scenario.targetUnavailable);
    const serialized = JSON.stringify({ inventoryResponse, prerequisitesResponse });
    expect(serialized).not.toContain("/private/ssh/id_probe");
    expect(serialized).not.toContain("private ssh stderr");
    expect(serialized).not.toContain("private spawn rejection");
  });

  it("reports an unavailable Docker daemon instead of an empty inventory", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("command -v docker")) {
        return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
      }
      return {
        command,
        exitCode: 1,
        stdout: "",
        stderr: "daemon details must not be returned",
        ok: false,
        timedOut: false
      };
    };

    const response = await inventory(ctx);

    expect(response).toMatchObject({
      ok: false,
      docker: {
        cliAvailable: true,
        daemonReachable: false
      },
      reason: "docker-daemon-unavailable"
    });
    expect("containers" in response).toBe(false);
    expect("volumes" in response).toBe(false);
    expect("inspect" in response).toBe(false);
    expect(executor.commands.some((command) => command.includes("docker ps"))).toBe(false);
  });

  it("reports an inventory command failure after a successful Docker probe", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("command -v docker") || command.includes("docker info")) {
        return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
      }
      return {
        command,
        exitCode: 1,
        stdout: "",
        stderr: "inventory details must not be returned",
        ok: false,
        timedOut: false
      };
    };

    const response = await inventory(ctx);

    expect(response).toMatchObject({
      ok: false,
      docker: {
        cliAvailable: true,
        daemonReachable: true
      },
      reason: "docker-inventory-failed"
    });
    expect("containers" in response).toBe(false);
    expect(response.summary).not.toContain("inventory details");
  });

  it("returns a successful inventory only after a reachable daemon probe", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      const stdout = command.includes("docker ps")
        ? `${JSON.stringify({ ID: "1", Image: "img", Names: "ydb-local", State: "exited", Status: "Exited" })}\n`
        : command.includes("docker volume ls")
          ? "ydb-local-data\n"
          : command.includes("docker inspect ydb-local")
            ? `${JSON.stringify([{ Name: "/ydb-local" }])}\n`
            : "";
      return { command, exitCode: 0, stdout, stderr: "", ok: true, timedOut: false };
    };

    const response = await inventory(ctx);

    expect(response).toMatchObject({
      ok: true,
      docker: {
        cliAvailable: true,
        daemonReachable: true
      },
      containers: [{ names: "ydb-local", state: "exited" }],
      volumes: ["ydb-local-data"],
      inspect: [{ Name: "/ydb-local" }]
    });
    expect(executor.commands.filter((command) => command.includes("docker inspect"))).toHaveLength(1);
    expect(executor.commands.some((command) => command.includes("ydb-dyn-example"))).toBe(false);
  });

  it("uses retrying YDB CLI command for tenant metadata checks", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const response = await tenantCheck(ctx);

    expect(response).toMatchObject({
      summary: "Tenant /local/example metadata is reachable.",
      ok: true,
      stdout: "",
      stderr: "",
    });
    expect(executor.commands).toHaveLength(1);
    expect(executor.commands[0]).toContain("scheme ls /local/example");
    expect(executor.commands[0]).toContain("for attempt in $(seq 1 30)");
    expect(executor.commands[0]).toContain("TRANSPORT_UNAVAILABLE");
  });

  it("parses a GOOD YDB healthcheck as healthy", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 0,
        stdout: JSON.stringify({
          self_check_result: "GOOD",
          location: { id: 50000, host: "localhost", port: 2137 },
        }),
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await healthcheck(ctx);

    expect(response).toMatchObject({
      summary: "YDB healthcheck for /local/example returned GOOD.",
      ok: true,
      commandOk: true,
      healthy: true,
      databasePath: "/local/example",
      selfCheckResult: "GOOD",
      issueCount: 0,
      issueStatusCounts: {},
      issueTypes: [],
      issues: [],
      issuesTruncated: false,
    });
    expect(executor.commands[0]).toContain("monitoring healthcheck --format json");
    expect(executor.commands[0]).toContain("grpc://localhost:2137");
  });

  it("parses a degraded YDB healthcheck with issue counts and types", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 0,
        stdout: JSON.stringify({
          self_check_result: "DEGRADED",
          issue_log: [
            { id: "YELLOW-1", status: "YELLOW", type: "DATABASE", message: "Database has multiple issues" },
            { id: "YELLOW-2", status: "YELLOW", type: "COMPUTE", message: "Compute is overloaded" },
            { id: "ORANGE-1", status: "ORANGE", type: "STORAGE", message: "Storage is degraded" },
          ],
        }),
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await healthcheck(ctx);

    expect(response).toMatchObject({
      summary: "YDB healthcheck for /local/example returned DEGRADED with 3 issue(s).",
      ok: true,
      commandOk: true,
      healthy: false,
      selfCheckResult: "DEGRADED",
      issueCount: 3,
      issueStatusCounts: { ORANGE: 1, YELLOW: 2 },
      issueTypes: ["COMPUTE", "DATABASE", "STORAGE"],
      issuesTruncated: false,
    });
    expect(response.issues).toHaveLength(3);
  });

  it("routes healthcheck through dynamic CLI for tenant and static CLI for root database", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const specs: CommandSpec[] = [];
    executor.run = async (_profile, spec) => {
      specs.push(spec);
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 0,
        stdout: JSON.stringify({ self_check_result: "GOOD" }),
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    await healthcheck(ctx, { databasePath: "/local/example" });
    await healthcheck(ctx, { databasePath: "/local" });

    expect(executor.commands[0]).toContain("grpc://localhost:2137");
    expect(executor.commands[0]).toContain("-d /local/example");
    expect(executor.commands[1]).toContain("grpc://localhost:2136");
    expect(executor.commands[1]).toContain("-d /local");
    expect(specs[0]?.timeoutMs).toBe(125_000);
    expect(specs[1]?.timeoutMs).toBe(125_000);
  });

  it("honors custom healthcheck timeouts in the command executor", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    let specTimeoutMs: number | undefined;
    executor.run = async (_profile, spec) => {
      specTimeoutMs = spec.timeoutMs;
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 0,
        stdout: JSON.stringify({ self_check_result: "GOOD" }),
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    await healthcheck(ctx, { timeoutMs: 240_000 });

    expect(executor.commands[0]).toContain("--timeout 240000");
    expect(specTimeoutMs).toBe(245_000);
  });

  it("reports invalid JSON from YDB healthcheck without treating it as ok", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 0,
        stdout: "{not-json",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await healthcheck(ctx, { maxOutputBytes: 4 });

    expect(response).toMatchObject({
      summary: "YDB healthcheck for /local/example returned invalid JSON.",
      ok: false,
      commandOk: true,
      healthy: false,
      stdout: "{not",
      stdoutBytes: 9,
      stdoutTruncated: true,
      issueCount: 0,
    });
    expect(response.parseError).toContain("JSON");
  });

  it("reports failed YDB healthcheck commands with capped output", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 1,
        stdout: "",
        stderr: "healthcheck failed hard",
        ok: false,
        timedOut: false
      };
    };

    const response = await healthcheck(ctx, { maxOutputBytes: 12 });

    expect(response).toMatchObject({
      summary: "YDB healthcheck for /local/example failed.",
      ok: false,
      commandOk: false,
      healthy: false,
      stderr: "healthcheck ",
      stderrBytes: 23,
      stderrTruncated: true,
    });
  });

  it("truncates returned healthcheck issues deterministically", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 0,
        stdout: JSON.stringify({
          self_check_result: "DEGRADED",
          issue_log: [
            { id: "YELLOW-1", status: "YELLOW", type: "DATABASE" },
            { id: "YELLOW-2", status: "YELLOW", type: "COMPUTE" },
            { id: "RED-1", status: "RED", type: "STORAGE" },
          ],
        }),
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await healthcheck(ctx, { maxIssues: 2 });

    expect(response.issueCount).toBe(3);
    expect(response.issues).toEqual([
      { id: "YELLOW-1", status: "YELLOW", type: "DATABASE" },
      { id: "YELLOW-2", status: "YELLOW", type: "COMPUTE" },
    ]);
    expect(response.issuesTruncated).toBe(true);
    expect(response.issueStatusCounts).toEqual({ RED: 1, YELLOW: 2 });
  });

  it("uses tenantinfo when viewer nodelist is empty", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    ctx.client.viewerGet = async (path) => path.includes("tenantinfo")
      ? { status: "ok", data: { TenantInfo: [{ AliveNodes: 1, NodeIds: [50000] }] } }
      : { status: "ok", data: [] };

    const response = await nodesCheck(ctx);

    expect(response).toMatchObject({
      summary: "Tenant /local/example reports 1 alive node; viewer nodelist returned 0 nodes.",
      ok: true,
      nodes: [],
      tenantAliveNodes: 1,
      tenantNodeIds: [50000],
      warning: "Viewer nodelist returned no nodes; tenantinfo confirmed alive tenant nodes.",
    });
  });

  it("treats an empty viewer node-list as not ok when tenantinfo has no alive nodes", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    ctx.client.viewerGet = async (path) => path.includes("tenantinfo")
      ? { status: "ok", data: { TenantInfo: [{ AliveNodes: 0, NodeIds: [] }] } }
      : { status: "ok", data: [] };

    const response = await nodesCheck(ctx);

    expect(response).toMatchObject({
      summary: "Viewer returned 0 nodes.",
      ok: false,
      nodes: [],
      tenantAliveNodes: 0,
      tenantNodeIds: [],
      error: "Viewer nodelist returned no nodes; dynamic node registration was not confirmed.",
    });
  });

  it("surfaces tenantinfo-confirmed nodes in the aggregate status report", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 0,
        stdout: command.includes("monitoring healthcheck")
          ? JSON.stringify({ self_check_result: "GOOD" })
          : "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };
    ctx.client.viewerGet = async (path) => path.includes("tenantinfo")
      ? { status: "ok", data: { TenantInfo: [{ AliveNodes: 1, NodeIds: [50000] }] } }
      : { status: "ok", data: [] };

    const response = await statusReport(ctx);

    expect(response.summary).toBe("Status report for default: docker=ok, tenant=ok, nodes=ok, health=GOOD.");
    expect(response.nodes).toMatchObject({
      summary: "Tenant /local/example reports 1 alive node; viewer nodelist returned 0 nodes.",
      ok: true,
      warning: "Viewer nodelist returned no nodes; tenantinfo confirmed alive tenant nodes.",
    });
  });

  it("continues read-only status checks when Docker inventory is unavailable", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker info")) {
        return {
          command,
          exitCode: 1,
          stdout: "",
          stderr: "private daemon error",
          ok: false,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: command.includes("monitoring healthcheck")
          ? JSON.stringify({ self_check_result: "GOOD" })
          : "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };
    ctx.client.viewerGet = async (path) => path.includes("tenantinfo")
      ? { status: "ok", data: { TenantInfo: [{ AliveNodes: 1, NodeIds: [50000] }] } }
      : { status: "ok", data: [{ NodeId: 50000 }] };

    const response = await statusReport(ctx);

    expect(response.summary).toBe(
      "Status report for default: docker=unavailable, tenant=ok, nodes=ok, health=GOOD."
    );
    expect(response.inventory).toMatchObject({
      ok: false,
      reason: "docker-daemon-unavailable"
    });
    expect(response.tenant.ok).toBe(true);
    expect(response.nodes.ok).toBe(true);
    expect(response.healthcheck.healthy).toBe(true);
    expect(JSON.stringify(response.inventory)).not.toContain("private daemon error");
  });

  it("returns a status report when individual local Docker checks reject with ENOENT", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("command -v docker")) {
        return { command, exitCode: 1, stdout: "", stderr: "", ok: false, timedOut: false };
      }
      if (spec.command === "docker") {
        throw Object.assign(new Error("spawn docker ENOENT with private details"), { code: "ENOENT" });
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };
    ctx.client.viewerGet = async (path) => path.includes("tenantinfo")
      ? { status: "ok", data: { TenantInfo: [{ AliveNodes: 1, NodeIds: [50000] }] } }
      : { status: "ok", data: [{ NodeId: 50000 }] };

    const response = await statusReport(ctx);

    expect(response.inventory).toMatchObject({ ok: false, reason: "docker-cli-missing" });
    expect(response.auth).toEqual({
      summary: "Auth check is unavailable.",
      viewerWhoamiStatus: null,
      anonymousCliOk: false,
      anonymousCliCommand: "",
      anonymousCliStderr: ""
    });
    expect(response.tenant.ok).toBe(true);
    expect(response.nodes.ok).toBe(true);
    expect(response.healthcheck).toMatchObject({
      summary: "YDB healthcheck is unavailable.",
      ok: false,
      commandOk: false,
      healthy: false,
      databasePath: "/local/example",
      command: ""
    });
    expect(JSON.stringify(response)).not.toContain("ENOENT");
    expect(JSON.stringify(response)).not.toContain("private details");
  });

  it("contains unexpected failures from every status component", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async () => {
      throw new Error("private command failure");
    };
    ctx.client.viewerStatus = async () => {
      throw new Error("private viewer status failure");
    };
    ctx.client.viewerGet = async () => {
      throw new Error("private viewer get failure");
    };

    const response = await statusReport(ctx);

    expect(response.inventory).toMatchObject({
      ok: false,
      reason: "docker-inventory-failed",
      docker: { cliAvailable: false, daemonReachable: false }
    });
    expect(response.auth).toEqual({
      summary: "Auth check is unavailable.",
      viewerWhoamiStatus: null,
      anonymousCliOk: false,
      anonymousCliCommand: "",
      anonymousCliStderr: ""
    });
    expect(response.tenant).toEqual({
      summary: "Tenant check is unavailable.",
      ok: false,
      command: "",
      stdout: "",
      stderr: ""
    });
    expect(response.nodes).toMatchObject({
      summary: "Node check is unavailable.",
      ok: false,
      nodes: [],
      tenantAliveNodes: 0,
      tenantNodeIds: [],
      error: "Node check could not be executed."
    });
    expect(response.healthcheck).toMatchObject({
      summary: "YDB healthcheck is unavailable.",
      ok: false,
      commandOk: false,
      healthy: false,
      databasePath: "/local/example",
      command: "",
      issues: [],
      maxOutputBytes: 65_536,
      maxIssues: 100
    });
    expect(JSON.stringify(response)).not.toContain("private");
  });
});

describe("mutating operations", () => {
  it("keeps a missing Docker CLI in missing rather than unavailable prerequisites", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("command -v docker")) {
        return {
          command,
          exitCode: 127,
          stdout: "",
          stderr: "docker: command not found",
          ok: false,
          timedOut: false
        };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await checkPrerequisites(ctx, {});

    expect(response.ready).toBe(false);
    expect(response.missing).toEqual(["docker"]);
    expect(response.unavailable).toEqual([]);
    expect(response.checks).toContainEqual({
      name: "dockerDaemon",
      kind: "service",
      ok: false,
      detail: "Docker daemon was not checked because Docker CLI is missing."
    });
    expect(executor.commands.some((command) => command.includes("docker info"))).toBe(false);
  });

  it("distinguishes an unavailable Docker daemon from a missing Docker CLI", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker info")) {
        return {
          command,
          exitCode: 1,
          stdout: "",
          stderr: "daemon details must not be returned",
          ok: false,
          timedOut: false
        };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await checkPrerequisites(ctx, {});

    expect(response.ready).toBe(false);
    expect(response.missing).toEqual([]);
    expect(response.unavailable).toEqual(["dockerDaemon"]);
    expect(response.checks).toContainEqual({
      name: "dockerDaemon",
      kind: "service",
      ok: false,
      detail: "Docker CLI is available, but the Docker daemon is unavailable or inaccessible."
    });
    expect(response.manualActions).toContain(
      "Start or configure Docker on the selected target and ensure the current user can access its daemon."
    );
    expect((response.results ?? []).some((result) => result.stderr.includes("daemon details"))).toBe(false);
  });

  it("blocks inventory-backed mutation planning when Docker is unavailable", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("command -v docker")) {
        return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
      }
      return {
        command,
        exitCode: 1,
        stdout: "",
        stderr: "",
        ok: false,
        timedOut: false
      };
    };

    await expect(destroyStack(ctx, {})).rejects.toThrow(
      "Docker inventory is unavailable for profile default: Docker CLI is available, but the Docker daemon is unavailable or inaccessible."
    );
    expect(executor.commands.some((command) => command.includes("docker rm"))).toBe(false);
  });

  it("does not execute bootstrap without confirm=true", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await bootstrap(ctx, {});
    const plan = response.plannedCommands.join("\n");
    expect(response.executed).toBe(false);
    expect(executor.commands).toEqual([]);
    expect(response.plannedCommands[0]).toContain("docker image inspect");
    expect(response.plannedCommands.some((command) => command.includes("docker network"))).toBe(true);
    expect(plan).toContain("-p 127.0.0.1:2136:2136");
    expect(plan).toContain("-p 127.0.0.1:2137:2137");
    expect(plan).toContain(".HostConfig.PortBindings");
    expect(plan).toContain("2136/tcp");
    expect(plan).toContain("2137/tcp");
    expect(plan).not.toContain("docker port");
  });

  it("plans root database bootstrap without tenant or dynamic-node commands", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await bootstrapRootDatabase(ctx, {});
    const plan = response.plannedCommands.join("\n");
    expect(response.executed).toBe(false);
    expect(executor.commands).toEqual([]);
    expect(plan).toContain("scheme ls /local");
    expect(plan).toContain("-p 127.0.0.1:2136:2136");
    expect(plan).toContain(".HostConfig.PortBindings");
    expect(plan).toContain("2136/tcp");
    expect(plan).not.toContain("-p 127.0.0.1:2137:2137");
    expect(plan).not.toContain("2137/tcp");
    expect(plan).not.toContain("docker port");
    expect(plan).not.toContain("admin database");
    expect(plan).not.toContain("ydb-dyn-example");
    expect(plan).not.toContain("YDB_FEATURE_FLAGS=enable_graph_shard");
  });

  it("keeps root bootstrap static-only when dynamicNodeCount is three", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));

    const response = await bootstrapRootDatabase(ctx, {});

    const plan = response.plannedCommands.join("\n");
    expect(plan).not.toContain("ydb-dyn-example");
    for (const port of [2137, 2138, 2139]) {
      expect(plan).not.toContain(`127.0.0.1:${port}:${port}`);
      expect(plan).not.toContain(`PortBindings \"${port}/tcp\"`);
    }
  });

  it("plans root bootstrap to start an existing stopped static container", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await bootstrapRootDatabase(ctx, {});
    expect(response.plannedCommands[3]).toContain(".State.Running");
    expect(response.plannedCommands[3]).toContain("docker start ydb-local >/dev/null");
  });

  it("fails tenant bootstrap before tenant creation when the static container lacks the GraphShard flag", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("local_ydb_destroy_stack")) {
        return {
          command,
          exitCode: 1,
          stdout: "",
          stderr: "Existing static container ydb-local is missing YDB_FEATURE_FLAGS=enable_graph_shard.",
          ok: false,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await bootstrap(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(response.results?.at(-1)?.ok).toBe(false);
    expect(response.results?.at(-1)?.stderr).toContain("YDB_FEATURE_FLAGS=enable_graph_shard");
    expect(executor.commands.some((command) => command.includes("admin database /local/example create"))).toBe(false);
  });

  it("fails tenant bootstrap before tenant creation when the static container lacks published gRPC ports", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("does not match profile published ports")) {
        return {
          command,
          exitCode: 1,
          stdout: "",
          stderr: "Existing static container ydb-local does not match profile published ports.",
          ok: false,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await bootstrap(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(response.results?.at(-1)?.ok).toBe(false);
    expect(response.results?.at(-1)?.stderr).toContain("does not match profile published ports");
    expect(executor.commands.some((command) => command.includes("admin database /local/example create"))).toBe(false);
    expect(executor.commands.some((command) => command.includes("docker rm -f ydb-dyn-example"))).toBe(false);
  });

  it("rejects static container host-port collisions before planning bootstrap", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          ports: {
            monitoring: 2136
          }
        }
      }
    }));
    await expect(bootstrapRootDatabase(ctx, {})).rejects.toThrow(/staticGrpc.*monitoring.*2136/);
    expect(executor.commands).toEqual([]);
  });

  it("keeps the root bootstrap viewer probe non-fatal", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: command.includes("/viewer/json/tenants") ? "curl probe failed" : "",
        ok: true,
        timedOut: false
      };
    };

    const response = await bootstrapRootDatabase(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(response.results?.at(-1)?.command).toContain("|| true");
  });

  it("keeps the tenant bootstrap viewer probe non-fatal", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 0,
        stdout: command.includes("{{.RestartCount}}") ? STABLE_DYNAMIC_CONTAINER_STATE : "",
        stderr: command.includes("/viewer/json/capabilities") ? "curl probe failed" : "",
        ok: true,
        timedOut: false
      };
    };
    confirmDynamicPorts(ctx, [19002]);

    const response = await withRunTimers(() => bootstrap(ctx, { confirm: true }));
    expect(response.executed).toBe(true);
    expect(response.results?.at(-1)?.command).toContain("|| true");
  });

  it("plans a background image pull without confirm=true", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await pullImage(ctx, { image: "ghcr.io/ydb-platform/local-ydb:25.4" });
    expect(response.executed).toBe(false);
    expect(response.status).toBe("planned");
    expect(response.plannedCommands.join("\n")).toContain("docker image inspect ghcr.io/ydb-platform/local-ydb:25.4");
    expect(response.plannedCommands.join("\n")).toContain("docker pull ghcr.io/ydb-platform/local-ydb:25.4");
  });

  it("does not start a pull job when the image is already present", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await pullImage(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(response.status).toBe("already-present");
    expect(response.jobId).toBeUndefined();
    expect(executor.commands).toEqual(["docker image inspect ghcr.io/ydb-platform/local-ydb:26.1.1.6"]);
  });

  it("reports unknown image pull jobs without throwing", () => {
    const status = pullImageStatus("missing-job");
    expect(status).toMatchObject({
      found: false,
      jobId: "missing-job",
      status: "unknown"
    });
    expect(status).not.toHaveProperty("progressPercent");
  });

  it("reports monotonic image pull progress from fragmented layer output", async () => {
    const { executor, jobId } = await startDeferredImagePull(
      "ghcr.io/ydb-platform/local-ydb:progress-test"
    );

    expect(pullImageStatus(jobId)).toMatchObject({
      status: "running",
      progressPercent: 0
    });

    executor.emit("stdout", "aaaa1111: Pulling fs ");
    executor.emit("stdout", "layer\nbbbb2222: Waiting\n");
    executor.emit("stderr", "aaaa1111: Pull complete\n");
    expect(pullImageStatus(jobId)).toMatchObject({
      status: "running",
      progressPercent: 49
    });

    executor.emit("stdout", "aaaa1111: Waiting\ncccc3333: Downloading\n");
    expect(pullImageStatus(jobId).progressPercent).toBe(49);

    executor.emit("stdout", "bbbb2222: Pull complete\ncccc3333: Already exists\n");
    expect(pullImageStatus(jobId)).toMatchObject({
      status: "running",
      progressPercent: 99
    });

    executor.finish(true);
    await vi.waitFor(() => {
      expect(pullImageStatus(jobId)).toMatchObject({
        status: "completed",
        progressPercent: 100
      });
    });
    expect(pullImageStatus(jobId).summary).toContain("100%");
  });

  it("refreshes image pull updatedAt for recognized activity without percentage changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    const { executor, jobId } = await startDeferredImagePull(
      "ghcr.io/ydb-platform/local-ydb:progress-activity-test"
    );

    executor.emit("stdout", "aaaa1111: Pulling fs layer\nbbbb2222: Waiting\naaaa1111: Pull complete\n");
    expect(pullImageStatus(jobId)).toMatchObject({
      progressPercent: 49,
      updatedAt: "2026-08-21T00:00:00.000Z"
    });

    vi.setSystemTime(new Date("2026-08-21T00:00:01.000Z"));
    executor.emit("stdout", "bbbb2222: Downloading\n");
    expect(pullImageStatus(jobId)).toMatchObject({
      progressPercent: 49,
      updatedAt: "2026-08-21T00:00:01.000Z"
    });

    vi.setSystemTime(new Date("2026-08-21T00:00:02.000Z"));
    executor.emit("stdout", "Digest: sha256:ignored\n");
    expect(pullImageStatus(jobId)).toMatchObject({
      progressPercent: 49,
      updatedAt: "2026-08-21T00:00:01.000Z"
    });
  });

  it("preserves the last image pull percentage on failure", async () => {
    const { executor, jobId } = await startDeferredImagePull(
      "ghcr.io/ydb-platform/local-ydb:progress-failure-test"
    );

    executor.emit("stdout", "aaaa1111: Pulling fs layer\nbbbb2222: Waiting\naaaa1111: Pull complete\n");
    expect(pullImageStatus(jobId).progressPercent).toBe(49);

    executor.finish(false);
    await vi.waitFor(() => {
      expect(pullImageStatus(jobId)).toMatchObject({
        status: "failed",
        progressPercent: 49
      });
    });
    expect(pullImageStatus(jobId).summary).toContain("49%");
  });

  it("flushes a final image pull layer line without a newline", async () => {
    const { executor, jobId } = await startDeferredImagePull(
      "ghcr.io/ydb-platform/local-ydb:progress-tail-test"
    );

    executor.emit("stdout", "aaaa1111: Pulling fs layer\nbbbb2222: Waiting\naaaa1111: Pull complete");
    expect(pullImageStatus(jobId).progressPercent).toBe(0);

    executor.finish(false);
    await vi.waitFor(() => {
      expect(pullImageStatus(jobId)).toMatchObject({
        status: "failed",
        progressPercent: 49
      });
    });
  });

  it("completes image pulls without layer output at 100 percent", async () => {
    const { executor, jobId } = await startDeferredImagePull(
      "ghcr.io/ydb-platform/local-ydb:no-layer-output-test"
    );

    expect(pullImageStatus(jobId).progressPercent).toBe(0);
    executor.finish(true);
    await vi.waitFor(() => {
      expect(pullImageStatus(jobId).progressPercent).toBe(100);
    });
  });

  it("checks prerequisites and prepares an apt install plan for missing host helpers", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          rootPasswordFile: "/tmp/local-ydb-auth/root.password"
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("command -v docker")) {
        return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
      }
      if (command.includes("command -v curl")) {
        return { command, exitCode: 1, stdout: "", stderr: "", ok: false, timedOut: false };
      }
      if (command.includes("command -v ruby")) {
        return { command, exitCode: 1, stdout: "", stderr: "", ok: false, timedOut: false };
      }
      if (command.includes("[ -f /tmp/local-ydb-auth/root.password ]")) {
        return { command, exitCode: 1, stdout: "", stderr: "", ok: false, timedOut: false };
      }
      if (command.includes("command -v apt-get")) {
        return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await checkPrerequisites(ctx, {});
    expect(response.executed).toBe(false);
    expect(response.missing).toEqual(["curl", "ruby", "rootPasswordFile"]);
    expect(response.installablePackages).toEqual(["curl", "ruby"]);
    expect(response.packageManager).toBe("apt-get");
    expect(response.manualActions.some((item) => item.includes("local_ydb_prepare_auth_config"))).toBe(true);
    expect(response.plannedCommands.join("\n")).toContain("sudo -n apt-get install -y curl ruby");
    expect(JSON.stringify(response)).not.toContain("/tmp/local-ydb-auth/root.password");
  });

  it("installs supported prerequisite packages when confirm=true", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    let installed = false;
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("command -v docker")) {
        return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
      }
      if (command.includes("command -v curl")) {
        return { command, exitCode: installed ? 0 : 1, stdout: "", stderr: "", ok: installed, timedOut: false };
      }
      if (command.includes("command -v ruby")) {
        return { command, exitCode: installed ? 0 : 1, stdout: "", stderr: "", ok: installed, timedOut: false };
      }
      if (command.includes("command -v apt-get")) {
        return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
      }
      if (command.includes("sudo -n apt-get install")) {
        installed = true;
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await checkPrerequisites(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(response.ready).toBe(true);
    expect(response.missing).toEqual([]);
    expect(response.installablePackages).toEqual([]);
    expect(response.checks.filter((check) => check.name === "curl" || check.name === "ruby").every((check) => check.ok)).toBe(true);
    expect(executor.commands.filter((command) => command.includes("command -v curl"))).toHaveLength(2);
    expect(executor.commands.filter((command) => command.includes("command -v ruby"))).toHaveLength(2);
    expect(response.results?.filter((result) => result.command === "Check curl availability")).toEqual([
      expect.objectContaining({ ok: true })
    ]);
    expect(response.results?.filter((result) => result.command === "Check ruby availability")).toEqual([
      expect.objectContaining({ ok: true })
    ]);
    expect(response.plannedCommands.join("\n")).toContain("sudo -n apt-get update");
    expect(response.plannedCommands.join("\n")).toContain("sudo -n apt-get install -y curl ruby");
  });

  it("executes bootstrap commands with confirm=true", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    confirmDynamicPorts(ctx, [19002]);
    const response = await bootstrap(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(executor.commands.length).toBeGreaterThan(1);
    expect(executor.commands.join("\n")).toContain("admin database");
  });

  it("starts and verifies configured dynamic nodes in index order", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));
    confirmDynamicPorts(ctx, [19002, 19003, 19004]);

    const response = await withRunTimers(() => bootstrap(ctx, { confirm: true }));
    const commands = executor.commands.join("\n");

    expect(response.summary).toContain("verified 3/3 configured dynamic nodes");
    expect(commands.indexOf("--name ydb-dyn-example ")).toBeLessThan(commands.indexOf("--name ydb-dyn-example-2 "));
    expect(commands.indexOf("--name ydb-dyn-example-2 ")).toBeLessThan(commands.indexOf("--name ydb-dyn-example-3 "));
  });

  it("publishes every configured dynamic-node gRPC port through the static container", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));

    const response = await bootstrap(ctx, {});
    const staticCommand = response.plannedCommands.find((command) => (
      command.includes("HostConfig.PortBindings") && command.includes("docker run -d")
    ));

    expect(staticCommand).toBeDefined();
    for (const port of [2137, 2138, 2139]) {
      expect(staticCommand).toContain(`127.0.0.1:${port}:${port}`);
      expect(staticCommand).toContain(`PortBindings \"${port}/tcp\"`);
    }
  });

  it("does not accept a matching IC port from a restarting configured container", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 2 } }
    }));
    confirmDynamicPorts(ctx, [19002, 19003]);
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("{{.State.Running}}") && command.includes("{{.RestartCount}}")) {
        const restarting = command.includes("ydb-dyn-example-2");
        return {
          command,
          exitCode: 0,
          stdout: `container-id\ttrue\t${restarting}\t4`,
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await withRunTimers(() => bootstrap(ctx, { confirm: true }));

    expect(response.summary).toContain("verified 1/2 configured dynamic nodes");
    expect(response.results?.at(-1)).toMatchObject({ ok: false });
    expect(response.results?.at(-1)?.stderr).toContain("matching IC port does not confirm the exact container");
  });

  it("does not accept a matching IC port when the configured container is missing", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    confirmDynamicPorts(ctx, [19002]);
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("{{.RestartCount}}")) {
        return { command, exitCode: 1, stdout: "", stderr: "No such container", ok: false, timedOut: false };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await withRunTimers(() => bootstrap(ctx, { confirm: true }));

    expect(response.summary).toContain("verified 0/1 configured dynamic nodes");
    expect(response.results?.at(-1)?.stderr).toContain("is missing or could not be inspected");
    expect(response.results?.at(-1)?.stderr).toContain("matching IC port does not confirm the exact container");
  });

  it("accepts a healthy exact container after two stable samples", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    confirmDynamicPorts(ctx, [19002]);

    const response = await withRunTimers(() => bootstrap(ctx, { confirm: true }));

    expect(response.summary).toContain("verified 1/1 configured dynamic nodes");
    expect(executor.commands.filter((command) => command.includes("{{.RestartCount}}"))).toHaveLength(2);
  });

  it("requires two stable exact-container samples after RestartCount changes", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    confirmDynamicPorts(ctx, [19002]);
    let inspectSamples = 0;
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("{{.State.Running}}") && command.includes("{{.RestartCount}}")) {
        inspectSamples += 1;
        const restartCount = inspectSamples === 1 ? 0 : 1;
        return {
          command,
          exitCode: 0,
          stdout: `container-id\ttrue\tfalse\t${restartCount}`,
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await withRunTimers(() => bootstrap(ctx, { confirm: true }));

    expect(response.summary).toContain("verified 1/1 configured dynamic nodes");
    expect(inspectSamples).toBe(3);
  });

  it("plans unconditional recreation for every configured dynamic node", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));

    const response = await bootstrap(ctx, {});
    const dynamicCommands = response.plannedCommands.filter((command) => command.includes("--name ydb-dyn-example"));

    expect(dynamicCommands).toHaveLength(3);
    for (const command of dynamicCommands) {
      expect(command).toContain("docker rm -f");
      expect(command).not.toContain(".State.Running");
    }
  });

  it("recreates configured dynamic nodes in order during confirmed bootstrap", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));
    confirmDynamicPorts(ctx, [19002, 19003, 19004]);

    const response = await withRunTimers(() => bootstrap(ctx, { confirm: true }));
    const dynamicCommands = executor.commands.filter((command) => command.includes("--name ydb-dyn-example"));

    expect(response.summary).toContain("verified 3/3 configured dynamic nodes");
    expect(dynamicCommands).toHaveLength(3);
    expect(dynamicCommands.every((command) => command.includes("docker rm -f"))).toBe(true);
    expect(dynamicCommands.every((command) => !command.includes(".State.Running"))).toBe(true);
    expect(dynamicCommands[0]).toContain("--name ydb-dyn-example ");
    expect(dynamicCommands[1]).toContain("--name ydb-dyn-example-2 ");
    expect(dynamicCommands[2]).toContain("--name ydb-dyn-example-3 ");
  });

  it("stops configured bootstrap after the first dynamic-node command failure", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));
    confirmDynamicPorts(ctx, [19002, 19003, 19004]);
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      const ok = !command.includes("--name ydb-dyn-example-2 ");
      const stdout = command.includes("{{.RestartCount}}") ? STABLE_DYNAMIC_CONTAINER_STATE : "";
      return { command, exitCode: ok ? 0 : 1, stdout, stderr: ok ? "" : "node 2 failed", ok, timedOut: false };
    };

    const response = await withRunTimers(() => bootstrap(ctx, { confirm: true }));

    expect(response.summary).toContain("verified 1/3 configured dynamic nodes");
    expect(response.results?.at(-1)?.stderr).toBe("node 2 failed");
    expect(executor.commands.join("\n")).not.toContain("--name ydb-dyn-example-3 ");
  });

  it("stops configured bootstrap after the first readiness failure", async () => {
    vi.useFakeTimers();
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));
    confirmDynamicPorts(ctx, [19002]);

    const pending = bootstrap(ctx, { confirm: true });
    await vi.runAllTimersAsync();
    const response = await pending;

    expect(response.summary).toContain("verified 1/3 configured dynamic nodes");
    expect(response.results?.at(-1)).toMatchObject({
      command: "verify dynamic node ydb-dyn-example-2 IC port 19003",
      ok: false
    });
    expect(executor.commands.join("\n")).not.toContain("--name ydb-dyn-example-3 ");
  });

  it("creates the named dump directory before running ydb dump", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await dumpTenant(ctx, { dumpName: "mcp-smoke" });
    expect(response.executed).toBe(false);
    expect(response.plannedCommands[0]).toContain("mkdir -p /tmp/local-ydb-dump/mcp-smoke");
    expect(response.plannedCommands[1]).toContain("tools dump -p . --exclude");
    expect(response.plannedCommands[1]).toContain("'(^|/)\\.sys(/|$)'");
    expect(response.plannedCommands[1]).toContain("-o /dump/mcp-smoke/tenant");
  });

  it("quotes dump rollback and verification paths", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await dumpTenant(ctx, { dumpName: "mcp smoke" });

    expect(response.executed).toBe(false);
    expect(response.plannedCommands[0]).toContain("/tmp/local-ydb-dump/mcp smoke");
    expect(response.rollback).toEqual(["rm -rf '/tmp/local-ydb-dump/mcp smoke'"]);
    expect(response.verification).toEqual(["test -d '/tmp/local-ydb-dump/mcp smoke/tenant'"]);
  });

  it("lists named dumps that contain a tenant dump directory", async () => {
    const executor = new RecordingExecutor();
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 0,
        stdout: "mcp smoke\nmcp-smoke\n../escape\n.\n..\nbad\\name\nbad\u0007name\n name \npre-auth\n",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const response = await listDumps(ctx);

    expect(response.ok).toBe(true);
    expect(response.dumpHostPath).toBe("/tmp/local-ydb-dump");
    expect(response.dumps).toEqual([
      {
        name: "mcp smoke",
        hostPath: "/tmp/local-ydb-dump/mcp smoke",
        tenantDumpPath: "/tmp/local-ydb-dump/mcp smoke/tenant"
      },
      {
        name: "mcp-smoke",
        hostPath: "/tmp/local-ydb-dump/mcp-smoke",
        tenantDumpPath: "/tmp/local-ydb-dump/mcp-smoke/tenant"
      },
      {
        name: "pre-auth",
        hostPath: "/tmp/local-ydb-dump/pre-auth",
        tenantDumpPath: "/tmp/local-ydb-dump/pre-auth/tenant"
      }
    ]);
    expect(response.command).toContain("for dir in /tmp/local-ydb-dump/*");
    expect(response.command).toContain("find \"$dir/tenant\" -name incomplete -print -quit");
  });

  it("filters dumps with incomplete restore markers", async () => {
    const dumpHostPath = mkdtempSync(join(tmpdir(), "local-ydb-dumps-"));
    try {
      mkdirSync(join(dumpHostPath, "complete", "tenant"), { recursive: true });
      mkdirSync(join(dumpHostPath, "root-incomplete", "tenant"), { recursive: true });
      writeFileSync(join(dumpHostPath, "root-incomplete", "tenant", "incomplete"), "", "utf8");
      mkdirSync(join(dumpHostPath, "nested-incomplete", "tenant", "dir"), { recursive: true });
      writeFileSync(join(dumpHostPath, "nested-incomplete", "tenant", "dir", "incomplete"), "", "utf8");
      mkdirSync(join(dumpHostPath, "no-tenant"), { recursive: true });
      const ctx = createContext(undefined, new ShellCommandExecutor(), ConfigSchema.parse({
        profiles: {
          default: {
            dumpHostPath
          }
        }
      }));

      const response = await listDumps(ctx);

      expect(response.ok).toBe(true);
      expect(response.stdout).toBe("complete\n");
      expect(response.dumps).toEqual([
        {
          name: "complete",
          hostPath: `${dumpHostPath}/complete`,
          tenantDumpPath: `${dumpHostPath}/complete/tenant`
        }
      ]);
    } finally {
      rmSync(dumpHostPath, { recursive: true, force: true });
    }
  });

  it("builds path-level dump commands with validated relative YDB paths", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await dumpTenant(ctx, { dumpName: "path-smoke", path: "dir/table" });

    expect(response.executed).toBe(false);
    expect(response).toMatchObject({
      dumpName: "path-smoke",
      path: "dir/table",
      sourcePath: "/local/example/dir/table",
      dumpPath: "/tmp/local-ydb-dump/path-smoke"
    });
    expect(response.summary).toContain("Dump /local/example/dir/table");
    expect(response.plannedCommands[1]).toContain("tools dump -p dir/table --exclude");
    expect(response.plannedCommands[1]).toContain("-o /dump/path-smoke/tenant");
  });

  it("rejects unsafe dump names and YDB relative paths", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    await expect(dumpTenant(ctx, { dumpName: "../escape" })).rejects.toThrow("dumpName must be a single directory name");
    await expect(dumpTenant(ctx, { path: "/local/example/table" })).rejects.toThrow("path must be . or a relative YDB path");
    await expect(restoreTenant(ctx, { dumpName: "mcp-smoke", path: "dir//table" })).rejects.toThrow("path must be . or a relative YDB path");
  });

  it("keeps restore plan-only while appending optional verification hooks", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await restoreTenant(ctx, {
      dumpName: "mcp-smoke",
      path: "restore-root",
      describePaths: ["restore-root/table"],
      countQueries: [
        {
          label: "table rows",
          query: "SELECT COUNT(*) AS rows FROM `restore-root/table`;"
        }
      ]
    });

    expect(response.executed).toBe(false);
    expect(response.risk).toBe("high");
    expect(response).toMatchObject({
      dumpName: "mcp-smoke",
      path: "restore-root",
      targetPath: "/local/example/restore-root",
      verificationHooks: [
        {
          type: "schemeDescribe",
          path: "restore-root/table",
          resolvedPath: "/local/example/restore-root/table"
        },
        {
          type: "countQuery",
          label: "table rows",
          query: "SELECT COUNT(*) AS rows FROM `restore-root/table`;"
        }
      ]
    });
    expect(response.summary).toContain("Restore /local/example/restore-root");
    expect(response.plannedCommands).toHaveLength(3);
    expect(response.plannedCommands[0]).toContain("tools restore -p restore-root -i /dump/mcp-smoke/tenant");
    expect(response.plannedCommands[1]).toContain("scheme describe /local/example/restore-root/table");
    expect(response.plannedCommands[2]).toContain("sql -s 'SELECT COUNT(*) AS rows FROM `restore-root/table`;'");
  });

  it("executes restore verification hooks after the restore command", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await restoreTenant(ctx, {
      confirm: true,
      dumpName: "mcp-smoke",
      describePaths: ["table"],
      countQueries: [{ query: "SELECT COUNT(*) FROM `table`;" }]
    });

    expect(response.executed).toBe(true);
    expect(executor.commands).toHaveLength(3);
    expect(executor.commands[0]).toContain("tools restore -p . -i /dump/mcp-smoke/tenant");
    expect(executor.commands[1]).toContain("scheme describe /local/example/table");
    expect(executor.commands[2]).toContain("sql -s 'SELECT COUNT(*) FROM `table`;'");
  });

  it("rejects count query set operations", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    for (const setOperation of ["UNION ALL", "INTERSECT", "EXCEPT"]) {
      await expect(restoreTenant(ctx, {
        dumpName: "mcp-smoke",
        countQueries: [{ query: `SELECT COUNT(*) FROM \`table\` ${setOperation} SELECT COUNT(*) FROM \`other_table\`;` }]
      })).rejects.toThrow("countQueries[].query must contain a single SELECT COUNT statement");
    }
  });

  it("rejects count query subqueries and unsupported count expressions", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    for (const query of [
      "SELECT COUNT(*) FROM (SELECT id FROM `admin_table`) AS t;",
      "SELECT COUNT(NULLIF(id, 0)) FROM `table`;",
      "SELECT COUNT(*) FROM `../table`;"
    ]) {
      await expect(restoreTenant(ctx, {
        dumpName: "mcp-smoke",
        countQueries: [{ query }]
      })).rejects.toThrow(/countQueries\[\]\.query/);
    }
  });

  it("allows count query guard tokens inside quoted identifiers", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const response = await restoreTenant(ctx, {
      dumpName: "mcp-smoke",
      countQueries: [{ query: "SELECT COUNT(*) FROM `except;table`;" }]
    });

    expect(response.executed).toBe(false);
    expect(response.verificationHooks).toEqual([
      { type: "countQuery", label: "count query 1", query: "SELECT COUNT(*) FROM `except;table`;" }
    ]);
  });

  it("waits for tenant readiness instead of trusting create exit code", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await createTenant(ctx, {});
    expect(response.executed).toBe(false);
    expect(response.plannedCommands[0]).toContain("status_rc=0");
    expect(response.plannedCommands[0]).toContain("status_rc=$?");
    expect(response.plannedCommands[0]).toContain("create_rc=0");
    expect(response.plannedCommands[0]).toContain("Unknown tenant|NOT_FOUND");
    expect(response.plannedCommands[0]).toContain("State:[[:space:]]*(RUNNING|PENDING_RESOURCES)");
    expect(response.plannedCommands[0]).toContain("SCHEME_ERROR|No database found");
    expect(response.plannedCommands[0]).toContain("Group fit error|failed to allocate group|no group options");
    expect(response.plannedCommands[0]).toContain("sleep 2");
    expect(response.plannedCommands[0]).not.toContain("if docker exec ydb-local /ydbd --server localhost:2136 --no-password admin database /local/example status >\"$tmp\" 2>&1; then");
  });

  it("treats readable tenant status as success when ydbd returns non-zero", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      return {
        command,
        exitCode: 1,
        stdout: "Database /local/example status:\n  State: PENDING_RESOURCES\n",
        stderr: "",
        ok: false,
        timedOut: false
      };
    };

    const response = await createTenant(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(response.summary).toContain("Executed 1/1 commands");
    expect(response.results?.[0]?.ok).toBe(true);
    expect(response.results?.[0]?.exitCode).toBe(1);
  });

  it("ensures the tenant exists before restarting the dynamic node", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await restartStack(ctx, {});
    expect(response.executed).toBe(false);
    const tenantCommandIndex = response.plannedCommands.findIndex((command) => command.includes("admin database /local/example"));
    const dynamicCommandIndex = response.plannedCommands.findIndex((command) => (
      command.includes("docker rm -f") && command.includes("--name ydb-dyn-example ")
    ));
    expect(tenantCommandIndex).toBeGreaterThan(-1);
    expect(dynamicCommandIndex).toBeGreaterThan(tenantCommandIndex);
    expect(response.plannedCommands[tenantCommandIndex]).toContain("SCHEME_ERROR|No database found");
  });

  it("checks static compatibility before planning any restart mutation", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));

    const response = await restartStack(ctx, {});
    const compatibilityIndex = response.plannedCommands.findIndex((command) => (
      command.includes("HostConfig.PortBindings")
      && command.includes("does not match profile published ports")
    ));
    const firstMutationIndex = response.plannedCommands.findIndex((command) => (
      command.includes("docker stop ")
    ));

    expect(compatibilityIndex).toBeGreaterThanOrEqual(0);
    expect(compatibilityIndex).toBeLessThan(firstMutationIndex);
  });

  it("rejects incompatible static bindings before mutating restart containers", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("does not match profile published ports")) {
        return commandResult(command, {
          exitCode: 1,
          stderr: "Existing static container ydb-local does not match profile published ports.",
          ok: false
        });
      }
      if (command.includes("docker ps -a --format")) {
        return commandResult(command, {
          stdout: [
            '{"Names":"ydb-local","State":"running","ID":"static-id"}',
            '{"Names":"ydb-dyn-example","State":"running","ID":"primary-id"}',
            '{"Names":"ydb-dyn-example-4","State":"running","ID":"one-off-id"}'
          ].join("\n")
        });
      }
      if (command.includes("docker rm -f ydb-dyn-example")) {
        return commandResult(command, { exitCode: 1, stderr: "mutation reached", ok: false });
      }
      return commandResult(command);
    };

    const response = await restartStack(ctx, { confirm: true });
    const mutationCommands = executor.commands.filter((command) => (
      !command.includes("does not match profile published ports")
    ));

    expect(response.results?.at(-1)?.stderr).toContain("does not match profile published ports");
    expect(mutationCommands.some((command) => (
      command.includes("docker stop ")
      || command.includes("docker start ")
      || command.includes("docker rm -f ")
    ))).toBe(false);
  });

  it("reports restart drift and preserves unexpected container state without removing it", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            '{"Names":"ydb-local","State":"running"}',
            '{"Names":"ydb-dyn-example","State":"running","ID":"primary-id"}',
            '{"Names":"ydb-dyn-example-3","State":"exited","ID":"configured-3-id"}',
            '{"Names":"ydb-dyn-example-4","State":"running","ID":"one-off-4-id"}',
            '{"Names":"ydb-dyn-example-5","State":"exited","ID":"one-off-5-id"}'
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.startsWith("docker inspect ")) {
        return { command, exitCode: 0, stdout: "[]", stderr: "", ok: true, timedOut: false };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await restartStack(ctx, {});
    const plan = response.plannedCommands.join("\n");

    expect(response.missingDynamicContainers).toEqual(["ydb-dyn-example-2"]);
    expect(response.unexpectedDynamicContainers).toEqual(["ydb-dyn-example-4", "ydb-dyn-example-5"]);
    expect(plan).toContain("docker stop ydb-dyn-example-4");
    expect(plan).toContain("docker start ydb-dyn-example-4");
    expect(plan).not.toContain("docker start ydb-dyn-example-5");
    expect(plan).not.toMatch(/docker rm -f ydb-dyn-example-4(?:\s|$)/);
    expect(plan).not.toMatch(/docker rm -f ydb-dyn-example-5(?:\s|$)/);
    expect(response.rollback.join("\n")).toMatch(/local_ydb_(restart_stack|bootstrap)/);
    expect(response.rollback.join("\n")).not.toContain("configured container definitions captured by local_ydb_inventory");
    expect(response.rollback).toContain("docker start ydb-dyn-example-4");
  });

  it("recreates a configured container found restarting during restart preflight", async () => {
    vi.useFakeTimers();
    let nodeTwoStopped = false;
    let nodeTwoRecreated = false;
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 2 } }
    }));
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return commandResult(command, {
          stdout: [
            '{"Names":"ydb-local","State":"running"}',
            '{"Names":"ydb-dyn-example","State":"running"}',
            '{"Names":"ydb-dyn-example-2","State":"restarting"}'
          ].join("\n")
        });
      }
      if (command.includes("docker stop ydb-dyn-example-2")) {
        nodeTwoStopped = true;
      }
      if (command.includes("docker rm -f ydb-dyn-example-2")) {
        nodeTwoRecreated = nodeTwoStopped || !command.includes(".State.Running");
      }
      if (command.includes("{{.RestartCount}}")) {
        const nodeTwo = command.includes("ydb-dyn-example-2");
        return commandResult(command, {
          stdout: nodeTwo && !nodeTwoRecreated
            ? "node-two-id\ttrue\ttrue\t4"
            : `${nodeTwo ? "node-two-id" : "node-one-id"}\ttrue\tfalse\t0`
        });
      }
      if (command.startsWith("docker inspect ")) {
        return commandResult(command, { stdout: "[]" });
      }
      return commandResult(command);
    };
    ctx.client.viewerGet = async (path) => path.includes("nodelist")
      ? { status: "ok", data: [{ Id: 50_000, Port: 19002 }, { Id: 50_001, Port: 19003 }] }
      : { status: "ok", data: { TenantInfo: [{ AliveNodes: 2, NodeIds: [50_000, 50_001] }] } };

    const planOnly = await restartStack(ctx, {});
    const nodeTwoPlan = planOnly.plannedCommands.find((command) => command.includes("--name ydb-dyn-example-2"));
    expect(nodeTwoPlan).toContain("docker rm -f ydb-dyn-example-2");
    expect(nodeTwoPlan).not.toContain(".State.Running");

    const pending = restartStack(ctx, { confirm: true });
    await vi.runAllTimersAsync();
    const response = await pending;

    expect(nodeTwoRecreated).toBe(true);
    expect(response.summary).toContain("verified 2/2 configured dynamic nodes");
  });

  it("restores only previously running unexpected containers after configured nodes", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            '{"Names":"ydb-local","State":"running"}',
            '{"Names":"ydb-dyn-example","State":"running"}',
            '{"Names":"ydb-dyn-example-2","State":"running","ID":"running-extra"}',
            '{"Names":"ydb-dyn-example-3","State":"exited","ID":"stopped-extra"}'
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("{{.RestartCount}}")) {
        return { command, exitCode: 0, stdout: STABLE_DYNAMIC_CONTAINER_STATE, stderr: "", ok: true, timedOut: false };
      }
      if (command.startsWith("docker inspect ")) {
        return { command, exitCode: 0, stdout: "[]", stderr: "", ok: true, timedOut: false };
      }
      if (command.includes("viewer/json/nodelist")) {
        return { command, exitCode: 0, stdout: '[{"Port":19002}]', stderr: "", ok: true, timedOut: false };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await withRunTimers(() => restartStack(ctx, { confirm: true }));
    const commands = executor.commands.join("\n");
    const configuredStart = executor.commands.findIndex((command) => command.includes("--name ydb-dyn-example "));
    const unexpectedStart = executor.commands.findIndex((command) => command.includes("docker start ydb-dyn-example-2"));

    expect(response.results?.every((result) => result.ok)).toBe(true);
    expect(commands).toContain("docker stop ydb-dyn-example-2");
    expect(commands).not.toContain("docker stop ydb-dyn-example-3");
    expect(unexpectedStart).toBeGreaterThan(configuredStart);
    expect(commands).not.toContain("docker start ydb-dyn-example-3");
    expect(commands).not.toMatch(/docker rm -f ydb-dyn-example-[23](?:\s|$)/);
  });

  it.each([
    { phase: "base restart", failureCommand: "docker start ydb-local", error: "static start failed" },
    { phase: "configured-node command", failureCommand: "--name ydb-dyn-example ", error: "configured start failed" }
  ])("restores a running unexpected container after a $phase failure", async ({ failureCommand, error }) => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            '{"Names":"ydb-local","State":"running"}',
            '{"Names":"ydb-dyn-example","State":"running"}',
            '{"Names":"ydb-dyn-example-2","State":"running","ID":"one-off-2"}'
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes(failureCommand)) {
        return { command, exitCode: 1, stdout: "", stderr: error, ok: false, timedOut: false };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await restartStack(ctx, { confirm: true });
    const failureIndex = response.results?.findIndex((result) => result.stderr === error) ?? -1;
    const recoveryIndex = response.results?.findIndex((result) => result.command.includes("docker start ydb-dyn-example-2")) ?? -1;

    expect(failureIndex).toBeGreaterThan(-1);
    expect(recoveryIndex).toBeGreaterThan(failureIndex);
  });

  it("restores a running unexpected container after configured-node readiness failure", async () => {
    vi.useFakeTimers();
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    confirmDynamicPorts(ctx, [19002]);
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            '{"Names":"ydb-local","State":"running"}',
            '{"Names":"ydb-dyn-example","State":"running"}',
            '{"Names":"ydb-dyn-example-2","State":"running","ID":"one-off-2"}'
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("{{.RestartCount}}")) {
        return {
          command,
          exitCode: 0,
          stdout: "container-id\ttrue\ttrue\t1",
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const pending = restartStack(ctx, { confirm: true });
    await vi.runAllTimersAsync();
    const response = await pending;
    const failureIndex = response.results?.findIndex((result) => result.command.includes("verify dynamic node")) ?? -1;
    const recoveryIndex = response.results?.findIndex((result) => result.command.includes("docker start ydb-dyn-example-2")) ?? -1;

    expect(response.results?.[failureIndex]).toMatchObject({ ok: false });
    expect(response.results?.[failureIndex]?.stderr).toContain("matching IC port does not confirm the exact container");
    expect(recoveryIndex).toBeGreaterThan(failureIndex);
  });

  it("attempts every unexpected-node recovery before stopping after a recovery failure", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    confirmDynamicPorts(ctx, [19002]);
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            '{"Names":"ydb-local","State":"running"}',
            '{"Names":"ydb-dyn-example","State":"running"}',
            '{"Names":"ydb-dyn-example-2","State":"running","ID":"one-off-2"}',
            '{"Names":"ydb-dyn-example-3","State":"running","ID":"one-off-3"}',
            '{"Names":"ydb-dyn-example-4","State":"exited","ID":"stopped-one-off-4"}'
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker start ydb-dyn-example-2")) {
        return { command, exitCode: 1, stdout: "", stderr: "first recovery failed", ok: false, timedOut: false };
      }
      const stdout = command.includes("{{.RestartCount}}") ? STABLE_DYNAMIC_CONTAINER_STATE : "";
      return { command, exitCode: 0, stdout, stderr: "", ok: true, timedOut: false };
    };

    const response = await withRunTimers(() => restartStack(ctx, { confirm: true }));
    const recoveryCommands = response.results
      ?.filter((result) => result.command.includes("docker start ydb-dyn-example-"));

    expect(recoveryCommands).toHaveLength(2);
    expect(recoveryCommands?.[0].command).toContain("docker start ydb-dyn-example-2");
    expect(recoveryCommands?.[1].command).toContain("docker start ydb-dyn-example-3");
    expect(executor.commands.some((command) => command.includes("docker start ydb-dyn-example-4"))).toBe(false);
    expect(executor.commands.some((command) => command.includes("scheme ls /local/example"))).toBe(false);
  });

  it("adds an auth-token mount when the dynamic node auth file is configured", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicNodeAuthTokenFile: "/tmp/local-ydb-auth.pb"
        }
      }
    }));
    const response = await startDynamicNode(ctx, {});
    expect(response.executed).toBe(false);
    expect(response.plannedCommands[0]).toContain("docker image inspect");
    expect(response.plannedCommands[1]).toContain("-e GRPC_TLS_PORT=");
    expect(response.plannedCommands[1]).toContain("-e YDB_GRPC_ENABLE_TLS=0");
    expect(response.plannedCommands[1]).toContain("local-ydb-dynamic-config.yaml");
    expect(response.plannedCommands[1]).toContain("/ydb_data/cluster/kikimr_configs/config.yaml");
    expect(response.plannedCommands[1]).toContain("/ydb_data/kikimr_configs/config.yaml");
    expect(response.plannedCommands[1]).toContain("\"$source_config\"");
    expect(response.plannedCommands[1]).not.toContain("sed -e '/^  ca: \\/ydb_certs\\/ca\\.pem$/d' -e '/^  cert: \\/ydb_certs\\/cert\\.pem$/d' -e '/^  key: \\/ydb_certs\\/key\\.pem$/d' /ydb_data/cluster/kikimr_configs/config.yaml");
    expect(response.plannedCommands[1]).toContain("/tmp/local-ydb-auth.pb:/run/local-ydb/dynamic-node-auth.pb:ro");
    expect(response.plannedCommands[1]).toContain("--auth-token-file /run/local-ydb/dynamic-node-auth.pb");
  });

  it("redacts custom dynamic auth token file and parent directory in planned commands", async () => {
    const shellDisplay = new ShellCommandExecutor();
    const executor = new RecordingExecutor();
    executor.display = (profile, spec) => shellDisplay.display(profile, spec);
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await writeDynamicNodeAuthConfig(ctx, {
      sid: "root@builtin",
      tokenHostPath: "/tmp/local-ydb-auth/quote'd/dynamic-node-auth.pb"
    });

    expect(response.executed).toBe(false);
    expect(response.plannedCommands[0]).toContain("install -d -m 0700 <redacted>");
    expect(response.plannedCommands[0]).toContain("> <redacted>");
    expect(response.plannedCommands[0]).not.toContain("<redacted>/dynamic-node-auth.pb");
    expect(response.plannedCommands[0]).toContain("chmod 600 <redacted>");
    expect(response.plannedCommands[0]).not.toContain("/tmp/local-ydb-auth");
    expect(response.plannedCommands[0]).not.toContain("quote");
  });

  it("plans additional dynamic nodes with unique containers and ports", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicContainer: "ydb-dyn-example",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb-auth.pb",
          ports: {
            dynamicGrpc: 2137,
            dynamicMonitoring: 8766,
            dynamicIc: 19002
          }
        }
      }
    }));
    const response = await addDynamicNodes(ctx, { count: 2 });
    expect(response.executed).toBe(false);
    expect(response.nodes.map((node) => node.container)).toEqual(["ydb-dyn-example-2", "ydb-dyn-example-3"]);
    expect(response.nodes.map((node) => node.grpcPort)).toEqual([2138, 2139]);
    expect(response.nodes.map((node) => node.monitoringPort)).toEqual([8767, 8768]);
    expect(response.nodes.map((node) => node.icPort)).toEqual([19003, 19004]);
    expect(response.plannedCommands.join("\n")).toContain("--auth-token-file /run/local-ydb/dynamic-node-auth.pb");
    expect(response.plannedCommands.join("\n")).toContain("--name ydb-dyn-example-2");
    expect(response.plannedCommands.join("\n")).toContain("--name ydb-dyn-example-3");
  });

  it("defaults one-off scaling to the node after the configured topology", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));

    const response = await addDynamicNodes(ctx, {});

    expect(response.nodes).toEqual([
      { container: "ydb-dyn-example-4", index: 4, grpcPort: 2140, monitoringPort: 8769, icPort: 19005 }
    ]);
    expect(response.plannedCommands.join("\n")).toContain(".State.Running");
  });

  it("keeps start_dynamic_node idempotent for a running primary container", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const response = await startDynamicNode(ctx, {});

    expect(response.plannedCommands.join("\n")).toContain(".State.Running");
  });

  it("rejects standalone primary start when its ports collide with the static node", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { ports: { dynamicIc: 19001 } } }
    }));

    await expect(startDynamicNode(ctx, {})).rejects.toThrow(/static IC.*19001|19001.*static IC/i);
    expect(executor.commands).toEqual([]);
  });

  it("rejects default removal when a three-node topology has no one-off nodes", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            '{"Names":"ydb-dyn-example"}',
            '{"Names":"ydb-dyn-example-2"}',
            '{"Names":"ydb-dyn-example-3"}'
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    await expect(removeDynamicNodes(ctx, {})).rejects.toThrow("Requested 1 removable dynamic nodes but found 0");
    expect(executor.commands.some((command) => command.includes("docker rm"))).toBe(false);
  });

  it("plans removing the highest-index extra dynamic nodes by default", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: { dynamicContainer: "ydb-dyn-example", dynamicNodeCount: 3 }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            '{"Names":"ydb-dyn-example-2"}',
            '{"Names":"ydb-dyn-example-3"}',
            '{"Names":"ydb-dyn-example-4"}',
            '{"Names":"ydb-dyn-example-5"}'
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker inspect ydb-dyn-example-5")) {
        return {
          command,
          exitCode: 0,
          stdout: '[{"Name":"/ydb-dyn-example-5","Args":["-lc","exec /ydbd --ic-port 19006"]}]',
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };
    const response = await removeDynamicNodes(ctx, {});
    expect(response.executed).toBe(false);
    expect(response.nodes.map((node) => node.container)).toEqual(["ydb-dyn-example-5"]);
    expect(response.plannedCommands[0]).toContain("docker rm -f ydb-dyn-example-5");
    expect(response.rollback.join("\n")).toContain("local_ydb_add_dynamic_nodes");
    expect(response.rollback.join("\n")).not.toMatch(/local_ydb_(restart_stack|bootstrap)/);
  });

  it.each([
    { selector: "container", options: { containers: ["ydb-dyn-example-2"] } },
    { selector: "startIndex", options: { startIndex: 2 } }
  ])("allows explicit $selector selection of a configured suffix", async ({ options }) => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return { command, exitCode: 0, stdout: '{"Names":"ydb-dyn-example-2"}', stderr: "", ok: true, timedOut: false };
      }
      if (command.includes("docker inspect")) {
        return { command, exitCode: 0, stdout: '[{"Name":"/ydb-dyn-example-2","Args":["--ic-port","19003"]}]', stderr: "", ok: true, timedOut: false };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await removeDynamicNodes(ctx, options);

    expect(response.nodes.map((node) => node.container)).toEqual(["ydb-dyn-example-2"]);
    expect(response.rollback.join("\n")).toMatch(/local_ydb_(restart_stack|bootstrap)/);
    expect(response.rollback.join("\n")).not.toContain("local_ydb_add_dynamic_nodes");
  });

  it("allows explicit YDB node ID selection of a configured suffix", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicContainer: "ydb-dyn-example",
          dynamicNodeCount: 3
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: '{"Names":"ydb-dyn-example"}\n{"Names":"ydb-dyn-example-2"}\n{"Names":"ydb-dyn-example-3"}\n',
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker inspect")) {
        return {
          command,
          exitCode: 0,
          stdout: JSON.stringify([
            { Name: "/ydb-dyn-example-2", Args: ["-lc", "exec /ydbd --ic-port 19003"] },
            { Name: "/ydb-dyn-example-3", Args: ["-lc", "exec /ydbd --ic-port 19004"] }
          ]),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("viewer/json/nodelist")) {
        return {
          command,
          exitCode: 0,
          stdout: '[{"Id":50000,"Port":19002},{"Id":50001,"Port":19003},{"Id":50002,"Port":19004}]',
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await removeDynamicNodes(ctx, { nodeIds: [50001] });
    expect(response.executed).toBe(false);
    expect(response.nodes).toEqual([{ container: "ydb-dyn-example-2", index: 2, icPort: 19003, nodeId: 50001 }]);
    expect(response.plannedCommands[0]).toContain("docker rm -f ydb-dyn-example-2");
    expect(response.rollback.join("\n")).toMatch(/local_ydb_(restart_stack|bootstrap)/);
    expect(response.rollback.join("\n")).not.toContain("local_ydb_add_dynamic_nodes");
  });

  it("returns configured and one-off rollback guidance for mixed explicit removal", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount: 3 } }
    }));
    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return commandResult(command, {
          stdout: [
            '{"Names":"ydb-dyn-example-2","State":"running"}',
            '{"Names":"ydb-dyn-example-4","State":"running"}'
          ].join("\n")
        });
      }
      if (command.includes("docker inspect")) {
        return commandResult(command, {
          stdout: JSON.stringify([
            { Name: "/ydb-dyn-example-2", Args: ["--ic-port", "19003"] },
            { Name: "/ydb-dyn-example-4", Args: ["--ic-port", "19005"] }
          ])
        });
      }
      return commandResult(command);
    };

    const response = await removeDynamicNodes(ctx, {
      containers: ["ydb-dyn-example-2", "ydb-dyn-example-4"]
    });

    expect(response.rollback).toEqual([
      "Restore configured nodes with local_ydb_restart_stack or local_ydb_bootstrap.",
      "Recreate removed one-off nodes with local_ydb_add_dynamic_nodes using matching suffixes and ports if needed."
    ]);
  });

  it("rejects removing the profile base dynamic node by YDB node ID", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicContainer: "ydb-dyn-example"
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: '{"Names":"ydb-dyn-example"}\n{"Names":"ydb-dyn-example-2"}\n',
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker inspect")) {
        return {
          command,
          exitCode: 0,
          stdout: '[{"Name":"/ydb-dyn-example-2","Args":["-lc","exec /ydbd --ic-port 19003"]}]',
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("viewer/json/nodelist")) {
        return {
          command,
          exitCode: 0,
          stdout: '[{"Id":50000,"Port":19002},{"Id":50001,"Port":19003}]',
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    await expect(removeDynamicNodes(ctx, { nodeIds: [50000] })).rejects.toThrow("port 19002 is not a removable dynamic-node suffix");
  });

  it("retries tenant metadata verification after confirmed dynamic node removal", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicContainer: "ydb-dyn-example"
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: '{"Names":"ydb-dyn-example-2"}\n',
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker inspect")) {
        return {
          command,
          exitCode: 0,
          stdout: '[{"Name":"/ydb-dyn-example-2","Args":["-lc","exec /ydbd --ic-port 19003"]}]',
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("viewer/json/nodelist")) {
        return {
          command,
          exitCode: 0,
          stdout: '[{"Id":50000,"Port":19002}]',
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await removeDynamicNodes(ctx, { confirm: true });

    expect(response.executed).toBe(true);
    expect(executor.commands.some((command) => {
      return command.includes("scheme ls /local/example") && command.includes("TRANSPORT_UNAVAILABLE");
    })).toBe(true);
  });

  it("plans increasing NumGroups for the tenant storage pool", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          rootPasswordFile: "/tmp/local-ydb/root.password",
          tenantPath: "/local/example",
          storagePoolKind: "hdd"
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("ReadStoragePool")) {
        return {
          command,
          exitCode: 0,
          stdout: `Status {
  StoragePool {
    BoxId: 1
    StoragePoolId: 2
    Name: "/local/example:hdd"
    ErasureSpecies: "none"
    VDiskKind: "Default"
    Kind: "hdd"
    NumGroups: 1
    PDiskFilter {
      Property {
        Type: ROT
      }
    }
    ScopeId {
      X1: 72057594046678944
      X2: 38
    }
    ItemConfigGeneration: 2
  }
}`,
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };
    const response = await addStorageGroups(ctx, {});
    expect(response.executed).toBe(false);
    expect(response.pool.name).toBe("/local/example:hdd");
    expect(response.pool.numGroups).toBe(1);
    expect(response.pool.targetNumGroups).toBe(2);
    expect(response.plannedCommands[0]).toContain('Name: "/local/example:hdd"');
    expect(response.plannedCommands[0]).toContain("NumGroups: 2");
    expect(response.plannedCommands[0]).toContain("ItemConfigGeneration: 2");
  });

  it("plans reducing NumGroups through dump, rebuild, restore, and auth reapply", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb-auth/config.auth.yaml",
          dynamicNodeCount: 3,
          dynamicNodeAuthSid: "root@builtin",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb-auth/dynamic-node-auth.pb",
          rootPasswordFile: "/tmp/local-ydb-auth/root.password",
          tenantPath: "/local/example",
          storagePoolKind: "hdd"
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("ReadStoragePool")) {
        return {
          command,
          exitCode: 0,
          stdout: `Status {
  StoragePool {
    BoxId: 1
    StoragePoolId: 2
    Name: "/local/example:hdd"
    ErasureSpecies: "none"
    VDiskKind: "Default"
    Kind: "hdd"
    NumGroups: 2
    PDiskFilter {
      Property {
        Type: ROT
      }
    }
    ScopeId {
      X1: 72057594046678944
      X2: 38
    }
    ItemConfigGeneration: 3
  }
}`,
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            JSON.stringify({ Names: "ydb-dyn-example-4" }),
            JSON.stringify({ Names: "ydb-dyn-example-3" }),
            JSON.stringify({ Names: "ydb-dyn-example-2" }),
            JSON.stringify({ Names: "ydb-dyn-example" }),
            JSON.stringify({ Names: "ydb-local" })
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker volume ls")) {
        return { command, exitCode: 0, stdout: "ydb-local-data\n", stderr: "", ok: true, timedOut: false };
      }
      if (command.includes("docker inspect")) {
        return {
          command,
          exitCode: 0,
          stdout: JSON.stringify([{
            Name: "/ydb-dyn-example-4",
            Args: ["--grpc-port", "32004", "--mon-port", "9204", "--ic-port", "19204"]
          }]),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };
    const response = await reduceStorageGroups(ctx, { dumpName: "shrink-smoke" });
    expect(response.executed).toBe(false);
    expect(response.pool.name).toBe("/local/example:hdd");
    expect(response.pool.numGroups).toBe(2);
    expect(response.pool.targetNumGroups).toBe(1);
    expect(response.dumpName).toBe("shrink-smoke");
    expect(response.authReapplyPlanned).toBe(true);
    expect(response.extraDynamicNodes).toEqual(["ydb-dyn-example-4"]);
    expect(response.plannedCommands.join("\n")).toContain("/dump/shrink-smoke/tenant");
    expect(response.plannedCommands.join("\n")).toContain("admin database /local/example create hdd:1");
    expect(response.plannedCommands.join("\n")).toContain("/tmp/local-ydb-auth/config.auth.yaml");
    expect(response.plannedCommands.join("\n")).toContain("--name ydb-dyn-example-2");
    expect(response.plannedCommands.join("\n")).toContain("--name ydb-dyn-example-3");
    expect(response.plannedCommands.join("\n")).toContain("--name ydb-dyn-example-4");
    expect(response.plannedCommands.join("\n")).toContain("-e GRPC_PORT=32004");
    expect(response.plannedCommands.join("\n")).toContain("-e MON_PORT=9204");
    expect(response.plannedCommands.join("\n")).toContain("--grpc-port 32004");
    expect(response.plannedCommands.join("\n")).toContain("--mon-port 9204");
    expect(response.plannedCommands.join("\n")).toContain("--ic-port 19204");
    expect(response.verification.join("\n")).toContain("19204");
    for (const port of [2137, 2138, 2139]) {
      expect(response.plannedCommands.join("\n")).toContain(`127.0.0.1:${port}:${port}`);
    }
  });

  it("rejects storage reduction before dump or destroy when one-off ports cannot be inspected", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicContainer: "ydb-dyn-example",
          dynamicNodeCount: 3,
          staticContainer: "ydb-local",
          tenantPath: "/local/example",
          storagePoolKind: "hdd"
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("ReadStoragePool")) {
        return commandResult(command, {
          stdout: `Status {
  StoragePool {
    BoxId: 1
    StoragePoolId: 2
    Name: "/local/example:hdd"
    ErasureSpecies: "none"
    VDiskKind: "Default"
    Kind: "hdd"
    NumGroups: 2
    PDiskFilter {
      Property {
        Type: ROT
      }
    }
    ScopeId {
      X1: 72057594046678944
      X2: 38
    }
    ItemConfigGeneration: 3
  }
}`
        });
      }
      if (command.includes("docker ps -a --format")) {
        return commandResult(command, {
          stdout: [
            JSON.stringify({ Names: "ydb-dyn-example-4" }),
            JSON.stringify({ Names: "ydb-dyn-example-3" }),
            JSON.stringify({ Names: "ydb-dyn-example-2" }),
            JSON.stringify({ Names: "ydb-dyn-example" }),
            JSON.stringify({ Names: "ydb-local" })
          ].join("\n")
        });
      }
      if (command.includes("docker volume ls")) {
        return commandResult(command, { stdout: "ydb-local-data\n" });
      }
      if (command.includes("docker inspect")) {
        return commandResult(command, { stdout: "[]" });
      }
      return commandResult(command);
    };

    await expect(reduceStorageGroups(ctx, { confirm: true, dumpName: "shrink-smoke" }))
      .rejects.toThrow(/inspect exact gRPC, monitoring, and IC ports.*before destructive rebuild/i);
    expect(executor.commands.some((command) => command.includes("/dump/shrink-smoke"))).toBe(false);
    expect(executor.commands.some((command) => command.includes("docker rm -f"))).toBe(false);
  });

  it("executes storage-group reduction rebuild and reapplies auth before re-adding extra dynamic nodes", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb-auth/config.auth.yaml",
          dynamicContainer: "ydb-dyn-example",
          dynamicNodeCount: 3,
          dynamicNodeAuthSid: "root@builtin",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb-auth/dynamic-node-auth.pb",
          rootPasswordFile: "/tmp/local-ydb-auth/root.password",
          staticContainer: "ydb-local",
          tenantPath: "/local/example",
          storagePoolKind: "hdd"
        }
      }
    }));

    let readStoragePoolCalls = 0;
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);

      if (command.includes("ReadStoragePool")) {
        readStoragePoolCalls += 1;
        const numGroups = readStoragePoolCalls === 1 ? 2 : 1;
        const itemConfigGeneration = readStoragePoolCalls === 1 ? 3 : 2;
        return {
          command,
          exitCode: 0,
          stdout: `Status {
  StoragePool {
    BoxId: 1
    StoragePoolId: 2
    Name: "/local/example:hdd"
    ErasureSpecies: "none"
    VDiskKind: "Default"
    Kind: "hdd"
    NumGroups: ${numGroups}
    PDiskFilter {
      Property {
        Type: ROT
      }
    }
    ScopeId {
      X1: 72057594046678944
      X2: 38
    }
    ItemConfigGeneration: ${itemConfigGeneration}
  }
}`,
          stderr: "",
          ok: true,
          timedOut: false
        };
      }

      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            JSON.stringify({ Names: "ydb-dyn-example-4", Image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6" }),
            JSON.stringify({ Names: "ydb-dyn-example-3", Image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6" }),
            JSON.stringify({ Names: "ydb-dyn-example-2", Image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6" }),
            JSON.stringify({ Names: "ydb-dyn-example", Image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6" }),
            JSON.stringify({ Names: "ydb-local", Image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6" })
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }

      if (command.includes("docker volume ls")) {
        return {
          command,
          exitCode: 0,
          stdout: "ydb-local-data\n",
          stderr: "",
          ok: true,
          timedOut: false
        };
      }

      if (command.includes("{{.RestartCount}}")) {
        return {
          command,
          exitCode: 0,
          stdout: STABLE_DYNAMIC_CONTAINER_STATE,
          stderr: "",
          ok: true,
          timedOut: false
        };
      }

      if (command.includes("docker inspect")) {
        return {
          command,
          exitCode: 0,
          stdout: JSON.stringify([{
            Name: "/ydb-dyn-example-4",
            Args: ["--grpc-port", "2140", "--mon-port", "8769", "--ic-port", "19005"]
          }]),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }

      if (command.includes("viewer/json/nodelist")) {
        return {
          command,
          exitCode: 0,
          stdout: '[{"Port":19002},{"Port":19003},{"Port":19004},{"Port":19005}]',
          stderr: "",
          ok: true,
          timedOut: false
        };
      }

      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await withRunTimers(() => reduceStorageGroups(ctx, { confirm: true, dumpName: "shrink-smoke" }));
    expect(response.executed).toBe(true);
    expect(response.dumpName).toBe("shrink-smoke");
    expect(response.authReapplyPlanned).toBe(true);
    expect(response.extraDynamicNodes).toEqual(["ydb-dyn-example-4"]);
    expect(response.observedNumGroups).toBe(1);

    const commands = response.results?.map((result) => result.command) ?? [];
    expect(commands.some((command) => command.includes("/dump/shrink-smoke/tenant"))).toBe(true);
    expect(commands.some((command) => command.includes("admin database /local/example create hdd:1"))).toBe(true);
    expect(commands.filter((command) => command.includes("docker restart ydb-local")).length).toBe(2);
    expect(commands.some((command) => command.includes("cp /tmp/local-ydb-toolkit-config.yaml \"$target\""))).toBe(true);
    expect(commands.some((command) => command.includes("StaffApiUserToken: \"root@builtin\""))).toBe(true);
    expect(commands.some((command) => command.includes("--name ydb-dyn-example-2"))).toBe(true);
    expect(commands.some((command) => command.includes("--name ydb-dyn-example-3"))).toBe(true);
    expect(commands.some((command) => command.includes("--name ydb-dyn-example-4"))).toBe(true);
    expect(commands.some((command) => command.includes("verify rebuilt profile containers use image"))).toBe(true);

    const firstRestartIndex = commands.findIndex((command) => command.includes("docker restart ydb-local"));
    const recopyIndex = commands.findIndex((command) => command.includes("cp /tmp/local-ydb-toolkit-config.yaml \"$target\""));
    const secondRestartIndex = commands.findIndex((command, index) => index > firstRestartIndex && command.includes("docker restart ydb-local"));
    const readdExtraNodeIndex = commands.findIndex((command) => command.includes("--name ydb-dyn-example-4"));
    expect(firstRestartIndex).toBeGreaterThan(-1);
    expect(recopyIndex).toBeGreaterThan(firstRestartIndex);
    expect(secondRestartIndex).toBeGreaterThan(recopyIndex);
    expect(readdExtraNodeIndex).toBeGreaterThan(secondRestartIndex);
  });

  it("plans full stack teardown and keeps shared host paths opt-in", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicContainer: "ydb-dyn-example",
          staticContainer: "ydb-local",
          network: "ydb-net",
          volume: "ydb-local-data",
          authConfigPath: "/tmp/local-ydb-auth/config.auth.yaml",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb-auth/dynamic-node-auth.pb",
          rootPasswordFile: "/tmp/local-ydb-auth/root.password",
          dumpHostPath: "/tmp/local-ydb-dump"
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            JSON.stringify({ Names: "ydb-dyn-example-2" }),
            JSON.stringify({ Names: "ydb-dyn-example-3" }),
            JSON.stringify({ Names: "ydb-dyn-example" }),
            JSON.stringify({ Names: "ydb-local" })
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker volume ls")) {
        return { command, exitCode: 0, stdout: "ydb-local-data\n", stderr: "", ok: true, timedOut: false };
      }
      if (command.includes("docker inspect")) {
        return { command, exitCode: 0, stdout: "[]", stderr: "", ok: true, timedOut: false };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };
    const response = await destroyStack(ctx, {});
    expect(response.executed).toBe(false);
    expect(response.extraDynamicNodes).toEqual(["ydb-dyn-example-3", "ydb-dyn-example-2"]);
    expect(response.plannedCommands.join("\n")).toContain("admin database /local/example remove --force");
    expect(response.plannedCommands.join("\n")).toContain("docker rm -f ydb-dyn-example-3");
    expect(response.plannedCommands.join("\n")).toContain("docker rm -f ydb-dyn-example");
    expect(response.plannedCommands.join("\n")).toContain("docker network rm ydb-net");
    expect(response.plannedCommands.join("\n")).toContain("docker volume rm ydb-local-data");
    expect(response.removesAuthArtifacts).toBe(false);
    expect(response.removesDumpHostPath).toBe(false);
  });

  it("redacts auth artifact cleanup paths without malformed shell quotes", async () => {
    const shellDisplay = new ShellCommandExecutor();
    const executor = new RecordingExecutor();
    executor.display = (profile, spec) => shellDisplay.display(profile, spec);
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            JSON.stringify({ Names: "ydb-dyn-example" }),
            JSON.stringify({ Names: "ydb-local" })
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker volume ls")) {
        return { command, exitCode: 0, stdout: "ydb-local-data\n", stderr: "", ok: true, timedOut: false };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb-auth/quote'd/config.auth.yaml",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb-auth/quote'd/dynamic-node-auth.pb",
          rootPasswordFile: "/tmp/local-ydb-auth/quote'd/root.password"
        }
      }
    }));

    const response = await destroyStack(ctx, { removeAuthArtifacts: true });
    const plan = response.plannedCommands.join("\n");
    const artifactCleanupCommands = response.plannedCommands.filter((command) => command.includes("rm -f <redacted>"));

    expect(artifactCleanupCommands).toHaveLength(3);
    expect(artifactCleanupCommands.every((command) => command.endsWith("'"))).toBe(true);
    expect(plan).not.toContain("/tmp/local-ydb-auth");
    expect(plan).not.toContain("quote");
    expect(artifactCleanupCommands.join("\n")).not.toContain("\\''");
    expect(plan).not.toContain("rm -f <redacted>\n");
  });

  it("continues docker teardown when tenant removal is blocked by auth failure", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicContainer: "ydb-dyn-example",
          staticContainer: "ydb-local",
          network: "ydb-net",
          volume: "ydb-local-data",
          rootPasswordFile: "/tmp/local-ydb-auth/root.password"
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            JSON.stringify({ Names: "ydb-dyn-example-2" }),
            JSON.stringify({ Names: "ydb-dyn-example" }),
            JSON.stringify({ Names: "ydb-local" })
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker volume ls")) {
        return { command, exitCode: 0, stdout: "ydb-local-data\n", stderr: "", ok: true, timedOut: false };
      }
      if (command.includes("admin database /local/example remove --force")) {
        return {
          command,
          exitCode: 1,
          stdout: "",
          stderr: "UNAUTHORIZED\nUser root login denied: too many failed password attempts\n",
          ok: false,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await destroyStack(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(response.summary).toContain("continuing past tenant removal failure during teardown");
    expect(response.results?.[0]?.ok).toBe(false);
    expect(response.results?.some((result) => result.command.includes("docker volume rm ydb-local-data"))).toBe(true);
  });

  it("continues docker teardown when tenant removal cannot reach the static gRPC endpoint", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicContainer: "ydb-dyn-example",
          staticContainer: "ydb-local",
          network: "ydb-net",
          volume: "ydb-local-data"
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            JSON.stringify({ Names: "ydb-dyn-example" }),
            JSON.stringify({ Names: "ydb-local" })
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker volume ls")) {
        return { command, exitCode: 0, stdout: "ydb-local-data\n", stderr: "", ok: true, timedOut: false };
      }
      if (command.includes("admin database /local/example remove --force")) {
        return {
          command,
          exitCode: 1,
          stdout: "",
          stderr: "Status: UNAVAILABLE\nEndpoint list is empty: connection refused\n",
          ok: false,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await destroyStack(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(response.results?.[0]?.ok).toBe(false);
    expect(response.results?.some((result) => result.command.includes("docker rm -f ydb-local"))).toBe(true);
    expect(response.results?.some((result) => result.command.includes("docker volume rm ydb-local-data"))).toBe(true);
  });

  it("continues docker teardown when tenant removal returns only Status: UNAVAILABLE", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicContainer: "ydb-dyn-example",
          staticContainer: "ydb-local",
          network: "ydb-net",
          volume: "ydb-local-data"
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            JSON.stringify({ Names: "ydb-dyn-example" }),
            JSON.stringify({ Names: "ydb-local" })
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker volume ls")) {
        return { command, exitCode: 0, stdout: "ydb-local-data\n", stderr: "", ok: true, timedOut: false };
      }
      if (command.includes("admin database /local/example remove --force")) {
        return {
          command,
          exitCode: 1,
          stdout: "",
          stderr: "Status: UNAVAILABLE\n",
          ok: false,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await destroyStack(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(response.results?.[0]?.ok).toBe(false);
    expect(response.results?.some((result) => result.command.includes("docker rm -f ydb-local"))).toBe(true);
    expect(response.results?.some((result) => result.command.includes("docker volume rm ydb-local-data"))).toBe(true);
  });

  it("continues docker teardown when tenant removal is already complete", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicContainer: "ydb-dyn-example",
          staticContainer: "ydb-local",
          network: "ydb-net",
          volume: "ydb-local-data"
        }
      }
    }));
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      if (command.includes("docker ps -a --format")) {
        return {
          command,
          exitCode: 0,
          stdout: [
            JSON.stringify({ Names: "ydb-dyn-example" }),
            JSON.stringify({ Names: "ydb-local" })
          ].join("\n"),
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker volume ls")) {
        return { command, exitCode: 0, stdout: "ydb-local-data\n", stderr: "", ok: true, timedOut: false };
      }
      if (command.includes("admin database /local/example remove --force")) {
        return {
          command,
          exitCode: 1,
          stdout: "ERROR: NOT_FOUND\nDatabase '/local/example' doesn't exist\n",
          stderr: "",
          ok: false,
          timedOut: false
        };
      }
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false
      };
    };

    const response = await destroyStack(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(response.results?.[0]?.ok).toBe(true);
    expect(response.results?.[0]?.exitCode).toBe(1);
    expect(response.results?.some((result) => result.command.includes("docker volume rm ydb-local-data"))).toBe(true);
  });

  it("can write a dynamic-node auth config from profile defaults", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          dynamicNodeAuthSid: "root@builtin",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb/auth.pb"
        }
      }
    }));
    const response = await writeDynamicNodeAuthConfig(ctx, {});
    expect(response.executed).toBe(false);
    expect(response.plannedCommands[0]).toContain("StaffApiUserToken: \"root@builtin\"");
    expect(response.plannedCommands[0]).toContain("NodeRegistrationToken: \"root@builtin\"");
    expect(response.plannedCommands[0]).toContain("/tmp/local-ydb/auth.pb");
  });

  it("uses profile auth config and recreates the dynamic node during auth hardening", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb/config.yaml",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb/auth.pb"
        }
      }
    }));
    const response = await applyAuthHardening(ctx, {});
    expect(response.executed).toBe(false);
    expect(response.plannedCommands.some((command) => command.includes("docker cp /tmp/local-ydb/config.yaml"))).toBe(true);
    expect(response.plannedCommands.filter((command) => command.includes("docker restart ydb-local")).length).toBe(2);
    expect(response.plannedCommands.join("\n")).toContain("State:[[:space:]]*(RUNNING|PENDING_RESOURCES)");
    const firstRestartIndex = response.plannedCommands.findIndex((command) => command.includes("docker restart ydb-local"));
    const recopyIndex = response.plannedCommands.findIndex((command) => command.includes("cp /tmp/local-ydb-toolkit-config.yaml \"$target\""));
    expect(recopyIndex).toBeGreaterThan(firstRestartIndex);
    expect(response.plannedCommands.some((command) => command.includes("docker rm -f ydb-dyn-example"))).toBe(true);
    expect(response.plannedCommands.some((command) => command.includes("--auth-token-file /run/local-ydb/dynamic-node-auth.pb"))).toBe(true);
    expect(response.plannedCommands.join("\n")).toContain("SCHEME_ERROR|No database found");
    expect(response.plannedCommands.join("\n")).toContain("Group fit error|failed to allocate group|no group options");
    expect(response.rollback.join("\n")).toMatch(/local_ydb_(restart_stack|bootstrap)/);
    expect(response.rollback.join("\n")).not.toMatch(/docker start ydb-dyn-example(?:-|$)/m);
  });

  it("checks static compatibility before any auth-hardening mutation", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb/config.yaml",
          dynamicNodeCount: 3
        }
      }
    }));

    const plan = await applyAuthHardening(ctx, {});
    const compatibilityIndex = plan.plannedCommands.findIndex((command) => (
      command.includes("HostConfig.PortBindings")
      && command.includes("does not match profile published ports")
    ));
    const firstMutationIndex = plan.plannedCommands.findIndex((command) => (
      command.startsWith("bash -lc 'docker cp ")
      || command.startsWith("bash -lc 'docker stop ")
      || command.startsWith("bash -lc 'docker restart ")
      || command.includes("docker rm -f ydb-dyn-example 2>/dev/null")
    ));

    expect(compatibilityIndex).toBeGreaterThanOrEqual(0);
    expect(compatibilityIndex).toBeLessThan(firstMutationIndex);

    executor.run = async (profile, spec) => {
      const command = executor.display(profile, spec);
      executor.commands.push(command);
      if (command.includes("does not match profile published ports")) {
        return commandResult(command, {
          exitCode: 1,
          stderr: "Existing static container ydb-local does not match profile published ports.",
          ok: false
        });
      }
      return commandResult(command, {
        exitCode: 1,
        stderr: "auth mutation reached before compatibility preflight",
        ok: false
      });
    };

    const confirmed = await applyAuthHardening(ctx, { confirm: true });
    expect(confirmed.results?.at(-1)?.stderr).toContain("does not match profile published ports");
    expect(executor.commands.some((command) => (
      command.startsWith("bash -lc 'docker cp ")
      || command.startsWith("bash -lc 'docker stop ")
      || command.startsWith("bash -lc 'docker restart ")
      || command.includes("docker rm -f ydb-dyn-example 2>/dev/null")
    ))).toBe(false);
  });

  it("recreates every configured dynamic node during auth hardening", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb/config.yaml",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb/auth.pb",
          dynamicNodeCount: 3
        }
      }
    }));

    const response = await applyAuthHardening(ctx, {});
    const plan = response.plannedCommands.join("\n");

    expect(plan).toContain("docker stop ydb-dyn-example-3");
    expect(plan).toContain("docker stop ydb-dyn-example-2");
    expect(plan).toContain("docker stop ydb-dyn-example");
    expect(plan).toContain("--name ydb-dyn-example ");
    expect(plan).toContain("--name ydb-dyn-example-2 ");
    expect(plan).toContain("--name ydb-dyn-example-3 ");
    expect(response.verification.join("\n")).toContain("19002, 19003, 19004");
  });

  it("recreates every configured dynamic node during no-token auth hardening", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb/config.yaml",
          dynamicNodeCount: 3
        }
      }
    }));

    const response = await applyAuthHardening(ctx, {});
    const dynamicPlan = response.plannedCommands
      .filter((command) => command.includes("ydb-dyn-example"))
      .join("\n");

    expect(dynamicPlan).not.toContain("docker restart ydb-dyn-example");
    expect(dynamicPlan).toContain("docker rm -f ydb-dyn-example");
    expect(dynamicPlan).toContain("--name ydb-dyn-example ");
    expect(dynamicPlan).toContain("--name ydb-dyn-example-2 ");
    expect(dynamicPlan).toContain("--name ydb-dyn-example-3 ");
  });

  it("restores a missing configured node during confirmed no-token auth hardening", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb/config.yaml",
          dynamicNodeCount: 2
        }
      }
    }));
    confirmDynamicPorts(ctx, [19002, 19003]);

    const response = await withRunTimers(() => applyAuthHardening(ctx, { confirm: true }));

    expect(response.summary).toContain("restored 2/2 configured dynamic nodes");
    expect(executor.commands.some((command) => command.includes("docker rm -f ydb-dyn-example-2"))).toBe(true);
    expect(executor.commands.some((command) => command.includes("--name ydb-dyn-example-2 "))).toBe(true);
    expect(executor.commands.join("\n")).not.toContain("docker restart ydb-dyn-example");
  });

  it("adds an authenticated tenant metadata wait for auth-hardening profiles with rootPasswordFile", async () => {
    const executor = new RecordingExecutor();
    executor.display = (profile, spec) => redactCommand(commandToShell(spec), [profile.rootPasswordFile ?? ""]);
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb/config.yaml",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb/auth.pb",
          rootPasswordFile: "/tmp/local-ydb/root.password"
        }
      }
    }));

    const response = await applyAuthHardening(ctx, {});

    expect(response.executed).toBe(false);
    expect(response.plannedCommands.join("\n")).not.toContain("/tmp/local-ydb/root.password");
    expect(response.plannedCommands.some((command) => command.includes("<redacted> | docker exec -i"))).toBe(true);
    const dynamicRecreateIndex = response.plannedCommands.findIndex((command) => command.includes("docker run -d --name ydb-dyn-example"));
    const waitIndex = response.plannedCommands.findIndex((command) => command.includes("scheme ls /local/example"));
    expect(dynamicRecreateIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(dynamicRecreateIndex);
  });

  it("plans root password rotation without exposing the password", async () => {
    const executor = new RecordingExecutor();
    const password = "S3cr3t! rotate me";
    const rawCommands: string[] = [];
    const capturedSpecs: CommandSpec[] = [];
    executor.display = (profile, spec) => {
      capturedSpecs.push(spec);
      const escapedPassword = password.replace(/\\/g, "\\\\").replace(/'/g, "''");
      const rawCommand = commandToShell(spec);
      rawCommands.push(rawCommand);
      return redactCommand(rawCommand, [
        password,
        escapedPassword,
        profile.rootPasswordFile ?? "",
        `${profile.rootPasswordFile ?? ""}.before-local-ydb-toolkit-password-rotate`,
        `${profile.authConfigPath ?? ""}.before-local-ydb-toolkit-password-rotate`
      ]);
    };
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb/config.auth.yaml",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb/auth.pb",
          rootPasswordFile: "/tmp/local-ydb/root.password"
        }
      }
    }));
    const response = await setRootPassword(ctx, { password });
    expect(response.executed).toBe(false);
    expect(capturedSpecs[0].description).toContain("Alter runtime root password");
    expect(capturedSpecs[0].stdin).toBe(password);
    expect(capturedSpecs[1].description).toBe("Sync host auth config and root password file with the new root password");
    expect(capturedSpecs[1].stdin).toBe(password);
    expect(response.plannedCommands[0]).toContain("/tmp/local-ydb/config.auth.yaml");
    expect(response.plannedCommands.join("\n")).not.toContain("S3cr3t! rotate me");
    expect(response.plannedCommands.some((command) => command.includes("query_host=$(mktemp)"))).toBe(true);
    expect(response.plannedCommands.some((command) => command.includes("mktemp /tmp/local-ydb-toolkit-password-rotate-XXXXXX.yql"))).toBe(true);
    expect(response.plannedCommands.some((command) => command.includes("docker cp \"$query_host\""))).toBe(true);
    expect(response.plannedCommands.some((command) => command.includes("yql -f"))).toBe(true);
    const rotationPasswordFile = rawCommands[0].indexOf("password_file=$(mktemp /tmp/local-ydb-toolkit-root-password-XXXXXX)");
    const rotationTrap = rawCommands[0].indexOf("trap", rotationPasswordFile);
    const rotationPasswordWrite = rawCommands[0].indexOf("cat >\"$password_file\"", rotationPasswordFile);
    expect(rotationPasswordFile).toBeGreaterThan(-1);
    expect(rotationTrap).toBeGreaterThan(rotationPasswordFile);
    expect(rotationPasswordWrite).toBeGreaterThan(rotationTrap);
    expect(rawCommands[0]).toContain("EXIT HUP INT TERM");
    expect(rawCommands[0]).toContain("set -e; query_file=");
    expect(rawCommands[0]).toContain("rm -f \"$candidate\" \"$last_error\" \"$query_host\"; cleanup_query_container; trap - EXIT HUP INT TERM");
    expect(rawCommands[0]).toContain("sql_escaped = password.gsub");
    expect(rawCommands[0]).toContain("{ \"\\\\\\\\\" }.gsub");
    expect(response.plannedCommands.some((command) => command.includes("yql -s \"ALTER USER root PASSWORD"))).toBe(false);
    expect(response.plannedCommands[0]).toContain("last_error=$(mktemp)");
    expect(response.plannedCommands[1]).toContain("target=$(docker exec ydb-local sh -lc");
    expect(response.plannedCommands[1]).toContain("/ydb_data/kikimr_configs/config.yaml");
    expect(response.plannedCommands[1]).toContain("docker exec ydb-local cat \"$target\"");
    expect(rawCommands[1]).toContain("rm -f \"$password_host\"; trap - EXIT HUP INT TERM");
    expect(rawCommands[1]).toContain("rm -f \"$cfg_tmp\" \"$password_host\"; trap - EXIT HUP INT TERM");
    expect(rawCommands[1]).toContain("File.read(ARGV[5], mode: \"r:UTF-8\")");
    expect(response.plannedCommands.filter((command) => command.includes("docker restart ydb-local")).length).toBe(0);
    expect(response.plannedCommands.some((command) => command.includes("viewer/json/whoami"))).toBe(true);
    const verifyCommand = rawCommands[2] ?? "";
    const verifyPasswordFile = verifyCommand.indexOf("password_file=$(mktemp /tmp/local-ydb-toolkit-root-password-XXXXXX)");
    const verifyTrap = verifyCommand.indexOf("trap", verifyPasswordFile);
    const verifyPasswordWrite = verifyCommand.indexOf("cat >\"$password_file\"", verifyPasswordFile);
    expect(verifyPasswordFile).toBeGreaterThan(-1);
    expect(verifyTrap).toBeGreaterThan(verifyPasswordFile);
    expect(verifyPasswordWrite).toBeGreaterThan(verifyTrap);
    expect(verifyCommand).toContain("EXIT HUP INT TERM");
    expect(verifyCommand).toContain("set -e; umask 077");
  });

  it("keeps quoted and escaped passwords out of the planned rotation command", async () => {
    const executor = new RecordingExecutor();
    const password = "pa'ss\\word";
    executor.display = (profile, spec) => {
      const escapedPassword = password.replace(/\\/g, "\\\\").replace(/'/g, "''");
      return redactCommand(commandToShell(spec), [
        password,
        escapedPassword,
        shellQuote(password),
        shellQuote(escapedPassword),
        profile.rootPasswordFile ?? "",
        `${profile.rootPasswordFile ?? ""}.before-local-ydb-toolkit-password-rotate`,
        `${profile.authConfigPath ?? ""}.before-local-ydb-toolkit-password-rotate`
      ]);
    };
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb/config.auth.yaml",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb/auth.pb",
          rootPasswordFile: "/tmp/local-ydb/root.password"
        }
      }
    }));

    const response = await setRootPassword(ctx, { password });
    const plan = response.plannedCommands.join("\n");
    const escapedPassword = password.replace(/\\/g, "\\\\").replace(/'/g, "''");

    expect(plan).not.toContain(password);
    expect(plan).not.toContain(shellQuote(password));
    expect(plan).not.toContain(shellQuote(escapedPassword));
    expect(plan).toContain("docker cp \"$query_host\"");
    expect(plan).toContain("cleanup_query_container");
  });

  it("passes the root user to the rotation query generator as data", async () => {
    const executor = new RecordingExecutor();
    const rootUser = "root`; raise 'boom'; #";
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb/config.auth.yaml",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb/auth.pb",
          rootPasswordFile: "/tmp/local-ydb/root.password",
          rootUser
        }
      }
    }));

    const response = await setRootPassword(ctx, { password: "S3cr3t!" });
    const plan = response.plannedCommands.join("\n");

    expect(plan).toContain("ARGV.fetch(1)");
    expect(plan).toContain("yql_identifier");
    expect(plan).not.toContain(`ALTER USER ${rootUser}`);
  });

  it.each([
    ["carriage return", "line1\rline2"],
    ["newline", "line1\nline2"]
  ])("rejects passwords containing %s", async (_label, password) => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb/config.auth.yaml",
          dynamicNodeAuthTokenFile: "/tmp/local-ydb/auth.pb",
          rootPasswordFile: "/tmp/local-ydb/root.password"
        }
      }
    }));

    const response = await setRootPassword(ctx, { password });

    expect(response.executed).toBe(false);
    expect(response.summary).toContain("does not support passwords containing carriage returns or newlines");
    expect(response.plannedCommands).toEqual([]);
  });

  it("falls back to sudo when removing root-owned cleanup paths", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await cleanupStorage(ctx, { paths: ["/tmp/local-ydb-dump/mcp-smoke"] });
    expect(response.executed).toBe(false);
    expect(response.plannedCommands[0]).toContain("rm -rf -- /tmp/local-ydb-dump/mcp-smoke");
    expect(response.plannedCommands[0]).toContain("sudo -n rm -rf -- /tmp/local-ydb-dump/mcp-smoke");
  });

  it("skips absent cleanup volumes but fails if an existing volume cannot be removed", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await cleanupStorage(ctx, { volumes: ["local-ydb-toolkit-mcp-cleanup-smoke"] });
    expect(response.executed).toBe(false);
    expect(response.plannedCommands[0]).toContain("docker volume inspect local-ydb-toolkit-mcp-cleanup-smoke");
    expect(response.plannedCommands[0]).toContain("docker volume rm local-ydb-toolkit-mcp-cleanup-smoke");
    expect(response.plannedCommands[0]).toContain("no such volume");
    expect(response.plannedCommands[0]).not.toContain("docker volume rm local-ydb-toolkit-mcp-cleanup-smoke || true");
  });

  it("fails confirmed cleanup when an existing volume cannot be removed", async () => {
    const fakeBin = createTempExecutableDir({
      docker: `#!/bin/bash
set -euo pipefail
if [ "$1" = "volume" ] && [ "$2" = "inspect" ] && [ "$3" = "local-ydb-present-volume" ]; then
  printf '%s\\n' 'local-ydb-present-volume'
  exit 0
fi
if [ "$1" = "volume" ] && [ "$2" = "rm" ] && [ "$3" = "local-ydb-present-volume" ]; then
  printf '%s\\n' 'permission denied' >&2
  exit 3
fi
printf '%s\\n' "unexpected docker invocation: $*" >&2
exit 99
`
    });

    try {
      const executor = new ScriptRewritingShellExecutor((script) =>
        script.replace(/\bdocker\b/g, shellQuote(join(fakeBin.path, "docker")))
      );
      const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
      const response = await cleanupStorage(ctx, { confirm: true, volumes: ["local-ydb-present-volume"] });
      expect(response.executed).toBe(true);
      expect(response.results).toHaveLength(1);
      expect(response.results?.[0]).toMatchObject({
        ok: false,
        exitCode: 3
      });
      expect(response.results?.[0]?.command).not.toContain(`${fakeBin.path}/${fakeBin.path}`);
      expect(response.results?.[0]?.stderr).toContain("permission denied");
    } finally {
      fakeBin.cleanup();
    }
  });

  it("prepares a hardened auth config and root password file from the running static config", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb/config.auth.yaml",
          dynamicNodeAuthSid: "root@builtin",
          rootPasswordFile: "/tmp/local-ydb/root.password"
        }
      }
    }));
    const response = await prepareAuthConfig(ctx, {});
    expect(response.executed).toBe(false);
    expect(response.plannedCommands[0]).toContain("target=$(docker exec ydb-local sh -lc");
    expect(response.plannedCommands[0]).toContain("/ydb_data/cluster/kikimr_configs/config.yaml");
    expect(response.plannedCommands[0]).toContain("/ydb_data/kikimr_configs/config.yaml");
    expect(response.plannedCommands[0]).toContain("docker exec ydb-local cat \"$target\"");
    expect(response.plannedCommands[0]).not.toContain("docker exec ydb-local cat /ydb_data/cluster/kikimr_configs/config.yaml");
    expect(response.plannedCommands[0]).toContain("/tmp/local-ydb/config.auth.yaml");
    expect(response.plannedCommands[0]).toContain("/tmp/local-ydb/root.password");
    expect(response.plannedCommands[0]).toContain("register_dynamic_node_allowed_sids");
    expect(response.plannedCommands[0]).toContain("allowed_sids");
  });
});
