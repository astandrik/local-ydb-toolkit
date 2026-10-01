import { bash, shellQuote, type CommandResult, type CommandSpec } from "../api-client.js";
import { attachNotRequiredConfirmation, retireSubmittedConfirmation } from "../confirmation.js";
import { probeDockerRuntime } from "./docker-runtime.js";
import { runMutating } from "./execution.js";
import type {
  CheckPrerequisitesResponse,
  MutatingOptions,
  PrerequisiteCheck,
  ToolkitContext
} from "./types.js";

type InstallTarget = {
  check: string;
  packageName: string;
};

interface PrerequisiteSnapshot {
  checks: PrerequisiteCheck[];
  results: CommandResult[];
  ready: boolean;
  missing: string[];
  unavailable: string[];
  installablePackages: string[];
  packageManager?: string;
  manualActions: string[];
}

const INSTALLABLE_COMMANDS: InstallTarget[] = [
  { check: "curl", packageName: "curl" },
  { check: "ruby", packageName: "ruby" }
];

export async function checkPrerequisites(
  ctx: ToolkitContext,
  options: MutatingOptions = {}
): Promise<CheckPrerequisitesResponse> {
  const initial = await collectPrerequisiteSnapshot(ctx);

  if (initial.installablePackages.length === 0) {
    retireSubmittedConfirmation(ctx, options);
    return attachNotRequiredConfirmation(ctx, snapshotResponse(ctx, initial, {
      summarySuffix: prerequisiteSummarySuffix(options.confirm, initial.installablePackages.length),
      plannedCommands: [],
      rollback: ["No changes."],
      verification: failedCheckVerification(initial.checks)
    }));
  }

  if (initial.packageManager !== "apt-get") {
    retireSubmittedConfirmation(ctx, options);
    return attachNotRequiredConfirmation(ctx, snapshotResponse(ctx, {
      ...initial,
      manualActions: [...initial.manualActions, "Install missing host packages manually on the target machine."]
    }, {
      summarySuffix: ", but no supported package manager was detected for auto-installation.",
      plannedCommands: [],
      rollback: ["No changes."],
      verification: []
    }));
  }

  const installPlan = {
    summary: `Install ${initial.installablePackages.length} prerequisite package(s) for ${ctx.profile.name}.`,
    risk: "high" as const,
    specs: installSpecs(initial.installablePackages),
    rollback: ["Remove installed packages manually if you need to revert host dependencies."],
    verification: initial.installablePackages.map((packageName) => `${packageName} installation completes successfully`)
  };

  const installResponse = await runMutating(ctx, installPlan, options);
  if (!installResponse.executed) {
    return {
      ...installResponse,
      summary: `${installResponse.summary} ${snapshotSummary(ctx, initial)}.`,
      results: initial.results,
      checks: initial.checks,
      ready: initial.ready,
      missing: initial.missing,
      unavailable: initial.unavailable,
      installablePackages: initial.installablePackages,
      packageManager: initial.packageManager,
      manualActions: initial.manualActions,
    };
  }
  const finalSnapshot = await collectPrerequisiteSnapshot(ctx);
  return {
    ...installResponse,
    summary: `${installResponse.summary} ${snapshotSummary(ctx, finalSnapshot)}`,
    results: [...(installResponse.results ?? []), ...finalSnapshot.results],
    checks: finalSnapshot.checks,
    ready: finalSnapshot.ready,
    missing: finalSnapshot.missing,
    unavailable: finalSnapshot.unavailable,
    installablePackages: finalSnapshot.installablePackages,
    packageManager: finalSnapshot.packageManager,
    manualActions: finalSnapshot.manualActions
  };
}

async function collectPrerequisiteSnapshot(ctx: ToolkitContext): Promise<PrerequisiteSnapshot> {
  const docker = await probeDockerRuntime(ctx);
  if (docker.status === "target-unreachable" || docker.status === "probe-failed") {
    return unavailableTargetSnapshot(ctx, docker.results);
  }

  const checks: PrerequisiteCheck[] = [
    {
      name: "docker",
      kind: "command",
      ok: docker.cliAvailable,
      detail: docker.cliAvailable ? "docker is available." : "docker is missing."
    },
    {
      name: "dockerDaemon",
      kind: "service",
      ok: docker.daemonReachable,
      detail: docker.cliAvailable
        ? docker.detail
        : "Docker daemon was not checked because Docker CLI is missing."
    }
  ];
  const results = [...docker.results];

  for (const command of ["curl", "ruby"]) {
    const probe = await runPrerequisiteProbe(
      ctx,
      bash(`command -v ${command} >/dev/null 2>&1`, {
        allowFailure: true,
        description: `Check ${command} availability`
      }),
      `Check ${command} availability`
    );
    results.push(probe.result);
    if (probe.targetUnavailable) {
      return unavailableTargetSnapshot(ctx, results);
    }
    checks.push({
      name: command,
      kind: "command",
      ok: probe.result.ok,
      detail: probe.result.ok ? `${command} is available.` : `${command} is missing.`
    });
  }

  if (ctx.profile.rootPasswordFile) {
    const probe = await runPrerequisiteProbe(
      ctx,
      bash(`[ -f ${shellQuote(ctx.profile.rootPasswordFile)} ]`, {
        allowFailure: true,
        description: "Check root password file presence"
      }),
      "Check root password file presence"
    );
    results.push(probe.result);
    if (probe.targetUnavailable) {
      return unavailableTargetSnapshot(ctx, results);
    }
    checks.push({
      name: "rootPasswordFile",
      kind: "file",
      ok: probe.result.ok,
      detail: probe.result.ok
        ? "The configured root password file exists."
        : "The configured root password file is missing."
    });
  }

  const missing = checks
    .filter((check) => check.kind !== "service" && !check.ok)
    .map((check) => check.name);
  const unavailable = docker.status === "daemon-unavailable" ? ["dockerDaemon"] : [];
  const installablePackages = INSTALLABLE_COMMANDS
    .filter((target) => missing.includes(target.check))
    .map((target) => target.packageName);

  const packageManagerProbe = await runPrerequisiteProbe(
    ctx,
    bash("command -v apt-get >/dev/null 2>&1", {
      allowFailure: true,
      description: "Check apt-get availability"
    }),
    "Check apt-get availability"
  );
  results.push(packageManagerProbe.result);
  if (packageManagerProbe.targetUnavailable) {
    return unavailableTargetSnapshot(ctx, results);
  }

  const manualActions: string[] = [];
  if (missing.includes("docker")) {
    manualActions.push("Install and configure Docker manually; the toolkit does not auto-install Docker.");
  }
  if (unavailable.includes("dockerDaemon")) {
    manualActions.push("Start or configure Docker on the selected target and ensure the current user can access its daemon.");
  }
  if (missing.includes("rootPasswordFile")) {
    manualActions.push("Run local_ydb_prepare_auth_config or point rootPasswordFile at an existing host-side password file.");
  }

  return {
    checks,
    results,
    ready: checks.every((check) => check.ok),
    missing,
    unavailable,
    installablePackages,
    packageManager: packageManagerProbe.result.ok ? "apt-get" : undefined,
    manualActions
  };
}

function unavailableTargetSnapshot(ctx: ToolkitContext, results: CommandResult[]): PrerequisiteSnapshot {
  const checks: PrerequisiteCheck[] = [
    { name: "docker", kind: "command", ok: false, detail: "Docker state was not determined because the selected target is unavailable." },
    { name: "dockerDaemon", kind: "service", ok: false, detail: "Docker daemon state was not determined because the selected target is unavailable." },
    { name: "curl", kind: "command", ok: false, detail: "Not checked because the selected target is unavailable." },
    { name: "ruby", kind: "command", ok: false, detail: "Not checked because the selected target is unavailable." }
  ];
  if (ctx.profile.rootPasswordFile) {
    checks.push({
      name: "rootPasswordFile",
      kind: "file",
      ok: false,
      detail: "Not checked because the selected target is unavailable."
    });
  }
  return {
    checks,
    results,
    ready: false,
    missing: [],
    unavailable: ["target"],
    installablePackages: [],
    packageManager: undefined,
    manualActions: ["Restore access to the selected target, then rerun prerequisite checks."]
  };
}

async function runPrerequisiteProbe(
  ctx: ToolkitContext,
  spec: CommandSpec,
  safeCommand: string
): Promise<{ result: CommandResult; targetUnavailable: boolean }> {
  let result: CommandResult;
  try {
    result = await ctx.client.run(spec);
  } catch {
    return {
      result: failedProbeResult(safeCommand),
      targetUnavailable: true
    };
  }
  const targetUnavailable = result.timedOut
    || (ctx.profile.mode === "ssh" && result.exitCode === 255)
    || (ctx.profile.mode === "ssh" && !result.ok && result.exitCode !== 1);
  return {
    result: safeProbeResult(result, safeCommand),
    targetUnavailable
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

function installSpecs(packages: string[]): CommandSpec[] {
  return [
    bash("sudo -n apt-get update", {
      allowFailure: true,
      timeoutMs: 300_000,
      description: "Update apt package index"
    }),
    bash(`sudo -n apt-get install -y ${packages.join(" ")}`, {
      allowFailure: true,
      timeoutMs: 300_000,
      description: "Install missing prerequisite packages"
    })
  ];
}

function snapshotResponse(
  ctx: ToolkitContext,
  snapshot: PrerequisiteSnapshot,
  plan: {
    summarySuffix: string;
    plannedCommands: string[];
    rollback: string[];
    verification: string[];
  }
): CheckPrerequisitesResponse {
  return {
    summary: `${snapshotSummary(ctx, snapshot)}${plan.summarySuffix}`,
    executed: false,
    risk: "medium",
    plannedCommands: plan.plannedCommands,
    rollback: plan.rollback,
    verification: plan.verification,
    results: snapshot.results,
    checks: snapshot.checks,
    ready: snapshot.ready,
    missing: snapshot.missing,
    unavailable: snapshot.unavailable,
    installablePackages: snapshot.installablePackages,
    packageManager: snapshot.packageManager,
    manualActions: snapshot.manualActions
  };
}

function snapshotSummary(ctx: ToolkitContext, snapshot: PrerequisiteSnapshot): string {
  return `Checked prerequisites for ${ctx.profile.name}. Ready=${snapshot.ready}; missing ${snapshot.missing.length} item(s); unavailable ${snapshot.unavailable.length} item(s)`;
}

function prerequisiteSummarySuffix(confirm: boolean | undefined, installablePackageCount: number): string {
  if (confirm && installablePackageCount === 0) {
    return ". No installable packages were queued.";
  }
  return installablePackageCount > 0 ? "; install plan prepared." : ".";
}

function failedCheckVerification(checks: PrerequisiteCheck[]): string[] {
  const failed = checks.filter((check) => !check.ok);
  return failed.length
    ? failed.map((check) => `${check.name} becomes available`)
    : ["No additional verification needed."];
}
