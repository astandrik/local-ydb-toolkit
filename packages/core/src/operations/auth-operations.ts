import { dirname } from "node:path";
import { bash, shellQuote } from "../api-client.js";
import { commandForDynamicRun, createTenantSpec } from "./commands.js";
import { planOnly, runMutating } from "./execution.js";
import { escapeTextProtoString } from "./helpers.js";
import type { MutatingOptions, OperationResponse, SetRootPasswordOptions, ToolkitContext } from "./types.js";

export async function applyAuthHardening(ctx: ToolkitContext, options: MutatingOptions & { configHostPath?: string } = {}) {
  const configHostPath = options.configHostPath ?? ctx.profile.authConfigPath;
  if (!configHostPath) {
    return planOnly(ctx, "Auth hardening requires configHostPath for the prepared YDB config.", "high", [], ["No changes."], ["Provide a reviewed configHostPath."]);
  }
  const target = "/ydb_data/cluster/kikimr_configs/config.yaml";
  const dynamicNodeRecreate = ctx.profile.dynamicNodeAuthTokenFile
    ? [
        bash(`docker rm -f ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || true`),
        bash(commandForDynamicRun(ctx.profile), { timeoutMs: 60_000 })
      ]
    : [
        bash(`docker restart ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || true`)
      ];
  return runMutating(ctx, {
    summary: `Apply reviewed YDB auth config from ${configHostPath}.`,
    risk: "high",
    specs: [
      bash(`docker cp ${shellQuote(configHostPath)} ${shellQuote(`${ctx.profile.staticContainer}:/tmp/local-ydb-toolkit-config.yaml`)}`),
      ctx.client.dockerExec(ctx.profile.staticContainer, ["cp", target, `${target}.before-local-ydb-toolkit-auth`]),
      bash(`docker stop ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || true`),
      bash(`docker restart ${shellQuote(ctx.profile.staticContainer)}`),
      bash("sleep 5"),
      ctx.client.dockerExec(ctx.profile.staticContainer, ["cp", "/tmp/local-ydb-toolkit-config.yaml", target]),
      bash(`docker restart ${shellQuote(ctx.profile.staticContainer)}`),
      bash("sleep 5"),
      ctx.profile.rootPasswordFile ? waitForAuthenticatedTenantStatusSpec(ctx) : createTenantSpec(ctx.profile),
      ...dynamicNodeRecreate
    ],
    rollback: [
      `docker exec ${ctx.profile.staticContainer} cp ${target}.before-local-ydb-toolkit-auth ${target}`,
      `docker restart ${ctx.profile.staticContainer}`
    ],
    verification: ["anonymous viewer/json returns 401", "authenticated tenant checks pass", "dynamic node reaches nodelist"]
  }, options);
}

function waitForAuthenticatedTenantStatusSpec(ctx: ToolkitContext) {
  const rootPasswordFile = ctx.profile.rootPasswordFile;
  if (!rootPasswordFile) {
    throw new Error("rootPasswordFile is required for auth hardening verification");
  }

  const withPassword = (innerCommand: string) => {
    const script = `umask 077; cat >/tmp/root.password; ${innerCommand}; rc=$?; rm -f /tmp/root.password; exit $rc`;
    return `cat ${shellQuote(rootPasswordFile)} | docker exec -i ${shellQuote(ctx.profile.staticContainer)} bash -lc ${shellQuote(script)}`;
  };

  const statusCommand = withPassword(
    `/ydbd --server localhost:${ctx.profile.ports.staticGrpc} --user ${shellQuote(ctx.profile.rootUser)} --password-file /tmp/root.password admin database ${shellQuote(ctx.profile.tenantPath)} status`
  );
  const createCommand = withPassword(
    `/ydbd --server localhost:${ctx.profile.ports.staticGrpc} --user ${shellQuote(ctx.profile.rootUser)} --password-file /tmp/root.password admin database ${shellQuote(ctx.profile.tenantPath)} create ${shellQuote(`${ctx.profile.storagePoolKind}:${ctx.profile.storagePoolCount}`)}`
  );
  const retryableStatusErrors = "UNAUTHORIZED|Invalid password|Access denied|CLIENT_UNAUTHENTICATED|SCHEME_ERROR|No database found|connection refused|Endpoint list is empty|Could not resolve redirected path|Failed to connect|TRANSPORT_UNAVAILABLE";

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
    `  elif grep -Eq '${retryableStatusErrors}' "$tmp"; then`,
    "    sleep 2",
    "  else",
    "    cat \"$tmp\" >&2",
    "    exit 1",
    "  fi",
    "done",
    "cat \"$tmp\" >&2",
    "exit 1"
  ].join("\n"), {
    timeoutMs: 60_000,
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
  const target = "/ydb_data/cluster/kikimr_configs/config.yaml";
  const script = [
    "set -euo pipefail",
    `install -d -m 0700 ${shellQuote(dirname(configHostPath))}`,
    rootPasswordFile ? `install -d -m 0700 ${shellQuote(dirname(rootPasswordFile))}` : ":",
    "tmp=$(mktemp)",
    "trap 'rm -f \"$tmp\"' EXIT",
    `docker exec ${shellQuote(ctx.profile.staticContainer)} cat ${shellQuote(target)} > \"$tmp\"`,
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
    specs: [bash(script)],
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
        `install -d -m 0700 ${shellQuote(dirname(tokenHostPath))} && printf '%s\n' ${shellQuote(staffToken)} ${shellQuote(registrationToken)} > ${shellQuote(tokenHostPath)} && chmod 600 ${shellQuote(tokenHostPath)}`
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
  const target = "/ydb_data/cluster/kikimr_configs/config.yaml";

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

  const backupConfig = `${configHostPath}.before-local-ydb-toolkit-password-rotate`;
  const backupPassword = `${rootPasswordFile}.before-local-ydb-toolkit-password-rotate`;
  const escapedPassword = password.replace(/'/g, "''");
  const rubyPasswordLiteral = `'${password.replace(/\\/g, "\\\\").replace(/'/g, "\\\\'")}'`;
  const rotateSpec = bash([
    "set -euo pipefail",
    "candidate=$(mktemp)",
    "trap 'rm -f \"$candidate\"' EXIT",
    `rotate_with_password_file() {
  local file="$1"
  [ -f "$file" ] || return 1
  cat "$file" | docker exec -i ${shellQuote(ctx.profile.staticContainer)} bash -lc ${shellQuote(`umask 077; cat >/tmp/root.password; /ydb -e grpc://localhost:${ctx.profile.ports.dynamicGrpc} -d ${shellQuote(ctx.profile.tenantPath)} --user ${shellQuote(ctx.profile.rootUser)} --password-file /tmp/root.password yql -s "ALTER USER ${ctx.profile.rootUser} PASSWORD '${escapedPassword}';"; rc=$?; rm -f /tmp/root.password; exit $rc`)} >/dev/null 2>&1
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
    "echo 'Unable to authenticate as root with any known password source' >&2",
    "exit 1"
  ].join("\n"), {
    redactions: [password, escapedPassword, backupPassword, backupConfig],
    description: `Alter runtime root password for ${ctx.profile.name}`
  });

  const syncHostSpec = bash([
    "set -euo pipefail",
    `install -d -m 0700 ${shellQuote(dirname(configHostPath))}`,
    `install -d -m 0700 ${shellQuote(dirname(rootPasswordFile))}`,
    `if [ -f ${shellQuote(configHostPath)} ]; then cp ${shellQuote(configHostPath)} ${shellQuote(backupConfig)}; fi`,
    `if [ -f ${shellQuote(rootPasswordFile)} ]; then cp ${shellQuote(rootPasswordFile)} ${shellQuote(backupPassword)}; fi`,
    "cfg_tmp=$(mktemp)",
    "trap 'rm -f \"$cfg_tmp\"' EXIT",
    `docker exec ${shellQuote(ctx.profile.staticContainer)} cat ${shellQuote(target)} > \"$cfg_tmp\"`,
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
        `password = ${rubyPasswordLiteral}`,
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
      shellQuote(rootSid)
    ].join(" ")
  ].join("\n"), {
    redactions: [password, escapedPassword, backupPassword, backupConfig],
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

  if (!options.confirm) {
    return {
      summary: `Set the root password for ${ctx.profile.name}. Not executed because confirm=true was not provided.`,
      executed: false,
      risk: "high",
      plannedCommands,
      rollback,
      verification
    };
  }

  const rotateResult = await ctx.client.run(rotateSpec);
  if (!rotateResult.ok) {
    return {
      summary: "Set the root password failed before host-side auth artifacts could be updated.",
      executed: true,
      risk: "high",
      plannedCommands,
      rollback,
      verification,
      results: [rotateResult]
    };
  }
  const syncHostResult = await ctx.client.run(syncHostSpec);
  if (!syncHostResult.ok) {
    return {
      summary: "Set the root password changed runtime credentials but failed while updating host-side auth artifacts.",
      executed: true,
      risk: "high",
      plannedCommands,
      rollback,
      verification,
      results: [rotateResult, syncHostResult]
    };
  }
  const verifyStatusResult = await ctx.client.run(verifyStatusSpec);
  const verifyAnonymousResult = await ctx.client.run(verifyAnonymousSpec);
  const results = [rotateResult, syncHostResult, verifyStatusResult, verifyAnonymousResult];
  return {
    summary: `Set the root password for ${ctx.profile.name}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands.`,
    executed: true,
    risk: "high",
    plannedCommands,
    rollback,
    verification,
    results
  };
}
