import { bash, shellQuote, type CommandSpec } from "../api-client.js";
import type { ToolkitContext, DynamicNodePlan } from "./types.js";
import { assertPort, escapeRegExp, extraDynamicNodeTarget } from "./helpers.js";

export interface InspectedDynamicNodePorts {
  containerId?: string;
  grpcPort?: number;
  monitoringPort?: number;
  icPort?: number;
}

export interface ExactDynamicNodeTarget {
  container: string;
  containerId: string;
}

export interface InspectedDynamicNodePlan extends DynamicNodePlan, ExactDynamicNodeTarget {}

export type ExactDynamicNodeAction = "remove" | "stop" | "start";

export function exactDynamicNodeActionSpec(
  target: ExactDynamicNodeTarget,
  action: ExactDynamicNodeAction,
  description: string,
): CommandSpec {
  const dockerCommand = exactDynamicNodeCommand(action);
  return bash([
    "set -euo pipefail",
    `expected_id=${shellQuote(target.containerId)}`,
    `actual_id=$(docker inspect --format '{{.Id}}' ${shellQuote(target.container)})`,
    `[ "$actual_id" = "$expected_id" ]`,
    dockerCommand,
  ].join("\n"), {
    timeoutMs: 60_000,
    description,
  });
}

function exactDynamicNodeCommand(action: ExactDynamicNodeAction): string {
  switch (action) {
    case "remove":
      return "docker rm -f \"$expected_id\"";
    case "stop":
      return "docker stop \"$expected_id\"";
    case "start":
      return "docker start \"$expected_id\"";
    default:
      throw new Error("Unsupported exact dynamic-node action.");
  }
}

export function exactDynamicNodeRemovalSpec(
  target: ExactDynamicNodeTarget,
  description: string,
): CommandSpec {
  return exactDynamicNodeActionSpec(target, "remove", description);
}

export async function inspectDynamicNodePorts(
  ctx: ToolkitContext,
  containers: string[]
): Promise<Map<string, InspectedDynamicNodePorts>> {
  const inspect = await ctx.client.dockerInspect(containers);
  const byContainer = new Map<string, InspectedDynamicNodePorts>();
  for (const item of inspect) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const name = typeof obj.Name === "string" ? obj.Name.replace(/^\//, "") : undefined;
    if (!name) {
      continue;
    }
    byContainer.set(name, {
      containerId: typeof obj.Id === "string" ? obj.Id : undefined,
      grpcPort: readCommandPort(obj, "--grpc-port"),
      monitoringPort: readCommandPort(obj, "--mon-port"),
      icPort: readCommandPort(obj, "--ic-port")
    });
  }
  return byContainer;
}

export async function inspectExtraDynamicNodePlans(
  ctx: ToolkitContext,
  names: Array<string | undefined>
): Promise<InspectedDynamicNodePlan[]> {
  const targets = names
    .map((name) => extraDynamicNodeTarget(ctx.profile, name))
    .filter((target): target is NonNullable<typeof target> => Boolean(target))
    .filter((target) => target.index > ctx.profile.dynamicNodeCount)
    .sort((left, right) => left.index - right.index);
  const byContainer = await inspectDynamicNodePorts(ctx, targets.map((target) => target.container));

  return targets.map((target) => {
    const ports = byContainer.get(target.container);
    if (
      !ports?.containerId
      || typeof ports.grpcPort !== "number"
      || typeof ports.monitoringPort !== "number"
      || typeof ports.icPort !== "number"
    ) {
      throw new Error(`Could not inspect exact Docker identity and gRPC, monitoring, and IC ports for one-off dynamic node ${target.container} before destructive rebuild.`);
    }
    assertPort(ports.grpcPort);
    assertPort(ports.monitoringPort);
    assertPort(ports.icPort);
    return {
      ...target,
      containerId: ports.containerId,
      grpcPort: ports.grpcPort,
      monitoringPort: ports.monitoringPort,
      icPort: ports.icPort
    };
  });
}

function readCommandPort(value: Record<string, unknown>, flag: string): number | undefined {
  const args = Array.isArray(value.Args) ? value.Args : [];
  const fromArgs = readPortFromArgs(args, flag);
  if (typeof fromArgs === "number") {
    return fromArgs;
  }
  const config = value.Config;
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const cmd = Array.isArray((config as Record<string, unknown>).Cmd)
    ? (config as Record<string, unknown>).Cmd as unknown[]
    : [];
  return readPortFromArgs(cmd, flag);
}

function readPortFromArgs(args: unknown[], flag: string): number | undefined {
  const strings = args.filter((arg): arg is string => typeof arg === "string");
  for (let index = 0; index < strings.length; index += 1) {
    if (strings[index] === flag) {
      const port = Number(strings[index + 1]);
      return Number.isInteger(port) ? port : undefined;
    }
  }
  const joined = strings.join(" ");
  const match = new RegExp(`${escapeRegExp(flag)}(?:=|\\s+)(\\d+)`).exec(joined);
  return match ? Number(match[1]) : undefined;
}
