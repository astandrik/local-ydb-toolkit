import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { bash, shellQuote } from "./api-client.js";
import type { ToolkitContext } from "./operations/types.js";
import { pathRedactions } from "./redactions.js";

export interface ConfirmationContentInput {
  kind: "file" | "directory";
  path: string;
  role: string;
}

type ConfirmationContentFingerprint = ConfirmationContentInput & {
  state: "missing" | "file" | "directory" | "not-file" | "not-directory";
  sha256?: string;
};

const READ_BUFFER_BYTES = 64 * 1024;

export async function confirmationContentIntent(
  ctx: ToolkitContext,
  explicitInputs: ConfirmationContentInput[] = [],
): Promise<ConfirmationContentFingerprint[]> {
  const inputs = new Map<string, ConfirmationContentInput>();
  for (const input of explicitInputs) {
    inputs.set(contentInputKey(input), input);
  }

  const profileInputs: ConfirmationContentInput[] = [
    ...optionalFileInput("root-password", ctx.profile.rootPasswordFile),
    ...optionalFileInput("auth-config", ctx.profile.authConfigPath),
    ...optionalFileInput("dynamic-node-auth", ctx.profile.dynamicNodeAuthTokenFile),
  ];
  for (const input of profileInputs) {
    const key = contentInputKey(input);
    if (!inputs.has(key)) {
      inputs.set(key, input);
    }
  }

  const ordered = [...inputs.values()].sort((left, right) => (
    compareStrings(left.role, right.role)
      || compareStrings(left.kind, right.kind)
      || compareStrings(left.path, right.path)
  ));
  return Promise.all(ordered.map((input) => fingerprintTargetInput(ctx, input)));
}

function optionalFileInput(
  role: string,
  path: string | undefined,
): ConfirmationContentInput[] {
  return path ? [{ kind: "file", path, role }] : [];
}

function contentInputKey(input: ConfirmationContentInput): string {
  return `${input.kind}\0${input.path}`;
}

async function fingerprintTargetInput(
  ctx: ToolkitContext,
  input: ConfirmationContentInput,
): Promise<ConfirmationContentFingerprint> {
  return ctx.profile.mode === "ssh" || input.kind === "directory"
    ? fingerprintShellInput(ctx, input)
    : fingerprintLocalFileInput(input);
}

function fingerprintLocalFileInput(
  input: ConfirmationContentInput,
): ConfirmationContentFingerprint {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(input.path);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return { ...input, state: "missing" };
    }
    throw new Error("Unable to fingerprint a confirmation content input");
  }

  try {
    if (input.kind !== "file" || !stats.isFile()) {
      return { ...input, state: "not-file" };
    }
    return { ...input, state: "file", sha256: hashLocalFile(input.path) };
  } catch {
    throw new Error("Unable to fingerprint a confirmation content input");
  }
}

async function fingerprintShellInput(
  ctx: ToolkitContext,
  input: ConfirmationContentInput,
): Promise<ConfirmationContentFingerprint> {
  const quotedPath = shellQuote(input.path);
  const typeCheck = input.kind === "file" ? "-f" : "-d";
  const wrongType = input.kind === "file" ? "not-file" : "not-directory";
  const digestCommand = input.kind === "file"
    ? `hash_file ${quotedPath}`
    : `hash_directory ${quotedPath}`;
  const script = [
    "set -euo pipefail",
    "hash_file() {",
    "  if command -v sha256sum >/dev/null 2>&1; then sha256sum -- \"$1\" | awk '{print $1}'; return; fi",
    "  if command -v shasum >/dev/null 2>&1; then shasum -a 256 -- \"$1\" | awk '{print $1}'; return; fi",
    "  if command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r < \"$1\" | awk '{print $1}'; return; fi",
    "  return 127",
    "}",
    "hash_stream() {",
    "  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'; return; fi",
    "  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'; return; fi",
    "  if command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r | awk '{print $1}'; return; fi",
    "  return 127",
    "}",
    "hash_directory() {",
    "  command -v find >/dev/null 2>&1 || return 127",
    "  command -v sort >/dev/null 2>&1 || return 127",
    "  (",
    "    cd \"$1\"",
    "    find . ! -path . -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' entry; do",
    "      if [ -L \"$entry\" ]; then",
    "        printf 'symlink\\0%s\\0%s\\0' \"$entry\" \"$(readlink \"$entry\")\"",
    "      elif [ -d \"$entry\" ]; then",
    "        printf 'directory\\0%s\\0' \"$entry\"",
    "      elif [ -f \"$entry\" ]; then",
    "        printf 'file\\0%s\\0' \"$entry\"",
    "        hash_file \"$entry\"",
    "      else",
    "        printf 'other\\0%s\\0' \"$entry\"",
    "      fi",
    "    done",
    "  ) | hash_stream",
    "}",
    `if [ ! -e ${quotedPath} ]; then printf 'missing\\n'; exit 0; fi`,
    `if [ ! ${typeCheck} ${quotedPath} ]; then printf '${wrongType}\\n'; exit 0; fi`,
    `digest=$(${digestCommand})`,
    `printf '${input.kind}:%s\\n' \"$digest\"`,
  ].join("\n");
  const result = await ctx.client.run(bash(script, {
    allowFailure: true,
    description: `Fingerprint ${input.role} confirmation input`,
    redactions: pathRedactions(input.path),
    timeoutMs: input.kind === "directory" ? 60 * 60 * 1000 : 60_000,
  }));
  if (!result.ok) {
    throw new Error("Unable to fingerprint a confirmation content input");
  }

  const output = result.stdout.trim();
  if (output === "missing") {
    return { ...input, state: "missing" };
  }
  if (output === "not-file" || output === "not-directory") {
    return { ...input, state: output };
  }
  const match = new RegExp(`^${input.kind}:([a-fA-F0-9]{64})$`).exec(output);
  if (!match) {
    throw new Error("Unable to fingerprint a confirmation content input");
  }
  return {
    ...input,
    state: input.kind,
    sha256: match[1]!.toLowerCase(),
  };
}

function hashLocalFile(path: string): string {
  const hash = createHash("sha256");
  hashFileInto(hash, path);
  return hash.digest("hex");
}

function hashFileInto(hash: ReturnType<typeof createHash>, path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error("Confirmation content input changed while it was fingerprinted");
    }
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let bytesRead = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) {
        break;
      }
      hash.update(buffer.subarray(0, count));
      bytesRead += count;
    }
    if (bytesRead !== stats.size) {
      throw new Error("Confirmation content input changed while it was fingerprinted");
    }
  } catch {
    throw new Error("Unable to fingerprint a confirmation content input");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The fingerprint result or safe error remains authoritative.
      }
    }
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
