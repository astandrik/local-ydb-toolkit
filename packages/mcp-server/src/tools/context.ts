import {
  createContext,
  loadConfig,
  resolveConfigPath,
  type CommandExecutor,
  type LocalYdbConfig,
  type ToolkitContext,
} from "@local-ydb-toolkit/core";

export type HandlerOptions = {
  executor?: CommandExecutor;
  config?: LocalYdbConfig;
  fetchImpl?: typeof fetch;
};

export type ToolHandler = (
  args: unknown,
  options: HandlerOptions,
) => Promise<unknown>;

export type ProfileToolArgs = {
  profile?: string;
  configPath?: string;
};

export function handlerConfig(
  configPath: string | undefined,
  options: HandlerOptions,
): LocalYdbConfig {
  return options.config ?? loadConfig(configPath);
}

export function createToolContext(
  parsed: ProfileToolArgs,
  options: HandlerOptions,
): ToolkitContext {
  return createContext(
    parsed.profile,
    options.executor,
    handlerConfig(parsed.configPath, options),
  );
}

export function createUpgradeToolContext(
  parsed: ProfileToolArgs,
  options: HandlerOptions,
): ToolkitContext {
  const config = handlerConfig(parsed.configPath, options);
  return createContext(
    parsed.profile,
    options.executor,
    config,
    options.config ? undefined : resolveConfigPath(parsed.configPath),
  );
}
