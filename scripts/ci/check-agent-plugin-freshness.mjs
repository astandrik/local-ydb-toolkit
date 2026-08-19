import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 30_000;
const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";
const stableSemverSource = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)";
const stableSemver = new RegExp(`^${stableSemverSource}$`);
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

  const comparison = compareStableSemver(pluginPin.version, server.version);
  if (comparison < 0) {
    throw new Error(
      `Plugin pin ${pluginPin.spec} is behind published ${npmPackage.identifier}@${server.version}. Run: npm run plugin:pin -- --mcp-version ${server.version} --write`,
    );
  }
  if (comparison > 0) {
    throw new Error(
      `Plugin pin ${pluginPin.spec} is ahead of published ${npmPackage.identifier}@${server.version}. Investigate release consistency and read back the published metadata.`,
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
  assertStableSemver(server.version, "server.json version");

  const npmPackages = Array.isArray(server.packages)
    ? server.packages.filter((entry) => entry?.registryType === "npm")
    : [];
  if (npmPackages.length !== 1) {
    throw new Error(`server.json must define exactly one npm package, found ${npmPackages.length}`);
  }

  const npmPackage = npmPackages[0];
  if (typeof npmPackage.identifier !== "string" || typeof npmPackage.version !== "string") {
    throw new Error("server.json npm package must define identifier and version");
  }
  if (npmPackage.registryBaseUrl !== NPM_REGISTRY_BASE_URL) {
    throw new Error(
      `server.json npm package must use registryBaseUrl ${NPM_REGISTRY_BASE_URL} exactly`,
    );
  }
  assertStableSemver(npmPackage.version, "server.json npm package version");
  if (npmPackage.version !== server.version) {
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
  assertStableSemver(version, "mcp.json plugin pin");

  return { packageName, version, spec: server.args[1] };
}

export function npmLatestUrl(npmPackage) {
  return new URL(
    `${encodeURIComponent(npmPackage.identifier)}/latest`,
    `${NPM_REGISTRY_BASE_URL}/`,
  ).href;
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
    redirect: "error",
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
  } catch {
    throw new Error(`${target} returned invalid JSON`);
  }
}

export function verifyNpmLatest(metadata, npmPackage, expectedVersion) {
  assertStableSemver(metadata.version, "npm latest version");
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
  assertStableSemver(registryServer.version, "Registry server version");
  if (registryServer.name !== server.name || registryServer.version !== server.version) {
    throw new Error("Registry server identity or version does not match server.json");
  }

  const registryNpmPackages = Array.isArray(registryServer.packages)
    ? registryServer.packages.filter((entry) => entry?.registryType === "npm")
    : [];
  if (
    registryNpmPackages.length !== 1
    || typeof registryNpmPackages[0].identifier !== "string"
    || typeof registryNpmPackages[0].version !== "string"
  ) {
    throw new Error("Registry npm package metadata does not match server.json");
  }
  assertStableSemver(registryNpmPackages[0].version, "Registry npm package version");
  if (
    registryNpmPackages[0].identifier !== npmPackage.identifier
    || registryNpmPackages[0].version !== npmPackage.version
  ) {
    throw new Error("Registry npm package metadata does not match server.json");
  }
}

export function compareStableSemver(left, right) {
  const leftParts = parseStableSemver(left);
  const rightParts = parseStableSemver(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return compareNumericIdentifiers(leftParts[index], rightParts[index]);
    }
  }
  return 0;
}

export function assertStableSemver(version, label) {
  if (typeof version !== "string" || !stableSemver.test(version)) {
    throw new Error(`${label} must use a stable X.Y.Z semver`);
  }
}

function parseStableSemver(version) {
  assertStableSemver(version, "version");
  return version.split(".");
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  return left < right ? -1 : 1;
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
