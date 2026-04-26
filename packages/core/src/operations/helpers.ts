import type { ResolvedLocalYdbProfile } from "../validation.js";
import type { DynamicNodeTarget } from "./types.js";

export function publicProfile(profile: ResolvedLocalYdbProfile) {
  return {
    ...profile,
    authConfigPath: profile.authConfigPath ? "<redacted>" : undefined,
    dynamicNodeAuthTokenFile: profile.dynamicNodeAuthTokenFile ? "<redacted>" : undefined,
    rootPasswordFile: profile.rootPasswordFile ? "<redacted>" : undefined,
    ssh: profile.ssh ? { ...profile.ssh, identityFile: profile.ssh.identityFile ? "<redacted>" : undefined } : undefined
  };
}

export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function assertPort(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Port must be an integer between 1 and 65535: ${value}`);
  }
}

export function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function collectGraphShardTabletIds(value: unknown): unknown[] {
  const result: unknown[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") {
      return;
    }
    const obj = item as Record<string, unknown>;
    if (obj.Type === "GraphShard" && "TabletId" in obj) {
      result.push(obj.TabletId);
    }
    Object.values(obj).forEach(visit);
  };
  visit(value);
  return result;
}

export function escapeTextProtoString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function observedNodePorts(nodes: unknown[]): number[] {
  return nodes
    .map((node) => node && typeof node === "object" ? (node as Record<string, unknown>).Port : undefined)
    .filter((port): port is number => typeof port === "number")
    .sort((a, b) => a - b);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extraDynamicNodeTarget(profile: ResolvedLocalYdbProfile, name?: string): DynamicNodeTarget | undefined {
  if (!name) {
    return undefined;
  }
  const match = new RegExp(`^${escapeRegExp(profile.dynamicContainer)}-(\\d+)$`).exec(name);
  if (!match) {
    return undefined;
  }
  return {
    container: name,
    index: Number(match[1])
  };
}

export function findExtraDynamicContainers(profile: ResolvedLocalYdbProfile, names: Array<string | undefined>): string[] {
  return names
    .map((name) => extraDynamicNodeTarget(profile, name))
    .filter((target): target is DynamicNodeTarget => Boolean(target))
    .sort((left, right) => right.index - left.index)
    .map((target) => target.container);
}

export function assertSafeCleanupTarget(target: string): void {
  const normalized = target.trim();
  if (!normalized || normalized === "/" || normalized === "/tmp" || normalized === "/var" || normalized === "/var/lib" || normalized === "/var/lib/docker" || normalized === "/var/lib/docker/volumes") {
    throw new Error(`Refusing unsafe cleanup target: ${target}`);
  }
  if (!/(ydb|local|dump)/i.test(normalized)) {
    throw new Error(`Cleanup target must look local-ydb related: ${target}`);
  }
}
