import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, commandToShell, type CommandExecutor } from "@local-ydb-toolkit/core";
import { createLocalYdbMcpApplication } from "../src/server.js";

describe("MCP confirmation activation boundary", () => {
  it("does not return internal file-source provenance through the current MCP response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "local-ydb-foundation-mcp-"));
    const path = join(directory, "config.json");
    const contents = '{ "profiles": { "default": { "tenantPath": "/local/foundation" } } }';
    writeFileSync(path, contents);
    const executor: CommandExecutor = {
      display: (_profile, spec) => commandToShell(spec),
      run: async (_profile, spec) => ({
        command: commandToShell(spec), exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false,
      }),
    };
    const application = createLocalYdbMcpApplication({ executor });
    const client = new Client({ name: "foundation-config", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await application.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool({
        name: "local_ydb_create_tenant", arguments: { configPath: path, confirm: true },
      });
      expect(response.structuredContent).toMatchObject({ executed: true });
      const serialized = JSON.stringify(response);
      expect(serialized.includes(path)).toBe(false);
      expect(serialized.includes(createHash("sha256").update(contents).digest("hex"))).toBe(false);
      expect(response.structuredContent).not.toHaveProperty("confirmation");
    } finally {
      await client.close();
      await application.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the current public surface and confirm-only execution until atomic activation", async () => {
    let calls = 0;
    const executor: CommandExecutor = {
      display: (_profile, spec) => commandToShell(spec),
      run: async (_profile, spec) => {
        calls += 1;
        return { command: commandToShell(spec), exitCode: 0, stdout: "", stderr: "", ok: true, timedOut: false };
      },
    };
    const application = createLocalYdbMcpApplication({ config: ConfigSchema.parse({}), executor });
    const client = new Client({ name: "foundation-compatibility", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await application.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(39);
      expect(tools.tools.filter(tool => Object.hasOwn(tool.inputSchema.properties ?? {}, "confirm"))).toHaveLength(23);
      expect(tools.tools.some(tool => Object.hasOwn(tool.inputSchema.properties ?? {}, "confirmationToken"))).toBe(false);
      expect((await client.listPrompts()).prompts).toHaveLength(8);
      expect(client.getServerCapabilities()?.resources).toBeUndefined();

      const planned = await client.callTool({ name: "local_ydb_create_tenant", arguments: {} });
      expect(planned.structuredContent).toMatchObject({ executed: false });
      expect(planned.structuredContent).not.toHaveProperty("confirmation");
      expect(calls).toBe(0);

      const confirmed = await client.callTool({ name: "local_ydb_create_tenant", arguments: { confirm: true } });
      expect(confirmed.structuredContent).toMatchObject({ executed: true });
      expect(confirmed.structuredContent).not.toHaveProperty("confirmation");
      expect(calls).toBe(1);

      const rejected = await client.callTool({
        name: "local_ydb_create_tenant",
        arguments: { confirm: true, confirmationToken: "not-yet-a-public-argument" },
      });
      expect(rejected.isError).toBe(true);
      expect(calls).toBe(1);
    } finally {
      await client.close();
      await application.close();
    }
  });
});
