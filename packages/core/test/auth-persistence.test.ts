import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bash, ConfigSchema, createContext, ProcessConfirmationStore, setRootPassword, ShellCommandExecutor, shellQuote,
  type CommandExecutor, type CommandResult, type CommandSpec, type ResolvedLocalYdbProfile } from "../src/index.js";

const originalConfig = JSON.stringify({ domains_config: { security_config: {
  default_users: [{ name: "root", password: "BENIGN_REVIEWED_PASSWORD" }],
} } });
const oldPassword = "BENIGN_REVIEWED_PASSWORD\n";
const newPassword = "BENIGN_REQUESTED_PASSWORD";
const concurrentBytes = "BENIGN_CONCURRENT_EDIT\n";
const backupBytes = "BENIGN_EXISTING_BACKUP\n";
const failureMessage = "Auth artifact destinations changed or could not be verified; no host files were updated.";

class PersistenceExecutor implements CommandExecutor {
  readonly shell = new ShellCommandExecutor();
  rotations = 0;
  beforeSync: (() => void) | undefined;
  rubyPrelude = "";
  constructor(readonly containerConfig: string) {}
  display(profile: ResolvedLocalYdbProfile, spec: CommandSpec) { return this.shell.display(profile, spec); }
  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    if (spec.description?.startsWith("Fingerprint ") || ["Prepare confirmed content snapshots", "Remove confirmed content snapshots"].includes(spec.description ?? "")) {
      return this.shell.run(profile, spec);
    }
    if (spec.description?.startsWith("Alter runtime root password")) {
      this.rotations++;
      expect(spec.stdin).toBe(newPassword);
      this.beforeSync?.();
    }
    if (spec.description === "Sync host auth config and root password file with the new root password") {
      if (spec.command !== "bash" || spec.args?.length !== 2 || spec.args[0] !== "-lc") {
        throw new Error("Persistence fixture requires a bash -lc script.");
      }
      const stub = [this.rubyPrelude, "docker() {",
        '  if [ "$1" != exec ]; then return 99; fi',
        `  if [ "$3" = cat ]; then /bin/cat ${shellQuote(this.containerConfig)}`,
        "  else printf '%s\\n' /fixture/generated.yaml; fi", "}",
      ].join("\n");
      const envDir = mkdtempSync(join(dirname(this.containerConfig), "executor-"));
      try {
        const envPath = join(envDir, "bash-env");
        writeFileSync(envPath, stub, { mode: 0o600 });
        const response = await this.shell.run(profile, {
          ...spec, command: "env", args: [`BASH_ENV=${envPath}`, spec.command, ...spec.args],
        });
        return { ...response, command: this.display(profile, spec) };
      } finally { rmSync(envDir, { recursive: true, force: true }); }
    }
    return { command: this.display(profile, spec), stdout: "", stderr: "", ok: true, exitCode: 0, timedOut: false };
  }
}

describe("persistence fixture command boundary", () => {
  const description = "Sync host auth config and root password file with the new root password";
  it.each([
    { name: "non-script bash", command: "bash", flag: "--version", extra: [] },
    { name: "different executable", command: "echo", flag: "-lc", extra: [] },
    { name: "extra argument", command: "bash", flag: "-lc", extra: ["extra"] },
  ])("rejects $name without reinterpreting arguments", async ({ command, flag, extra }) => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-persistence-boundary-"));
    const marker = join(dir, "must-not-execute");
    const script = "touch " + shellQuote(marker);
    const spec = { command, args: [flag, script, ...extra], description };
    try {
      const executor = new PersistenceExecutor(join(dir, "unused-config"));
      await expect(executor.run(createContext(undefined, undefined, ConfigSchema.parse({})).profile, spec))
        .rejects.toThrow("Persistence fixture requires a bash -lc script.");
      expect(existsSync(marker)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(["success", "failure", "abort"])("preserves script semantics and cleans up on %s", async outcome => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-persistence-boundary-"));
    const profile = createContext(undefined, undefined, ConfigSchema.parse({})).profile;
    const controller = new AbortController();
    const spec = bash(outcome === "failure" ? "exit 27" : "read -r value; printf '%s' \"$value\"", {
      description, stdin: "BENIGN_STDIN\n", signal: controller.signal,
    });
    if (outcome === "abort") controller.abort();
    try {
      const executor = new PersistenceExecutor(join(dir, "unused-config"));
      if (outcome === "abort") await expect(executor.run(profile, spec)).rejects.toThrow();
      else {
        const response = await executor.run(profile, spec);
        expect(response.exitCode).toBe(outcome === "failure" ? 27 : 0);
        expect(response.stdout).toBe(outcome === "failure" ? "" : "BENIGN_STDIN");
        expect(response.command).toBe(executor.display(profile, spec));
      }
      expect(readdirSync(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("password rotation host persistence", () => {
  const variations = ["config", "password", "missing", "directory", "oversized", "unreadable", "unchanged", "symlink"] as const;
  it.each(variations)("handles %s destinations without losing concurrent edits", async variation => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-persistence-"));
    const configPath = join(dir, "auth.yaml");
    const passwordPath = join(dir, "root.password");
    const containerConfig = join(dir, "container.yaml");
    const backupConfig = configPath + ".before-local-ydb-toolkit-password-rotate";
    const backupPassword = passwordPath + ".before-local-ydb-toolkit-password-rotate";
    const realConfig = join(dir, "config-target.yaml");
    for (const [path, bytes] of [[configPath, originalConfig], [passwordPath, oldPassword],
      [containerConfig, originalConfig], [backupConfig, backupBytes], [backupPassword, backupBytes]]) {
      writeFileSync(path!, bytes!, { mode: 0o600 });
    }
    if (variation === "symlink") {
      writeFileSync(realConfig, originalConfig, { mode: 0o600 });
      rmSync(configPath);
      symlinkSync(realConfig, configPath);
    }
    const executor = new PersistenceExecutor(containerConfig);
    const config = ConfigSchema.parse({ profiles: { default: { authConfigPath: configPath, rootPasswordFile: passwordPath } } });
    const ctx = { ...createContext(undefined, executor, config), confirmation: {
      store: new ProcessConfirmationStore(), toolName: "local_ydb_set_root_password", configSource: { kind: "provided" as const, config },
    } };
    try {
      const plan = await setRootPassword(ctx, { password: newPassword });
      executor.beforeSync = () => {
        if (variation === "config") writeFileSync(configPath, concurrentBytes);
        if (variation === "password") writeFileSync(passwordPath, concurrentBytes);
        if (variation === "missing" || variation === "directory") rmSync(configPath);
        if (variation === "directory") mkdirSync(configPath);
        if (variation === "oversized") writeFileSync(configPath, Buffer.alloc(16 * 1024 * 1024 + 1));
        if (variation === "unreadable") {
          const patch = join(dir, "deny-read.rb");
          writeFileSync(patch, `class << File; alias g46_open open; def open(path, *args, &block); raise Errno::EACCES if path == ${JSON.stringify(configPath)}; g46_open(path, *args, &block); end; end`);
          executor.rubyPrelude = `ruby() { command ruby -r ${shellQuote(patch)} "$@"; }`;
        }
      };
      const response = await setRootPassword(ctx, { password: newPassword, confirm: true, confirmationToken: plan.confirmation?.token });
      expect(response.confirmation?.status).toBe("accepted");
      expect(executor.rotations).toBe(1);
      if (variation === "unchanged" || variation === "symlink") {
        expect(response.results?.every(result => result.ok)).toBe(true);
        expect(readFileSync(passwordPath, "utf8")).toBe(newPassword + "\n");
        expect(readFileSync(backupConfig, "utf8")).toBe(originalConfig);
        expect(readFileSync(backupPassword, "utf8")).toBe(oldPassword);
        if (variation === "symlink") expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
      } else {
        expect(response.results).toHaveLength(2);
        expect(response.results?.[1]?.ok).toBe(false);
        expect(response.results?.[1]?.stderr.trim()).toBe(failureMessage);
        expect(response.summary).toContain("reconcile the host files");
        expect(readFileSync(backupConfig, "utf8")).toBe(backupBytes);
        expect(readFileSync(backupPassword, "utf8")).toBe(backupBytes);
        if (variation === "config") expect(readFileSync(configPath, "utf8")).toBe(concurrentBytes);
        if (variation === "password") expect(readFileSync(passwordPath, "utf8")).toBe(concurrentBytes);
        for (const secret of [newPassword, concurrentBytes.trim(), backupBytes.trim()]) {
          expect(JSON.stringify(response)).not.toContain(secret);
        }
      }
      const replay = setRootPassword(ctx, { password: newPassword, confirm: true, confirmationToken: plan.confirmation?.token });
      if (variation === "oversized") {
        await expect(replay).rejects.toThrow("Unable to fingerprint a confirmation content input");
      } else {
        expect((await replay).confirmation?.status).toBe("rejected");
      }
      expect(executor.rotations).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);
    }
  });
  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt("rejects a FIFO destination promptly before any backup or write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-persistence-fifo-"));
    const configPath = join(dir, "auth.yaml");
    const passwordPath = join(dir, "root.password");
    const containerConfig = join(dir, "container.yaml");
    writeFileSync(configPath, originalConfig); writeFileSync(passwordPath, oldPassword); writeFileSync(containerConfig, originalConfig);
    const executor = new PersistenceExecutor(containerConfig);
    const config = ConfigSchema.parse({ profiles: { default: { authConfigPath: configPath, rootPasswordFile: passwordPath } } });
    const ctx = { ...createContext(undefined, executor, config), confirmation: { store: new ProcessConfirmationStore(),
      toolName: "local_ydb_set_root_password", configSource: { kind: "provided" as const, config } } };
    try {
      const plan = await setRootPassword(ctx, { password: newPassword });
      executor.beforeSync = () => { rmSync(configPath); expect(spawnSync("mkfifo", [configPath]).status).toBe(0); };
      const response = await setRootPassword(ctx, { password: newPassword, confirm: true, confirmationToken: plan.confirmation?.token });
      expect(response.results?.[1]?.ok).toBe(false);
      expect(response.results?.[1]?.stderr.trim()).toBe(failureMessage);
      expect(existsSync(configPath + ".before-local-ydb-toolkit-password-rotate")).toBe(false);
      expect(lstatSync(configPath).isFIFO()).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 2000);
});
