import {
  createContext,
  type ConfigSource,
  loadConfig,
  loadConfigDocument,
  type ProcessConfirmationStore,
  resolveConfigPath,
  type CommandExecutor,
  type LocalYdbConfig,
  type SchemaSdkExecutor,
  type SqlBackendExecutor,
  type ToolkitContext,
} from "@local-ydb-toolkit/core";
import type { ResponseContentFormat } from "../response-format.js";

export type HandlerOptions = {
  executor?: CommandExecutor;
  config?: LocalYdbConfig;
  fetchImpl?: typeof fetch;
  responseContentFormat?: ResponseContentFormat;
  sdkExecutor?: SchemaSdkExecutor;
  sqlExecutor?: SqlBackendExecutor;
  signal?: AbortSignal;
  confirmationStore?: ProcessConfirmationStore;
  confirmationToolName?: string;
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

function handlerConfigDocument(
  configPath: string | undefined,
  options: HandlerOptions,
): {
  config: LocalYdbConfig;
  source: ConfigSource | { kind: "provided"; config: LocalYdbConfig };
} {
  if (options.config) {
    return {
      config: options.config,
      source: { kind: "provided", config: options.config },
    };
  }
  return loadConfigDocument(configPath);
}

export function createToolContext(
  parsed: ProfileToolArgs,
  options: HandlerOptions,
): ToolkitContext {
  const loaded = handlerConfigDocument(parsed.configPath, options);
  return withConfirmation(createContext(
    parsed.profile,
    options.executor,
    loaded.config,
  ), loaded.source, options);
}

export function createUpgradeToolContext(
  parsed: ProfileToolArgs,
  options: HandlerOptions,
): ToolkitContext {
  const loaded = handlerConfigDocument(parsed.configPath, options);
  return withConfirmation(createContext(
    parsed.profile,
    options.executor,
    loaded.config,
    options.config ? undefined : resolveConfigPath(parsed.configPath),
  ), loaded.source, options);
}

function withConfirmation(
  context: ToolkitContext,
  configSource: ConfigSource | { kind: "provided"; config: LocalYdbConfig },
  options: HandlerOptions,
): ToolkitContext {
  if (!options.confirmationStore || !options.confirmationToolName) {
    return context;
  }
  return {
    ...context,
    confirmation: {
      store: options.confirmationStore,
      toolName: options.confirmationToolName,
      configSource,
    },
  };
}
