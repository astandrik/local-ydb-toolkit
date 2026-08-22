import { bash, shellQuote, type CommandSpec } from "../api-client.js";
import type { ResolvedLocalYdbProfile } from "../validation.js";
import { generatedConfigDiscoveryLines } from "./generated-config.js";
import { statusCommandFailureLines } from "./helpers.js";
import { ensureImagePresentSpec } from "./images.js";
import type { DynamicNodePlan } from "./types.js";

const YDB_CLI_RETRYABLE_ERRORS = "CLIENT_UNAUTHENTICATED|SCHEME_ERROR|No database found|connection refused|Endpoint list is empty|Could not resolve redirected path|Failed to connect|TRANSPORT_UNAVAILABLE|Status:[[:space:]]*UNAVAILABLE";

interface StaticCompatibilityOptions {
  requireGraphShard?: boolean;
  publishedDynamicGrpcPorts?: readonly number[];
}

interface StaticEnsureOptions extends StaticCompatibilityOptions {
  enableGraphShard?: boolean;
}

export function commandForStaticRun(
  profile: ResolvedLocalYdbProfile,
  options: { enableGraphShard?: boolean; publishedDynamicGrpcPorts?: readonly number[] } = {}
): string {
  const enableGraphShard = options.enableGraphShard ?? true;
  const publishedDynamicGrpcPorts = options.publishedDynamicGrpcPorts ?? [];
  validatePublishedHostPorts(profile, publishedDynamicGrpcPorts);
  const mount = profile.bindMountPath ? `${profile.bindMountPath}:/ydb_data` : `${profile.volume}:/ydb_data`;
  const grpcPortMappings = requiredPublishedGrpcPorts(profile, publishedDynamicGrpcPorts)
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
  options: StaticEnsureOptions = {}
): string {
  return commandForStaticContainer(profile, { ...options, mode: "ensure" });
}

export function commandForStaticCompatibilityCheck(
  profile: ResolvedLocalYdbProfile,
  options: StaticCompatibilityOptions = {}
): string {
  return commandForStaticContainer(profile, { ...options, mode: "check" });
}

function commandForStaticContainer(
  profile: ResolvedLocalYdbProfile,
  options: StaticEnsureOptions & { mode: "ensure" | "check" }
): string {
  const enableGraphShard = options.enableGraphShard ?? true;
  const checkOnly = options.mode === "check";
  const requireGraphShard = options.requireGraphShard ?? false;
  const publishedDynamicGrpcPorts = options.publishedDynamicGrpcPorts ?? [];
  validatePublishedHostPorts(profile, publishedDynamicGrpcPorts);
  const container = shellQuote(profile.staticContainer);
  const grpcPorts = requiredPublishedGrpcPorts(profile, publishedDynamicGrpcPorts);
  const expectedPortBindings = [
    ...grpcPorts.map((port) => ({ containerPort: port, hostPort: port })),
    { containerPort: 8765, hostPort: profile.ports.monitoring }
  ];
  const mountTemplate = profile.bindMountPath
    ? '{{range .Mounts}}{{if eq .Destination "/ydb_data"}}{{printf "%s|%s|%s|%t\\n" .Type .Source .Destination .RW}}{{end}}{{end}}'
    : '{{range .Mounts}}{{if eq .Destination "/ydb_data"}}{{printf "%s|%s|%s|%t\\n" .Type .Name .Destination .RW}}{{end}}{{end}}';
  const expectedMount = profile.bindMountPath
    ? `bind|${profile.bindMountPath}|/ydb_data|true`
    : `volume|${profile.volume}|/ydb_data|true`;
  const requiredEnvironment = [
    `GRPC_PORT=${profile.ports.staticGrpc}`,
    "MON_PORT=8765",
    "GRPC_TLS_PORT=",
    "YDB_GRPC_ENABLE_TLS=0",
    "YDB_ANONYMOUS_CREDENTIALS=1",
    "YDB_LOCAL_SURVIVE_RESTART=1",
    ...(requireGraphShard ? ["YDB_FEATURE_FLAGS=enable_graph_shard"] : [])
  ];
  const compatibilityLines = [
    ...staticInspectValueCheck(profile, "{{.Config.Image}}", profile.image, "image reference"),
    `if ! expected_image_id=$(docker image inspect --format ${shellQuote("{{.Id}}")} ${shellQuote(profile.image)} 2>/dev/null); then`,
    ...staticContainerMismatchLines(profile, "image ID", "  "),
    "fi",
    `if ! observed=$(docker inspect --type container --format ${shellQuote("{{.Image}}")} ${container} 2>/dev/null); then`,
    ...staticContainerMismatchLines(profile, "image ID", "  "),
    "fi",
    "if [ \"$observed\" != \"$expected_image_id\" ]; then",
    ...staticContainerMismatchLines(profile, "image ID", "  "),
    "fi",
    ...staticInspectValueCheck(profile, "{{.HostConfig.NetworkMode}}", profile.network, "network"),
    ...staticInspectValueCheck(profile, mountTemplate, expectedMount, "data mount"),
    ...staticInspectValueCheck(profile, "{{len .HostConfig.PortBindings}}", String(expectedPortBindings.length), "published ports"),
    ...expectedPortBindings.flatMap(({ containerPort, hostPort }) => {
      const template = `{{range (index .HostConfig.PortBindings "${containerPort}/tcp")}}{{printf "%s:%s\\n" .HostIp .HostPort}}{{end}}`;
      return staticInspectValueCheck(profile, template, `127.0.0.1:${hostPort}`, "published ports");
    }),
    `if ! container_env=$(docker inspect --type container --format ${shellQuote("{{range .Config.Env}}{{println .}}{{end}}")} ${container} 2>/dev/null); then`,
    ...staticContainerMismatchLines(profile, "environment", "  "),
    "fi",
    ...requiredEnvironment.flatMap((entry) => {
      const key = entry.slice(0, entry.indexOf("="));
      return [
        `if [ \"$(printf '%s\\n' \"$container_env\" | grep -Fxc ${shellQuote(entry)} || true)\" -ne 1 ] || [ \"$(printf '%s\\n' \"$container_env\" | grep -c ${shellQuote(`^${key}=`)} || true)\" -ne 1 ]; then`,
        ...staticContainerMismatchLines(profile, requireGraphShard && key === "YDB_FEATURE_FLAGS" ? "GraphShard environment" : "environment", "  "),
        "fi"
      ];
    }),
    ...staticInspectValueCheck(profile, "{{.HostConfig.RestartPolicy.Name}}", "unless-stopped", "restart policy"),
    ...staticInspectValueCheck(profile, "{{if .Config.Healthcheck}}{{index .Config.Healthcheck.Test 0}}{{end}}", "NONE", "healthcheck")
  ];

  return [
    "set -euo pipefail",
    `if ! existing_containers=$(docker ps -a --format ${shellQuote("{{.Names}}")} 2>/dev/null); then`,
    ...staticContainerMismatchLines(profile, "container inspection", "  "),
    "fi",
    `if ! printf '%s\\n' \"$existing_containers\" | grep -Fxq ${shellQuote(profile.staticContainer)}; then`,
    ...(checkOnly
      ? staticContainerMismatchLines(profile, "container inspection", "  ")
      : [`  ${commandForStaticRun(profile, { enableGraphShard, publishedDynamicGrpcPorts })}`, "  exit 0"]),
    "fi",
    ...compatibilityLines,
    ...(checkOnly
      ? ["exit 0"]
      : [
        `if ! observed=$(docker inspect --type container --format ${shellQuote("{{.State.Running}}")} ${container} 2>/dev/null); then`,
        ...staticContainerMismatchLines(profile, "running state", "  "),
        "fi",
        "if [ \"$observed\" = true ]; then",
        "  exit 0",
        "fi",
        "if [ \"$observed\" != false ]; then",
        ...staticContainerMismatchLines(profile, "running state", "  "),
        "fi",
        `docker start ${container} >/dev/null`,
        "exit 0"
      ])
  ].join("\n");
}

function staticInspectValueCheck(
  profile: ResolvedLocalYdbProfile,
  template: string,
  expected: string,
  aspect: string
): string[] {
  const container = shellQuote(profile.staticContainer);
  return [
    `if ! observed=$(docker inspect --type container --format ${shellQuote(template)} ${container} 2>/dev/null); then`,
    ...staticContainerMismatchLines(profile, aspect, "  "),
    "fi",
    `if [ \"$observed\" != ${shellQuote(expected)} ]; then`,
    ...staticContainerMismatchLines(profile, aspect, "  "),
    "fi"
  ];
}

function staticContainerMismatchLines(
  profile: ResolvedLocalYdbProfile,
  aspect: string,
  indent = ""
): string[] {
  return [
    `${indent}printf '%s\\n' ${shellQuote(`Existing static container ${profile.staticContainer} does not match profile ${aspect}.`)} >&2`,
    `${indent}printf '%s\\n' ${shellQuote(`Recreate it with local_ydb_destroy_stack or docker rm -f ${profile.staticContainer}, then rerun local_ydb_bootstrap.`)} >&2`,
    `${indent}exit 1`
  ];
}

function requiredPublishedGrpcPorts(profile: ResolvedLocalYdbProfile, publishedDynamicGrpcPorts: readonly number[]): number[] {
  return [profile.ports.staticGrpc, ...publishedDynamicGrpcPorts];
}

function validatePublishedHostPorts(profile: ResolvedLocalYdbProfile, publishedDynamicGrpcPorts: readonly number[]): void {
  const bindings = [
    { name: "staticGrpc", port: profile.ports.staticGrpc },
    ...publishedDynamicGrpcPorts.map((port, offset) => ({ name: `dynamicGrpc[${offset + 1}]`, port })),
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

export function dynamicNodeStartSpecs(
  profile: ResolvedLocalYdbProfile,
  plan: DynamicNodePlan,
  mode: "ensure" | "recreate" = "ensure",
  beforeRunSpecs: readonly CommandSpec[] = []
): CommandSpec[] {
  const startCommand = mode === "ensure"
    ? commandForDynamicEnsureRun(profile, plan)
    : [
        `docker rm -f ${shellQuote(plan.container)} 2>/dev/null || true`,
        commandForDynamicNodeRun(profile, plan)
      ].join("\n");
  return [
    ensureImagePresentSpec(profile.image),
    ...beforeRunSpecs,
    bash(startCommand, {
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
    ...statusCommandFailureLines,
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
    return bash(commandForYdbCli(profile, args, database), {
      allowFailure: true,
      description,
      redactions: [profile.rootPasswordFile]
    });
  }
  return {
    command: "docker",
    args: ["exec", profile.staticContainer, "/ydb", "-e", `grpc://localhost:${profile.ports.dynamicGrpc}`, "-d", database, ...args],
    allowFailure: true,
    description
  };
}

export function waitForCommand(
  command: string,
  description: string,
  retryableErrors: string,
  options: { redactions?: string[]; timeoutMs?: number; maxAttempts?: number; retryDelaySeconds?: number } = {}
): CommandSpec {
  const maxAttempts = options.maxAttempts ?? 30;
  const retryDelaySeconds = options.retryDelaySeconds ?? 2;
  return bash([
    "set -euo pipefail",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT",
    `for attempt in $(seq 1 ${maxAttempts}); do`,
    "  rc=0",
    `  ( ${command} ) >"$tmp" 2>&1 || rc=$?`,
    "  if [ \"$rc\" -eq 0 ]; then",
    "    cat \"$tmp\"",
    "    exit 0",
    "  fi",
    `  if grep -Eiq '${retryableErrors}' "$tmp"; then`,
    `    sleep ${retryDelaySeconds}`,
    "  else",
    "    cat \"$tmp\" >&2",
    "    exit \"$rc\"",
    "  fi",
    "done",
    "cat \"$tmp\" >&2",
    "exit \"$rc\""
  ].join("\n"), {
    allowFailure: true,
    timeoutMs: options.timeoutMs ?? 120_000,
    description,
    redactions: options.redactions
  });
}

export function waitForYdbCli(profile: ResolvedLocalYdbProfile, args: string[], database: string, description: string): CommandSpec {
  const command = commandForYdbCli(profile, args, database);
  return waitForYdbCliCommand(profile, command, description);
}

export function waitForYdbRootCli(profile: ResolvedLocalYdbProfile, args: string[], description: string): CommandSpec {
  const command = commandForYdbRootCli(profile, args);
  return waitForYdbCliCommand(profile, command, description);
}

function waitForYdbCliCommand(profile: ResolvedLocalYdbProfile, command: string, description: string): CommandSpec {
  return waitForCommand(command, description, YDB_CLI_RETRYABLE_ERRORS, {
    redactions: [profile.rootPasswordFile ?? ""]
  });
}

function commandForYdbCli(profile: ResolvedLocalYdbProfile, args: string[], database: string): string {
  if (profile.rootPasswordFile) {
    return commandForPasswordPipedDockerExec(profile, `/ydb -e grpc://localhost:${profile.ports.dynamicGrpc} -d ${shellQuote(database)} --user ${shellQuote(profile.rootUser)} --password-file /tmp/root.password ${args.map(shellQuote).join(" ")}`);
  }
  return ["docker", "exec", profile.staticContainer, "/ydb", "-e", `grpc://localhost:${profile.ports.dynamicGrpc}`, "-d", database, ...args].map(shellQuote).join(" ");
}

export function ydbRootCli(profile: ResolvedLocalYdbProfile, args: string[], description: string): CommandSpec {
  if (profile.rootPasswordFile) {
    return bash(commandForYdbRootCli(profile, args), {
      allowFailure: true,
      description,
      redactions: [profile.rootPasswordFile]
    });
  }
  const endpoint = `grpc://localhost:${profile.ports.staticGrpc}`;
  return {
    command: "docker",
    args: ["exec", profile.staticContainer, "/ydb", "-e", endpoint, "-d", profile.rootDatabase, ...args],
    allowFailure: true,
    description
  };
}

function commandForYdbRootCli(profile: ResolvedLocalYdbProfile, args: string[]): string {
  const endpoint = `grpc://localhost:${profile.ports.staticGrpc}`;
  if (profile.rootPasswordFile) {
    return commandForPasswordPipedDockerExec(profile, `/ydb -e ${shellQuote(endpoint)} -d ${shellQuote(profile.rootDatabase)} --user ${shellQuote(profile.rootUser)} --password-file /tmp/root.password ${args.map(shellQuote).join(" ")}`);
  }
  return ["docker", "exec", profile.staticContainer, "/ydb", "-e", endpoint, "-d", profile.rootDatabase, ...args].map(shellQuote).join(" ");
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
