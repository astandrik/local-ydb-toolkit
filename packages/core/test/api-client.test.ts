import { describe, expect, it } from "vitest";
import {
  LocalYdbApiClient,
  parseBscPlacement,
  parseDockerPsJsonLines,
  parseReadStoragePools,
  redactCommand,
  ShellCommandExecutor,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec
} from "../src/index.js";
import { ConfigSchema, resolveProfile } from "../src/validation.js";

describe("api client helpers", () => {
  it("parses docker ps JSON lines", () => {
    const containers = parseDockerPsJsonLines([
      JSON.stringify({ ID: "1", Image: "img", Names: "ydb-local", State: "running", Status: "Up", Ports: "8765/tcp" }),
      JSON.stringify({ ID: "2", Image: "img", Names: "ydb-dyn-example", State: "exited", Status: "Exited" })
    ].join("\n"));
    expect(containers).toHaveLength(2);
    expect(containers[0].names).toBe("ydb-local");
  });

  it("parses BSC placement fragments", () => {
    const placement = parseBscPlacement('GroupId: 100 PDiskId: 1 Path: "/ydb_data/pdisks/1"\nGroupId: 101 PDiskId: 2');
    expect(placement.groupIds).toEqual([100, 101]);
    expect(placement.pdiskIds).toEqual([1, 2]);
    expect(placement.paths).toEqual(["/ydb_data/pdisks/1"]);
  });

  it("parses storage pools from ReadStoragePool output", () => {
    const pools = parseReadStoragePools(`
Status {
  StoragePool {
    BoxId: 1
    StoragePoolId: 2
    Name: "/local/example:hdd"
    Kind: "hdd"
    NumGroups: 1
    ItemConfigGeneration: 2
  }
}
`);
    expect(pools).toHaveLength(1);
    expect(pools[0].name).toBe("/local/example:hdd");
    expect(pools[0].storagePoolId).toBe(2);
    expect(pools[0].numGroups).toBe(1);
    expect(pools[0].itemConfigGeneration).toBe(2);
  });

  it("redacts sensitive command flags and profile values", () => {
    expect(redactCommand("ydb --password-file /secret/root.password --token-file abc")).toContain("--password-file <redacted>");
  });

  it("formats ssh commands with safe defaults", () => {
    const profile = resolveProfile(ConfigSchema.parse({
      profiles: {
        default: {
          mode: "ssh",
          ssh: {
            host: "db.example",
            user: "ops",
            port: 2222
          }
        }
      }
    }));
    const command = new ShellCommandExecutor().display(profile, { command: "docker", args: ["ps"] });
    expect(command).toContain("ssh");
    expect(command).toContain("BatchMode=yes");
    expect(command).toContain("ops@db.example");
  });

  it("uses the configured monitoring port for authenticated viewer login", async () => {
    class RecordingExecutor implements CommandExecutor {
      command = "";

      display(_profile: ReturnType<typeof resolveProfile>, spec: CommandSpec): string {
        this.command = [spec.command, ...(spec.args ?? [])].join(" ");
        return this.command;
      }

      async run(profile: ReturnType<typeof resolveProfile>, spec: CommandSpec): Promise<CommandResult> {
        const command = this.display(profile, spec);
        return { command, exitCode: 0, stdout: "{}", stderr: "", ok: true, timedOut: false };
      }
    }

    const profile = resolveProfile(ConfigSchema.parse({
      profiles: {
        default: {
          ports: {
            monitoring: 9065
          },
          rootPasswordFile: "/tmp/root.password"
        }
      }
    }));
    const executor = new RecordingExecutor();
    const client = new LocalYdbApiClient(profile, executor);
    await client.viewerGet("/viewer/json/nodelist", true);
    expect(executor.command).toContain("http://127.0.0.1:9065/login");
  });
});
