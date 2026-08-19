import assert from "node:assert/strict";
import test from "node:test";

import { checkAgentPluginFreshness } from "./check-agent-plugin-freshness.mjs";

const packageName = "@astandrik/local-ydb-mcp";
const serverName = "io.github.astandrik/local-ydb-mcp";
const publishedVersion = "0.16.0";

function serverMetadata() {
  return {
    name: serverName,
    version: publishedVersion,
    packages: [
      {
        registryType: "npm",
        registryBaseUrl: "https://registry.npmjs.org",
        identifier: packageName,
        version: publishedVersion,
      },
    ],
  };
}

function pluginConfig(version = publishedVersion) {
  return {
    mcpServers: {
      "local-ydb": {
        command: "npx",
        args: ["--yes", `${packageName}@${version}`],
      },
    },
  };
}

function registryResponse(metadata = serverMetadata()) {
  return {
    server: {
      name: metadata.name,
      version: metadata.version,
      packages: [
        {
          registryType: "npm",
          identifier: metadata.packages[0].identifier,
          version: metadata.packages[0].version,
        },
      ],
    },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulFetch(metadata = serverMetadata()) {
  return async (url) => {
    if (url.endsWith("/latest")) {
      return jsonResponse(200, {
        name: metadata.packages[0].identifier,
        version: metadata.version,
      });
    }
    return jsonResponse(200, registryResponse(metadata));
  };
}

test("accepts an exactly published npm package, Registry version, and plugin pin", async () => {
  const result = await checkAgentPluginFreshness({
    server: serverMetadata(),
    plugin: pluginConfig(),
    fetchImpl: successfulFetch(),
  });

  assert.deepEqual(result, {
    packageName,
    pluginVersion: publishedVersion,
    publishedVersion,
  });
});

test("rejects non-canonical npm registry bases before any HTTP request", async (t) => {
  const rejectedRegistryBaseUrls = [
    undefined,
    "http://registry.npmjs.org",
    "https://127.0.0.1",
    "https://169.254.169.254/latest/meta-data",
    "https://registry.npmjs.org.example.test",
    "https://user:password@registry.npmjs.org",
    "https://registry.npmjs.org?target=https://127.0.0.1",
    "https://registry.npmjs.org/custom",
    "https://registry.npmjs.org/",
  ];

  for (const registryBaseUrl of rejectedRegistryBaseUrls) {
    await t.test(String(registryBaseUrl), async () => {
      const server = serverMetadata();
      server.packages[0].registryBaseUrl = registryBaseUrl;
      let requests = 0;

      await assert.rejects(
        checkAgentPluginFreshness({
          server,
          plugin: pluginConfig(),
          fetchImpl: async () => {
            requests += 1;
            return jsonResponse(200, {});
          },
        }),
        /server\.json npm package must use registryBaseUrl https:\/\/registry\.npmjs\.org exactly/,
      );
      assert.equal(requests, 0);
    });
  }
});

test("rejects a fragment that would suppress the npm package path", async () => {
  const server = serverMetadata();
  server.packages[0].registryBaseUrl = "https://registry.npmjs.org#ignored";
  let requests = 0;

  await assert.rejects(
    checkAgentPluginFreshness({
      server,
      plugin: pluginConfig(),
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse(200, {});
      },
    }),
    /server\.json npm package must use registryBaseUrl https:\/\/registry\.npmjs\.org exactly/,
  );
  assert.equal(requests, 0);
});

test("reports the current pin, published version, and repair command when the plugin drifts", async () => {
  await assert.rejects(
    checkAgentPluginFreshness({
      server: serverMetadata(),
      plugin: pluginConfig("0.15.0"),
      fetchImpl: successfulFetch(),
    }),
    new RegExp(
      "Plugin pin @astandrik/local-ydb-mcp@0\\.15\\.0 is behind published @astandrik/local-ydb-mcp@0\\.16\\.0\\. Run: npm run plugin:pin -- --mcp-version 0\\.16\\.0 --write",
    ),
  );
});

test("fails closed without a downgrade command when the plugin pin is ahead of publication", async () => {
  await assert.rejects(
    checkAgentPluginFreshness({
      server: serverMetadata(),
      plugin: pluginConfig("0.17.0"),
      fetchImpl: successfulFetch(),
    }),
    (error) => {
      assert.match(error.message, /Plugin pin @astandrik\/local-ydb-mcp@0\.17\.0 is ahead of published @astandrik\/local-ydb-mcp@0\.16\.0/);
      assert.match(error.message, /Investigate release consistency and read back the published metadata\./);
      assert.doesNotMatch(error.message, /npm run plugin:pin/);
      return true;
    },
  );
});

test("rejects prerelease server, package, and plugin pin versions", async (t) => {
  await t.test("server version", async () => {
    const server = serverMetadata();
    server.version = "0.16.0-rc.1";
    server.packages[0].version = "0.16.0-rc.1";

    await assert.rejects(
      checkAgentPluginFreshness({
        server,
        plugin: pluginConfig("0.16.0-rc.1"),
        fetchImpl: successfulFetch(server),
      }),
      /server\.json version must use a stable X\.Y\.Z semver/,
    );
  });

  await t.test("npm package version", async () => {
    const server = serverMetadata();
    server.packages[0].version = "0.16.0-rc.1";

    await assert.rejects(
      checkAgentPluginFreshness({
        server,
        plugin: pluginConfig(),
        fetchImpl: successfulFetch(),
      }),
      /server\.json npm package version must use a stable X\.Y\.Z semver/,
    );
  });

  await t.test("plugin pin", async () => {
    await assert.rejects(
      checkAgentPluginFreshness({
        server: serverMetadata(),
        plugin: pluginConfig("0.16.0-rc.1"),
        fetchImpl: successfulFetch(),
      }),
      /mcp\.json plugin pin must use a stable X\.Y\.Z semver/,
    );
  });

  await t.test("npm latest version", async () => {
    await assert.rejects(
      checkAgentPluginFreshness({
        server: serverMetadata(),
        plugin: pluginConfig(),
        fetchImpl: async () =>
          jsonResponse(200, {
            name: packageName,
            version: "0.16.0-rc.1",
          }),
      }),
      /npm latest version must use a stable X\.Y\.Z semver/,
    );
  });
});

test("rejects prerelease Registry server and npm package versions", async (t) => {
  await t.test("Registry server version", async () => {
    const registry = registryResponse();
    registry.server.version = "0.16.0-rc.1";

    await assert.rejects(
      checkAgentPluginFreshness({
        server: serverMetadata(),
        plugin: pluginConfig(),
        fetchImpl: async (url) =>
          url.endsWith("/latest")
            ? jsonResponse(200, { name: packageName, version: publishedVersion })
            : jsonResponse(200, registry),
      }),
      /Registry server version must use a stable X\.Y\.Z semver/,
    );
  });

  await t.test("Registry npm package version", async () => {
    const registry = registryResponse();
    registry.server.packages[0].version = "0.16.0-rc.1";

    await assert.rejects(
      checkAgentPluginFreshness({
        server: serverMetadata(),
        plugin: pluginConfig(),
        fetchImpl: async (url) =>
          url.endsWith("/latest")
            ? jsonResponse(200, { name: packageName, version: publishedVersion })
            : jsonResponse(200, registry),
      }),
      /Registry npm package version must use a stable X\.Y\.Z semver/,
    );
  });
});

test("rejects npm metadata for another package even at the expected version", async () => {
  await assert.rejects(
    checkAgentPluginFreshness({
      server: serverMetadata(),
      plugin: pluginConfig(),
      fetchImpl: async (url) =>
        url.endsWith("/latest")
          ? jsonResponse(200, { name: "other-package", version: publishedVersion })
          : jsonResponse(200, registryResponse()),
    }),
    /npm latest metadata does not match server\.json: expected @astandrik\/local-ydb-mcp@0\.16\.0/,
  );
});

test("rejects a Registry server with mismatched npm package metadata", async () => {
  const registry = registryResponse();
  registry.server.packages[0].version = "0.15.0";

  await assert.rejects(
    checkAgentPluginFreshness({
      server: serverMetadata(),
      plugin: pluginConfig(),
      fetchImpl: async (url) =>
        url.endsWith("/latest")
          ? jsonResponse(200, { name: packageName, version: publishedVersion })
          : jsonResponse(200, registry),
    }),
    /Registry npm package metadata does not match server\.json/,
  );
});

for (const status of [404, 503]) {
  test(`rejects Registry HTTP ${status}`, async () => {
    await assert.rejects(
      checkAgentPluginFreshness({
        server: serverMetadata(),
        plugin: pluginConfig(),
        fetchImpl: async (url) =>
          url.endsWith("/latest")
            ? jsonResponse(200, { name: packageName, version: publishedVersion })
            : jsonResponse(status, { message: "unavailable" }),
      }),
      new RegExp(`Registry request failed with HTTP ${status}`),
    );
  });
}

test("redacts parser details from invalid JSON errors", async (t) => {
  const sensitiveParserDetail = "Unexpected token '<', \"<html>secret fragment\"";

  for (const target of ["npm", "Registry"]) {
    await t.test(target, async () => {
      await assert.rejects(
        checkAgentPluginFreshness({
          server: serverMetadata(),
          plugin: pluginConfig(),
          fetchImpl: async (url) => {
            if (target === "Registry" && url.endsWith("/latest")) {
              return jsonResponse(200, { name: packageName, version: publishedVersion });
            }
            return {
              status: 200,
              json: async () => {
                throw new SyntaxError(sensitiveParserDetail);
              },
            };
          },
        }),
        (error) => {
          assert.equal(error.message, `${target} returned invalid JSON`);
          assert.doesNotMatch(error.message, /secret fragment|Unexpected token|<html>/);
          return true;
        },
      );
    });
  }
});

test("disables redirects for npm and MCP Registry requests", async () => {
  const redirects = [];

  await checkAgentPluginFreshness({
    server: serverMetadata(),
    plugin: pluginConfig(),
    fetchImpl: async (url, options) => {
      redirects.push(options.redirect);
      return url.endsWith("/latest")
        ? jsonResponse(200, { name: packageName, version: publishedVersion })
        : jsonResponse(200, registryResponse());
    },
  });

  assert.deepEqual(redirects, ["error", "error"]);
});

test("uses a fresh bounded 30-second abort signal for each HTTP request", async () => {
  const timeouts = [];
  const signals = [];

  await checkAgentPluginFreshness({
    server: serverMetadata(),
    plugin: pluginConfig(),
    fetchImpl: async (url, options) => {
      signals.push(options.signal);
      return url.endsWith("/latest")
        ? jsonResponse(200, { name: packageName, version: publishedVersion })
        : jsonResponse(200, registryResponse());
    },
    abortSignalTimeoutImpl: (milliseconds) => {
      timeouts.push(milliseconds);
      return new AbortController().signal;
    },
  });

  assert.deepEqual(timeouts, [30_000, 30_000]);
  assert.notEqual(signals[0], signals[1]);
});
