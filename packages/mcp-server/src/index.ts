#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLocalYdbMcpApplication } from "./server.js";
import { localYdbMcpServerVersion } from "./metadata.js";

export { localYdbMcpServerVersion };
export { getLocalYdbPrompt, localYdbPrompts } from "./prompts.js";
export {
  createLocalYdbMcpApplication,
  createLocalYdbMcpServer,
  callLocalYdbToolForTest,
} from "./server.js";
export type { LocalYdbMcpApplication } from "./server.js";
export { localYdbInstructions } from "./tools/instructions.js";
export { localYdbTools } from "./tools/registry.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${localYdbMcpServerVersion}\n`);
    return;
  }
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`local-ydb-mcp: stdio MCP server for operating Docker-based local YDB deployments.

Usage:
  local-ydb-mcp             Start the MCP server over stdin/stdout.
  local-ydb-mcp --version   Print the installed package version and exit.
  local-ydb-mcp --help      Print this help and exit.

Environment:
  LOCAL_YDB_TOOLKIT_CONFIG      Absolute path to a toolkit JSON config file.
  LOCAL_YDB_MCP_CONTENT_FORMAT  Response text format: json (default) or toon.

You can also pass an absolute configPath in individual MCP tool calls.
With no explicit config path, the server looks for local-ydb.config.json in
its working directory and uses a default local profile if that file is absent.
`);
    return;
  }
  if (args.length !== 0) {
    process.stderr.write("Invalid arguments. Run local-ydb-mcp --help for usage.\n");
    process.exitCode = 2;
    return;
  }
  const application = createLocalYdbMcpApplication();
  await application.connect(new StdioServerTransport());
}

if (isCliEntryPoint()) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exit(1);
  });
}

function isCliEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return fileURLToPath(import.meta.url) === entry;
  }
}
