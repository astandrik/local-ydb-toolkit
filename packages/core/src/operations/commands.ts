import { bash, shellQuote, type CommandSpec } from "../api-client.js";
import type { ResolvedLocalYdbProfile } from "../validation.js";
import { generatedConfigDiscoveryLines } from "./generated-config.js";
import { ensureImagePresentSpec } from "./images.js";
import type { DynamicNodePlan } from "./types.js";

export function commandForStaticRun(
  profile: ResolvedLocalYdbProfile,
  options: { enableGraphShard?: boolean; publishDynamicGrpc?: boolean } = {}
): string {
  const enableGraphShard = options.enableGraphShard ?? true;
  const publishDynamicGrpc = options.publishDynamicGrpc ?? false;
  validatePublishedHostPorts(profile, publishDynamicGrpc);
  const mount = profile.bindMountPath ? `${profile.bindMountPath}:/ydb_data` : `${profile.volume}:/ydb_data`;
  const grpcPortMappings = requiredPublishedGrpcPorts(profile, publishDynamicGrpc)
    .flatMap((port) => ["-p", `127.0.0.1:${port}:${port}`]);
  return [
    "docker", "run", "-d",
    "--name", profile.staticContainer,
    "--no-healthcheck",
    "--network", profile.network,
    "--restart", "unless-stopped",
    ...grpcPortMappings,
    "-p", `127.0.0.1:${profile.ports.monitoring}:8765`,
    "-v", mount,
    "-e", `GRPC_PORT=${profile.ports.staticGrpc}`,
    "-e", "MON_PORT=8765",
    "-e", "GRPC_TLS_PORT=",
    "-e", "YDB_GRPC_ENABLE_TLS=0",
    "-e", "YDB_ANONYMOUS_CREDENTIALS=1",
    "-e", "YDB_LOCAL_SURVIVE_RESTART=1",
    ...(enableGraphShard ? ["-e", "YDB_FEATURE_FLAGS=enable_graph_shard"] : []),
    profile.image
  ].map(shellQuote).join(" ");
}

export function commandForStaticEnsureRun(
  profile: ResolvedLocalYdbProfile,
  options: { enableGraphShard?: boolean; requireGraphShard?: boolean; publishDynamicGrpc?: boolean } = {}
): string {
  const enableGraphShard = options.enableGraphShard ?? true;
  const requireGraphShard = options.requireGraphShard ?? false;
  const publishDynamicGrpc = options.publishDynamicGrpc ?? false;
  validatePublishedHostPorts(profile, publishDynamicGrpc);
  const container = shellQuote(profile.staticContainer);
  const graphShardCheck = `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' ${container} 2>/dev/null | grep -qx 'YDB_FEATURE_FLAGS=enable_graph_shard'`;
  const missingGraphShardHint = [
    `printf '%s\\n' ${shellQuote(`Existing static container ${profile.staticContainer} is missing YDB_FEATURE_FLAGS=enable_graph_shard.`)} >&2`,
    `printf '%s\\n' ${shellQuote(`Recreate it with local_ydb_destroy_stack or docker rm -f ${profile.staticContainer}, then rerun local_ydb_bootstrap.`)} >&2`
  ];
  const requireGraphShardLines = requireGraphShard
    ? [
        `  if ! ${graphShardCheck}; then`,
        ...missingGraphShardHint.map((line) => `    ${line}`),
        "    exit 1",
        "  fi"
      ]
    : [];
  const requirePublishedGrpcLines = requiredPublishedGrpcPorts(profile, publishDynamicGrpc)
    .flatMap((port) => [
      `  if ! docker port ${container} ${shellQuote(`${port}/tcp`)} 2>/dev/null | grep -qx ${shellQuote(`127.0.0.1:${port}`)}; then`,
      `    printf '%s\\n' ${shellQuote(`Existing static container ${profile.staticContainer} does not publish required gRPC port 127.0.0.1:${port}.`)} >&2`,
      `    printf '%s\\n' ${shellQuote(`Recreate it with local_ydb_destroy_stack or docker rm -f ${profile.staticContainer}, then rerun local_ydb_bootstrap.`)} >&2`,
      "    exit 1",
      "  fi"
    ]);

  return [
    "set -euo pipefail",
    `if docker inspect -f '{{.State.Running}}' ${container} 2>/dev/null | grep -qx true; then`,
    ...requireGraphShardLines,
    ...requirePublishedGrpcLines,
    "  exit 0",
    "fi",
    `if docker inspect ${container} >/dev/null 2>&1; then`,
    ...requireGraphShardLines,
    ...requirePublishedGrpcLines,
    `  docker start ${container} >/dev/null`,
    "  exit 0",
    "fi",
    commandForStaticRun(profile, { enableGraphShard, publishDynamicGrpc })
  ].join("\n");
}

function requiredPublishedGrpcPorts(profile: ResolvedLocalYdbProfile, publishDynamicGrpc: boolean): number[] {
  return [
    profile.ports.staticGrpc,
    ...(publishDynamicGrpc && profile.ports.dynamicGrpc !== profile.ports.staticGrpc ? [profile.ports.dynamicGrpc] : [])
  ];
}

function validatePublishedHostPorts(profile: ResolvedLocalYdbProfile, publishDynamicGrpc: boolean): void {
  const bindings = [
    { name: "staticGrpc", port: profile.ports.staticGrpc },
    ...(publishDynamicGrpc && profile.ports.dynamicGrpc !== profile.ports.staticGrpc
      ? [{ name: "dynamicGrpc", port: profile.ports.dynamicGrpc }]
      : []),
    { name: "monitoring", port: profile.ports.monitoring }
  ];
  const seen = new Map<number, string>();
  for (const binding of bindings) {
    const existing = seen.get(binding.port);
    if (existing) {
      throw new Error(`Profile ${profile.name} maps both ${existing} and ${binding.name} to host port ${binding.port}; published host ports must be unique.`);
    }
    seen.set(binding.port, binding.name);
  }
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
    ...generatedConfigDiscoveryLines("source_config"),
    "sed -e '/^  ca: \\/ydb_certs\\/ca\\.pem$/d' -e '/^  cert: \\/ydb_certs\\/cert\\.pem$/d' -e '/^  key: \\/ydb_certs\\/key\\.pem$/d' \"$source_config\" > \"$cfg\"",
    `exec /ydbd server --yaml-config "$cfg" ${dynamicArgs}`
  ].join("\n");
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
    ensureImagePresentSpec(profile.image),
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
  const retryableStatusErrors = "SCHEME_ERROR|No database found|connection refused|Endpoint list is empty|Could not resolve redirected path|Failed to connect|TRANSPORT_UNAVAILABLE";
  const retryableCreateErrors = "Group fit error|failed to allocate group|no group options";
  const failWithStatusOutput = [
    "    cat \"$tmp\" >&2",
    "    if [ \"$status_rc\" -eq 0 ]; then",
    "      exit 1",
    "    fi",
    "    exit \"$status_rc\""
  ];
  return bash([
    "set -euo pipefail",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT",
    "for attempt in $(seq 1 30); do",
    "  status_rc=0",
    `  ${statusCommand} >"$tmp" 2>&1 || status_rc=$?`,
    "  if grep -Eq 'State:[[:space:]]*(RUNNING|PENDING_RESOURCES)' \"$tmp\"; then",
    "    cat \"$tmp\"",
    "    exit 0",
    "  elif grep -Eq 'Unknown tenant|NOT_FOUND' \"$tmp\"; then",
    "    create_rc=0",
    `    ${createCommand} >"$tmp" 2>&1 || create_rc=$?`,
    `    if grep -Eiq '${retryableCreateErrors}' "$tmp"; then`,
    "      cat \"$tmp\" >&2",
    "      sleep 2",
    "    elif [ \"$create_rc\" -ne 0 ]; then",
    "      cat \"$tmp\" >&2",
    "      exit \"$create_rc\"",
    "    else",
    "      sleep 2",
    "    fi",
    `  elif grep -Eq '${retryableStatusErrors}' "$tmp"; then`,
    "    sleep 2",
    "  else",
    ...failWithStatusOutput,
    "  fi",
    "done",
    "cat \"$tmp\" >&2",
    "exit 1"
  ].join("\n"), {
    timeoutMs: 120_000,
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

export function ydbRootCli(profile: ResolvedLocalYdbProfile, args: string[], description: string): CommandSpec {
  const endpoint = `grpc://localhost:${profile.ports.staticGrpc}`;
  if (profile.rootPasswordFile) {
    return passwordPipedDockerExec(profile, `/ydb -e ${shellQuote(endpoint)} -d ${shellQuote(profile.rootDatabase)} --user ${shellQuote(profile.rootUser)} --password-file /tmp/root.password ${args.map(shellQuote).join(" ")}`, description);
  }
  return {
    command: "docker",
    args: ["exec", profile.staticContainer, "/ydb", "-e", endpoint, "-d", profile.rootDatabase, ...args],
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
