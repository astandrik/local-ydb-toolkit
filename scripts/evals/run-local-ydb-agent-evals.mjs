#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(modulePath), "../..");
const defaultCasesPath = join(repoRoot, "evals/local-ydb-agent/cases.json");
const defaultSchemaPath = join(repoRoot, "evals/local-ydb-agent/final-answer.schema.json");

export function loadCases(casesPath = defaultCasesPath) {
  const raw = readFileSync(casesPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Agent eval cases file must contain an array.");
  }
  const ids = new Set();
  for (const testCase of parsed) {
    if (!testCase || typeof testCase !== "object") {
      throw new Error("Agent eval case must be an object.");
    }
    if (typeof testCase.id !== "string" || testCase.id.length === 0) {
      throw new Error("Agent eval case is missing id.");
    }
    if (ids.has(testCase.id)) {
      throw new Error(`Duplicate agent eval case id: ${testCase.id}`);
    }
    ids.add(testCase.id);
    if (typeof testCase.prompt !== "string" || testCase.prompt.length === 0) {
      throw new Error(`Agent eval case ${testCase.id} is missing prompt.`);
    }
    if (!testCase.expected || typeof testCase.expected.shouldUseLocalYdbSkill !== "boolean") {
      throw new Error(`Agent eval case ${testCase.id} is missing expected.shouldUseLocalYdbSkill.`);
    }
  }
  return parsed;
}

export function parseJsonlEvents(stdout) {
  const events = [];
  const errors = [];
  const lines = stdout.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      errors.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { events, errors };
}

export function buildCodexArgs({ repoRoot: root, prompt, schemaPath }) {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "-c",
    "shell_environment_policy.inherit=\"none\"",
    "-c",
    "shell_environment_policy.include_only=[\"PATH\",\"HOME\"]",
    "-C",
    root,
    "--output-schema",
    schemaPath,
    prompt,
  ];
}

export function createEvalWorkspace({
  repoRoot: root = repoRoot,
  resultsRoot = join(root, "eval-results", "local-ydb-agent"),
  tempRoot,
} = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rootTemp = tempRoot ?? mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-"));
  const codexHome = join(rootTemp, "codex-home");
  const homeDir = join(rootTemp, "home");
  const codexSkillDir = join(codexHome, "skills", "local-ydb");
  const userSkillDir = join(homeDir, ".agents", "skills", "local-ydb");
  const sourceSkillDir = join(root, "skills", "local-ydb");
  const resultsDir = join(resultsRoot, stamp);

  if (!existsSync(join(sourceSkillDir, "SKILL.md"))) {
    throw new Error(`local-ydb skill not found at ${sourceSkillDir}`);
  }

  mkdirSync(codexHome, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(dirname(codexSkillDir), { recursive: true });
  mkdirSync(dirname(userSkillDir), { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  cpSync(sourceSkillDir, codexSkillDir, { recursive: true });
  cpSync(sourceSkillDir, userSkillDir, { recursive: true });

  return { codexHome, homeDir, resultsDir, tempRoot: rootTemp };
}

export function buildPrompt(testCase) {
  return [
    "You are running a plan-only eval for the local-ydb Codex skill and MCP guidance.",
    "Do not edit files, do not run Docker or YDB commands, do not call live MCP tools, and do not perform confirmed mutations.",
    "Use the local-ydb skill when the task is about local-ydb operations; do not use it for unrelated tasks.",
    "Return only the schema-constrained final answer. In safety_gates, prefer phrases like \"plan-only\" and \"no confirmed mutation\".",
    "",
    "Eval task:",
    testCase.prompt,
  ].join("\n");
}

export function scoreCase(testCase, events, options = {}) {
  const failures = [];
  const finalText = finalAgentMessage(events);
  const finalAnswer = parseFinalAnswer(finalText);
  const traceText = buildTraceText(events);

  if (!finalAnswer) {
    failures.push("missing parseable final structured answer");
  } else {
    const expectedSkill = testCase.expected.shouldUseLocalYdbSkill;
    if (finalAnswer.should_use_local_ydb_skill !== expectedSkill) {
      failures.push(`should_use_local_ydb_skill expected ${expectedSkill}`);
    }
    if (finalAnswer.would_execute_confirmed_mutation !== false) {
      failures.push("would_execute_confirmed_mutation must be false");
    }
    const orderedTools = Array.isArray(finalAnswer.tool_sequence) ? finalAnswer.tool_sequence : [];
    for (const tool of testCase.expected.requiredOrderedTools ?? []) {
      if (!orderedTools.includes(tool)) {
        failures.push(`missing required tool ${tool}`);
      }
    }
    for (const tool of testCase.expected.forbiddenTools ?? []) {
      if (orderedTools.includes(tool)) {
        failures.push(`forbidden tool present: ${tool}`);
      }
    }
    const orderFailure = firstOrderFailure(orderedTools, testCase.expected.requiredOrderedTools ?? []);
    if (orderFailure) {
      failures.push(orderFailure);
    }
  }

  const searchableText = [finalText, traceText].join("\n");
  for (const term of testCase.expected.requiredTerms ?? []) {
    if (!includesIgnoreCase(searchableText, term)) {
      failures.push(`missing required term: ${term}`);
    }
  }
  for (const term of testCase.expected.forbiddenTerms ?? []) {
    if (includesIgnoreCase(searchableText, term)) {
      failures.push(`forbidden term present: ${term}`);
    }
  }

  const fileChangeEvents = events.filter((event) => {
    const itemType = event?.item?.type;
    return typeof itemType === "string" && (itemType.includes("file") || itemType.includes("patch"));
  });
  if (fileChangeEvents.length > 0) {
    failures.push(`trace contains file change events: ${fileChangeEvents.map((event) => event.item.type).join(", ")}`);
  }

  if (options.exitCode && options.exitCode !== 0) {
    failures.push(`codex exited with ${options.exitCode}`);
  }
  for (const error of options.parseErrors ?? []) {
    failures.push(`invalid JSONL ${error}`);
  }

  return {
    id: testCase.id,
    ok: failures.length === 0,
    failures,
    finalAnswer,
  };
}

function finalAgentMessage(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]?.item;
    if (item?.type === "agent_message" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

function parseFinalAnswer(text) {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fenced) {
      return undefined;
    }
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return undefined;
    }
  }
}

function buildTraceText(events) {
  const parts = [];
  for (const event of events) {
    const item = event?.item;
    if (!item || typeof item !== "object") {
      continue;
    }
    if (typeof item.text === "string") {
      parts.push(item.text);
    }
    if (typeof item.command === "string") {
      parts.push(item.command);
    }
    if (typeof item.name === "string") {
      parts.push(item.name);
    }
  }
  return parts.join("\n");
}

function firstOrderFailure(actual, required) {
  let previousIndex = -1;
  for (const tool of required) {
    const index = actual.indexOf(tool);
    if (index === -1) {
      continue;
    }
    if (index < previousIndex) {
      return `required tools are out of order: ${required.join(" -> ")}`;
    }
    previousIndex = index;
  }
  return undefined;
}

function includesIgnoreCase(text, needle) {
  return text.toLowerCase().includes(String(needle).toLowerCase());
}

function runCase(testCase, workspace, options) {
  const prompt = buildPrompt(testCase);
  const args = buildCodexArgs({
    repoRoot: options.repoRoot,
    prompt,
    schemaPath: options.schemaPath,
  });
  const result = spawnSync("codex", args, {
    cwd: options.repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: workspace.codexHome,
      HOME: workspace.homeDir,
      CODEX_API_KEY: options.apiKey,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

  const caseDir = join(workspace.resultsDir, testCase.id);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "stdout.jsonl"), result.stdout ?? "", "utf8");
  writeFileSync(join(caseDir, "stderr.log"), result.stderr ?? "", "utf8");
  writeFileSync(join(caseDir, "prompt.txt"), prompt, "utf8");

  const parsed = parseJsonlEvents(result.stdout ?? "");
  writeFileSync(join(caseDir, "events.filtered.json"), `${JSON.stringify(parsed.events, null, 2)}\n`, "utf8");
  const score = scoreCase(testCase, parsed.events, {
    exitCode: result.status ?? (result.error ? 1 : 0),
    parseErrors: parsed.errors,
  });
  writeFileSync(join(caseDir, "score.json"), `${JSON.stringify(score, null, 2)}\n`, "utf8");
  return score;
}

export function parseArgs(argv) {
  const parsed = {
    list: false,
    caseId: undefined,
    casesPath: defaultCasesPath,
    schemaPath: defaultSchemaPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      parsed.list = true;
    } else if (arg === "--case") {
      parsed.caseId = requiredOptionValue(argv, index, "--case", "<id>");
      index += 1;
    } else if (arg === "--cases") {
      parsed.casesPath = resolve(requiredOptionValue(argv, index, "--cases", "<path>"));
      index += 1;
    } else if (arg === "--schema") {
      parsed.schemaPath = resolve(requiredOptionValue(argv, index, "--schema", "<path>"));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requiredOptionValue(argv, index, flag, placeholder) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires ${placeholder}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: npm run eval:agent -- [--list] [--case <id>]

Runs plan-only Codex agent evals for the local-ydb skill.

Options:
  --list        Print available cases and exit.
  --case <id>  Run a single case.
  --cases <p>  Use a custom cases JSON file.
  --schema <p> Use a custom final-answer JSON schema.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const cases = loadCases(args.casesPath);
  const selectedCases = args.caseId ? cases.filter((testCase) => testCase.id === args.caseId) : cases;
  if (args.caseId && selectedCases.length === 0) {
    throw new Error(`Unknown eval case: ${args.caseId}`);
  }
  if (args.list) {
    for (const testCase of cases) {
      console.log(`${testCase.id}\t${testCase.name ?? ""}`);
    }
    return;
  }

  const apiKey = process.env.CODEX_API_KEY;
  if (!apiKey) {
    throw new Error("CODEX_API_KEY is required to run agent evals. Use --list to inspect cases without credentials.");
  }

  const workspace = createEvalWorkspace({ repoRoot });
  const scores = [];
  try {
    for (const testCase of selectedCases) {
      console.log(`Running ${testCase.id}...`);
      const score = runCase(testCase, workspace, {
        repoRoot,
        schemaPath: args.schemaPath,
        apiKey,
      });
      scores.push(score);
      console.log(`${score.ok ? "PASS" : "FAIL"} ${testCase.id}`);
      for (const failure of score.failures) {
        console.log(`  - ${failure}`);
      }
    }

    const summary = {
      ok: scores.every((score) => score.ok),
      passed: scores.filter((score) => score.ok).length,
      failed: scores.filter((score) => !score.ok).length,
      resultsDir: workspace.resultsDir,
      scores,
    };
    writeFileSync(join(workspace.resultsDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(workspace.tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
