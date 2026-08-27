import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { decode } from "@toon-format/toon";
import { StatusIds_StatusCode } from "@ydbjs/api/operation";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigSchema,
  commandToShell,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  type ResolvedLocalYdbProfile,
} from "@local-ydb-toolkit/core";
import {
  createLocalYdbMcpApplication,
  createLocalYdbMcpServer,
  getLocalYdbPrompt,
  localYdbPrompts,
  localYdbTools,
  type LocalYdbMcpApplication,
} from "../src/index.js";

type ProtocolServer = LocalYdbMcpApplication | Server;

const openConnections: Array<{ client: Client; server: ProtocolServer }> = [];
const posixIt = process.platform === "win32" ? it.skip : it;

class ProtocolMutationExecutor implements CommandExecutor {
  readonly commands: string[] = [];
  fail = false;

  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    const command = this.display(profile, spec);
    this.commands.push(command);
    if (this.fail) {
      throw new Error("synthetic protocol execution failure");
    }
    return {
      command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      ok: true,
      timedOut: false,
    };
  }
}

afterEach(async () => {
  for (const { client, server } of openConnections.splice(0)) {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

describe("MCP protocol contract", () => {
  it("keeps the application and compatibility factories on the same 39/8/0 surface", async () => {
    const applicationSnapshot = await protocolSnapshot(createLocalYdbMcpApplication());
    const compatibilitySnapshot = await protocolSnapshot(createLocalYdbMcpServer());

    expect(compatibilitySnapshot).toEqual(applicationSnapshot);
    expect(applicationSnapshot.capabilities.tools).toEqual({});
    expect(applicationSnapshot.capabilities.prompts).toEqual({ listChanged: true });
    expect(applicationSnapshot.capabilities.resources).toBeUndefined();
    expect(applicationSnapshot.tools).toHaveLength(39);
    expect(canonicalJson(applicationSnapshot.tools)).toBe(canonicalJson(localYdbTools));
    expect(applicationSnapshot.prompts).toHaveLength(8);
    expect(JSON.stringify(applicationSnapshot.prompts)).toBe(JSON.stringify(localYdbPrompts));
  });

  it("exposes only the supported application lifecycle surface", () => {
    const application = createLocalYdbMcpApplication();

    expect(Object.keys(application).sort()).toEqual(["close", "connect", "server"]);
    expect(application).not.toHaveProperty("registerPrompt");
    expect(application).not.toHaveProperty("registerTool");
  });

  it("renders every prompt and preserves strict prompt argument errors", async () => {
    const { client } = await connect(createLocalYdbMcpApplication());
    const promptArguments: Record<string, Record<string, string>> = {
      local_ydb_diagnose_database: { databasePath: "/local/example" },
      local_ydb_upgrade_version_workflow: { version: "26.1.2.0" },
      local_ydb_reduce_storage_groups_workflow: { count: "2" },
    };

    for (const prompt of localYdbPrompts) {
      const result = await client.getPrompt({
        name: prompt.name,
        arguments: promptArguments[prompt.name] ?? {},
      });
      expect(result.description).toBe(prompt.description);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]?.content).toMatchObject({ type: "text" });
    }

    await expect(client.getPrompt({
      name: "local_ydb_upgrade_version_workflow",
      arguments: {},
    })).rejects.toThrow("Missing required argument version");
    await expect(client.getPrompt({
      name: "local_ydb_reduce_storage_groups_workflow",
      arguments: { count: "not-an-integer" },
    })).rejects.toThrow("must be an integer");
    await expect(client.getPrompt({
      name: "local_ydb_diagnose_stack",
      arguments: { confirm: "true" },
    })).rejects.toThrow("Unknown argument confirm");
    await expect(client.getPrompt({
      name: "local_ydb_diagnose_stack",
      arguments: { prototype: "untrusted" },
    })).rejects.toThrow("Unknown argument prototype");
    await expect(client.getPrompt({
      name: "local_ydb_diagnose_stack",
      arguments: { configPath: "relative.json" },
    })).rejects.toThrow("must be an absolute path");
    await expect(client.getPrompt({
      name: "local_ydb_diagnose_stack",
      arguments: { configPath: "" },
    })).rejects.toThrow("must be an absolute path");
    expect(() => getLocalYdbPrompt(
      "local_ydb_diagnose_stack",
      JSON.parse('{"__proto__":"untrusted"}') as Record<string, string>,
    )).toThrow("Unknown argument __proto__");
    await expect(client.getPrompt({
      name: "__proto__",
      arguments: {},
    })).rejects.toThrow("Prompt __proto__ not found");
  });

  it("rejects non-string arguments passed directly to the prompt helper", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["local_ydb_upgrade_version_workflow", { version: 123 }],
      ["local_ydb_diagnose_stack", { profile: false }],
    ];

    for (const [name, args] of cases) {
      let error: unknown;
      try {
        getLocalYdbPrompt(name, args);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: ErrorCode.InvalidParams });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("must be a string");
    }
  });

  it("preserves tool errors and JSON/TOON response formatting over MCP", async () => {
    for (const responseContentFormat of ["json", "toon"] as const) {
      const { client } = await connect(createLocalYdbMcpApplication({
        config: ConfigSchema.parse({}),
        responseContentFormat,
        sqlExecutor: async () => ({
          completion: "success",
          resultSets: [{
            index: 0,
            columns: [{ name: "value", type: "Int32" }],
            rows: [[1]],
            truncationReasons: [],
          }],
          capturedBytes: 36,
          truncationReasons: [],
          status: StatusIds_StatusCode.SUCCESS,
        }),
      }));

      const unknown = await client.callTool({ name: "local_ydb_missing", arguments: {} });
      expect(unknown).toMatchObject({
        isError: true,
        structuredContent: { error: "Unknown tool: local_ydb_missing" },
      });

      const invalid = await client.callTool({
        name: "local_ydb_sql",
        arguments: { script: "" },
      });
      expect(invalid).toMatchObject({
        isError: true,
        structuredContent: { error: expect.any(String) },
      });

      const result = await client.callTool({
        name: "local_ydb_sql",
        arguments: { script: "SELECT 1;" },
      });
      const text = textContentAt(result.content, 1);
      const jsonModel = JSON.parse(JSON.stringify(result.structuredContent)) as unknown;

      expect(result.structuredContent).toMatchObject({
        action: "query",
        resultSets: [{ rows: [[1]] }],
      });
      expect(responseContentFormat === "json" ? JSON.parse(text) : decode(text)).toEqual(jsonModel);
    }
  });

  it("returns safe structured config errors without parser snippets or paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-mcp-config-error-"));
    const configPath = join(dir, "config.json");
    const marker = "BENIGN_MCP_CONFIG_MARKER";
    writeFileSync(configPath, `${marker}\n`, "utf8");
    try {
      const { client } = await connect(createLocalYdbMcpApplication());
      const result = await client.callTool({
        name: "local_ydb_inventory",
        arguments: { configPath },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "CONFIG_INVALID_JSON",
          error: expect.any(String),
        },
      });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(JSON.stringify(result)).not.toContain(configPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a safe schema error when defaultProfile is not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-mcp-default-profile-"));
    const configPath = join(dir, "config.json");
    const marker = "BENIGN_MCP_MISSING_DEFAULT_PROFILE";
    writeFileSync(configPath, JSON.stringify({
      defaultProfile: marker,
      profiles: { default: {} },
    }), "utf8");
    try {
      const { client } = await connect(createLocalYdbMcpApplication());
      const result = await client.callTool({
        name: "local_ydb_inventory",
        arguments: { configPath },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "CONFIG_INVALID_SCHEMA",
          error: expect.any(String),
        },
      });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(JSON.stringify(result)).not.toContain(configPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  posixIt("returns a safe non-file error for a Unix socket config path", async () => {
    const marker = "p5m-";
    const dir = mkdtempSync(join(tmpdir(), marker));
    const configPath = join(dir, "s");
    const socketServer = createServer();
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const result = await (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          socketServer.once("error", reject);
          socketServer.listen(configPath, resolve);
        });
        const { client } = await connect(createLocalYdbMcpApplication());
        return await Promise.race([
          client.callTool({
            name: "local_ydb_inventory",
            arguments: { configPath },
          }),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Unix socket config call exceeded 2 seconds")),
              2_000,
            );
          }),
        ]);
      } finally {
        if (deadline !== undefined) {
          clearTimeout(deadline);
        }
        if (socketServer.listening) {
          await new Promise<void>((resolve) => socketServer.close(() => resolve()));
        }
        rmSync(dir, { recursive: true, force: true });
      }
    })();

    expect(existsSync(dir)).toBe(false);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "CONFIG_NOT_FILE",
        error: expect.any(String),
      },
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain(configPath);
  });

  it("treats an empty config environment value as explicit", async () => {
    const previousConfigPath = process.env.LOCAL_YDB_TOOLKIT_CONFIG;
    process.env.LOCAL_YDB_TOOLKIT_CONFIG = "";
    try {
      const { client } = await connect(createLocalYdbMcpApplication());
      const result = await client.callTool({
        name: "local_ydb_inventory",
        arguments: {},
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "CONFIG_PATH_NOT_ABSOLUTE",
          error: expect.any(String),
        },
      });
    } finally {
      if (previousConfigPath === undefined) {
        delete process.env.LOCAL_YDB_TOOLKIT_CONFIG;
      } else {
        process.env.LOCAL_YDB_TOOLKIT_CONFIG = previousConfigPath;
      }
    }
  });

  it("rejects unknown top-level MCP tool arguments", async () => {
    const { client } = await connect(createLocalYdbMcpApplication({
      config: ConfigSchema.parse({}),
    }));
    const result = await client.callTool({
      name: "local_ydb_inventory",
      arguments: { unexpected: true },
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: expect.any(String) },
    });
  });

  it("requires a one-time token for an exact mutating MCP request", async () => {
    const executor = new ProtocolMutationExecutor();
    const { client } = await connect(createLocalYdbMcpApplication({
      config: ConfigSchema.parse({}),
      executor,
    }));
    const request = {
      name: "local_ydb_cleanup_storage",
      arguments: { paths: ["/tmp/local-ydb-confirmation-protocol"] },
    };

    const planned = await client.callTool(request);
    const token = confirmationToken(planned.structuredContent);
    expect(planned.structuredContent).toMatchObject({
      executed: false,
      confirmation: { status: "planned", token: expect.any(String) },
    });
    expect(executor.commands).toHaveLength(0);

    const missing = await client.callTool({
      ...request,
      arguments: { ...request.arguments, confirm: true },
    });
    expect(missing.structuredContent).toMatchObject({
      executed: false,
      confirmation: { status: "rejected", token: expect.any(String) },
    });
    expect(executor.commands).toHaveLength(0);

    const accepted = await client.callTool({
      ...request,
      arguments: {
        ...request.arguments,
        confirm: true,
        confirmationToken: token,
      },
    });
    expect(accepted.structuredContent).toMatchObject({
      executed: true,
      confirmation: { status: "accepted" },
    });
    expect(executor.commands).toHaveLength(1);

    const replay = await client.callTool({
      ...request,
      arguments: {
        ...request.arguments,
        confirm: true,
        confirmationToken: token,
      },
    });
    expect(replay.structuredContent).toMatchObject({
      executed: false,
      confirmation: { status: "rejected", token: expect.any(String) },
    });
    expect(executor.commands).toHaveLength(1);
  });

  it("rejects changed, wrong-tool, wrong-profile, and pre-restart tokens", async () => {
    const config = ConfigSchema.parse({
      profiles: { default: {}, other: {} },
    });
    const executor = new ProtocolMutationExecutor();
    const application = createLocalYdbMcpApplication({ config, executor });
    const { client } = await connect(application);
    const planned = await client.callTool({
      name: "local_ydb_cleanup_storage",
      arguments: { paths: ["/tmp/local-ydb-confirmation-a"] },
    });
    const token = confirmationToken(planned.structuredContent);

    for (const request of [
      {
        name: "local_ydb_cleanup_storage",
        arguments: {
          paths: ["/tmp/local-ydb-confirmation-b"],
          confirm: true,
          confirmationToken: token,
        },
      },
      {
        name: "local_ydb_create_tenant",
        arguments: { confirm: true, confirmationToken: token },
      },
      {
        name: "local_ydb_cleanup_storage",
        arguments: {
          profile: "other",
          paths: ["/tmp/local-ydb-confirmation-a"],
          confirm: true,
          confirmationToken: token,
        },
      },
    ]) {
      const response = await client.callTool(request);
      expect(response.structuredContent).toMatchObject({
        executed: false,
        confirmation: { status: "rejected", token: expect.any(String) },
      });
    }
    expect(executor.commands).toHaveLength(0);

    const restartedExecutor = new ProtocolMutationExecutor();
    const { client: restartedClient } = await connect(createLocalYdbMcpApplication({
      config,
      executor: restartedExecutor,
    }));
    const restarted = await restartedClient.callTool({
      name: "local_ydb_cleanup_storage",
      arguments: {
        paths: ["/tmp/local-ydb-confirmation-a"],
        confirm: true,
        confirmationToken: token,
      },
    });
    expect(restarted.structuredContent).toMatchObject({
      executed: false,
      confirmation: { status: "rejected", token: expect.any(String) },
    });
    expect(restartedExecutor.commands).toHaveLength(0);
  });

  it("rejects a token when the explicit config source changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-confirmation-config-"));
    const configPath = join(dir, "local-ydb.config.json");
    const executor = new ProtocolMutationExecutor();
    writeFileSync(configPath, JSON.stringify({ profiles: { default: {} } }), "utf8");
    try {
      const { client } = await connect(createLocalYdbMcpApplication({ executor }));
      const request = {
        name: "local_ydb_cleanup_storage",
        arguments: {
          configPath,
          paths: ["/tmp/local-ydb-confirmation-config"],
        },
      };
      const planned = await client.callTool(request);
      const token = confirmationToken(planned.structuredContent);
      writeFileSync(configPath, JSON.stringify({
        profiles: { default: { volume: "changed-volume" } },
      }), "utf8");

      const rejected = await client.callTool({
        ...request,
        arguments: {
          ...request.arguments,
          confirm: true,
          confirmationToken: token,
        },
      });
      expect(rejected.structuredContent).toMatchObject({
        executed: false,
        confirmation: { status: "rejected", token: expect.any(String) },
      });
      expect(executor.commands).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects changed auth-file contents without returning content or fingerprints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ydb-confirmation-auth-content-"));
    const authConfigPath = join(dir, "auth.yaml");
    const marker = "BENIGN_PROTOCOL_AUTH_CONTENT_MARKER";
    writeFileSync(authConfigPath, marker, "utf8");
    try {
      const executor = new ProtocolMutationExecutor();
      const config = ConfigSchema.parse({
        profiles: { default: { authConfigPath } },
      });
      const { client } = await connect(createLocalYdbMcpApplication({
        config,
        executor,
      }));
      const request = {
        name: "local_ydb_apply_auth_hardening",
        arguments: {},
      };
      const planned = await client.callTool(request);
      const token = confirmationToken(planned.structuredContent);
      const digest = createHash("sha256").update(marker).digest("hex");
      expect(JSON.stringify(planned)).not.toContain(marker);
      expect(JSON.stringify(planned)).not.toContain(digest);

      writeFileSync(authConfigPath, `${marker}-changed`, "utf8");
      const rejected = await client.callTool({
        ...request,
        arguments: { confirm: true, confirmationToken: token },
      });
      expect(rejected.structuredContent).toMatchObject({
        executed: false,
        confirmation: { status: "rejected", token: expect.any(String) },
      });
      expect(JSON.stringify(rejected)).not.toContain(marker);
      expect(JSON.stringify(rejected)).not.toContain(digest);
      expect(executor.commands).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("permits at most one concurrent execution and consumes tokens before failures", async () => {
    const executor = new ProtocolMutationExecutor();
    const { client } = await connect(createLocalYdbMcpApplication({
      config: ConfigSchema.parse({}),
      executor,
    }));
    const argumentsWithoutConfirmation = {
      paths: ["/tmp/local-ydb-confirmation-concurrent"],
    };
    const planned = await client.callTool({
      name: "local_ydb_cleanup_storage",
      arguments: argumentsWithoutConfirmation,
    });
    const token = confirmationToken(planned.structuredContent);
    const confirmedRequest = {
      name: "local_ydb_cleanup_storage",
      arguments: {
        ...argumentsWithoutConfirmation,
        confirm: true,
        confirmationToken: token,
      },
    };

    const concurrent = await Promise.all([
      client.callTool(confirmedRequest),
      client.callTool(confirmedRequest),
    ]);
    expect(concurrent.map((response) => (
      response.structuredContent as { confirmation?: { status?: string } }
    ).confirmation?.status).sort()).toEqual(["accepted", "rejected"]);
    expect(executor.commands).toHaveLength(1);

    const failingExecutor = new ProtocolMutationExecutor();
    const { client: failingClient } = await connect(createLocalYdbMcpApplication({
      config: ConfigSchema.parse({}),
      executor: failingExecutor,
    }));
    const failingPlan = await failingClient.callTool({
      name: "local_ydb_cleanup_storage",
      arguments: { paths: ["/tmp/local-ydb-confirmation-failure"] },
    });
    const failingToken = confirmationToken(failingPlan.structuredContent);
    failingExecutor.fail = true;
    const failingRequest = {
      name: "local_ydb_cleanup_storage",
      arguments: {
        paths: ["/tmp/local-ydb-confirmation-failure"],
        confirm: true,
        confirmationToken: failingToken,
      },
    };
    expect(await failingClient.callTool(failingRequest)).toMatchObject({ isError: true });
    failingExecutor.fail = false;
    const retry = await failingClient.callTool(failingRequest);
    expect(retry.structuredContent).toMatchObject({
      executed: false,
      confirmation: { status: "rejected" },
    });
    expect(failingExecutor.commands).toHaveLength(1);
  });

  it("rejects confirmationToken without confirm=true and never exposes secret intent", async () => {
    const executor = new ProtocolMutationExecutor();
    const config = ConfigSchema.parse({
      profiles: {
        default: {
          authConfigPath: "/tmp/local-ydb-auth.yaml",
          rootPasswordFile: "/tmp/local-ydb-root-password",
        },
      },
    });
    const { client } = await connect(createLocalYdbMcpApplication({ config, executor }));
    const invalid = await client.callTool({
      name: "local_ydb_cleanup_storage",
      arguments: {
        paths: ["/tmp/local-ydb-confirmation-invalid"],
        confirmationToken: "v1.invalid.invalid",
      },
    });
    expect(invalid).toMatchObject({ isError: true });
    expect(executor.commands).toHaveLength(0);

    const secret = "BENIGN_PROTOCOL_PASSWORD_SECRET";
    const planned = await client.callTool({
      name: "local_ydb_set_root_password",
      arguments: { password: secret },
    });
    expect(planned.structuredContent).toMatchObject({
      executed: false,
      confirmation: { status: "planned", token: expect.any(String) },
    });
    expect(JSON.stringify(planned)).not.toContain(secret);

    const noOp = await client.callTool({
      name: "local_ydb_cleanup_storage",
      arguments: {},
    });
    expect(noOp.structuredContent).toMatchObject({
      executed: false,
      confirmation: { status: "not-required" },
    });
    expect((noOp.structuredContent as { confirmation?: { token?: string } }).confirmation)
      .not.toHaveProperty("token");
  });

  it("binds SQL confirmation to the request while refreshing EXPLAIN", async () => {
    const executor = new ProtocolMutationExecutor();
    let queryPlan = '{"Plan":{"Node Type":"Upsert","PlanNodeId":1}}';
    let validPreflight = true;
    let executions = 0;
    const { client } = await connect(createLocalYdbMcpApplication({
      config: ConfigSchema.parse({}),
      executor,
      sqlExecutor: async (_context, request) => {
        if (request.mode === "noTx") executions += 1;
        return {
          completion: validPreflight ? "success" : "failed",
          status: validPreflight ? StatusIds_StatusCode.SUCCESS : StatusIds_StatusCode.BAD_REQUEST,
          resultSets: [],
          capturedBytes: 128,
          truncationReasons: [],
          ...(request.mode === "explain" ? { queryPlan } : {}),
        };
      },
    }));
    const call = (args: Record<string, unknown>) => client.callTool({ name: "local_ydb_sql", arguments: args });
    const status = (response: Awaited<ReturnType<typeof call>>) => (
      response.structuredContent as { confirmation?: { status?: string } } | undefined
    )?.confirmation?.status;
    const parameter = { type: { kind: "primitive", name: "Utf8" }, value: "BENIGN_SQL_PARAMETER" };
    const request = {
      action: "execute",
      script: "UPSERT INTO items (id, value) VALUES (1, $value);",
      parameters: { value: parameter },
    };
    const firstPlan = await call(request);
    expect(status(await call({
      ...request,
      confirm: true,
      confirmationToken: confirmationToken(firstPlan.structuredContent),
      parameters: { value: { ...parameter, value: "changed" } },
    }))).toBe("rejected");
    expect(executions).toBe(0);

    const plan = await call(request);
    const confirmed = { ...request, confirm: true, confirmationToken: confirmationToken(plan.structuredContent) };
    queryPlan = '{"Plan":{"PlanNodeId":1,"Node Type":"Upsert"}}';
    const responses = await Promise.all([call(confirmed), call(confirmed)]);
    expect(responses.map(status).sort()).toEqual(["accepted", "rejected"]);
    expect(status(await call(confirmed))).toBe("rejected");
    expect(executions).toBe(1);
    expect(JSON.stringify([firstPlan, plan, ...responses])).not.toContain(parameter.value);

    const nextPlan = await call(request);
    const nextConfirmed = { ...request, confirm: true, confirmationToken: confirmationToken(nextPlan.structuredContent) };
    validPreflight = false;
    expect(status(await call(nextConfirmed))).toBe("not-required");
    validPreflight = true;
    expect(status(await call(nextConfirmed))).toBe("rejected");
    expect(executions).toBe(1);
    expect(executor.commands).toHaveLength(0);
  });

  it("propagates client cancellation to the tool handler abort signal", async () => {
    let startedResolve: (() => void) | undefined;
    let cancelledResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      cancelledResolve = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const { client } = await connect(createLocalYdbMcpApplication({
      config: ConfigSchema.parse({}),
      sqlExecutor: async (_context, request) => {
        observedSignal = request.signal;
        startedResolve?.();
        await new Promise<void>((resolve) => {
          const finish = () => {
            cancelledResolve?.();
            resolve();
          };
          if (request.signal?.aborted) {
            finish();
          } else {
            request.signal?.addEventListener("abort", finish, { once: true });
          }
        });
        return {
          completion: "cancelled",
          resultSets: [],
          capturedBytes: 0,
          truncationReasons: [],
        };
      },
    }));
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "local_ydb_sql", arguments: { script: "SELECT 1;" } },
      undefined,
      { signal: controller.signal },
    );

    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await cancelled;
    expect(observedSignal?.aborted).toBe(true);
  });
});

async function protocolSnapshot(server: ProtocolServer): Promise<{
  capabilities: NonNullable<ReturnType<Client["getServerCapabilities"]>>;
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
  prompts: Awaited<ReturnType<Client["listPrompts"]>>["prompts"];
}> {
  const { client } = await connect(server);
  const tools = await client.listTools();
  const prompts = await client.listPrompts();
  await expect(client.listResources()).rejects.toMatchObject({
    code: ErrorCode.MethodNotFound,
  });

  return {
    capabilities: client.getServerCapabilities() ?? {},
    tools: tools.tools,
    prompts: prompts.prompts,
  };
}

async function connect(server: ProtocolServer): Promise<{ client: Client }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "local-ydb-toolkit-protocol-test", version: "0.0.0" },
    { capabilities: {} },
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openConnections.push({ client, server });
  return { client };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue: unknown) => {
    if (!currentValue || Array.isArray(currentValue) || typeof currentValue !== "object") {
      return currentValue;
    }
    return Object.fromEntries(
      Object.entries(currentValue as Record<string, unknown>).sort(([left], [right]) => (
        left < right ? -1 : left > right ? 1 : 0
      )),
    );
  });
}

function textContentAt(content: unknown, index: number): string {
  if (!Array.isArray(content)) {
    throw new Error("Expected MCP tool content to be an array");
  }
  const item: unknown = content[index];
  if (
    !item
    || typeof item !== "object"
    || !("type" in item)
    || item.type !== "text"
    || !("text" in item)
    || typeof item.text !== "string"
  ) {
    throw new Error(`Expected MCP tool content ${index} to be text`);
  }
  return item.text;
}

function confirmationToken(structuredContent: unknown): string {
  if (
    !structuredContent
    || typeof structuredContent !== "object"
    || !("confirmation" in structuredContent)
  ) {
    throw new Error("Expected confirmation metadata");
  }
  const confirmation = structuredContent.confirmation;
  if (
    !confirmation
    || typeof confirmation !== "object"
    || !("token" in confirmation)
    || typeof confirmation.token !== "string"
  ) {
    throw new Error("Expected confirmation token");
  }
  return confirmation.token;
}
