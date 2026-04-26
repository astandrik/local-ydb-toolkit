import type { CommandResult, CommandSpec } from "../api-client.js";
import type { MutatingOptions, OperationPlan, OperationResponse, ToolkitContext } from "./types.js";

export async function runMutating(
  ctx: ToolkitContext,
  plan: { summary: string; risk: OperationPlan["risk"]; specs: CommandSpec[]; rollback: string[]; verification: string[] },
  options: MutatingOptions
): Promise<OperationResponse> {
  const plannedCommands = plan.specs.map((spec) => ctx.client.display(spec));
  if (!options.confirm) {
    return {
      summary: `${plan.summary} Not executed because confirm=true was not provided.`,
      executed: false,
      risk: plan.risk,
      plannedCommands,
      rollback: plan.rollback,
      verification: plan.verification
    };
  }
  const results: CommandResult[] = [];
  for (const spec of plan.specs) {
    const result = normalizeExpectedYdbResult(spec, await ctx.client.run(spec));
    results.push(result);
    if (!result.ok) {
      break;
    }
  }
  return {
    summary: `${plan.summary} Executed ${results.filter((result) => result.ok).length}/${results.length} commands.`,
    executed: true,
    risk: plan.risk,
    plannedCommands,
    rollback: plan.rollback,
    verification: plan.verification,
    results
  };
}

export function normalizeExpectedYdbResult(spec: CommandSpec, result: CommandResult): CommandResult {
  if (result.ok || result.timedOut) {
    return result;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (spec.description === "Create CMS tenant if missing" && tenantStatusWasRead(output)) {
    return { ...result, ok: true };
  }
  if (spec.description?.startsWith("Wait for authenticated tenant status") && tenantStatusWasRead(output)) {
    return { ...result, ok: true };
  }
  if (spec.description?.startsWith("Remove tenant ") && tenantRemoveReachedTerminalState(output)) {
    return { ...result, ok: true };
  }

  return result;
}

function tenantStatusWasRead(output: string): boolean {
  return /State:\s*(RUNNING|PENDING_RESOURCES)/.test(output);
}

function tenantRemoveReachedTerminalState(output: string): boolean {
  return /^\s*OK\s*$/m.test(output) || /Unknown tenant|NOT_FOUND|not found|Path does not exist/i.test(output);
}

export function planOnly(
  ctx: ToolkitContext,
  summary: string,
  risk: OperationPlan["risk"],
  specs: CommandSpec[],
  rollback: string[],
  verification: string[]
): OperationResponse {
  return {
    summary,
    executed: false,
    risk,
    plannedCommands: specs.map((spec) => ctx.client.display(spec)),
    rollback,
    verification
  };
}
