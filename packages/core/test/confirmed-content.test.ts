import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyAuthHardening,
  commandToShell,
  createContext,
  ProcessConfirmationStore,
  restoreTenant,
  setRootPassword,
  ShellCommandExecutor,
  startDynamicNode,
  type CommandExecutor,
  type CommandOutputObserver,
  type CommandResult,
  type CommandSpec,
  type ResolvedLocalYdbProfile,
  type ToolkitContext,
} from "../src/index.js";
import { ConfigSchema } from "../src/validation.js";

const REVIEWED_AUTH = "BENIGN_REVIEWED_AUTH_CONFIG\n";
const REPLACEMENT_AUTH = "BENIGN_REPLACEMENT_AUTH_CONFIG\n";
const REVIEWED_TOKEN = "BENIGN_REVIEWED_DYNAMIC_TOKEN\n";
const REPLACEMENT_TOKEN = "BENIGN_REPLACEMENT_DYNAMIC_TOKEN\n";
const REVIEWED_DUMP = "BENIGN_REVIEWED_DUMP\n";
const REPLACEMENT_DUMP = "BENIGN_REPLACEMENT_DUMP\n";
const REVIEWED_PASSWORD = "BENIGN_REVIEWED_PASSWORD\n";
const REPLACEMENT_PASSWORD = "BENIGN_REPLACEMENT_PASSWORD\n";

class ContentBoundaryExecutor implements CommandExecutor {
  readonly commands: string[] = [];
  readonly preparationCommands: string[] = [];
  readonly cleanupCommands: string[] = [];
  readonly executionCommands: string[] = [];
  capturedContent: string | undefined;
  capturedConfigBackupContent: string | undefined;
  capturedPasswordBackupContent: string | undefined;
  snapshotPath: string | undefined;
  failPreparation = false;
  failCleanup = false;
  abortExecution = false;
  afterPreparation: (() => void) | undefined;
  beforeFirstExecution: (() => void) | undefined;
  backupSources: { config: string; password: string } | undefined;
  private executionStarted = false;
  private readonly shell = new ShellCommandExecutor();

  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

  async run(
    profile: ResolvedLocalYdbProfile,
    spec: CommandSpec,
    _outputObserver?: CommandOutputObserver,
  ): Promise<CommandResult> {
    const command = this.display(profile, spec);
    this.commands.push(command);
    if (spec.description?.startsWith("Fingerprint ")) {
      return this.shell.run(profile, spec);
    }
    if (spec.description === "Prepare confirmed content snapshots") {
      this.preparationCommands.push(command);
      if (this.failPreparation) {
        return result(command, false, "private snapshot failure details");
      }
      const prepared = await this.shell.run(profile, spec);
      if (prepared.ok) {
        this.afterPreparation?.();
      }
      return prepared;
    }
    if (spec.description === "Remove confirmed content snapshots") {
      this.cleanupCommands.push(command);
      if (this.failCleanup) {
        return result(command, false, "private cleanup failure details");
      }
      return this.shell.run(profile, spec);
    }

    if (!this.executionStarted) {
      this.executionStarted = true;
      this.beforeFirstExecution?.();
    }
    this.executionCommands.push(command);
    const snapshotPath = extractSnapshotPath(command);
    if (snapshotPath && existsSync(snapshotPath)) {
      this.snapshotPath = snapshotPath;
      this.capturedContent = readFileSync(
        command.includes("confirmed_restore_snapshot=")
          ? join(snapshotPath, "data.csv")
          : snapshotPath,
        "utf8",
      );
    }
    if (
      spec.description === "Sync host auth config and root password file with the new root password"
      && this.backupSources
    ) {
      const configSource = extractNamedSnapshotPath(command, "config")
        ?? this.backupSources.config;
      const passwordSource = extractNamedSnapshotPath(command, "password")
        ?? this.backupSources.password;
      this.capturedConfigBackupContent = readFileSync(configSource, "utf8");
      this.capturedPasswordBackupContent = readFileSync(passwordSource, "utf8");
      return result(command, true);
    }
    if (this.abortExecution) {
      throw new Error("BENIGN_SYNTHETIC_ABORT");
    }
    return result(command, snapshotPath === undefined, "BENIGN_SYNTHETIC_STOP");
  }
}

describe("confirmed content execution", () => {
  it("executes auth hardening from the immutable bytes accepted by the token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmed-auth-"));
    const configPath = join(directory, "auth.yaml");
    writeFileSync(configPath, REVIEWED_AUTH, { mode: 0o600 });
    const executor = new ContentBoundaryExecutor();
    executor.afterPreparation = () => writeFileSync(configPath, REPLACEMENT_AUTH, "utf8");
    const ctx = confirmationContext(executor, {
      authConfigPath: configPath,
    }, "local_ydb_apply_auth_hardening");

    try {
      const planned = await applyAuthHardening(ctx, { configHostPath: configPath });
      const confirmed = await applyAuthHardening(ctx, {
        configHostPath: configPath,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });

      expect(confirmed.confirmation).toEqual({ status: "accepted" });
      expect(executor.capturedContent).toBe(REVIEWED_AUTH);
      expect(executor.executionCommands.some((command) => command.includes(configPath))).toBe(false);
      expect(executor.snapshotPath && existsSync(executor.snapshotPath)).toBe(false);
      expectPublicResponseToHideContent(
        [planned, confirmed],
        [REVIEWED_AUTH, REPLACEMENT_AUTH],
        executor.snapshotPath,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves an authorized missing input to an absent private snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmed-missing-"));
    const configPath = join(directory, "missing-auth.yaml");
    const executor = new ContentBoundaryExecutor();
    const ctx = confirmationContext(executor, {
      authConfigPath: configPath,
    }, "local_ydb_apply_auth_hardening");

    try {
      const planned = await applyAuthHardening(ctx, { configHostPath: configPath });
      const confirmed = await applyAuthHardening(ctx, {
        configHostPath: configPath,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });
      const consumer = executor.executionCommands.find((command) => (
        command.includes("confirmed_config_snapshot=")
      ));
      const snapshotPath = consumer && extractSnapshotPath(consumer);

      expect(confirmed.confirmation).toEqual({ status: "accepted" });
      expect(snapshotPath).toMatch(/^\/tmp\/local-ydb-toolkit-confirmation-/);
      expect(snapshotPath && existsSync(snapshotPath)).toBe(false);
      expect(consumer).not.toContain(configPath);
      expect(executor.cleanupCommands).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("copies the accepted dynamic-node token into the stopped container from its snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmed-dynamic-"));
    const tokenPath = join(directory, "dynamic.pb");
    const passwordPath = join(directory, "root.password");
    writeFileSync(tokenPath, REVIEWED_TOKEN, { mode: 0o600 });
    writeFileSync(passwordPath, "BENIGN_REVIEWED_PASSWORD\n", { mode: 0o600 });
    const executor = new ContentBoundaryExecutor();
    executor.afterPreparation = () => {
      writeFileSync(tokenPath, REPLACEMENT_TOKEN, "utf8");
      writeFileSync(passwordPath, "BENIGN_REPLACEMENT_PASSWORD\n", "utf8");
    };
    const ctx = confirmationContext(executor, {
      dynamicNodeAuthTokenFile: tokenPath,
      rootPasswordFile: passwordPath,
    }, "local_ydb_start_dynamic_node");

    try {
      const planned = await startDynamicNode(ctx, {});
      const confirmed = await startDynamicNode(ctx, {
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });

      expect(confirmed.confirmation).toEqual({ status: "accepted" });
      expect(executor.capturedContent).toBe(REVIEWED_TOKEN);
      const dynamicCommand = executor.executionCommands.find((command) => (
        command.includes("--auth-token-file")
      ));
      expect(dynamicCommand).toContain("docker create");
      expect(dynamicCommand).toContain("docker cp ");
      expect(dynamicCommand).toContain("docker start ");
      expect(dynamicCommand).not.toContain(`${tokenPath}:/run/`);
      expect(executor.preparationCommands[0]).not.toContain(passwordPath);
      expect(executor.snapshotPath && existsSync(executor.snapshotPath)).toBe(false);
      expectPublicResponseToHideContent(
        [planned, confirmed],
        [REVIEWED_TOKEN, REPLACEMENT_TOKEN],
        executor.snapshotPath,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores from a read-only immutable directory snapshot", async () => {
    const dumpRoot = mkdtempSync(join(tmpdir(), "local-ydb-confirmed-restore-"));
    const dumpDirectory = join(dumpRoot, "reviewed", "tenant");
    const dumpFile = join(dumpDirectory, "data.csv");
    mkdirSync(dumpDirectory, { recursive: true });
    writeFileSync(dumpFile, REVIEWED_DUMP, { mode: 0o600 });
    const executor = new ContentBoundaryExecutor();
    executor.afterPreparation = () => writeFileSync(dumpFile, REPLACEMENT_DUMP, "utf8");
    const ctx = confirmationContext(executor, {
      dumpHostPath: dumpRoot,
    }, "local_ydb_restore_tenant");

    try {
      const planned = await restoreTenant(ctx, { dumpName: "reviewed" });
      const confirmed = await restoreTenant(ctx, {
        dumpName: "reviewed",
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });

      expect(confirmed.confirmation).toEqual({ status: "accepted" });
      expect(executor.capturedContent).toBe(REVIEWED_DUMP);
      expect(executor.executionCommands.at(-1)).toContain(":/dump/confirmed:ro");
      expect(executor.executionCommands.at(-1)).toContain("-i /dump/confirmed");
      expect(executor.snapshotPath && existsSync(executor.snapshotPath)).toBe(false);
      expectPublicResponseToHideContent(
        [planned, confirmed],
        [REVIEWED_DUMP, REPLACEMENT_DUMP],
        executor.snapshotPath,
      );
    } finally {
      rmSync(dumpRoot, { recursive: true, force: true });
    }
  });

  it("fails closed before restore when the reviewed dump contains a symlink", async () => {
    const dumpRoot = mkdtempSync(join(tmpdir(), "local-ydb-confirmed-symlink-"));
    const dumpDirectory = join(dumpRoot, "reviewed", "tenant");
    const outsideFile = join(dumpRoot, "outside.csv");
    mkdirSync(dumpDirectory, { recursive: true });
    writeFileSync(outsideFile, REVIEWED_DUMP, { mode: 0o600 });
    symlinkSync(outsideFile, join(dumpDirectory, "data.csv"));
    const executor = new ContentBoundaryExecutor();
    const ctx = confirmationContext(executor, {
      dumpHostPath: dumpRoot,
    }, "local_ydb_restore_tenant");

    try {
      const planned = await restoreTenant(ctx, { dumpName: "reviewed" });
      const confirmed = await restoreTenant(ctx, {
        dumpName: "reviewed",
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });

      expect(confirmed).toMatchObject({
        confirmation: { status: "accepted" },
        results: [{
          ok: false,
          stderr: "Confirmed content snapshot could not be created or verified.",
        }],
      });
      expect(executor.executionCommands).toEqual([]);
      expect(executor.cleanupCommands).toHaveLength(1);
    } finally {
      rmSync(dumpRoot, { recursive: true, force: true });
    }
  });

  it("backs up only the auth bytes captured after password-rotation confirmation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmed-password-"));
    const configPath = join(directory, "auth.yaml");
    const passwordPath = join(directory, "root.password");
    const newPassword = "BENIGN_NEW_PASSWORD";
    writeFileSync(configPath, REVIEWED_AUTH, { mode: 0o600 });
    writeFileSync(passwordPath, REVIEWED_PASSWORD, { mode: 0o600 });
    const executor = new ContentBoundaryExecutor();
    executor.backupSources = { config: configPath, password: passwordPath };
    executor.beforeFirstExecution = () => {
      writeFileSync(configPath, REPLACEMENT_AUTH, "utf8");
      writeFileSync(passwordPath, REPLACEMENT_PASSWORD, "utf8");
    };
    const ctx = confirmationContext(executor, {
      authConfigPath: configPath,
      rootPasswordFile: passwordPath,
    }, "local_ydb_set_root_password");

    try {
      const planned = await setRootPassword(ctx, { password: newPassword });
      const confirmed = await setRootPassword(ctx, {
        password: newPassword,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });

      expect(confirmed.confirmation).toEqual({ status: "accepted" });
      expect(executor.capturedConfigBackupContent).toBe(REVIEWED_AUTH);
      expect(executor.capturedPasswordBackupContent).toBe(REVIEWED_PASSWORD);
      expect(executor.snapshotPath && existsSync(executor.snapshotPath)).toBe(false);
      expectPublicResponseToHideContent(
        [planned, confirmed],
        [
          REVIEWED_AUTH,
          REPLACEMENT_AUTH,
          REVIEWED_PASSWORD,
          REPLACEMENT_PASSWORD,
          newPassword,
        ],
        executor.snapshotPath,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("consumes the token and reaches no mutation when snapshot preparation fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmed-failure-"));
    const configPath = join(directory, "auth.yaml");
    writeFileSync(configPath, REVIEWED_AUTH, { mode: 0o600 });
    const executor = new ContentBoundaryExecutor();
    executor.failPreparation = true;
    const ctx = confirmationContext(executor, {
      authConfigPath: configPath,
    }, "local_ydb_apply_auth_hardening");

    try {
      const planned = await applyAuthHardening(ctx, { configHostPath: configPath });
      const options = {
        configHostPath: configPath,
        confirm: true as const,
        confirmationToken: planned.confirmation?.token,
      };
      const failed = await applyAuthHardening(ctx, options);
      const replay = await applyAuthHardening(ctx, options);

      expect(failed).toMatchObject({
        executed: true,
        confirmation: { status: "accepted" },
        results: [{
          ok: false,
          stderr: "Confirmed content snapshot could not be created or verified.",
        }],
      });
      expect(replay).toMatchObject({
        executed: false,
        confirmation: { status: "rejected", token: expect.any(String) },
      });
      expect(executor.executionCommands).toEqual([]);
      expect(executor.preparationCommands).toHaveLength(1);
      expect(executor.cleanupCommands).toHaveLength(1);
      expect(JSON.stringify(failed)).not.toContain("private snapshot failure details");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cleans the private snapshot after an aborted accepted execution", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmed-abort-"));
    const configPath = join(directory, "auth.yaml");
    writeFileSync(configPath, REVIEWED_AUTH, { mode: 0o600 });
    const executor = new ContentBoundaryExecutor();
    executor.abortExecution = true;
    const ctx = confirmationContext(executor, {
      authConfigPath: configPath,
    }, "local_ydb_apply_auth_hardening");

    try {
      const planned = await applyAuthHardening(ctx, { configHostPath: configPath });
      const options = {
        configHostPath: configPath,
        confirm: true as const,
        confirmationToken: planned.confirmation?.token,
      };
      await expect(applyAuthHardening(ctx, options)).rejects.toThrow("BENIGN_SYNTHETIC_ABORT");
      expect(executor.cleanupCommands).toHaveLength(1);
      const snapshotRoot = extractSnapshotRoot(executor.preparationCommands[0] ?? "");
      expect(snapshotRoot && existsSync(snapshotRoot)).toBe(false);

      executor.abortExecution = false;
      expect(await applyAuthHardening(ctx, options)).toMatchObject({
        executed: false,
        confirmation: { status: "rejected" },
      });
      expect(executor.preparationCommands).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("surfaces a fixed non-disclosing error when snapshot cleanup fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmed-cleanup-"));
    const configPath = join(directory, "auth.yaml");
    writeFileSync(configPath, REVIEWED_AUTH, { mode: 0o600 });
    const executor = new ContentBoundaryExecutor();
    executor.failCleanup = true;
    const ctx = confirmationContext(executor, {
      authConfigPath: configPath,
    }, "local_ydb_apply_auth_hardening");
    let snapshotRoot: string | undefined;

    try {
      const planned = await applyAuthHardening(ctx, { configHostPath: configPath });
      await expect(applyAuthHardening(ctx, {
        configHostPath: configPath,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      })).rejects.toThrow("Confirmed content snapshot could not be removed.");
      snapshotRoot = extractSnapshotRoot(executor.preparationCommands[0] ?? "");
      expect(executor.cleanupCommands).toHaveLength(1);
      expect(JSON.stringify(executor.cleanupCommands)).not.toContain("private cleanup failure details");
    } finally {
      if (snapshotRoot) {
        rmSync(snapshotRoot, { recursive: true, force: true });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function confirmationContext(
  executor: CommandExecutor,
  profile: Record<string, unknown>,
  toolName: string,
): ToolkitContext {
  const config = ConfigSchema.parse({ profiles: { default: profile } });
  const context = createContext(undefined, executor, config);
  return {
    ...context,
    confirmation: {
      store: new ProcessConfirmationStore(),
      toolName,
      configSource: { kind: "provided", config },
    },
  };
}

function extractSnapshotPath(command: string): string | undefined {
  return /confirmed_(?:config|auth|restore)_snapshot=([A-Za-z0-9_./-]+)/.exec(command)?.[1];
}

function extractNamedSnapshotPath(
  command: string,
  name: "config" | "password",
): string | undefined {
  return new RegExp(`confirmed_${name}_snapshot=([A-Za-z0-9_./-]+)`).exec(command)?.[1];
}

function extractSnapshotRoot(command: string): string | undefined {
  return /snapshot_root=([A-Za-z0-9_./-]+)/.exec(command)?.[1];
}

function expectPublicResponseToHideContent(
  response: unknown,
  contents: string[],
  snapshotPath: string | undefined,
): void {
  const serialized = JSON.stringify(response);
  for (const content of contents) {
    expect(serialized).not.toContain(content.trim());
    expect(serialized).not.toContain(createHash("sha256").update(content).digest("hex"));
  }
  expect(serialized).not.toContain("/tmp/local-ydb-toolkit-confirmation-");
  if (snapshotPath) {
    expect(serialized).not.toContain(snapshotPath);
  }
}

function result(command: string, ok: boolean, stderr = ""): CommandResult {
  return {
    command,
    exitCode: ok ? 0 : 1,
    stdout: "",
    stderr: ok ? "" : stderr,
    ok,
    timedOut: false,
  };
}
