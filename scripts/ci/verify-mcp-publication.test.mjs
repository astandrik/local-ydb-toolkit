import assert from "node:assert/strict";
import test from "node:test";

import {
  checkPublication,
  compareRegistryMetadata,
} from "./verify-mcp-publication.mjs";

function serverMetadata() {
  return {
    $schema: "https://example.com/server.schema.json",
    name: "io.github.astandrik/local-ydb-mcp",
    title: "Local YDB MCP",
    description: "Operate local-ydb deployments.",
    version: "0.14.0",
    websiteUrl: "https://example.com/",
    repository: {
      url: "https://github.com/astandrik/local-ydb-toolkit",
      source: "github",
      id: "1220812874",
      subfolder: "packages/mcp-server",
    },
    packages: [
      {
        registryType: "npm",
        registryBaseUrl: "https://registry.npmjs.org",
        identifier: "@astandrik/local-ydb-mcp",
        version: "0.14.0",
        runtimeHint: "npx",
        runtimeArguments: [{ type: "named", name: "-y" }],
        environmentVariables: [
          {
            name: "LOCAL_YDB_MCP_CONTENT_FORMAT",
            description: "Response format.",
            isRequired: false,
            choices: ["json", "toon"],
            default: "json",
            placeholder: "toon",
          },
        ],
        transport: { type: "stdio" },
      },
    ],
  };
}

function response(status, body) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Registry comparison treats omitted isRequired as false and ignores _meta", () => {
  const expected = serverMetadata();
  const actual = structuredClone(expected);
  delete actual.packages[0].environmentVariables[0].isRequired;
  actual._meta = { "io.modelcontextprotocol.registry/official": { status: "active" } };

  assert.doesNotThrow(() =>
    compareRegistryMetadata(expected, {
      server: actual,
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } },
    }),
  );
});

test("Registry comparison rejects mismatched immutable metadata", () => {
  const expected = serverMetadata();
  const actual = structuredClone(expected);
  actual.packages[0].runtimeArguments = [{ type: "named", name: "--offline" }];

  assert.throws(
    () => compareRegistryMetadata(expected, { server: actual }),
    /Registry metadata does not match server\.json/,
  );
});

test("wait mode retries an exact Registry 404 until matching metadata appears", async () => {
  const metadata = serverMetadata();
  const statuses = [
    response(404, { message: "not found" }),
    response(200, { server: metadata }),
  ];
  let sleeps = 0;

  const result = await checkPublication({
    target: "registry",
    metadata,
    waitSeconds: 30,
    intervalMs: 15_000,
    fetchImpl: async () => statuses.shift(),
    sleepImpl: async () => {
      sleeps += 1;
    },
  });

  assert.deepEqual(result, { exists: true });
  assert.equal(sleeps, 1);
});

test("allow-missing reports an exact 404 without retrying or hiding it", async () => {
  const outputs = [];

  const result = await checkPublication({
    target: "registry",
    metadata: serverMetadata(),
    allowMissing: true,
    fetchImpl: async () => response(404, { message: "not found" }),
    writeOutput: (value) => outputs.push(value),
  });

  assert.deepEqual(result, { exists: false });
  assert.deepEqual(outputs, ["exists=false"]);
});

test("wait mode fails after a persistent exact 404", async () => {
  let now = 0;

  await assert.rejects(
    checkPublication({
      target: "registry",
      metadata: serverMetadata(),
      waitSeconds: 30,
      intervalMs: 15_000,
      nowImpl: () => now,
      fetchImpl: async () => response(404, { message: "not found" }),
      sleepImpl: async (milliseconds) => {
        now += milliseconds;
      },
    }),
    /was not found after waiting 30 seconds/,
  );
});

test("wait mode includes request time in the wall-clock deadline", async () => {
  let now = 0;
  const sleeps = [];

  await assert.rejects(
    checkPublication({
      target: "registry",
      metadata: serverMetadata(),
      waitSeconds: 30,
      intervalMs: 15_000,
      nowImpl: () => now,
      fetchImpl: async () => {
        now += 20_000;
        return response(404, { message: "not found" });
      },
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    }),
    /was not found after waiting 30 seconds/,
  );

  assert.deepEqual(sleeps, [10_000]);
});

test("HTTP requests use a bounded abort signal", async () => {
  await checkPublication({
    target: "registry",
    metadata: serverMetadata(),
    allowMissing: true,
    fetchImpl: async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return response(404, { message: "not found" });
    },
  });
});

test("HTTP 5xx is an error even when allow-missing is enabled", async () => {
  await assert.rejects(
    checkPublication({
      target: "registry",
      metadata: serverMetadata(),
      allowMissing: true,
      fetchImpl: async () => response(503, { message: "unavailable" }),
    }),
    /Registry request failed with HTTP 503/,
  );
});

test("npm readback requires the exact package identity and version", async () => {
  await assert.rejects(
    checkPublication({
      target: "npm",
      metadata: serverMetadata(),
      fetchImpl: async () =>
        response(200, {
          name: "@astandrik/local-ydb-mcp",
          version: "0.13.0",
        }),
    }),
    /npm metadata does not match server\.json/,
  );
});

test("npm readback uses registryBaseUrl from server.json", async () => {
  const metadata = serverMetadata();
  metadata.packages[0].registryBaseUrl = "https://npm.example.test/custom";
  let requestedUrl;

  await checkPublication({
    target: "npm",
    metadata,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return response(200, {
        name: "@astandrik/local-ydb-mcp",
        version: "0.14.0",
      });
    },
  });

  assert.equal(
    requestedUrl,
    "https://npm.example.test/custom/%40astandrik%2Flocal-ydb-mcp/0.14.0",
  );
});
