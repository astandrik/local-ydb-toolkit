import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  prepareAuthConfig,
  pullImage,
  pullImageStatus,
  redactCommand,
  reduceStorageGroups,
  removeDynamicNodes,
  restartStack,
  ShellCommandExecutor,
  shellQuote,
  startDynamicNode,
  setRootPassword,
  writeDynamicNodeAuthConfig,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  type ResolvedLocalYdbProfile
} from "../src/index.js";
import { ConfigSchema } from "../src/validation.js";

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
      stdout: "",
      stderr: "",
      ok: true,
      timedOut: false
    };
  }
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

describe("mutating operations", () => {
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
    expect(plan).toContain("docker port ydb-local 2136/tcp");
    expect(plan).toContain("docker port ydb-local 2137/tcp");
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
    expect(plan).toContain("docker port ydb-local 2136/tcp");
    expect(plan).not.toContain("-p 127.0.0.1:2137:2137");
    expect(plan).not.toContain("docker port ydb-local 2137/tcp");
    expect(plan).not.toContain("admin database");
    expect(plan).not.toContain("ydb-dyn-example");
    expect(plan).not.toContain("YDB_FEATURE_FLAGS=enable_graph_shard");
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
      if (command.includes("does not publish required gRPC port")) {
        return {
          command,
          exitCode: 1,
          stdout: "",
          stderr: "Existing static container ydb-local does not publish required gRPC port 127.0.0.1:2136.",
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
    expect(response.results?.at(-1)?.stderr).toContain("does not publish required gRPC port");
    expect(executor.commands.some((command) => command.includes("admin database /local/example create"))).toBe(false);
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
        stdout: "",
        stderr: command.includes("/viewer/json/capabilities") ? "curl probe failed" : "",
        ok: true,
        timedOut: false
      };
    };

    const response = await bootstrap(ctx, { confirm: true });
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
    expect(pullImageStatus("missing-job")).toMatchObject({
      found: false,
      jobId: "missing-job",
      status: "unknown"
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
  });

  it("installs supported prerequisite packages when confirm=true", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
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
      if (command.includes("command -v apt-get")) {
        return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
      }
      return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
    };

    const response = await checkPrerequisites(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(response.plannedCommands.join("\n")).toContain("sudo -n apt-get update");
    expect(response.plannedCommands.join("\n")).toContain("sudo -n apt-get install -y curl ruby");
  });

  it("executes bootstrap commands with confirm=true", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await bootstrap(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(executor.commands.length).toBeGreaterThan(1);
    expect(executor.commands.join("\n")).toContain("admin database");
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
    const dynamicCommandIndex = response.plannedCommands.findIndex((command) => command.includes("docker rm -f <redacted>") || command.includes("YDB_GRPC_ENABLE_TLS=0"));
    expect(tenantCommandIndex).toBeGreaterThan(-1);
    expect(dynamicCommandIndex).toBeGreaterThan(tenantCommandIndex);
    expect(response.plannedCommands[tenantCommandIndex]).toContain("SCHEME_ERROR|No database found");
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

  it("plans removing the highest-index extra dynamic nodes by default", async () => {
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
          stdout: '{"Names":"ydb-dyn-example-2"}\n{"Names":"ydb-dyn-example-3"}\n',
          stderr: "",
          ok: true,
          timedOut: false
        };
      }
      if (command.includes("docker inspect ydb-dyn-example-3")) {
        return {
          command,
          exitCode: 0,
          stdout: '[{"Name":"/ydb-dyn-example-3","Args":["-lc","exec /ydbd --ic-port 19004"]}]',
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
    expect(response.nodes.map((node) => node.container)).toEqual(["ydb-dyn-example-3"]);
    expect(response.plannedCommands[0]).toContain("docker rm -f ydb-dyn-example-3");
  });

  it("plans removing an extra dynamic node by YDB node ID", async () => {
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

    await expect(removeDynamicNodes(ctx, { nodeIds: [50000] })).rejects.toThrow("port 19002 is not a removable extra dynamic node");
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
    const response = await reduceStorageGroups(ctx, { dumpName: "shrink-smoke" });
    expect(response.executed).toBe(false);
    expect(response.pool.name).toBe("/local/example:hdd");
    expect(response.pool.numGroups).toBe(2);
    expect(response.pool.targetNumGroups).toBe(1);
    expect(response.dumpName).toBe("shrink-smoke");
    expect(response.authReapplyPlanned).toBe(true);
    expect(response.extraDynamicNodes).toEqual(["ydb-dyn-example-2"]);
    expect(response.plannedCommands.join("\n")).toContain("/dump/shrink-smoke/tenant");
    expect(response.plannedCommands.join("\n")).toContain("admin database /local/example create hdd:1");
    expect(response.plannedCommands.join("\n")).toContain("/tmp/local-ydb-auth/config.auth.yaml");
    expect(response.plannedCommands.join("\n")).toContain("--name ydb-dyn-example-2");
  });

  it("executes storage-group reduction rebuild and reapplies auth before re-adding extra dynamic nodes", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb-auth/config.auth.yaml",
          dynamicContainer: "ydb-dyn-example",
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
        return {
          command,
          exitCode: 0,
          stdout: "ydb-local-data\n",
          stderr: "",
          ok: true,
          timedOut: false
        };
      }

      if (command.includes("docker inspect")) {
        return {
          command,
          exitCode: 0,
          stdout: "[]",
          stderr: "",
          ok: true,
          timedOut: false
        };
      }

      if (command.includes("viewer/json/nodelist")) {
        return {
          command,
          exitCode: 0,
          stdout: '[{"Port":19003}]',
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

    const response = await reduceStorageGroups(ctx, { confirm: true, dumpName: "shrink-smoke" });
    expect(response.executed).toBe(true);
    expect(response.dumpName).toBe("shrink-smoke");
    expect(response.authReapplyPlanned).toBe(true);
    expect(response.observedNumGroups).toBe(1);

    const commands = response.results?.map((result) => result.command) ?? [];
    expect(commands.some((command) => command.includes("/dump/shrink-smoke/tenant"))).toBe(true);
    expect(commands.some((command) => command.includes("admin database /local/example create hdd:1"))).toBe(true);
    expect(commands.filter((command) => command.includes("docker restart ydb-local")).length).toBe(2);
    expect(commands.some((command) => command.includes("cp /tmp/local-ydb-toolkit-config.yaml \"$target\""))).toBe(true);
    expect(commands.some((command) => command.includes("StaffApiUserToken: \"root@builtin\""))).toBe(true);
    expect(commands.some((command) => command.includes("--name ydb-dyn-example-2"))).toBe(true);

    const firstRestartIndex = commands.findIndex((command) => command.includes("docker restart ydb-local"));
    const recopyIndex = commands.findIndex((command) => command.includes("cp /tmp/local-ydb-toolkit-config.yaml \"$target\""));
    const secondRestartIndex = commands.findIndex((command, index) => index > firstRestartIndex && command.includes("docker restart ydb-local"));
    const readdExtraNodeIndex = commands.findIndex((command) => command.includes("--name ydb-dyn-example-2"));
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
    let commandIndex = 0;
    executor.run = async (_profile, spec) => {
      const command = executor.display(_profile, spec);
      executor.commands.push(command);
      commandIndex += 1;
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
      if (commandIndex === 4 && command.includes("admin database /local/example remove --force")) {
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
