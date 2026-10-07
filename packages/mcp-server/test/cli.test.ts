import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const entryPoint = join(repositoryRoot, "packages/mcp-server/dist/index.js");
const environmentMarker = "CLI_ENV_VALUE_MUST_NOT_APPEAR";
const processTimeout = 5_000;
let outsideDirectory: string;
let packageVersion: string;

beforeAll(async () => {
  await promisify(execFile)("npm", ["run", "build", "-w", "@astandrik/local-ydb-mcp"], {
    cwd: repositoryRoot,
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  packageVersion = JSON.parse(await readFile(
    join(repositoryRoot, "packages/mcp-server/package.json"), "utf8",
  )).version;
  outsideDirectory = await mkdtemp(join(tmpdir(), "local-ydb-cli-"));
}, 130_000);

afterAll(async () => {
  if (outsideDirectory) {
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});

describe("MCP CLI", () => {
  it.each(["repository", "outside"])("prints the package version from %s cwd and exits with stdin open", async (location) => {
    const result = await runNode([entryPoint, "--version"], location === "repository" ? repositoryRoot : outsideDirectory);
    expect(result).toEqual({ code: 0, signal: null, timedOut: false, stdout: `${packageVersion}\n`, stderr: "" });
  }, 10_000);

  it.each(["repository", "outside"])("prints help from %s cwd without loading config or starting MCP", async (location) => {
    const result = await runNode([entryPoint, "--help"], location === "repository" ? repositoryRoot : outsideDirectory);
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false, stderr: "" });
    for (const text of ["local-ydb-mcp", "stdio", "Usage:", "--version", "--help", "LOCAL_YDB_TOOLKIT_CONFIG", "LOCAL_YDB_MCP_CONTENT_FORMAT", "absolute", "configPath", "json", "toon"]) {
      expect(result.stdout).toContain(text);
    }
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout).not.toContain(environmentMarker);
    expect(result.stdout).not.toContain(outsideDirectory);
  }, 10_000);

  it.each([
    ["--verison"], ["positional"], ["--help", "--version"], ["--version", "--help"],
    ["--help", "--help"], ["--version", "--version"], ["--help", "extra"], ["--version", "extra"],
    ["-h"], ["-v"],
  ].map((args) => ({ args })))("rejects unsupported arguments $args", async ({ args }) => {
    const result = await runNode([entryPoint, ...args], outsideDirectory);
    expect(result).toMatchObject({ code: 2, signal: null, timedOut: false, stdout: "" });
    expect(result.stderr).toContain("Invalid arguments");
    expect(result.stderr).toContain("--help");
    expect(result.stderr).not.toContain(environmentMarker);
  }, 10_000);

  it("keeps stdio initialization and discovery free of non-protocol stdout", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPoint],
      cwd: outsideDirectory,
      stderr: "pipe",
    });
    const client = new Client({ name: "local-ydb-cli-test", version: "1.0.0" }, { capabilities: {} });
    const protocolErrors: Error[] = [];
    let stderr = "";
    client.onerror = (error) => protocolErrors.push(error);
    transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    try {
      await client.connect(transport, { timeout: processTimeout });
      expect(client.getServerVersion()).toEqual({ name: "local-ydb-toolkit", version: packageVersion });
      const { tools } = await client.listTools(undefined, { timeout: processTimeout });
      const { prompts } = await client.listPrompts(undefined, { timeout: processTimeout });
      expect(tools).toHaveLength(39);
      expect(prompts).toHaveLength(8);
      expect(tools.map((tool) => tool.name)).toContain("local_ydb_inventory");
      expect(prompts.map((prompt) => prompt.name)).toContain("local_ydb_diagnose_stack");
    } finally {
      await client.close();
    }
    expect(protocolErrors).toEqual([]);
    expect(stderr).toBe("");
    expect(transport.pid).toBeNull();
  }, 25_000);

  it("imports the package silently without starting CLI when the caller uses --help", async () => {
    const result = await runNode([
      "--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(entryPoint).href)});`,
      "--", "--help",
    ], outsideDirectory);
    expect(result).toEqual({ code: 0, signal: null, timedOut: false, stdout: "", stderr: "" });
  }, 10_000);
});

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function runNode(args: string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...getDefaultEnvironment(),
        LOCAL_YDB_TOOLKIT_CONFIG: join(outsideDirectory, environmentMarker),
        LOCAL_YDB_MCP_CONTENT_FORMAT: environmentMarker,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, processTimeout);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
    // Keep stdin open: informational commands must exit without waiting for EOF.
  });
}
