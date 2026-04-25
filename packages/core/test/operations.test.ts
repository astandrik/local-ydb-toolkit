import { describe, expect, it } from "vitest";
import {
  bootstrap,
  commandToShell,
  createContext,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  type ResolvedLocalYdbProfile
} from "../src/index.js";
import { ConfigSchema } from "../src/validation.js";

class RecordingExecutor implements CommandExecutor {
  readonly commands: string[] = [];

  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

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

describe("mutating operations", () => {
  it("does not execute bootstrap without confirm=true", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await bootstrap(ctx, {});
    expect(response.executed).toBe(false);
    expect(executor.commands).toEqual([]);
    expect(response.plannedCommands.some((command) => command.includes("docker network"))).toBe(true);
  });

  it("executes bootstrap commands with confirm=true", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({}));
    const response = await bootstrap(ctx, { confirm: true });
    expect(response.executed).toBe(true);
    expect(executor.commands.length).toBeGreaterThan(1);
    expect(executor.commands.join("\n")).toContain("admin database");
  });
});
