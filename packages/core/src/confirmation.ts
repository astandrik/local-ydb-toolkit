import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { CommandSpec } from "./api-client.js";
import {
  confirmationContentIntent,
  type ConfirmationContentFingerprint,
  type ConfirmationContentInput,
} from "./confirmation-inputs.js";
import type {
  MutationConfirmation,
  MutatingOptions,
  ToolkitContext,
} from "./operations/types.js";

const TOKEN_VERSION = "v1";
const PROCESS_KEY_BYTES = 32;
const NONCE_BYTES = 16;
const MAC_BYTES = 32;

export interface PlanConfirmationRuntime {
  store: ProcessConfirmationStore;
  toolName: string;
  configSource: unknown;
}

export interface ConfirmationDecision {
  execute: boolean;
  confirmation?: MutationConfirmation;
  receipt?: ConfirmationReceipt;
}

export interface ConfirmationReceipt {
  contentInputs: readonly ConfirmationContentFingerprint[];
}

export interface ConfirmationAuthorizationOptions {
  contentInputs?: ConfirmationContentInput[];
  rotatingScope?: unknown;
}

export class ProcessConfirmationStore {
  readonly #key = randomBytes(PROCESS_KEY_BYTES);
  readonly #consumedTokens = new Set<string>();
  readonly #scopeGenerations = new Map<string, number>();

  issue(intent: unknown): string {
    const nonce = randomBytes(NONCE_BYTES);
    const intentMac = this.#sign(nonce, intent);
    const capabilityMac = this.#signCapability(nonce, intentMac);
    return [
      TOKEN_VERSION,
      nonce.toString("base64url"),
      intentMac.toString("base64url"),
      capabilityMac.toString("base64url"),
    ].join(".");
  }

  consume(token: string, intent: unknown, rotatingScope?: unknown): boolean {
    if (this.#consumedTokens.has(token)) {
      return false;
    }
    const parsed = parseToken(token);
    if (!parsed) {
      return false;
    }
    const expectedCapability = this.#signCapability(parsed.nonce, parsed.intentMac);
    if (!timingSafeEqual(parsed.capabilityMac, expectedCapability)) {
      return false;
    }
    const expected = this.#sign(parsed.nonce, intent);
    if (!timingSafeEqual(parsed.intentMac, expected)) {
      return false;
    }
    this.#consumedTokens.add(token);
    if (rotatingScope !== undefined) {
      // Rotate synchronously with consumption so concurrent confirms cannot reuse
      // an auto-resolved execution value before the first caller mutates state.
      const scopeKey = this.#scopeKey(rotatingScope);
      this.#scopeGenerations.set(
        scopeKey,
        (this.#scopeGenerations.get(scopeKey) ?? 0) + 1,
      );
    }
    return true;
  }

  retire(token: string): boolean {
    if (this.#consumedTokens.has(token)) {
      return false;
    }
    const parsed = parseToken(token);
    if (!parsed) {
      return false;
    }
    const expectedCapability = this.#signCapability(parsed.nonce, parsed.intentMac);
    if (!timingSafeEqual(parsed.capabilityMac, expectedCapability)) {
      return false;
    }
    this.#consumedTokens.add(token);
    return true;
  }

  scopedId(scope: unknown): string {
    const scopeKey = this.#scopeKey(scope);
    const generation = this.#scopeGenerations.get(scopeKey) ?? 0;
    return createHmac("sha256", this.#key)
      .update("confirmation-scope-id\0", "utf8")
      .update(scopeKey, "ascii")
      .update("\0")
      .update(String(generation), "ascii")
      .digest()
      .subarray(0, NONCE_BYTES)
      .toString("base64url");
  }

  #sign(nonce: Buffer, intent: unknown): Buffer {
    return createHmac("sha256", this.#key)
      .update(nonce)
      .update("\0")
      .update(canonicalJson(intent), "utf8")
      .digest();
  }

  #signCapability(nonce: Buffer, intentMac: Buffer): Buffer {
    return createHmac("sha256", this.#key)
      .update("confirmation-capability\0", "utf8")
      .update(nonce)
      .update(intentMac)
      .digest();
  }

  #scopeKey(scope: unknown): string {
    return createHmac("sha256", this.#key)
      .update("confirmation-scope-key\0", "utf8")
      .update(canonicalJson(scope), "utf8")
      .digest("hex");
  }
}

export async function authorizeMutation(
  ctx: ToolkitContext,
  options: MutatingOptions,
  executionIntent: unknown,
  authorization: ConfirmationAuthorizationOptions = {},
): Promise<ConfirmationDecision> {
  const runtime = ctx.confirmation;
  if (!runtime) {
    if (options.confirm !== true) {
      return { execute: false };
    }
    return {
      execute: true,
      receipt: {
        contentInputs: await confirmationContentIntent(
          ctx,
          authorization.contentInputs,
        ),
      },
    };
  }

  const contentInputs = await confirmationContentIntent(
    ctx,
    authorization.contentInputs,
  );
  const intent = {
    ...confirmationEnvelope(ctx, executionIntent),
    contentInputs,
  };
  const contextualScope = authorization.rotatingScope === undefined
    ? undefined
    : confirmationEnvelope(ctx, {
        kind: "rotating-scope",
        scope: authorization.rotatingScope,
      });

  if (options.confirm !== true) {
    return {
      execute: false,
      confirmation: {
        status: "planned",
        token: runtime.store.issue(intent),
      },
    };
  }

  if (
    typeof options.confirmationToken === "string"
    && runtime.store.consume(options.confirmationToken, intent, contextualScope)
  ) {
    return {
      execute: true,
      confirmation: { status: "accepted" },
      receipt: { contentInputs },
    };
  }

  return {
    execute: false,
    confirmation: {
      status: "rejected",
      token: runtime.store.issue(intent),
    },
  };
}

export function confirmationScopedId(ctx: ToolkitContext, scope: unknown): string | undefined {
  const runtime = ctx.confirmation;
  return runtime?.store.scopedId(
    confirmationEnvelope(ctx, { kind: "rotating-scope", scope }),
  );
}

export function retireSubmittedConfirmation(
  ctx: ToolkitContext,
  options: MutatingOptions,
): boolean {
  return options.confirm === true
    && typeof options.confirmationToken === "string"
    && ctx.confirmation?.store.retire(options.confirmationToken) === true;
}

export function commandPlanIntent(plan: {
  summary: string;
  risk: "low" | "medium" | "high";
  specs: CommandSpec[];
  rollback: string[];
  verification: string[];
}): Record<string, unknown> {
  return {
    kind: "command-plan",
    summary: plan.summary,
    risk: plan.risk,
    commands: plan.specs.map(commandSpecIntent),
    rollback: plan.rollback,
    verification: plan.verification,
  };
}

export function commandSpecIntent(spec: CommandSpec): Record<string, unknown> {
  return {
    command: spec.command,
    args: spec.args,
    stdin: spec.stdin,
    timeoutMs: spec.timeoutMs,
    allowFailure: spec.allowFailure,
    description: spec.description,
  };
}

export function attachConfirmation<T extends object>(
  response: T,
  confirmation: MutationConfirmation | undefined,
): T & { confirmation?: MutationConfirmation } {
  return confirmation ? { ...response, confirmation } : response;
}

export function attachNotRequiredConfirmation<T extends object>(
  ctx: ToolkitContext,
  response: T,
): T & { confirmation?: MutationConfirmation } {
  return attachConfirmation(
    response,
    ctx.confirmation ? { status: "not-required" } : undefined,
  );
}

export function confirmationSummarySuffix(
  confirmation: MutationConfirmation | undefined,
): string {
  if (confirmation?.status === "planned") {
    return " Not executed; review this exact plan, then repeat the request with confirm=true and confirmationToken.";
  }
  if (confirmation?.status === "rejected") {
    return " Not executed because the confirmation token did not match this exact plan; review the refreshed plan and token.";
  }
  return " Not executed because confirm=true was not provided.";
}

export function withoutConfirmation(ctx: ToolkitContext): ToolkitContext {
  if (!ctx.confirmation) {
    return ctx;
  }
  const { confirmation: _confirmation, ...rest } = ctx;
  return rest;
}

function parseToken(token: string): {
  nonce: Buffer;
  intentMac: Buffer;
  capabilityMac: Buffer;
} | undefined {
  const parts = token.split(".");
  if (
    parts.length !== 4
    || parts[0] !== TOKEN_VERSION
    || !/^[A-Za-z0-9_-]{22}$/.test(parts[1] ?? "")
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? "")
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[3] ?? "")
  ) {
    return undefined;
  }
  const nonce = Buffer.from(parts[1]!, "base64url");
  const intentMac = Buffer.from(parts[2]!, "base64url");
  const capabilityMac = Buffer.from(parts[3]!, "base64url");
  if (
    nonce.length !== NONCE_BYTES
    || intentMac.length !== MAC_BYTES
    || capabilityMac.length !== MAC_BYTES
    || nonce.toString("base64url") !== parts[1]
    || intentMac.toString("base64url") !== parts[2]
    || capabilityMac.toString("base64url") !== parts[3]
  ) {
    return undefined;
  }
  return { nonce, intentMac, capabilityMac };
}

function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set());
}

function confirmationEnvelope(ctx: ToolkitContext, execution: unknown): Record<string, unknown> {
  const runtime = ctx.confirmation;
  if (!runtime) {
    throw new Error("Confirmation runtime is required for contextual confirmation state");
  }
  return {
    toolName: runtime.toolName,
    configSource: runtime.configSource,
    profile: ctx.profile,
    execution,
  };
}

function serializeCanonical(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Confirmation intent contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") {
    return "null";
  }
  if (typeof value !== "object") {
    throw new Error("Confirmation intent contains a non-JSON value");
  }
  if (seen.has(value)) {
    throw new Error("Confirmation intent contains a cycle");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializeCanonical(item, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Confirmation intent contains a non-plain object");
    }
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${serializeCanonical(item, seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
