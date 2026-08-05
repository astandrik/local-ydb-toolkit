import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applySchema,
  createSdkOperationDeadline,
  createContext,
  remainingSdkOperationTimeoutMs,
  type SchemaSdkExecuteRequest,
  type SchemaSdkExecuteResult,
  withSdkConnection,
} from "../src/index.js";
import { ConfigSchema } from "../src/validation.js";

function successfulSdkRecorder(calls: SchemaSdkExecuteRequest[] = []): (request: SchemaSdkExecuteRequest) => Promise<SchemaSdkExecuteResult> {
  return async (request) => {
    calls.push(request);
    return {
      ok: true,
      status: "SUCCESS",
      issues: "",
    };
  };
}

describe("schema application", () => {
  it("provides normalized root and tenant SDK connections with local credentials", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "local-ydb-sdk-connection-test-"));
    const passwordFile = join(tempDir, "root.password");
    const password = "S3cr3t! \t";
    writeFileSync(passwordFile, `${password}\n`, "utf8");
    try {
      const ctx = createContext(undefined, undefined, ConfigSchema.parse({
        profiles: {
          default: {
            rootPasswordFile: passwordFile,
          },
        },
      }));

      const tenant = await withSdkConnection(ctx, {
        databasePath: "/local/example",
        timeoutMs: 1_500,
      }, async (connection) => connection);
      const root = await withSdkConnection(ctx, {
        databasePath: "/local",
        timeoutMs: 1_500,
      }, async (connection) => connection);

      expect(tenant).toMatchObject({
        databasePath: "/local/example",
        endpoint: "grpc://127.0.0.1:2137",
        connectionString: "grpc://127.0.0.1:2137/local/example",
        timeoutMs: 1_500,
        rootUser: "root",
        rootPassword: password,
      });
      expect(root).toMatchObject({
        databasePath: "/local",
        endpoint: "grpc://127.0.0.1:2136",
        connectionString: "grpc://127.0.0.1:2136/local",
      });
      expect(tenant).not.toHaveProperty("deadline");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("links an SDK operation deadline to caller cancellation", () => {
    const caller = new AbortController();
    const deadline = createSdkOperationDeadline(1_000, caller.signal);

    expect(remainingSdkOperationTimeoutMs(deadline)).toBeGreaterThan(0);
    expect(remainingSdkOperationTimeoutMs(deadline)).toBeLessThanOrEqual(1_000);
    caller.abort();
    expect(() => remainingSdkOperationTimeoutMs(deadline)).toThrow();
  });

  it("treats the absolute SDK expiry as authoritative before abort delivery", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const deadline = createSdkOperationDeadline(1_000);
    now.mockReturnValue(11_001);

    try {
      expect(() => remainingSdkOperationTimeoutMs(deadline)).toThrow(
        /deadline expired/,
      );
    } finally {
      now.mockRestore();
    }
  });

  it("validates table DDL without applying it by default", async () => {
    const calls: SchemaSdkExecuteRequest[] = [];
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await applySchema(ctx, {
      script: "CREATE TABLE users (id Uint64, PRIMARY KEY (id));",
      sdkExecutor: successfulSdkRecorder(calls),
    });

    expect(response).toMatchObject({
      action: "validate",
      databasePath: "/local/example",
      executed: false,
      risk: "low",
      statements: {
        count: 1,
        kinds: ["CREATE TABLE"],
      },
      validation: {
        ok: true,
        status: "SUCCESS",
        issues: "",
        issuesTruncated: false,
      },
    });
    expect(response.scriptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(response.plannedCommands.join("\n")).toContain("Validate YDB schema DDL");
    expect(calls.map((call) => call.mode)).toEqual(["validate"]);
    expect(calls[0]?.connectionString).toBe("grpc://127.0.0.1:2137/local/example");
    expect(JSON.stringify(response)).not.toContain("CREATE TABLE users");
  });

  it("validates and returns a plan for apply without confirm=true", async () => {
    const calls: SchemaSdkExecuteRequest[] = [];
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await applySchema(ctx, {
      action: "apply",
      script: "ALTER TABLE users ADD COLUMN name Utf8;",
      sdkExecutor: successfulSdkRecorder(calls),
    });

    expect(response.executed).toBe(false);
    expect(response.risk).toBe("medium");
    expect(response.execution).toBeUndefined();
    expect(response.plannedCommands.join("\n")).toContain("Apply YDB schema DDL");
    expect(calls.map((call) => call.mode)).toEqual(["validate"]);
  });

  it("classifies ALTER TABLE DROP actions as high risk", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await applySchema(ctx, {
      action: "apply",
      script: "ALTER TABLE users DROP COLUMN name;",
      sdkExecutor: successfulSdkRecorder(),
    });

    expect(response.executed).toBe(false);
    expect(response.risk).toBe("high");
    expect(response.statements).toEqual({
      count: 1,
      kinds: ["ALTER TABLE"],
    });
  });

  it("executes apply only after validation succeeds and confirm=true is supplied", async () => {
    const calls: SchemaSdkExecuteRequest[] = [];
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await applySchema(ctx, {
      action: "apply",
      confirm: true,
      script: "CREATE TABLE users (id Uint64, PRIMARY KEY (id));",
      sdkExecutor: successfulSdkRecorder(calls),
    });

    expect(response.executed).toBe(true);
    expect(response.execution).toMatchObject({
      ok: true,
      status: "SUCCESS",
      issues: "",
    });
    expect(calls.map((call) => call.mode)).toEqual(["validate", "execute"]);
  });

  it("shares one absolute timeout across schema validation and execution", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const calls: SchemaSdkExecuteRequest[] = [];
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));
    try {
      await applySchema(ctx, {
        action: "apply",
        confirm: true,
        timeoutMs: 1_000,
        script: "CREATE TABLE users (id Uint64, PRIMARY KEY (id));",
        sdkExecutor: async (request) => {
          calls.push(request);
          if (request.mode === "validate") {
            now.mockReturnValue(10_250);
          }
          return { ok: true, status: "SUCCESS", issues: "" };
        },
      });
    } finally {
      now.mockRestore();
    }

    expect(calls.map((call) => call.timeoutMs)).toEqual([1_000, 750]);
  });

  it("does not execute apply when SDK validation reports YDB issues", async () => {
    const calls: SchemaSdkExecuteRequest[] = [];
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await applySchema(ctx, {
      action: "apply",
      confirm: true,
      script: "CREATE TABLE broken (id MadeUpType, PRIMARY KEY (id));",
      sdkExecutor: async (request) => {
        calls.push(request);
        return {
          ok: false,
          status: "BAD_REQUEST",
          issues: "Unknown type: MadeUpType",
        };
      },
    });

    expect(response.executed).toBe(false);
    expect(response.validation).toMatchObject({
      ok: false,
      status: "BAD_REQUEST",
      issues: "Unknown type: MadeUpType",
    });
    expect(response.execution).toBeUndefined();
    expect(calls.map((call) => call.mode)).toEqual(["validate"]);
  });

  it("rejects unsupported statement classes before SDK validation", async () => {
    const calls: SchemaSdkExecuteRequest[] = [];
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(applySchema(ctx, {
      script: "CREATE USER alice PASSWORD 'secret';",
      sdkExecutor: successfulSdkRecorder(calls),
    })).rejects.toThrow(/Only PRAGMA, CREATE TABLE, ALTER TABLE, and DROP TABLE/);

    await expect(applySchema(ctx, {
      script: "UPSERT INTO users (id) VALUES (1);",
      sdkExecutor: successfulSdkRecorder(calls),
    })).rejects.toThrow(/Only PRAGMA, CREATE TABLE, ALTER TABLE, and DROP TABLE/);

    expect(calls).toEqual([]);
  });

  it("caps validation and execution issues independently", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await applySchema(ctx, {
      action: "apply",
      confirm: true,
      maxOutputBytes: 4,
      script: "DROP TABLE users;",
      sdkExecutor: async (request) => ({
        ok: true,
        status: request.mode === "validate" ? "SUCCESS" : "GENERIC_ERROR",
        issues: request.mode === "validate" ? "abcdef" : "uvwxyz",
      }),
    });

    expect(response.executed).toBe(true);
    expect(response.risk).toBe("high");
    expect(response.validation).toMatchObject({
      issues: "abcd",
      issuesBytes: 6,
      issuesTruncated: true,
    });
    expect(response.execution).toMatchObject({
      issues: "uvwx",
      issuesBytes: 6,
      issuesTruncated: true,
    });
  });

  it("uses the root database endpoint for root database schema paths", async () => {
    const calls: SchemaSdkExecuteRequest[] = [];
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await applySchema(ctx, {
      databasePath: "/local",
      script: "CREATE TABLE root_table (id Uint64, PRIMARY KEY (id));",
      sdkExecutor: successfulSdkRecorder(calls),
    });

    expect(calls[0]?.connectionString).toBe("grpc://127.0.0.1:2136/local");
  });

  it("does not expose password values or password file paths in responses", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "local-ydb-schema-test-"));
    const passwordFile = join(tempDir, "root.password");
    writeFileSync(passwordFile, "S3cr3t!\n", "utf8");
    try {
      const ctx = createContext(undefined, undefined, ConfigSchema.parse({
        profiles: {
          default: {
            rootPasswordFile: passwordFile,
          },
        },
      }));

      const response = await applySchema(ctx, {
        action: "apply",
        script: "CREATE TABLE users (id Uint64, PRIMARY KEY (id));",
        sdkExecutor: successfulSdkRecorder(),
      });

      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain(passwordFile);
      expect(serialized).not.toContain("S3cr3t!");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
