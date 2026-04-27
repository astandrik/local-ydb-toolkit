import { LocalYdbApiClient, type CommandResult } from "../api-client.js";
import { sanitizeTenantName, type ResolvedLocalYdbProfile } from "../validation.js";
import { applyAuthHardening, prepareAuthConfig, writeDynamicNodeAuthConfig } from "./auth-operations.js";
import { inventory } from "./checks.js";
import { addDynamicNodes } from "./dynamic-nodes.js";
import { assertPositiveInteger, extraDynamicNodeTarget } from "./helpers.js";
import { ensureImagePresentSpec } from "./images.js";
import { bootstrap, destroyStack } from "./stack.js";
import { dumpTenant, restoreTenant } from "./tenant.js";
import type {
  ListVersionsOptions,
  ListVersionsResponse,
  ToolkitContext,
  UpgradeVersionOptions,
  UpgradeVersionResponse
} from "./types.js";

const DEFAULT_LIST_IMAGE = "ghcr.io/ydb-platform/local-ydb";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_REGISTRY = "registry-1.docker.io";
const DOCKER_HUB_LIBRARY_PREFIX = "library/";
const VERSION_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export interface ParsedImageReference {
  input: string;
  imageName: string;
  registry: string;
  repository: string;
  tag?: string;
  digest?: string;
}

interface RegistryChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

export function parseImageReference(image: string): ParsedImageReference {
  const input = image.trim();
  if (!input) {
    throw new Error("Image reference must be non-empty");
  }

  let remainder = input;
  let digest: string | undefined;
  const digestIndex = remainder.indexOf("@");
  if (digestIndex !== -1) {
    digest = remainder.slice(digestIndex + 1);
    remainder = remainder.slice(0, digestIndex);
    if (!digest) {
      throw new Error(`Invalid image digest in reference: ${image}`);
    }
  }

  const lastSlash = remainder.lastIndexOf("/");
  const lastColon = remainder.lastIndexOf(":");
  let tag: string | undefined;
  if (lastColon > lastSlash) {
    tag = remainder.slice(lastColon + 1);
    remainder = remainder.slice(0, lastColon);
    if (!tag) {
      throw new Error(`Invalid image tag in reference: ${image}`);
    }
  }

  if (!remainder) {
    throw new Error(`Invalid image reference: ${image}`);
  }

  const segments = remainder.split("/");
  const hasExplicitRegistry = segments.length > 1 && (
    segments[0].includes(".") ||
    segments[0].includes(":") ||
    segments[0] === "localhost"
  );
  const registry = hasExplicitRegistry ? segments[0] : DEFAULT_REGISTRY;
  const repository = hasExplicitRegistry
    ? segments.slice(1).join("/")
    : segments.length === 1
      ? `${DOCKER_HUB_LIBRARY_PREFIX}${segments[0]}`
      : remainder;

  if (!repository || repository.startsWith("/") || repository.endsWith("/")) {
    throw new Error(`Image reference is not taggable: ${image}`);
  }

  return {
    input,
    imageName: remainder,
    registry,
    repository,
    tag,
    digest
  };
}

export function replaceImageTag(image: string, version: string): string {
  const targetVersion = version.trim();
  if (!VERSION_TAG_PATTERN.test(targetVersion)) {
    throw new Error(`Invalid target image tag: ${version}`);
  }

  const parsed = parseImageReference(image);
  if (parsed.digest) {
    throw new Error(`Cannot upgrade digest-pinned image reference: ${image}`);
  }

  return `${parsed.imageName}:${targetVersion}`;
}

export async function listVersions(options: ListVersionsOptions = {}): Promise<ListVersionsResponse> {
  const image = options.image ?? DEFAULT_LIST_IMAGE;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  assertPositiveInteger("pageSize", pageSize);
  assertPositiveInteger("maxPages", maxPages);
  if (pageSize > 1000) {
    throw new Error("pageSize must be 1000 or less");
  }
  if (maxPages > 100) {
    throw new Error("maxPages must be 100 or less");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available in this runtime");
  }

  const parsed = parseImageReference(image);
  const authScope = `repository:${parsed.repository}:pull`;
  const auth = { token: undefined as string | undefined };
  let nextUrl: URL | undefined = new URL(`https://${parsed.registry}/v2/${parsed.repository}/tags/list`);
  nextUrl.searchParams.set("n", String(pageSize));
  const tags: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (let page = 0; page < maxPages && nextUrl; page += 1) {
    const { response, payload } = await fetchRegistryTagsPage(fetchImpl, nextUrl, auth, authScope);
    const pageTags = Array.isArray(payload.tags)
      ? payload.tags.filter((value): value is string => typeof value === "string")
      : [];
    for (const tag of pageTags) {
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }

    const nextRef = parseNextLink(response.headers.get("link"));
    if (!nextRef) {
      nextUrl = undefined;
      break;
    }
    nextUrl = new URL(nextRef, nextUrl);
  }

  if (nextUrl) {
    truncated = true;
  }

  const sortedTags = sortVersionTags(tags);

  return {
    summary: `Listed ${tags.length} tag${tags.length === 1 ? "" : "s"} for ${parsed.repository} from ${parsed.registry}. Version tags are sorted newest first.`,
    image,
    registry: parsed.registry,
    repository: parsed.repository,
    tags: sortedTags,
    count: tags.length,
    truncated
  };
}

export async function upgradeVersion(
  ctx: ToolkitContext,
  options: UpgradeVersionOptions = {}
): Promise<UpgradeVersionResponse> {
  const version = options.version?.trim();
  if (!version) {
    throw new Error("version is required");
  }

  const sourceImage = ctx.profile.image;
  const targetImage = replaceImageTag(sourceImage, version);
  const authReapplyPlanned = requiresAuthReapply(ctx.profile);
  const dumpName = options.dumpName ?? buildUpgradeDumpName(ctx.profile, sourceImage, version);
  const inventoryState = await inventory(ctx);
  const extraDynamicNodes = inventoryState.containers
    .map((container) => extraDynamicNodeTarget(ctx.profile, container.names))
    .filter((target): target is NonNullable<typeof target> => Boolean(target))
    .sort((left, right) => left.index - right.index);
  const rebuildCtx = upgradeContext(ctx, targetImage, false);
  const finalCtx = authReapplyPlanned ? upgradeContext(ctx, targetImage, true) : rebuildCtx;

  const sourceImageSpec = ensureImagePresentSpec(sourceImage);
  const targetImageSpec = ensureImagePresentSpec(targetImage);
  const dumpPlan = await dumpTenant(ctx, { confirm: false, dumpName });
  const destroyPlan = await destroyStack(ctx, { confirm: false });
  const bootstrapPlan = await bootstrap(rebuildCtx, { confirm: false });
  const restorePlan = await restoreTenant(rebuildCtx, { confirm: false, dumpName });
  const reapplyPlans = authReapplyPlanned
    ? [
        await prepareAuthConfig(finalCtx, { confirm: false }),
        await writeDynamicNodeAuthConfig(finalCtx, {
          confirm: false,
          sid: finalCtx.profile.dynamicNodeAuthSid ?? "root@builtin"
        }),
        await applyAuthHardening(finalCtx, { confirm: false })
      ]
    : [];
  const extraDynamicPlans = [];
  for (const node of extraDynamicNodes) {
    extraDynamicPlans.push(await addDynamicNodes(finalCtx, {
      confirm: false,
      count: 1,
      startIndex: node.index
    }));
  }

  const plannedCommands = [
    ctx.client.display(sourceImageSpec),
    ctx.client.display(targetImageSpec),
    ...dumpPlan.plannedCommands,
    ...destroyPlan.plannedCommands,
    ...bootstrapPlan.plannedCommands,
    ...restorePlan.plannedCommands,
    ...reapplyPlans.flatMap((plan) => plan.plannedCommands),
    ...extraDynamicPlans.flatMap((plan) => plan.plannedCommands)
  ];
  const rollback = [
    `Pull ${sourceImage}, recreate the profile stack with the previous image, and restore dump ${dumpName}.`,
    "Auth artifacts are preserved; rerun local_ydb_prepare_auth_config, local_ydb_write_dynamic_auth_config, and local_ydb_apply_auth_hardening if auth reapply needs to be repeated."
  ];
  const verification = [
    `scheme ls ${ctx.profile.tenantPath}`,
    authReapplyPlanned ? "anonymous viewer/json returns 401 again after auth reapply" : "viewer/json/whoami remains reachable anonymously",
    extraDynamicNodes.length ? "previous extra dynamic-node suffixes appear in nodelist again" : "base dynamic node remains reachable",
    `profile containers use image ${targetImage}`
  ];

  if (!options.confirm) {
    return {
      summary: `Upgrade ${ctx.profile.name} from ${sourceImage} to ${targetImage} via dump, rebuild, and restore. Not executed because confirm=true was not provided.`,
      executed: false,
      risk: "high",
      plannedCommands,
      rollback,
      verification,
      sourceImage,
      targetImage,
      dumpName,
      authReapplyPlanned,
      extraDynamicNodes: extraDynamicNodes.map((node) => node.container)
    };
  }

  const results: CommandResult[] = [];
  const sourceImageResult = await ctx.client.run(sourceImageSpec);
  results.push(sourceImageResult);
  if (!sourceImageResult.ok) {
    return upgradeVersionResponse(
      sourceImage,
      targetImage,
      dumpName,
      authReapplyPlanned,
      extraDynamicNodes,
      undefined,
      plannedCommands,
      rollback,
      verification,
      results
    );
  }
  const targetImageResult = await ctx.client.run(targetImageSpec);
  results.push(targetImageResult);
  if (!targetImageResult.ok) {
    return upgradeVersionResponse(
      sourceImage,
      targetImage,
      dumpName,
      authReapplyPlanned,
      extraDynamicNodes,
      undefined,
      plannedCommands,
      rollback,
      verification,
      results
    );
  }

  if (!await runOperation(results, await dumpTenant(ctx, { confirm: true, dumpName }))) {
    return upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, plannedCommands, rollback, verification, results);
  }
  if (!await runOperation(results, await destroyStack(ctx, { confirm: true }))) {
    return upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, plannedCommands, rollback, verification, results);
  }
  if (!await runOperation(results, await bootstrap(rebuildCtx, { confirm: true }))) {
    return upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, plannedCommands, rollback, verification, results);
  }
  if (!await runOperation(results, await restoreTenant(rebuildCtx, { confirm: true, dumpName }))) {
    return upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, plannedCommands, rollback, verification, results);
  }

  if (authReapplyPlanned) {
    if (!await runOperation(results, await prepareAuthConfig(finalCtx, { confirm: true }))) {
      return upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, plannedCommands, rollback, verification, results);
    }
    if (!await runOperation(results, await writeDynamicNodeAuthConfig(finalCtx, {
      confirm: true,
      sid: finalCtx.profile.dynamicNodeAuthSid ?? "root@builtin"
    }))) {
      return upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, plannedCommands, rollback, verification, results);
    }
    if (!await runOperation(results, await applyAuthHardening(finalCtx, { confirm: true }))) {
      return upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, plannedCommands, rollback, verification, results);
    }
  }

  for (const node of extraDynamicNodes) {
    if (!await runOperation(results, await addDynamicNodes(finalCtx, {
      confirm: true,
      count: 1,
      startIndex: node.index
    }))) {
      return upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, plannedCommands, rollback, verification, results);
    }
  }

  const imageVerification = await verifyProfileImages(finalCtx, targetImage, extraDynamicNodes.map((node) => node.container));
  const { result: imageVerificationResult, ...imageVerificationData } = imageVerification;
  results.push(imageVerificationResult);

  return upgradeVersionResponse(
    sourceImage,
    targetImage,
    dumpName,
    authReapplyPlanned,
    extraDynamicNodes,
    imageVerificationData,
    plannedCommands,
    rollback,
    verification,
    results
  );
}

async function fetchRegistryTagsPage(
  fetchImpl: typeof fetch,
  url: URL,
  auth: { token?: string },
  authScope: string
): Promise<{ response: Response; payload: { tags?: unknown } }> {
  let response = await fetchImpl(url, {
    headers: registryRequestHeaders(auth.token)
  });

  if (response.status === 401) {
    const challenge = parseRegistryChallenge(response.headers.get("www-authenticate"));
    if (!challenge) {
      throw new Error(`Registry ${url.origin} requires authentication but did not advertise a Bearer challenge`);
    }
    auth.token = await fetchRegistryToken(fetchImpl, challenge, authScope);
    response = await fetchImpl(url, {
      headers: registryRequestHeaders(auth.token)
    });
  }

  if (!response.ok) {
    throw new Error(`Registry tags request failed with ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as { tags?: unknown };
  return { response, payload };
}

function registryRequestHeaders(token?: string): Record<string, string> {
  return token
    ? {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      }
    : {
        Accept: "application/json"
      };
}

function parseRegistryChallenge(header: string | null): RegistryChallenge | undefined {
  if (!header || !/^Bearer\s+/i.test(header)) {
    return undefined;
  }

  const attributes: Record<string, string> = {};
  for (const match of header.matchAll(/([A-Za-z]+)="([^"]*)"/g)) {
    attributes[match[1].toLowerCase()] = match[2];
  }
  if (!attributes.realm) {
    return undefined;
  }

  return {
    realm: attributes.realm,
    service: attributes.service,
    scope: attributes.scope
  };
}

async function fetchRegistryToken(
  fetchImpl: typeof fetch,
  challenge: RegistryChallenge,
  fallbackScope: string
): Promise<string> {
  const tokenUrl = new URL(challenge.realm);
  if (challenge.service) {
    tokenUrl.searchParams.set("service", challenge.service);
  }
  tokenUrl.searchParams.set("scope", challenge.scope ?? fallbackScope);

  const response = await fetchImpl(tokenUrl, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`Registry token request failed with ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as { token?: unknown; access_token?: unknown };
  const token = typeof payload.token === "string"
    ? payload.token
    : typeof payload.access_token === "string"
      ? payload.access_token
      : undefined;
  if (!token) {
    throw new Error(`Registry token response did not contain a usable token for ${tokenUrl.origin}`);
  }
  return token;
}

function parseNextLink(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(header);
  return match?.[1];
}

function sortVersionTags(tags: string[]): string[] {
  return [...tags].sort((left, right) => {
    const leftVersion = parseNumericVersionTag(left);
    const rightVersion = parseNumericVersionTag(right);
    if (leftVersion && rightVersion) {
      const length = Math.max(leftVersion.length, rightVersion.length);
      for (let index = 0; index < length; index += 1) {
        const leftPart = leftVersion[index] ?? -1;
        const rightPart = rightVersion[index] ?? -1;
        if (leftPart !== rightPart) {
          return rightPart - leftPart;
        }
      }
      return left.localeCompare(right);
    }
    if (leftVersion) {
      return -1;
    }
    if (rightVersion) {
      return 1;
    }
    return left.localeCompare(right);
  });
}

function parseNumericVersionTag(tag: string): number[] | undefined {
  if (!/^\d+(?:\.\d+)*$/.test(tag)) {
    return undefined;
  }
  return tag.split(".").map((part) => Number(part));
}

function buildUpgradeDumpName(profile: ResolvedLocalYdbProfile, sourceImage: string, version: string): string {
  const currentTag = parseImageReference(sourceImage).tag ?? "current";
  return `upgrade-${sanitizeTenantName(profile.tenantPath)}-${sanitizeIdentifier(currentTag)}-to-${sanitizeIdentifier(version)}`;
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function requiresAuthReapply(profile: ResolvedLocalYdbProfile): boolean {
  const authConfigured = Boolean(profile.authConfigPath || profile.dynamicNodeAuthTokenFile || profile.rootPasswordFile);
  if (!authConfigured) {
    return false;
  }
  if (!profile.authConfigPath || !profile.dynamicNodeAuthTokenFile || !profile.rootPasswordFile) {
    throw new Error("Automatic version upgrade for auth-enabled profiles requires authConfigPath, dynamicNodeAuthTokenFile, and rootPasswordFile.");
  }
  return true;
}

function upgradeContext(ctx: ToolkitContext, targetImage: string, includeAuth: boolean): ToolkitContext {
  const profile: ResolvedLocalYdbProfile = {
    ...ctx.profile,
    image: targetImage,
    authConfigPath: includeAuth ? ctx.profile.authConfigPath : undefined,
    dynamicNodeAuthTokenFile: includeAuth ? ctx.profile.dynamicNodeAuthTokenFile : undefined,
    dynamicNodeAuthSid: includeAuth ? ctx.profile.dynamicNodeAuthSid : undefined,
    rootPasswordFile: includeAuth ? ctx.profile.rootPasswordFile : undefined
  };
  return {
    config: ctx.config,
    profile,
    client: new LocalYdbApiClient(profile, ctx.client.executor)
  };
}

async function verifyProfileImages(
  ctx: ToolkitContext,
  expectedImage: string,
  extraDynamicContainers: string[]
): Promise<{
  expectedImage: string;
  missing: string[];
  mismatches: string[];
  result: CommandResult;
}> {
  const inv = await inventory(ctx);
  const targetNames = [
    ctx.profile.staticContainer,
    ctx.profile.dynamicContainer,
    ...extraDynamicContainers
  ];
  const imageByName = new Map(
    inv.containers
      .filter((container) => container.names && container.image)
      .map((container) => [container.names as string, container.image as string])
  );
  const missing = targetNames.filter((name) => !imageByName.has(name));
  const mismatches = targetNames
    .map((name) => ({ name, image: imageByName.get(name) }))
    .filter((item): item is { name: string; image: string } => typeof item.image === "string" && item.image !== expectedImage)
    .map((item) => `${item.name} -> ${item.image}`);
  const ok = missing.length === 0 && mismatches.length === 0;

  return {
    expectedImage,
    missing,
    mismatches,
    result: {
      command: `verify profile containers use image ${expectedImage}`,
      exitCode: ok ? 0 : 1,
      stdout: targetNames
        .map((name) => `${name}=${imageByName.get(name) ?? "<missing>"}`)
        .join("\n"),
      stderr: ok
        ? ""
        : [
            missing.length ? `Missing containers: ${missing.join(", ")}` : "",
            mismatches.length ? `Image mismatches: ${mismatches.join(", ")}` : ""
          ].filter(Boolean).join("\n"),
      ok,
      timedOut: false
    }
  };
}

async function runOperation(results: CommandResult[], response: { results?: CommandResult[] }): Promise<boolean> {
  if (response.results) {
    results.push(...response.results);
  }
  return !response.results || response.results.every((result) => result.ok);
}

function upgradeVersionResponse(
  sourceImage: string,
  targetImage: string,
  dumpName: string,
  authReapplyPlanned: boolean,
  extraDynamicNodes: Array<{ container: string }>,
  imageVerification: {
    expectedImage: string;
    missing: string[];
    mismatches: string[];
  } | undefined,
  plannedCommands: string[],
  rollback: string[],
  verification: string[],
  results: CommandResult[]
): UpgradeVersionResponse {
  return {
    summary: `Upgrade to ${targetImage}. Executed ${results.filter((result) => result.ok).length}/${results.length} commands.`,
    executed: true,
    risk: "high",
    plannedCommands,
    rollback,
    verification,
    results,
    sourceImage,
    targetImage,
    dumpName,
    authReapplyPlanned,
    extraDynamicNodes: extraDynamicNodes.map((node) => node.container),
    imageVerification
  };
}
