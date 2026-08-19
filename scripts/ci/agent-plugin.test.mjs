import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schemaRoot = join(repositoryRoot, "schemas", "agent-plugins", "1.0.0");
const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
const portableManifest = await readJson("plugin.json");
const legacyManifest = await readJson(".codex-plugin/plugin.json");
const claudeManifest = await readJson(".claude-plugin/plugin.json");
const geminiManifest = await readJson("gemini-extension.json");
const portableMcp = await readJson("mcp.json");
const legacyMcp = await readJson(".mcp.json");
const marketplace = await readJson(".agents/plugins/marketplace.json");
const pluginSchema = await readJson("schemas/agent-plugins/1.0.0/plugin.schema.json");
const mcpSchema = await readJson("schemas/agent-plugins/1.0.0/mcp.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validatePlugin = ajv.compile(pluginSchema);
const validateMcp = ajv.compile(mcpSchema);

test("vendored Agent Plugins schemas match their canonical checksums", async () => {
  const checksumLines = (await readFile(join(schemaRoot, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n");
  assert.equal(checksumLines.length, 2);

  for (const line of checksumLines) {
    const [expected, file] = line.split(/\s+/, 2);
    const contents = await readFile(join(schemaRoot, file));
    assert.equal(createHash("sha256").update(contents).digest("hex"), expected);
  }
});

test("portable and Codex manifests expose identical plugin metadata", async () => {
  assertSchema(validatePlugin, portableManifest, "plugin.json");
  assert.deepEqual(portableMetadata(portableManifest), legacyMetadata(legacyManifest));
  assert.equal(portableManifest.name, "local-ydb-toolkit");
  assertStableSemver(portableManifest.version, "plugin.json version");
  assert.equal(legacyManifest.skills, "./skills/");
  assert.equal(legacyManifest.mcpServers, "./.mcp.json");

  const pluginInterface = legacyManifest.interface;
  assert.equal(pluginInterface.displayName, "Local YDB Toolkit");
  assert.equal(pluginInterface.shortDescription, "Operate local YDB safely");
  assert(pluginInterface.displayName.length <= 30);
  assert(pluginInterface.shortDescription.length <= 30);
  assert(pluginInterface.longDescription.length <= 4_000);
  assert(pluginInterface.developerName.length <= 80);
  assert.equal(pluginInterface.category, "Developer Tools");
  assert.equal(pluginInterface.defaultPrompt.length, 3);
  assert.equal(new Set(pluginInterface.defaultPrompt).size, 3);
  assert(pluginInterface.defaultPrompt.every((prompt) => prompt.length <= 128 && !prompt.includes("@")));
  assert.equal("screenshots" in pluginInterface, false);

  for (const path of [
    "assets/icon.svg",
    "skills/local-ydb/SKILL.md",
    "skills/local-ydb/agents/openai.yaml",
  ]) {
    assert((await stat(join(repositoryRoot, path))).isFile(), `Missing plugin file: ${path}`);
  }

  const serializedConfig = JSON.stringify({
    portableManifest,
    legacyManifest,
    claudeManifest,
    geminiManifest,
    portableMcp,
    legacyMcp,
  });
  assert.doesNotMatch(serializedConfig, /\/(?:Users|home)\//);
  assert.doesNotMatch(serializedConfig, /"(?:password|secret|token|api[_-]?key)"\s*:/i);
});

test("plugin surfaces use aligned stable versions and the exact pinned package shape", () => {
  assertSchema(validateMcp, portableMcp, "mcp.json");
  const pluginVersion = portableManifest.version;
  const packageSpec = packageSpecFrom(portableMcp.mcpServers["local-ydb"]);
  const mcpVersion = packageSpec.slice(`${packageName}@`.length);

  for (const [label, version] of [
    ["portable manifest", portableManifest.version],
    ["Codex manifest", legacyManifest.version],
    ["Claude manifest", claudeManifest.version],
    ["Gemini extension", geminiManifest.version],
  ]) {
    assertStableSemver(version, `${label} version`);
    assert.equal(version, pluginVersion, `${label} version must align`);
  }
  assertStableSemver(mcpVersion, "pinned MCP version");
  assert.deepEqual(Object.keys(portableMcp.mcpServers), ["local-ydb"]);
  assert.deepEqual(Object.keys(legacyMcp.mcpServers), ["local-ydb"]);

  const { type, ...portableServer } = portableMcp.mcpServers["local-ydb"];
  assert.equal(type, "stdio");
  assert.deepEqual(portableServer, legacyMcp.mcpServers["local-ydb"]);
  assert.equal(portableServer.command, "npx");
  assert.deepEqual(portableServer.args, ["--yes", packageSpec]);
  assert.equal("env" in portableServer, false);
  assert.doesNotMatch(portableServer.args.join(" "), /@latest|[~^*]/);
});

test("Claude manifest mirrors portable metadata and uses default component locations", async () => {
  assert.deepEqual(coreMetadata(claudeManifest), coreMetadata(portableManifest));
  assert.equal("displayName" in claudeManifest, false);
  assert.equal("skills" in claudeManifest, false);
  assert.equal("mcpServers" in claudeManifest, false);
  assert((await stat(join(repositoryRoot, "skills", "local-ydb", "SKILL.md"))).isFile());
  assert((await stat(join(repositoryRoot, ".mcp.json"))).isFile());
});

test("Gemini extension mirrors portable metadata and the pinned local MCP", async () => {
  assert.deepEqual(
    {
      name: geminiManifest.name,
      version: geminiManifest.version,
      description: geminiManifest.description,
    },
    {
      name: portableManifest.name,
      version: portableManifest.version,
      description: portableManifest.description,
    },
  );

  assert.deepEqual(Object.keys(geminiManifest.mcpServers), ["local-ydb"]);
  const { cwd, ...geminiServer } = geminiManifest.mcpServers["local-ydb"];
  assert.equal(cwd, "${extensionPath}");
  assert.deepEqual(geminiServer, legacyMcp.mcpServers["local-ydb"]);
  assert.deepEqual(geminiServer.args, ["--yes", packageSpecFrom(portableMcp.mcpServers["local-ydb"])]);
  assert.doesNotMatch(geminiServer.args.join(" "), /@latest|[~^*]/);
  assert.equal("env" in geminiServer, false);

  assert.deepEqual(geminiManifest.settings, [
    {
      name: "Local YDB Toolkit config path",
      description:
        "Optional absolute path to a local-ydb-toolkit config JSON file. Leave blank to pass configPath on individual tool calls.",
      envVar: "LOCAL_YDB_TOOLKIT_CONFIG",
      sensitive: false,
    },
    {
      name: "MCP response text format",
      description:
        "Optional response text format: json or toon. Leave blank for the server default.",
      envVar: "LOCAL_YDB_MCP_CONTENT_FORMAT",
      sensitive: false,
    },
  ]);
  assert((await stat(join(repositoryRoot, "skills", "local-ydb", "SKILL.md"))).isFile());
});

test("Gemini and Antigravity documentation preserves the supported install paths", () => {
  assert(
    readme.includes(
      "gemini extensions install https://github.com/astandrik/local-ydb-toolkit --ref=main --auto-update",
    ),
  );
  assert(readme.includes("agy plugin import gemini"));
  assert(
    readme.includes(
      "The repository is not listed in the Gemini extension gallery until the owner adds the `gemini-cli-extension` GitHub topic",
    ),
  );
});

test("repo marketplace exposes the plugin root with explicit policy", () => {
  assert.equal(marketplace.name, "local-ydb-toolkit");
  assert.equal(marketplace.interface.displayName, "Local YDB Toolkit");
  assert.equal(marketplace.plugins.length, 1);
  assert.deepEqual(marketplace.plugins[0], {
    name: "local-ydb-toolkit",
    source: { source: "local", path: "./" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  });
});

test("submission materials contain exactly five positive and three negative cases", async () => {
  const submission = await readFile(
    join(repositoryRoot, "docs", "openai-plugin-submission.md"),
    "utf8",
  );
  const privacyPolicyUrl = "https://local-ydb-toolkit.ydb-qdrant.tech/privacy";
  const termsOfUseUrl = "https://local-ydb-toolkit.ydb-qdrant.tech/terms";

  assert.equal(submission.match(/^### Positive \d+:/gm)?.length, 5);
  assert.equal(submission.match(/^### Negative \d+:/gm)?.length, 3);
  assert.match(submission, /^Status: ready for portal draft; not submitted for review\.$/m);
  assert.match(submission, /^- Publisher: `astandrik`$/m);
  assert.match(submission, /^- Submission type: `Skills only`$/m);
  assert.match(
    submission,
    new RegExp(`^- Version: \`${escapeRegex(portableManifest.version)}\`$`, "m"),
  );
  assert.match(
    submission,
    /^- Availability: all countries and regions supported by OpenAI$/m,
  );
  const submissionLines = submission.split(/\r?\n/);
  assert(submissionLines.includes(`- Privacy policy: \`${privacyPolicyUrl}\``));
  assert(submissionLines.includes(`- Terms of use: \`${termsOfUseUrl}\``));
  assert.equal(new URL(privacyPolicyUrl).protocol, "https:");
  assert.equal(new URL(termsOfUseUrl).protocol, "https:");
  assert.match(submission, /Apps Management: Write/);
  assert.match(submission, /verified developer identity is exactly `astandrik`/);
  assert.doesNotMatch(submission, /^Status:\s*(?:approved|published|submitted)\b/im);
  assert.doesNotMatch(submission, /approved by OpenAI/i);
  assert.doesNotMatch(
    submission,
    /(?:published|available) (?:on|in) (?:the )?(?:public )?OpenAI marketplace/i,
  );
  assert.match(
    readme,
    new RegExp(
      `Plugin \`${escapeRegex(portableManifest.version)}\` pins \`${escapeRegex(packageSpecFrom(portableMcp.mcpServers["local-ydb"]))}\`\\.`,
    ),
  );
  assert.match(
    readme,
    new RegExp(
      `dist/local-ydb-toolkit-${escapeRegex(portableManifest.version)}-skills\\.zip`,
    ),
  );
});

test("plugin packager rejects custom output paths without touching them", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "local-ydb-plugin-output-test-"));
  const externalArchive = join(temporaryRoot, "outside-repository.zip");
  const sentinel = "do not overwrite\n";

  try {
    await writeFile(externalArchive, sentinel, "utf8");
    assert.throws(() => packagePlugin(["--output", externalArchive]));
    assert.equal(await readFile(externalArchive, "utf8"), sentinel);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("skills-only ZIP is deterministic, contained, and excludes MCP", { timeout: 30_000 }, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "local-ydb-plugin-test-"));
  const archive = join(
    repositoryRoot,
    "dist",
    `${portableManifest.name}-${portableManifest.version}-skills.zip`,
  );
  const extractedRoot = join(temporaryRoot, "extracted");

  try {
    packagePlugin();
    const firstContents = await readFile(archive);
    packagePlugin();
    const secondContents = await readFile(archive);
    assert.deepEqual(firstContents, secondContents);
    assert(firstContents.byteLength < 100 * 1024 * 1024);

    const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
      .trim()
      .split("\n");
    assert.deepEqual(entries, [...entries].sort());
    assert(entries.includes("plugin.json"));
    assert(entries.includes(".codex-plugin/plugin.json"));
    assert(entries.includes("assets/icon.svg"));
    assert(entries.includes("skills/local-ydb/SKILL.md"));
    assert(entries.includes("LICENSE"));
    assert(!entries.includes("mcp.json"));
    assert(!entries.includes(".mcp.json"));
    assert(!entries.includes("gemini-extension.json"));
    assert(entries.every((entry) => !entry.endsWith("/.gitkeep")));

    for (const entry of entries) {
      assert(!entry.startsWith("/"), `Archive entry must be relative: ${entry}`);
      assert(!entry.split("/").includes(".."), `Archive entry escapes plugin root: ${entry}`);
      assert(
        entry === "plugin.json" ||
          entry === ".codex-plugin/plugin.json" ||
          entry === "assets/icon.svg" ||
          entry === "LICENSE" ||
          entry.startsWith("skills/local-ydb/"),
        `Unexpected archive entry: ${entry}`,
      );
    }

    execFileSync("unzip", ["-qq", archive, "-d", extractedRoot]);
    await assertNoSymlinks(extractedRoot);
    const publicPortableManifest = await readJsonFrom(
      join(extractedRoot, "plugin.json"),
    );
    const publicLegacyManifest = await readJsonFrom(
      join(extractedRoot, ".codex-plugin", "plugin.json"),
    );
    assertSchema(validatePlugin, publicPortableManifest, "public plugin.json");
    assert.equal("mcpServers" in publicLegacyManifest, false);
    assert.equal("screenshots" in publicLegacyManifest.interface, false);
    assert.deepEqual(
      portableMetadata(publicPortableManifest),
      legacyMetadata(publicLegacyManifest),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function portableMetadata(manifest) {
  return commonMetadata(manifest, manifest.extensions["com.openai"].interface);
}

function legacyMetadata(manifest) {
  return commonMetadata(manifest, manifest.interface);
}

function commonMetadata(manifest, pluginInterface) {
  return {
    ...coreMetadata(manifest),
    interface: pluginInterface,
  };
}

function coreMetadata(manifest) {
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage,
    repository: manifest.repository,
    license: manifest.license,
    keywords: manifest.keywords,
  };
}

function assertSchema(validate, value, label) {
  assert(validate(value), `${label} schema errors: ${JSON.stringify(validate.errors)}`);
}

const packageName = "@astandrik/local-ydb-mcp";
const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function packageSpecFrom(server) {
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args.slice(0, 1), ["--yes"]);
  assert.equal(server.args.length, 2);
  const packageSpec = server.args[1];
  assert(packageSpec.startsWith(`${packageName}@`));
  assertStableSemver(packageSpec.slice(`${packageName}@`.length), "pinned MCP version");
  return packageSpec;
}

function assertStableSemver(version, label) {
  assert.match(version, stableSemver, `${label} must be a stable X.Y.Z semver`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function packagePlugin(args = []) {
  execFileSync(
    process.execPath,
    [join(repositoryRoot, "scripts", "package-agent-plugin.mjs"), ...args],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
}

async function assertNoSymlinks(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const entryStat = await lstat(path);
    assert(!entryStat.isSymbolicLink(), `Archive contains symlink: ${path}`);
    if (entryStat.isDirectory()) {
      await assertNoSymlinks(path);
    }
  }
}

async function readJson(path) {
  return readJsonFrom(join(repositoryRoot, path));
}

async function readJsonFrom(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
