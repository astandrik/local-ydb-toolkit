import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bash, commandToShell, ConfigSchema, createContext, destroyStack, restartStack, upgradeVersion, reduceStorageGroups,
  ProcessConfirmationStore, ShellCommandExecutor, shellQuote,
  type CommandExecutor, type CommandResult, type CommandSpec, type ResolvedLocalYdbProfile } from "../src/index.js";
import { prepareStackTargets, stackTargetsGuardSpec, stackTargetsAbsentSpec } from "../src/operations/stack-targets.js";

function result(command: string, stdout = "", ok = true): CommandResult {
  return { command, stdout, stderr: ok ? "" : "identity changed", ok, exitCode: ok ? 0 : 1, timedOut: false };
}
class IdentityExecutor implements CommandExecutor {
  readonly ids = new Map([["ydb-local", "static-id"], ["ydb-dyn-example", "primary-id"], ["ydb-dyn-example-2", "node-two-id"]]);
  readonly actedOn: string[] = [];
  readonly shell = new ShellCommandExecutor();
  beforeCommand: ((spec: CommandSpec) => void) | undefined;
  duringDump: (() => void) | undefined;
  dumpCalls = 0;
  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec) { return commandToShell(spec); }
  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec) {
    const command = this.display(profile, spec);
    if (spec.description?.startsWith("Fingerprint ") ||
      ["Prepare private verified composite dump snapshot", "Remove private composite dump snapshot"].includes(spec.description ?? "")) {
      return this.shell.run(profile, spec);
    }
    if (spec.command === "docker" && spec.args?.[0] === "ps") {
      return result(command, [...this.ids].map(([Names, ID]) => JSON.stringify({ Names, ID, State: "running", Image: profile.image })).join("\n"));
    }
    if (spec.command === "docker" && spec.args?.[0] === "inspect") {
      return result(command, JSON.stringify(spec.args.slice(1).flatMap(name =>
        this.ids.has(name) ? [{ Name: "/" + name, Id: this.ids.get(name) }] : [])));
    }
    if (command.includes("docker volume ls")) return result(command, "ydb-local-data\n");
    if (spec.command === "docker" && spec.args?.[0] === "image") return result(command, "sha256:reviewed-image\n");
    if (command.includes("ReadStoragePool")) return result(command,
      'StoragePool { BoxId: 1 StoragePoolId: 2 Name: "/local/example:hdd" NumGroups: 2 ItemConfigGeneration: 1 }');
    if (command.includes(" tools dump ")) {
      const dumpName = /\/dump\/([^/]+)\/tenant/.exec(command)?.[1];
      if (!dumpName) throw new Error("Missing fixture dump name");
      const directory = join(profile.dumpHostPath, dumpName, "tenant");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "data.csv"), "safe dump fixture\n");
      this.dumpCalls++;
      this.duringDump?.();
      return result(command);
    }
    this.beforeCommand?.(spec);
    const script = spec.args?.[1] ?? "";
    const targets = [...script.matchAll(/expected_id=(\S+)\nactual_id=\$\(docker inspect(?: --type container)? --format '\{\{\.Id\}\}' ([\w.-]+)/g)];
    for (const [, expected, name] of targets) if (this.ids.get(name!) !== expected) return result(command, "", false);
    for (const [, name] of script.matchAll(/if \[ "\$current_name" = ([\w.-]+) \]/g)) {
      if (this.ids.has(name!)) return result(command, "", false);
    }
    const target = targets.at(-1);
    if (target && /docker (?:rm -f|stop|start) "\$expected_id"/.test(script)) {
      this.actedOn.push(target[1]!);
      if (script.includes('docker rm -f "$expected_id"')) this.ids.delete(target[2]!);
    }
    if (script.includes("admin database") && script.includes("docker exec")) {
      const id = /docker exec(?: -i)? ([\w.-]+)/.exec(script)?.[1];
      if (id) this.actedOn.push(id);
    }
    // Stop after the disputed action, before unrelated readiness waits.
    return result(command, "", !script.includes("docker create"));
  }
}
function context(executor: CommandExecutor, operation: "destroy" | "restart") {
  const config = ConfigSchema.parse({ profiles: { default: { dynamicNodeCount: 2 } } });
  return { ...createContext(undefined, executor, config), confirmation: {
    store: new ProcessConfirmationStore(),
    toolName: operation === "destroy" ? "local_ydb_destroy_stack" : "local_ydb_restart_stack",
    configSource: { kind: "provided" as const, config },
  } };
}
describe("configured stack container identities", () => {
  for (const operation of ["destroy", "restart"] as const) {
    const call = operation === "destroy" ? destroyStack : restartStack;
    for (const name of ["ydb-local", "ydb-dyn-example", "ydb-dyn-example-2"]) {
      it.each(["before confirm", "after consume", "after first guard"] as const)(
        operation + " preserves replacement of " + name + " %s", async boundary => {
          const executor = new IdentityExecutor();
          const ctx = context(executor, operation);
          const plan = await call(ctx, {});
          let replaced = false;
          const replace = () => { executor.ids.set(name, "replacement-id"); replaced = true; };
          if (boundary === "before confirm") replace();
          else executor.beforeCommand = spec => {
            const trigger = boundary === "after consume"
              ? spec.description === "Verify reviewed stack container identities"
              : spec.description?.startsWith(operation === "destroy" ? "Remove exact" : "Stop ");
            if (!replaced && trigger) replace();
          };
          const response = await call(ctx, { confirm: true, confirmationToken: plan.confirmation?.token });
          expect(replaced).toBe(true);
          expect(response.confirmation?.status).toBe(boundary === "before confirm" ? "rejected" : "accepted");
          expect(executor.actedOn).not.toContain("replacement-id");
          expect(executor.ids.get(name)).toBe("replacement-id");
        },
      );
    }
    it(operation + " does not adopt a configured container that appears after consume", async () => {
      const executor = new IdentityExecutor();
      executor.ids.delete("ydb-dyn-example-2");
      const ctx = context(executor, operation);
      const plan = await call(ctx, {});
      executor.beforeCommand = spec => {
        if (spec.description === "Verify reviewed stack container identities") executor.ids.set("ydb-dyn-example-2", "new-id");
      };
      const response = await call(ctx, { confirm: true, confirmationToken: plan.confirmation?.token });
      expect(response.results?.[0]?.ok).toBe(false);
      expect(executor.actedOn).toEqual([]);
      expect(executor.ids.get("ydb-dyn-example-2")).toBe("new-id");
    });
  }
  it("keeps legacy prepared extra-node names ID-bound without changing the third argument", async () => {
    const executor = new IdentityExecutor();
    executor.ids.set("ydb-dyn-example-3", "extra-id");
    const ctx = context(executor, "destroy");
    const plan = await destroyStack(ctx, {}, ["ydb-dyn-example-3"]);
    executor.ids.set("ydb-dyn-example-3", "replacement-id");
    const response = await destroyStack(ctx, { confirm: true, confirmationToken: plan.confirmation?.token }, ["ydb-dyn-example-3"]);
    expect(response.confirmation?.status).toBe("rejected");
    expect(executor.actedOn).toEqual([]);
  });
  it("does not invent an ID for a present but uninspectable configured container", async () => {
    const executor = new IdentityExecutor();
    const ctx = context(executor, "destroy");
    await expect(prepareStackTargets(ctx, {
      containers: [{ names: "unknown-configured" }], inspect: [],
    }, ["unknown-configured"])).rejects.toThrow("Could not inspect exact Docker identity");
  });
  it("records explicit absence separately from a missing inspect ID", async () => {
    const ctx = context(new IdentityExecutor(), "destroy");
    const targets = await prepareStackTargets(ctx, { containers: [], inspect: [] }, ["ydb-dyn-example"]);
    expect(targets.staticContainer.containerId).toBe(null);
    expect(targets.dynamicContainers[0]?.containerId).toBe(null);
  });
  it("does not report planned tenant removal when the static container is absent", async () => {
    const executor = new IdentityExecutor();
    executor.ids.clear();
    const ctx = context(executor, "destroy");
    const plan = await destroyStack(ctx, {});
    expect(plan.tenantRemovePlanned).toBe(false);
    const response = await destroyStack(ctx, { confirm: true, confirmationToken: plan.confirmation?.token });
    expect(response.tenantRemovePlanned).toBe(false);
    expect(response.plannedCommands.join("\n")).not.toContain("admin database");
    expect(executor.actedOn).toEqual([]);
  });
  for (const family of ["upgrade", "storage"] as const) {
    it.each(["ydb-local", "ydb-dyn-example", "ydb-dyn-example-2"])(
      family + " preserves reviewed %s replaced during dump", async name => {
        const directory = mkdtempSync(join(tmpdir(), "local-ydb-stack-receipt-"));
        const executor = new IdentityExecutor();
        const config = ConfigSchema.parse({ profiles: { default: { dynamicNodeCount: 2, dumpHostPath: join(directory, "dumps") } } });
        const configPath = join(directory, "config.json");
        writeFileSync(configPath, JSON.stringify(config));
        const ctx = { ...createContext(undefined, executor, config, configPath), confirmation: {
          store: new ProcessConfirmationStore(),
          toolName: family === "upgrade" ? "local_ydb_upgrade_version" : "local_ydb_reduce_storage_groups",
          configSource: { kind: "provided" as const, config },
        } };
        const options = { version: "26.1.2.0", count: 1, dumpName: "receipt" };
        const call = family === "upgrade" ? upgradeVersion : reduceStorageGroups;
        try {
          const plan = await call(ctx, options);
          executor.duringDump = () => executor.ids.set(name, "replacement-id");
          const response = await call(ctx, { ...options, confirm: true, confirmationToken: plan.confirmation?.token });
          expect(response.confirmation?.status).toBe("accepted");
          expect(executor.dumpCalls).toBe(1);
          expect(response.results?.some(item => !item.ok)).toBe(true);
          expect(executor.actedOn).toEqual([]);
          expect(executor.ids.get(name)).toBe("replacement-id");
          const replay = await call(ctx, { ...options, confirm: true, confirmationToken: plan.confirmation?.token });
          expect(replay.confirmation?.status).toBe("rejected");
          expect(executor.dumpCalls).toBe(1);
        } finally {
          rmSync(directory, { recursive: true, force: true });
          expect(existsSync(directory)).toBe(false);
        }
      },
    );
  }
});
describe("executable stack identity guards", () => {
  it.each(["matching", "replacement", "absent", "late arrival"] as const)("checks %s state with actual shell control flow", async variation => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-stack-guard-"));
    const marker = join(dir, "mutation");
    const profile = createContext(undefined, undefined, ConfigSchema.parse({})).profile;
    const expected = variation === "absent" || variation === "late arrival" ? null : "reviewed-id";
    const current = variation === "matching" ? "reviewed-id" : "replacement-id";
    const names = variation === "absent" ? "" : "ydb-local";
    const spec = stackTargetsGuardSpec([{ container: "ydb-local", containerId: expected }]);
    const docker = "docker() { if [ \"$1\" = ps ]; then printf '%s\\n' " + shellQuote(names) + "; else printf '%s\\n' " + shellQuote(current) + "; fi; }";
    try {
      const response = await new ShellCommandExecutor().run(profile, bash(
        docker + "\n" + spec.args![1] + "\ntouch " + shellQuote(marker),
      ));
      const allowed = variation === "matching" || variation === "absent";
      expect(response.ok).toBe(allowed);
      expect(existsSync(marker)).toBe(allowed);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("stops shared cleanup when a prepared name reappears", async () => {
    const profile = createContext(undefined, undefined, ConfigSchema.parse({})).profile;
    const spec = stackTargetsAbsentSpec(["ydb-local", "ydb-dyn-example"]);
    const response = await new ShellCommandExecutor().run(profile, bash(
      "docker() { printf '%s\\n' ydb-dyn-example; }\n" + spec.args![1] + "\nprintf SHOULD_NOT_RUN",
    ));
    expect(response.ok).toBe(false);
    expect(response.stdout).not.toContain("SHOULD_NOT_RUN");
  });
});
