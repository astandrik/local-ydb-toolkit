import { Buffer } from "node:buffer";
import { ydbCli } from "./commands.js";
import type { SchemeAction, SchemeOptions, SchemeResponse, ToolkitContext } from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
const MAX_OUTPUT_BYTES_LIMIT = 1_048_576;

interface CappedText {
  text: string;
  bytes: number;
  truncated: boolean;
}

export async function inspectScheme(
  ctx: ToolkitContext,
  options: SchemeOptions = {}
): Promise<SchemeResponse> {
  const action = options.action ?? "list";
  if (action !== "list" && action !== "describe") {
    throw new Error(`Unsupported scheme action: ${String(action)}`);
  }

  const path = options.path === undefined ? ctx.profile.tenantPath : options.path.trim();
  if (!path) {
    throw new Error("path must be non-empty");
  }
  const maxOutputBytes = normalizeMaxOutputBytes(options.maxOutputBytes);
  const args = schemeArgs(action, path, options);
  const result = await ctx.client.run(ydbCli(
    ctx.profile,
    args,
    ctx.profile.tenantPath,
    action === "list" ? "List YDB scheme objects" : "Describe YDB scheme object"
  ));
  const stdout = capText(result.stdout, maxOutputBytes);
  const stderr = capText(result.stderr, maxOutputBytes);

  return {
    summary: schemeSummary(action, path, result.ok, stdout.truncated || stderr.truncated),
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
    maxOutputBytes
  };
}

function schemeArgs(action: SchemeAction, path: string, options: SchemeOptions): string[] {
  if (action === "list") {
    if (options.stats) {
      throw new Error("stats is only supported when action is describe");
    }
    return [
      "scheme",
      "ls",
      path,
      ...(options.long ? ["-l"] : []),
      ...(options.recursive ? ["-R"] : []),
      ...(options.onePerLine ? ["-1"] : [])
    ];
  }

  if (options.recursive || options.long || options.onePerLine) {
    throw new Error("recursive, long, and onePerLine are only supported when action is list");
  }
  return [
    "scheme",
    "describe",
    path,
    ...(options.stats ? ["--stats"] : [])
  ];
}

function normalizeMaxOutputBytes(value: number | undefined): number {
  const maxOutputBytes = value ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("maxOutputBytes must be a positive integer");
  }
  if (maxOutputBytes > MAX_OUTPUT_BYTES_LIMIT) {
    throw new Error(`maxOutputBytes must be ${MAX_OUTPUT_BYTES_LIMIT} or less`);
  }
  return maxOutputBytes;
}

function capText(input: string, maxBytes: number): CappedText {
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes <= maxBytes) {
    return { text: input, bytes, truncated: false };
  }

  let usedBytes = 0;
  let text = "";
  for (const char of input) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (usedBytes + charBytes > maxBytes) {
      break;
    }
    text += char;
    usedBytes += charBytes;
  }

  return { text, bytes, truncated: true };
}

function schemeSummary(action: SchemeAction, path: string, ok: boolean, truncated: boolean): string {
  const operation = action === "list" ? "List scheme objects" : "Describe scheme object";
  const status = ok ? "succeeded" : "failed";
  return `${operation} at ${path} ${status}${truncated ? " with capped output" : ""}.`;
}
