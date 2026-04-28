import { ydbCli } from "./commands.js";
import { runMutating } from "./execution.js";
import { capText, normalizeMaxOutputBytes } from "./output.js";
import type {
  OperationPlan,
  PermissionsAction,
  PermissionsMutationResponse,
  PermissionsOptions,
  PermissionsResponse,
  ToolkitContext,
} from "./types.js";

type MutatingPermissionsAction = Exclude<PermissionsAction, "list">;

export async function managePermissions(
  ctx: ToolkitContext,
  options: PermissionsOptions = {},
): Promise<PermissionsResponse> {
  const action = options.action ?? "list";
  validateAction(action);

  const path = normalizeNonEmpty("path", options.path ?? ctx.profile.tenantPath);
  const args = permissionsArgs(action, path, options);

  if (action === "list") {
    const maxOutputBytes = normalizeMaxOutputBytes(options.maxOutputBytes);
    const result = await ctx.client.run(ydbCli(
      ctx.profile,
      args,
      ctx.profile.tenantPath,
      "List YDB scheme permissions",
    ));
    const stdout = capText(result.stdout, maxOutputBytes);
    const stderr = capText(result.stderr, maxOutputBytes);

    return {
      summary: permissionsListSummary(path, result.ok, stdout.truncated || stderr.truncated),
      ok: result.ok,
      action,
      path,
      command: result.command,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      maxOutputBytes,
    };
  }

  const normalized = normalizedMutationFields(action, options);
  const response = await runMutating(ctx, {
    summary: permissionsMutationSummary(action, path, normalized),
    risk: permissionsRisk(action),
    specs: [
      ydbCli(
        ctx.profile,
        args,
        ctx.profile.tenantPath,
        permissionsDescription(action),
      ),
    ],
    rollback: permissionsRollback(action, normalized),
    verification: [
      `Run local_ydb_permissions with action=list and path=${path} to inspect direct and effective permissions.`,
    ],
  }, options);

  return {
    ...response,
    action,
    path,
    ...normalized,
  };
}

function permissionsArgs(
  action: PermissionsAction,
  path: string,
  options: PermissionsOptions,
): string[] {
  if (action === "list") {
    ensureNoMutationOnlyFields(action, options);
    return ["scheme", "permissions", "list", path];
  }

  if (action === "grant" || action === "revoke" || action === "set") {
    if (options.owner !== undefined) {
      throw new Error(`owner is not supported when action is ${action}`);
    }
    const subject = normalizeNonEmpty("subject", options.subject);
    const permissions = normalizePermissions(action, options.permissions);
    return [
      "scheme",
      "permissions",
      action,
      ...permissions.flatMap((permission) => ["-p", permission]),
      path,
      subject,
    ];
  }

  if (action === "chown") {
    ensureNoMutationOnlyFields(action, { ...options, owner: undefined });
    return [
      "scheme",
      "permissions",
      "chown",
      path,
      normalizeNonEmpty("owner", options.owner),
    ];
  }

  ensureNoMutationOnlyFields(action, options);
  return ["scheme", "permissions", action, path];
}

function normalizedMutationFields(
  action: MutatingPermissionsAction,
  options: PermissionsOptions,
): Omit<PermissionsMutationResponse, keyof OperationPlan | "summary" | "executed" | "results" | "action" | "path"> {
  if (action === "grant" || action === "revoke" || action === "set") {
    return {
      subject: normalizeNonEmpty("subject", options.subject),
      permissions: normalizePermissions(action, options.permissions),
    };
  }
  if (action === "chown") {
    return { owner: normalizeNonEmpty("owner", options.owner) };
  }
  return {};
}

function normalizePermissions(action: "grant" | "revoke" | "set", values: string[] | undefined): string[] {
  const permissions = (values ?? []).map((value, index) =>
    normalizeNonEmpty(`permissions[${index}]`, value));
  if (permissions.length === 0) {
    throw new Error(`At least one permission to ${action} should be provided`);
  }
  return permissions;
}

function normalizeNonEmpty(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} must be non-empty`);
  }
  return normalized;
}

function ensureNoMutationOnlyFields(action: PermissionsAction, options: PermissionsOptions): void {
  if (options.subject !== undefined) {
    throw new Error(`subject is not supported when action is ${action}`);
  }
  if (options.owner !== undefined) {
    throw new Error(`owner is not supported when action is ${action}`);
  }
  if (options.permissions !== undefined) {
    throw new Error(`permissions is not supported when action is ${action}`);
  }
}

function validateAction(action: string): asserts action is PermissionsAction {
  if (![
    "list",
    "grant",
    "revoke",
    "set",
    "clear",
    "chown",
    "set-inheritance",
    "clear-inheritance",
  ].includes(action)) {
    throw new Error(`Unsupported permissions action: ${action}`);
  }
}

function permissionsRisk(action: MutatingPermissionsAction): OperationPlan["risk"] {
  return action === "grant" || action === "revoke" ? "medium" : "high";
}

function permissionsDescription(action: MutatingPermissionsAction): string {
  switch (action) {
    case "grant":
      return "Grant YDB scheme permissions";
    case "revoke":
      return "Revoke YDB scheme permissions";
    case "set":
      return "Set YDB scheme permissions";
    case "clear":
      return "Clear direct YDB scheme permissions";
    case "chown":
      return "Change YDB scheme owner";
    case "set-inheritance":
      return "Enable YDB scheme permission inheritance";
    case "clear-inheritance":
      return "Disable YDB scheme permission inheritance";
  }
}

function permissionsMutationSummary(
  action: MutatingPermissionsAction,
  path: string,
  fields: Pick<PermissionsMutationResponse, "subject" | "permissions" | "owner">,
): string {
  if (action === "grant" || action === "revoke" || action === "set") {
    return `${permissionsDescription(action)} at ${path} for ${fields.subject}.`;
  }
  if (action === "chown") {
    return `${permissionsDescription(action)} at ${path} to ${fields.owner}.`;
  }
  return `${permissionsDescription(action)} at ${path}.`;
}

function permissionsRollback(
  action: MutatingPermissionsAction,
  fields: Pick<PermissionsMutationResponse, "subject" | "permissions" | "owner">,
): string[] {
  if (action === "grant") {
    return [`Run action=revoke for subject=${fields.subject} with the same permissions if the grant should be undone.`];
  }
  if (action === "revoke") {
    return [`Run action=grant for subject=${fields.subject} with the same permissions if the revoke should be undone.`];
  }
  if (action === "set" || action === "clear") {
    return ["Restore the previous direct permissions from a prior action=list capture."];
  }
  if (action === "chown") {
    return ["Run action=chown with the previous owner from a prior action=list capture."];
  }
  if (action === "set-inheritance") {
    return ["Run action=clear-inheritance to disable inherited permissions again."];
  }
  return ["Run action=set-inheritance to enable inherited permissions again."];
}

function permissionsListSummary(path: string, ok: boolean, truncated: boolean): string {
  const status = ok ? "succeeded" : "failed";
  return `List permissions at ${path} ${status}${truncated ? " with capped output" : ""}.`;
}
