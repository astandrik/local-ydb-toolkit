import { randomBytes } from "node:crypto";
import {
  LocalYdbApiClient,
  bash,
  shellQuote,
  type CommandExecutor,
  type CommandOutputObserver,
  type CommandResult,
  type CommandSpec,
} from "./api-client.js";
import { redactText } from "./auth.js";
import {
  confirmationContentDigestPlaceholder,
  confirmationContentKey,
  confirmationContentSnapshotPlaceholder,
  confirmationHashShellFunctions,
  type ConfirmationContentFingerprint,
} from "./confirmation-inputs.js";
import type { ConfirmationReceipt } from "./confirmation.js";
import type { ToolkitContext } from "./operations/types.js";
import { pathRedactions } from "./redactions.js";

const SNAPSHOT_FAILURE = "Confirmed content snapshot could not be created or verified.";
const SNAPSHOT_CLEANUP_FAILURE = "Confirmed content snapshot could not be removed.";
const SNAPSHOT_PATH_PREFIX = "/tmp/local-ydb-toolkit-confirmation-";

interface PreparedContent {
  fingerprint: ConfirmationContentFingerprint;
  snapshotPath: string;
}

export async function withAuthorizedContentExecution<T>(
  ctx: ToolkitContext,
  receipt: ConfirmationReceipt | undefined,
  specs: readonly CommandSpec[],
  operation: (executionContext: ToolkitContext) => Promise<T>,
): Promise<T> {
  const required = requiredFingerprints(receipt, specs);
  if (required.length === 0) {
    return operation(ctx);
  }

  const snapshotRoot = `${SNAPSHOT_PATH_PREFIX}${randomBytes(16).toString("hex")}`;
  const preparedItems = required.map((fingerprint, index): PreparedContent => ({
    fingerprint,
    snapshotPath: `${snapshotRoot}/content-${index}`,
  }));
  const preparationFailure = await prepareSnapshots(
    ctx,
    snapshotRoot,
    preparedItems,
    specs.find((spec) => spec.signal)?.signal,
  );
  const prepared = new Map<string, PreparedContent>();
  for (const item of preparedItems) {
    prepared.set(confirmationContentKey(item.fingerprint), item);
  }
  const executor = new ConfirmedContentExecutor(
    ctx.client.executor,
    prepared,
    preparationFailure,
  );
  const executionContext: ToolkitContext = {
    ...ctx,
    client: cloneClientWithExecutor(ctx, executor),
  };

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation(executionContext) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (!await removeSnapshots(ctx, snapshotRoot)) {
    throw new Error(SNAPSHOT_CLEANUP_FAILURE);
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

function requiredFingerprints(
  receipt: ConfirmationReceipt | undefined,
  specs: readonly CommandSpec[],
): ConfirmationContentFingerprint[] {
  if (!receipt) {
    return [];
  }
  const serializedSpecs = specs.flatMap((spec) => [
    spec.command,
    ...(spec.args ?? []),
    spec.stdin ?? "",
  ]).join("\0");
  return receipt.contentInputs.filter((fingerprint) => (
    serializedSpecs.includes(confirmationContentDigestPlaceholder(fingerprint))
      || serializedSpecs.includes(confirmationContentSnapshotPlaceholder(fingerprint))
  ));
}

async function prepareSnapshots(
  ctx: ToolkitContext,
  snapshotRoot: string,
  prepared: readonly PreparedContent[],
  signal?: AbortSignal,
): Promise<CommandResult | undefined> {
  const script = [
    "set -eEuo pipefail",
    "umask 077",
    `snapshot_root=${shellQuote(snapshotRoot)}`,
    "snapshot_failed() {",
    "  trap - ERR HUP INT TERM",
    "  rm -rf \"$snapshot_root\" >/dev/null 2>&1 || true",
    `  printf '%s\\n' ${shellQuote(SNAPSHOT_FAILURE)} >&2`,
    "  exit 1",
    "}",
    "trap snapshot_failed ERR HUP INT TERM",
    "install -d -m 0700 \"$snapshot_root\"",
    ...confirmationHashShellFunctions(),
    "copy_directory_snapshot() {",
    "  local source=$1 destination=$2",
    "  local unsupported",
    "  unsupported=$(find \"$source\" ! -type d ! -type f -print -quit)",
    "  [ -z \"$unsupported\" ]",
    "  rm -rf \"$destination\"",
    "  if cp -a --reflink=always -- \"$source\" \"$destination\" >/dev/null 2>&1; then",
    "    :",
    "  else",
    "    rm -rf \"$destination\"",
    "    if cp -cR \"$source\" \"$destination\" >/dev/null 2>&1; then",
    "      :",
    "    else",
    "      rm -rf \"$destination\"",
    "      cp -R \"$source\" \"$destination\" >/dev/null 2>&1",
    "    fi",
    "  fi",
    "  unsupported=$(find \"$destination\" ! -type d ! -type f -print -quit)",
    "  [ -z \"$unsupported\" ]",
    "}",
    ...prepared.flatMap(({ fingerprint, snapshotPath }, index) => {
      if (!fingerprint.sha256) {
        return [`rm -rf ${shellQuote(snapshotPath)}`];
      }
      const expected = `expected_${index}`;
      const actual = `actual_${index}`;
      const copyLines = fingerprint.kind === "file"
        ? [
            `[ -f ${shellQuote(fingerprint.path)} ]`,
            `cp -p ${shellQuote(fingerprint.path)} ${shellQuote(snapshotPath)} >/dev/null 2>&1`,
            `chmod 0600 ${shellQuote(snapshotPath)}`,
            `${actual}=$(hash_file ${shellQuote(snapshotPath)})`,
          ]
        : [
            `[ -d ${shellQuote(fingerprint.path)} ]`,
            `copy_directory_snapshot ${shellQuote(fingerprint.path)} ${shellQuote(snapshotPath)}`,
            `${actual}=$(hash_directory ${shellQuote(snapshotPath)})`,
          ];
      return [
        `IFS= read -r ${expected}`,
        ...copyLines,
        `[ \"$${actual}\" = \"$${expected}\" ]`,
      ];
    }),
    "trap - ERR HUP INT TERM",
  ].join("\n");
  const digests = prepared
    .flatMap(({ fingerprint }) => fingerprint.sha256 ? [fingerprint.sha256] : [])
    .join("\n") + "\n";
  const spec = bash(script, {
    stdin: digests,
    signal,
    timeoutMs: prepared.some(({ fingerprint }) => fingerprint.kind === "directory")
      ? 60 * 60 * 1000
      : 60_000,
    description: "Prepare confirmed content snapshots",
    redactions: [
      snapshotRoot,
      ...prepared.flatMap(({ fingerprint, snapshotPath }) => [
        ...pathRedactions(fingerprint.path),
        fingerprint.sha256 ?? "",
        snapshotPath,
      ]),
    ],
  });
  try {
    const result = await ctx.client.run(spec);
    return result.ok ? undefined : fixedSnapshotFailure(result);
  } catch {
    return fixedSnapshotFailure();
  }
}

async function removeSnapshots(
  ctx: ToolkitContext,
  snapshotRoot: string,
): Promise<boolean> {
  try {
    const result = await ctx.client.run(bash(`rm -rf ${shellQuote(snapshotRoot)}`, {
      timeoutMs: 60_000,
      description: "Remove confirmed content snapshots",
      redactions: [snapshotRoot],
    }));
    return result.ok;
  } catch {
    return false;
  }
}

class ConfirmedContentExecutor implements CommandExecutor {
  constructor(
    readonly delegate: CommandExecutor,
    readonly prepared: ReadonlyMap<string, PreparedContent>,
    readonly preparationFailure: CommandResult | undefined,
  ) {}

  display(profile: ToolkitContext["profile"], spec: CommandSpec): string {
    return this.delegate.display(profile, spec);
  }

  run(
    profile: ToolkitContext["profile"],
    spec: CommandSpec,
    outputObserver?: CommandOutputObserver,
  ): Promise<CommandResult> {
    if (this.preparationFailure) {
      return Promise.resolve({
        ...this.preparationFailure,
        command: this.delegate.display(profile, spec),
      });
    }
    const resolved = resolveSpec(spec, this.prepared);
    return this.delegate.run(profile, resolved, outputObserver).then((result) => ({
      ...result,
      command: redactText(result.command, resolved.redactions ?? []),
      stdout: redactText(result.stdout, resolved.redactions ?? []),
      stderr: redactText(result.stderr, resolved.redactions ?? []),
    }));
  }
}

function resolveSpec(
  spec: CommandSpec,
  prepared: ReadonlyMap<string, PreparedContent>,
): CommandSpec {
  let command = spec.command;
  let args = spec.args;
  let stdin = spec.stdin;
  const redactions = [...(spec.redactions ?? [])];
  for (const { fingerprint, snapshotPath } of prepared.values()) {
    const digestPlaceholder = confirmationContentDigestPlaceholder(fingerprint);
    const snapshotPlaceholder = confirmationContentSnapshotPlaceholder(fingerprint);
    const digest = fingerprint.sha256 ?? "";
    command = replaceAll(command, digestPlaceholder, digest, snapshotPlaceholder, snapshotPath);
    args = args?.map((arg) => replaceAll(arg, digestPlaceholder, digest, snapshotPlaceholder, snapshotPath));
    stdin = stdin === undefined
      ? undefined
      : replaceAll(stdin, digestPlaceholder, digest, snapshotPlaceholder, snapshotPath);
    redactions.push(
      digestPlaceholder,
      snapshotPlaceholder,
      snapshotPath,
      ...pathRedactions(fingerprint.path),
    );
    if (digest) {
      redactions.push(digest);
    }
  }
  return { ...spec, command, args, stdin, redactions };
}

function replaceAll(
  value: string,
  digestPlaceholder: string,
  digest: string,
  snapshotPlaceholder: string,
  snapshotPath: string,
): string {
  return value
    .replaceAll(digestPlaceholder, digest)
    .replaceAll(snapshotPlaceholder, snapshotPath);
}

function fixedSnapshotFailure(result?: CommandResult): CommandResult {
  return {
    command: "prepare confirmed content snapshot",
    exitCode: result?.exitCode ?? 1,
    stdout: "",
    stderr: SNAPSHOT_FAILURE,
    ok: false,
    timedOut: result?.timedOut ?? false,
  };
}

function cloneClientWithExecutor(
  ctx: ToolkitContext,
  executor: CommandExecutor,
): LocalYdbApiClient {
  const client = new LocalYdbApiClient(ctx.profile, executor);
  const source = ctx.client as unknown as Record<string, unknown>;
  const target = client as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key !== "profile" && key !== "executor") {
      target[key] = source[key];
    }
  }
  return client;
}
