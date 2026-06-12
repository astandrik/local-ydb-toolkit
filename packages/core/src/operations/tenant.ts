import { bash, shellQuote } from "../api-client.js";
import { createTenantSpec, helperContainer, ydbAuthArgs, ydbCli } from "./commands.js";
import { planOnly, runMutating } from "./execution.js";
import type {
  DumpTenantOptions,
  DumpTenantResponse,
  ListDumpsResponse,
  MutatingOptions,
  RestoreTenantOptions,
  RestoreTenantResponse,
  RestoreVerificationHook,
  ToolkitContext
} from "./types.js";

const SYSTEM_PATH_EXCLUDE_PATTERN = "(^|/)\\.sys(/|$)";
const DEFAULT_YDB_DUMP_PATH = ".";
const MAX_COUNT_QUERY_BYTES = 4096;

export async function createTenant(ctx: ToolkitContext, options: MutatingOptions = {}) {
  return runMutating(ctx, {
    summary: `Create CMS tenant ${ctx.profile.tenantPath}.`,
    risk: "medium",
    specs: [createTenantSpec(ctx.profile)],
    rollback: [`/ydbd --server localhost:${ctx.profile.ports.staticGrpc} admin database ${ctx.profile.tenantPath} remove --force`],
    verification: [`admin database ${ctx.profile.tenantPath} status`, `scheme ls ${ctx.profile.tenantPath}`]
  }, options);
}

export async function listDumps(ctx: ToolkitContext): Promise<ListDumpsResponse> {
  const dumpHostPath = ctx.profile.dumpHostPath;
  const spec = bash([
    `if [ -d ${shellQuote(dumpHostPath)} ]; then`,
    `  for dir in ${shellQuote(dumpHostPath)}/*; do`,
    "    [ -d \"$dir/tenant\" ] && basename \"$dir\"",
    "  done | sort",
    "fi"
  ].join("\n"), {
    allowFailure: true,
    description: "List local-ydb dumps"
  });
  const result = await ctx.client.run(spec);
  const dumps = result.ok
    ? parseDumpNames(result.stdout).map((name) => ({
        name,
        hostPath: `${dumpHostPath}/${name}`,
        tenantDumpPath: `${dumpHostPath}/${name}/tenant`
      }))
    : [];
  return {
    summary: result.ok
      ? `Found ${dumps.length} dump${dumps.length === 1 ? "" : "s"} under ${dumpHostPath}.`
      : `Could not list dumps under ${dumpHostPath}.`,
    ok: result.ok,
    command: result.command,
    dumpHostPath,
    dumps,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

export async function dumpTenant(ctx: ToolkitContext, options: DumpTenantOptions = {}): Promise<DumpTenantResponse> {
  const dumpName = normalizeDumpName(options.dumpName ?? defaultDumpName(ctx));
  const path = normalizeYdbRelativePath(options.path ?? DEFAULT_YDB_DUMP_PATH);
  const sourcePath = resolveTenantRelativePath(ctx.profile.tenantPath, path);
  const dumpPath = `${ctx.profile.dumpHostPath}/${dumpName}`;
  const specs = [
    bash(`mkdir -p ${shellQuote(dumpPath)}`),
    helperContainer(ctx.profile, `/ydb -e grpc://localhost:${ctx.profile.ports.dynamicGrpc} -d ${shellQuote(ctx.profile.tenantPath)} ${ydbAuthArgs(ctx.profile)} tools dump -p ${shellQuote(path)} --exclude ${shellQuote(SYSTEM_PATH_EXCLUDE_PATTERN)} -o ${shellQuote(`/dump/${dumpName}/tenant`)}`)
  ];
  const response = await runMutating(ctx, {
    summary: `Dump ${sourcePath} to ${dumpPath}.`,
    risk: "medium",
    specs,
    rollback: [`rm -rf ${dumpPath}`],
    verification: [`test -d ${dumpPath}/tenant`]
  }, options);
  return {
    ...response,
    dumpName,
    path,
    sourcePath,
    dumpPath
  };
}

export async function restoreTenant(ctx: ToolkitContext, options: RestoreTenantOptions = {}): Promise<RestoreTenantResponse> {
  if (!options.dumpName) {
    return {
      ...planOnly(ctx, "Restore requires dumpName.", "high", [], ["No changes."], ["Provide dumpName and rerun."]),
      verificationHooks: []
    };
  }
  const dumpName = normalizeDumpName(options.dumpName);
  const path = normalizeYdbRelativePath(options.path ?? DEFAULT_YDB_DUMP_PATH);
  const targetPath = resolveTenantRelativePath(ctx.profile.tenantPath, path);
  const verificationHooks = restoreVerificationHooks(ctx, options);
  const response = await runMutating(ctx, {
    summary: `Restore ${targetPath} from ${ctx.profile.dumpHostPath}/${dumpName}.`,
    risk: "high",
    specs: [
      helperContainer(ctx.profile, `/ydb -e grpc://localhost:${ctx.profile.ports.dynamicGrpc} -d ${shellQuote(ctx.profile.tenantPath)} ${ydbAuthArgs(ctx.profile)} tools restore -p ${shellQuote(path)} -i ${shellQuote(`/dump/${dumpName}/tenant`)}`),
      ...verificationHooks.map((hook) => hook.spec)
    ],
    rollback: ["Restore from a previous dump or restart the previous volume/container set."],
    verification: [
      `scheme ls ${ctx.profile.tenantPath}`,
      "small table reads succeed",
      ...verificationHooks.map((hook) => hook.description)
    ]
  }, options);
  return {
    ...response,
    dumpName,
    path,
    targetPath,
    verificationHooks: verificationHooks.map((hook) => {
      if (hook.type === "schemeDescribe") {
        return { type: hook.type, path: hook.path, resolvedPath: hook.resolvedPath };
      }
      return { type: hook.type, label: hook.label, query: hook.query };
    })
  };
}

function defaultDumpName(ctx: ToolkitContext): string {
  return `${ctx.profile.tenantPath.split("/").pop() ?? "tenant"}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function parseDumpNames(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((name, index, names) => names.indexOf(name) === index);
}

function normalizeDumpName(value: string): string {
  const dumpName = value.trim();
  if (
    !dumpName ||
    dumpName === "." ||
    dumpName === ".." ||
    dumpName.includes("/") ||
    dumpName.includes("\\") ||
    /[\x00-\x1F\x7F]/.test(dumpName)
  ) {
    throw new Error("dumpName must be a single directory name under profile.dumpHostPath");
  }
  return dumpName;
}

function normalizeYdbRelativePath(value: string, fieldName = "path"): string {
  const path = value.trim();
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\x00-\x1F\x7F]/.test(path)
  ) {
    throw new Error(`${fieldName} must be . or a relative YDB path`);
  }
  if (path === ".") {
    return path;
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${fieldName} must be . or a relative YDB path`);
  }
  return parts.join("/");
}

function resolveTenantRelativePath(tenantPath: string, path: string): string {
  return path === "." ? tenantPath : `${tenantPath}/${path}`;
}

function restoreVerificationHooks(
  ctx: ToolkitContext,
  options: Pick<RestoreTenantOptions, "describePaths" | "countQueries">
): Array<RestoreVerificationHook & { spec: ReturnType<typeof ydbCli>; description: string }> {
  const describeHooks = (options.describePaths ?? []).map((path) => {
    const normalizedPath = normalizeYdbRelativePath(path, "describePaths[]");
    const resolvedPath = resolveTenantRelativePath(ctx.profile.tenantPath, normalizedPath);
    return {
      type: "schemeDescribe" as const,
      path: normalizedPath,
      resolvedPath,
      spec: ydbCli(ctx.profile, ["scheme", "describe", resolvedPath], ctx.profile.tenantPath, `Verify restored path ${resolvedPath}`),
      description: `scheme describe ${resolvedPath}`
    };
  });

  const countHooks = (options.countQueries ?? []).map((item, index) => {
    const query = normalizeCountQuery(item.query);
    const label = item.label?.trim() || `count query ${index + 1}`;
    return {
      type: "countQuery" as const,
      label,
      query,
      spec: ydbCli(ctx.profile, ["sql", "-s", query], ctx.profile.tenantPath, `Verify restored row count: ${label}`),
      description: `bounded count query ${label}`
    };
  });

  return [...describeHooks, ...countHooks];
}

function normalizeCountQuery(value: string): string {
  const query = value.trim();
  if (!query || Buffer.byteLength(query, "utf8") > MAX_COUNT_QUERY_BYTES) {
    throw new Error(`countQueries[].query must be non-empty and at most ${MAX_COUNT_QUERY_BYTES} bytes`);
  }
  const withoutTrailingSemicolon = query.endsWith(";") ? query.slice(0, -1) : query;
  if (withoutTrailingSemicolon.includes(";")) {
    throw new Error("countQueries[].query must contain a single SELECT COUNT statement");
  }
  if (!/^select\s+count\s*\([^)]{1,256}\)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*|\s+[A-Za-z_][A-Za-z0-9_]*)?\s+from\b/i.test(withoutTrailingSemicolon)) {
    throw new Error("countQueries[].query must start with SELECT COUNT(...) and include FROM");
  }
  return query;
}
