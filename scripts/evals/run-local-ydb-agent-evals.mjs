#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
export const defaultCaseTimeoutMs = 5 * 60 * 1000;
const caseIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const optionalStringArrayFields = [
  "requiredOrderedTools",
  "allowedExtraTools",
  "forbiddenTools",
  "forbiddenToolPrefixes",
  "requiredTerms",
  "forbiddenTerms",
];
const finalAnswerFields = new Map([
  ["should_use_local_ydb_skill", "boolean"],
  ["task_type", "string"],
  ["tool_sequence", "array:string"],
  ["safety_gates", "array:string"],
  ["would_execute_confirmed_mutation", "boolean"],
  ["answer", "string"],
]);
export function loadCases(casesPath = defaultCasesPath) {
  const raw = readFileSync(casesPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Agent eval cases file must contain an array.");
  }
  if (parsed.length === 0) {
    throw new Error("Agent eval cases file must contain at least one case.");
  }
  const ids = new Set();
  for (const testCase of parsed) {
    if (!testCase || typeof testCase !== "object") {
      throw new Error("Agent eval case must be an object.");
    }
    if (typeof testCase.id !== "string" || testCase.id.length === 0) {
      throw new Error("Agent eval case is missing id.");
    }
    if (!caseIdPattern.test(testCase.id)) {
      throw new Error(`Agent eval case id must be a safe slug: ${testCase.id}`);
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
    for (const field of optionalStringArrayFields) {
      assertOptionalStringArray(testCase, field);
    }
    assertOptionalStringMap(testCase, "allowedExtraToolsBefore");
  }
  return parsed;
}

function assertOptionalStringArray(testCase, field) {
  const value = testCase.expected[field];
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`Agent eval case ${testCase.id} expected.${field} must be an array of non-empty strings.`);
  }
}

function assertOptionalStringMap(testCase, field) {
  const value = testCase.expected[field];
  if (value === undefined) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent eval case ${testCase.id} expected.${field} must be an object of string values.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || typeof item !== "string" || item.length === 0) {
      throw new Error(`Agent eval case ${testCase.id} expected.${field} must be an object of string values.`);
    }
  }
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
    "--ignore-rules",
    "--skip-git-repo-check",
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
  schemaPath,
  resultsRoot = join(root, "eval-results", "local-ydb-agent"),
  tempRoot,
} = {}) {
  const resolvedSchemaPath = schemaPath ?? join(root, "evals/local-ydb-agent/final-answer.schema.json");
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const rootTemp = tempRoot ?? mkdtempSync(join(tmpdir(), "local-ydb-agent-evals-"));
  const ownsTempRoot = tempRoot === undefined;
  const checkoutRoot = join(rootTemp, "checkout");
  const codexHome = join(rootTemp, "codex-home");
  const homeDir = join(rootTemp, "home");
  const codexSkillDir = join(codexHome, "skills", "local-ydb");
  const userSkillDir = join(homeDir, ".agents", "skills", "local-ydb");
  const checkoutSkillDir = join(checkoutRoot, "skills", "local-ydb");
  const checkoutEvalDir = join(checkoutRoot, "evals", "local-ydb-agent");
  const sourceSkillDir = join(root, "skills", "local-ydb");
  const resultsDir = join(resultsRoot, stamp);
  const workspaceSchemaPath = join(checkoutEvalDir, "final-answer.schema.json");

  try {
    if (!existsSync(join(sourceSkillDir, "SKILL.md"))) {
      throw new Error(`local-ydb skill not found at ${sourceSkillDir}`);
    }
    if (!existsSync(resolvedSchemaPath)) {
      throw new Error(`final-answer schema not found at ${resolvedSchemaPath}`);
    }

    mkdirSync(codexHome, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(dirname(codexSkillDir), { recursive: true });
    mkdirSync(dirname(userSkillDir), { recursive: true });
    mkdirSync(dirname(checkoutSkillDir), { recursive: true });
    mkdirSync(checkoutEvalDir, { recursive: true });
    mkdirSync(resultsDir, { recursive: true });
    cpSync(sourceSkillDir, codexSkillDir, { recursive: true });
    cpSync(sourceSkillDir, userSkillDir, { recursive: true });
    cpSync(sourceSkillDir, checkoutSkillDir, { recursive: true });
    cpSync(resolvedSchemaPath, workspaceSchemaPath);

    return { codexHome, homeDir, repoRoot: checkoutRoot, schemaPath: workspaceSchemaPath, resultsDir, tempRoot: rootTemp };
  } catch (error) {
    rmSync(resultsDir, { recursive: true, force: true });
    if (ownsTempRoot) {
      rmSync(rootTemp, { recursive: true, force: true });
    }
    throw error;
  }
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

  if (!finalAnswer) {
    failures.push("missing parseable final structured answer");
  } else {
    failures.push(...validateFinalAnswerShape(finalAnswer));
    const expectedSkill = testCase.expected.shouldUseLocalYdbSkill;
    if (finalAnswer.should_use_local_ydb_skill !== expectedSkill) {
      failures.push(`should_use_local_ydb_skill expected ${expectedSkill}`);
    }
    if (finalAnswer.would_execute_confirmed_mutation !== false) {
      failures.push("would_execute_confirmed_mutation must be false");
    }
    const orderedTools = Array.isArray(finalAnswer.tool_sequence)
      ? finalAnswer.tool_sequence.filter((tool) => typeof tool === "string")
      : [];
    const answerText = finalAnswerTextFields(finalAnswer).join("\n");
    const guidanceText = finalAnswerGuidanceText(finalAnswer);

    if (!expectedSkill && orderedTools.some((tool) => tool.startsWith("local_ydb_"))) {
      failures.push("negative control must not include local-ydb tools");
    }
    if (!expectedSkill && containsForbiddenToolPrefix(answerText, "local_ydb_")) {
      failures.push("negative control must not mention local-ydb tools");
    }
    if (expectedSkill) {
      const allowedTools = new Set([
        ...(testCase.expected.requiredOrderedTools ?? []),
        ...(testCase.expected.allowedExtraTools ?? []),
      ]);
      for (const tool of orderedTools) {
        if (!allowedTools.has(tool)) {
          failures.push(`unexpected tool present: ${tool}`);
        }
      }
      for (const tool of unexpectedAnswerTools(answerText, allowedTools)) {
        failures.push(`unexpected tool recommended in answer text: ${tool}`);
      }
    }
    for (const tool of testCase.expected.requiredOrderedTools ?? []) {
      if (!orderedTools.includes(tool)) {
        failures.push(`missing required tool ${tool}`);
      }
    }
    const orderFailure = firstOrderFailure(orderedTools, testCase.expected.requiredOrderedTools ?? []);
    if (orderFailure) {
      failures.push(orderFailure);
    }
    for (const [tool, beforeTool] of Object.entries(testCase.expected.allowedExtraToolsBefore ?? {})) {
      const beforeIndex = orderedTools.indexOf(beforeTool);
      const lateToolIndex = orderedTools.findIndex((candidate, index) => candidate === tool && index > beforeIndex);
      if (beforeIndex !== -1 && lateToolIndex !== -1) {
        failures.push(`allowed extra tool ${tool} must appear before ${beforeTool}`);
      }
    }
    for (const tool of testCase.expected.forbiddenTools ?? []) {
      if (orderedTools.includes(tool)) {
        failures.push(`forbidden tool present: ${tool}`);
      }
      if (containsForbiddenToolName(answerText, tool)) {
        failures.push(`forbidden tool present in answer text: ${tool}`);
      }
    }
    for (const prefix of testCase.expected.forbiddenToolPrefixes ?? []) {
      if (orderedTools.some((tool) => tool.startsWith(prefix))) {
        failures.push(`forbidden tool prefix present: ${prefix}`);
      }
      if (containsForbiddenToolPrefix(answerText, prefix)) {
        failures.push(`forbidden tool prefix present in answer text: ${prefix}`);
      }
    }
    for (const term of testCase.expected.requiredTerms ?? []) {
      if (!containsRequiredTerm(guidanceText, term)) {
        failures.push(`missing required term: ${term}`);
      }
    }
    for (const term of testCase.expected.forbiddenTerms ?? []) {
      if (containsForbiddenTerm(answerText, term)) {
        failures.push(`forbidden term present: ${term}`);
      }
    }
  }

  const fileChangeEvents = events.filter((event) => {
    const itemType = event?.item?.type;
    return itemType === "file_change" || (typeof itemType === "string" && itemType.includes("patch"));
  });
  if (fileChangeEvents.length > 0) {
    failures.push(`trace contains file change events: ${fileChangeEvents.map((event) => event.item.type).join(", ")}`);
  }
  const liveCommands = events.flatMap((event) => {
    const command = event?.item?.command;
    return typeof command === "string" && invokesLiveDockerOrYdb(command) ? [command] : [];
  });
  for (const command of liveCommands) {
    failures.push(`trace contains live Docker/YDB command: ${command}`);
  }
  const liveMcpTools = events.flatMap((event) => {
    const item = event?.item;
    const itemType = item?.type;
    const name = typeof item?.name === "string" ? item.name : item?.tool;
    const eventType = event?.type;
    const isToolEvent = [itemType, eventType].some((value) => typeof value === "string" && value.includes("tool"));
    return isToolEvent && typeof name === "string" && name.startsWith("local_ydb_") ? [name] : [];
  });
  for (const name of liveMcpTools) {
    failures.push(`trace contains live MCP tool call: ${name}`);
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

function validateFinalAnswerShape(answer) {
  const failures = [];
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return ["final answer must be an object"];
  }
  for (const [field, type] of finalAnswerFields) {
    if (!(field in answer)) {
      failures.push(`final answer missing required field: ${field}`);
      continue;
    }
    const value = answer[field];
    if (type === "array:string") {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        failures.push(`final answer field ${field} must be an array of strings`);
      }
    } else if (typeof value !== type) {
      failures.push(`final answer field ${field} must be ${type}`);
    }
  }
  for (const field of Object.keys(answer)) {
    if (!finalAnswerFields.has(field)) {
      failures.push(`final answer contains unsupported field: ${field}`);
    }
  }
  return failures;
}

function finalAnswerTextFields(answer) {
  return [
    answer.task_type,
    answer.answer,
    ...(Array.isArray(answer.safety_gates) ? answer.safety_gates : []),
  ].filter((value) => typeof value === "string");
}

function finalAnswerGuidanceText(answer) {
  return [
    answer.answer,
    ...(Array.isArray(answer.safety_gates) ? answer.safety_gates : []),
  ].filter((value) => typeof value === "string").join("\n");
}

function containsForbiddenToolPrefix(text, prefix) {
  return toolPrefixMatches(text, prefix).some((match) => !isNegatedWarningAt(text, match.index));
}

function unexpectedAnswerTools(text, allowedTools) {
  const unexpected = new Set();
  for (const match of text.matchAll(/\blocal_ydb_[a-z0-9_]+\b/g)) {
    const tool = match[0];
    if (!allowedTools.has(tool) && !isNegatedWarningAt(text, match.index ?? 0)) {
      unexpected.add(tool);
    }
  }
  return [...unexpected];
}

function containsForbiddenToolName(text, tool) {
  return exactToolMatches(text, tool).some((match) => !isNegatedWarningAt(text, match.index));
}

function toolPrefixMatches(text, prefix) {
  return regexMatches(text, new RegExp(String.raw`\b${escapeRegExp(prefix)}[A-Za-z0-9_]*\b`, "g"));
}

function exactToolMatches(text, tool) {
  return regexMatches(text, new RegExp(String.raw`\b${escapeRegExp(tool)}\b`, "g"));
}

function regexMatches(text, pattern) {
  const matches = [];
  for (const match of text.matchAll(pattern)) {
    matches.push({
      text: match[0],
      index: match.index ?? 0,
      length: match[0].length,
    });
  }
  return matches;
}

function firstOrderFailure(actual, required) {
  // Validate the first occurrence of each required tool: a required tool that
  // runs before its prerequisites is unsafe even if it is repeated later.
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

function containsRequiredTerm(text, term) {
  return requiredTermMatches(text, String(term)).length > 0;
}

function requiredTermMatches(text, term) {
  if (/^[A-Za-z0-9_]+$/.test(term)) {
    return regexMatches(text, new RegExp(String.raw`\b${escapeRegExp(term)}\b`, "gi"));
  }
  // Phrase terms get word-boundary edges so "gh api" does not match inside
  // "through API". A trailing plural "s" stays allowed: "unit tests" still
  // satisfies a required "unit test" term.
  const leftBoundary = /^[A-Za-z0-9_]/.test(term) ? String.raw`(?<![A-Za-z0-9_])` : "";
  const rightBoundary = /[A-Za-z0-9_]$/.test(term) ? String.raw`s?(?![A-Za-z0-9_])` : "";
  return regexMatches(text, new RegExp(`${leftBoundary}${escapeRegExp(term)}${rightBoundary}`, "gi"));
}

function containsForbiddenTerm(text, term) {
  for (const match of text.matchAll(forbiddenTermPattern(term))) {
    if (!isNegatedWarningAt(text, match.index ?? 0)) {
      return true;
    }
  }
  return false;
}

function forbiddenTermPattern(term) {
  const flexible = escapeRegExp(String(term)).replace(/[\s`"':=]+/g, "[\\s`\"':=]*");
  return new RegExp(flexible, "gi");
}

function isNegatedWarningAt(text, index) {
  const before = text.slice(Math.max(0, index - 40), index);
  const negations = [...before.matchAll(/\b(?:no|not|never|without|avoid)\b/gi)];
  if (negations.length === 0) {
    return false;
  }
  const lastNegation = negations[negations.length - 1];
  const scope = before.slice(lastNegation.index + lastNegation[0].length);
  // Clause punctuation and coordinating conjunctions end the negation scope:
  // in "do not stop, pass X" or "do not skip the backup and pass X" the
  // "not" does not govern the forbidden action that follows.
  return !/[.!?;,\n]|\b(?:and|or|but)\b/i.test(scope);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const shellWrapperNames = new Set([
  "sudo",
  "env",
  "timeout",
  "time",
  "nice",
  "command",
  "exec",
  "nohup",
  "setsid",
  "eval",
  "xargs",
]);
const shellCommandNames = new Set(["bash", "sh", "zsh"]);
// Shell grammar keywords that can precede the real command in compound
// commands ("if ...; then docker stop x; fi", "for f in ...; do ...; done").
const shellControlWords = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "in",
  "select",
  "function",
  "!",
  ")",
]);

export function invokesLiveDockerOrYdb(command) {
  return scanForLiveDockerOrYdb(command, 0);
}

const maxSubstitutionDepth = 4;

function scanForLiveDockerOrYdb(command, depth) {
  if (scanShellSegments(command).some((tokens) => tokensInvokeLiveDockerOrYdb(tokens))) {
    return true;
  }
  if (depth >= maxSubstitutionDepth) {
    return false;
  }
  return commandSubstitutionBodies(command).some((body) => scanForLiveDockerOrYdb(body, depth + 1));
}

function commandSubstitutionBodies(command) {
  const bodies = [];
  let singleQuoted = false;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (singleQuoted) {
      if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      continue;
    }
    if (char === "`") {
      const end = command.indexOf("`", index + 1);
      if (end === -1) {
        return bodies;
      }
      bodies.push(command.slice(index + 1, end));
      index = end;
      continue;
    }
    const opensSubstitution = (char === "$" || char === "<" || char === ">") && command[index + 1] === "(";
    if (opensSubstitution) {
      const close = matchingParenIndex(command, index + 1);
      if (close === -1) {
        return bodies;
      }
      bodies.push(command.slice(index + 2, close));
      index = close;
    }
  }
  return bodies;
}

function matchingParenIndex(command, openIndex) {
  let depth = 0;
  let quote;
  let escaped = false;
  for (let index = openIndex; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function scanShellSegments(command) {
  const segments = [[]];
  let current = "";
  let quote;
  let escaped = false;
  const pushToken = () => {
    if (current.length > 0) {
      segments[segments.length - 1].push(current);
      current = "";
    }
  };
  const pushSegment = () => {
    pushToken();
    segments.push([]);
  };
  for (let charIndex = 0; charIndex < command.length; charIndex += 1) {
    const char = command[charIndex];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      pushSegment();
      continue;
    }
    // "{}" is a literal word in shell (xargs/find placeholder), not a brace
    // group, so it must survive as a token instead of becoming a delimiter.
    if (char === "{" && command[charIndex + 1] === "}") {
      current += "{}";
      charIndex += 1;
      continue;
    }
    // A ")" closes a case pattern or a function name; keep it as a token so
    // the scanner can resume at the real command that follows it.
    if (char === ")") {
      pushToken();
      segments[segments.length - 1].push(")");
      continue;
    }
    if (/\s/.test(char) || char === "(" || char === "{" || char === "}") {
      pushToken();
      continue;
    }
    current += char;
  }
  pushToken();
  return segments.filter((segment) => segment.length > 0);
}

function tokensInvokeLiveDockerOrYdb(tokens) {
  let index = 0;
  // Case-arm patterns and function names precede the first ")" token; the
  // real command follows it ("foo) docker stop;;", "f() { ydb ...; }").
  const closeParen = tokens.indexOf(")");
  if (closeParen !== -1 && closeParen < tokens.length - 1) {
    index = closeParen + 1;
  }
  while (index < tokens.length) {
    const token = tokens[index];
    if (isEnvironmentAssignment(token) || token.startsWith("-")) {
      index += 1;
      continue;
    }
    const name = commandName(token);
    if (shellControlWords.has(name)) {
      index += 1;
      continue;
    }
    if (shellWrapperNames.has(name)) {
      index = nextCommandIndexAfterWrapper(tokens, index, name);
      continue;
    }
    if (isLiveDockerOrYdbName(name)) {
      return true;
    }
    if (shellCommandNames.has(name)) {
      const flagIndex = tokens.findIndex((candidate, cursor) => cursor > index && /^-[^-]*c/.test(candidate));
      const script = flagIndex === -1 ? undefined : tokens[flagIndex + 1];
      return typeof script === "string" && invokesLiveDockerOrYdb(script);
    }
    return false;
  }
  return false;
}

function nextCommandIndexAfterWrapper(tokens, index, name) {
  let cursor = index + 1;
  if (name === "timeout") {
    cursor = skipOptions(tokens, cursor, timeoutOptionsWithValues);
    return isDurationToken(tokens[cursor] ?? "") ? cursor + 1 : cursor;
  }
  if (name === "nice") {
    return skipOptions(tokens, cursor, niceOptionsWithValues);
  }
  if (name === "sudo") {
    return skipOptions(tokens, cursor, sudoOptionsWithValues);
  }
  if (name === "env") {
    cursor = skipOptions(tokens, cursor, envOptionsWithValues);
    while (isEnvironmentAssignment(tokens[cursor] ?? "")) {
      cursor += 1;
    }
    return cursor;
  }
  if (name === "xargs") {
    return skipOptions(tokens, cursor, xargsOptionsWithValues);
  }
  if (name === "time") {
    return skipOptions(tokens, cursor, timeOptionsWithValues);
  }
  if (name === "exec") {
    return skipOptions(tokens, cursor, execOptionsWithValues);
  }
  return cursor;
}

function skipOptions(tokens, index, optionsWithValues) {
  let cursor = index;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token === "--") {
      return cursor + 1;
    }
    if (!token.startsWith("-") || token === "-") {
      return cursor;
    }
    cursor += optionTokenWidth(token, optionsWithValues);
  }
  return cursor;
}

function optionTokenWidth(token, optionsWithValues) {
  if (optionsWithValues.some((option) => token === option)) {
    return 2;
  }
  return 1;
}

function isDurationToken(token) {
  return /^\d+(?:\.\d+)?[a-z]?$/i.test(token);
}

const timeoutOptionsWithValues = ["-k", "-s", "--kill-after", "--signal"];
const niceOptionsWithValues = ["-n", "--adjustment"];
const sudoOptionsWithValues = [
  "-C",
  "-g",
  "-h",
  "-p",
  "-r",
  "-T",
  "-t",
  "-U",
  "-u",
  "--close-from",
  "--command-timeout",
  "--group",
  "--host",
  "--login-class",
  "--prompt",
  "--role",
  "--type",
  "--user",
];
const envOptionsWithValues = ["-C", "-S", "-u", "--chdir", "--split-string", "--unset"];
const xargsOptionsWithValues = [
  "-a",
  "-d",
  "-E",
  "-I",
  "-L",
  "-l",
  "-n",
  "-P",
  "-s",
  "--arg-file",
  "--delimiter",
  "--eof",
  "--max-args",
  "--max-chars",
  "--max-lines",
  "--max-procs",
  "--replace",
];
const timeOptionsWithValues = ["-f", "-o", "--format", "--output"];
const execOptionsWithValues = ["-a"];

function commandName(token) {
  return token.split("/").pop() ?? token;
}

function isLiveDockerOrYdbName(name) {
  return /^(?:docker|ydbd?)$/.test(name);
}

function isEnvironmentAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

export function buildCodexEnv({
  path = process.env.PATH ?? process.env.Path,
  homeDir,
  codexHome,
  apiKey,
}) {
  const env = {};
  if (path) {
    env.PATH = path;
  }
  env.HOME = homeDir;
  env.CODEX_HOME = codexHome;
  env.CODEX_API_KEY = apiKey;
  return env;
}

export function buildCodexSpawnOptions(workspace, options) {
  return {
    cwd: options.repoRoot,
    env: buildCodexEnv({
      homeDir: workspace.homeDir,
      codexHome: workspace.codexHome,
      apiKey: options.apiKey,
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? defaultCaseTimeoutMs,
  };
}

export function codexExitCode(result) {
  if (typeof result.status === "number") {
    return result.status;
  }
  return 1;
}

export function codexStderrLog(result) {
  const parts = [];
  if (typeof result.stderr === "string" && result.stderr.length > 0) {
    parts.push(result.stderr.trimEnd());
  }
  if (result.error) {
    parts.push(result.error.stack || result.error.message || String(result.error));
  }
  return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}

function runCase(testCase, workspace, options) {
  const prompt = buildPrompt(testCase);
  const args = buildCodexArgs({
    repoRoot: options.repoRoot,
    prompt,
    schemaPath: options.schemaPath,
  });
  const result = spawnSync("codex", args, {
    ...buildCodexSpawnOptions(workspace, options),
  });

  const caseDir = join(workspace.resultsDir, testCase.id);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "stdout.jsonl"), result.stdout ?? "", "utf8");
  writeFileSync(join(caseDir, "stderr.log"), codexStderrLog(result), "utf8");
  writeFileSync(join(caseDir, "prompt.txt"), prompt, "utf8");

  const parsed = parseJsonlEvents(result.stdout ?? "");
  writeFileSync(join(caseDir, "events.filtered.json"), `${JSON.stringify(parsed.events, null, 2)}\n`, "utf8");
  const score = scoreCase(testCase, parsed.events, {
    exitCode: codexExitCode(result),
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
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires ${placeholder}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: npm run eval:agent -- [--list] [--case <id>] [--cases <path>] [--schema <path>] [--help]

Runs plan-only Codex agent evals for the local-ydb skill.

Options:
  --list          Print available cases and exit.
  --case <id>    Run a single case.
  --cases <path> Use a custom cases JSON file.
  --schema <path> Use a custom final-answer JSON schema.
  --help          Print this help.
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const cases = loadCases(args.casesPath);
  if (args.list) {
    for (const testCase of cases) {
      console.log(`${testCase.id}\t${testCase.name ?? ""}`);
    }
    return;
  }

  const selectedCases = args.caseId ? cases.filter((testCase) => testCase.id === args.caseId) : cases;
  if (args.caseId && selectedCases.length === 0) {
    throw new Error(`Unknown eval case: ${args.caseId}`);
  }

  const apiKey = process.env.CODEX_API_KEY;
  if (!apiKey) {
    throw new Error("CODEX_API_KEY is required to run agent evals. Use --list to inspect cases without credentials.");
  }

  const workspace = createEvalWorkspace({ repoRoot, schemaPath: args.schemaPath });
  const scores = [];
  try {
    for (const testCase of selectedCases) {
      console.log(`Running ${testCase.id}...`);
      const score = runCase(testCase, workspace, {
        repoRoot: workspace.repoRoot,
        schemaPath: workspace.schemaPath,
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
