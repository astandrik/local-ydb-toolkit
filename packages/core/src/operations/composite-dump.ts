import { randomBytes } from "node:crypto";
import { bash, shellQuote, type CommandResult } from "../api-client.js";
import {
  confirmationDirectoryCopyShellFunctions,
  confirmationHashShellFunctions,
} from "../confirmation-inputs.js";
import { pathRedactions } from "../redactions.js";
import type { PreparedRestoreSnapshot } from "./commands.js";
import type { ToolkitContext } from "./types.js";

export const COMPOSITE_DUMP_SNAPSHOT_COMMAND = "prepare private verified composite dump snapshot";
export const COMPOSITE_DUMP_SNAPSHOT_FAILURE = "Private composite dump snapshot could not be created or verified.";
export const COMPOSITE_DUMP_CLEANUP_FAILURE = "Private composite dump snapshot could not be removed.";
export const PROFILE_COMPOSITE_REBUILD_SCOPE = { kind: "profile-composite-rebuild" } as const;

const SNAPSHOT_ROOT_PREFIX = "/tmp/local-ydb-toolkit-composite-";

export interface CompositeDumpSnapshot {
  result: CommandResult;
  preparedRestore?: PreparedRestoreSnapshot;
  remove(): Promise<boolean>;
}

export async function createCompositeDumpSnapshot(
  ctx: ToolkitContext,
  dumpName: string,
): Promise<CompositeDumpSnapshot> {
  const snapshotRoot = `${SNAPSHOT_ROOT_PREFIX}${randomBytes(16).toString("hex")}`;
  const source = `${ctx.profile.dumpHostPath}/${dumpName}/tenant`;
  const destination = `${snapshotRoot}/${dumpName}/tenant`;
  const script = [
    "set -eEuo pipefail",
    "umask 077",
    `snapshot_root=${shellQuote(snapshotRoot)}`,
    `source_dump=${shellQuote(source)}`,
    `snapshot_dump=${shellQuote(destination)}`,
    "snapshot_failed() {",
    "  trap - ERR HUP INT TERM",
    "  rm -rf \"$snapshot_root\" >/dev/null 2>&1 || true",
    `  printf '%s\\n' ${shellQuote(COMPOSITE_DUMP_SNAPSHOT_FAILURE)} >&2`,
    "  exit 1",
    "}",
    "trap snapshot_failed ERR HUP INT TERM",
    "[ -d \"$source_dump\" ]",
    "install -d -m 0700 \"$snapshot_root\"",
    "install -d -m 0700 \"$(dirname \"$snapshot_dump\")\"",
    ...confirmationHashShellFunctions(),
    ...confirmationDirectoryCopyShellFunctions(),
    "source_digest=$(hash_directory \"$source_dump\")",
    "copy_directory_snapshot \"$source_dump\" \"$snapshot_dump\"",
    "[ \"$(hash_directory \"$source_dump\")\" = \"$source_digest\" ]",
    "[ \"$(hash_directory \"$snapshot_dump\")\" = \"$source_digest\" ]",
    "printf '%s\\n' \"$source_digest\"",
    "trap - ERR HUP INT TERM",
  ].join("\n");
  let rawResult: CommandResult | undefined;
  try {
    rawResult = await ctx.client.run(bash(script, {
      timeoutMs: 60 * 60 * 1000,
      description: "Prepare private verified composite dump snapshot",
      redactions: [
        snapshotRoot,
        ...pathRedactions(source),
      ],
    }));
  } catch {
    rawResult = undefined;
  }
  const snapshotDigest = rawResult?.ok
    ? /^([a-f0-9]{64})\n?$/.exec(rawResult.stdout)?.[1]
    : undefined;
  const ok = snapshotDigest !== undefined;
  const result: CommandResult = {
    command: COMPOSITE_DUMP_SNAPSHOT_COMMAND,
    exitCode: ok ? 0 : rawResult?.ok ? 1 : rawResult?.exitCode ?? 1,
    stdout: "",
    stderr: ok ? "" : COMPOSITE_DUMP_SNAPSHOT_FAILURE,
    ok,
    timedOut: rawResult?.timedOut ?? false,
  };

  return {
    result,
    preparedRestore: snapshotDigest
      ? { path: destination, sha256: snapshotDigest }
      : undefined,
    async remove() {
      try {
        const cleanup = await ctx.client.run(bash(`rm -rf ${shellQuote(snapshotRoot)}`, {
          timeoutMs: 60_000,
          description: "Remove private composite dump snapshot",
          redactions: [snapshotRoot],
        }));
        return cleanup.ok;
      } catch {
        return false;
      }
    },
  };
}
