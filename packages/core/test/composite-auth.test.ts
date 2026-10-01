import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigSchema, createContext, ProcessConfirmationStore, ShellCommandExecutor,
  type CommandSpec, type ResolvedLocalYdbProfile,
} from "../src/index.js";
import { createCompositeAuthArtifacts } from "../src/operations/composite-auth.js";

const failure = "Composite auth artifact destinations must be distinct and accessible.";
const original = "BENIGN_ORIGINAL_AUTH\n";

function setup(paths: string[], executor = new ShellCommandExecutor()) {
  const ctx = createContext(undefined, executor, ConfigSchema.parse({
    profiles: { default: {
      authConfigPath: paths[0], dynamicNodeAuthTokenFile: paths[1], rootPasswordFile: paths[2],
    } },
  }));
  return createCompositeAuthArtifacts(ctx, ctx, { kind: "test-auth-destinations" });
}

function prepare(artifacts: ReturnType<typeof createCompositeAuthArtifacts>) {
  const profile = artifacts.context.profile;
  mkdirSync(dirname(profile.authConfigPath!), { recursive: true, mode: 0o700 });
  writeFileSync(profile.authConfigPath!, "BENIGN_CONFIG\n", { mode: 0o600 });
  writeFileSync(profile.dynamicNodeAuthTokenFile!, "BENIGN_DYNAMIC\n", { mode: 0o600 });
  writeFileSync(profile.rootPasswordFile!, "BENIGN_ROOT\n", { mode: 0o600 });
}

describe("composite auth destination identity", () => {
  it.each(["symlink", "hardlink", "dangling", "parent-alias"])("rejects %s aliases without writing", async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-auth-identity-"));
    const shared = join(directory, "shared");
    let paths = [shared, join(directory, "alias"), join(directory, "root")];
    if (kind === "dangling") {
      paths = [join(directory, "first"), join(directory, "second"), paths[2]!];
      symlinkSync(shared, paths[0]!);
      symlinkSync(shared, paths[1]!);
    } else if (kind === "parent-alias") {
      mkdirSync(join(directory, "real"));
      symlinkSync(join(directory, "real"), join(directory, "alias-parent"));
      paths = [join(directory, "real", "missing", "file"), join(directory, "alias-parent", "missing", "file"), paths[2]!];
    } else {
      writeFileSync(shared, original, { mode: 0o600 });
      (kind === "symlink" ? symlinkSync : linkSync)(shared, paths[1]!);
    }
    const artifacts = setup(paths);
    try {
      await expect(artifacts.validateDestinations()).rejects.toThrow(failure);
      prepare(artifacts);
      const persisted = await artifacts.persist({ confirm: true });
      expect(persisted.results?.[0]).toMatchObject({ ok: false, stderr: `${failure}\n` });
      expect(JSON.stringify(persisted)).not.toContain(directory);
      expect(JSON.stringify(persisted)).not.toContain("BENIGN_CONFIG");
      expect(existsSync(paths[2]!)).toBe(false);
      if (kind === "symlink" || kind === "hardlink") expect(readFileSync(shared, "utf8")).toBe(original);
      else expect(existsSync(shared)).toBe(false);
    } finally {
      expect(await artifacts.remove()).toBe(true);
      expect(existsSync(dirname(artifacts.context.profile.authConfigPath!))).toBe(false);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["regular", "symlink", "missing"])("persists distinct %s destinations and preserves links", async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-auth-distinct-"));
    const paths = ["config", "dynamic", "root"].map((name) => join(directory, "nested", name));
    if (kind !== "missing") {
      mkdirSync(dirname(paths[0]!));
      for (const path of paths) {
        if (kind === "symlink") {
          writeFileSync(`${path}.target`, original);
          symlinkSync(`${path}.target`, path);
        } else writeFileSync(path, original);
      }
    }
    const artifacts = setup(paths);
    try {
      await artifacts.validateDestinations();
      expect(existsSync(dirname(artifacts.context.profile.authConfigPath!))).toBe(false);
      prepare(artifacts);
      const response = await artifacts.persist({ confirm: true });
      expect(response.results?.every((result) => result.ok)).toBe(true);
      for (const [index, value] of ["BENIGN_CONFIG\n", "BENIGN_DYNAMIC\n", "BENIGN_ROOT\n"].entries()) {
        expect(readFileSync(paths[index]!, "utf8")).toBe(value);
        if (kind === "symlink") expect(readFileSync(`${paths[index]}.target`, "utf8")).toBe(value);
        expect(JSON.stringify(response)).not.toContain(value.trim());
      }
      expect(JSON.stringify(response)).not.toContain(directory);
    } finally {
      expect(await artifacts.remove()).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rechecks destinations at persistence after a link is introduced", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-auth-late-alias-"));
    const paths = ["config", "dynamic", "root"].map((name) => join(directory, name));
    for (const path of paths) writeFileSync(path, original);
    const artifacts = setup(paths);
    artifacts.context.confirmation = {
      store: new ProcessConfirmationStore(),
      toolName: "test-composite-persist",
      configSource: { kind: "provided", config: artifacts.context.config },
    };
    try {
      await artifacts.validateDestinations();
      prepare(artifacts);
      const plan = await artifacts.persist({});
      rmSync(paths[1]!);
      symlinkSync(paths[0]!, paths[1]!);
      const response = await artifacts.persist({ confirm: true, confirmationToken: plan.confirmation?.token });
      expect(response.confirmation?.status).toBe("accepted");
      expect(response.results?.[0]?.ok).toBe(false);
      expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual([original, original, original]);
      expect(await artifacts.persist({ confirm: true, confirmationToken: plan.confirmation?.token }))
        .toMatchObject({ executed: false, confirmation: { status: "rejected" } });
    } finally {
      expect(await artifacts.remove()).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("dispatches identity validation through the SSH target executor and hides failures", async () => {
    class TargetExecutor extends ShellCommandExecutor {
      seen: ResolvedLocalYdbProfile[] = [];
      override async run(profile: ResolvedLocalYdbProfile, _spec: CommandSpec): Promise<never> {
        this.seen.push(profile);
        throw new Error("BENIGN_PRIVATE_TRANSPORT_DETAIL");
      }
    }
    const executor = new TargetExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({ profiles: { default: {
      mode: "ssh", ssh: { host: "test.invalid" },
      authConfigPath: "/target/config", dynamicNodeAuthTokenFile: "/target/token", rootPasswordFile: "/target/password",
    } } }));
    const artifacts = createCompositeAuthArtifacts(ctx, ctx, { kind: "ssh-target" });
    await expect(artifacts.validateDestinations()).rejects.toThrow(new Error(failure));
    expect(executor.seen).toEqual([ctx.profile]);
  });
});
