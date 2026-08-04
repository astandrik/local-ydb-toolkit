import { bash, type CommandResult } from "../api-client.js";
import type { ToolkitContext } from "./types.js";

const DOCKER_RUNTIME_PROBE_TIMEOUT_MS = 30_000;

type DockerRuntimeProbeStatus =
  | "available"
  | "cli-missing"
  | "daemon-unavailable"
  | "target-unreachable"
  | "probe-failed";

interface DockerRuntimeProbe {
  status: DockerRuntimeProbeStatus;
  cliAvailable: boolean;
  daemonReachable: boolean;
  detail: string;
  results: CommandResult[];
}

export async function probeDockerRuntime(ctx: ToolkitContext): Promise<DockerRuntimeProbe> {
  const cliSpec = bash("command -v docker >/dev/null 2>&1", {
    allowFailure: true,
    timeoutMs: DOCKER_RUNTIME_PROBE_TIMEOUT_MS,
    description: "Check docker availability"
  });
  let cliResult: CommandResult;
  try {
    cliResult = await ctx.client.run(cliSpec);
  } catch {
    return unavailableProbe([failedProbeResult("Check Docker availability")]);
  }
  if (!cliResult.ok) {
    const status = classifyCliFailure(ctx, cliResult);
    if (status === "target-unreachable") {
      return unavailableProbe([safeProbeResult(cliResult, "Check Docker availability")]);
    }
    if (status === "probe-failed") {
      return {
        status,
        cliAvailable: false,
        daemonReachable: false,
        detail: "Docker availability could not be determined.",
        results: [safeProbeResult(cliResult, "Check Docker availability")]
      };
    }
    return {
      status,
      cliAvailable: false,
      daemonReachable: false,
      detail: "Docker CLI is missing.",
      results: [safeProbeResult(cliResult, "Check Docker availability")]
    };
  }

  const daemonSpec = bash("docker info >/dev/null 2>&1", {
    allowFailure: true,
    timeoutMs: DOCKER_RUNTIME_PROBE_TIMEOUT_MS,
    description: "Check Docker daemon reachability"
  });
  let daemonResult: CommandResult;
  try {
    daemonResult = await ctx.client.run(daemonSpec);
  } catch {
    return unavailableProbe([
      safeProbeResult(cliResult, "Check Docker availability"),
      failedProbeResult("Check Docker daemon reachability")
    ]);
  }
  if (!daemonResult.ok && isTargetUnavailable(ctx, daemonResult)) {
    return unavailableProbe([
      safeProbeResult(cliResult, "Check Docker availability"),
      safeProbeResult(daemonResult, "Check Docker daemon reachability")
    ]);
  }
  return {
    status: daemonResult.ok ? "available" : "daemon-unavailable",
    cliAvailable: true,
    daemonReachable: daemonResult.ok,
    detail: daemonResult.ok
      ? "Docker CLI and daemon are available."
      : "Docker CLI is available, but the Docker daemon is unavailable or inaccessible.",
    results: [
      safeProbeResult(cliResult, "Check Docker availability"),
      safeProbeResult(daemonResult, "Check Docker daemon reachability")
    ]
  };
}

function classifyCliFailure(ctx: ToolkitContext, result: CommandResult): Exclude<DockerRuntimeProbeStatus, "available" | "daemon-unavailable"> {
  if (isTargetUnavailable(ctx, result)) {
    return "target-unreachable";
  }
  if (ctx.profile.mode === "ssh") {
    return result.exitCode === 1 ? "cli-missing" : "probe-failed";
  }
  return "cli-missing";
}

function isTargetUnavailable(ctx: ToolkitContext, result: CommandResult): boolean {
  return result.timedOut || (ctx.profile.mode === "ssh" && result.exitCode === 255);
}

function unavailableProbe(results: CommandResult[]): DockerRuntimeProbe {
  return {
    status: "target-unreachable",
    cliAvailable: false,
    daemonReachable: false,
    detail: "The selected target is unavailable, so Docker state could not be determined.",
    results
  };
}

function failedProbeResult(command: string): CommandResult {
  return {
    command,
    exitCode: null,
    stdout: "",
    stderr: "",
    ok: false,
    timedOut: false
  };
}

function safeProbeResult(result: CommandResult, command: string): CommandResult {
  return {
    ...result,
    command,
    stdout: "",
    stderr: ""
  };
}
