import type { CommandResult, CommandSpec } from "../api-client.js";
import { bash, shellQuote } from "../api-client.js";
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

interface ImagePullJob {
  jobId: string;
  image: string;
  profile: string;
  command: string;
  status: ImagePullStatus;
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

  if (!options.confirm) {
    return {
      summary: `Pull Docker image ${image}. Not started because confirm=true was not provided.`,
      executed: false,
      risk: "medium",
      plannedCommands,
      rollback,
      verification,
      image,
      status: "planned"
    };
  }

  const inspectResult = await ctx.client.run(inspectSpec);
  if (inspectResult.ok) {
    return {
      summary: `Docker image ${image} is already present on ${ctx.profile.name}.`,
      executed: true,
      risk: "medium",
      plannedCommands,
      rollback,
      verification,
      results: [inspectResult],
      image,
      status: "already-present"
    };
  }

  const job = createImagePullJob(ctx, image, pullSpec);
  void ctx.client.run(pullSpec)
    .then((result) => finishImagePullJob(job, result))
    .catch((error: unknown) => finishImagePullJob(job, {
      command: job.command,
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      ok: false,
      timedOut: false
    }));

  return {
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
  };
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
    summary: `Docker image pull job ${job.jobId} is ${job.status}.`,
    found: true,
    jobId: job.jobId,
    image: job.image,
    profile: job.profile,
    status: job.status,
    command: job.command,
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
    startedAt: now,
    updatedAt: now
  };
  imagePullJobs.set(job.jobId, job);
  return job;
}

function finishImagePullJob(job: ImagePullJob, result: CommandResult): void {
  job.result = result;
  job.status = result.ok ? "completed" : "failed";
  job.updatedAt = new Date().toISOString();
}

function tail(value: string): string {
  return value.length > OUTPUT_TAIL_LIMIT
    ? value.slice(value.length - OUTPUT_TAIL_LIMIT)
    : value;
}
