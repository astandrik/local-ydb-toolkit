import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { CommandResult } from "../api-client.js";
import { BoundedFileReadError, readBoundedRegularFile } from "../config-file.js";
import { ConfigSchema, MAX_CONFIG_FILE_BYTES } from "../validation.js";
import type { UpgradeVersionResponse } from "./types.js";

export type ProfileImageUpdate = NonNullable<UpgradeVersionResponse["profileImageUpdate"]>;

export type ProfileConfigReceipt =
  | { state: "missing" }
  | { state: "file"; contentSha256: string };

const UPDATE_FAILURE = "Profile config changed after confirmation or could not be updated safely.";

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
    throw new Error("Profile config could not be read safely for upgrade planning.");
  }
  parseProfileConfig(contents.text, profileName, sourceImage);
  return { state: "file", contentSha256: contents.contentSha256 };
}

export function updateProfileImage(
  configPath: string,
  profileName: string,
  sourceImage: string,
  targetImage: string,
  receipt: ProfileConfigReceipt,
): ProfileImageUpdate {
  try {
    if (receipt.state !== "file") {
      throw new Error(UPDATE_FAILURE);
    }
    const rawConfig = readRawConfigForProfileUpdate(
      configPath,
      profileName,
      sourceImage,
      receipt,
    );
    const profiles = rawConfig.profiles;
    if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
      throw new Error(UPDATE_FAILURE);
    }
    const profileRecord = profiles as Record<string, unknown>;
    const profile = Object.hasOwn(profileRecord, profileName)
      ? profileRecord[profileName]
      : undefined;
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error(UPDATE_FAILURE);
    }
    (profile as Record<string, unknown>).image = targetImage;
    ConfigSchema.parse(rawConfig);
    writeJsonAtomicCas(configPath, rawConfig, receipt);
    return {
      configPath,
      profile: profileName,
      sourceImage,
      targetImage,
      executed: true,
      ok: true,
    };
  } catch {
    return {
      configPath,
      profile: profileName,
      sourceImage,
      targetImage,
      executed: true,
      ok: false,
      error: UPDATE_FAILURE,
    };
  }
}

export function profileImageUpdateCommand(
  configPath: string,
  profile: string,
  sourceImage: string,
  targetImage: string,
): string {
  return `update ${configPath}: profiles.${profile}.image ${sourceImage} -> ${targetImage}`;
}

export function profileImageUpdateResult(update: ProfileImageUpdate): CommandResult {
  return {
    command: profileImageUpdateCommand(
      update.configPath,
      update.profile,
      update.sourceImage,
      update.targetImage,
    ),
    exitCode: update.ok ? 0 : 1,
    stdout: update.ok ? `Updated profiles.${update.profile}.image to ${update.targetImage}` : "",
    stderr: update.ok ? "" : update.error ?? "Profile image update failed",
    ok: update.ok,
    timedOut: false,
  };
}

function readRawConfigForProfileUpdate(
  configPath: string,
  profileName: string,
  sourceImage: string,
  receipt: Extract<ProfileConfigReceipt, { state: "file" }>,
): Record<string, unknown> {
  let contents: ReturnType<typeof readBoundedRegularFile>;
  try {
    contents = readBoundedRegularFile(configPath, MAX_CONFIG_FILE_BYTES);
  } catch {
    throw new Error(UPDATE_FAILURE);
  }
  if (contents.contentSha256 !== receipt.contentSha256) {
    throw new Error(UPDATE_FAILURE);
  }
  return parseProfileConfig(contents.text, profileName, sourceImage);
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
    throw new Error(UPDATE_FAILURE);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(UPDATE_FAILURE);
  }
  const validated = ConfigSchema.safeParse(parsed);
  if (
    !validated.success
    || !Object.hasOwn(validated.data.profiles, profileName)
    || validated.data.profiles[profileName]?.image !== sourceImage
  ) {
    throw new Error(UPDATE_FAILURE);
  }
  return parsed as Record<string, unknown>;
}

function writeJsonAtomicCas(
  configPath: string,
  rawConfig: Record<string, unknown>,
  receipt: Extract<ProfileConfigReceipt, { state: "file" }>,
): void {
  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const tmpPath = `${configPath}.tmp-${suffix}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(rawConfig, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const current = readBoundedRegularFile(configPath, MAX_CONFIG_FILE_BYTES);
    if (current.contentSha256 !== receipt.contentSha256) {
      throw new Error(UPDATE_FAILURE);
    }
    chmodSync(tmpPath, current.mode);
    renameSync(tmpPath, configPath);
  } catch (error) {
    removeFileIfPresent(tmpPath);
    throw error;
  }
}

function removeFileIfPresent(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    // Preserve the non-disclosing update failure as the public result.
  }
}
