import type { CommandExecutor } from "../../src/api-client.js";

// Older operation fixtures modeled names/ports but omitted configured IDs.
// Keep explicit IDs and missing extra-node responses intact; identity-boundary
// tests use their own executor rather than this compatibility fixture.
export function withConfiguredContainerIds(delegate: CommandExecutor): CommandExecutor {
  const present = new Map<string, string | undefined>();
  return {
    display: (profile, spec) => delegate.display(profile, spec),
    async run(profile, spec, observer) {
      const result = await delegate.run(profile, spec, observer);
      if (!result.ok || spec.command !== "docker") return result;
      if (spec.args?.[0] === "ps") {
        present.clear();
        for (const line of result.stdout.split("\n").filter(Boolean)) {
          const item = JSON.parse(line);
          if (typeof item.Names === "string") present.set(item.Names, item.ID);
        }
      }
      if (spec.args?.[0] !== "inspect" || spec.args[1]?.startsWith("-")) return result;
      const configured = new Set([
        profile.staticContainer,
        ...Array.from({ length: profile.dynamicNodeCount }, (_, index) =>
          index === 0 ? profile.dynamicContainer : `${profile.dynamicContainer}-${index + 1}`),
      ]);
      const items = result.stdout.trim() ? JSON.parse(result.stdout) : [];
      for (const name of spec.args.slice(1)) {
        if (!configured.has(name) || !present.has(name)) continue;
        const item = items.find((value: { Name?: string }) => value.Name === `/${name}`);
        if (item?.Id) continue;
        const Id = present.get(name) ?? `reviewed-${name}-id`;
        if (item) item.Id = Id;
        else items.push({ Name: `/${name}`, Id });
      }
      return { ...result, stdout: JSON.stringify(items) };
    },
  };
}
