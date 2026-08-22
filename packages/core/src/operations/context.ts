import { LocalYdbApiClient, type CommandExecutor } from "../api-client.js";
import { loadConfig, resolveConfigPath, resolveProfile, type LocalYdbConfig } from "../validation.js";
import type { ToolkitContext } from "./types.js";

export function createContext(
  profileName?: string,
  executor?: CommandExecutor,
  config?: LocalYdbConfig,
  configPath?: string
): ToolkitContext {
  const effectiveConfig = config ?? loadConfig(configPath);
  const effectiveConfigPath = configPath ? resolveConfigPath(configPath) : config ? undefined : resolveConfigPath();
  const profile = resolveProfile(effectiveConfig, profileName);
  return {
    config: effectiveConfig,
    configPath: effectiveConfigPath,
    profile,
    client: new LocalYdbApiClient(profile, executor)
  };
}
