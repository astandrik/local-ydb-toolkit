import { bash, shellQuote, type CommandSpec } from "../api-client.js";
import type { ResolvedLocalYdbProfile } from "../validation.js";
import type { DynamicNodePlan } from "./types.js";

export function commandForStaticRun(profile: ResolvedLocalYdbProfile): string {
  const mount = profile.bindMountPath ? `${profile.bindMountPath}:/ydb_data` : `${profile.volume}:/ydb_data`;
  return [
    "docker", "run", "-d",
    "--name", profile.staticContainer,
    "--no-healthcheck",
    "--network", profile.network,
    "--restart", "unless-stopped",
    "-p", `127.0.0.1:${profile.ports.monitoring}:8765`,
    "-v", mount,
    "-e", `GRPC_PORT=${profile.ports.staticGrpc}`,
    "-e", "MON_PORT=8765",
    "-e", "GRPC_TLS_PORT=",
    "-e", "YDB_GRPC_ENABLE_TLS=0",
    "-e", "YDB_ANONYMOUS_CREDENTIALS=1",
    "-e", "YDB_LOCAL_SURVIVE_RESTART=1",
    "-e", "YDB_FEATURE_FLAGS=enable_graph_shard",
    profile.image
  ].map(shellQuote).join(" ");
}

export function commandForDynamicRun(profile: ResolvedLocalYdbProfile): string {
  return commandForDynamicNodeRun(profile, {
    container: profile.dynamicContainer,
    grpcPort: profile.ports.dynamicGrpc,
    monitoringPort: profile.ports.dynamicMonitoring,
    icPort: profile.ports.dynamicIc
  });
}

export function commandForDynamicNodeRun(profile: ResolvedLocalYdbProfile, node: Pick<DynamicNodePlan, "container" | "grpcPort" | "monitoringPort" | "icPort">): string {
  const mount = profile.bindMountPath ? `${profile.bindMountPath}:/ydb_data:ro` : `${profile.volume}:/ydb_data:ro`;
  const authMount = profile.dynamicNodeAuthTokenFile ? [`${profile.dynamicNodeAuthTokenFile}:/run/local-ydb/dynamic-node-auth.pb:ro`] : [];
  const authArgs = profile.dynamicNodeAuthTokenFile ? ["--auth-token-file", "/run/local-ydb/dynamic-node-auth.pb"] : [];
  const dynamicArgs = [
    "--tcp",
    ...authArgs,
    "--node-broker", `grpc://127.0.0.1:${profile.ports.staticGrpc}`,
    "--grpc-port", String(node.grpcPort),
    "--mon-port", String(node.monitoringPort),
    "--ic-port", String(node.icPort),
    "--tenant", profile.tenantPath,
    "--node-host", "127.0.0.1",
    "--node-address", "127.0.0.1",
    "--node-resolve-host", "127.0.0.1",
    "--node-domain", "local"
  ].map(shellQuote).join(" ");
  const innerCommand = [
    "set -euo pipefail",
    "cfg=/tmp/local-ydb-dynamic-config.yaml",
    "sed -e '/^  ca: \\/ydb_certs\\/ca\\.pem$/d' -e '/^  cert: \\/ydb_certs\\/cert\\.pem$/d' -e '/^  key: \\/ydb_certs\\/key\\.pem$/d' /ydb_data/cluster/kikimr_configs/config.yaml > \"$cfg\"",
    `exec /ydbd server --yaml-config "$cfg" ${dynamicArgs}`
  ].join("; ");
  return [
    "docker", "run", "-d",
    "--name", node.container,
    "--no-healthcheck",
    "--network", `container:${profile.staticContainer}`,
    "--restart", "unless-stopped",
    "-v", mount,
    "-e", `GRPC_PORT=${node.grpcPort}`,
    "-e", `MON_PORT=${node.monitoringPort}`,
    "-e", "GRPC_TLS_PORT=",
    "-e", "YDB_GRPC_ENABLE_TLS=0",
    ...authMount.flatMap((value) => ["-v", value]),
    "--entrypoint", "/bin/bash",
    profile.image,
    "-lc", innerCommand
  ].map(shellQuote).join(" ");
}

export function commandForDynamicEnsureRun(profile: ResolvedLocalYdbProfile, node?: Pick<DynamicNodePlan, "container" | "grpcPort" | "monitoringPort" | "icPort">): string {
  const target = node ?? {
    container: profile.dynamicContainer,
    grpcPort: profile.ports.dynamicGrpc,
    monitoringPort: profile.ports.dynamicMonitoring,
    icPort: profile.ports.dynamicIc
  };
  const container = shellQuote(target.container);
  return [
    `if docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null | grep -qx true; then`,
    "  exit 0",
    "fi",
    `docker rm -f ${container} 2>/dev/null || true`,
    commandForDynamicNodeRun(profile, target)
  ].join("\n");
}

export function dynamicNodeStartSpecs(profile: ResolvedLocalYdbProfile, plan: DynamicNodePlan): CommandSpec[] {
  return [
    bash(commandForDynamicEnsureRun(profile, plan), {
      timeoutMs: 60_000,
      description: `Start dynamic tenant node ${plan.container}`
    }),
    bash("sleep 5", { description: `Wait briefly for ${plan.container} startup` })
  ];
}

export function removeTenantIfPresentSpec(profile: ResolvedLocalYdbProfile): CommandSpec {
  const removeCommand = dockerExecYdbd(profile, ["admin", "database", profile.tenantPath, "remove", "--force"]);
  return bash([
    "set -euo pipefail",
    `if ! docker inspect -f '{{.State.Running}}' ${shellQuote(profile.staticContainer)} 2>/dev/null | grep -qx true; then`,
    "  exit 0",
    "fi",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT",
    `if ${removeCommand} >"$tmp" 2>&1; then`,
    "  cat \"$tmp\"",
    "  exit 0",
    "elif grep -Eq 'Unknown tenant|NOT_FOUND|not found|Path does not exist' \"$tmp\"; then",
    "  cat \"$tmp\"",
    "  exit 0",
    "else",
    "  cat \"$tmp\" >&2",
    "  exit 1",
    "fi"
  ].join("\n"), {
    timeoutMs: 60_000,
    allowFailure: true,
    description: `Remove tenant ${profile.tenantPath} if present`
  });
}

export function createTenantSpec(profile: ResolvedLocalYdbProfile): CommandSpec {
  const statusArgs = ["admin", "database", profile.tenantPath, "status"];
  const createArgs = ["admin", "database", profile.tenantPath, "create", `${profile.storagePoolKind}:${profile.storagePoolCount}`];
  const statusCommand = dockerExecYdbd(profile, statusArgs);
  const createCommand = dockerExecYdbd(profile, createArgs);
  return bash([
    "set -euo pipefail",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT",
    "for attempt in $(seq 1 15); do",
    `  if ${statusCommand} >"$tmp" 2>&1; then`,
    "    cat \"$tmp\"",
    "    exit 0",
    "  elif grep -Eq 'State:[[:space:]]*(RUNNING|PENDING_RESOURCES)' \"$tmp\"; then",
    "    cat \"$tmp\"",
    "    exit 0",
    "  elif grep -Eq 'Unknown tenant|NOT_FOUND' \"$tmp\"; then",
    `    ${createCommand} >/dev/null 2>&1 || exit $?`,
    "  else",
    "    cat \"$tmp\" >&2",
    "    exit 1",
    "  fi",
    "  sleep 2",
    "done",
    "cat \"$tmp\" >&2",
    "exit 1"
  ].join("\n"), {
    timeoutMs: 60_000,
    description: "Create CMS tenant if missing"
  });
}

export function ydbCli(profile: ResolvedLocalYdbProfile, args: string[], database: string, description: string): CommandSpec {
  if (profile.rootPasswordFile) {
    return passwordPipedDockerExec(profile, `/ydb -e grpc://localhost:${profile.ports.dynamicGrpc} -d ${shellQuote(database)} --user ${shellQuote(profile.rootUser)} --password-file /tmp/root.password ${args.map(shellQuote).join(" ")}`, description);
  }
  return {
    command: "docker",
    args: ["exec", profile.staticContainer, "/ydb", "-e", `grpc://localhost:${profile.ports.dynamicGrpc}`, "-d", database, ...args],
    allowFailure: true,
    description
  };
}

export function ydbdAdmin(profile: ResolvedLocalYdbProfile, args: string[], description: string): CommandSpec {
  if (profile.rootPasswordFile) {
    return passwordPipedDockerExec(profile, `/ydbd --server localhost:${profile.ports.staticGrpc} --user ${shellQuote(profile.rootUser)} --password-file /tmp/root.password ${args.map(shellQuote).join(" ")}`, description);
  }
  return {
    command: "docker",
    args: ["exec", profile.staticContainer, "/ydbd", "--server", `localhost:${profile.ports.staticGrpc}`, "--no-password", ...args],
    allowFailure: true,
    description
  };
}

function dockerExecYdbd(profile: ResolvedLocalYdbProfile, args: string[]): string {
  if (profile.rootPasswordFile) {
    return commandForPasswordPipedDockerExec(profile, `/ydbd --server localhost:${profile.ports.staticGrpc} --user ${shellQuote(profile.rootUser)} --password-file /tmp/root.password ${args.map(shellQuote).join(" ")}`);
  }
  return ["docker", "exec", profile.staticContainer, "/ydbd", "--server", `localhost:${profile.ports.staticGrpc}`, "--no-password", ...args].map(shellQuote).join(" ");
}

function passwordPipedDockerExec(profile: ResolvedLocalYdbProfile, innerCommand: string, description: string): CommandSpec {
  return bash(commandForPasswordPipedDockerExec(profile, innerCommand), {
    allowFailure: true,
    description,
    redactions: [profile.rootPasswordFile ?? ""]
  });
}

function commandForPasswordPipedDockerExec(profile: ResolvedLocalYdbProfile, innerCommand: string): string {
  if (!profile.rootPasswordFile) {
    throw new Error("rootPasswordFile is required");
  }
  const script = `umask 077; cat >/tmp/root.password; ${innerCommand}; rc=$?; rm -f /tmp/root.password; exit $rc`;
  return `cat ${shellQuote(profile.rootPasswordFile)} | docker exec -i ${shellQuote(profile.staticContainer)} bash -lc ${shellQuote(script)}`;
}

export function helperContainer(profile: ResolvedLocalYdbProfile, innerCommand: string): CommandSpec {
  const passwordMount = profile.rootPasswordFile ? ["-v", `${profile.rootPasswordFile}:/tmp/root.password:ro`] : [];
  return bash([
    [
      "docker", "run", "--rm",
      "--network", `container:${profile.staticContainer}`,
      "-v", `${profile.dumpHostPath}:/dump`,
      ...passwordMount,
      "--entrypoint", "/bin/bash",
      profile.image,
      "-lc",
      innerCommand
    ].map(shellQuote).join(" ")
  ].join("\n"), {
    timeoutMs: 300_000,
    redactions: [profile.rootPasswordFile ?? ""]
  });
}

export function ydbAuthArgs(profile: ResolvedLocalYdbProfile): string {
  return profile.rootPasswordFile ? `--user ${shellQuote(profile.rootUser)} --password-file /tmp/root.password` : "";
}
