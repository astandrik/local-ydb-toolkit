import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bash, ShellCommandExecutor, shellQuote } from "../src/index.js";
import {
  commandForStaticCompatibilityCheck,
  commandForStaticEnsureRun,
  commandForStaticRun,
  waitForCommand
} from "../src/operations/commands.js";
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

interface StaticContainerFixture {
  exists: string;
  state: string;
  imageReference: string;
  imageId: string;
  containerImageId: string;
  network: string;
  mount: string;
  portCount: string;
  staticGrpcBinding: string;
  dynamicGrpcBinding: string;
  monitoringBinding: string;
  environment: string;
  restartPolicy: string;
  healthcheck: string;
  failAspect: string;
}

const DEFAULT_TENANT_ENVIRONMENT = [
  "GRPC_PORT=2136",
  "MON_PORT=8765",
  "GRPC_TLS_PORT=",
  "YDB_GRPC_ENABLE_TLS=0",
  "YDB_ANONYMOUS_CREDENTIALS=1",
  "YDB_LOCAL_SURVIVE_RESTART=1",
  "YDB_FEATURE_FLAGS=enable_graph_shard"
];

const STATIC_MISMATCH_CASES: Array<[string, Partial<StaticContainerFixture>]> = [
  ["image reference", { imageReference: "ghcr.io/ydb-platform/local-ydb:stale" }],
  ["image ID", { containerImageId: "sha256:stale-image" }],
  ["data mount", { mount: "volume|stale-ydb-data|/ydb_data|true" }],
  ["data mount", { mount: "bind|ydb-local-data|/ydb_data|true" }],
  ["data mount", { mount: "volume|ydb-local-data|/ydb_data|false" }],
  ["network", { network: "stale-network" }],
  ["published ports", { portCount: "4" }],
  ["published ports", { staticGrpcBinding: "0.0.0.0:2136" }],
  ["published ports", { staticGrpcBinding: "127.0.0.1:2136\n127.0.0.1:9999" }],
  ["published ports", { monitoringBinding: "127.0.0.1:9999" }],
  ["environment", { environment: "MON_PORT=8765" }],
  ["environment", { environment: [...DEFAULT_TENANT_ENVIRONMENT, "GRPC_PORT=9999"].join("\n") }],
  ["restart policy", { restartPolicy: "no" }],
  ["healthcheck", { healthcheck: "CMD" }]
];

async function runStaticEnsureCase(options: {
  fixture?: Partial<StaticContainerFixture>;
  profileOverrides?: Record<string, unknown>;
  checkOnly?: boolean;
} = {}) {
  const tempDir = createTempDir();
  try {
    const dockerLog = join(tempDir.path, "docker.log");
    const injectionMarker = join(tempDir.path, "inspect-output-was-executed");
    const profile = resolveProfile(ConfigSchema.parse({
      profiles: { default: options.profileOverrides ?? {} }
    }));
    const fixture: StaticContainerFixture = {
      exists: "true",
      state: "false",
      imageReference: profile.image,
      imageId: "sha256:current-image",
      containerImageId: "sha256:current-image",
      network: profile.network,
      mount: profile.bindMountPath
        ? `bind|${profile.bindMountPath}|/ydb_data|true`
        : `volume|${profile.volume}|/ydb_data|true`,
      portCount: String(profile.dynamicNodeCount + 2),
      staticGrpcBinding: `127.0.0.1:${profile.ports.staticGrpc}`,
      dynamicGrpcBinding: `127.0.0.1:${profile.ports.dynamicGrpc}`,
      monitoringBinding: `127.0.0.1:${profile.ports.monitoring}`,
      environment: [
        `GRPC_PORT=${profile.ports.staticGrpc}`,
        "MON_PORT=8765",
        "GRPC_TLS_PORT=",
        "YDB_GRPC_ENABLE_TLS=0",
        "YDB_ANONYMOUS_CREDENTIALS=1",
        "YDB_LOCAL_SURVIVE_RESTART=1",
        "YDB_FEATURE_FLAGS=enable_graph_shard"
      ].join("\n"),
      restartPolicy: "unless-stopped",
      healthcheck: "NONE",
      failAspect: "",
      ...options.fixture
    };
    fixture.mount = fixture.mount.replace("<INJECTION_MARKER>", injectionMarker);
    const fixtureExports = Object.entries(fixture)
      .map(([name, value]) => `export FAKE_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}=${shellQuote(value)}`);
    const dockerFunction = `docker() {
printf '%s\\n' "$*" >> ${shellQuote(dockerLog)}
if [ "$1" = "ps" ]; then
  [ "$FAKE_FAIL_ASPECT" != "container inspection" ] || return 1
  [ "$FAKE_EXISTS" != "true" ] || printf '%s\\n' ydb-local
  return 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  [ "$FAKE_FAIL_ASPECT" != "image ID" ] || return 1
  printf '%s\\n' "$FAKE_IMAGE_ID"
  return 0
fi
if [ "$1" = "inspect" ]; then
  if [[ "$*" == *"{{.Config.Image}}"* ]]; then
    [ "$FAKE_FAIL_ASPECT" != "image reference" ] || return 1
    printf '%s\\n' "$FAKE_IMAGE_REFERENCE"
  elif [[ "$*" == *"{{.Image}}"* ]]; then
    [ "$FAKE_FAIL_ASPECT" != "image ID" ] || return 1
    printf '%s\\n' "$FAKE_CONTAINER_IMAGE_ID"
  elif [[ "$*" == *"NetworkMode"* ]]; then
    [ "$FAKE_FAIL_ASPECT" != "network" ] || return 1
    printf '%s\\n' "$FAKE_NETWORK"
  elif [[ "$*" == *".Mounts"* ]]; then
    [ "$FAKE_FAIL_ASPECT" != "data mount" ] || return 1
    printf '%s\\n' "$FAKE_MOUNT"
  elif [[ "$*" == *"len .HostConfig.PortBindings"* ]]; then
    [ "$FAKE_FAIL_ASPECT" != "published ports" ] || return 1
    printf '%s\\n' "$FAKE_PORT_COUNT"
  elif [[ "$*" == *'PortBindings "2136/tcp"'* ]]; then
    printf '%s\\n' "$FAKE_STATIC_GRPC_BINDING"
  elif [[ "$*" == *'PortBindings "2137/tcp"'* ]]; then
    printf '%s\\n' "$FAKE_DYNAMIC_GRPC_BINDING"
  elif [[ "$*" == *'PortBindings "8765/tcp"'* ]]; then
    printf '%s\\n' "$FAKE_MONITORING_BINDING"
  elif [[ "$*" == *'PortBindings "'* ]]; then
    port=$(printf '%s\\n' "$*" | grep -o '[0-9][0-9]*/tcp' | head -n 1 | cut -d/ -f1)
    [ -n "$port" ] || return 98
    printf '127.0.0.1:%s\\n' "$port"
  elif [[ "$*" == *".Config.Env"* ]]; then
    [ "$FAKE_FAIL_ASPECT" != "environment" ] || return 1
    printf '%s\\n' "$FAKE_ENVIRONMENT"
  elif [[ "$*" == *"RestartPolicy.Name"* ]]; then
    [ "$FAKE_FAIL_ASPECT" != "restart policy" ] || return 1
    printf '%s\\n' "$FAKE_RESTART_POLICY"
  elif [[ "$*" == *".Config.Healthcheck"* ]]; then
    [ "$FAKE_FAIL_ASPECT" != "healthcheck" ] || return 1
    printf '%s\\n' "$FAKE_HEALTHCHECK"
  elif [[ "$*" == *".State.Running"* ]]; then
    [ "$FAKE_FAIL_ASPECT" != "running state" ] || return 1
    printf '%s\\n' "$FAKE_STATE"
  else
    printf '%s\\n' "unexpected inspect invocation: $*" >&2
    return 97
  fi
  return 0
fi
if [ "$1" = "start" ] && [ "$2" = "ydb-local" ]; then
  return 0
fi
printf '%s\\n' "unexpected docker invocation: $*" >&2
return 99
}`;

    const executor = new ShellCommandExecutor();
    const script = [
      ...fixtureExports,
      dockerFunction,
      options.checkOnly
        ? commandForStaticCompatibilityCheck(profile, {
            requireGraphShard: true,
            publishedDynamicGrpcPorts: Array.from(
              { length: profile.dynamicNodeCount },
              (_, offset) => profile.ports.dynamicGrpc + offset
            )
          })
        : commandForStaticEnsureRun(profile, {
            enableGraphShard: true,
            requireGraphShard: true,
            publishedDynamicGrpcPorts: Array.from(
              { length: profile.dynamicNodeCount },
              (_, offset) => profile.ports.dynamicGrpc + offset
            )
          })
    ].join("\n");
    const result = await executor.run(profile, bash(script));
    const invocations = readFileSync(dockerLog, "utf8").trim().split("\n");
    return {
      result,
      invocations,
      injectionMarkerCreated: existsSync(injectionMarker)
    };
  } finally {
    tempDir.cleanup();
  }
}

function runStaticCompatibilityCase(options: {
  fixture?: Partial<StaticContainerFixture>;
  profileOverrides?: Record<string, unknown>;
} = {}) {
  return runStaticEnsureCase({ ...options, checkOnly: true });
}

describe("commandForStaticCompatibilityCheck", () => {
  it.each([1, 3, 11])("validates all %i configured dynamic gRPC bindings without lifecycle commands", (dynamicNodeCount) => {
    const profile = resolveProfile(ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount } }
    }));
    const publishedDynamicGrpcPorts = Array.from(
      { length: dynamicNodeCount },
      (_, offset) => profile.ports.dynamicGrpc + offset
    );

    const command = commandForStaticCompatibilityCheck(profile, {
      requireGraphShard: true,
      publishedDynamicGrpcPorts
    });

    for (const port of publishedDynamicGrpcPorts) {
      expect(command).toContain(`PortBindings \"${port}/tcp\"`);
    }
    expect(command).toContain("{{len .HostConfig.PortBindings}}");
    expect(command).toContain(`!= ${dynamicNodeCount + 2}`);
    expect(command).not.toMatch(/^\s*docker (?:run|start|stop|rm)\b/m);
  });

  it.each(["true", "false"])("accepts a compatible container with Running=%s without changing its state", async (state) => {
    const response = await runStaticCompatibilityCase({ fixture: { state } });

    expect(response.result.ok).toBe(true);
    expect(response.invocations.some((invocation) => /^(?:run|start|stop|rm)\b/.test(invocation))).toBe(false);
  });

  it("fails when the static container is missing without creating it", async () => {
    const response = await runStaticCompatibilityCase({ fixture: { exists: "false" } });

    expect(response.result.ok).toBe(false);
    expect(response.result.stderr).toContain("does not match profile container inspection");
    expect(response.invocations.some((invocation) => /^(?:run|start|stop|rm)\b/.test(invocation))).toBe(false);
  });

  it("rejects bindings from a smaller configured topology without changing the container", async () => {
    const response = await runStaticCompatibilityCase({
      profileOverrides: { dynamicNodeCount: 3 },
      fixture: { portCount: "3" }
    });

    expect(response.result.ok).toBe(false);
    expect(response.result.stderr).toContain("does not match profile published ports");
    expect(response.invocations.some((invocation) => /^(?:run|start|stop|rm)\b/.test(invocation))).toBe(false);
  });
});

describe("commandForStaticEnsureRun", () => {
  it.each([1, 3, 11])("publishes and validates all %i configured dynamic gRPC ports", (dynamicNodeCount) => {
    const profile = resolveProfile(ConfigSchema.parse({
      profiles: { default: { dynamicNodeCount } }
    }));
    const publishedDynamicGrpcPorts = Array.from(
      { length: dynamicNodeCount },
      (_, offset) => profile.ports.dynamicGrpc + offset
    );
    const runCommand = commandForStaticRun(profile, { publishedDynamicGrpcPorts });
    const ensureCommand = commandForStaticEnsureRun(profile, { publishedDynamicGrpcPorts });

    for (const port of publishedDynamicGrpcPorts) {
      expect(runCommand).toContain(`127.0.0.1:${port}:${port}`);
      expect(ensureCommand).toContain(`PortBindings \"${port}/tcp\"`);
    }
    expect(ensureCommand).toContain(`{{len .HostConfig.PortBindings}}`);
    expect(ensureCommand).toContain(`!= ${dynamicNodeCount + 2}`);
  });

  it.each([
    ["running", "true", false],
    ["stopped", "false", true]
  ])("reuses a compatible %s container", async (_label, state, starts) => {
    const response = await runStaticEnsureCase({ fixture: { state } });

    expect(response.result.ok).toBe(true);
    expect(response.invocations.some((invocation) => invocation.startsWith("start "))).toBe(starts);
  });

  it.each(STATIC_MISMATCH_CASES)(
    "rejects a stopped container with mismatched %s",
    async (aspect, fixture) => {
      const response = await runStaticEnsureCase({ fixture });

      expect(response.result.ok).toBe(false);
      expect(response.result.stderr).toContain(`does not match profile ${aspect}`);
      expect(response.result.stderr).toContain("Recreate it with local_ydb_destroy_stack");
      expect(response.invocations.some((invocation) => invocation.startsWith("start "))).toBe(false);
    }
  );

  it("validates bind mount source, type, and RW state", async () => {
    const response = await runStaticEnsureCase({
      profileOverrides: { bindMountPath: "/srv/local-ydb-data" },
      fixture: { mount: "bind|/srv/other-data|/ydb_data|true" }
    });

    expect(response.result.ok).toBe(false);
    expect(response.result.stderr).toContain("does not match profile data mount");
    expect(response.invocations.some((invocation) => invocation.startsWith("start "))).toBe(false);
  });

  it("requires GraphShard for tenant bootstrap reuse", async () => {
    const response = await runStaticEnsureCase({
      fixture: {
        environment: [
          "GRPC_PORT=2136",
          "MON_PORT=8765",
          "GRPC_TLS_PORT=",
          "YDB_GRPC_ENABLE_TLS=0",
          "YDB_ANONYMOUS_CREDENTIALS=1",
          "YDB_LOCAL_SURVIVE_RESTART=1"
        ].join("\n")
      }
    });

    expect(response.result.ok).toBe(false);
    expect(response.result.stderr).toContain("does not match profile GraphShard environment");
  });

  it("rejects a static container created for a smaller configured topology", async () => {
    const response = await runStaticEnsureCase({
      profileOverrides: { dynamicNodeCount: 3 },
      fixture: { portCount: "3" }
    });

    expect(response.result.ok).toBe(false);
    expect(response.result.stderr).toContain("does not match profile published ports");
    expect(response.invocations.some((invocation) => invocation.startsWith("start "))).toBe(false);
  });

  it("checks every required static environment value", () => {
    const profile = resolveProfile(ConfigSchema.parse({}));
    const script = commandForStaticEnsureRun(profile, {
      enableGraphShard: true,
      requireGraphShard: true,
      publishedDynamicGrpcPorts: [profile.ports.dynamicGrpc]
    });

    for (const entry of DEFAULT_TENANT_ENVIRONMENT) {
      expect(script).toContain(entry);
    }
  });

  it.each([
    "container inspection",
    "image ID",
    "data mount"
  ])("fails closed when %s inspection fails", async (aspect) => {
    const response = await runStaticEnsureCase({ fixture: { failAspect: aspect } });

    expect(response.result.ok).toBe(false);
    expect(response.result.stderr).toContain(`does not match profile ${aspect}`);
    expect(response.invocations.some((invocation) => invocation.startsWith("start "))).toBe(false);
  });

  it("does not execute data returned by docker inspect", async () => {
    const response = await runStaticEnsureCase({
      fixture: { mount: "volume|$(touch <INJECTION_MARKER>)|/ydb_data|true" }
    });

    expect(response.result.ok).toBe(false);
    expect(response.injectionMarkerCreated).toBe(false);
    expect(response.result.stderr).not.toContain("touch");
  });
});
