import { describe, expect, it, vi } from "vitest";
import { ProcessConfirmationStore } from "../src/index.js";
import {
  attachConfirmation, authorizeMutation, commandPlanIntent, commandSpecIntent,
  confirmationScopedId, retireSubmittedConfirmation, withConfirmationLease, withoutConfirmation,
} from "../src/confirmation.js";
import { createContext } from "../src/operations/context.js";
import type { ToolkitContext } from "../src/operations/types.js";
import { ConfigSchema } from "../src/validation.js";

const intent = {
  request: { command: "fixture", args: ["alpha"], stdin: "BENIGN_PRIVATE_INPUT" },
  risk: "high", rollback: ["Undo fixture"], verification: ["Read fixture state"],
};

function context(store = new ProcessConfirmationStore()): ToolkitContext {
  return {
    ...createContext(undefined, undefined, ConfigSchema.parse({})),
    confirmation: { store, toolName: "fixture_mutation", configSource: { kind: "built-in" } },
  };
}

describe("confirmation foundation store", () => {
  it("accepts canonical intent once without putting input into a token", () => {
    const store = new ProcessConfirmationStore();
    const token = store.issue(intent);
    expect(/^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    expect(token.includes("BENIGN_PRIVATE_INPUT")).toBe(false);
    expect(store.consume(token, intent)).toBe(true);
    expect(store.consume(token, intent)).toBe(false);
  });

  it("canonicalizes key order and omitted undefined values, but not array order", () => {
    const store = new ProcessConfirmationStore();
    const token = store.issue({ b: [1, 2], a: { value: 3 }, omitted: undefined });
    expect(store.consume(token, { a: { value: 3 }, b: [2, 1] })).toBe(false);
    expect(store.consume(token, { a: { value: 3 }, b: [1, 2] })).toBe(true);
  });

  it("issues independent capabilities for the same intent", () => {
    const store = new ProcessConfirmationStore();
    const first = store.issue(intent), second = store.issue(intent);
    expect(first === second).toBe(false);
    expect(store.consume(first, intent)).toBe(true);
    expect(store.consume(second, intent)).toBe(true);
  });

  it("rejects malformed, tampered and foreign capabilities without consuming the valid one", () => {
    const store = new ProcessConfirmationStore(), token = store.issue(intent);
    const parts = token.split(".");
    parts[2] = (parts[2]!.startsWith("A") ? "B" : "A") + parts[2]!.slice(1);
    for (const candidate of ["", "invalid", token + ".extra", parts.join("."), new ProcessConfirmationStore().issue(intent)]) {
      expect(store.consume(candidate, intent)).toBe(false);
      expect(store.retire(candidate)).toBe(false);
    }
    expect(store.consume(token, intent)).toBe(true);
  });

  it("rejects noncanonical base64url aliases even when nonce bytes match", () => {
    const store = new ProcessConfirmationStore(), token = store.issue(intent);
    const parts = token.split("."), nonce = parts[1]!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    parts[1] = nonce.slice(0, -1) + alphabet[alphabet.indexOf(nonce.at(-1)!) + 1];
    expect(Buffer.from(parts[1], "base64url").equals(Buffer.from(nonce, "base64url"))).toBe(true);
    expect(store.retire(parts.join("."))).toBe(false);
    expect(store.consume(token, intent)).toBe(true);
    expect(store.consume(parts.join("."), intent)).toBe(false);
  });

  it("invalidates pre-restart capabilities", () => {
    const token = new ProcessConfirmationStore().issue(intent);
    expect(new ProcessConfirmationStore().consume(token, intent)).toBe(false);
  });

  it("has no clock expiry and retains consumed capabilities", () => {
    vi.useFakeTimers();
    try {
      const store = new ProcessConfirmationStore(), token = store.issue(intent);
      vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
      expect(store.consume(token, intent)).toBe(true);
      const others = Array.from({ length: 100 }, () => store.issue(intent));
      expect(others.every(candidate => store.consume(candidate, intent))).toBe(true);
      expect(store.consume(token, intent)).toBe(false);
      expect(others.every(candidate => !store.consume(candidate, intent))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("retires current-process capabilities without knowing their tool intent", () => {
    const store = new ProcessConfirmationStore();
    const original = { tool: "another-tool", request: intent }, token = store.issue(original);
    expect(store.retire(token)).toBe(true);
    expect(store.retire(token)).toBe(false);
    expect(store.consume(token, original)).toBe(false);
  });

  it.each([NaN, Infinity, BigInt(1), new Date(0), () => 1])("rejects non-JSON case %#", value => {
    expect(() => new ProcessConfirmationStore().issue(value)).toThrow(/Confirmation intent/);
  });

  it("rejects cycles but permits repeated non-cyclic objects", () => {
    const cycle: { next?: object } = {};
    cycle.next = cycle;
    expect(() => new ProcessConfirmationStore().issue(cycle)).toThrow("contains a cycle");
    const shared = { value: 1 }, store = new ProcessConfirmationStore();
    expect(store.consume(store.issue([shared, shared]), [{ value: 1 }, { value: 1 }])).toBe(true);
  });

  it("rotates contextual generation synchronously with consume", () => {
    const store = new ProcessConfirmationStore(), scope = { target: "alpha" };
    const first = store.issue(intent, scope), second = store.issue(intent, scope);
    const scopeId = store.scopedId(scope);
    expect(store.consume(first, intent, scope)).toBe(true);
    expect(store.scopedId(scope) === scopeId).toBe(false);
    expect(store.consume(second, intent, scope)).toBe(false);
    expect(store.consume(store.issue(intent, scope), intent, scope)).toBe(true);
  });

  it("holds exclusive scope through release and retires an overlapping submitted capability", () => {
    const store = new ProcessConfirmationStore(), scope = { target: "alpha" };
    const first = store.issue(intent, scope), overlapping = store.issue(intent, scope);
    const release = store.acquire(first, intent, scope);
    expect(typeof release).toBe("function");
    expect(store.acquire(overlapping, intent, scope)).toBeUndefined();
    const duringExecution = store.issue(intent, scope), otherScope = { target: "beta" };
    const releaseOther = store.acquire(store.issue(intent, otherScope), intent, otherScope);
    expect(typeof releaseOther).toBe("function");
    release?.();
    const afterRelease = store.scopedId(scope);
    release?.();
    expect(store.scopedId(scope)).toBe(afterRelease);
    expect(store.acquire(overlapping, intent, scope)).toBeUndefined();
    expect(store.acquire(duringExecution, intent, scope)).toBeUndefined();
    const nextRelease = store.acquire(store.issue(intent, scope), intent, scope);
    expect(typeof nextRelease).toBe("function");
    nextRelease?.();
    releaseOther?.();
  });
});

describe("confirmation foundation authorization", () => {
  it("plans, rejects a missing token and accepts concurrent confirms at most once", async () => {
    const ctx = context(), planned = await authorizeMutation(ctx, {}, intent);
    expect(planned.execute).toBe(false);
    expect(planned.confirmation?.status).toBe("planned");
    expect((await authorizeMutation(ctx, { confirm: true }, intent)).confirmation?.status).toBe("rejected");
    const options = { confirm: true, confirmationToken: planned.confirmation?.token };
    const results = await Promise.all([authorizeMutation(ctx, options, intent), authorizeMutation(ctx, options, intent)]);
    expect(results.filter(result => result.execute)).toHaveLength(1);
    expect(results.map(result => result.confirmation?.status).sort()).toEqual(["accepted", "rejected"]);
  });

  it.each(["tool", "profile", "config source", "request"] as const)("binds %s independently", async field => {
    const ctx = context(), planned = await authorizeMutation(ctx, {}, intent);
    const changedContext = {
      ...ctx,
      profile: { ...ctx.profile, tenantPath: field === "profile" ? "/local/changed" : ctx.profile.tenantPath },
      confirmation: {
        ...ctx.confirmation!,
        toolName: field === "tool" ? "other_tool" : ctx.confirmation!.toolName,
        configSource: field === "config source" ? { kind: "argument", path: "/benign/config.json" } : ctx.confirmation!.configSource,
      },
    };
    const changedIntent = field === "request" ? { ...intent, request: { ...intent.request, stdin: "OTHER_INPUT" } } : intent;
    const result = await authorizeMutation(changedContext, { confirm: true, confirmationToken: planned.confirmation?.token }, changedIntent);
    expect(result.execute).toBe(false);
    expect(result.confirmation?.status).toBe("rejected");
  });

  it("preserves no-runtime behavior without attaching internal receipts", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));
    expect(await authorizeMutation(ctx, {}, intent)).toEqual({ execute: false });
    const accepted = await authorizeMutation(ctx, { confirm: true }, intent), response = { executed: true };
    expect(accepted.execute).toBe(true);
    expect(accepted.receipt?.contentInputs).toEqual([]);
    expect(attachConfirmation(response, accepted.confirmation)).toBe(response);
    expect(response).not.toHaveProperty("receipt");
    expect(response).not.toHaveProperty("confirmation");
    expect(retireSubmittedConfirmation(ctx, { confirm: true, confirmationToken: "invalid" })).toBe(false);
    expect(withoutConfirmation(ctx)).toBe(ctx);
    expect(confirmationScopedId(ctx, {})).toBeUndefined();
  });

  it("excludes signal/redactions while binding execution and verification fields", () => {
    const spec = { command: "fixture", args: ["one"], stdin: "INPUT", timeoutMs: 10, allowFailure: false };
    const store = new ProcessConfirmationStore(), token = store.issue(commandSpecIntent(spec));
    expect(store.consume(token, commandSpecIntent({ ...spec, signal: new AbortController().signal, redactions: ["INPUT"] }))).toBe(true);
    const plan = { summary: "fixture", risk: "high" as const, specs: [spec], rollback: ["undo"], verification: ["read"] };
    const bound = store.issue(commandPlanIntent(plan));
    expect(store.consume(bound, commandPlanIntent({ ...plan, verification: ["different"] }))).toBe(false);
    expect(store.consume(bound, commandPlanIntent(plan))).toBe(true);
  });

  it("releases failed exclusive execution without making its capability reusable", async () => {
    const ctx = context(), authorization = { sharedExclusiveScope: { kind: "rebuild" } };
    const planned = await authorizeMutation(ctx, {}, intent, authorization);
    const options = { confirm: true, confirmationToken: planned.confirmation?.token };
    const accepted = await authorizeMutation(ctx, options, intent, authorization);
    await expect(withConfirmationLease(accepted.receipt, async () => { throw new Error("fixture failure"); })).rejects.toThrow("fixture failure");
    expect((await authorizeMutation(ctx, options, intent, authorization)).execute).toBe(false);
    const fresh = await authorizeMutation(ctx, {}, intent, authorization);
    const next = await authorizeMutation(ctx, { confirm: true, confirmationToken: fresh.confirmation?.token }, intent, authorization);
    expect(next.execute).toBe(true);
    next.receipt?.release?.();
  });

  it.each(["profile label", "config source", "SSH user"] as const)(
    "shares a configured-target lease despite different %s without weakening exact intent",
    async difference => {
      const store = new ProcessConfirmationStore();
      const first = context(store);
      first.profile = { ...first.profile, mode: "ssh", ssh: { host: "fixture.invalid", user: "first" } };
      const second = {
        ...first,
        profile: {
          ...first.profile,
          name: difference === "profile label" ? "alias" : first.profile.name,
          ssh: { ...first.profile.ssh!, user: difference === "SSH user" ? "second" : "first" },
        },
        confirmation: {
          ...first.confirmation!,
          toolName: "another_fixture_tool",
          configSource: difference === "config source" ? { kind: "provided" } : first.confirmation!.configSource,
        },
      };
      const authorization = { sharedExclusiveScope: { kind: "rebuild" } };
      const firstPlan = await authorizeMutation(first, {}, intent, authorization);
      const secondPlan = await authorizeMutation(second, {}, intent, authorization);
      const wrongContext = await authorizeMutation(second, {
        confirm: true, confirmationToken: firstPlan.confirmation?.token,
      }, intent, authorization);
      expect(wrongContext.execute).toBe(false);
      const accepted = await authorizeMutation(first, {
        confirm: true, confirmationToken: firstPlan.confirmation?.token,
      }, intent, authorization);
      try {
        expect(accepted.execute).toBe(true);
        const overlapping = await authorizeMutation(second, {
          confirm: true, confirmationToken: secondPlan.confirmation?.token,
        }, intent, authorization);
        expect(overlapping.execute).toBe(false);
      } finally {
        accepted.receipt?.release?.();
      }
    },
  );

  it("rejects incompatible scopes and retires only on mutating confirm", async () => {
    const ctx = context();
    await expect(authorizeMutation(ctx, {}, intent, { rotatingScope: {}, sharedExclusiveScope: {} }))
      .rejects.toThrow("cannot use rotating and shared exclusive scopes together");
    const planned = await authorizeMutation(ctx, {}, intent), options = { confirmationToken: planned.confirmation?.token };
    expect(retireSubmittedConfirmation(ctx, options)).toBe(false);
    expect(retireSubmittedConfirmation(ctx, { ...options, confirm: true })).toBe(true);
    expect((await authorizeMutation(ctx, { ...options, confirm: true }, intent)).execute).toBe(false);
  });
});
