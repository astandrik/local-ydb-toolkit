import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bash, ShellCommandExecutor, shellQuote } from "../src/index.js";
import { commandForStaticEnsureRun, waitForCommand } from "../src/operations/commands.js";
import { ConfigSchema, resolveProfile } from "../src/validation.js";

function createTempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "local-ydb-wait-for-command-"));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true })
  };
}

describe("waitForCommand", () => {
  it("does not spawn a command for a pre-aborted signal", () => {
    const controller = new AbortController();
    controller.abort(new Error("test pre-abort"));
    const executor = new ShellCommandExecutor();
    const profile = resolveProfile(ConfigSchema.parse({}));

    expect(() => executor.run(profile, {
      command: "command-that-must-not-spawn",
      signal: controller.signal,
    })).toThrow("test pre-abort");
  });

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

describe("commandForStaticEnsureRun", () => {
  it("starts a compatible stopped container from its stored port bindings", async () => {
    const tempDir = createTempDir();
    try {
      const dockerLog = join(tempDir.path, "docker.log");
      const dockerPath = join(tempDir.path, "docker");
      writeFileSync(dockerPath, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> ${shellQuote(dockerLog)}
if [ "$1" = "inspect" ] && [[ "$*" == *".State.Running"* ]]; then
  printf '%s\\n' false
  exit 0
fi
if [ "$1" = "inspect" ] && [[ "$*" == *"HostConfig.PortBindings"* ]]; then
  printf '%s\\n' '127.0.0.1:2136'
  exit 0
fi
if [ "$1" = "inspect" ]; then
  exit 0
fi
if [ "$1" = "port" ]; then
  printf '%s\\n' 'No public port is available for a stopped container' >&2
  exit 1
fi
if [ "$1" = "start" ] && [ "$2" = "ydb-local" ]; then
  exit 0
fi
printf '%s\\n' "unexpected docker invocation: $*" >&2
exit 99
`, "utf8");
      chmodSync(dockerPath, 0o755);

      const profile = resolveProfile(ConfigSchema.parse({}));
      const executor = new ShellCommandExecutor();
      const script = [
        `export PATH=${shellQuote(tempDir.path)}:$PATH`,
        commandForStaticEnsureRun(profile, { enableGraphShard: false })
      ].join("\n");

      const result = await executor.run(profile, bash(script));

      expect(result.ok).toBe(true);
      expect(readFileSync(dockerLog, "utf8").trim().split("\n")).toEqual([
        "inspect -f {{.State.Running}} ydb-local",
        "inspect ydb-local",
        "inspect --type container --format {{range (index .HostConfig.PortBindings \"2136/tcp\")}}{{printf \"%s:%s\\n\" .HostIp .HostPort}}{{end}} ydb-local",
        "start ydb-local"
      ]);
    } finally {
      tempDir.cleanup();
    }
  });

  it("does not start a stopped container with a non-loopback stored port binding", async () => {
    const tempDir = createTempDir();
    try {
      const dockerLog = join(tempDir.path, "docker.log");
      const dockerPath = join(tempDir.path, "docker");
      writeFileSync(dockerPath, `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> ${shellQuote(dockerLog)}
if [ "$1" = "inspect" ] && [[ "$*" == *".State.Running"* ]]; then
  printf '%s\\n' false
  exit 0
fi
if [ "$1" = "inspect" ] && [[ "$*" == *"HostConfig.PortBindings"* ]]; then
  printf '%s\\n' '0.0.0.0:2136'
  exit 0
fi
if [ "$1" = "inspect" ]; then
  exit 0
fi
if [ "$1" = "start" ]; then
  printf '%s\\n' 'incompatible container must not be started' >&2
  exit 99
fi
printf '%s\\n' "unexpected docker invocation: $*" >&2
exit 98
`, "utf8");
      chmodSync(dockerPath, 0o755);

      const profile = resolveProfile(ConfigSchema.parse({}));
      const executor = new ShellCommandExecutor();
      const script = [
        `export PATH=${shellQuote(tempDir.path)}:$PATH`,
        commandForStaticEnsureRun(profile, { enableGraphShard: false })
      ].join("\n");

      const result = await executor.run(profile, bash(script));
      const invocations = readFileSync(dockerLog, "utf8").trim().split("\n");

      expect(result.ok).toBe(false);
      expect(result.stderr).toContain(
        "Existing static container ydb-local does not publish required gRPC port 127.0.0.1:2136."
      );
      expect(invocations.some((invocation) => invocation.startsWith("start "))).toBe(false);
    } finally {
      tempDir.cleanup();
    }
  });
});
