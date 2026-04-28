import { describe, expect, it } from "vitest";
import {
  commandToShell,
  createContext,
  managePermissions,
  ShellCommandExecutor,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  type PermissionsListResponse,
  type PermissionsMutationResponse,
  type PermissionsResponse,
  type ResolvedLocalYdbProfile,
} from "../src/index.js";
import { ConfigSchema } from "../src/validation.js";

class RecordingExecutor implements CommandExecutor {
  readonly commands: string[] = [];

  constructor(
    readonly stdout = "",
    readonly stderr = "",
    readonly ok = true,
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
      timedOut: false,
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
      timedOut: false,
    };
  }
}

function expectMutationResponse(response: PermissionsResponse): PermissionsMutationResponse {
  if (!("plannedCommands" in response)) {
    throw new Error("Expected a mutating permissions response");
  }
  return response;
}

function expectListResponse(response: PermissionsResponse): PermissionsListResponse {
  if (response.action !== "list") {
    throw new Error("Expected a permissions list response");
  }
  return response;
}

describe("permissions management", () => {
  it("lists permissions for the configured tenant root without confirm", async () => {
    const executor = new RecordingExecutor("Owner: root\n");
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const response = expectListResponse(await managePermissions(ctx));

    expect(response).toMatchObject({
      ok: true,
      action: "list",
      path: "/local/example",
      stdout: "Owner: root\n",
      stdoutTruncated: false,
      stderrTruncated: false,
      maxOutputBytes: 65_536,
    });
    expect(response.command).toContain("scheme permissions list /local/example");
    expect(response.command).toContain("-d /local/example");
    expect(executor.commands).toHaveLength(1);
  });

  it("passes each granted permission as a separate CLI argument", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const response = expectMutationResponse(await managePermissions(ctx, {
      action: "grant",
      path: "/local/example/app",
      subject: "testuser",
      permissions: ["ydb.generic.read", "ydb.access.grant"],
    }));

    expect(response).toMatchObject({
      executed: false,
      action: "grant",
      path: "/local/example/app",
      subject: "testuser",
      permissions: ["ydb.generic.read", "ydb.access.grant"],
    });
    expect(executor.commands).toEqual([]);
    expect(response.plannedCommands[0]).toContain(
      "scheme permissions grant -p ydb.generic.read -p ydb.access.grant /local/example/app testuser",
    );
  });

  it("executes mutating permission actions only with confirm=true", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const response = expectMutationResponse(await managePermissions(ctx, {
      action: "revoke",
      path: "/local/example/app",
      subject: "testuser",
      permissions: ["ydb.generic.read"],
      confirm: true,
    }));

    expect(response.executed).toBe(true);
    expect(response.results).toHaveLength(1);
    expect(executor.commands).toEqual(response.plannedCommands);
    expect(executor.commands[0]).toContain(
      "scheme permissions revoke -p ydb.generic.read /local/example/app testuser",
    );
  });

  it("builds clear, chown, and inheritance commands in upstream CLI shape", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    const clear = expectMutationResponse(await managePermissions(ctx, {
      action: "clear",
      path: "/local/example/app",
    }));
    const chown = expectMutationResponse(await managePermissions(ctx, {
      action: "chown",
      path: "/local/example/app",
      owner: "new-owner",
    }));
    const setInheritance = expectMutationResponse(await managePermissions(ctx, {
      action: "set-inheritance",
      path: "/local/example/app",
    }));
    const clearInheritance = expectMutationResponse(await managePermissions(ctx, {
      action: "clear-inheritance",
      path: "/local/example/app",
    }));

    expect(clear.plannedCommands[0]).toContain("scheme permissions clear /local/example/app");
    expect(chown.plannedCommands[0]).toContain("scheme permissions chown /local/example/app new-owner");
    expect(setInheritance.plannedCommands[0]).toContain("scheme permissions set-inheritance /local/example/app");
    expect(clearInheritance.plannedCommands[0]).toContain("scheme permissions clear-inheritance /local/example/app");
    expect(executor.commands).toEqual([]);
  });

  it("rejects missing subject, owner, and permissions before command execution", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));

    await expect(managePermissions(ctx, {
      action: "grant",
      permissions: ["ydb.generic.read"],
    })).rejects.toThrow(/subject must be non-empty/);

    await expect(managePermissions(ctx, {
      action: "grant",
      subject: "testuser",
    })).rejects.toThrow(/At least one permission/);

    await expect(managePermissions(ctx, {
      action: "chown",
    })).rejects.toThrow(/owner must be non-empty/);

    expect(executor.commands).toEqual([]);
  });

  it("redacts root password file paths in authenticated command text", async () => {
    const executor = new DisplayOnlyShellExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          rootPasswordFile: "/tmp/local-ydb/root.password",
        },
      },
    }));

    const response = expectMutationResponse(await managePermissions(ctx, {
      action: "grant",
      subject: "testuser",
      permissions: ["ydb.generic.read"],
    }));

    expect(response.plannedCommands[0]).toContain("<redacted>");
    expect(response.plannedCommands[0]).not.toContain("/tmp/local-ydb/root.password");
  });
});
