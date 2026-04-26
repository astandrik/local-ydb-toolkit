import { dirname } from "node:path";
import { bash, shellQuote } from "../api-client.js";
import { commandForDynamicRun, createTenantSpec } from "./commands.js";
import { planOnly, runMutating } from "./execution.js";
import { escapeTextProtoString } from "./helpers.js";
import type { MutatingOptions, ToolkitContext } from "./types.js";

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
      ctx.client.dockerExec(ctx.profile.staticContainer, ["cp", "/tmp/local-ydb-toolkit-config.yaml", target]),
      bash(`docker stop ${shellQuote(ctx.profile.dynamicContainer)} 2>/dev/null || true`),
      bash(`docker restart ${shellQuote(ctx.profile.staticContainer)}`),
      bash("sleep 5"),
      createTenantSpec(ctx.profile),
      ...dynamicNodeRecreate
    ],
    rollback: [
      `docker exec ${ctx.profile.staticContainer} cp ${target}.before-local-ydb-toolkit-auth ${target}`,
      `docker restart ${ctx.profile.staticContainer}`
    ],
    verification: ["anonymous viewer/json returns 401", "authenticated tenant checks pass", "dynamic node reaches nodelist"]
  }, options);
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
