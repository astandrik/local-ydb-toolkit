import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import {
  LocalYdbApiClient,
  bash,
  shellQuote,
  type CommandResult,
} from "../api-client.js";
import { redactText } from "../auth.js";
import { confirmationScopedId } from "../confirmation.js";
import { pathRedactions } from "../redactions.js";
import { runMutating } from "./execution.js";
import type {
  MutatingOptions,
  OperationResponse,
  ToolkitContext,
} from "./types.js";

const COMPOSITE_AUTH_PATH_PREFIX = "/tmp/local-ydb-toolkit-composite-auth-";

export const COMPOSITE_AUTH_CLEANUP_FAILURE = "Private composite auth artifacts could not be removed.";
const DESTINATION_VALIDATION_FAILURE = "Composite auth artifact destinations must be distinct and accessible.";

export interface CompositeAuthArtifacts {
  context: ToolkitContext;
  validateDestinations(): Promise<void>;
  persist(options: MutatingOptions): Promise<OperationResponse>;
  redact(text: string): string;
  redactResults(results: CommandResult[]): void;
  remove(): Promise<boolean>;
}

export function createCompositeAuthArtifacts(
  confirmationContext: ToolkitContext,
  executionContext: ToolkitContext,
  rotatingScope: unknown,
): CompositeAuthArtifacts {
  const canonical = confirmationContext.profile;
  const canonicalAuthConfigPath = canonical.authConfigPath;
  const canonicalDynamicTokenPath = canonical.dynamicNodeAuthTokenFile;
  const canonicalRootPasswordPath = canonical.rootPasswordFile;
  if (!canonicalAuthConfigPath || !canonicalDynamicTokenPath || !canonicalRootPasswordPath) {
    throw new Error("Composite auth artifacts require all configured auth paths.");
  }
  const canonicalDestinations = [
    canonicalAuthConfigPath,
    canonicalDynamicTokenPath,
    canonicalRootPasswordPath,
  ].map((path) => resolve(path));
  if (new Set(canonicalDestinations).size !== canonicalDestinations.length) {
    throw new Error("Composite auth artifact destinations must be distinct.");
  }

  const scopedId = confirmationScopedId(confirmationContext, rotatingScope)
    ?? randomBytes(16).toString("base64url");
  const privateRoot = `${COMPOSITE_AUTH_PATH_PREFIX}${scopedId}`;
  const privateAuthConfigPath = `${privateRoot}/config.yaml`;
  const privateDynamicTokenPath = `${privateRoot}/dynamic-token.txt`;
  const privateRootPasswordPath = `${privateRoot}/root.password`;
  const profile = {
    ...executionContext.profile,
    authConfigPath: privateAuthConfigPath,
    dynamicNodeAuthTokenFile: privateDynamicTokenPath,
    rootPasswordFile: privateRootPasswordPath,
  };
  const context: ToolkitContext = {
    ...executionContext,
    profile,
    client: new LocalYdbApiClient(profile, executionContext.client.executor),
  };
  const redactions = pathRedactions(
    privateRoot,
    privateAuthConfigPath,
    privateDynamicTokenPath,
    privateRootPasswordPath,
    canonicalAuthConfigPath,
    canonicalDynamicTokenPath,
    canonicalRootPasswordPath,
  );
  const redact = (text: string) => redactText(text, redactions);
  // Run on the execution host: lexical paths alone miss symlink/hardlink aliases.
  // Ruby is already required by composite auth generation. No file bytes are read.
  const destinationCheck = `ruby -e ${shellQuote(`
def destination(path, remaining = 64)
  raise if remaining == 0
  File.realpath(path)
rescue Errno::ENOENT
  if File.symlink?(path)
    link = File.readlink(path)
    return destination(link.start_with?("/") ? link : File.join(File.dirname(path), link), remaining - 1)
  end
  parent = File.dirname(path)
  raise if parent == path
  File.expand_path(File.basename(path), destination(parent, remaining - 1))
end
begin
  paths = ARGV.map { |path| destination(path) }
  raise unless paths.uniq.length == paths.length
  identities = paths.map do |path|
    begin
      stat = File.stat(path)
      raise unless stat.file?
      [stat.dev, stat.ino]
    rescue Errno::ENOENT
      nil
    end
  end.compact
  raise unless identities.uniq.length == identities.length
rescue StandardError
  warn ${JSON.stringify(DESTINATION_VALIDATION_FAILURE)}
  exit 1
end
`)} -- ${[canonicalAuthConfigPath, canonicalDynamicTokenPath, canonicalRootPasswordPath].map(shellQuote).join(" ")}`;

  return {
    context,
    async validateDestinations() {
      try {
        const result = await executionContext.client.run(bash(destinationCheck, {
          timeoutMs: 10_000,
          description: "Validate distinct composite auth destinations",
          redactions,
        }));
        if (result.ok) {
          return;
        }
      } catch {
        // Filesystem and transport details are not part of the public error.
      }
      throw new Error(DESTINATION_VALIDATION_FAILURE);
    },
    persist: (options) => runMutating(context, {
      summary: "Persist generated auth artifacts after private preparation.",
      risk: "high",
      specs: [bash([
        "set -euo pipefail",
        "umask 077",
        destinationCheck,
        `[ -f ${shellQuote(privateAuthConfigPath)} ]`,
        `[ -f ${shellQuote(privateDynamicTokenPath)} ]`,
        `[ -f ${shellQuote(privateRootPasswordPath)} ]`,
        `install -d -m 0700 ${shellQuote(dirname(canonicalAuthConfigPath))}`,
        `install -d -m 0700 ${shellQuote(dirname(canonicalDynamicTokenPath))}`,
        `install -d -m 0700 ${shellQuote(dirname(canonicalRootPasswordPath))}`,
        `cat ${shellQuote(privateAuthConfigPath)} > ${shellQuote(canonicalAuthConfigPath)}`,
        `cat ${shellQuote(privateDynamicTokenPath)} > ${shellQuote(canonicalDynamicTokenPath)}`,
        `cat ${shellQuote(privateRootPasswordPath)} > ${shellQuote(canonicalRootPasswordPath)}`,
        `chmod 0600 ${shellQuote(canonicalAuthConfigPath)} ${shellQuote(canonicalDynamicTokenPath)} ${shellQuote(canonicalRootPasswordPath)}`,
      ].join("\n"), {
        timeoutMs: 60_000,
        description: "Persist privately generated auth artifacts",
        redactions,
      })],
      rollback: ["Restore the previous host auth artifacts from a trusted backup."],
      verification: ["The configured auth artifact files contain the privately generated bytes."],
    }, options),
    redact,
    redactResults: (results) => {
      for (const result of results) {
        result.command = redact(result.command);
        result.stdout = redact(result.stdout);
        result.stderr = redact(result.stderr);
      }
    },
    remove: async () => {
      try {
        const result = await context.client.run(bash(`rm -rf ${shellQuote(privateRoot)}`, {
          timeoutMs: 60_000,
          description: "Remove private composite auth artifacts",
          redactions: pathRedactions(privateRoot),
        }));
        return result.ok;
      } catch {
        return false;
      }
    },
  };
}
