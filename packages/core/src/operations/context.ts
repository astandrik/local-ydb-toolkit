import { LocalYdbApiClient, type CommandExecutor } from "../api-client.js";
import { loadConfig, resolveProfile, type LocalYdbConfig } from "../validation.js";
import type { ToolkitContext } from "./types.js";

export function createContext(profileName?: string, executor?: CommandExecutor, config = loadConfig()): ToolkitContext {
  const profile = resolveProfile(config, profileName);
  return {
    config,
    profile,
    client: new LocalYdbApiClient(profile, executor)
  };
}
