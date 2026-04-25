import { describe, expect, it } from "vitest";
import { parseBscPlacement, parseDockerPsJsonLines, redactCommand, ShellCommandExecutor } from "../src/index.js";
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
});
