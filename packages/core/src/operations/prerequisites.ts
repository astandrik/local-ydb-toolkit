import { bash, shellQuote, type CommandResult } from "../api-client.js";
import { probeDockerRuntime } from "./docker-runtime.js";
import { runMutating } from "./execution.js";
import type {
  CheckPrerequisitesResponse,
  PrerequisiteCheck,
  ToolkitContext
} from "./types.js";

type InstallTarget = {
  check: string;
  packageName: string;
};

const INSTALLABLE_COMMANDS: InstallTarget[] = [
  { check: "curl", packageName: "curl" },
  { check: "ruby", packageName: "ruby" }
];

export async function checkPrerequisites(
  ctx: ToolkitContext,
  options: { confirm?: boolean } = {}
): Promise<CheckPrerequisitesResponse> {
  const checks: PrerequisiteCheck[] = [];
  const results: CommandResult[] = [];

  const docker = await probeDockerRuntime(ctx);
  results.push(...docker.results);
  checks.push({
    name: "docker",
    kind: "command",
    ok: docker.cliAvailable,
    detail: docker.cliAvailable ? "docker is available." : "docker is missing."
  });
  checks.push({
    name: "dockerDaemon",
    kind: "service",
    ok: docker.daemonReachable,
    detail: docker.cliAvailable
      ? docker.detail
      : "Docker daemon was not checked because Docker CLI is missing."
  });

  for (const command of ["curl", "ruby"]) {
    const result = await ctx.client.run(bash(`command -v ${command} >/dev/null 2>&1`, {
      allowFailure: true,
      description: `Check ${command} availability`
    }));
    results.push(result);
    checks.push({
      name: command,
      kind: "command",
      ok: result.ok,
      detail: result.ok ? `${command} is available.` : `${command} is missing.`
    });
  }

  if (ctx.profile.rootPasswordFile) {
    const result = await ctx.client.run(bash(`[ -f ${shellQuote(ctx.profile.rootPasswordFile)} ]`, {
      allowFailure: true,
      description: `Check ${ctx.profile.rootPasswordFile} presence`
    }));
    results.push(result);
    checks.push({
      name: "rootPasswordFile",
      kind: "file",
      ok: result.ok,
      detail: result.ok
        ? `${ctx.profile.rootPasswordFile} exists.`
        : `${ctx.profile.rootPasswordFile} is missing.`
    });
  }

  const missing = checks
    .filter((check) => check.kind !== "service" && !check.ok)
    .map((check) => check.name);
  const unavailable = docker.cliAvailable && !docker.daemonReachable ? ["dockerDaemon"] : [];
  const ready = checks.every((check) => check.ok);
  const installablePackages = INSTALLABLE_COMMANDS
    .filter((target) => missing.includes(target.check))
    .map((target) => target.packageName);

  const packageManagerResult = await ctx.client.run(bash("command -v apt-get >/dev/null 2>&1", {
    allowFailure: true,
    description: "Check apt-get availability"
  }));
  results.push(packageManagerResult);
  const packageManager = packageManagerResult.ok ? "apt-get" : undefined;

  const manualActions = [];
  if (missing.includes("docker")) {
    manualActions.push("Install and configure Docker manually; the toolkit does not auto-install Docker.");
  }
  if (unavailable.includes("dockerDaemon")) {
    manualActions.push("Start or configure Docker on the selected target and ensure the current user can access its daemon.");
  }
  if (missing.includes("rootPasswordFile")) {
    manualActions.push("Run local_ydb_prepare_auth_config or point rootPasswordFile at an existing host-side password file.");
  }

  if (!options.confirm || installablePackages.length === 0) {
    return {
      summary: `Checked prerequisites for ${ctx.profile.name}. Ready=${ready}; missing ${missing.length} item(s); unavailable ${unavailable.length} item(s)${installablePackages.length ? "; install plan prepared." : "."}${options.confirm && installablePackages.length === 0 ? " No installable packages were queued." : ""}`,
      executed: false,
      risk: "medium",
      plannedCommands: installablePackages.length && packageManager === "apt-get"
        ? [
            ctx.client.display(bash("sudo -n apt-get update", { allowFailure: true, description: "Update apt package index" })),
            ctx.client.display(bash(`sudo -n apt-get install -y ${installablePackages.join(" ")}`, { allowFailure: true, description: "Install missing prerequisite packages" }))
          ]
        : [],
      rollback: installablePackages.length ? ["Remove installed packages manually if you need to revert host dependencies."] : ["No changes."],
      verification: checks.filter((check) => !check.ok).length
        ? checks.filter((check) => !check.ok).map((check) => `${check.name} becomes available`)
        : ["No additional verification needed."],
      results,
      checks,
      ready,
      missing,
      unavailable,
      installablePackages,
      packageManager,
      manualActions
    };
  }

  if (packageManager !== "apt-get") {
    return {
      summary: `Checked prerequisites for ${ctx.profile.name}. Ready=${ready}; missing ${missing.length} item(s); unavailable ${unavailable.length} item(s), but no supported package manager was detected for auto-installation.`,
      executed: false,
      risk: "medium",
      plannedCommands: [],
      rollback: ["No changes."],
      verification: [],
      results,
      checks,
      ready,
      missing,
      unavailable,
      installablePackages,
      packageManager,
      manualActions: [...manualActions, "Install missing host packages manually on the target machine."]
    };
  }

  const installPlan = {
    summary: `Install ${installablePackages.length} prerequisite package(s) for ${ctx.profile.name}.`,
    risk: "high" as const,
    specs: [
      bash("sudo -n apt-get update", {
        allowFailure: true,
        timeoutMs: 300_000,
        description: "Update apt package index"
      }),
      bash(`sudo -n apt-get install -y ${installablePackages.join(" ")}`, {
        allowFailure: true,
        timeoutMs: 300_000,
        description: "Install missing prerequisite packages"
      })
    ],
    rollback: ["Remove installed packages manually if you need to revert host dependencies."],
    verification: installablePackages.map((packageName) => `${packageName} installation completes successfully`)
  };

  const installResponse = await runMutating(ctx, installPlan, { confirm: true });
  return {
    ...installResponse,
    checks,
    ready,
    missing,
    unavailable,
    installablePackages,
    packageManager,
    manualActions
  };
}
