import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 30_000;
const SERVER_JSON_URL = new URL("../../server.json", import.meta.url);
const PLUGIN_MCP_URL = new URL("../../mcp.json", import.meta.url);

export async function checkAgentPluginFreshness({
  server,
  plugin,
  fetchImpl = fetch,
  abortSignalTimeoutImpl = AbortSignal.timeout,
}) {
  const npmPackage = npmPackageFromServer(server);
  const pluginPin = pluginPinFromConfig(plugin, npmPackage.identifier);
  const npmUrl = npmLatestUrl(npmPackage);
  const registryUrl = registryVersionUrl(server);

  const npmMetadata = await fetchJson(npmUrl, "npm", {
    fetchImpl,
    abortSignalTimeoutImpl,
  });
  verifyNpmLatest(npmMetadata, npmPackage, server.version);

  const registryMetadata = await fetchJson(registryUrl, "Registry", {
    fetchImpl,
    abortSignalTimeoutImpl,
  });
  verifyRegistryVersion(registryMetadata, server, npmPackage);

  if (pluginPin.version !== server.version) {
    throw new Error(
      `Plugin pin ${pluginPin.spec} is behind published ${npmPackage.identifier}@${server.version}. Run: npm run plugin:pin -- --mcp-version ${server.version} --write`,
    );
  }

  return {
    packageName: npmPackage.identifier,
    pluginVersion: pluginPin.version,
    publishedVersion: server.version,
  };
}

export async function loadFreshnessInputs({
  readFileImpl = readFile,
  serverUrl = SERVER_JSON_URL,
  pluginUrl = PLUGIN_MCP_URL,
} = {}) {
  const [serverText, pluginText] = await Promise.all([
    readFileImpl(serverUrl, "utf8"),
    readFileImpl(pluginUrl, "utf8"),
  ]);

  return {
    server: parseJson(serverText, "server.json"),
    plugin: parseJson(pluginText, "mcp.json"),
  };
}

export function npmPackageFromServer(server) {
  if (!isObject(server) || typeof server.name !== "string" || typeof server.version !== "string") {
    throw new Error("server.json must contain server name and version strings");
  }

  const npmPackages = Array.isArray(server.packages)
    ? server.packages.filter((entry) => entry?.registryType === "npm")
    : [];
  if (npmPackages.length !== 1) {
    throw new Error(`server.json must define exactly one npm package, found ${npmPackages.length}`);
  }

  const npmPackage = npmPackages[0];
  if (
    typeof npmPackage.identifier !== "string"
    || typeof npmPackage.version !== "string"
    || npmPackage.version !== server.version
  ) {
    throw new Error("server.json npm package must match the server version");
  }
  return npmPackage;
}

export function pluginPinFromConfig(plugin, expectedPackageName) {
  const server = plugin?.mcpServers?.["local-ydb"];
  if (
    !isObject(server)
    || server.command !== "npx"
    || !Array.isArray(server.args)
    || server.args.length !== 2
    || server.args[0] !== "--yes"
    || typeof server.args[1] !== "string"
  ) {
    throw new Error("mcp.json must contain the exact local-ydb npx package shape");
  }

  const separator = server.args[1].lastIndexOf("@");
  const packageName = server.args[1].slice(0, separator);
  const version = server.args[1].slice(separator + 1);
  if (!packageName || !version || packageName !== expectedPackageName) {
    throw new Error(`mcp.json must pin ${expectedPackageName} exactly`);
  }

  return { packageName, version, spec: server.args[1] };
}

export function npmLatestUrl(npmPackage) {
  const baseUrl = typeof npmPackage.registryBaseUrl === "string"
    ? npmPackage.registryBaseUrl
    : "https://registry.npmjs.org";
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(npmPackage.identifier)}/latest`;
}

export function registryVersionUrl(server) {
  if (!isObject(server) || typeof server.name !== "string" || typeof server.version !== "string") {
    throw new Error("server.json must contain server name and version strings");
  }
  return `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`;
}

export async function fetchJson(url, target, {
  fetchImpl = fetch,
  abortSignalTimeoutImpl = AbortSignal.timeout,
} = {}) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: abortSignalTimeoutImpl(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error(`${target} request failed with HTTP ${response.status}`);
  }

  try {
    const body = await response.json();
    if (!isObject(body)) {
      throw new Error("response must be a JSON object");
    }
    return body;
  } catch (error) {
    throw new Error(
      `${target} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function verifyNpmLatest(metadata, npmPackage, expectedVersion) {
  if (
    metadata.name !== npmPackage.identifier
    || metadata.version !== expectedVersion
  ) {
    throw new Error(
      `npm latest metadata does not match server.json: expected ${npmPackage.identifier}@${expectedVersion}`,
    );
  }
}

export function verifyRegistryVersion(metadata, server, npmPackage) {
  const registryServer = metadata.server;
  if (!isObject(registryServer)) {
    throw new Error("Registry response must contain a server JSON object");
  }
  if (registryServer.name !== server.name || registryServer.version !== server.version) {
    throw new Error("Registry server identity or version does not match server.json");
  }

  const registryNpmPackages = Array.isArray(registryServer.packages)
    ? registryServer.packages.filter((entry) => entry?.registryType === "npm")
    : [];
  if (
    registryNpmPackages.length !== 1
    || registryNpmPackages[0].identifier !== npmPackage.identifier
    || registryNpmPackages[0].version !== npmPackage.version
  ) {
    throw new Error("Registry npm package metadata does not match server.json");
  }
}

function parseJson(contents, label) {
  try {
    const value = JSON.parse(contents);
    if (!isObject(value)) {
      throw new Error("must be a JSON object");
    }
    return value;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main() {
  const inputs = await loadFreshnessInputs();
  const result = await checkAgentPluginFreshness(inputs);
  console.log(
    `Agent plugin pin ${result.packageName}@${result.pluginVersion} matches published ${result.publishedVersion}.`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entryPoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
