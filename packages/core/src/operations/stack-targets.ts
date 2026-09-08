import { bash, shellQuote, type CommandSpec, type DockerContainerSummary } from "../api-client.js";
import type { ToolkitContext } from "./types.js";

export interface StackContainerTarget {
  container: string;
  containerId: string | null;
}

export interface PreparedStackTargets {
  staticContainer: StackContainerTarget;
  dynamicContainers: StackContainerTarget[];
}

export async function prepareStackTargets(
  ctx: ToolkitContext,
  inventory: { containers: readonly DockerContainerSummary[]; inspect: readonly unknown[] },
  dynamicNames: readonly string[],
): Promise<PreparedStackTargets> {
  const names = [...new Set([ctx.profile.staticContainer, ...dynamicNames])];
  const present = new Set(inventory.containers.map((item) => item.names));
  const byName = new Map<string, string>();
  const collect = (items: readonly unknown[]) => {
    for (const item of items) {
      if (!item || typeof item !== "object" || !("Name" in item) || !("Id" in item)) continue;
      if (typeof item.Name === "string" && typeof item.Id === "string" && item.Id && !/\s/.test(item.Id)) {
        byName.set(item.Name.replace(/^\//, ""), item.Id);
      }
    }
  };
  collect(inventory.inspect);
  const missing = names.filter((name) => present.has(name) && !byName.has(name));
  if (missing.length) collect(await ctx.client.dockerInspect(missing));
  const target = (container: string): StackContainerTarget => {
    if (!present.has(container)) return { container, containerId: null };
    const containerId = byName.get(container);
    if (!containerId) {
      throw new Error("Could not inspect exact Docker identity for every configured stack container.");
    }
    return { container, containerId };
  };
  return { staticContainer: target(ctx.profile.staticContainer), dynamicContainers: dynamicNames.map(target) };
}

export function stackContainerIdentityCheckLines(target: StackContainerTarget): string[] {
  if (target.containerId === null) return absentContainerLines([target.container]);
  const failure = "printf '%s\\n' 'Reviewed Docker container identity changed.' >&2; exit 1";
  return [
    `expected_id=${shellQuote(target.containerId)}`,
    `actual_id=$(docker inspect --type container --format '{{.Id}}' ${shellQuote(target.container)} 2>/dev/null) || { ${failure}; }`,
    `[ "$actual_id" = "$expected_id" ] || { ${failure}; }`,
  ];
}

export function stackTargetsGuardSpec(targets: readonly StackContainerTarget[]): CommandSpec {
  targets = [...new Map(targets.map((target) => [JSON.stringify([target.container, target.containerId]), target])).values()];
  const absent = targets.filter((target) => target.containerId === null).map((target) => target.container);
  return bash(["set -euo pipefail",
    ...targets.filter((target) => target.containerId !== null).flatMap(stackContainerIdentityCheckLines),
    ...(absent.length ? absentContainerLines(absent) : []),
  ].join("\n"), { timeoutMs: 60_000, description: "Verify reviewed stack container identities" });
}

export function stackTargetsAbsentSpec(names: readonly string[]): CommandSpec {
  return bash(["set -euo pipefail", ...absentContainerLines(names)].join("\n"), {
    timeoutMs: 60_000, description: "Verify reviewed stack containers are absent before shared cleanup",
  });
}

function absentContainerLines(names: readonly string[]): string[] {
  return [
    "current_container_names=$(docker ps -a --format '{{.Names}}')",
    ...[...new Set(names)].map((name) => [
      "while IFS= read -r current_name; do",
      `  if [ "$current_name" = ${shellQuote(name)} ]; then`,
      "    printf '%s\\n' 'A stack container appeared before cleanup; shared resources were preserved.' >&2",
      "    exit 1",
      "  fi",
      "done <<< \"$current_container_names\"",
    ].join("\n")),
  ];
}
