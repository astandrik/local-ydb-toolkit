import { BoundedFileReadError, readBoundedRegularFile } from "../config-file.js";
import { ConfigSchema, MAX_CONFIG_FILE_BYTES } from "../validation.js";
import type { UpgradeVersionResponse } from "./types.js";

export type ProfileImageUpdate = NonNullable<UpgradeVersionResponse["profileImageUpdate"]>;

export type ProfileConfigReceipt =
  | { state: "missing" }
  | { state: "file"; contentSha256: string };

const PROFILE_CONFIG_PLANNING_FAILURE = "Profile config could not be read safely for upgrade planning.";
export const MANUAL_PROFILE_IMAGE_UPDATE_ERROR = "Profile config update requires manual action after verifying the upgraded stack.";

export function plannedProfileImageUpdate(
  configPath: string,
  profile: string,
  sourceImage: string,
  targetImage: string,
): ProfileImageUpdate {
  return {
    configPath,
    profile,
    sourceImage,
    targetImage,
    executed: false,
    ok: false,
  };
}

export function manualProfileImageUpdate(
  configPath: string,
  profile: string,
  sourceImage: string,
  targetImage: string,
): ProfileImageUpdate {
  return {
    ...plannedProfileImageUpdate(configPath, profile, sourceImage, targetImage),
    error: MANUAL_PROFILE_IMAGE_UPDATE_ERROR,
  };
}

export function captureProfileConfigReceipt(
  configPath: string,
  profileName: string,
  sourceImage: string,
): ProfileConfigReceipt {
  let contents: ReturnType<typeof readBoundedRegularFile>;
  try {
    contents = readBoundedRegularFile(configPath, MAX_CONFIG_FILE_BYTES);
  } catch (error) {
    if (error instanceof BoundedFileReadError && error.code === "not-found") {
      return { state: "missing" };
    }
    throw new Error(PROFILE_CONFIG_PLANNING_FAILURE);
  }
  parseProfileConfig(contents.text, profileName, sourceImage);
  return { state: "file", contentSha256: contents.contentSha256 };
}

function parseProfileConfig(
  text: string,
  profileName: string,
  sourceImage: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(PROFILE_CONFIG_PLANNING_FAILURE);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(PROFILE_CONFIG_PLANNING_FAILURE);
  }
  const validated = ConfigSchema.safeParse(parsed);
  if (
    !validated.success
    || !Object.hasOwn(validated.data.profiles, profileName)
    || validated.data.profiles[profileName]?.image !== sourceImage
  ) {
    throw new Error(PROFILE_CONFIG_PLANNING_FAILURE);
  }
  return parsed as Record<string, unknown>;
}
