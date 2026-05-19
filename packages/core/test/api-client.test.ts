import { describe, expect, it } from "vitest";
import {
  LocalYdbApiClient,
  parseBscPlacement,
  parseDockerPsJsonLines,
  parseReadStoragePools,
  redactCommand,
  ShellCommandExecutor,
  shellQuote,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec
} from "../src/index.js";
import { pathRedactions } from "../src/redactions.js";
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
    const lineContinuation = "\\\n";

    expect(redactCommand("ydb --password-file /secret/root.password --token-file abc")).toContain("--password-file <redacted>");
    expect(redactCommand("docker rm -f ydb-local")).toBe("docker rm -f ydb-local");
    expect(redactCommand("docker exec -i ydb-local true")).toBe("docker exec -i ydb-local true");
    expect(redactCommand("ssh -i /secret/key host true")).toBe("ssh -i <redacted> host true");
    expect(redactCommand("ssh -i/secret/key host true")).toBe("ssh -i<redacted> host true");
    expect(redactCommand("/usr/bin/ssh -i /secret/key host true")).toBe("/usr/bin/ssh -i <redacted> host true");
    expect(redactCommand("scp -i /secret/key file host:/tmp")).toBe("scp -i <redacted> file host:/tmp");
    expect(redactCommand("sftp -i /secret/key host")).toBe("sftp -i <redacted> host");
    expect(redactCommand("bash -lc 'ssh -i /secret/key host true'")).toBe("bash -lc 'ssh -i <redacted> host true'");
    expect(redactCommand("bash -lc 'ssh -vi /secret/key host true'")).toBe("bash -lc 'ssh -vi <redacted> host true'");
    expect(redactCommand("bash -lc '/usr/bin/ssh -B eth0 -P tag -i /secret/key host true'")).toBe("bash -lc '/usr/bin/ssh -B eth0 -P tag -i <redacted> host true'");
    expect(redactCommand("bash -lc 'ssh -o ProxyCommand=\"ssh -i /secret/key jump\" host true'")).toBe("bash -lc 'ssh -o ProxyCommand=\"ssh -i <redacted> jump\" host true'");
    expect(redactCommand("bash -lc 'ssh -oProxyCommand=\"ssh -i /secret/key jump\" host true'")).toBe("bash -lc 'ssh -oProxyCommand=\"ssh -i <redacted> jump\" host true'");
    expect(redactCommand("bash -lc 'ssh -F <(printf x) -i /secret/key host'")).toBe("bash -lc 'ssh -F <(printf x) -i <redacted> host'");
    expect(redactCommand("bash -lc 'scp -X nrequests=64 -i /secret/key file host:/tmp'")).toBe("bash -lc 'scp -X nrequests=64 -i <redacted> file host:/tmp'");
    expect(redactCommand("bash -lc 'sftp -s subsystem -i /secret/key host'")).toBe("bash -lc 'sftp -s subsystem -i <redacted> host'");
    expect(redactCommand("bash -lc 'scp -p -i /secret/key file host:/tmp'")).toBe("bash -lc 'scp -p -i <redacted> file host:/tmp'");
    expect(redactCommand("bash -lc 'sftp -p -i /secret/key host'")).toBe("bash -lc 'sftp -p -i <redacted> host'");
    expect(redactCommand("env ssh -i /secret/key host true")).toBe("env ssh -i <redacted> host true");
    expect(redactCommand("bash -lc 'out=$(ssh -i /secret/key host true)'")).toBe("bash -lc 'out=$(ssh -i <redacted> host true)'");
    expect(redactCommand(`bash -lc 'ssh ${lineContinuation} -i /secret/key host true'`)).toBe(`bash -lc 'ssh ${lineContinuation} -i <redacted> host true'`);
    expect(redactCommand("bash -lc 'rm -f /tmp/secret'", ["/tmp/secret"])).toBe("bash -lc 'rm -f <redacted>'");
    expect(redactCommand("bash -lc 'ydb --token-file /secrets/token scheme ls'")).toBe("bash -lc 'ydb --token-file <redacted> scheme ls'");
    expect(redactCommand("bash -lc 'cmd=\"ydb --token-file /secret/token\"; echo ok'")).toBe("bash -lc 'cmd=\"ydb --token-file <redacted>\"; echo ok'");
    expect(redactCommand(`bash -lc 'ydb --token-file ${lineContinuation} /secret/token scheme ls'`)).toBe(`bash -lc 'ydb --token-file ${lineContinuation} <redacted> scheme ls'`);
    expect(redactCommand("bash -lc\\ 'ydb --token-file /secrets/token scheme ls'")).toBe("bash -lc\\ 'ydb --token-file <redacted> scheme ls'");
    expect(redactCommand("bash -lc\\ 'rm -f /tmp/secret path'", ["/tmp/secret path"])).toBe("bash -lc\\ 'rm -f <redacted>'");
    expect(redactCommand(`bash -lc 'ydb --token-file ${shellQuote("/tmp/quote'd/token file")} scheme ls'`)).toBe("bash -lc 'ydb --token-file <redacted> scheme ls'");
  });

  it("redacts every long sensitive flag inside quoted shell scripts", () => {
    for (const flag of ["--password", "--password-file", "--token-file", "--auth-token-file", "--access-token", "--private-key", "--sa-key-file"]) {
      expect(redactCommand(`bash -lc 'tool ${flag} /secrets/value done'`)).toBe(`bash -lc 'tool ${flag} <redacted> done'`);
    }
  });

  it("redacts shell-quoted profile paths before rendering display commands", () => {
    const authDir = "/tmp/local-ydb-auth/quote'd";
    const authConfigPath = `${authDir}/config.auth.yaml`;
    const dynamicNodeAuthTokenFile = `${authDir}/dynamic-node-auth.pb`;
    const profile = resolveProfile(ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath,
          dynamicNodeAuthTokenFile
        }
      }
    }));

    const executor = new ShellCommandExecutor();
    const command = executor.display(profile, {
      command: "bash",
      args: ["-lc", `install -d -m 0700 ${shellQuote(authDir)} && rm -f ${shellQuote(authConfigPath)}`]
    });
    const mountCommand = executor.display(profile, {
      command: "docker",
      args: ["run", "-v", `${dynamicNodeAuthTokenFile}:/run/local-ydb/dynamic-node-auth.pb:ro`]
    });

    expect(command).toBe("bash -lc 'install -d -m 0700 <redacted> && rm -f <redacted>'");
    expect(mountCommand).toContain("'<redacted>:/run/local-ydb/dynamic-node-auth.pb:ro'");
    expect(mountCommand).not.toContain("<redacted>/dynamic-node-auth.pb");
    expect(command).not.toContain("/tmp/local-ydb-auth");
    expect(mountCommand).not.toContain("/tmp/local-ydb-auth");
    expect(command).not.toContain("quote");
    expect(mountCommand).not.toContain("quote");
  });

  it("does not redact broad parent directories for top-level sensitive files", () => {
    const executor = new ShellCommandExecutor();
    const tmpProfile = resolveProfile(ConfigSchema.parse({
      profiles: {
        default: {
          rootPasswordFile: "/tmp/root.password"
        }
      }
    }));
    const tmpCommand = executor.display(tmpProfile, {
      command: "bash",
      args: ["-lc", "echo /tmp/not-secret && cat /tmp/root.password"]
    });
    const homeProfile = resolveProfile(ConfigSchema.parse({
      profiles: {
        default: {
          rootPasswordFile: "/home/alice/root.password"
        }
      }
    }));
    const homeCommand = executor.display(homeProfile, {
      command: "bash",
      args: ["-lc", "echo /home/alice/not-secret && cat /home/alice/root.password"]
    });

    expect(tmpCommand).toBe("bash -lc 'echo /tmp/not-secret && cat <redacted>'");
    expect(homeCommand).toBe("bash -lc 'echo /home/alice/not-secret && cat <redacted>'");
  });

  it("normalizes repeated trailing slashes without broad parent redactions", () => {
    const slashRun = "/".repeat(5000);
    expect(pathRedactions(`/tmp${slashRun}root.password`)).toEqual([`/tmp${slashRun}root.password`]);
    expect(pathRedactions(`/home/alice${slashRun}key`)).toEqual([`/home/alice${slashRun}key`]);
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
