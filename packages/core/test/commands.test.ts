import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ShellCommandExecutor, shellQuote } from "../src/index.js";
import { waitForCommand } from "../src/operations/commands.js";
import { ConfigSchema, resolveProfile } from "../src/validation.js";

function createTempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "local-ydb-wait-for-command-"));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true })
  };
}

describe("waitForCommand", () => {
  it("retries retryable failures until a later attempt succeeds", async () => {
    const tempDir = createTempDir();
    try {
      const counterFile = join(tempDir.path, "counter");
      const command = [
        `count=$(cat ${shellQuote(counterFile)} 2>/dev/null || printf 0)`,
        "count=$((count + 1))",
        `printf '%s' \"$count\" > ${shellQuote(counterFile)}`,
        "if [ \"$count\" -lt 3 ]; then",
        "  printf '%s\\n' 'Status: UNAVAILABLE' >&2",
        "  exit 7",
        "fi",
        "printf '%s\\n' ready"
      ].join("\n");
      const spec = waitForCommand(command, "Retry until ready", "Status:[[:space:]]*UNAVAILABLE", {
        maxAttempts: 3,
        retryDelaySeconds: 0,
        timeoutMs: 5_000
      });

      const executor = new ShellCommandExecutor();
      const profile = resolveProfile(ConfigSchema.parse({}));
      const result = await executor.run(profile, spec);

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("ready");
      expect(readFileSync(counterFile, "utf8")).toBe("3");
    } finally {
      tempDir.cleanup();
    }
  });

  it("returns immediately on a non-retryable failure", async () => {
    const tempDir = createTempDir();
    try {
      const counterFile = join(tempDir.path, "counter");
      const command = [
        `count=$(cat ${shellQuote(counterFile)} 2>/dev/null || printf 0)`,
        "count=$((count + 1))",
        `printf '%s' \"$count\" > ${shellQuote(counterFile)}`,
        "printf '%s\\n' 'fatal parse error' >&2",
        "exit 2"
      ].join("\n");
      const spec = waitForCommand(command, "Fail fast", "Status:[[:space:]]*UNAVAILABLE", {
        maxAttempts: 3,
        retryDelaySeconds: 0,
        timeoutMs: 5_000
      });

      const executor = new ShellCommandExecutor();
      const profile = resolveProfile(ConfigSchema.parse({}));
      const result = await executor.run(profile, spec);

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("fatal parse error");
      expect(readFileSync(counterFile, "utf8")).toBe("1");
    } finally {
      tempDir.cleanup();
    }
  });

  it("preserves the last exit code after retry exhaustion", async () => {
    const tempDir = createTempDir();
    try {
      const counterFile = join(tempDir.path, "counter");
      const command = [
        `count=$(cat ${shellQuote(counterFile)} 2>/dev/null || printf 0)`,
        "count=$((count + 1))",
        `printf '%s' \"$count\" > ${shellQuote(counterFile)}`,
        "printf '%s\\n' 'Status: UNAVAILABLE' >&2",
        "exit 7"
      ].join("\n");
      const spec = waitForCommand(command, "Exhaust retries", "Status:[[:space:]]*UNAVAILABLE", {
        maxAttempts: 3,
        retryDelaySeconds: 0,
        timeoutMs: 5_000
      });

      const executor = new ShellCommandExecutor();
      const profile = resolveProfile(ConfigSchema.parse({}));
      const result = await executor.run(profile, spec);

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toContain("Status: UNAVAILABLE");
      expect(readFileSync(counterFile, "utf8")).toBe("3");
    } finally {
      tempDir.cleanup();
    }
  });
});
