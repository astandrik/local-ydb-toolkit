import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  commandToShell,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
} from "../src/api-client.js";
import { createContext } from "../src/operations/context.js";
import { ConfigSchema, type ResolvedLocalYdbProfile } from "../src/validation.js";

const networkMocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
}));

const sdkDriverMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  ready: vi.fn(),
  close: vi.fn(),
}));

const childProcessMocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  type MockChild = {
    stdout: { resume: ReturnType<typeof vi.fn> };
    stderr: { resume: ReturnType<typeof vi.fn> };
    pid: number | undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => void;
  };

  const children: MockChild[] = [];
  const behavior = { exitOnSigterm: true };
  const createChild = (): MockChild => {
    const listeners = new Map<string, Set<Listener>>();
    let child: MockChild;
    child = {
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
      pid: 12_345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      once: vi.fn((event: string, listener: Listener): MockChild => {
        const eventListeners = listeners.get(event) ?? new Set<Listener>();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
        return child;
      }),
      off: vi.fn((event: string, listener: Listener): MockChild => {
        listeners.get(event)?.delete(listener);
        return child;
      }),
      emit: () => undefined,
    } satisfies MockChild;
    const emit = (event: string, ...args: unknown[]) => {
      const eventListeners = [...(listeners.get(event) ?? [])];
      listeners.delete(event);
      for (const listener of eventListeners) {
        listener(...args);
      }
    };
    child.emit = emit;
    child.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === "SIGKILL" || behavior.exitOnSigterm) {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.signalCode = signal;
          emit("exit", 0, signal);
        });
      }
      return true;
    });
    children.push(child);
    return child;
  };

  return {
    children,
    behavior,
    createChild,
    spawn: vi.fn((_command: string, _args: string[]) => createChild()),
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

vi.mock("@ydbjs/core", () => ({
  Driver: class {
    constructor(connectionString: string, options: Record<string, unknown>) {
      sdkDriverMocks.construct(connectionString, options);
    }

    ready(signal?: AbortSignal) {
      return sdkDriverMocks.ready(signal);
    }

    close() {
      sdkDriverMocks.close();
    }
  },
}));

vi.mock("@ydbjs/auth/anonymous", () => ({
  AnonymousCredentialsProvider: class {},
}));

vi.mock("@ydbjs/auth/static", () => ({
  StaticCredentialsProvider: class {
    constructor(..._args: unknown[]) {}
  },
}));

class InspectExecutor implements CommandExecutor {
  readonly commands: CommandSpec[] = [];

  constructor(private readonly inspectByContainer: Record<string, unknown>) {}

  display(_profile: ResolvedLocalYdbProfile, spec: CommandSpec): string {
    return commandToShell(spec);
  }

  async run(profile: ResolvedLocalYdbProfile, spec: CommandSpec): Promise<CommandResult> {
    this.commands.push(spec);
    const command = this.display(profile, spec);
    const container = spec.command === "docker" && spec.args?.[0] === "inspect"
      ? spec.args.at(-1)
      : undefined;
    const inspect = container ? this.inspectByContainer[container] : undefined;
    return {
      command,
      exitCode: inspect === undefined ? 1 : 0,
      stdout: inspect === undefined ? "" : JSON.stringify(inspect),
      stderr: inspect === undefined ? "missing test inspect" : "",
      ok: inspect !== undefined,
      timedOut: false,
    };
  }
}

function successfulProbeSocket() {
  const socket = {
    destroy: vi.fn(),
    removeAllListeners: vi.fn(),
    setTimeout: vi.fn(),
    once: vi.fn(),
  };
  socket.once.mockImplementation((event: string, listener: () => void) => {
    if (event === "connect") {
      queueMicrotask(listener);
    }
    return socket;
  });
  return socket;
}

function inspectContainer(
  id: string,
  name: string,
  networkMode: string,
  networks: Record<string, { IPAddress: string }> = {},
) {
  return {
    id,
    name: `/${name}`,
    networkMode,
    networks,
  };
}

function sshContext(executor: CommandExecutor) {
  return createContext(undefined, executor, ConfigSchema.parse({
    profiles: {
      default: {
        mode: "ssh",
        ssh: { host: "test.invalid" },
        staticContainer: "ydb-static",
        dynamicContainer: "ydb-dynamic",
        network: "ydb-net",
        ports: { dynamicGrpc: 2141 },
      },
    },
  }));
}

describe("shared SDK connection lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childProcessMocks.children.length = 0;
    childProcessMocks.behavior.exitOnSigterm = true;
    childProcessMocks.spawn.mockImplementation(
      (_command: string, _args: string[]) => childProcessMocks.createChild(),
    );
    networkMocks.createConnection.mockImplementation(() => successfulProbeSocket());
    sdkDriverMocks.ready.mockResolvedValue(undefined);
  });

  it("rejects database paths whose URL form escapes the configured root", async () => {
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

  it("forwards a tenant SDK connection to the static container namespace IP", async () => {
    const executor = new InspectExecutor({
      "ydb-dynamic": inspectContainer(
        "dynamic-id",
        "ydb-dynamic",
        "container:static-id",
      ),
      "ydb-static": inspectContainer(
        "static-id",
        "ydb-static",
        "ydb-net",
        { "ydb-net": { IPAddress: "172.20.0.4" } },
      ),
    });
    const ctx = sshContext(executor);
    const { withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );

    const result = await withSdkConnection(ctx, {
      databasePath: "/local/example",
      timeoutMs: 1_000,
    }, async (connection) => connection);

    expect(result.endpoint).toMatch(/^grpc:\/\/127\.0\.0\.1:\d+$/);
    expect(executor.commands.map((spec) => spec.args?.at(-1))).toEqual([
      "ydb-dynamic",
      "ydb-static",
    ]);
    for (const command of executor.commands) {
      expect(command.args?.slice(0, 4)).toEqual([
        "inspect",
        "--type", "container",
        "--format",
      ]);
      expect(command.args?.[4]).toContain("NetworkSettings.Networks");
    }
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1);
    const sshArgs = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
    expect(sshArgs).toContainEqual(expect.stringMatching(
      /^127\.0\.0\.1:\d+:172\.20\.0\.4:2141$/,
    ));
    expect(sdkDriverMocks.construct).toHaveBeenCalledWith(
      expect.stringMatching(/^grpc:\/\/127\.0\.0\.1:\d+\/local\/example$/),
      expect.objectContaining({ "ydb.sdk.enable_discovery": true }),
    );
    expect(childProcessMocks.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.each([
    {
      label: "root database on the configured bridge",
      databasePath: "/local",
      inspectByContainer: {
        "ydb-static": inspectContainer(
          "static-id",
          "ydb-static",
          "ydb-net",
          { "ydb-net": { IPAddress: "172.20.0.5" } },
        ),
      },
      expectedInspects: ["ydb-static"],
      expectedForward: /:172\.20\.0\.5:2136$/,
    },
    {
      label: "tenant database directly attached to the configured bridge",
      databasePath: "/local/example",
      inspectByContainer: {
        "ydb-dynamic": inspectContainer(
          "dynamic-id",
          "ydb-dynamic",
          "ydb-net",
          { "ydb-net": { IPAddress: "172.20.0.6" } },
        ),
      },
      expectedInspects: ["ydb-dynamic"],
      expectedForward: /:172\.20\.0\.6:2141$/,
    },
    {
      label: "tenant database attached to the configured non-primary bridge",
      databasePath: "/local/example",
      inspectByContainer: {
        "ydb-dynamic": inspectContainer(
          "dynamic-id",
          "ydb-dynamic",
          "default",
          { "ydb-net": { IPAddress: "172.20.0.7" } },
        ),
      },
      expectedInspects: ["ydb-dynamic"],
      expectedForward: /:172\.20\.0\.7:2141$/,
    },
    {
      label: "tenant database using host networking",
      databasePath: "/local/example",
      inspectByContainer: {
        "ydb-dynamic": inspectContainer(
          "dynamic-id",
          "ydb-dynamic",
          "host",
        ),
      },
      expectedInspects: ["ydb-dynamic"],
      expectedForward: /:127\.0\.0\.1:2141$/,
    },
  ])("resolves $label", async ({
    databasePath,
    inspectByContainer,
    expectedInspects,
    expectedForward,
  }) => {
    const executor = new InspectExecutor(inspectByContainer);
    const { withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );

    await withSdkConnection(sshContext(executor), {
      databasePath,
      timeoutMs: 1_000,
    }, async () => undefined);

    expect(executor.commands.map((spec) => spec.args?.at(-1))).toEqual(
      expectedInspects,
    );
    const sshArgs = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
    expect(sshArgs).toContainEqual(expect.stringMatching(expectedForward));
  });

  it.each([
    {
      label: "an unexpected namespace owner",
      inspectByContainer: {
        "ydb-dynamic": inspectContainer(
          "dynamic-id",
          "ydb-dynamic",
          "container:other-id",
        ),
        "ydb-static": inspectContainer(
          "static-id",
          "ydb-static",
          "ydb-net",
          { "ydb-net": { IPAddress: "172.20.0.4" } },
        ),
      },
    },
    {
      label: "a missing configured network",
      inspectByContainer: {
        "ydb-dynamic": inspectContainer(
          "dynamic-id",
          "ydb-dynamic",
          "other-net",
          { "other-net": { IPAddress: "172.21.0.4" } },
        ),
      },
    },
    {
      label: "a namespace owner outside the configured network",
      inspectByContainer: {
        "ydb-dynamic": inspectContainer(
          "dynamic-id",
          "ydb-dynamic",
          "container:static-id",
        ),
        "ydb-static": inspectContainer(
          "static-id",
          "ydb-static",
          "host",
        ),
      },
    },
    {
      label: "a root target sharing another container namespace",
      databasePath: "/local",
      inspectByContainer: {
        "ydb-static": inspectContainer(
          "static-id",
          "ydb-static",
          "container:other-id",
        ),
      },
    },
    {
      label: "an invalid IPv4 address",
      inspectByContainer: {
        "ydb-dynamic": inspectContainer(
          "dynamic-id",
          "ydb-dynamic",
          "ydb-net",
          { "ydb-net": { IPAddress: "172.20.0.4\nProxyCommand=bad" } },
        ),
      },
    },
    {
      label: "an inspect response for a different container",
      inspectByContainer: {
        "ydb-dynamic": inspectContainer(
          "different-id",
          "different-name",
          "ydb-net",
          { "ydb-net": { IPAddress: "172.20.0.6" } },
        ),
      },
    },
  ])("rejects $label before spawning SSH", async ({
    databasePath,
    inspectByContainer,
  }) => {
    const executor = new InspectExecutor(inspectByContainer);
    const callback = vi.fn();
    const { withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );

    await expect(withSdkConnection(sshContext(executor), {
      databasePath,
      timeoutMs: 1_000,
    }, callback)).rejects.toThrow("Docker SDK target resolution failed.");

    expect(callback).not.toHaveBeenCalled();
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("rejects malformed docker inspect JSON without exposing it", async () => {
    const executor = new InspectExecutor({});
    executor.run = async (profile, spec) => ({
      command: executor.display(profile, spec),
      exitCode: 0,
      stdout: "{private malformed inspect",
      stderr: "private stderr",
      ok: true,
      timedOut: false,
    });
    const { withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );

    const operation = withSdkConnection(sshContext(executor), {
      timeoutMs: 1_000,
    }, async () => undefined);
    await expect(operation).rejects.toThrow("Docker SDK target resolution failed.");
    await operation.catch((error: unknown) => {
      expect(String(error)).not.toContain("private");
    });
  });

  it("does not treat an open SSH listener as YDB readiness", async () => {
    sdkDriverMocks.ready.mockRejectedValueOnce(new Error("private target details"));
    const executor = new InspectExecutor({
      "ydb-dynamic": inspectContainer(
        "dynamic-id",
        "ydb-dynamic",
        "container:static-id",
      ),
      "ydb-static": inspectContainer(
        "static-id",
        "ydb-static",
        "ydb-net",
        { "ydb-net": { IPAddress: "172.20.0.4" } },
      ),
    });
    const ctx = sshContext(executor);
    const callback = vi.fn();
    const { withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );

    await expect(withSdkConnection(ctx, {
      timeoutMs: 1_000,
    }, callback)).rejects.toThrow("YDB target readiness check failed.");

    expect(callback).not.toHaveBeenCalled();
    expect(sdkDriverMocks.close).toHaveBeenCalledTimes(1);
    expect(childProcessMocks.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not hang cleanup when the SSH process fails before spawn", async () => {
    childProcessMocks.spawn.mockImplementationOnce(() => {
      const child = childProcessMocks.createChild();
      queueMicrotask(() => {
        child.pid = undefined;
        child.emit("error", new Error("spawn failed"));
      });
      return child;
    });
    const executor = new InspectExecutor({
      "ydb-dynamic": inspectContainer(
        "dynamic-id",
        "ydb-dynamic",
        "ydb-net",
        { "ydb-net": { IPAddress: "172.20.0.6" } },
      ),
    });
    const { withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );

    await expect(withSdkConnection(sshContext(executor), {
      timeoutMs: 1_000,
    }, async () => undefined)).rejects.toThrow("SSH listener setup failed.");

    expect(childProcessMocks.children[0]?.kill).not.toHaveBeenCalled();
  });

  it("passes the absolute deadline through inspect and bounds the YDB probe", async () => {
    const executor = new InspectExecutor({
      "ydb-dynamic": inspectContainer(
        "dynamic-id",
        "ydb-dynamic",
        "ydb-net",
        { "ydb-net": { IPAddress: "172.20.0.6" } },
      ),
    });
    const { createSdkOperationDeadline, withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );
    const deadline = createSdkOperationDeadline(20_000);

    await withSdkConnection(sshContext(executor), {
      timeoutMs: 20_000,
      deadline,
    }, async () => undefined);

    expect(executor.commands[0]?.signal).toBe(deadline.signal);
    expect(executor.commands[0]?.timeoutMs).toBeGreaterThan(0);
    expect(executor.commands[0]?.timeoutMs).toBeLessThanOrEqual(20_000);
    const probeOptions = sdkDriverMocks.construct.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(probeOptions["ydb.sdk.ready_timeout_ms"]).toBe(12_000);
    const probeSignal = sdkDriverMocks.ready.mock.calls[0]?.[0] as AbortSignal;
    expect(probeSignal).not.toBe(deadline.signal);
    expect(probeSignal.aborted).toBe(false);
  });

  it("cleans up the tunnel when the SDK callback fails", async () => {
    const executor = new InspectExecutor({
      "ydb-dynamic": inspectContainer(
        "dynamic-id",
        "ydb-dynamic",
        "ydb-net",
        { "ydb-net": { IPAddress: "172.20.0.6" } },
      ),
    });
    const { withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );

    await expect(withSdkConnection(sshContext(executor), {
      timeoutMs: 1_000,
    }, async () => {
      throw new Error("callback failed");
    })).rejects.toThrow("callback failed");

    expect(childProcessMocks.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not replace a successful result when tunnel signalling races with exit", async () => {
    const executor = new InspectExecutor({
      "ydb-dynamic": inspectContainer(
        "dynamic-id",
        "ydb-dynamic",
        "ydb-net",
        { "ydb-net": { IPAddress: "172.20.0.6" } },
      ),
    });
    childProcessMocks.spawn.mockImplementationOnce(() => {
      const child = childProcessMocks.createChild();
      child.kill.mockImplementationOnce(() => {
        child.exitCode = 0;
        throw new Error("process already exited");
      });
      return child;
    });
    const { withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );

    await expect(withSdkConnection(sshContext(executor), {
      timeoutMs: 1_000,
    }, async () => 42)).resolves.toBe(42);

    expect(childProcessMocks.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cleans up the tunnel when caller cancellation interrupts readiness", async () => {
    const executor = new InspectExecutor({
      "ydb-dynamic": inspectContainer(
        "dynamic-id",
        "ydb-dynamic",
        "ydb-net",
        { "ydb-net": { IPAddress: "172.20.0.6" } },
      ),
    });
    const caller = new AbortController();
    sdkDriverMocks.ready.mockImplementationOnce((signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    const { createSdkOperationDeadline, withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );
    const deadline = createSdkOperationDeadline(1_000, caller.signal);
    const callback = vi.fn();
    const operation = withSdkConnection(sshContext(executor), {
      timeoutMs: 1_000,
      deadline,
    }, callback);
    const rejection = expect(operation).rejects.toThrow(
      "YDB target readiness check failed.",
    );
    await vi.waitFor(() => expect(sdkDriverMocks.ready).toHaveBeenCalled());

    caller.abort(new Error("private abort reason"));
    await rejection;

    expect(callback).not.toHaveBeenCalled();
    expect(childProcessMocks.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cleans up the tunnel when the absolute deadline expires during readiness", async () => {
    const executor = new InspectExecutor({
      "ydb-dynamic": inspectContainer(
        "dynamic-id",
        "ydb-dynamic",
        "ydb-net",
        { "ydb-net": { IPAddress: "172.20.0.6" } },
      ),
    });
    sdkDriverMocks.ready.mockImplementationOnce((signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    const { createSdkOperationDeadline, withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );
    const deadline = createSdkOperationDeadline(250);
    const callback = vi.fn();

    await expect(withSdkConnection(sshContext(executor), {
      timeoutMs: 250,
      deadline,
    }, callback)).rejects.toThrow("YDB target readiness check failed.");

    expect(callback).not.toHaveBeenCalled();
    expect(childProcessMocks.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates tunnel shutdown to SIGKILL after the grace period", async () => {
    vi.useFakeTimers();
    childProcessMocks.behavior.exitOnSigterm = false;
    const executor = new InspectExecutor({
      "ydb-dynamic": inspectContainer(
        "dynamic-id",
        "ydb-dynamic",
        "ydb-net",
        { "ydb-net": { IPAddress: "172.20.0.6" } },
      ),
    });
    const { withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );

    try {
      const operation = withSdkConnection(sshContext(executor), {
        timeoutMs: 2_000,
      }, async () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(childProcessMocks.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(1_000);
      await operation;

      expect(childProcessMocks.children[0]?.kill.mock.calls).toEqual([
        ["SIGTERM"],
        ["SIGKILL"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the tunnel shutdown grace by the absolute deadline", async () => {
    vi.useFakeTimers();
    childProcessMocks.behavior.exitOnSigterm = false;
    const executor = new InspectExecutor({
      "ydb-dynamic": inspectContainer(
        "dynamic-id",
        "ydb-dynamic",
        "ydb-net",
        { "ydb-net": { IPAddress: "172.20.0.6" } },
      ),
    });
    const { createSdkOperationDeadline, withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );
    const deadline = createSdkOperationDeadline(250);

    try {
      const operation = withSdkConnection(sshContext(executor), {
        timeoutMs: 250,
        deadline,
      }, async () => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(childProcessMocks.children[0]?.kill.mock.calls).toEqual([
        ["SIGTERM"],
      ]);

      await vi.advanceTimersByTimeAsync(249);
      expect(childProcessMocks.children[0]?.kill).not.toHaveBeenCalledWith(
        "SIGKILL",
      );

      await vi.advanceTimersByTimeAsync(1);
      await operation;
      expect(childProcessMocks.children[0]?.kill.mock.calls).toEqual([
        ["SIGTERM"],
        ["SIGKILL"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not create a tunnel probe socket after the absolute deadline expires", async () => {
    const socket = successfulProbeSocket();
    networkMocks.createConnection.mockReturnValue(socket);
    const { withSdkConnection } = await import(
      "../src/operations/sdk-connection.js"
    );
    const executor = new InspectExecutor({
      "ydb-dynamic": inspectContainer(
        "dynamic-id",
        "ydb-dynamic",
        "container:static-id",
      ),
      "ydb-static": inspectContainer(
        "static-id",
        "ydb-static",
        "ydb-net",
        { "ydb-net": { IPAddress: "172.20.0.4" } },
      ),
    });
    const ctx = sshContext(executor);
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
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });
});
