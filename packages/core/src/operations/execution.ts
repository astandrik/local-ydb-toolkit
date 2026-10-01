import type { CommandResult, CommandSpec } from "../api-client.js";
import { withAuthorizedContentExecution } from "../confirmed-content.js";
import type { ConfirmationContentInput } from "../confirmation-inputs.js";
import {
  attachConfirmation,
  attachNotRequiredConfirmation,
  authorizeMutation,
  commandPlanIntent,
  confirmationSummarySuffix,
  retireSubmittedConfirmation,
} from "../confirmation.js";
import type { MutatingOptions, OperationPlan, OperationResponse, ToolkitContext } from "./types.js";

export async function runMutating(
  ctx: ToolkitContext,
  plan: {
    summary: string;
    risk: OperationPlan["risk"];
    specs: CommandSpec[];
    rollback: string[];
    verification: string[];
    confirmationInputs?: ConfirmationContentInput[];
    confirmationScope?: unknown;
  },
  options: MutatingOptions
): Promise<OperationResponse> {
  const plannedCommands = plan.specs.map((spec) => ctx.client.display(spec));
  if (plan.specs.length === 0) {
    retireSubmittedConfirmation(ctx, options);
    return attachNotRequiredConfirmation(ctx, {
      summary: plan.summary,
      executed: false,
      risk: plan.risk,
      plannedCommands,
      rollback: plan.rollback,
      verification: plan.verification
    });
  }
  const decision = await authorizeMutation(
    ctx,
    options,
    commandPlanIntent(plan),
    {
      contentInputs: plan.confirmationInputs,
      rotatingScope: plan.confirmationScope,
    },
  );
  if (!decision.execute) {
    return attachConfirmation({
      summary: `${plan.summary}${confirmationSummarySuffix(decision.confirmation)}`,
      executed: false,
      risk: plan.risk,
      plannedCommands,
      rollback: plan.rollback,
      verification: plan.verification
    }, decision.confirmation);
  }
  return withAuthorizedContentExecution(
    ctx,
    decision.receipt,
    plan.specs,
    async (executionContext) => {
      const results = await runCommandSpecs(executionContext, plan.specs);
      return attachConfirmation({
        summary: `${plan.summary} Executed ${results.filter((result) => result.ok).length}/${results.length} commands.`,
        executed: true,
        risk: plan.risk,
        plannedCommands,
        rollback: plan.rollback,
        verification: plan.verification,
        results
      }, decision.confirmation);
    },
  );
}

export async function runCommandSpecs(ctx: ToolkitContext, specs: CommandSpec[]): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (const spec of specs) {
    const result = normalizeExpectedYdbResult(spec, await ctx.client.run(spec));
    results.push(result);
    if (!result.ok) {
      break;
    }
  }
  return results;
}

export function appendOperationResultsAndCheckSuccess(
  results: CommandResult[],
  response: { results?: CommandResult[] },
): boolean {
  if (!response.results) {
    return true;
  }
  results.push(...response.results);
  return response.results.every((result) => result.ok);
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
  verification: string[],
  options: MutatingOptions,
): OperationResponse {
  retireSubmittedConfirmation(ctx, options);
  return attachNotRequiredConfirmation(ctx, {
    summary,
    executed: false,
    risk,
    plannedCommands: specs.map((spec) => ctx.client.display(spec)),
    rollback,
    verification
  });
}
