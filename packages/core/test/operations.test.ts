import { describe, expect, it } from "vitest";
import {
  addStorageGroups,
  addDynamicNodes,
  applyAuthHardening,
  bootstrap,
  commandToShell,
  createContext,
  createTenant,
  destroyStack,
  dumpTenant,
  prepareAuthConfig,
  removeDynamicNodes,
  restartStack,
  startDynamicNode,
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

describe("mutating operations", () => {
  it("does not execute bootstrap without confirm=true", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await bootstrap(ctx, {});
    expect(response.executed).toBe(false);
    expect(executor.commands).toEqual([]);
    expect(response.plannedCommands.some((command) => command.includes("docker network"))).toBe(true);
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
    expect(response.plannedCommands[1]).toContain("-o /dump/mcp-smoke/tenant");
  });

  it("waits for tenant readiness instead of trusting create exit code", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await createTenant(ctx, {});
    expect(response.executed).toBe(false);
    expect(response.plannedCommands[0]).toContain("Unknown tenant|NOT_FOUND");
    expect(response.plannedCommands[0]).toContain("sleep 2");
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
    expect(response.plannedCommands[0]).toContain("-e GRPC_TLS_PORT=");
    expect(response.plannedCommands[0]).toContain("-e YDB_GRPC_ENABLE_TLS=0");
    expect(response.plannedCommands[0]).toContain("local-ydb-dynamic-config.yaml");
    expect(response.plannedCommands[0]).toContain("/tmp/local-ydb-auth.pb:/run/local-ydb/dynamic-node-auth.pb:ro");
    expect(response.plannedCommands[0]).toContain("--auth-token-file /run/local-ydb/dynamic-node-auth.pb");
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
    expect(response.plannedCommands.some((command) => command.includes("docker rm -f ydb-dyn-example"))).toBe(true);
    expect(response.plannedCommands.some((command) => command.includes("--auth-token-file /run/local-ydb/dynamic-node-auth.pb"))).toBe(true);
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
    expect(response.plannedCommands[0]).toContain("docker exec ydb-local cat /ydb_data/cluster/kikimr_configs/config.yaml");
    expect(response.plannedCommands[0]).toContain("/tmp/local-ydb/config.auth.yaml");
    expect(response.plannedCommands[0]).toContain("/tmp/local-ydb/root.password");
    expect(response.plannedCommands[0]).toContain("register_dynamic_node_allowed_sids");
    expect(response.plannedCommands[0]).toContain("allowed_sids");
  });
});
