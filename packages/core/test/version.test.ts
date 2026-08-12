import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandToShell,
  createContext,
  listVersions,
  parseImageReference,
  replaceImageTag,
  upgradeVersion,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  type ResolvedLocalYdbProfile
} from "../src/index.js";
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
  writeFileSync(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, "utf8");
  return {
    configPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

function stubUpgradeExecutor(
  executor: RecordingExecutor,
  inventoryImage: string,
  options: { failDockerPsCall?: number; containerNames?: string[] } = {}
): void {
  let dockerPsCalls = 0;
  executor.run = async (_profile, spec) => {
    const command = executor.display(_profile, spec);
    executor.commands.push(command);

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
      const containerNames = options.containerNames ?? [
        "ydb-dyn-example-2",
        "ydb-dyn-example",
        "ydb-local"
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
    if (command.includes("docker inspect")) {
      return { command, exitCode: 0, stdout: "[]", stderr: "", ok: true, timedOut: false };
    }
    if (command.includes("viewer/json/nodelist")) {
      return {
        command,
        exitCode: 0,
        stdout: "[{\"Port\":19003}]",
        stderr: "",
        ok: true,
        timedOut: false
      };
    }
    return { command, exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
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
    expect(parseImageReference("docker.io/ydb-platform/local-ydb").registry).toBe("docker.io");
    expect(replaceImageTag("ghcr.io/ydb-platform/local-ydb:26.1.1.6", "latest")).toBe("ghcr.io/ydb-platform/local-ydb:latest");
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
      expect(response.plannedCommands.join("\n")).toContain("--name ydb-dyn-example-2");
      expect(response.plannedCommands.join("\n")).toContain(`profiles.default.image ghcr.io/ydb-platform/local-ydb:26.1.1.6 -> ghcr.io/ydb-platform/local-ydb:26.1.2.0`);
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

      const response = await upgradeVersion(ctx, {
        confirm: true,
        version: "26.1.2.0",
        dumpName: "upgrade-smoke"
      });
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
        executed: true,
        ok: true
      });
      expect(response.summary).toContain("Final image verification succeeded");
      const updatedConfig = JSON.parse(readFileSync(configPath, "utf8")) as { profiles: { default: { image: string } } };
      expect(updatedConfig.profiles.default.image).toBe("ghcr.io/ydb-platform/local-ydb:26.1.2.0");

      const commands = response.results?.map((result) => result.command) ?? [];
      expect(commands[0]).toContain("docker image inspect ghcr.io/ydb-platform/local-ydb:26.1.1.6");
      expect(commands[1]).toContain("docker image inspect ghcr.io/ydb-platform/local-ydb:26.1.2.0");
      expect(commands.some((command) => command.includes("--name ydb-local") && command.includes("ghcr.io/ydb-platform/local-ydb:26.1.2.0"))).toBe(true);
      expect(commands.some((command) => command.includes("--name ydb-dyn-example-2") && command.includes("ghcr.io/ydb-platform/local-ydb:26.1.2.0"))).toBe(true);
      expect(commands.some((command) => command.includes("verify profile containers use image ghcr.io/ydb-platform/local-ydb:26.1.2.0"))).toBe(true);
      expect(commands.some((command) => command.includes("profiles.default.image ghcr.io/ydb-platform/local-ydb:26.1.1.6 -> ghcr.io/ydb-platform/local-ydb:26.1.2.0"))).toBe(true);
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

  it("reports a failed config image update after successful image verification", async () => {
    const executor = new RecordingExecutor();
    const rawConfig = upgradeConfig();
    const configPath = join(tmpdir(), `local-ydb-missing-${Date.now()}`, "local-ydb.config.json");
    const ctx = createContext(undefined, executor, ConfigSchema.parse(rawConfig), configPath);
    stubUpgradeExecutor(executor, "ghcr.io/ydb-platform/local-ydb:26.1.2.0");

    const response = await upgradeVersion(ctx, {
      confirm: true,
      version: "26.1.2.0",
      dumpName: "upgrade-smoke"
    });

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
      executed: true,
      ok: false
    });
    expect(response.profileImageUpdate?.error).toBeTruthy();
    expect(response.results?.at(-1)).toMatchObject({
      command: `update ${configPath}: profiles.default.image ghcr.io/ydb-platform/local-ydb:26.1.1.6 -> ghcr.io/ydb-platform/local-ydb:26.1.2.0`,
      ok: false,
      exitCode: 1
    });
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

      const response = await upgradeVersion(ctx, {
        confirm: true,
        version: "26.1.2.0",
        dumpName: "upgrade-smoke"
      });

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

  it("persists the target image and returns history when final inventory is unavailable", async () => {
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
        failDockerPsCall: 4,
        containerNames: ["ydb-dyn-example", "ydb-local"]
      });

      const response = await upgradeVersion(ctx, {
        confirm: true,
        version: "26.1.2.0",
        dumpName: "upgrade-smoke"
      });
      expect(response.executed).toBe(true);
      expect(response.imageVerification).toBeUndefined();
      expect(response.profileImageUpdate).toMatchObject({
        targetImage: "ghcr.io/ydb-platform/local-ydb:26.1.2.0",
        executed: true,
        ok: true
      });
      expect(response.summary).toContain("could not be verified");
      expect(response.results?.at(-2)).toMatchObject({ ok: false, exitCode: 1 });
      expect(response.results?.at(-2)?.stderr).not.toContain("private final inventory failure");
      expect(response.results?.at(-1)).toMatchObject({ ok: true, exitCode: 0 });
      const updatedConfig = JSON.parse(readFileSync(configPath, "utf8")) as { profiles: { default: { image: string } } };
      expect(updatedConfig.profiles.default.image).toBe("ghcr.io/ydb-platform/local-ydb:26.1.2.0");
    } finally {
      cleanup();
    }
  });

  it("reports a structured config write failure after unavailable final verification", async () => {
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
      failDockerPsCall: 4,
      containerNames: ["ydb-dyn-example", "ydb-local"]
    });

    const response = await upgradeVersion(ctx, {
      confirm: true,
      version: "26.1.2.0",
      dumpName: "upgrade-smoke"
    });

    expect(response.imageVerification).toBeUndefined();
    expect(response.profileImageUpdate).toMatchObject({
      executed: true,
      ok: false,
      targetImage: "ghcr.io/ydb-platform/local-ydb:26.1.2.0"
    });
    expect(response.summary).toContain("could not be verified");
    expect(response.results?.at(-2)).toMatchObject({ ok: false, exitCode: 1 });
    expect(response.results?.at(-1)).toMatchObject({ ok: false, exitCode: 1 });
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
