import { LocalYdbApiClient, type CommandResult } from "../api-client.js";
import {
  attachConfirmation,
  authorizeMutation,
  confirmationSummarySuffix,
  withoutConfirmation,
} from "../confirmation.js";
import { sanitizeTenantName, type ResolvedLocalYdbProfile } from "../validation.js";
import { applyAuthHardening, prepareAuthConfig, writeDynamicNodeAuthConfig } from "./auth-operations.js";
import { inventory, requireInventory } from "./checks.js";
import {
  COMPOSITE_DUMP_CLEANUP_FAILURE,
  COMPOSITE_DUMP_SNAPSHOT_COMMAND,
  createCompositeDumpSnapshot,
} from "./composite-dump.js";
import { addDynamicNodes } from "./dynamic-nodes.js";
import { configuredDynamicNodePlans } from "./dynamic-node-topology.js";
import { inspectExtraDynamicNodePlans } from "./dynamic-node-inspect.js";
import { assertPositiveInteger } from "./helpers.js";
import { ensureImagePresentSpec } from "./images.js";
import {
  captureProfileConfigReceipt,
  MANUAL_PROFILE_IMAGE_UPDATE_ERROR,
  manualProfileImageUpdate,
  plannedProfileImageUpdate,
  type ProfileImageUpdate,
} from "./profile-image-config.js";
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
const REGISTRY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["docker.io", DEFAULT_REGISTRY],
  ["index.docker.io", DEFAULT_REGISTRY]
]);
const REGISTRY_AUTH_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  "ghcr.io": ["https://ghcr.io"],
  "registry-1.docker.io": ["https://auth.docker.io"]
};

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

type ImageVerificationData = NonNullable<UpgradeVersionResponse["imageVerification"]>;
type ImageVerificationOutcome =
  | { kind: "verified"; verification: ImageVerificationData; result: CommandResult }
  | { kind: "mismatch"; verification: ImageVerificationData; result: CommandResult }
  | { kind: "unavailable"; result: CommandResult };

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
  const registry = canonicalizeRegistry(parsed.registry);
  const allowedAuthOrigins = REGISTRY_AUTH_ORIGINS[registry];
  if (!allowedAuthOrigins) {
    throw new Error(
      `Version listing only supports trusted registries: ${Object.keys(REGISTRY_AUTH_ORIGINS).join(", ")}`
    );
  }
  const authScope = `repository:${parsed.repository}:pull`;
  const auth = { token: undefined as string | undefined };
  let nextUrl: URL | undefined = new URL(`https://${registry}/v2/${parsed.repository}/tags/list`);
  const registryOrigin = nextUrl.origin;
  nextUrl.searchParams.set("n", String(pageSize));
  const tags: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (let page = 0; page < maxPages && nextUrl; page += 1) {
    const { response, payload } = await fetchRegistryTagsPage(
      fetchImpl,
      nextUrl,
      auth,
      authScope,
      allowedAuthOrigins
    );
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
    const candidateUrl: URL = new URL(nextRef, nextUrl);
    if (candidateUrl.origin !== registryOrigin) {
      throw new Error(`Registry pagination must remain on ${registryOrigin}`);
    }
    nextUrl = candidateUrl;
  }

  if (nextUrl) {
    truncated = true;
  }

  const sortedTags = sortVersionTags(tags);

  return {
    summary: `Listed ${tags.length} tag${tags.length === 1 ? "" : "s"} for ${parsed.repository} from ${registry}. Version tags are sorted newest first.`,
    image,
    registry,
    repository: parsed.repository,
    tags: sortedTags,
    count: tags.length,
    truncated
  };
}

function canonicalizeRegistry(registry: string): string {
  return REGISTRY_ALIASES.get(registry) ?? registry;
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
  if (ctx.profile.bindMountPath) {
    throw new Error("Automatic version upgrade does not support bindMountPath profiles because the upgrade must rebuild from empty storage.");
  }
  if (!ctx.configPath) {
    throw new Error("Automatic version upgrade requires a file-backed local-ydb config path so the reviewed source profile can be verified and updated manually after the upgrade.");
  }
  const profileConfigReceipt = captureProfileConfigReceipt(
    ctx.configPath,
    ctx.profile.name,
    sourceImage,
  );

  const authReapplyPlanned = requiresAuthReapply(ctx.profile);
  const dumpName = options.dumpName ?? buildUpgradeDumpName(ctx.profile, sourceImage, version);
  const profileImageUpdate = plannedProfileImageUpdate(ctx.configPath, ctx.profile.name, sourceImage, targetImage);
  const inventoryState = await requireInventory(ctx);
  const extraDynamicNodes = await inspectExtraDynamicNodePlans(
    ctx,
    inventoryState.containers.map((container) => container.names)
  );
  const rebuildCtx = upgradeContext(ctx, targetImage, false);
  const finalCtx = authReapplyPlanned ? upgradeContext(ctx, targetImage, true) : rebuildCtx;
  const phaseCtx = withoutConfirmation(ctx);

  const sourceImageSpec = ensureImagePresentSpec(sourceImage);
  const targetImageSpec = ensureImagePresentSpec(targetImage);
  const dumpPlan = await dumpTenant(phaseCtx, { confirm: false, dumpName });
  const preparedExtraDynamicContainers = extraDynamicNodes.map((node) => node.container);
  const destroyPlan = await destroyStack(
    phaseCtx,
    { confirm: false },
    preparedExtraDynamicContainers,
  );
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
      startIndex: node.index,
      grpcPortStart: node.grpcPort,
      monitoringPortStart: node.monitoringPort,
      icPortStart: node.icPort
    }));
  }

  const plannedCommands = [
    ctx.client.display(sourceImageSpec),
    ctx.client.display(targetImageSpec),
    ...dumpPlan.plannedCommands,
    COMPOSITE_DUMP_SNAPSHOT_COMMAND,
    ...destroyPlan.plannedCommands,
    ...bootstrapPlan.plannedCommands,
    ...restorePlan.plannedCommands,
    ...reapplyPlans.flatMap((plan) => plan.plannedCommands),
    ...extraDynamicPlans.flatMap((plan) => plan.plannedCommands)
  ];
  const rollback = [
    `Pull ${sourceImage}, recreate the profile stack with the previous image, and restore dump ${dumpName}.`,
    `If the config was manually updated to ${targetImage}, set profiles.${ctx.profile.name}.image in ${ctx.configPath} back to ${sourceImage} when rolling back.`,
    "Auth artifacts are preserved; rerun local_ydb_prepare_auth_config, local_ydb_write_dynamic_auth_config, and local_ydb_apply_auth_hardening if auth reapply needs to be repeated."
  ];
  const verification = [
    `scheme ls ${ctx.profile.tenantPath}`,
    authReapplyPlanned ? "anonymous viewer/json returns 401 again after auth reapply" : "viewer/json/whoami remains reachable anonymously",
    `configured and restored one-off dynamic containers are present: ${[
      ...configuredDynamicNodePlans(finalCtx.profile).map((plan) => plan.container),
      ...extraDynamicNodes.map((node) => node.container)
    ].join(", ")}`,
    `nodelist includes configured and restored one-off IC ports: ${[
      ...configuredDynamicNodePlans(finalCtx.profile).map((plan) => plan.icPort),
      ...extraDynamicNodes.map((node) => node.icPort)
    ].join(", ")}`,
    `profile containers use image ${targetImage}`,
    `after independent image and data verification, manually set profiles.${ctx.profile.name}.image in ${ctx.configPath} to ${targetImage}`
  ];

  const summary = `Upgrade ${ctx.profile.name} from ${sourceImage} to ${targetImage} via dump, rebuild, and restore.`;
  const decision = await authorizeMutation(ctx, options, {
    kind: "version-upgrade",
    request: { version, dumpName, sourceImage, targetImage },
    profileConfigReceipt,
    profileImageUpdate,
    extraDynamicNodes,
    authReapplyPlanned,
    plannedCommands,
    risk: "high",
    rollback,
    verification,
  });
  if (!decision.execute) {
    return attachConfirmation({
      summary: `${summary}${confirmationSummarySuffix(decision.confirmation)}`,
      executed: false,
      risk: "high",
      plannedCommands,
      rollback,
      verification,
      sourceImage,
      targetImage,
      dumpName,
      authReapplyPlanned,
      extraDynamicNodes: extraDynamicNodes.map((node) => node.container),
      profileImageUpdate
    }, decision.confirmation);
  }
  const confirmed = (response: UpgradeVersionResponse) =>
    attachConfirmation(response, decision.confirmation);

  const results: CommandResult[] = [];
  const sourceImageResult = await ctx.client.run(sourceImageSpec);
  results.push(sourceImageResult);
  if (!sourceImageResult.ok) {
    return confirmed(upgradeVersionResponse(
      sourceImage,
      targetImage,
      dumpName,
      authReapplyPlanned,
      extraDynamicNodes,
      undefined,
      profileImageUpdate,
      plannedCommands,
      rollback,
      verification,
      results
    ));
  }
  const targetImageResult = await ctx.client.run(targetImageSpec);
  results.push(targetImageResult);
  if (!targetImageResult.ok) {
    return confirmed(upgradeVersionResponse(
      sourceImage,
      targetImage,
      dumpName,
      authReapplyPlanned,
      extraDynamicNodes,
      undefined,
      profileImageUpdate,
      plannedCommands,
      rollback,
      verification,
      results
    ));
  }

  if (!await runOperation(results, await dumpTenant(phaseCtx, { confirm: true, dumpName }))) {
    return confirmed(upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, profileImageUpdate, plannedCommands, rollback, verification, results));
  }
  const dumpSnapshot = await createCompositeDumpSnapshot(phaseCtx, dumpName);
  results.push(dumpSnapshot.result);
  try {
    if (!dumpSnapshot.result.ok || !dumpSnapshot.preparedRestore) {
      return confirmed(upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, profileImageUpdate, plannedCommands, rollback, verification, results));
    }
    if (!await runOperation(results, await destroyStack(
      phaseCtx,
      { confirm: true },
      preparedExtraDynamicContainers,
    ))) {
      return confirmed(upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, profileImageUpdate, plannedCommands, rollback, verification, results));
    }
    if (!await runOperation(results, await bootstrap(rebuildCtx, { confirm: true }))) {
      return confirmed(upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, profileImageUpdate, plannedCommands, rollback, verification, results));
    }
    if (!await runOperation(results, await restoreTenant(
      rebuildCtx,
      { confirm: true, dumpName },
      dumpSnapshot.preparedRestore,
    ))) {
      return confirmed(upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, profileImageUpdate, plannedCommands, rollback, verification, results));
    }

    if (authReapplyPlanned) {
      if (!await runOperation(results, await prepareAuthConfig(finalCtx, { confirm: true }))) {
        return confirmed(upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, profileImageUpdate, plannedCommands, rollback, verification, results));
      }
      if (!await runOperation(results, await writeDynamicNodeAuthConfig(finalCtx, {
        confirm: true,
        sid: finalCtx.profile.dynamicNodeAuthSid ?? "root@builtin"
      }))) {
        return confirmed(upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, profileImageUpdate, plannedCommands, rollback, verification, results));
      }
      if (!await runOperation(results, await applyAuthHardening(finalCtx, { confirm: true }))) {
        return confirmed(upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, profileImageUpdate, plannedCommands, rollback, verification, results));
      }
    }

    for (const node of extraDynamicNodes) {
      if (!await runOperation(results, await addDynamicNodes(finalCtx, {
        confirm: true,
        count: 1,
        startIndex: node.index,
        grpcPortStart: node.grpcPort,
        monitoringPortStart: node.monitoringPort,
        icPortStart: node.icPort
      }))) {
        return confirmed(upgradeVersionResponse(sourceImage, targetImage, dumpName, authReapplyPlanned, extraDynamicNodes, undefined, profileImageUpdate, plannedCommands, rollback, verification, results));
      }
    }

    const imageVerification = await verifyProfileImages(finalCtx, targetImage, extraDynamicNodes.map((node) => node.container));
    results.push(imageVerification.result);
    if (imageVerification.kind === "mismatch") {
      return confirmed(upgradeVersionResponse(
        sourceImage,
        targetImage,
        dumpName,
        authReapplyPlanned,
        extraDynamicNodes,
        imageVerification.verification,
        profileImageUpdate,
        plannedCommands,
        rollback,
        verification,
        results
      ));
    }

    if (imageVerification.kind === "unavailable") {
      const manualProfileUpdate = manualProfileImageUpdate(
        ctx.configPath,
        ctx.profile.name,
        sourceImage,
        targetImage,
      );
      return confirmed(upgradeVersionResponse(
        sourceImage,
        targetImage,
        dumpName,
        authReapplyPlanned,
        extraDynamicNodes,
        undefined,
        manualProfileUpdate,
        plannedCommands,
        rollback,
        verification,
        results
      ));
    }

    const manualProfileUpdate = manualProfileImageUpdate(
      ctx.configPath,
      ctx.profile.name,
      sourceImage,
      targetImage,
    );

    return confirmed(upgradeVersionResponse(
      sourceImage,
      targetImage,
      dumpName,
      authReapplyPlanned,
      extraDynamicNodes,
      imageVerification.verification,
      manualProfileUpdate,
      plannedCommands,
      rollback,
      verification,
      results
    ));
  } finally {
    if (!await dumpSnapshot.remove()) {
      throw new Error(COMPOSITE_DUMP_CLEANUP_FAILURE);
    }
  }
}

async function fetchRegistryTagsPage(
  fetchImpl: typeof fetch,
  url: URL,
  auth: { token?: string },
  authScope: string,
  allowedAuthOrigins: readonly string[]
): Promise<{ response: Response; payload: { tags?: unknown } }> {
  let response = await fetchImpl(url, {
    headers: registryRequestHeaders(auth.token),
    redirect: "error"
  });

  if (response.status === 401) {
    const challenge = parseRegistryChallenge(response.headers.get("www-authenticate"));
    if (!challenge) {
      throw new Error(`Registry ${url.origin} requires authentication but did not advertise a Bearer challenge`);
    }
    auth.token = await fetchRegistryToken(fetchImpl, challenge, authScope, allowedAuthOrigins);
    response = await fetchImpl(url, {
      headers: registryRequestHeaders(auth.token),
      redirect: "error"
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
  fallbackScope: string,
  allowedOrigins: readonly string[]
): Promise<string> {
  const tokenUrl = new URL(challenge.realm);
  if (!allowedOrigins.includes(tokenUrl.origin)) {
    throw new Error(`Registry authentication endpoint is not trusted: ${tokenUrl.origin}`);
  }
  if (challenge.service) {
    tokenUrl.searchParams.set("service", challenge.service);
  }
  tokenUrl.searchParams.set("scope", challenge.scope ?? fallbackScope);

  const response = await fetchImpl(tokenUrl, {
    headers: { Accept: "application/json" },
    redirect: "error"
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
    configPath: ctx.configPath,
    profile,
    client: new LocalYdbApiClient(profile, ctx.client.executor)
  };
}

async function verifyProfileImages(
  ctx: ToolkitContext,
  expectedImage: string,
  extraDynamicContainers: string[]
): Promise<ImageVerificationOutcome> {
  const inv = await inventory(ctx);
  if (!inv.ok) {
    return {
      kind: "unavailable",
      result: {
        command: `verify profile containers use image ${expectedImage}`,
        exitCode: 1,
        stdout: "",
        stderr: "Docker inventory was unavailable during final image verification.",
        ok: false,
        timedOut: false
      }
    };
  }
  const targetNames = [
    ctx.profile.staticContainer,
    ...configuredDynamicNodePlans(ctx.profile).map((plan) => plan.container),
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

  const verification = { expectedImage, missing, mismatches };
  return {
    kind: ok ? "verified" : "mismatch",
    verification,
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
  profileImageUpdate: ProfileImageUpdate | undefined,
  plannedCommands: string[],
  rollback: string[],
  verification: string[],
  results: CommandResult[]
): UpgradeVersionResponse {
  const completedCommands = results.filter((result) => result.ok).length;
  const progress = `Upgrade to ${targetImage}. Executed ${completedCommands}/${results.length} commands.`;
  const summary = upgradeVersionSummary(progress, imageVerification, profileImageUpdate);
  return {
    summary,
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
    profileImageUpdate,
    imageVerification
  };
}

function upgradeVersionSummary(
  progress: string,
  imageVerification: ImageVerificationData | undefined,
  profileImageUpdate: ProfileImageUpdate | undefined
): string {
  if (imageVerification) {
    if (imageVerification.missing.length > 0 || imageVerification.mismatches.length > 0) {
      return `${progress} Final image verification found a mismatch; the profile image was not updated.`;
    }
    if (profileImageUpdate?.error === MANUAL_PROFILE_IMAGE_UPDATE_ERROR) {
      return `${progress} Final image verification succeeded; profile config was not updated automatically and requires manual action.`;
    }
    if (profileImageUpdate?.executed) {
      return `${progress} Final image verification succeeded; profile image update ${profileImageUpdate.ok ? "succeeded" : "failed"}.`;
    }
    return `${progress} Final image verification succeeded.`;
  }
  if (profileImageUpdate?.error === MANUAL_PROFILE_IMAGE_UPDATE_ERROR) {
    return `${progress} Final container images could not be verified; profile config was not updated automatically and requires independent verification before manual action.`;
  }
  if (profileImageUpdate?.executed) {
    return `${progress} Final container images could not be verified; the target profile image update ${profileImageUpdate.ok ? "succeeded" : "failed"}.`;
  }
  return `${progress} Final image verification was not reached.`;
}
