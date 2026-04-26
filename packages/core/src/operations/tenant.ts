import { bash, shellQuote } from "../api-client.js";
import { createTenantSpec, helperContainer, ydbAuthArgs } from "./commands.js";
import { planOnly, runMutating } from "./execution.js";
import type { MutatingOptions, ToolkitContext } from "./types.js";

export async function createTenant(ctx: ToolkitContext, options: MutatingOptions = {}) {
  return runMutating(ctx, {
    summary: `Create CMS tenant ${ctx.profile.tenantPath}.`,
    risk: "medium",
    specs: [createTenantSpec(ctx.profile)],
    rollback: [`/ydbd --server localhost:${ctx.profile.ports.staticGrpc} admin database ${ctx.profile.tenantPath} remove --force`],
    verification: [`admin database ${ctx.profile.tenantPath} status`, `scheme ls ${ctx.profile.tenantPath}`]
  }, options);
}

export async function dumpTenant(ctx: ToolkitContext, options: MutatingOptions & { dumpName?: string } = {}) {
  const dumpName = options.dumpName ?? `${ctx.profile.tenantPath.split("/").pop() ?? "tenant"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dumpPath = `${ctx.profile.dumpHostPath}/${dumpName}`;
  const specs = [
    bash(`mkdir -p ${shellQuote(dumpPath)}`),
    helperContainer(ctx.profile, `/ydb -e grpc://localhost:${ctx.profile.ports.dynamicGrpc} -d ${shellQuote(ctx.profile.tenantPath)} ${ydbAuthArgs(ctx.profile)} tools dump -p . -o ${shellQuote(`/dump/${dumpName}/tenant`)}`)
  ];
  return runMutating(ctx, {
    summary: `Dump ${ctx.profile.tenantPath} to ${dumpPath}.`,
    risk: "medium",
    specs,
    rollback: [`rm -rf ${dumpPath}`],
    verification: [`test -d ${dumpPath}/tenant`]
  }, options);
}

export async function restoreTenant(ctx: ToolkitContext, options: MutatingOptions & { dumpName?: string } = {}) {
  if (!options.dumpName) {
    return planOnly(ctx, "Restore requires dumpName.", "high", [], ["No changes."], ["Provide dumpName and rerun."]);
  }
  return runMutating(ctx, {
    summary: `Restore ${ctx.profile.tenantPath} from ${ctx.profile.dumpHostPath}/${options.dumpName}.`,
    risk: "high",
    specs: [
      helperContainer(ctx.profile, `/ydb -e grpc://localhost:${ctx.profile.ports.dynamicGrpc} -d ${shellQuote(ctx.profile.tenantPath)} ${ydbAuthArgs(ctx.profile)} tools restore -p . -i ${shellQuote(`/dump/${options.dumpName}/tenant`)}`)
    ],
    rollback: ["Restore from a previous dump or restart the previous volume/container set."],
    verification: [`scheme ls ${ctx.profile.tenantPath}`, "small table reads succeed"]
  }, options);
}
