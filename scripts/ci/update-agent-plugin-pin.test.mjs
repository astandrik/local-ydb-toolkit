import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const trackedFiles = [
  "plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "mcp.json",
  ".mcp.json",
  "gemini-extension.json",
  "README.md",
  "docs/openai-plugin-submission.md",
];

test("rejects invalid and prerelease MCP versions without changing files", async (t) => {
  for (const version of ["0.16", "0.16.0-rc.1"]) {
    await t.test(version, async () => {
      const fixture = await createFixture();
      try {
        const before = await snapshot(fixture);
        const result = runUpdater(fixture, ["--mcp-version", version, "--write"]);

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /stable X\.Y\.Z/i);
        assert.deepEqual(await snapshot(fixture), before);
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    });
  }
});

test("rejects a lower MCP version without changing files", async () => {
  const fixture = await createFixture();
  try {
    const before = await snapshot(fixture);
    const result = runUpdater(fixture, ["--mcp-version", "0.15.3", "--write"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lower than the current MCP version/i);
    assert.deepEqual(await snapshot(fixture), before);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("reports a higher MCP pin without writing during a dry run", async () => {
  const fixture = await createFixture();
  try {
    const before = await snapshot(fixture);
    const result = runUpdater(fixture, ["--mcp-version", "0.16.0"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would update/i);
    assert.match(result.stdout, /0\.15\.4.*0\.16\.0/s);
    assert.match(result.stdout, /0\.1\.1.*0\.1\.2/s);
    assert.deepEqual(await snapshot(fixture), before);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("updates every plugin surface to the exact higher MCP pin", async () => {
  const fixture = await createFixture();
  try {
    const result = runUpdater(fixture, ["--mcp-version", "0.16.0", "--write"]);
    assert.equal(result.status, 0, result.stderr);

    for (const path of [
      "plugin.json",
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      "gemini-extension.json",
    ]) {
      assert.equal((await readJson(fixture, path)).version, "0.1.2", path);
    }

    for (const path of ["mcp.json", ".mcp.json", "gemini-extension.json"]) {
      const manifest = await readJson(fixture, path);
      assert.deepEqual(manifest.mcpServers["local-ydb"].args, [
        "--yes",
        "@astandrik/local-ydb-mcp@0.16.0",
      ]);
    }

    const readme = await readFile(join(fixture, "README.md"), "utf8");
    assert.match(readme, /pinned `@astandrik\/local-ydb-mcp@0\.16\.0` package/);
    assert.match(readme, /Plugin `0\.1\.2` pins `@astandrik\/local-ydb-mcp@0\.16\.0`\./);
    assert.match(readme, /dist\/local-ydb-toolkit-0\.1\.2-skills\.zip/);
    const submission = await readFile(join(fixture, "docs/openai-plugin-submission.md"), "utf8");
    assert.match(submission, /^- Version: `0\.1\.2`$/m);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("does not increment the plugin version when the MCP pin already matches", async () => {
  const fixture = await createFixture();
  try {
    assert.equal(
      runUpdater(fixture, ["--mcp-version", "0.16.0", "--write"]).status,
      0,
    );
    const before = await snapshot(fixture);
    const result = runUpdater(fixture, ["--mcp-version", "0.16.0", "--write"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already pins/i);
    assert.deepEqual(await snapshot(fixture), before);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("compares and increments large stable semver identifiers exactly", async () => {
  const fixture = await createFixture();
  try {
    await seedRelease(fixture, {
      pluginVersion: "0.1.9007199254740992",
      mcpVersion: "9007199254740992.0.0",
    });
    const targetMcpVersion = "9007199254740993.0.0";
    const result = runUpdater(fixture, ["--mcp-version", targetMcpVersion, "--write"]);

    assert.equal(result.status, 0, result.stderr);
    for (const path of [
      "plugin.json",
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      "gemini-extension.json",
    ]) {
      assert.equal((await readJson(fixture, path)).version, "0.1.9007199254740993", path);
    }
    for (const path of ["mcp.json", ".mcp.json", "gemini-extension.json"]) {
      const manifest = await readJson(fixture, path);
      assert.equal(
        manifest.mcpServers["local-ydb"].args[1],
        `@astandrik/local-ydb-mcp@${targetMcpVersion}`,
      );
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function createFixture() {
  const fixture = await mkdtemp(join(tmpdir(), "local-ydb-plugin-pin-test-"));
  await Promise.all(
    [...trackedFiles, "scripts/ci/update-agent-plugin-pin.mjs"].map((path) =>
      cp(join(repositoryRoot, path), join(fixture, path), { recursive: true }),
    ),
  );
  await seedPriorRelease(fixture);
  return fixture;
}

async function seedPriorRelease(fixture) {
  await seedRelease(fixture, { pluginVersion: "0.1.1", mcpVersion: "0.15.4" });
}

async function seedRelease(fixture, { pluginVersion, mcpVersion }) {
  const currentPluginVersion = (await readJson(fixture, "plugin.json")).version;
  const currentMcpVersion = (await readJson(fixture, "mcp.json")).mcpServers["local-ydb"].args[1].slice(
    "@astandrik/local-ydb-mcp@".length,
  );
  for (const path of [
    "plugin.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    "gemini-extension.json",
  ]) {
    const manifest = await readJson(fixture, path);
    manifest.version = pluginVersion;
    await writeJson(fixture, path, manifest);
  }
  for (const path of ["mcp.json", ".mcp.json", "gemini-extension.json"]) {
    const manifest = await readJson(fixture, path);
    manifest.mcpServers["local-ydb"].args[1] = `@astandrik/local-ydb-mcp@${mcpVersion}`;
    await writeJson(fixture, path, manifest);
  }

  await writeFile(
    join(fixture, "README.md"),
    (await readFile(join(fixture, "README.md"), "utf8"))
      .replace(
        `pinned \`@astandrik/local-ydb-mcp@${currentMcpVersion}\` package`,
        `pinned \`@astandrik/local-ydb-mcp@${mcpVersion}\` package`,
      )
      .replace(
        `Plugin \`${currentPluginVersion}\` pins \`@astandrik/local-ydb-mcp@${currentMcpVersion}\`.`,
        `Plugin \`${pluginVersion}\` pins \`@astandrik/local-ydb-mcp@${mcpVersion}\`.`,
      )
      .replace(
        `dist/local-ydb-toolkit-${currentPluginVersion}-skills.zip`,
        `dist/local-ydb-toolkit-${pluginVersion}-skills.zip`,
      ),
    "utf8",
  );
  await writeFile(
    join(fixture, "docs/openai-plugin-submission.md"),
    (await readFile(join(fixture, "docs/openai-plugin-submission.md"), "utf8")).replace(
      `- Version: \`${currentPluginVersion}\``,
      `- Version: \`${pluginVersion}\``,
    ),
    "utf8",
  );
}

function runUpdater(fixture, args) {
  return spawnSync(process.execPath, [join(fixture, "scripts/ci/update-agent-plugin-pin.mjs"), ...args], {
    cwd: fixture,
    encoding: "utf8",
  });
}

async function snapshot(root) {
  return Object.fromEntries(
    await Promise.all(
      trackedFiles.map(async (path) => [path, await readFile(join(root, path), "utf8")]),
    ),
  );
}

async function readJson(root, path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function writeJson(root, path, value) {
  await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
