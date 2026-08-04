import { bash, type CommandResult } from "../api-client.js";
import type { ToolkitContext } from "./types.js";

const DOCKER_RUNTIME_PROBE_TIMEOUT_MS = 30_000;

export interface DockerRuntimeProbe {
  cliAvailable: boolean;
  daemonReachable: boolean;
  detail: string;
  results: CommandResult[];
}

export async function probeDockerRuntime(ctx: ToolkitContext): Promise<DockerRuntimeProbe> {
  const cliResult = await ctx.client.run(bash("command -v docker >/dev/null 2>&1", {
    allowFailure: true,
    timeoutMs: DOCKER_RUNTIME_PROBE_TIMEOUT_MS,
    description: "Check docker availability"
  }));
  if (!cliResult.ok) {
    return {
      cliAvailable: false,
      daemonReachable: false,
      detail: "Docker CLI is missing.",
      results: [withoutOutput(cliResult)]
    };
  }

  const daemonResult = await ctx.client.run(bash("docker info >/dev/null 2>&1", {
    allowFailure: true,
    timeoutMs: DOCKER_RUNTIME_PROBE_TIMEOUT_MS,
    description: "Check Docker daemon reachability"
  }));
  return {
    cliAvailable: true,
    daemonReachable: daemonResult.ok,
    detail: daemonResult.ok
      ? "Docker CLI and daemon are available."
      : "Docker CLI is available, but the Docker daemon is unavailable or inaccessible.",
    results: [withoutOutput(cliResult), withoutOutput(daemonResult)]
  };
}

function withoutOutput(result: CommandResult): CommandResult {
  return {
    ...result,
    stdout: "",
    stderr: ""
  };
}
