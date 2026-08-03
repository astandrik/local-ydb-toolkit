import { describe, expect, it, vi } from "vitest";
import { createContext } from "../src/operations/context.js";
import { ConfigSchema } from "../src/validation.js";

const networkMocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
}));
const childProcessMocks = vi.hoisted(() => {
  const child = {
    stdout: { resume: vi.fn() },
    stderr: { resume: vi.fn() },
    exitCode: null,
    kill: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  };
  return {
    child,
    spawn: vi.fn(() => child),
  };
});

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createConnection: networkMocks.createConnection,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: childProcessMocks.spawn,
  };
});

describe("shared SDK connection lifecycle", () => {
  it("rejects database paths whose URL form escapes the configured root", async () => {
    // Production break caught: WHATWG URL normalization can turn an apparently
    // rooted child path with raw or encoded dot segments into another database.
    const { normalizeSdkDatabasePath } = await import(
      "../src/operations/sdk-connection.js"
    );
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    for (const databasePath of [
      "/local/../other",
      "/local/%2e%2e/other",
      "/local/./example",
      "/local/%2E/example",
      "/local/child%2Fother",
      "/local/child%5Cother",
      "/local/child\\other",
      "/local/child?query",
      "/local/child#fragment",
      "/local//child",
    ]) {
      expect(() => normalizeSdkDatabasePath(ctx, databasePath)).toThrow(
        /databasePath/,
      );
    }

    expect(normalizeSdkDatabasePath(ctx, "/local")).toBe("/local");
    expect(normalizeSdkDatabasePath(ctx, "/local/example")).toBe(
      "/local/example",
    );
  });

  it("does not create a tunnel probe socket after the absolute deadline expires", async () => {
    // Production break caught: creating the socket before checking remaining
    // time leaves it without error listeners when the deadline check throws.
    const socket = {
      destroy: vi.fn(),
      removeAllListeners: vi.fn(),
      setTimeout: vi.fn(),
      once: vi.fn(),
    };
    networkMocks.createConnection.mockReturnValue(socket);
    const { withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({
      profiles: {
        default: {
          mode: "ssh",
          ssh: { host: "test.invalid" },
        },
      },
    }));
    const deadline = {
      signal: new AbortController().signal,
      expiresAtMs: Date.now() - 1,
    };

    await expect(withSdkConnection(ctx, {
      timeoutMs: 1_000,
      deadline,
    }, async () => {
      throw new Error("SDK callback must not run");
    })).rejects.toThrow(/deadline expired/);

    expect(networkMocks.createConnection).not.toHaveBeenCalled();
    expect(socket.once).not.toHaveBeenCalled();
    expect(childProcessMocks.child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
