import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyAuthHardening,
  ProcessConfirmationStore,
  ShellCommandExecutor,
  commandToShell,
  createContext,
  dumpTenant,
  restoreTenant,
  type CommandExecutor,
  type CommandResult,
  type CommandSpec,
  type ToolkitContext,
} from "../src/index.js";
import { runMutating } from "../src/operations/execution.js";
import {
  authorizeMutation,
  confirmationSummarySuffix,
  withConfirmationLease,
} from "../src/confirmation.js";
import { MAX_CONFIRMATION_FILE_BYTES } from "../src/confirmation-inputs.js";
import { ConfigSchema } from "../src/validation.js";

class CountingExecutor implements CommandExecutor {
  calls = 0;
  fail = false;

  display(_profile: ToolkitContext["profile"], spec: CommandSpec): string {
    return commandToShell(spec);
  }

  async run(_profile: ToolkitContext["profile"], spec: CommandSpec): Promise<CommandResult> {
    this.calls += 1;
    if (this.fail) {
      throw new Error("synthetic execution failure");
    }
    return {
      command: commandToShell(spec),
      exitCode: 0,
      stdout: "",
      stderr: "",
      ok: true,
      timedOut: false,
    };
  }
}

class FingerprintingExecutor extends CountingExecutor {
  readonly #shell = new ShellCommandExecutor();

  override run(
    profile: ToolkitContext["profile"],
    spec: CommandSpec,
  ): Promise<CommandResult> {
    if (spec.description?.startsWith("Fingerprint ")) {
      return this.#shell.run(profile, spec);
    }
    return super.run(profile, spec);
  }
}

const SECRET = "BENIGN_CONFIRMATION_SECRET";
const plan = {
  summary: "Apply exact test plan.",
  risk: "high" as const,
  specs: [{
    command: "example-mutation",
    args: ["--target", "alpha"],
    stdin: SECRET,
    timeoutMs: 12_345,
    allowFailure: false,
    description: "Synthetic mutation",
    redactions: [SECRET],
  }],
  rollback: ["Undo synthetic mutation."],
  verification: ["Read synthetic state."],
};

describe("process confirmation store", () => {
  it("maps response confirmation.token to the confirmationToken request argument in summaries", () => {
    for (const confirmation of [
      { status: "planned" as const, token: "planned-token" },
      { status: "rejected" as const, token: "refreshed-token" },
    ]) {
      const summary = confirmationSummarySuffix(confirmation);
      expect(summary).toContain("confirmation.token");
      expect(summary).toContain("confirmationToken request argument");
      expect(summary).not.toContain("plan's confirmationToken");
    }
  });

  it("accepts an exact plan once without exposing secret-bearing intent", async () => {
    const executor = new CountingExecutor();
    const ctx = confirmationContext(new ProcessConfirmationStore(), executor);
    const planned = await runMutating(ctx, plan, {});
    const token = planned.confirmation?.token;

    expect(planned.confirmation).toMatchObject({ status: "planned", token: expect.any(String) });
    expect(JSON.stringify(planned)).not.toContain(SECRET);
    expect(token).not.toContain(SECRET);
    expect(executor.calls).toBe(0);

    const accepted = await runMutating(ctx, plan, {
      confirm: true,
      confirmationToken: token,
    });
    expect(accepted).toMatchObject({
      executed: true,
      confirmation: { status: "accepted" },
    });
    expect(executor.calls).toBe(1);

    const replay = await runMutating(ctx, plan, {
      confirm: true,
      confirmationToken: token,
    });
    expect(replay).toMatchObject({
      executed: false,
      confirmation: { status: "rejected", token: expect.any(String) },
    });
    expect(executor.calls).toBe(1);
  });

  it("rejects non-canonical base64url aliases of a consumed token", async () => {
    const executor = new CountingExecutor();
    const ctx = confirmationContext(new ProcessConfirmationStore(), executor);
    const planned = await runMutating(ctx, plan, {});
    const token = planned.confirmation?.token;
    if (!token) {
      throw new Error("Expected plan token");
    }
    const [version, nonce, intentMac, capabilityMac] = token.split(".");
    const aliasedNonce = replaceLastBase64UrlCharacter(nonce!);
    const alias = `${version}.${aliasedNonce}.${intentMac}.${capabilityMac}`;
    expect(Buffer.from(aliasedNonce, "base64url")).toEqual(Buffer.from(nonce!, "base64url"));

    expect(await runMutating(ctx, plan, {
      confirm: true,
      confirmationToken: token,
    })).toMatchObject({
      executed: true,
      confirmation: { status: "accepted" },
    });

    const response = await runMutating(ctx, plan, {
      confirm: true,
      confirmationToken: alias,
    });
    expect(response).toMatchObject({
      executed: false,
      confirmation: { status: "rejected" },
    });
    expect(executor.calls).toBe(1);
  });

  it("rejects missing, malformed, changed-plan, wrong-tool, and wrong-profile tokens", async () => {
    const store = new ProcessConfirmationStore();
    const executor = new CountingExecutor();
    const ctx = confirmationContext(store, executor);
    const planned = await runMutating(ctx, plan, {});
    const token = planned.confirmation?.token;

    for (const confirmationToken of [undefined, "malformed", `${token}x`]) {
      const response = await runMutating(ctx, plan, { confirm: true, confirmationToken });
      expect(response).toMatchObject({
        executed: false,
        confirmation: { status: "rejected", token: expect.any(String) },
      });
    }

    const changedPlan = {
      ...plan,
      specs: [{ ...plan.specs[0], args: ["--target", "beta"] }],
    };
    expect(await runMutating(ctx, changedPlan, {
      confirm: true,
      confirmationToken: token,
    })).toMatchObject({ executed: false, confirmation: { status: "rejected" } });

    const changedSecret = {
      ...plan,
      specs: [{ ...plan.specs[0], stdin: `${SECRET}-changed` }],
    };
    expect(await runMutating(ctx, changedSecret, {
      confirm: true,
      confirmationToken: token,
    })).toMatchObject({ executed: false, confirmation: { status: "rejected" } });

    const wrongTool = confirmationContext(store, executor, "local_ydb_other");
    expect(await runMutating(wrongTool, plan, {
      confirm: true,
      confirmationToken: token,
    })).toMatchObject({ executed: false, confirmation: { status: "rejected" } });

    const wrongProfile = confirmationContext(store, executor, "local_ydb_test", "other");
    expect(await runMutating(wrongProfile, plan, {
      confirm: true,
      confirmationToken: token,
    })).toMatchObject({ executed: false, confirmation: { status: "rejected" } });

    const changedSource = {
      ...ctx,
      confirmation: {
        ...ctx.confirmation!,
        configSource: { kind: "argument", path: "/tmp/config.json", contentSha256: "changed" },
      },
    };
    expect(await runMutating(changedSource, plan, {
      confirm: true,
      confirmationToken: token,
    })).toMatchObject({ executed: false, confirmation: { status: "rejected" } });
    expect(executor.calls).toBe(0);
  });

  it("invalidates tokens when the process store is replaced", async () => {
    const executor = new CountingExecutor();
    const planned = await runMutating(
      confirmationContext(new ProcessConfirmationStore(), executor),
      plan,
      {},
    );
    const restarted = confirmationContext(new ProcessConfirmationStore(), executor);
    const response = await runMutating(restarted, plan, {
      confirm: true,
      confirmationToken: planned.confirmation?.token,
    });

    expect(response).toMatchObject({
      executed: false,
      confirmation: { status: "rejected", token: expect.any(String) },
    });
    expect(executor.calls).toBe(0);
  });

  it("consumes one token synchronously across concurrent calls", async () => {
    const executor = new CountingExecutor();
    const ctx = confirmationContext(new ProcessConfirmationStore(), executor);
    const planned = await runMutating(ctx, plan, {});
    const options = {
      confirm: true,
      confirmationToken: planned.confirmation?.token,
    };

    const responses = await Promise.all([
      runMutating(ctx, plan, options),
      runMutating(ctx, plan, options),
    ]);
    expect(responses.map((response) => response.confirmation?.status).sort()).toEqual([
      "accepted",
      "rejected",
    ]);
    expect(executor.calls).toBe(1);
  });

  it("rejects distinct tokens issued for a stale rotating-scope generation", () => {
    const store = new ProcessConfirmationStore();
    const rotatingScope = { kind: "auto-dump-name", profile: "default" };
    const scopedId = store.scopedId(rotatingScope);
    const intent = { kind: "dump", dumpName: `tenant-auto-${scopedId}` };
    const firstToken = store.issue(intent, rotatingScope);
    const secondToken = store.issue(intent, rotatingScope);

    expect(store.consume(firstToken, intent, rotatingScope)).toBe(true);
    expect(store.scopedId(rotatingScope)).not.toBe(scopedId);
    expect(store.consume(secondToken, intent, rotatingScope)).toBe(false);
  });

  it("shares an exclusive lease across tools for the same resolved profile", async () => {
    const store = new ProcessConfirmationStore();
    const executor = new CountingExecutor();
    const firstCtx = confirmationContext(store, executor, "local_ydb_upgrade_version");
    const secondCtx = {
      ...firstCtx,
      confirmation: {
        ...firstCtx.confirmation!,
        toolName: "local_ydb_reduce_storage_groups",
      },
    };
    const sharedExclusiveScope = { kind: "profile-composite-rebuild" };
    const firstIntent = { kind: "version-upgrade", dumpName: "first" };
    const secondIntent = { kind: "storage-rebuild", dumpName: "second" };
    const firstPlan = await authorizeMutation(firstCtx, {}, firstIntent, { sharedExclusiveScope });
    const secondPlan = await authorizeMutation(secondCtx, {}, secondIntent, { sharedExclusiveScope });

    const accepted = await authorizeMutation(firstCtx, {
      confirm: true,
      confirmationToken: firstPlan.confirmation?.token,
    }, firstIntent, { sharedExclusiveScope });
    const rejected = await authorizeMutation(secondCtx, {
      confirm: true,
      confirmationToken: secondPlan.confirmation?.token,
    }, secondIntent, { sharedExclusiveScope });

    expect(accepted).toMatchObject({ execute: true, confirmation: { status: "accepted" } });
    expect(rejected).toMatchObject({ execute: false, confirmation: { status: "rejected" } });
  });

  it("keeps shared exclusive leases independent across profiles", async () => {
    const store = new ProcessConfirmationStore();
    const executor = new CountingExecutor();
    const defaultCtx = confirmationContext(store, executor, "local_ydb_upgrade_version");
    const otherCtx = confirmationContext(store, executor, "local_ydb_reduce_storage_groups", "other");
    const sharedExclusiveScope = { kind: "profile-composite-rebuild" };
    const intent = { kind: "composite-rebuild" };
    const defaultPlan = await authorizeMutation(defaultCtx, {}, intent, { sharedExclusiveScope });
    const otherPlan = await authorizeMutation(otherCtx, {}, intent, { sharedExclusiveScope });

    expect(await authorizeMutation(defaultCtx, {
      confirm: true,
      confirmationToken: defaultPlan.confirmation?.token,
    }, intent, { sharedExclusiveScope })).toMatchObject({ execute: true });
    expect(await authorizeMutation(otherCtx, {
      confirm: true,
      confirmationToken: otherPlan.confirmation?.token,
    }, intent, { sharedExclusiveScope })).toMatchObject({ execute: true });
  });

  it("invalidates plans issued during an exclusive lease after release", async () => {
    const store = new ProcessConfirmationStore();
    const executor = new CountingExecutor();
    const ctx = confirmationContext(store, executor, "local_ydb_upgrade_version");
    const sharedExclusiveScope = { kind: "profile-composite-rebuild" };
    const firstIntent = { kind: "version-upgrade", dumpName: "first" };
    const secondIntent = { kind: "version-upgrade", dumpName: "second" };
    const firstPlan = await authorizeMutation(ctx, {}, firstIntent, { sharedExclusiveScope });
    const accepted = await authorizeMutation(ctx, {
      confirm: true,
      confirmationToken: firstPlan.confirmation?.token,
    }, firstIntent, { sharedExclusiveScope });
    const duringExecutionPlan = await authorizeMutation(
      ctx,
      {},
      secondIntent,
      { sharedExclusiveScope },
    );

    const busy = await authorizeMutation(ctx, {
      confirm: true,
      confirmationToken: duringExecutionPlan.confirmation?.token,
    }, secondIntent, { sharedExclusiveScope });
    expect(accepted).toMatchObject({ execute: true, confirmation: { status: "accepted" } });
    expect(busy).toMatchObject({ execute: false, confirmation: { status: "rejected" } });

    accepted.receipt?.release?.();
    accepted.receipt?.release?.();

    expect(await authorizeMutation(ctx, {
      confirm: true,
      confirmationToken: duringExecutionPlan.confirmation?.token,
    }, secondIntent, { sharedExclusiveScope })).toMatchObject({
      execute: false,
      confirmation: { status: "rejected" },
    });

    const freshPlan = await authorizeMutation(ctx, {}, secondIntent, { sharedExclusiveScope });
    const freshAccepted = await authorizeMutation(ctx, {
      confirm: true,
      confirmationToken: freshPlan.confirmation?.token,
    }, secondIntent, { sharedExclusiveScope });
    expect(freshAccepted).toMatchObject({
      execute: true,
      confirmation: { status: "accepted" },
    });
    freshAccepted.receipt?.release?.();
  });

  it("releases an exclusive lease when accepted execution fails", async () => {
    const store = new ProcessConfirmationStore();
    const ctx = confirmationContext(
      store,
      new CountingExecutor(),
      "local_ydb_upgrade_version",
    );
    const sharedExclusiveScope = { kind: "profile-composite-rebuild" };
    const intent = { kind: "version-upgrade", dumpName: "failure" };
    const planBeforeFailure = await authorizeMutation(ctx, {}, intent, { sharedExclusiveScope });
    const accepted = await authorizeMutation(ctx, {
      confirm: true,
      confirmationToken: planBeforeFailure.confirmation?.token,
    }, intent, { sharedExclusiveScope });

    await expect(withConfirmationLease(accepted.receipt, async () => {
      throw new Error("synthetic lease failure");
    })).rejects.toThrow("synthetic lease failure");

    const freshPlan = await authorizeMutation(ctx, {}, intent, { sharedExclusiveScope });
    const freshAccepted = await authorizeMutation(ctx, {
      confirm: true,
      confirmationToken: freshPlan.confirmation?.token,
    }, intent, { sharedExclusiveScope });
    expect(freshAccepted).toMatchObject({
      execute: true,
      confirmation: { status: "accepted" },
    });
    freshAccepted.receipt?.release?.();
  });

  it("rejects simultaneous rotating and shared exclusive scopes", async () => {
    const ctx = confirmationContext(new ProcessConfirmationStore(), new CountingExecutor());
    await expect(authorizeMutation(ctx, {}, plan, {
      rotatingScope: { kind: "contextual" },
      sharedExclusiveScope: { kind: "shared" },
    })).rejects.toThrow("cannot use rotating and shared exclusive scopes together");
  });

  it("retires submitted current-process tokens on zero-command mutating exits", async () => {
    const executor = new CountingExecutor();
    const ctx = confirmationContext(new ProcessConfirmationStore(), executor);
    const planned = await runMutating(ctx, plan, {});
    const emptyPlan = { ...plan, specs: [] };

    const noOp = await runMutating(ctx, emptyPlan, {
      confirm: true,
      confirmationToken: planned.confirmation?.token,
    });
    const replay = await runMutating(ctx, plan, {
      confirm: true,
      confirmationToken: planned.confirmation?.token,
    });

    expect(noOp).toMatchObject({ executed: false, confirmation: { status: "not-required" } });
    expect(replay).toMatchObject({ executed: false, confirmation: { status: "rejected" } });
    expect(executor.calls).toBe(0);
  });

  it("does not retire malformed or foreign tokens on zero-command exits", async () => {
    const executor = new CountingExecutor();
    const store = new ProcessConfirmationStore();
    const ctx = confirmationContext(store, executor);
    const planned = await runMutating(ctx, plan, {});
    const emptyPlan = { ...plan, specs: [] };
    const foreign = new ProcessConfirmationStore().issue({ kind: "foreign" });

    for (const confirmationToken of ["malformed", foreign]) {
      expect(await runMutating(ctx, emptyPlan, {
        confirm: true,
        confirmationToken,
      })).toMatchObject({ confirmation: { status: "not-required" } });
    }
    expect(await runMutating(ctx, plan, {
      confirm: true,
      confirmationToken: planned.confirmation?.token,
    })).toMatchObject({ executed: true, confirmation: { status: "accepted" } });
    expect(executor.calls).toBe(1);
  });

  it("keeps a token consumed when execution throws", async () => {
    const executor = new CountingExecutor();
    executor.fail = true;
    const ctx = confirmationContext(new ProcessConfirmationStore(), executor);
    const planned = await runMutating(ctx, plan, {});
    const options = {
      confirm: true,
      confirmationToken: planned.confirmation?.token,
    };

    await expect(runMutating(ctx, plan, options)).rejects.toThrow("synthetic execution failure");
    executor.fail = false;
    const replay = await runMutating(ctx, plan, options);
    expect(replay).toMatchObject({
      executed: false,
      confirmation: { status: "rejected" },
    });
    expect(executor.calls).toBe(1);
  });

  it("retires only canonical capabilities issued by the current process", async () => {
    const store = new ProcessConfirmationStore();
    const token = store.issue(plan);
    const wrongIntentToken = store.issue({ kind: "different-tool-intent" });
    const foreignToken = new ProcessConfirmationStore().issue(plan);

    expect(store.retire("malformed")).toBe(false);
    expect(store.retire(foreignToken)).toBe(false);
    expect(store.retire(token)).toBe(true);
    expect(store.retire(token)).toBe(false);
    expect(store.consume(token, plan)).toBe(false);
    expect(store.retire(wrongIntentToken)).toBe(true);
    expect(store.consume(wrongIntentToken, { kind: "different-tool-intent" })).toBe(false);
  });

  it("does not retire a token whose intent MAC was tampered", () => {
    const store = new ProcessConfirmationStore();
    const token = store.issue(plan);
    const [version, nonce, intentMac, capabilityMac] = token.split(".");
    const tamperedIntentMac = `${intentMac?.startsWith("A") ? "B" : "A"}${intentMac?.slice(1)}`;
    const tampered = [
      version,
      nonce,
      tamperedIntentMac,
      capabilityMac,
    ].join(".");

    expect(store.retire(tampered)).toBe(false);
    expect(store.consume(token, plan)).toBe(true);
  });

  it("keeps an omitted dumpName stable for the exact confirm request", async () => {
    const executor = new CountingExecutor();
    const ctx = confirmationContext(
      new ProcessConfirmationStore(),
      executor,
      "local_ydb_dump_tenant",
    );

    const planned = await dumpTenant(ctx, {});
    expect(planned).toMatchObject({
      executed: false,
      dumpName: expect.stringMatching(/^example-auto-[A-Za-z0-9_-]{22}$/),
      confirmation: { status: "planned", token: expect.any(String) },
    });

    const accepted = await dumpTenant(ctx, {
      confirm: true,
      confirmationToken: planned.confirmation?.token,
    });
    expect(accepted).toMatchObject({
      executed: true,
      dumpName: planned.dumpName,
      confirmation: { status: "accepted" },
    });

    const replay = await dumpTenant(ctx, {
      confirm: true,
      confirmationToken: planned.confirmation?.token,
    });
    expect(replay).toMatchObject({
      executed: false,
      dumpName: expect.stringMatching(/^example-auto-[A-Za-z0-9_-]{22}$/),
      confirmation: { status: "rejected", token: expect.any(String) },
    });
    expect(replay.dumpName).not.toBe(planned.dumpName);
    expect(replay.confirmation?.token).not.toBe(planned.confirmation?.token);

    const refreshed = await dumpTenant(ctx, {
      confirm: true,
      confirmationToken: replay.confirmation?.token,
    });
    expect(refreshed).toMatchObject({
      executed: true,
      dumpName: replay.dumpName,
      confirmation: { status: "accepted" },
    });
    expect(executor.calls).toBe(4);
  });

  it("rejects an exact auth plan when the reviewed file contents change", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmation-file-"));
    const authConfigPath = join(directory, "auth.yaml");
    const firstContents = "BENIGN_AUTH_CONFIG_MARKER_ONE";
    const secondContents = "BENIGN_AUTH_CONFIG_MARKER_TWO";
    writeFileSync(authConfigPath, firstContents, "utf8");
    try {
      const executor = new CountingExecutor();
      const ctx = confirmationContext(
        new ProcessConfirmationStore(),
        executor,
        "local_ydb_apply_auth_hardening",
      );
      const request = { configHostPath: authConfigPath };
      const planned = await applyAuthHardening(ctx, request);
      const firstDigest = createHash("sha256").update(firstContents).digest("hex");

      expect(planned).toMatchObject({
        executed: false,
        confirmation: { status: "planned", token: expect.any(String) },
      });
      expect(JSON.stringify(planned)).not.toContain(firstContents);
      expect(JSON.stringify(planned)).not.toContain(firstDigest);

      writeFileSync(authConfigPath, secondContents, "utf8");
      const rejected = await applyAuthHardening(ctx, {
        ...request,
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });
      expect(rejected).toMatchObject({
        executed: false,
        confirmation: { status: "rejected", token: expect.any(String) },
      });
      expect(executor.calls).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("binds configured secret-file contents even when commands use the resolved profile", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmation-secret-"));
    const rootPasswordFile = join(directory, "root.password");
    writeFileSync(rootPasswordFile, "first-password\n", "utf8");
    try {
      const executor = new CountingExecutor();
      const config = ConfigSchema.parse({
        profiles: { default: { rootPasswordFile } },
      });
      const context = createContext(undefined, executor, config);
      const ctx: ToolkitContext = {
        ...context,
        confirmation: {
          store: new ProcessConfirmationStore(),
          toolName: "local_ydb_test",
          configSource: { kind: "provided", config },
        },
      };
      const planned = await runMutating(ctx, plan, {});
      expect(JSON.stringify(planned)).not.toContain("first-password");
      expect(JSON.stringify(planned)).not.toContain(
        createHash("sha256").update("first-password\n").digest("hex"),
      );

      writeFileSync(rootPasswordFile, "second-password\n", "utf8");
      const rejected = await runMutating(ctx, plan, {
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });
      expect(rejected).toMatchObject({
        executed: false,
        confirmation: { status: "rejected", token: expect.any(String) },
      });
      expect(executor.calls).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fingerprints configured secret files through the SSH target command path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmation-ssh-secret-"));
    const rootPasswordFile = join(directory, "root.password");
    writeFileSync(rootPasswordFile, "ssh-password-one\n", "utf8");
    try {
      const config = ConfigSchema.parse({
        profiles: { default: { rootPasswordFile } },
      });
      const localContext = createContext(
        undefined,
        new FingerprintingExecutor(),
        config,
      );
      const ctx: ToolkitContext = {
        ...localContext,
        profile: {
          ...localContext.profile,
          mode: "ssh",
          ssh: { host: "fingerprint-test.invalid" },
        },
        confirmation: {
          store: new ProcessConfirmationStore(),
          toolName: "local_ydb_test",
          configSource: { kind: "provided", config },
        },
      };
      const planned = await runMutating(ctx, plan, {});

      writeFileSync(rootPasswordFile, "ssh-password-two\n", "utf8");
      const rejected = await runMutating(ctx, plan, {
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });
      expect(rejected).toMatchObject({
        executed: false,
        confirmation: { status: "rejected", token: expect.any(String) },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects oversized SSH credential files before hashing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmation-ssh-oversized-"));
    const rootPasswordFile = join(directory, "root.password");
    writeFileSync(rootPasswordFile, "", "utf8");
    truncateSync(rootPasswordFile, MAX_CONFIRMATION_FILE_BYTES + 1);
    try {
      const config = ConfigSchema.parse({
        profiles: { default: { rootPasswordFile } },
      });
      const localContext = createContext(
        undefined,
        new FingerprintingExecutor(),
        config,
      );
      const ctx: ToolkitContext = {
        ...localContext,
        profile: {
          ...localContext.profile,
          mode: "ssh",
          ssh: { host: "fingerprint-test.invalid" },
        },
        confirmation: {
          store: new ProcessConfirmationStore(),
          toolName: "local_ydb_test",
          configSource: { kind: "provided", config },
        },
      };

      await expect(runMutating(ctx, plan, {})).rejects.toThrow(
        "Unable to fingerprint a confirmation content input",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects restore when a file inside the selected dump changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmation-dump-"));
    const dumpDirectory = join(directory, "reviewed", "tenant");
    const dumpFile = join(dumpDirectory, "data.csv");
    mkdirSync(dumpDirectory, { recursive: true });
    writeFileSync(dumpFile, "row-one\n", "utf8");
    try {
      const executor = new FingerprintingExecutor();
      const config = ConfigSchema.parse({
        profiles: { default: { dumpHostPath: directory } },
      });
      const context = createContext(undefined, executor, config);
      const ctx: ToolkitContext = {
        ...context,
        confirmation: {
          store: new ProcessConfirmationStore(),
          toolName: "local_ydb_restore_tenant",
          configSource: { kind: "provided", config },
        },
      };
      const planned = await restoreTenant(ctx, { dumpName: "reviewed" });
      expect(JSON.stringify(planned)).not.toContain("row-one");
      expect(JSON.stringify(planned)).not.toContain(
        createHash("sha256").update("row-one\n").digest("hex"),
      );

      writeFileSync(dumpFile, "row-two\n", "utf8");
      const rejected = await restoreTenant(ctx, {
        dumpName: "reviewed",
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });
      expect(rejected).toMatchObject({
        executed: false,
        confirmation: { status: "rejected", token: expect.any(String) },
      });
      expect(executor.calls).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fingerprints a restore directory through the SSH target command path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-confirmation-ssh-dump-"));
    const dumpDirectory = join(directory, "reviewed", "tenant");
    const dumpFile = join(dumpDirectory, "data.csv");
    mkdirSync(dumpDirectory, { recursive: true });
    writeFileSync(dumpFile, "ssh-row-one\n", "utf8");
    try {
      const config = ConfigSchema.parse({
        profiles: { default: { dumpHostPath: directory } },
      });
      const localContext = createContext(
        undefined,
        new FingerprintingExecutor(),
        config,
      );
      const ctx: ToolkitContext = {
        ...localContext,
        profile: {
          ...localContext.profile,
          mode: "ssh",
          ssh: { host: "fingerprint-test.invalid" },
        },
        confirmation: {
          store: new ProcessConfirmationStore(),
          toolName: "local_ydb_restore_tenant",
          configSource: { kind: "provided", config },
        },
      };
      const planned = await restoreTenant(ctx, { dumpName: "reviewed" });

      writeFileSync(dumpFile, "ssh-row-two\n", "utf8");
      const rejected = await restoreTenant(ctx, {
        dumpName: "reviewed",
        confirm: true,
        confirmationToken: planned.confirmation?.token,
      });
      expect(rejected).toMatchObject({
        executed: false,
        confirmation: { status: "rejected", token: expect.any(String) },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function confirmationContext(
  store: ProcessConfirmationStore,
  executor: CommandExecutor,
  toolName = "local_ydb_test",
  profileName = "default",
): ToolkitContext {
  const config = ConfigSchema.parse(
    profileName === "default"
      ? {}
      : { defaultProfile: profileName, profiles: { [profileName]: {} } },
  );
  return {
    ...createContext(profileName, executor, config),
    confirmation: {
      store,
      toolName,
      configSource: { kind: "provided", config },
    },
  };
}

function replaceLastBase64UrlCharacter(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(value.at(-1)!);
  if (last < 0 || last % 16 === 15) {
    throw new Error("Expected a canonical 128-bit base64url nonce");
  }
  return `${value.slice(0, -1)}${alphabet[last + 1]}`;
}
