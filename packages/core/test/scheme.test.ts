import { describe, expect, it } from "vitest";
import {
  commandToShell,
  createContext,
  inspectScheme,
  ShellCommandExecutor,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  type ResolvedLocalYdbProfile
} from "../src/index.js";
import { ConfigSchema } from "../src/validation.js";

class RecordingExecutor implements CommandExecutor {
  readonly commands: string[] = [];

  constructor(
    readonly stdout = "",
    readonly stderr = "",
    readonly ok = true
  ) {}

  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    const command = this.display(profile, spec);
    this.commands.push(command);
    return {
      command,
      exitCode: this.ok ? 0 : 1,
      stdout: this.stdout,
      stderr: this.stderr,
      ok: this.ok,
      timedOut: false
    };
  }
}

class DisplayOnlyShellExecutor extends ShellCommandExecutor {
  readonly commands: string[] = [];

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

describe("scheme inspection", () => {
  it("lists the configured tenant root by default", async () => {
    const executor = new RecordingExecutor("dir1\ndir2\n");
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const response = await inspectScheme(ctx);

    expect(response).toMatchObject({
      ok: true,
      action: "list",
      path: "/local/example",
      stdout: "dir1\ndir2\n",
      stdoutTruncated: false,
      stderrTruncated: false,
      maxOutputBytes: 65_536
    });
    expect(response.command).toContain("scheme ls /local/example");
    expect(response.command).toContain("-d /local/example");
  });

  it("adds list flags in the documented CLI order", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const response = await inspectScheme(ctx, {
      path: "/local/example/dir",
      long: true,
      recursive: true,
      onePerLine: true
    });

    expect(response.command).toContain("scheme ls /local/example/dir -l -R -1");
  });

  it("describes a scheme object with stats", async () => {
    const executor = new RecordingExecutor("<table> users\n");
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const response = await inspectScheme(ctx, {
      action: "describe",
      path: "/local/example/users",
      stats: true
    });

    expect(response).toMatchObject({
      ok: true,
      action: "describe",
      path: "/local/example/users",
      stdout: "<table> users\n"
    });
    expect(response.command).toContain("scheme describe /local/example/users --stats");
  });

  it("rejects unsupported flag combinations", async () => {
    const ctx = createContext(undefined, new RecordingExecutor(), ConfigSchema.parse({}));

    await expect(inspectScheme(ctx, {
      action: "list",
      stats: true
    })).rejects.toThrow(/stats is only supported/);

    await expect(inspectScheme(ctx, {
      action: "describe",
      recursive: true
    })).rejects.toThrow(/only supported when action is list/);
  });

  it("caps stdout and stderr independently", async () => {
    const executor = new RecordingExecutor("abcdef", "uvwxyz");
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const response = await inspectScheme(ctx, { maxOutputBytes: 3 });

    expect(response).toMatchObject({
      stdout: "abc",
      stderr: "uvw",
      stdoutBytes: 6,
      stderrBytes: 6,
      stdoutTruncated: true,
      stderrTruncated: true,
      maxOutputBytes: 3
    });
    expect(response.summary).toContain("with capped output");
  });

  it("redacts root password file paths in authenticated command text", async () => {
    const executor = new DisplayOnlyShellExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          rootPasswordFile: "/tmp/local-ydb/root.password"
        }
      }
    }));

    const response = await inspectScheme(ctx);

    expect(response.command).toContain("<redacted>");
    expect(response.command).not.toContain("/tmp/local-ydb/root.password");
  });

  it("wraps commands through ssh for ssh profiles", async () => {
    const executor = new DisplayOnlyShellExecutor();
    const ctx = createContext("remote", executor, ConfigSchema.parse({
      defaultProfile: "remote",
      profiles: {
        remote: {
          mode: "ssh",
          ssh: {
            host: "example-host",
            user: "ops"
          }
        }
      }
    }));

    const response = await inspectScheme(ctx, { path: "/local/example/dir" });

    expect(response.command).toContain("ssh -o BatchMode=yes");
    expect(response.command).toContain("ops@example-host");
    expect(response.command).toContain("scheme ls /local/example/dir");
  });
});
