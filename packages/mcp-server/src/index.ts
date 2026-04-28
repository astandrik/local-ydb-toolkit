#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLocalYdbMcpServer } from "./server.js";

export { localYdbMcpServerVersion } from "./metadata.js";
export { createLocalYdbMcpServer, callLocalYdbToolForTest } from "./server.js";
export { localYdbInstructions } from "./tools/instructions.js";
export { localYdbTools } from "./tools/registry.js";

async function main(): Promise<void> {
  const server = createLocalYdbMcpServer();
  await server.connect(new StdioServerTransport());
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
