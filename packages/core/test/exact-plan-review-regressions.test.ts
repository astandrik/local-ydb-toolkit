import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyAuthHardening,
  commandToShell,
  createContext,
  prepareAuthConfig,
  ProcessConfirmationStore,
  removeDynamicNodes,
  restoreTenant,
  setRootPassword,
  ShellCommandExecutor,
  upgradeVersion,
  writeDynamicNodeAuthConfig,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  type ResolvedLocalYdbProfile,
  type ToolkitContext,
} from "../src/index.js";
import { ConfigSchema } from "../src/validation.js";

describe("exact-plan review regressions", () => {
  it("serializes distinct composite upgrade confirmations for one profile", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-g32-composite-"));
    const dumpHostPath = join(directory, "dumps");
    const configPath = join(directory, "local-ydb.config.json");
    mkdirSync(dumpHostPath, { recursive: true });
    const rawConfig = {
      profiles: {
        default: {
          image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6",
          dumpHostPath,
        },
      },
    };
    writeFileSync(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, "utf8");
    const executor = new CompositeUpgradeExecutor();
    const base = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
    const ctx = confirmationContext(base, "local_ydb_upgrade_version");

    try {
      const firstRequest = { version: "26.1.2.0", dumpName: "g32-first" };
      const secondRequest = { version: "26.1.2.0", dumpName: "g32-second" };
      const [firstPlan, secondPlan] = await Promise.all([
        upgradeVersion(ctx, firstRequest),
        upgradeVersion(ctx, secondRequest),
      ]);

      const responses = await Promise.all([
        upgradeVersion(ctx, {
          ...firstRequest,
          confirm: true,
          confirmationToken: firstPlan.confirmation?.token,
        }),
        upgradeVersion(ctx, {
          ...secondRequest,
          confirm: true,
          confirmationToken: secondPlan.confirmation?.token,
        }),
      ]);

      expect.soft(responses.map((response) => response.confirmation?.status).sort()).toEqual([
        "accepted",
        "rejected",
      ]);
      expect.soft(executor.dumpCalls).toBe(1);
      expect.soft(executor.maxConcurrentDumps).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retires a submitted token when auth hardening temporarily becomes plan-only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-g32-plan-only-"));
    const authConfigPath = join(directory, "config.auth.yaml");
    writeFileSync(authConfigPath, "domains_config: {}\n", { mode: 0o600 });
    const executor = new AuthPlanOnlyExecutor();
    const store = new ProcessConfirmationStore();
    const originalConfig = ConfigSchema.parse({
      profiles: { default: { authConfigPath } },
    });
    const original = confirmationContext(
      createContext(undefined, executor, originalConfig),
      "local_ydb_apply_auth_hardening",
      store,
    );
    const missingConfig = ConfigSchema.parse({});
    const temporarilyMissing = confirmationContext(
      createContext(undefined, executor, missingConfig),
      "local_ydb_apply_auth_hardening",
      store,
    );

    try {
      const planned = await applyAuthHardening(original, {});
      const planOnly = await applyAuthHardening(temporarilyMissing, {
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });
      const replay = await applyAuthHardening(original, {
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });

      expect.soft(planOnly.confirmation?.status).toBe("not-required");
      expect.soft(replay.confirmation?.status).toBe("rejected");
      expect.soft(executor.authMutationCalls).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retires submitted tokens across every mutating plan-only caller", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-g32-plan-only-callers-"));
    const authConfigPath = join(directory, "config.auth.yaml");
    const rootPasswordFile = join(directory, "root.password");
    const dynamicNodeAuthTokenFile = join(directory, "dynamic-token.txt");
    const dumpHostPath = join(directory, "dumps");
    const dumpName = "reviewed-dump";
    mkdirSync(join(dumpHostPath, dumpName, "tenant"), { recursive: true });
    writeFileSync(join(dumpHostPath, dumpName, "tenant", "data.txt"), "reviewed dump\n");
    writeFileSync(authConfigPath, "domains_config: {}\n", { mode: 0o600 });
    writeFileSync(rootPasswordFile, "old-password\n", { mode: 0o600 });

    try {
      const cases = [
        {
          toolName: "local_ydb_prepare_auth_config",
          config: { profiles: { default: { authConfigPath } } },
          plan: (ctx: ToolkitContext) => prepareAuthConfig(ctx, {}),
          noOp: (ctx: ToolkitContext, token: string | undefined) => prepareAuthConfig(ctx, {
            confirm: true,
            confirmationToken: token,
          }),
          replay: (ctx: ToolkitContext, token: string | undefined) => prepareAuthConfig(ctx, {
            confirm: true,
            confirmationToken: token,
          }),
          transientConfig: {},
        },
        {
          toolName: "local_ydb_write_dynamic_auth_config",
          config: { profiles: { default: { dynamicNodeAuthSid: "root@builtin", dynamicNodeAuthTokenFile } } },
          plan: (ctx: ToolkitContext) => writeDynamicNodeAuthConfig(ctx, {}),
          noOp: (ctx: ToolkitContext, token: string | undefined) => writeDynamicNodeAuthConfig(ctx, {
            confirm: true,
            confirmationToken: token,
          }),
          replay: (ctx: ToolkitContext, token: string | undefined) => writeDynamicNodeAuthConfig(ctx, {
            confirm: true,
            confirmationToken: token,
          }),
          transientConfig: {},
        },
        {
          toolName: "local_ydb_set_root_password",
          config: { profiles: { default: { authConfigPath, rootPasswordFile } } },
          plan: (ctx: ToolkitContext) => setRootPassword(ctx, { password: "new-password" }),
          noOp: (ctx: ToolkitContext, token: string | undefined) => setRootPassword(ctx, {
            confirm: true,
            confirmationToken: token,
          }),
          replay: (ctx: ToolkitContext, token: string | undefined) => setRootPassword(ctx, {
            password: "new-password",
            confirm: true,
            confirmationToken: token,
          }),
          transientConfig: { profiles: { default: { authConfigPath, rootPasswordFile } } },
        },
        {
          toolName: "local_ydb_restore_tenant",
          config: { profiles: { default: { dumpHostPath } } },
          plan: (ctx: ToolkitContext) => restoreTenant(ctx, { dumpName }),
          noOp: (ctx: ToolkitContext, token: string | undefined) => restoreTenant(ctx, {
            confirm: true,
            confirmationToken: token,
          }),
          replay: (ctx: ToolkitContext, token: string | undefined) => restoreTenant(ctx, {
            dumpName,
            confirm: true,
            confirmationToken: token,
          }),
          transientConfig: { profiles: { default: { dumpHostPath } } },
        },
      ];

      for (const testCase of cases) {
        const executor = new CountingPlanOnlyExecutor();
        const store = new ProcessConfirmationStore();
        const original = confirmationContext(
          createContext(undefined, executor, ConfigSchema.parse(testCase.config)),
          testCase.toolName,
          store,
        );
        const transient = confirmationContext(
          createContext(undefined, executor, ConfigSchema.parse(testCase.transientConfig)),
          testCase.toolName,
          store,
        );
        const planned = await testCase.plan(original);
        const noOp = await testCase.noOp(transient, planned.confirmation?.token);
        const replay = await testCase.replay(original, planned.confirmation?.token);

        expect(noOp.confirmation?.status, testCase.toolName).toBe("not-required");
        expect(replay.confirmation?.status, testCase.toolName).toBe("rejected");
        expect(executor.calls, testCase.toolName).toBe(0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves the exact authorized removal commands in confirmed responses", async () => {
    const executor = new RemovalResponseExecutor();
    const base = createContext(undefined, executor, ConfigSchema.parse({}));
    const ctx = confirmationContext(base, "local_ydb_remove_dynamic_nodes");

    const planned = await removeDynamicNodes(ctx, {});
    const confirmed = await removeDynamicNodes(ctx, {
      confirm: true,
      confirmationToken: planned.confirmation?.token,
    });

    expect.soft(confirmed.confirmation?.status).toBe("accepted");
    expect.soft(confirmed.plannedCommands).toEqual(planned.plannedCommands);
    expect.soft(confirmed.plannedCommands.join("\n")).toContain("expected_id=reviewed-extra-id");
    expect.soft(confirmed.plannedCommands.join("\n")).toContain('docker rm -f "$expected_id"');
  });
});

class CompositeUpgradeExecutor implements CommandExecutor {
  dumpCalls = 0;
  maxConcurrentDumps = 0;
  #activeDumps = 0;
  #releaseDumps: (() => void) | undefined;
  #dumpsReady = new Promise<void>((resolve) => {
    this.#releaseDumps = resolve;
  });

  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    const command = this.display(profile, spec);
    if (
      spec.command === "docker"
      && spec.args?.slice(0, 4).join(" ") === "image inspect --format {{.Id}}"
    ) {
      return result(command, { stdout: "sha256:g32-reviewed-target\n" });
    }
    if (spec.command === "docker" && spec.args?.[0] === "ps") {
      return result(command, {
        stdout: [
          '{"Names":"ydb-local","Image":"ghcr.io/ydb-platform/local-ydb:26.1.1.6"}',
          '{"Names":"ydb-dyn-example","Image":"ghcr.io/ydb-platform/local-ydb:26.1.1.6"}',
        ].join("\n"),
      });
    }
    if (command.includes("docker volume ls")) {
      return result(command, { stdout: "ydb-local-data\n" });
    }
    if (command.includes(" tools dump ")) {
      this.dumpCalls += 1;
      this.#activeDumps += 1;
      this.maxConcurrentDumps = Math.max(this.maxConcurrentDumps, this.#activeDumps);
      if (this.dumpCalls === 2) {
        this.#releaseDumps?.();
      }
      await Promise.race([
        this.#dumpsReady,
        new Promise<void>((resolve) => setTimeout(resolve, 200)),
      ]);
      this.#activeDumps -= 1;
      return result(command, {
        exitCode: 1,
        stderr: "BENIGN_G32_DUMP_STOP",
        ok: false,
      });
    }
    return result(command);
  }
}

class AuthPlanOnlyExecutor implements CommandExecutor {
  authMutationCalls = 0;
  readonly #shell = new ShellCommandExecutor();

  display(profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return this.#shell.display(profile, spec);
  }

  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    if (
      spec.description === "Prepare confirmed content snapshots"
      || spec.description === "Remove confirmed content snapshots"
    ) {
      return this.#shell.run(profile, spec);
    }
    const command = this.display(profile, spec);
    this.authMutationCalls += 1;
    return result(command, {
      exitCode: 1,
      stderr: "BENIGN_G32_AUTH_STOP",
      ok: false,
    });
  }
}

class CountingPlanOnlyExecutor implements CommandExecutor {
  calls = 0;
  readonly #shell = new ShellCommandExecutor();

  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    if (spec.description?.startsWith("Fingerprint ")) {
      return this.#shell.run(profile, spec);
    }
    this.calls += 1;
    return result(this.display(profile, spec));
  }
}

class RemovalResponseExecutor implements CommandExecutor {
  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    const command = this.display(profile, spec);
    if (spec.command === "docker" && spec.args?.[0] === "ps") {
      return result(command, {
        stdout: '{"Names":"ydb-dyn-example-2","State":"running","ID":"reviewed-extra-id"}',
      });
    }
    if (command.includes("docker volume ls")) {
      return result(command, { stdout: "ydb-local-data\n" });
    }
    if (spec.command === "docker" && spec.args?.[0] === "inspect") {
      return result(command, {
        stdout: JSON.stringify([{
          Id: "reviewed-extra-id",
          Name: "/ydb-dyn-example-2",
          Args: ["--ic-port", "19003"],
        }]),
      });
    }
    if (spec.description === "Remove exact dynamic tenant node ydb-dyn-example-2") {
      return result(command, {
        exitCode: 1,
        stderr: "BENIGN_G32_REMOVE_STOP",
        ok: false,
      });
    }
    return result(command);
  }
}

function confirmationContext(
  context: ToolkitContext,
  toolName: string,
  store = new ProcessConfirmationStore(),
): ToolkitContext {
  return {
    ...context,
    confirmation: {
      store,
      toolName,
      configSource: { kind: "provided", config: context.config },
    },
  };
}

function result(command: string, overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command,
    exitCode: 0,
    stdout: "",
    stderr: "",
    ok: true,
    timedOut: false,
    ...overrides,
  };
}
