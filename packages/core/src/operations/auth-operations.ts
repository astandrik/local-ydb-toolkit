import { dirname } from "node:path";
import { bash, shellQuote, type CommandResult, type CommandSpec } from "../api-client.js";
import { withAuthorizedContentExecution } from "../confirmed-content.js";
import {
  confirmationContentArgBinding,
  confirmationContentDigestPlaceholder,
  confirmationContentSnapshotPlaceholder,
  confirmationHashShellFunctions,
  type ConfirmationContentInput,
} from "../confirmation-inputs.js";
import {
  attachConfirmation,
  authorizeMutation,
  commandPlanIntent,
  confirmationSummarySuffix,
} from "../confirmation.js";
import { pathRedactions } from "../redactions.js";
import { commandForStaticCompatibilityCheck, createTenantSpec, dynamicNodeStartSpecs, waitForYdbCli } from "./commands.js";
import { configuredDynamicNodePlans, startDynamicNodePlans } from "./dynamic-node-topology.js";
import { planOnly, runCommandSpecs, runMutating } from "./execution.js";
import { commandForStaticGeneratedConfigPath } from "./generated-config.js";
import { escapeTextProtoString, statusCommandFailureLines } from "./helpers.js";
import type { MutatingOptions, OperationResponse, SetRootPasswordOptions, ToolkitContext } from "./types.js";

export async function applyAuthHardening(
  ctx: ToolkitContext,
  options: MutatingOptions & { configHostPath?: string } = {}
): Promise<OperationResponse> {
  const configHostPath = options.configHostPath ?? ctx.profile.authConfigPath;
  if (!configHostPath) {
    return planOnly(ctx, "Auth hardening requires configHostPath for the prepared YDB config.", "high", [], ["No changes."], ["Provide a reviewed configHostPath."]);
  }
  const configInput: ConfirmationContentInput = {
    kind: "file",
    path: configHostPath,
    role: "reviewed-auth-config",
  };
  const dynamicAuthInput: ConfirmationContentInput[] = ctx.profile.dynamicNodeAuthTokenFile
    ? [{
        kind: "file",
        path: ctx.profile.dynamicNodeAuthTokenFile,
        role: "dynamic-node-auth",
      }]
    : [];
  const configSnapshot = confirmationContentSnapshotPlaceholder(configInput);
  const configDigest = confirmationContentDigestPlaceholder(configInput);
  const targetCommand = commandForStaticGeneratedConfigPath(ctx.profile.staticContainer);
  const plans = configuredDynamicNodePlans(ctx.profile);
  const preDynamicSpecs: CommandSpec[] = [
    bash(commandForStaticCompatibilityCheck(ctx.profile, {
      requireGraphShard: true,
      publishedDynamicGrpcPorts: plans.map((plan) => plan.grpcPort)
    }), { timeoutMs: 60_000, description: "Verify static local-ydb node compatibility before auth hardening" }),
    bash([
      "set -euo pipefail",
      ...confirmationHashShellFunctions(),
      `confirmed_config_snapshot=${shellQuote(configSnapshot)}`,
      `confirmed_config_digest=${shellQuote(configDigest)}`,
      "if [ ! -f \"$confirmed_config_snapshot\" ] || ! actual_config_digest=$(hash_file \"$confirmed_config_snapshot\") || [ \"$actual_config_digest\" != \"$confirmed_config_digest\" ]; then",
      "  printf '%s\\n' 'Confirmed content snapshot could not be created or verified.' >&2",
      "  exit 1",
      "fi",
      `docker cp \"$confirmed_config_snapshot\" ${shellQuote(`${ctx.profile.staticContainer}:/tmp/local-ydb-toolkit-config.yaml`)}`,
    ].join("\n"), {
      redactions: [
        ...pathRedactions(configHostPath),
        configSnapshot,
        configDigest,
      ],
      confirmationContentBindings: [
        confirmationContentArgBinding(configInput, "snapshot", 1),
        confirmationContentArgBinding(configInput, "digest", 1),
      ],
      description: "Copy confirmed auth config snapshot into the static container",
    }),
    bash([
      "set -euo pipefail",
      `target=$(${targetCommand})`,
      `docker exec ${shellQuote(ctx.profile.staticContainer)} cp "$target" "$target.before-local-ydb-toolkit-auth"`
    ].join("\n")),
    ...plans.slice().reverse().map((plan) => bash(`docker stop ${shellQuote(plan.container)} 2>/dev/null || true`, {
      timeoutMs: 60_000,
      description: `Stop configured dynamic tenant node ${plan.container}`
    })),
    bash(`docker restart ${shellQuote(ctx.profile.staticContainer)}`),
    bash("sleep 5"),
    bash([
      "set -euo pipefail",
      `target=$(${targetCommand})`,
      `docker exec ${shellQuote(ctx.profile.staticContainer)} cp /tmp/local-ydb-toolkit-config.yaml "$target"`
    ].join("\n")),
    bash(`docker restart ${shellQuote(ctx.profile.staticContainer)}`),
    bash("sleep 5"),
    ctx.profile.rootPasswordFile ? waitForAuthenticatedTenantStatusSpec(ctx) : createTenantSpec(ctx.profile)
  ];
  const dynamicSpecs = plans.flatMap((plan) => dynamicNodeStartSpecs(ctx.profile, plan, "recreate"));
  const finalSpecs = ctx.profile.rootPasswordFile
    ? [waitForYdbCli(ctx.profile, ["scheme", "ls", ctx.profile.tenantPath], ctx.profile.tenantPath, "Wait for authenticated tenant metadata")]
    : [];
  const specs = [...preDynamicSpecs, ...dynamicSpecs, ...finalSpecs];
  const rollback = [
    `target=$(${targetCommand}) && docker exec ${shellQuote(ctx.profile.staticContainer)} cp "$target.before-local-ydb-toolkit-auth" "$target"`,
    `docker restart ${shellQuote(ctx.profile.staticContainer)}`,
    "Run local_ydb_restart_stack or local_ydb_bootstrap to recreate configured dynamic nodes against the restored static config."
  ];
  const verification = [
    "anonymous viewer/json returns 401",
    "authenticated tenant checks pass",
    `authenticated viewer/json/nodelist includes configured IC ports: ${plans.map((plan) => plan.icPort).join(", ")}`
  ];
  const summary = `Apply reviewed YDB auth config from ${configHostPath}.`;

  const decision = await authorizeMutation(ctx, options, commandPlanIntent({
    summary,
    risk: "high",
    specs,
    rollback,
    verification,
  }), {
    contentInputs: [configInput, ...dynamicAuthInput],
  });
  if (!decision.execute) {
    return attachConfirmation({
      summary: `${summary}${confirmationSummarySuffix(decision.confirmation)}`,
      executed: false,
      risk: "high",
      plannedCommands: specs.map((spec) => ctx.client.display(spec)),
      rollback,
      verification
    }, decision.confirmation);
  }
  return withAuthorizedContentExecution(
    ctx,
    decision.receipt,
    specs,
    async (executionContext) => {
      const confirmed = (response: OperationResponse) =>
        attachConfirmation(response, decision.confirmation);

      const results = await runCommandSpecs(executionContext, preDynamicSpecs);
      if (!completedAll(preDynamicSpecs, results)) {
        return confirmed(authHardeningResponse(ctx, summary, specs, rollback, verification, results, 0, plans.length));
      }

      const topology = await startDynamicNodePlans(executionContext, plans, "recreate");
      results.push(...topology.results);
      const completedNodes = topology.completedNodes;
      if (completedNodes < plans.length) {
        return confirmed(authHardeningResponse(ctx, summary, specs, rollback, verification, results, completedNodes, plans.length));
      }

      results.push(...await runCommandSpecs(executionContext, finalSpecs));
      return confirmed(authHardeningResponse(ctx, summary, specs, rollback, verification, results, completedNodes, plans.length));
    },
  );
}

function completedAll(specs: CommandSpec[], results: CommandResult[]): boolean {
  return results.length === specs.length && results.every((result) => result.ok);
}

function authHardeningResponse(
  ctx: ToolkitContext,
  summary: string,
  specs: CommandSpec[],
  rollback: string[],
  verification: string[],
  results: CommandResult[],
  completedNodes: number,
  nodeCount: number
): OperationResponse {
  return {
    summary: `${summary} Executed ${results.filter((result) => result.ok).length}/${results.length} commands; restored ${completedNodes}/${nodeCount} configured dynamic nodes.`,
    executed: true,
    risk: "high",
    plannedCommands: specs.map((spec) => ctx.client.display(spec)),
    rollback,
    verification,
    results
  };
}

function waitForAuthenticatedTenantStatusSpec(ctx: ToolkitContext) {
  const rootPasswordFile = ctx.profile.rootPasswordFile;
  if (!rootPasswordFile) {
    throw new Error("rootPasswordFile is required for auth hardening verification");
  }

  const withPassword = (innerCommand: string) => {
    const script = `set -e; umask 077; password_file=$(mktemp /tmp/local-ydb-toolkit-root-password-XXXXXX); trap 'rc=$?; rm -f "$password_file"; trap - EXIT HUP INT TERM; exit "$rc"' EXIT HUP INT TERM; cat >"$password_file"; ${innerCommand.replaceAll("/tmp/root.password", '"$password_file"')}`;
    return `cat ${shellQuote(rootPasswordFile)} | docker exec -i ${shellQuote(ctx.profile.staticContainer)} bash -lc ${shellQuote(script)}`;
  };

  const statusCommand = withPassword(
    `/ydbd --server localhost:${ctx.profile.ports.staticGrpc} --user ${shellQuote(ctx.profile.rootUser)} --password-file /tmp/root.password admin database ${shellQuote(ctx.profile.tenantPath)} status`
  );
  const createCommand = withPassword(
    `/ydbd --server localhost:${ctx.profile.ports.staticGrpc} --user ${shellQuote(ctx.profile.rootUser)} --password-file /tmp/root.password admin database ${shellQuote(ctx.profile.tenantPath)} create ${shellQuote(`${ctx.profile.storagePoolKind}:${ctx.profile.storagePoolCount}`)}`
  );
  const retryableStatusErrors = "UNAUTHORIZED|Invalid password|Access denied|CLIENT_UNAUTHENTICATED|SCHEME_ERROR|No database found|connection refused|Endpoint list is empty|Could not resolve redirected path|Failed to connect|TRANSPORT_UNAVAILABLE";
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
    redactions: [rootPasswordFile],
    description: `Wait for authenticated tenant status for ${ctx.profile.tenantPath}`
  });
}

export async function prepareAuthConfig(
  ctx: ToolkitContext,
  options: MutatingOptions & { configHostPath?: string; sid?: string } = {}
) {
  const configHostPath = options.configHostPath ?? ctx.profile.authConfigPath;
  const sid = options.sid ?? ctx.profile.dynamicNodeAuthSid ?? "root@builtin";
  const rootSid = ctx.profile.rootUser;
  if (!configHostPath) {
    return planOnly(
      ctx,
      "Prepare auth config requires configHostPath directly or through the selected profile.",
      "medium",
      [],
      ["No changes."],
      ["Provide configHostPath and rerun."]
    );
  }

  const rootPasswordFile = ctx.profile.rootPasswordFile ?? "";
  const targetCommand = commandForStaticGeneratedConfigPath(ctx.profile.staticContainer);
  const script = [
    "set -euo pipefail",
    `install -d -m 0700 ${shellQuote(dirname(configHostPath))}`,
    rootPasswordFile ? `install -d -m 0700 ${shellQuote(dirname(rootPasswordFile))}` : ":",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT",
    `target=$(${targetCommand})`,
    `docker exec ${shellQuote(ctx.profile.staticContainer)} cat "$target" > "$tmp"`,
    [
      "ruby -ryaml -e",
      shellQuote([
        "config = YAML.load_file(ARGV[0])",
        "domains = config.fetch(\"domains_config\")",
        "security = domains[\"security_config\"] ||= {}",
        "allowed_sids = [ARGV[2], ARGV[4]].reject(&:empty?).uniq",
        "security[\"enforce_user_token_requirement\"] = true",
        "security[\"viewer_allowed_sids\"] = allowed_sids",
        "security[\"monitoring_allowed_sids\"] = allowed_sids",
        "security[\"administration_allowed_sids\"] = allowed_sids",
        "security[\"register_dynamic_node_allowed_sids\"] = allowed_sids",
        "File.write(ARGV[1], YAML.dump(config))",
        "File.chmod(0600, ARGV[1])",
        "if !ARGV[3].empty?",
        "  root = Array(security[\"default_users\"]).find { |user| user[\"name\"] == \"root\" }",
        "  raise \"root password not found in security_config.default_users\" unless root && root[\"password\"]",
        "  File.write(ARGV[3], \"#{root[\"password\"]}\\n\")",
        "  File.chmod(0600, ARGV[3])",
        "end"
      ].join("; ")),
      "\"$tmp\"",
      shellQuote(configHostPath),
      shellQuote(sid),
      shellQuote(rootPasswordFile),
      shellQuote(rootSid)
    ].join(" ")
  ].join("\n");

  return runMutating(ctx, {
    summary: `Prepare hardened auth config at ${configHostPath}.`,
    risk: "medium",
    specs: [bash(script, {
      redactions: pathRedactions(configHostPath, rootPasswordFile)
    })],
    rollback: [
      `rm -f ${configHostPath}`,
      ...(rootPasswordFile ? [`rm -f ${rootPasswordFile}`] : [])
    ],
    verification: [
      `test -s ${configHostPath}`,
      ...(rootPasswordFile ? [`test -s ${rootPasswordFile}`] : [])
    ]
  }, options);
}

export async function writeDynamicNodeAuthConfig(
  ctx: ToolkitContext,
  options: MutatingOptions & { sid?: string; tokenHostPath?: string } = {}
) {
  const sid = options.sid ?? ctx.profile.dynamicNodeAuthSid;
  const tokenHostPath = options.tokenHostPath ?? ctx.profile.dynamicNodeAuthTokenFile;
  if (!sid || !tokenHostPath) {
    return planOnly(
      ctx,
      "Dynamic node auth config requires both sid and tokenHostPath.",
      "medium",
      [],
      ["No changes."],
      ["Provide sid and tokenHostPath directly or through the selected profile."]
    );
  }

  const staffToken = `StaffApiUserToken: "${escapeTextProtoString(sid)}"`;
  const registrationToken = `NodeRegistrationToken: "${escapeTextProtoString(sid)}"`;
  return runMutating(ctx, {
    summary: `Write dynamic-node auth config to ${tokenHostPath}.`,
    risk: "medium",
    specs: [
      bash(
        `install -d -m 0700 ${shellQuote(dirname(tokenHostPath))} && printf '%s\n' ${shellQuote(staffToken)} ${shellQuote(registrationToken)} > ${shellQuote(tokenHostPath)} && chmod 600 ${shellQuote(tokenHostPath)}`,
        { redactions: pathRedactions(tokenHostPath) }
      )
    ],
    rollback: [`rm -f ${tokenHostPath}`],
    verification: [`test -s ${tokenHostPath}`]
  }, options);
}

export async function setRootPassword(
  ctx: ToolkitContext,
  options: SetRootPasswordOptions = {}
): Promise<OperationResponse> {
  const configHostPath = ctx.profile.authConfigPath;
  const rootPasswordFile = ctx.profile.rootPasswordFile;
  const password = options.password;
  const sid = ctx.profile.dynamicNodeAuthSid ?? "root@builtin";
  const rootSid = ctx.profile.rootUser;
  const targetCommand = commandForStaticGeneratedConfigPath(ctx.profile.staticContainer);

  if (!password) {
    return planOnly(
      ctx,
      "Set root password requires a non-empty password value.",
      "high",
      [],
      ["No changes."],
      ["Provide password and rerun."]
    );
  }
  if (/[\r\n]/.test(password)) {
    return planOnly(
      ctx,
      "Set root password does not support passwords containing carriage returns or newlines.",
      "high",
      [],
      ["No changes."],
      ["Provide a password without carriage returns or newlines and rerun."]
    );
  }
  if (!configHostPath || !rootPasswordFile) {
    return planOnly(
      ctx,
      "Set root password requires authConfigPath and rootPasswordFile on the selected profile.",
      "high",
      [],
      ["No changes."],
      ["Configure authConfigPath and rootPasswordFile on the selected profile."]
    );
  }

  const configInput: ConfirmationContentInput = {
    kind: "file",
    path: configHostPath,
    role: "auth-config",
  };
  const passwordInput: ConfirmationContentInput = {
    kind: "file",
    path: rootPasswordFile,
    role: "root-password",
  };
  const configSnapshot = confirmationContentSnapshotPlaceholder(configInput);
  const configDigest = confirmationContentDigestPlaceholder(configInput);
  const passwordSnapshot = confirmationContentSnapshotPlaceholder(passwordInput);
  const passwordDigest = confirmationContentDigestPlaceholder(passwordInput);

  const backupConfig = `${configHostPath}.before-local-ydb-toolkit-password-rotate`;
  const backupPassword = `${rootPasswordFile}.before-local-ydb-toolkit-password-rotate`;
  const escapedPassword = password.replace(/\\/g, "\\\\").replace(/'/g, "''");
  const rotateSpec = bash([
    "set -euo pipefail",
    "candidate=$(mktemp)",
    "last_error=$(mktemp)",
    "query_host=$(mktemp)",
    "query_container=",
    `cleanup_query_container() {
  if [ -n "$query_container" ]; then
    docker exec ${shellQuote(ctx.profile.staticContainer)} rm -f "$query_container" >/dev/null 2>&1 || true
    query_container=
  fi
}`,
    "trap 'rc=$?; rm -f \"$candidate\" \"$last_error\" \"$query_host\"; cleanup_query_container; trap - EXIT HUP INT TERM; exit \"$rc\"' EXIT HUP INT TERM",
    [
      "ruby -e",
      shellQuote([
        "def yql_identifier(value)",
        "escaped = value.gsub(\"\\\\\") { \"\\\\\\\\\" }.gsub(\"`\") { \"\\\\`\" }",
        "\"`#{escaped}`\"",
        "end",
        "password = STDIN.read",
        "user = yql_identifier(ARGV.fetch(1))",
        "sql_escaped = password.gsub(\"\\\\\") { \"\\\\\\\\\" }.gsub(\"'\", \"''\")",
        "File.write(ARGV[0], \"ALTER USER #{user} PASSWORD '#{sql_escaped}';\\n\")"
      ].join("; ")),
      "\"$query_host\"",
      shellQuote(ctx.profile.rootUser)
    ].join(" "),
    `rotate_with_password_file() {
  local file="$1"
  [ -f "$file" ] || return 1
  query_container=$(docker exec ${shellQuote(ctx.profile.staticContainer)} mktemp /tmp/local-ydb-toolkit-password-rotate-XXXXXX.yql) || return $?
  if ! docker cp "$query_host" ${shellQuote(`${ctx.profile.staticContainer}:`)}"$query_container"; then
    cleanup_query_container
    return 1
  fi
  set +e
  cat "$file" | docker exec -i ${shellQuote(ctx.profile.staticContainer)} bash -lc ${shellQuote(`set -e; query_file="$1"; umask 077; password_file=$(mktemp /tmp/local-ydb-toolkit-root-password-XXXXXX); trap 'rc=$?; rm -f "$password_file" "$query_file"; trap - EXIT HUP INT TERM; exit "$rc"' EXIT HUP INT TERM; cat >"$password_file"; /ydb -e grpc://localhost:${ctx.profile.ports.dynamicGrpc} -d ${shellQuote(ctx.profile.tenantPath)} --user ${shellQuote(ctx.profile.rootUser)} --password-file "$password_file" yql -f "$query_file"`)} _ "$query_container" >"$last_error" 2>&1
  rc=$?
  set -e
  cleanup_query_container
  return "$rc"
}`,
    `extract_password_from_config() {
  local file="$1"
  [ -f "$file" ] || return 1
  ruby -ryaml -e ${shellQuote([
    "cfg = YAML.load_file(ARGV[0])",
    "root = Array(cfg.dig(\"domains_config\", \"security_config\", \"default_users\")).find { |user| user[\"name\"] == \"root\" }",
    "exit 1 unless root && root[\"password\"]",
    "print root[\"password\"]"
  ].join("; "))} "$file" > "$candidate"
}`,
    `if rotate_with_password_file ${shellQuote(rootPasswordFile)}; then exit 0; fi`,
    `if rotate_with_password_file ${shellQuote(backupPassword)}; then exit 0; fi`,
    `if extract_password_from_config ${shellQuote(configHostPath)} && rotate_with_password_file "$candidate"; then exit 0; fi`,
    `if extract_password_from_config ${shellQuote(backupConfig)} && rotate_with_password_file "$candidate"; then exit 0; fi`,
    "echo 'Unable to authenticate as root with any known password source or ALTER USER failed' >&2",
    "cat \"$last_error\" >&2",
    "exit 1"
  ].join("\n"), {
    stdin: password,
    redactions: [password, escapedPassword, backupPassword, backupConfig],
    description: `Alter runtime root password for ${ctx.profile.name}`
  });

  const syncHostSpec = bash([
    "set -euo pipefail",
    ...confirmationHashShellFunctions(),
    `confirmed_config_snapshot=${shellQuote(configSnapshot)}`,
    `confirmed_config_digest=${shellQuote(configDigest)}`,
    `confirmed_password_snapshot=${shellQuote(passwordSnapshot)}`,
    `confirmed_password_digest=${shellQuote(passwordDigest)}`,
    "backup_confirmed_file() {",
    "  local source=$1 expected=$2 destination=$3 actual",
    "  [ -f \"$source\" ] || return 0",
    "  actual=$(hash_file \"$source\")",
    "  if [ \"$actual\" != \"$expected\" ]; then",
    "    printf '%s\\n' 'Confirmed content snapshot could not be created or verified.' >&2",
    "    return 1",
    "  fi",
    "  cp \"$source\" \"$destination\"",
    "}",
    "password_host=$(mktemp)",
    "trap 'rc=$?; rm -f \"$password_host\"; trap - EXIT HUP INT TERM; exit \"$rc\"' EXIT HUP INT TERM",
    "cat > \"$password_host\"",
    `install -d -m 0700 ${shellQuote(dirname(configHostPath))}`,
    `install -d -m 0700 ${shellQuote(dirname(rootPasswordFile))}`,
    `backup_confirmed_file "$confirmed_config_snapshot" "$confirmed_config_digest" ${shellQuote(backupConfig)}`,
    `backup_confirmed_file "$confirmed_password_snapshot" "$confirmed_password_digest" ${shellQuote(backupPassword)}`,
    "cfg_tmp=$(mktemp)",
    "trap 'rc=$?; rm -f \"$cfg_tmp\" \"$password_host\"; trap - EXIT HUP INT TERM; exit \"$rc\"' EXIT HUP INT TERM",
    `target=$(${targetCommand})`,
    `docker exec ${shellQuote(ctx.profile.staticContainer)} cat "$target" > "$cfg_tmp"`,
    [
      "ruby -ryaml -e",
      shellQuote([
        "config = YAML.load_file(ARGV[0])",
        "domains = config.fetch(\"domains_config\")",
        "security = domains[\"security_config\"] ||= {}",
        "allowed_sids = [ARGV[2], ARGV[4]].reject(&:empty?).uniq",
        "security[\"enforce_user_token_requirement\"] = true",
        "security[\"viewer_allowed_sids\"] = allowed_sids",
        "security[\"monitoring_allowed_sids\"] = allowed_sids",
        "security[\"administration_allowed_sids\"] = allowed_sids",
        "security[\"register_dynamic_node_allowed_sids\"] = allowed_sids",
        "root = Array(security[\"default_users\"]).find { |user| user[\"name\"] == \"root\" }",
        "raise \"root password not found in security_config.default_users\" unless root",
        "password = File.read(ARGV[5], mode: \"r:UTF-8\")",
        "root[\"password\"] = password",
        "File.write(ARGV[1], YAML.dump(config))",
        "File.chmod(0600, ARGV[1])",
        "File.write(ARGV[3], \"#{password}\\n\")",
        "File.chmod(0600, ARGV[3])"
      ].join("; ")),
      "\"$cfg_tmp\"",
      shellQuote(configHostPath),
      shellQuote(sid),
      shellQuote(rootPasswordFile),
      shellQuote(rootSid),
      "\"$password_host\""
    ].join(" ")
  ].join("\n"), {
    stdin: password,
    redactions: [
      password,
      escapedPassword,
      backupPassword,
      backupConfig,
      configSnapshot,
      configDigest,
      passwordSnapshot,
      passwordDigest,
    ],
    confirmationContentBindings: [
      confirmationContentArgBinding(configInput, "snapshot", 1),
      confirmationContentArgBinding(configInput, "digest", 1),
      confirmationContentArgBinding(passwordInput, "snapshot", 1),
      confirmationContentArgBinding(passwordInput, "digest", 1),
    ],
    description: "Sync host auth config and root password file with the new root password"
  });
  const verifyStatusSpec = waitForAuthenticatedTenantStatusSpec(ctx);
  const verifyAnonymousSpec = bash(`tmp=$(mktemp); code=$(curl -sS -o "$tmp" -w '%{http_code}' ${shellQuote(`${ctx.profile.monitoringBaseUrl}/viewer/json/whoami`)} || true); rm -f "$tmp"; test "$code" = 401`, {
    allowFailure: true,
    description: "Verify anonymous viewer is denied"
  });

  const plannedCommands = [
    ctx.client.display(rotateSpec),
    ctx.client.display(syncHostSpec),
    ctx.client.display(verifyStatusSpec),
    ctx.client.display(verifyAnonymousSpec)
  ];
  const rollback = [
    `if [ -f ${backupConfig} ]; then cp ${backupConfig} ${configHostPath}; fi`,
    `if [ -f ${backupPassword} ]; then cp ${backupPassword} ${rootPasswordFile}; fi`,
    "Rotate the root password back with ALTER USER if the old password is still known."
  ];
  const verification = [
    `test -s ${configHostPath}`,
    `test -s ${rootPasswordFile}`,
    "anonymous viewer/json returns 401",
    "authenticated tenant checks pass"
  ];

  const summary = `Set the root password for ${ctx.profile.name}.`;
  const specs = [rotateSpec, syncHostSpec, verifyStatusSpec, verifyAnonymousSpec];
  const decision = await authorizeMutation(ctx, options, commandPlanIntent({
    summary,
    risk: "high",
    specs,
    rollback,
    verification,
  }), {
    contentInputs: [
      configInput,
      passwordInput,
      { kind: "file", path: backupConfig, role: "backup-auth-config" },
      { kind: "file", path: backupPassword, role: "backup-root-password" },
    ],
  });
  if (!decision.execute) {
    return attachConfirmation({
      summary: `${summary}${confirmationSummarySuffix(decision.confirmation)}`,
      executed: false,
      risk: "high",
      plannedCommands,
      rollback,
      verification
    }, decision.confirmation);
  }

  return withAuthorizedContentExecution(
    ctx,
    decision.receipt,
    specs,
    async (executionContext) => {
      const rotateResult = await executionContext.client.run(rotateSpec);
      if (!rotateResult.ok) {
        return attachConfirmation({
          summary: "Set the root password failed before host-side auth artifacts could be updated.",
          executed: true,
          risk: "high",
          plannedCommands,
          rollback,
          verification,
          results: [rotateResult]
        }, decision.confirmation);
      }
      const syncHostResult = await executionContext.client.run(syncHostSpec);
      if (!syncHostResult.ok) {
        return attachConfirmation({
          summary: "Set the root password changed runtime credentials but failed while updating host-side auth artifacts.",
          executed: true,
          risk: "high",
          plannedCommands,
          rollback,
          verification,
          results: [rotateResult, syncHostResult]
        }, decision.confirmation);
      }
      const verifyStatusResult = await executionContext.client.run(verifyStatusSpec);
      const verifyAnonymousResult = await executionContext.client.run(verifyAnonymousSpec);
      const results = [rotateResult, syncHostResult, verifyStatusResult, verifyAnonymousResult];
      return attachConfirmation({
        summary: `Set the root password for ${ctx.profile.name}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands.`,
        executed: true,
        risk: "high",
        plannedCommands,
        rollback,
        verification,
        results
      }, decision.confirmation);
    },
  );
}
