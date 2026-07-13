import { appendFile, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const DEFAULT_INTERVAL_MS = 15_000;
const SERVER_JSON_URL = new URL("../../server.json", import.meta.url);

export function compareRegistryMetadata(expectedServer, registryResponse) {
  if (!registryResponse || typeof registryResponse !== "object") {
    throw new Error("Registry response must be a JSON object");
  }

  const actualServer = registryResponse.server;
  const expected = normalizeServerMetadata(expectedServer);
  const actual = normalizeServerMetadata(actualServer);

  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      [
        "Registry metadata does not match server.json",
        `Expected: ${JSON.stringify(expected)}`,
        `Actual: ${JSON.stringify(actual)}`,
      ].join("\n"),
    );
  }
}

export async function checkPublication({
  target,
  metadata,
  allowMissing = false,
  waitSeconds = 0,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = fetch,
  sleepImpl = sleep,
  writeOutput = async () => {},
}) {
  validateOptions({ target, metadata, allowMissing, waitSeconds, intervalMs });

  const url = publicationUrl(target, metadata);
  const maxAttempts = waitSeconds > 0
    ? Math.ceil((waitSeconds * 1_000) / intervalMs) + 1
    : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
    });

    if (response.status === 200) {
      const body = await readJsonResponse(response, target);
      verifyPublishedMetadata(target, metadata, body);
      await writeOutput("exists=true");
      return { exists: true };
    }

    if (response.status !== 404) {
      const details = await response.text();
      throw new Error(
        `${targetLabel(target)} request failed with HTTP ${response.status}: ${details}`,
      );
    }

    if (attempt < maxAttempts) {
      await sleepImpl(intervalMs);
      continue;
    }

    if (allowMissing) {
      await writeOutput("exists=false");
      return { exists: false };
    }

    if (waitSeconds > 0) {
      throw new Error(
        `${publicationDescription(target, metadata)} was not found after waiting ${waitSeconds} seconds`,
      );
    }

    throw new Error(`${publicationDescription(target, metadata)} was not found`);
  }

  throw new Error("Publication check exhausted unexpectedly");
}

function normalizeServerMetadata(server) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return server;
  }

  const normalized = structuredClone(server);
  for (const packageMetadata of normalized.packages ?? []) {
    for (const variable of packageMetadata.environmentVariables ?? []) {
      variable.isRequired ??= false;
    }
  }
  return canonicalize(normalized);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "_meta")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, canonicalize(nestedValue)]),
  );
}

function validateOptions({ target, metadata, allowMissing, waitSeconds, intervalMs }) {
  if (target !== "npm" && target !== "registry") {
    throw new Error(`Unknown publication target: ${JSON.stringify(target)}`);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("server.json must contain a JSON object");
  }
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    throw new Error("--wait-seconds must be a non-negative number");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Polling interval must be a positive number");
  }
  if (allowMissing && waitSeconds > 0) {
    throw new Error("--allow-missing and --wait-seconds cannot be combined");
  }

  npmPackage(metadata);
}

function publicationUrl(target, metadata) {
  if (target === "npm") {
    const packageMetadata = npmPackage(metadata);
    return `https://registry.npmjs.org/${encodeURIComponent(packageMetadata.identifier)}/${encodeURIComponent(packageMetadata.version)}`;
  }

  return `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(metadata.name)}/versions/${encodeURIComponent(metadata.version)}`;
}

function npmPackage(metadata) {
  const packages = metadata.packages ?? [];
  const npmPackages = packages.filter(({ registryType }) => registryType === "npm");
  if (npmPackages.length !== 1) {
    throw new Error(`server.json must define exactly one npm package, found ${npmPackages.length}`);
  }

  const packageMetadata = npmPackages[0];
  if (!packageMetadata.identifier || !packageMetadata.version) {
    throw new Error("server.json npm package must define identifier and version");
  }
  if (packageMetadata.version !== metadata.version) {
    throw new Error("server.json package version must match server version");
  }
  return packageMetadata;
}

async function readJsonResponse(response, target) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      `${targetLabel(target)} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function verifyPublishedMetadata(target, metadata, body) {
  if (target === "registry") {
    compareRegistryMetadata(metadata, body);
    return;
  }

  const packageMetadata = npmPackage(metadata);
  if (
    body?.name !== packageMetadata.identifier
    || body?.version !== packageMetadata.version
  ) {
    throw new Error(
      `npm metadata does not match server.json: expected ${packageMetadata.identifier}@${packageMetadata.version}, got ${JSON.stringify({ name: body?.name, version: body?.version })}`,
    );
  }
}

function publicationDescription(target, metadata) {
  if (target === "npm") {
    const packageMetadata = npmPackage(metadata);
    return `npm package ${packageMetadata.identifier}@${packageMetadata.version}`;
  }
  return `Registry server ${metadata.name}@${metadata.version}`;
}

function targetLabel(target) {
  return target === "registry" ? "Registry" : "npm";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseArguments(argv) {
  const [target, ...flags] = argv;
  let allowMissing = false;
  let waitSeconds = 0;

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--allow-missing") {
      allowMissing = true;
      continue;
    }
    if (flag === "--wait-seconds") {
      const value = flags[index + 1];
      if (value === undefined) {
        throw new Error("--wait-seconds requires a value");
      }
      waitSeconds = Number(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }

  return { target, allowMissing, waitSeconds };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const metadata = JSON.parse(await readFile(SERVER_JSON_URL, "utf8"));
  const githubOutput = process.env.GITHUB_OUTPUT;

  const result = await checkPublication({
    ...options,
    metadata,
    writeOutput: async (value) => {
      if (githubOutput) {
        await appendFile(githubOutput, `${value}\n`, "utf8");
      }
    },
  });

  console.log(
    result.exists
      ? `${publicationDescription(options.target, metadata)} exists and matches`
      : `${publicationDescription(options.target, metadata)} is missing`,
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
