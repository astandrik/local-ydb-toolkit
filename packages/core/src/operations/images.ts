import type {
  CommandOutputStream,
  CommandResult,
  CommandSpec
} from "../api-client.js";
import { bash, shellQuote } from "../api-client.js";
import {
  attachConfirmation,
  attachNotRequiredConfirmation,
  authorizeMutation,
  commandPlanIntent,
  confirmationSummarySuffix,
  retireSubmittedConfirmation,
} from "../confirmation.js";
import type {
  ImagePullOptions,
  ImagePullResponse,
  ImagePullStatus,
  ImagePullStatusResponse,
  ToolkitContext
} from "./types.js";

const IMAGE_PULL_TIMEOUT_MS = 60 * 60 * 1000;
const IMAGE_INSPECT_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_LIMIT = 4000;
const OUTPUT_REMAINDER_LIMIT = 1024;
const DOCKER_PULL_LAYER_LINE = /^([^:\s]+):\s+(Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)(?:\s|$)/;
const COMPLETED_LAYER_STATUSES = new Set(["Pull complete", "Already exists"]);

interface ImagePullJob {
  jobId: string;
  image: string;
  profile: string;
  command: string;
  status: ImagePullStatus;
  progressPercent: number;
  knownLayers: Set<string>;
  completedLayers: Set<string>;
  outputRemainders: Record<CommandOutputStream, string>;
  startedAt: string;
  updatedAt: string;
  result?: CommandResult;
}

const imagePullJobs = new Map<string, ImagePullJob>();
let imagePullJobCounter = 0;

export function imageInspectSpec(image: string): CommandSpec {
  return {
    command: "docker",
    args: ["image", "inspect", image],
    timeoutMs: IMAGE_INSPECT_TIMEOUT_MS,
    allowFailure: true,
    description: `Check Docker image ${image}`
  };
}

export function dockerPullSpec(image: string): CommandSpec {
  return {
    command: "docker",
    args: ["pull", image],
    timeoutMs: IMAGE_PULL_TIMEOUT_MS,
    description: `Pull Docker image ${image}`
  };
}

export function ensureImagePresentSpec(image: string): CommandSpec {
  const message = [
    `Docker image ${image} is not available on the target.`,
    `Start local_ydb_pull_image with image=${image} and confirm=true, then poll local_ydb_pull_status before retrying.`
  ].join(" ");
  return bash(`docker image inspect ${shellQuote(image)} >/dev/null 2>&1 || { printf '%s\\n' ${shellQuote(message)} >&2; exit 42; }`, {
    timeoutMs: IMAGE_INSPECT_TIMEOUT_MS,
    allowFailure: true,
    description: `Require Docker image ${image}`
  });
}

export async function inspectImageId(ctx: ToolkitContext, image: string): Promise<string> {
  const spec: CommandSpec = {
    command: "docker",
    args: ["image", "inspect", "--format", "{{.Id}}", image],
    timeoutMs: IMAGE_INSPECT_TIMEOUT_MS,
    allowFailure: true,
    description: `Inspect exact Docker image identity for ${image}`,
  };
  const result = await ctx.client.run(spec);
  const imageId = result.stdout.trim();
  if (!result.ok || !imageId || /\s/.test(imageId)) {
    throw new Error("Unable to inspect exact Docker image identity.");
  }
  return imageId;
}

export function ensureImageIdSpec(image: string, expectedImageId: string): CommandSpec {
  const message = `Docker image ${image} no longer matches the confirmed image identity.`;
  return bash([
    "set -euo pipefail",
    `expected_image_id=${shellQuote(expectedImageId)}`,
    `if ! observed_image_id=$(docker image inspect --format ${shellQuote("{{.Id}}")} ${shellQuote(image)} 2>/dev/null); then`,
    `  printf '%s\\n' ${shellQuote(message)} >&2`,
    "  exit 42",
    "fi",
    "if [ \"$observed_image_id\" != \"$expected_image_id\" ]; then",
    `  printf '%s\\n' ${shellQuote(message)} >&2`,
    "  exit 42",
    "fi",
  ].join("\n"), {
    timeoutMs: IMAGE_INSPECT_TIMEOUT_MS,
    allowFailure: true,
    description: `Require exact Docker image identity for ${image}`,
  });
}

export async function pullImage(ctx: ToolkitContext, options: ImagePullOptions = {}): Promise<ImagePullResponse> {
  const image = (options.image ?? ctx.profile.image).trim();
  if (!image) {
    throw new Error("image must be non-empty");
  }

  const inspectSpec = imageInspectSpec(image);
  const pullSpec = dockerPullSpec(image);
  const plannedCommands = [
    ctx.client.display(inspectSpec),
    ctx.client.display(pullSpec)
  ];
  const rollback = [
    `Remove the image manually with docker image rm ${image} if the downloaded image is no longer wanted.`
  ];
  const verification = [
    `docker image inspect ${image}`,
    "local_ydb_bootstrap/local_ydb_upgrade_version no longer fails the image preflight"
  ];

  if (!ctx.confirmation && options.confirm !== true) {
    return {
      summary: `Pull Docker image ${image}. Not started because confirm=true was not provided.`,
      executed: false,
      risk: "medium",
      plannedCommands,
      rollback,
      verification,
      image,
      status: "planned",
    };
  }

  const inspectResult = await ctx.client.run(inspectSpec);
  if (inspectResult.ok) {
    retireSubmittedConfirmation(ctx, options);
    return attachNotRequiredConfirmation(ctx, {
      summary: `Docker image ${image} is already present on ${ctx.profile.name}.`,
      executed: true,
      risk: "medium",
      plannedCommands,
      rollback,
      verification,
      results: [inspectResult],
      image,
      status: "already-present",
    });
  }

  const summary = `Pull Docker image ${image}.`;
  const decision = await authorizeMutation(ctx, options, {
    ...commandPlanIntent({
      summary,
      risk: "medium",
      specs: [inspectSpec, pullSpec],
      rollback,
      verification,
    }),
    imagePresent: false,
  });
  if (!decision.execute) {
    return attachConfirmation({
      summary: `${summary}${confirmationSummarySuffix(decision.confirmation)}`,
      executed: false,
      risk: "medium",
      plannedCommands,
      rollback,
      verification,
      results: [inspectResult],
      image,
      status: "planned"
    }, decision.confirmation);
  }

  const job = createImagePullJob(ctx, image, pullSpec);
  void ctx.client.run(pullSpec, (stream, chunk) => observeImagePullOutput(job, stream, chunk))
    .then((result) => finishImagePullJob(job, result))
    .catch((error: unknown) => finishImagePullJob(job, {
      command: job.command,
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      ok: false,
      timedOut: false
    }));

  return attachConfirmation({
    summary: `Started background Docker image pull for ${image}. Poll local_ydb_pull_status with jobId=${job.jobId}.`,
    executed: true,
    risk: "medium",
    plannedCommands,
    rollback,
    verification,
    results: [inspectResult],
    image,
    status: "running",
    jobId: job.jobId,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt
  }, decision.confirmation);
}

export function pullImageStatus(jobId: string): ImagePullStatusResponse {
  const job = imagePullJobs.get(jobId);
  if (!job) {
    return {
      summary: `Unknown Docker image pull job: ${jobId}.`,
      found: false,
      jobId,
      status: "unknown"
    };
  }

  const result = job.result;
  return {
    summary: `Docker image pull job ${job.jobId} is ${job.status} (${job.progressPercent}%).`,
    found: true,
    jobId: job.jobId,
    image: job.image,
    profile: job.profile,
    status: job.status,
    command: job.command,
    progressPercent: job.progressPercent,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    exitCode: result?.exitCode,
    ok: result?.ok,
    timedOut: result?.timedOut,
    stdoutTail: result ? tail(result.stdout) : undefined,
    stderrTail: result ? tail(result.stderr) : undefined
  };
}

function createImagePullJob(ctx: ToolkitContext, image: string, spec: CommandSpec): ImagePullJob {
  const now = new Date().toISOString();
  const job: ImagePullJob = {
    jobId: `pull-${Date.now()}-${imagePullJobCounter += 1}`,
    image,
    profile: ctx.profile.name,
    command: ctx.client.display(spec),
    status: "running",
    progressPercent: 0,
    knownLayers: new Set(),
    completedLayers: new Set(),
    outputRemainders: { stdout: "", stderr: "" },
    startedAt: now,
    updatedAt: now
  };
  imagePullJobs.set(job.jobId, job);
  return job;
}

function finishImagePullJob(job: ImagePullJob, result: CommandResult): void {
  flushImagePullOutput(job);
  job.result = result;
  job.status = result.ok ? "completed" : "failed";
  if (result.ok) {
    job.progressPercent = 100;
  }
  job.updatedAt = new Date().toISOString();
}

function observeImagePullOutput(job: ImagePullJob, stream: CommandOutputStream, chunk: string): void {
  const lines = `${job.outputRemainders[stream]}${chunk}`.split(/\r\n|\r|\n/);
  job.outputRemainders[stream] = tailToLimit(lines.pop() ?? "", OUTPUT_REMAINDER_LIMIT);
  for (const line of lines) {
    observeImagePullLine(job, line);
  }
}

function flushImagePullOutput(job: ImagePullJob): void {
  for (const stream of ["stdout", "stderr"] as const) {
    const line = job.outputRemainders[stream];
    job.outputRemainders[stream] = "";
    if (line) {
      observeImagePullLine(job, line);
    }
  }
}

function observeImagePullLine(job: ImagePullJob, line: string): void {
  const match = DOCKER_PULL_LAYER_LINE.exec(stripAnsi(line).trim());
  if (!match) {
    return;
  }

  const [, layer, status] = match;
  job.knownLayers.add(layer);
  if (COMPLETED_LAYER_STATUSES.has(status)) {
    job.completedLayers.add(layer);
  }
  job.updatedAt = new Date().toISOString();

  const progressPercent = Math.min(
    99,
    Math.floor(99 * job.completedLayers.size / job.knownLayers.size)
  );
  if (progressPercent > job.progressPercent) {
    job.progressPercent = progressPercent;
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function tailToLimit(value: string, limit: number): string {
  return value.length > limit ? value.slice(value.length - limit) : value;
}

function tail(value: string): string {
  return tailToLimit(value, OUTPUT_TAIL_LIMIT);
}
