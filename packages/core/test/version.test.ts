import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandToShell,
  createContext,
  listVersions,
  parseImageReference,
  ProcessConfirmationStore,
  replaceImageTag,
  upgradeVersion,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  type ResolvedLocalYdbProfile,
  type ToolkitContext,
} from "../src/index.js";
import { MANUAL_PROFILE_IMAGE_UPDATE_ERROR } from "../src/operations/profile-image-config.js";
import { ConfigSchema } from "../src/validation.js";

class RecordingExecutor implements CommandExecutor {
  readonly commands: string[] = [];

  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    const command = this.display(profile, spec);
    this.commands.push(command);
    return {
      command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      ok: true,
      timedOut: false
    };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

async function withRunTimers<T>(operation: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const pending = operation();
  await vi.runAllTimersAsync();
  return pending;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

function upgradeConfig(profileOverrides: Record<string, unknown> = {}) {
  return {
    profiles: {
      default: {
        image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6",
        authConfigPath: "/tmp/local-ydb-auth/config.auth.yaml",
        dynamicContainer: "ydb-dyn-example",
        dynamicNodeAuthSid: "root@builtin",
        dynamicNodeAuthTokenFile: "/tmp/local-ydb-auth/dynamic-node-auth.pb",
        rootPasswordFile: "/tmp/local-ydb-auth/root.password",
        staticContainer: "ydb-local",
        tenantPath: "/local/example",
        ...profileOverrides
      }
    }
  };
}

function writeTempConfig(rawConfig: unknown): { configPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "local-ydb-upgrade-"));
  const configPath = join(dir, "local-ydb.config.json");
  materializeProfileFiles(rawConfig, dir);
  writeFileSync(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, "utf8");
  return {
    configPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function exactConfirmationContext(
  context: ToolkitContext,
  toolName = "local_ydb_upgrade_version",
): ToolkitContext {
  return {
    ...context,
    confirmation: {
      store: new ProcessConfirmationStore(),
      toolName,
      configSource: {
        kind: "argument",
        path: context.configPath,
        contentSha256: "test-config-content",
      },
    },
  };
}

function materializeProfileFiles(rawConfig: unknown, dir: string): void {
  const profiles = (rawConfig as { profiles?: Record<string, Record<string, unknown>> }).profiles;
  for (const [name, profile] of Object.entries(profiles ?? {})) {
    const profileDir = join(dir, name);
    mkdirSync(profileDir, { recursive: true });
    profile.dumpHostPath = join(profileDir, "dumps");
    mkdirSync(profile.dumpHostPath as string, { recursive: true });
    for (const [field, basename, content] of [
      ["authConfigPath", "config.auth.yaml", "domains_config: {}\n"],
      ["dynamicNodeAuthTokenFile", "dynamic-node-auth.pb", "StaffApiUserToken: \"root@builtin\"\n"],
      ["rootPasswordFile", "root.password", "test-password\n"],
    ] as const) {
      if (typeof profile[field] === "string") {
        const path = join(profileDir, basename);
        profile[field] = path;
        writeFileSync(path, content, { mode: 0o600 });
      }
    }
  }
}

function stubUpgradeExecutor(
  executor: RecordingExecutor,
  inventoryImage: string,
  options: {
    failDockerPsCall?: number;
    containerNames?: string[];
    inspectedNodes?: unknown[];
    nodePorts?: number[];
    onFirstRequiredImage?: () => void;
    lateContainer?: string;
    realContentSnapshots?: boolean;
    afterCompositeSnapshot?: () => void;
    captureRestoredContent?: (content: string) => void;
    dumpContent?: string;
    dumpSymlink?: boolean;
    captureCompositeRoot?: (path: string) => void;
    throwOnFirstDestroy?: boolean;
    afterAuthPersist?: () => void;
    captureAppliedAuth?: (content: string) => void;
    captureAuthRoot?: (path: string) => void;
    failAuthPersist?: boolean;
  } = {}
): void {
  let dockerPsCalls = 0;
  let acceptedMutationStarted = false;
  let destroyThrown = false;
  executor.run = async (_profile, spec) => {
    if (spec.description?.startsWith("Fingerprint ")) {
      if (options.realContentSnapshots) {
        return runSpecSynchronously(executor, _profile, spec);
      }
      return {
        command: executor.display(_profile, spec),
        exitCode: 0,
        stdout: `directory:${"a".repeat(64)}\n`,
        stderr: "",
        ok: true,
        timedOut: false,
      };
    }
    if (
      spec.description === "Prepare confirmed content snapshots"
      || spec.description === "Remove confirmed content snapshots"
    ) {
      if (options.realContentSnapshots) {
        return runSpecSynchronously(executor, _profile, spec);
      }
      return {
        command: executor.display(_profile, spec),
        exitCode: 0,
        stdout: "",
        stderr: "",
        ok: true,
        timedOut: false,
      };
    }
    if (spec.description === "Prepare private verified composite dump snapshot") {
      const snapshotRoot = /snapshot_root=([A-Za-z0-9_./-]+)/.exec(spec.args?.[1] ?? "")?.[1];
      if (snapshotRoot) {
        options.captureCompositeRoot?.(snapshotRoot);
      }
      const result = runSpecSynchronously(executor, _profile, spec);
      if (result.ok) {
        options.afterCompositeSnapshot?.();
      }
      return result;
    }
    if (spec.description === "Remove private composite dump snapshot") {
      return runSpecSynchronously(executor, _profile, spec);
    }
    if (spec.description === "Remove private composite auth artifacts") {
      return runSpecSynchronously(executor, _profile, spec);
    }
    const command = executor.display(_profile, spec);
    executor.commands.push(command);
    const rawScript = spec.args?.[1] ?? "";
    const authRoot = /\/tmp\/local-ydb-toolkit-composite-auth-[A-Za-z0-9_-]+/.exec(rawScript)?.[0];

    if (authRoot && rawScript.includes("ruby -ryaml -e")) {
      options.captureAuthRoot?.(authRoot);
      mkdirSync(authRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(authRoot, "config.yaml"), "BENIGN_GENERATED_AUTH\n", { mode: 0o600 });
      writeFileSync(join(authRoot, "root.password"), "BENIGN_GENERATED_ROOT\n", { mode: 0o600 });
    }
    if (authRoot && rawScript.includes("StaffApiUserToken")) {
      mkdirSync(authRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(authRoot, "dynamic-token.txt"), "BENIGN_GENERATED_DYNAMIC\n", { mode: 0o600 });
    }
    if (spec.description === "Persist privately generated auth artifacts") {
      if (options.failAuthPersist) {
        return {
          command,
          exitCode: 1,
          stdout: "",
          stderr: "BENIGN_PRIVATE_AUTH_PERSIST_FAILURE",
          ok: false,
          timedOut: false,
        };
      }
      const persisted = runSpecSynchronously(executor, _profile, spec);
      if (persisted.ok) {
        options.afterAuthPersist?.();
      }
      return persisted;
    }
    if (spec.description === "Copy confirmed auth config snapshot into the static container") {
      const snapshot = /confirmed_config_snapshot=([A-Za-z0-9_./-]+)/.exec(rawScript)?.[1];
      if (snapshot && existsSync(snapshot)) {
        options.captureAppliedAuth?.(readFileSync(snapshot, "utf8"));
      }
    }

    if (options.throwOnFirstDestroy && !destroyThrown && command.includes("docker rm -f")) {
      destroyThrown = true;
      throw new Error("BENIGN_SYNTHETIC_COMPOSITE_ABORT");
    }

    if (spec.description?.startsWith("Require Docker image") && !acceptedMutationStarted) {
      acceptedMutationStarted = true;
      options.onFirstRequiredImage?.();
    }

    if (command.includes(" tools dump ")) {
      const dumpName = /-o \/dump\/([^/]+)\/tenant/.exec(command)?.[1];
      if (dumpName) {
        const tenantDump = join(_profile.dumpHostPath, dumpName, "tenant");
        mkdirSync(tenantDump, { recursive: true });
        const dataPath = join(tenantDump, "data.csv");
        if (options.dumpSymlink) {
          const outside = join(_profile.dumpHostPath, `${dumpName}-outside.csv`);
          writeFileSync(outside, options.dumpContent ?? "1,test\n", "utf8");
          symlinkSync(outside, dataPath);
        } else {
          writeFileSync(dataPath, options.dumpContent ?? "1,test\n", "utf8");
        }
      }
    }

    if (spec.command === "docker" && spec.args?.[0] === "ps") {
      dockerPsCalls += 1;
      if (dockerPsCalls === options.failDockerPsCall) {
        return {
          command,
          exitCode: 1,
          stdout: "",
          stderr: "private final inventory failure",
          ok: false,
          timedOut: false
        };
      }
      const containerNames = [
        ...(options.lateContainer && acceptedMutationStarted ? [options.lateContainer] : []),
        ...(options.containerNames ?? [
        "ydb-dyn-example-2",
        "ydb-dyn-example",
        "ydb-local"
        ]),
      ];
      return {
        command,
        exitCode: 0,
        stdout: containerNames
          .map((Names) => JSON.stringify({ Names, Image: inventoryImage }))
          .join("\n"),
        stderr: "",
        ok: true,
        timedOut: false
      };
    }
    if (command.includes("docker volume ls")) {
      return { command, exitCode: 0, stdout: "ydb-local-data\n", stderr: "", ok: true, timedOut: false };
    }
    if (command.includes("{{.RestartCount}}")) {
      return { command, exitCode: 0, stdout: "container-id\ttrue\tfalse\t0", stderr: "", ok: true, timedOut: false };
    }
    if (command.includes("docker inspect")) {
      return {
        command,
        exitCode: 0,
        stdout: JSON.stringify(options.inspectedNodes ?? [
          { Id: "reviewed-ydb-dyn-example-2-id", Name: "/ydb-dyn-example-2", Args: ["--grpc-port", "2138", "--mon-port", "8767", "--ic-port", "19003"] },
          { Id: "reviewed-ydb-dyn-example-4-id", Name: "/ydb-dyn-example-4", Args: ["--grpc-port", "2140", "--mon-port", "8769", "--ic-port", "19005"] }
        ]),
        stderr: "",
        ok: true,
        timedOut: false
      };
    }
    if (command.includes("viewer/json/nodelist")) {
      return {
        command,
        exitCode: 0,
        stdout: JSON.stringify((options.nodePorts ?? [19002, 19003]).map((Port) => ({ Port }))),
        stderr: "",
        ok: true,
        timedOut: false
      };
    }
    if (spec.description?.startsWith("Restore from a ")) {
      const snapshot = /confirmed_restore_snapshot=([A-Za-z0-9_./-]+)/.exec(command)?.[1];
      if (snapshot) {
        options.captureRestoredContent?.(readFileSync(join(snapshot, "data.csv"), "utf8"));
      }
    }
    return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
  };
}

function runSpecSynchronously(
  executor: RecordingExecutor,
  profile: ResolvedLocalYdbProfile,
  spec: CommandSpec,
): CommandResult {
  const completed = spawnSync(spec.command, spec.args ?? [], {
    encoding: "utf8",
    input: spec.stdin,
    timeout: spec.timeoutMs,
  });
  const ok = completed.status === 0 && !completed.error;
  return {
    command: executor.display(profile, spec),
    exitCode: completed.status,
    stdout: completed.stdout ?? "",
    stderr: completed.stderr ?? completed.error?.message ?? "",
    ok,
    timedOut: completed.error?.name === "TimeoutError",
  };
}

describe("version operations", () => {
  it("parses image references and replaces tags", () => {
    expect(parseImageReference("ghcr.io/ydb-platform/local-ydb:26.1.1.6")).toEqual({
      input: "ghcr.io/ydb-platform/local-ydb:26.1.1.6",
      imageName: "ghcr.io/ydb-platform/local-ydb",
      registry: "ghcr.io",
      repository: "ydb-platform/local-ydb",
      tag: "26.1.1.6",
      digest: undefined
    });
    expect(parseImageReference("ghcr.io/ydb-platform/local-ydb:stable-26-1-1")).toMatchObject({
      imageName: "ghcr.io/ydb-platform/local-ydb",
      tag: "stable-26-1-1",
      digest: undefined
    });
    expect(parseImageReference("docker.io/ydb-platform/local-ydb").registry).toBe("docker.io");
    expect(replaceImageTag("ghcr.io/ydb-platform/local-ydb:26.1.1.6", "latest")).toBe("ghcr.io/ydb-platform/local-ydb:latest");
    expect(replaceImageTag("ghcr.io/ydb-platform/local-ydb:stable-26-1-1", "stable-26-2-1")).toBe("ghcr.io/ydb-platform/local-ydb:stable-26-2-1");
  });

  it("lists registry tags across paginated Bearer-authenticated responses", async () => {
    const requests: Array<{ url: string; auth?: string | null; redirect?: RequestInit["redirect"] }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization");
      requests.push({ url, auth, redirect: init?.redirect });

      if (url === "https://ghcr.io/v2/ydb-platform/local-ydb/tags/list?n=2" && !auth) {
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:ydb-platform/local-ydb:pull"'
          }
        });
      }
      if (url === "https://ghcr.io/token?service=ghcr.io&scope=repository%3Aydb-platform%2Flocal-ydb%3Apull") {
        return jsonResponse({ token: "secret-token" });
      }
      if (url === "https://ghcr.io/v2/ydb-platform/local-ydb/tags/list?n=2" && auth === "Bearer secret-token") {
        return jsonResponse(
          { tags: ["24.1", "26.1.1.6"] },
          { headers: { link: '</v2/ydb-platform/local-ydb/tags/list?n=2&last=26.1.1.7>; rel="next"' } }
        );
      }
      if (url === "https://ghcr.io/v2/ydb-platform/local-ydb/tags/list?n=2&last=26.1.1.7" && auth === "Bearer secret-token") {
        return jsonResponse({ tags: ["latest", "nightly", "26.1.1.7"] });
      }
      throw new Error(`Unexpected fetch request: ${url}`);
    };

    const result = await listVersions({
      image: "ghcr.io/ydb-platform/local-ydb",
      pageSize: 2,
      maxPages: 3,
      fetchImpl
    });

    expect(result.registry).toBe("ghcr.io");
    expect(result.repository).toBe("ydb-platform/local-ydb");
    expect(result.tags).toEqual(["26.1.1.7", "26.1.1.6", "24.1", "latest", "nightly"]);
    expect(result.truncated).toBe(false);
    expect(requests.map((item) => item.auth)).toEqual([
      null,
      null,
      "Bearer secret-token",
      "Bearer secret-token"
    ]);
    expect(requests.map((item) => item.redirect)).toEqual([
      "error",
      "error",
      "error",
      "error"
    ]);
  });

  it.each(["docker.io", "index.docker.io"])(
    "normalizes Docker Hub registry alias %s before fetching tags",
    async (registryAlias) => {
      const requests: Array<{ url: string; redirect?: RequestInit["redirect"] }> = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        requests.push({
          url: typeof input === "string" ? input : input.toString(),
          redirect: init?.redirect
        });
        return jsonResponse({ tags: ["latest"] });
      };
      const image = `${registryAlias}/ydb-platform/local-ydb`;

      const result = await listVersions({ image, fetchImpl });

      expect(requests).toEqual([{
        url: "https://registry-1.docker.io/v2/ydb-platform/local-ydb/tags/list?n=100",
        redirect: "error"
      }]);
      expect(result).toMatchObject({
        image,
        registry: "registry-1.docker.io",
        repository: "ydb-platform/local-ydb",
        tags: ["latest"],
        count: 1
      });
    }
  );

  it("marks the tag list as truncated when maxPages is reached", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://ghcr.io/v2/ydb-platform/local-ydb/tags/list?n=1") {
        return jsonResponse(
          { tags: ["26.1.1.6"] },
          { headers: { link: '</v2/ydb-platform/local-ydb/tags/list?n=1&last=26.1.1.6>; rel="next"' } }
        );
      }
      throw new Error(`Unexpected fetch request: ${url}`);
    };

    const result = await listVersions({
      image: "ghcr.io/ydb-platform/local-ydb",
      pageSize: 1,
      maxPages: 1,
      fetchImpl
    });

    expect(result.tags).toEqual(["26.1.1.6"]);
    expect(result.truncated).toBe(true);
  });

  it.each([
    "127.0.0.1:5000/attacker/repo",
    "docker.io.attacker.invalid/ydb-platform/local-ydb",
    "evil-docker.io/ydb-platform/local-ydb"
  ])("rejects untrusted registry %s before making a request", async (image) => {
    let requested = false;
    const fetchImpl: typeof fetch = async () => {
      requested = true;
      return jsonResponse({ tags: [] });
    };

    await expect(listVersions({
      image,
      fetchImpl
    })).rejects.toThrow("Version listing only supports trusted registries");
    expect(requested).toBe(false);
  });

  it("rejects pagination links that leave the registry origin", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(
      { tags: ["26.1.1.6"] },
      { headers: { link: '<http://127.0.0.1/metadata>; rel="next"' } }
    );

    await expect(listVersions({
      image: "ghcr.io/ydb-platform/local-ydb",
      fetchImpl
    })).rejects.toThrow("Registry pagination must remain on https://ghcr.io");
  });

  it("rejects Bearer challenge realms outside the registry trust boundary", async () => {
    const fetchImpl: typeof fetch = async () => new Response("", {
      status: 401,
      headers: {
        "www-authenticate": 'Bearer realm="http://127.0.0.1/token",service="ghcr.io"'
      }
    });

    await expect(listVersions({
      image: "ghcr.io/ydb-platform/local-ydb",
      fetchImpl
    })).rejects.toThrow("Registry authentication endpoint is not trusted: http://127.0.0.1");
  });

  it("plans a version upgrade via pull, dump, rebuild, auth reapply, and extra-node recreation", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig();
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    try {
      const ctx = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.1.6");

      const response = await upgradeVersion(ctx, { version: "26.1.2.0" });
      expect(response.executed).toBe(false);
      expect(response.targetImage).toBe("ghcr.io/ydb-platform/local-ydb:26.1.2.0");
      expect(response.authReapplyPlanned).toBe(true);
      expect(response.extraDynamicNodes).toEqual(["ydb-dyn-example-2"]);
      expect(response.profileImageUpdate).toMatchObject({
        configPath,
        profile: "default",
        sourceImage: "ghcr.io/ydb-platform/local-ydb:26.1.1.6",
        targetImage: "ghcr.io/ydb-platform/local-ydb:26.1.2.0",
        executed: false,
        ok: false
      });
      expect(response.plannedCommands[0]).toContain("docker image inspect ghcr.io/ydb-platform/local-ydb:26.1.1.6");
      expect(response.plannedCommands[1]).toContain("docker image inspect ghcr.io/ydb-platform/local-ydb:26.1.2.0");
      expect(response.plannedCommands.join("\n")).toContain("/dump/");
      expect(response.plannedCommands.join("\n")).toContain("ghcr.io/ydb-platform/local-ydb:26.1.2.0");
      expect(response.plannedCommands.join("\n")).toContain("expected_id=reviewed-ydb-dyn-example-2-id");
      expect(response.plannedCommands.join("\n")).toContain('docker rm -f "$expected_id"');
      expect(response.plannedCommands.join("\n")).toContain("--name ydb-dyn-example-2");
      expect(response.plannedCommands.join("\n")).not.toContain("profiles.default.image");
      expect(response.verification.join("\n")).toContain(`manually set profiles.default.image in ${configPath}`);
    } finally {
      cleanup();
    }
  });

  it("treats only suffixes above dynamicNodeCount as one-off nodes during upgrade", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({ dynamicNodeCount: 3 });
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    try {
      const ctx = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.1.6", {
        containerNames: [
          "ydb-dyn-example-4",
          "ydb-dyn-example-3",
          "ydb-dyn-example-2",
          "ydb-dyn-example",
          "ydb-local"
        ],
        inspectedNodes: [{
          Id: "reviewed-ydb-dyn-example-4-id",
          Name: "/ydb-dyn-example-4",
          Args: ["--grpc-port", "32004", "--mon-port", "9204", "--ic-port", "19204"]
        }]
      });

      const response = await upgradeVersion(ctx, { version: "26.1.2.0" });
      const plan = response.plannedCommands.join("\n");

      expect(response.extraDynamicNodes).toEqual(["ydb-dyn-example-4"]);
      expect(plan).toContain("--name ydb-dyn-example-2 ");
      expect(plan).toContain("--name ydb-dyn-example-3 ");
      expect(plan).toContain("--name ydb-dyn-example-4 ");
      expect(plan).toContain("-e GRPC_PORT=32004");
      expect(plan).toContain("-e MON_PORT=9204");
      expect(plan).toContain("--grpc-port 32004");
      expect(plan).toContain("--mon-port 9204");
      expect(plan).toContain("--ic-port 19204");
      for (const port of [2137, 2138, 2139]) {
        expect(plan).toContain(`127.0.0.1:${port}:${port}`);
      }
      expect(response.verification.join("\n")).toContain("ydb-dyn-example, ydb-dyn-example-2, ydb-dyn-example-3, ydb-dyn-example-4");
      expect(response.verification.join("\n")).toContain("19002, 19003, 19004, 19204");
    } finally {
      cleanup();
    }
  });

  it("rejects version upgrade before dump or destroy when one-off identity cannot be inspected", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({ dynamicNodeCount: 3 });
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    try {
      const ctx = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.1.6", {
        containerNames: [
          "ydb-dyn-example-4",
          "ydb-dyn-example-3",
          "ydb-dyn-example-2",
          "ydb-dyn-example",
          "ydb-local"
        ],
        inspectedNodes: [{
          Name: "/ydb-dyn-example-4",
          Args: ["--grpc-port", "32004", "--mon-port", "9204", "--ic-port", "19204"],
        }]
      });

      await expect(upgradeVersion(ctx, {
        confirm: true,
        version: "26.1.2.0",
        dumpName: "upgrade-smoke"
      })).rejects.toThrow(/inspect exact Docker identity and gRPC, monitoring, and IC ports.*before destructive rebuild/i);
      expect(executor.commands.some((command) => command.includes("/dump/upgrade-smoke"))).toBe(false);
      expect(executor.commands.some((command) => command.includes("docker rm -f"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("executes a version upgrade and verifies target image usage", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig();
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    try {
      const ctx = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0");

      const response = await withRunTimers(() => upgradeVersion(ctx, {
        confirm: true,
        version: "26.1.2.0",
        dumpName: "upgrade-smoke"
      }));
      expect(response.executed).toBe(true);
      expect(response.targetImage).toBe("ghcr.io/ydb-platform/local-ydb:26.1.2.0");
      expect(response.dumpName).toBe("upgrade-smoke");
      expect(response.imageVerification).toEqual({
        expectedImage: "ghcr.io/ydb-platform/local-ydb:26.1.2.0",
        missing: [],
        mismatches: []
      });
      expect(response.profileImageUpdate).toMatchObject({
        configPath,
        profile: "default",
        sourceImage: "ghcr.io/ydb-platform/local-ydb:26.1.1.6",
        targetImage: "ghcr.io/ydb-platform/local-ydb:26.1.2.0",
        executed: false,
        ok: false,
        error: MANUAL_PROFILE_IMAGE_UPDATE_ERROR
      });
      expect(response.summary).toContain("profile config was not updated automatically and requires manual action");
      const unchangedConfig = JSON.parse(readFileSync(configPath, "utf8")) as { profiles: { default: { image: string } } };
      expect(unchangedConfig.profiles.default.image).toBe("ghcr.io/ydb-platform/local-ydb:26.1.1.6");

      const commands = response.results?.map((result) => result.command) ?? [];
      expect(commands[0]).toContain("docker image inspect ghcr.io/ydb-platform/local-ydb:26.1.1.6");
      expect(commands[1]).toContain("docker image inspect ghcr.io/ydb-platform/local-ydb:26.1.2.0");
      expect(commands.some((command) => command.includes("--name ydb-local") && command.includes("ghcr.io/ydb-platform/local-ydb:26.1.2.0"))).toBe(true);
      expect(commands.some((command) => command.includes("--name ydb-dyn-example-2") && command.includes("ghcr.io/ydb-platform/local-ydb:26.1.2.0"))).toBe(true);
      expect(commands.some((command) => command.includes("verify profile containers use image ghcr.io/ydb-platform/local-ydb:26.1.2.0"))).toBe(true);
      expect(commands.some((command) => command.includes("profiles.default.image"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("executes the multi-phase upgrade only with its recalculated exact-plan token", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig();
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    try {
      chmodSync(configPath, 0o640);
      const context = createContext(
        undefined,
        executor,
        ConfigSchema.parse(rawConfig),
        configPath,
      );
      const ctx = {
        ...context,
        confirmation: {
          store: new ProcessConfirmationStore(),
          toolName: "local_ydb_upgrade_version",
          configSource: {
            kind: "argument",
            path: configPath,
            contentSha256: "test-config-content",
          },
        },
      };
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0");
      const request = {
        version: "26.1.2.0",
        dumpName: "upgrade-exact-token",
      };

      const planned = await upgradeVersion(ctx, request);
      const accepted = await withRunTimers(() => upgradeVersion(ctx, {
        ...request,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      }));

      expect(planned).toMatchObject({
        executed: false,
        confirmation: { status: "planned", token: expect.any(String) },
      });
      expect(accepted).toMatchObject({
        executed: true,
        confirmation: { status: "accepted" },
        profileImageUpdate: {
          executed: false,
          ok: false,
          error: MANUAL_PROFILE_IMAGE_UPDATE_ERROR,
        },
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        profiles: { default: { image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6" } },
      });
      expect(statSync(configPath).mode & 0o777).toBe(0o640);
    } finally {
      cleanup();
    }
  });

  it("applies privately generated auth bytes when canonical artifacts change after persistence", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig();
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    const authConfigPath = (rawConfig.profiles.default as { authConfigPath: string }).authConfigPath;
    let appliedAuth: string | undefined;
    let privateRoot: string | undefined;
    try {
      const context = createContext(
        undefined,
        executor,
        ConfigSchema.parse(rawConfig),
        configPath,
      );
      const ctx = exactConfirmationContext(context);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0", {
        realContentSnapshots: true,
        captureAuthRoot: (path) => {
          privateRoot = path;
        },
        afterAuthPersist: () => {
          writeFileSync(authConfigPath, "BENIGN_CANONICAL_REPLACEMENT\n", "utf8");
        },
        captureAppliedAuth: (content) => {
          appliedAuth = content;
        },
      });
      const request = {
        version: "26.1.2.0",
        dumpName: "upgrade-private-auth",
      };

      const planned = await upgradeVersion(ctx, request);
      const accepted = await withRunTimers(() => upgradeVersion(ctx, {
        ...request,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      }));

      expect(accepted.confirmation).toEqual({ status: "accepted" });
      expect(appliedAuth).toBe("BENIGN_GENERATED_AUTH\n");
      expect(readFileSync(authConfigPath, "utf8")).toBe("BENIGN_CANONICAL_REPLACEMENT\n");
      expect(JSON.stringify(accepted)).not.toContain("/tmp/local-ydb-toolkit-composite-auth-");
      expect(privateRoot).toMatch(/^\/tmp\/local-ydb-toolkit-composite-auth-/);
      expect(privateRoot && existsSync(privateRoot)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("consumes the token and removes private auth artifacts when persistence fails", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig();
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    let privateRoot: string | undefined;
    try {
      const context = createContext(
        undefined,
        executor,
        ConfigSchema.parse(rawConfig),
        configPath,
      );
      const ctx = exactConfirmationContext(context);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0", {
        captureAuthRoot: (path) => {
          privateRoot = path;
        },
        failAuthPersist: true,
      });
      const request = {
        version: "26.1.2.0",
        dumpName: "upgrade-private-auth-persist-failure",
      };
      const planned = await upgradeVersion(ctx, request);
      const confirmedRequest = {
        ...request,
        confirm: true as const,
        confirmationToken: planned.confirmation?.token,
      };

      const failed = await withRunTimers(() => upgradeVersion(ctx, confirmedRequest));
      const replay = await upgradeVersion(ctx, confirmedRequest);

      expect(failed.confirmation).toEqual({ status: "accepted" });
      expect(failed.results?.some((result) => result.stderr.includes("BENIGN_PRIVATE_AUTH_PERSIST_FAILURE"))).toBe(true);
      expect(replay.confirmation?.status).toBe("rejected");
      expect(privateRoot).toMatch(/^\/tmp\/local-ydb-toolkit-composite-auth-/);
      expect(privateRoot && existsSync(privateRoot)).toBe(false);
      expect(JSON.stringify(failed)).not.toContain("/tmp/local-ydb-toolkit-composite-auth-");
    } finally {
      cleanup();
    }
  });

  it("does not overwrite a profile config changed after token consumption", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({
      authConfigPath: undefined,
      dynamicNodeAuthSid: undefined,
      dynamicNodeAuthTokenFile: undefined,
      rootPasswordFile: undefined,
    });
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    const concurrentImage = "ghcr.io/ydb-platform/local-ydb:26.1.1.99";
    try {
      const context = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      const ctx = exactConfirmationContext(context);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0", {
        containerNames: ["ydb-dyn-example", "ydb-local"],
        onFirstRequiredImage: () => {
          const current = JSON.parse(readFileSync(configPath, "utf8")) as {
            profiles: { default: { image: string } };
          };
          current.profiles.default.image = concurrentImage;
          writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
        },
      });
      const request = { version: "26.1.2.0", dumpName: "upgrade-config-cas" };

      const planned = await upgradeVersion(ctx, request);
      const accepted = await withRunTimers(() => upgradeVersion(ctx, {
        ...request,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      }));

      expect(accepted.confirmation).toEqual({ status: "accepted" });
      expect(accepted.profileImageUpdate).toMatchObject({
        executed: false,
        ok: false,
        error: MANUAL_PROFILE_IMAGE_UPDATE_ERROR,
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        profiles: { default: { image: concurrentImage } },
      });
    } finally {
      cleanup();
    }
  });

  it("preserves a symlink-backed profile config and its target", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({
      authConfigPath: undefined,
      dynamicNodeAuthSid: undefined,
      dynamicNodeAuthTokenFile: undefined,
      rootPasswordFile: undefined,
    });
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    const targetPath = `${configPath}.target`;
    try {
      renameSync(configPath, targetPath);
      symlinkSync(targetPath, configPath);
      const context = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      const ctx = exactConfirmationContext(context);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0", {
        containerNames: ["ydb-dyn-example", "ydb-local"],
      });
      const request = { version: "26.1.2.0", dumpName: "upgrade-symlink-config" };

      const planned = await upgradeVersion(ctx, request);
      const accepted = await withRunTimers(() => upgradeVersion(ctx, {
        ...request,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      }));

      expect(accepted.confirmation).toEqual({ status: "accepted" });
      expect(accepted.profileImageUpdate).toMatchObject({
        executed: false,
        ok: false,
        error: MANUAL_PROFILE_IMAGE_UPDATE_ERROR,
      });
      expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(targetPath, "utf8"))).toMatchObject({
        profiles: { default: { image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6" } },
      });
    } finally {
      cleanup();
    }
  });

  it("does not expand composite teardown to a container discovered after confirmation", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({
      authConfigPath: undefined,
      dynamicNodeAuthSid: undefined,
      dynamicNodeAuthTokenFile: undefined,
      rootPasswordFile: undefined,
    });
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    try {
      const context = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      const ctx = exactConfirmationContext(context);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0", {
        containerNames: ["ydb-dyn-example", "ydb-local"],
        lateContainer: "ydb-dyn-example-2",
      });
      const request = { version: "26.1.2.0", dumpName: "upgrade-frozen-teardown" };

      const planned = await upgradeVersion(ctx, request);
      const accepted = await withRunTimers(() => upgradeVersion(ctx, {
        ...request,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      }));

      expect(planned.plannedCommands.join("\n")).not.toContain("docker rm -f ydb-dyn-example-2");
      expect(accepted.confirmation).toEqual({ status: "accepted" });
      expect(executor.commands.join("\n")).not.toContain("docker rm -f ydb-dyn-example-2");
    } finally {
      cleanup();
    }
  });

  it("restores composite upgrades only from the private copy made before teardown", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({
      authConfigPath: undefined,
      dynamicNodeAuthSid: undefined,
      dynamicNodeAuthTokenFile: undefined,
      rootPasswordFile: undefined,
    });
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    const dumpName = "upgrade-private-dump";
    const reviewed = "BENIGN_REVIEWED_COMPOSITE_DUMP\n";
    const replacement = "BENIGN_REPLACEMENT_COMPOSITE_DUMP\n";
    let restoredContent: string | undefined;
    let compositeRoot: string | undefined;
    try {
      const context = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      const ctx = exactConfirmationContext(context);
      const dumpHostPath = ctx.profile.dumpHostPath;
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0", {
        containerNames: ["ydb-dyn-example", "ydb-local"],
        realContentSnapshots: true,
        afterCompositeSnapshot: () => {
          writeFileSync(join(dumpHostPath, dumpName, "tenant", "data.csv"), replacement, "utf8");
        },
        captureRestoredContent: (content) => {
          restoredContent = content;
        },
        dumpContent: reviewed,
        captureCompositeRoot: (path) => {
          compositeRoot = path;
        },
      });
      const request = { version: "26.1.2.0", dumpName };
      const planned = await upgradeVersion(ctx, request);

      const accepted = await withRunTimers(() => upgradeVersion(ctx, {
        ...request,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      }));

      expect(accepted.confirmation).toEqual({ status: "accepted" });
      expect(restoredContent).toBe(reviewed);
      expect(JSON.stringify(accepted)).not.toContain(replacement.trim());
      expect(JSON.stringify(accepted)).not.toContain("/tmp/local-ydb-toolkit-composite-");
      expect(compositeRoot && existsSync(compositeRoot)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("consumes the token and stops before teardown when composite dump isolation fails", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({
      authConfigPath: undefined,
      dynamicNodeAuthSid: undefined,
      dynamicNodeAuthTokenFile: undefined,
      rootPasswordFile: undefined,
    });
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    let compositeRoot: string | undefined;
    try {
      const context = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      const ctx = exactConfirmationContext(context);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0", {
        containerNames: ["ydb-dyn-example", "ydb-local"],
        dumpSymlink: true,
        captureCompositeRoot: (path) => {
          compositeRoot = path;
        },
      });
      const request = { version: "26.1.2.0", dumpName: "upgrade-invalid-dump" };
      const planned = await upgradeVersion(ctx, request);
      const confirmedRequest = {
        ...request,
        confirm: true as const,
        confirmationToken: planned.confirmation?.token,
      };

      const failed = await withRunTimers(() => upgradeVersion(ctx, confirmedRequest));
      const replay = await upgradeVersion(ctx, confirmedRequest);

      expect(failed).toMatchObject({
        confirmation: { status: "accepted" },
        results: expect.arrayContaining([expect.objectContaining({
          command: "prepare private verified composite dump snapshot",
          ok: false,
          stderr: "Private composite dump snapshot could not be created or verified.",
        })]),
      });
      expect(replay.confirmation?.status).toBe("rejected");
      expect(executor.commands.join("\n")).not.toContain("docker rm -f ydb-local");
      expect(compositeRoot && existsSync(compositeRoot)).toBe(false);
      expect(JSON.stringify(failed)).not.toContain("upgrade-invalid-dump-outside.csv");
    } finally {
      cleanup();
    }
  });

  it("removes the private composite dump when a later phase aborts", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({
      authConfigPath: undefined,
      dynamicNodeAuthSid: undefined,
      dynamicNodeAuthTokenFile: undefined,
      rootPasswordFile: undefined,
    });
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    let compositeRoot: string | undefined;
    try {
      const context = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      const ctx = exactConfirmationContext(context);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0", {
        containerNames: ["ydb-dyn-example", "ydb-local"],
        throwOnFirstDestroy: true,
        captureCompositeRoot: (path) => {
          compositeRoot = path;
        },
      });
      const request = { version: "26.1.2.0", dumpName: "upgrade-aborted-after-snapshot" };
      const planned = await upgradeVersion(ctx, request);

      await expect(upgradeVersion(ctx, {
        ...request,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      })).rejects.toThrow("BENIGN_SYNTHETIC_COMPOSITE_ABORT");

      expect(compositeRoot).toMatch(/^\/tmp\/local-ydb-toolkit-composite-/);
      expect(compositeRoot && existsSync(compositeRoot)).toBe(false);
      expect(await upgradeVersion(ctx, {
        ...request,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      })).toMatchObject({
        executed: false,
        confirmation: { status: "rejected" },
      });
    } finally {
      cleanup();
    }
  });

  it("verifies configured and one-off container images after a multi-node upgrade", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({ dynamicNodeCount: 3 });
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    try {
      const ctx = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0", {
        containerNames: [
          "ydb-dyn-example-4",
          "ydb-dyn-example-3",
          "ydb-dyn-example-2",
          "ydb-dyn-example",
          "ydb-local"
        ],
        nodePorts: [19002, 19003, 19004, 19005]
      });

      const response = await withRunTimers(() => upgradeVersion(ctx, {
        confirm: true,
        version: "26.1.2.0",
        dumpName: "upgrade-multi-node"
      }));

      expect(response.extraDynamicNodes).toEqual(["ydb-dyn-example-4"]);
      expect(response.imageVerification).toEqual({
        expectedImage: "ghcr.io/ydb-platform/local-ydb:26.1.2.0",
        missing: [],
        mismatches: []
      });
      const imageResult = response.results?.find((result) => result.command.includes("verify profile containers use image"));
      expect(imageResult?.stdout).toContain("ydb-dyn-example-2=ghcr.io/ydb-platform/local-ydb:26.1.2.0");
      expect(imageResult?.stdout).toContain("ydb-dyn-example-3=ghcr.io/ydb-platform/local-ydb:26.1.2.0");
      expect(imageResult?.stdout).toContain("ydb-dyn-example-4=ghcr.io/ydb-platform/local-ydb:26.1.2.0");
    } finally {
      cleanup();
    }
  });

  it("rejects confirmed upgrades without a file-backed config path before Docker commands", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse(upgradeConfig()));

    await expect(upgradeVersion(ctx, {
      confirm: true,
      version: "26.1.2.0"
    })).rejects.toThrow(/file-backed local-ydb config path/);
    expect(executor.commands).toEqual([]);
  });

  it("rejects bind-mounted profiles before Docker commands", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse(upgradeConfig({
      bindMountPath: "/tmp/local-ydb-bind-data"
    })), "/tmp/local-ydb.config.json");

    await expect(upgradeVersion(ctx, {
      confirm: true,
      version: "26.1.2.0"
    })).rejects.toThrow(/bindMountPath profiles/);
    expect(executor.commands).toEqual([]);
  });

  it("reports a manual config update after successful image verification", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig();
    const fixtureDir = mkdtempSync(join(tmpdir(), "local-ydb-missing-config-test-"));
    materializeProfileFiles(rawConfig, fixtureDir);
    const configPath = join(fixtureDir, "missing", "local-ydb.config.json");
    const ctx = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
    stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0");

    const response = await withRunTimers(() => upgradeVersion(ctx, {
      confirm: true,
      version: "26.1.2.0",
      dumpName: "upgrade-smoke"
    }));

    expect(response.imageVerification).toEqual({
      expectedImage: "ghcr.io/ydb-platform/local-ydb:26.1.2.0",
      missing: [],
      mismatches: []
    });
    expect(response.profileImageUpdate).toMatchObject({
      configPath,
      profile: "default",
      sourceImage: "ghcr.io/ydb-platform/local-ydb:26.1.1.6",
      targetImage: "ghcr.io/ydb-platform/local-ydb:26.1.2.0",
      executed: false,
      ok: false,
      error: MANUAL_PROFILE_IMAGE_UPDATE_ERROR
    });
    expect(response.results?.some((result) => result.command.includes("profiles.default.image"))).toBe(false);
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("does not update the profile when final image verification finds a mismatch", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({
      authConfigPath: undefined,
      dynamicNodeAuthSid: undefined,
      dynamicNodeAuthTokenFile: undefined,
      rootPasswordFile: undefined
    });
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    try {
      const ctx = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.1.6", {
        containerNames: ["ydb-dyn-example", "ydb-local"]
      });

      const response = await withRunTimers(() => upgradeVersion(ctx, {
        confirm: true,
        version: "26.1.2.0",
        dumpName: "upgrade-smoke"
      }));

      expect(response.imageVerification).toEqual({
        expectedImage: "ghcr.io/ydb-platform/local-ydb:26.1.2.0",
        missing: [],
        mismatches: [
          "ydb-local -> ghcr.io/ydb-platform/local-ydb:26.1.1.6",
          "ydb-dyn-example -> ghcr.io/ydb-platform/local-ydb:26.1.1.6"
        ]
      });
      expect(response.profileImageUpdate).toMatchObject({ executed: false, ok: false });
      expect(response.summary).toContain("Final image verification found a mismatch");
      const unchangedConfig = JSON.parse(readFileSync(configPath, "utf8")) as { profiles: { default: { image: string } } };
      expect(unchangedConfig.profiles.default.image).toBe("ghcr.io/ydb-platform/local-ydb:26.1.1.6");
    } finally {
      cleanup();
    }
  });

  it("requires a manual profile update when final inventory is unavailable", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({
      authConfigPath: undefined,
      dynamicNodeAuthSid: undefined,
      dynamicNodeAuthTokenFile: undefined,
      rootPasswordFile: undefined
    });
    const { configPath, cleanup } = writeTempConfig(rawConfig);
    try {
      const ctx = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
      stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0", {
        failDockerPsCall: 2,
        containerNames: ["ydb-dyn-example", "ydb-local"]
      });

      const response = await withRunTimers(() => upgradeVersion(ctx, {
        confirm: true,
        version: "26.1.2.0",
        dumpName: "upgrade-smoke"
      }));
      expect(response.executed).toBe(true);
      expect(response.imageVerification).toBeUndefined();
      expect(response.profileImageUpdate).toMatchObject({
        targetImage: "ghcr.io/ydb-platform/local-ydb:26.1.2.0",
        executed: false,
        ok: false,
        error: MANUAL_PROFILE_IMAGE_UPDATE_ERROR
      });
      expect(response.summary).toContain("requires independent verification before manual action");
      expect(response.results?.at(-1)).toMatchObject({ ok: false, exitCode: 1 });
      expect(response.results?.at(-1)?.stderr).not.toContain("private final inventory failure");
      const unchangedConfig = JSON.parse(readFileSync(configPath, "utf8")) as { profiles: { default: { image: string } } };
      expect(unchangedConfig.profiles.default.image).toBe("ghcr.io/ydb-platform/local-ydb:26.1.1.6");
    } finally {
      cleanup();
    }
  });

  it("reports manual action without a fake config result after unavailable final verification", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig({
      authConfigPath: undefined,
      dynamicNodeAuthSid: undefined,
      dynamicNodeAuthTokenFile: undefined,
      rootPasswordFile: undefined
    });
    const configPath = join(tmpdir(), `local-ydb-unavailable-${Date.now()}`, "local-ydb.config.json");
    const ctx = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
    stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0", {
      failDockerPsCall: 2,
      containerNames: ["ydb-dyn-example", "ydb-local"]
    });

    const response = await withRunTimers(() => upgradeVersion(ctx, {
      confirm: true,
      version: "26.1.2.0",
      dumpName: "upgrade-smoke"
    }));

    expect(response.imageVerification).toBeUndefined();
    expect(response.profileImageUpdate).toMatchObject({
      executed: false,
      ok: false,
      targetImage: "ghcr.io/ydb-platform/local-ydb:26.1.2.0",
      error: MANUAL_PROFILE_IMAGE_UPDATE_ERROR
    });
    expect(response.summary).toContain("requires independent verification before manual action");
    expect(response.results?.at(-1)).toMatchObject({ ok: false, exitCode: 1 });
    expect(response.results?.some((result) => result.command.includes("profiles.default.image"))).toBe(false);
  });

  it("rejects digest-pinned profile images for upgrade", async () => {
    const executor = new RecordingExecutor();
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: {
        default: {
          image: "ghcr.io/ydb-platform/local-ydb@sha256:deadbeef"
        }
      }
    }));

    await expect(upgradeVersion(ctx, { version: "26.1.2.0" })).rejects.toThrow(/digest-pinned/);
  });
});
