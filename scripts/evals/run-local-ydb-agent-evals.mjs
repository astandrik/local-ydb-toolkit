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
const mutatingLocalYdbTools = new Set([
  "local_ydb_add_dynamic_nodes",
  "local_ydb_add_storage_groups",
  "local_ydb_apply_auth_hardening",
  "local_ydb_apply_schema",
  "local_ydb_bootstrap",
  "local_ydb_bootstrap_root_database",
  "local_ydb_check_prerequisites",
  "local_ydb_cleanup_storage",
  "local_ydb_create_tenant",
  "local_ydb_destroy_stack",
  "local_ydb_dump_tenant",
  "local_ydb_permissions",
  "local_ydb_prepare_auth_config",
  "local_ydb_pull_image",
  "local_ydb_reduce_storage_groups",
  "local_ydb_remove_dynamic_nodes",
  "local_ydb_restart_stack",
  "local_ydb_restore_tenant",
  "local_ydb_set_root_password",
  "local_ydb_start_dynamic_node",
  "local_ydb_upgrade_version",
  "local_ydb_write_dynamic_auth_config",
]);
const shellControlKeywords = new Set([
  "!",
  "{",
  "do",
  "elif",
  "else",
  "for",
  "if",
  "select",
  "then",
  "until",
  "while",
]);

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
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Agent eval case ${testCase.id} expected.${field} must be an array of strings.`);
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
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
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
  const traceText = buildTraceText(events);
  const requiredTermsText = finalAnswer ? finalAnswerGuidanceText(finalAnswer) : finalText;

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
    const answerTextFields = finalAnswerTextFields(finalAnswer);
    const answerMentionsLocalYdbTool = answerTextFields.some(
      (text) => containsForbiddenToolPrefix(text, "local_ydb_"),
    );
    if (!expectedSkill && orderedTools.some((tool) => tool.startsWith("local_ydb_"))) {
      failures.push("negative control must not include local-ydb tools");
    }
    if (!expectedSkill && answerMentionsLocalYdbTool) {
      failures.push("negative control must not mention local-ydb tools");
    }
    if (!expectedSkill && !answerMentionsLocalYdbTool && containsForbiddenToolPrefix(finalText, "local_ydb_")) {
      failures.push("negative control must not mention local-ydb tools in final message");
    }
    if (!expectedSkill && containsForbiddenToolPrefix(traceText, "local_ydb_")) {
      failures.push("negative control must not mention local-ydb tools in agent trace");
    }
    const answerRecommendsLocalYdbSkill = answerTextFields.some((text) => recommendsLocalYdbSkill(text));
    if (!expectedSkill && answerRecommendsLocalYdbSkill) {
      failures.push("negative control must not recommend the local-ydb skill");
    }
    if (!expectedSkill && !answerRecommendsLocalYdbSkill && recommendsLocalYdbSkill(finalText)) {
      failures.push("negative control must not recommend the local-ydb skill in final message");
    }
    if (!expectedSkill && recommendsLocalYdbSkill(traceText)) {
      failures.push("negative control must not recommend the local-ydb skill in agent trace");
    }
    if (expectedSkill) {
      const allowedTools = new Set([
        ...(testCase.expected.requiredOrderedTools ?? []),
        ...(testCase.expected.allowedExtraTools ?? []),
      ]);
      for (const tool of orderedTools) {
        if (mutatingLocalYdbTools.has(tool) && !allowedTools.has(tool)) {
          failures.push(`unexpected mutating tool present: ${tool}`);
        }
      }
      for (const tool of mutatingLocalYdbTools) {
        if (allowedTools.has(tool)) {
          continue;
        }
        const answerMentionsTool = answerTextFields.some((text) => containsForbiddenToolName(text, tool));
        if (answerMentionsTool) {
          failures.push(`unexpected mutating tool present in answer text: ${tool}`);
        }
        if (!orderedTools.includes(tool) && !answerMentionsTool && containsForbiddenToolName(finalText, tool)) {
          failures.push(`unexpected mutating tool present in final message: ${tool}`);
        }
        if (containsForbiddenToolName(traceText, tool)) {
          failures.push(`unexpected mutating tool present in agent trace: ${tool}`);
        }
      }
    }
    for (const tool of testCase.expected.requiredOrderedTools ?? []) {
      if (!orderedTools.includes(tool)) {
        failures.push(`missing required tool ${tool}`);
      }
    }
    for (const tool of testCase.expected.forbiddenTools ?? []) {
      const answerMentionsTool = answerTextFields.some((text) => containsForbiddenToolName(text, tool));
      if (orderedTools.includes(tool)) {
        failures.push(`forbidden tool present: ${tool}`);
      }
      if (answerMentionsTool) {
        failures.push(`forbidden tool present in answer text: ${tool}`);
      }
      if (!orderedTools.includes(tool) && !answerMentionsTool && containsForbiddenToolName(finalText, tool)) {
        failures.push(`forbidden tool present in final message: ${tool}`);
      }
    }
    for (const prefix of testCase.expected.forbiddenToolPrefixes ?? []) {
      const answerMentionsPrefix = answerTextFields.some((text) => containsForbiddenToolPrefix(text, prefix));
      if (orderedTools.some((tool) => tool.startsWith(prefix))) {
        failures.push(`forbidden tool prefix present: ${prefix}`);
      }
      if (answerMentionsPrefix) {
        failures.push(`forbidden tool prefix present in answer text: ${prefix}`);
      }
      if (
        !orderedTools.some((tool) => tool.startsWith(prefix)) &&
        !answerMentionsPrefix &&
        containsForbiddenToolPrefix(finalText, prefix)
      ) {
        failures.push(`forbidden tool prefix present in final message: ${prefix}`);
      }
      if (containsForbiddenToolPrefix(traceText, prefix)) {
        failures.push(`forbidden tool prefix present in agent trace: ${prefix}`);
      }
    }
    const orderFailure = firstOrderFailure(orderedTools, testCase.expected.requiredOrderedTools ?? []);
    if (orderFailure) {
      failures.push(orderFailure);
    }
    const earlyRequiredToolFailure = firstEarlyRequiredToolFailure(
      orderedTools,
      testCase.expected.requiredOrderedTools ?? [],
    );
    if (earlyRequiredToolFailure) {
      failures.push(earlyRequiredToolFailure);
    }
    for (const text of answerTextFields) {
      const requiredTextOrderFailure = firstRequiredToolTextOrderFailure(
        text,
        testCase.expected.requiredOrderedTools ?? [],
        "answer text",
      );
      if (requiredTextOrderFailure) {
        failures.push(requiredTextOrderFailure);
      }
      const allowedExtraTextOrderFailure = firstAllowedExtraTextOrderFailure(
        text,
        testCase.expected.allowedExtraToolsBefore ?? {},
        "answer text",
      );
      if (allowedExtraTextOrderFailure) {
        failures.push(allowedExtraTextOrderFailure);
      }
    }
    const requiredTraceOrderFailure = firstRequiredToolTextOrderFailure(
      traceText,
      testCase.expected.requiredOrderedTools ?? [],
      "agent trace",
    );
    if (requiredTraceOrderFailure) {
      failures.push(requiredTraceOrderFailure);
    }
    const allowedExtraTraceOrderFailure = firstAllowedExtraTextOrderFailure(
      traceText,
      testCase.expected.allowedExtraToolsBefore ?? {},
      "agent trace",
    );
    if (allowedExtraTraceOrderFailure) {
      failures.push(allowedExtraTraceOrderFailure);
    }
    for (const [tool, beforeTool] of Object.entries(testCase.expected.allowedExtraToolsBefore ?? {})) {
      const beforeIndex = orderedTools.indexOf(beforeTool);
      const lateToolIndex = orderedTools.findIndex((candidate, index) => candidate === tool && index > beforeIndex);
      if (beforeIndex !== -1 && lateToolIndex !== -1) {
        failures.push(`allowed extra tool ${tool} must appear before ${beforeTool}`);
      }
    }
  }

  const searchableText = [finalText, traceText].join("\n");
  for (const term of testCase.expected.requiredTerms ?? []) {
    if (!includesIgnoreCase(requiredTermsText, term)) {
      failures.push(`missing required term: ${term}`);
    }
  }
  for (const term of testCase.expected.forbiddenTerms ?? []) {
    if (containsForbiddenTerm(searchableText, term)) {
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

function buildTraceText(events) {
  const parts = [];
  const finalAgentMessageIndex = findFinalAgentMessageIndex(events);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const item = event?.item;
    if (!item || typeof item !== "object") {
      continue;
    }
    if (index !== finalAgentMessageIndex && item.type === "agent_message" && typeof item.text === "string") {
      parts.push(item.text);
    }
    if (typeof item.command === "string") {
      parts.push(item.command);
    }
    if (typeof item.name === "string") {
      parts.push(item.name);
    }
    if (typeof item.tool === "string") {
      parts.push(item.tool);
    }
    if (item.type !== "agent_message") {
      parts.push(...traceItemTextParts(item));
    }
  }
  return parts.join("\n");
}

const traceTextFieldNames = new Set(["text", "content", "title", "summary", "description", "step"]);

function traceItemTextParts(value) {
  const parts = [];
  const visit = (candidate) => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    if (!candidate || typeof candidate !== "object") {
      return;
    }
    for (const [key, item] of Object.entries(candidate)) {
      if (typeof item === "string" && traceTextFieldNames.has(key)) {
        parts.push(item);
      } else if (item && typeof item === "object") {
        visit(item);
      }
    }
  };
  visit(value);
  return parts;
}

function findFinalAgentMessageIndex(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]?.item;
    if (item?.type === "agent_message" && typeof item.text === "string") {
      return index;
    }
  }
  return -1;
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
  return toolPrefixMatches(text, prefix).some((match) => !isSafeForbiddenWarningAtMatch(text, match));
}

function containsForbiddenToolName(text, tool) {
  return exactToolMatches(text, tool).some((match) => !isSafeForbiddenWarningAtMatch(text, match));
}

function recommendsLocalYdbSkill(text) {
  return localYdbSkillMatches(text).some((match) => !isSafeForbiddenWarningAtMatch(text, match));
}

function toolPrefixMatches(text, prefix) {
  return regexMatches(text, new RegExp(String.raw`\b${escapeRegExp(prefix)}[A-Za-z0-9_]*\b`, "g"));
}

function exactToolMatches(text, tool) {
  return regexMatches(text, new RegExp(String.raw`\b${escapeRegExp(tool)}\b`, "g"));
}

function localYdbSkillMatches(text) {
  return [
    ...regexMatches(text, /\$local-ydb\b/gi),
    ...regexMatches(text, /\blocal-ydb\s+(?:codex\s+)?(?:skill|workflow|guidance|mcp(?:\s+server)?|toolkit)\b/gi),
    ...regexMatches(text, /\blocal\s+ydb\s+(?:codex\s+)?(?:skill|workflow|guidance|mcp(?:\s+server)?|toolkit)\b/gi),
  ];
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
  let previousIndex = -1;
  for (const tool of required) {
    const index = actual.indexOf(tool, previousIndex + 1);
    if (index === -1) {
      if (actual.includes(tool)) {
        return `required tools are out of order: ${required.join(" -> ")}`;
      }
      continue;
    }
    previousIndex = index;
  }
  return undefined;
}

function firstEarlyRequiredToolFailure(actual, required) {
  for (let requiredIndex = 1; requiredIndex < required.length; requiredIndex += 1) {
    const tool = required[requiredIndex];
    for (
      let actualIndex = actual.indexOf(tool);
      actualIndex !== -1;
      actualIndex = actual.indexOf(tool, actualIndex + 1)
    ) {
      for (const predecessor of required.slice(0, requiredIndex)) {
        if (!actual.slice(0, actualIndex).includes(predecessor)) {
          const toolLabel = mutatingLocalYdbTools.has(tool) ? "required mutating tool" : "required tool";
          return `${toolLabel} ${tool} appears before required predecessor ${predecessor}`;
        }
      }
    }
  }
  return undefined;
}

function firstRequiredToolTextOrderFailure(text, required, location) {
  for (let requiredIndex = 1; requiredIndex < required.length; requiredIndex += 1) {
    const tool = required[requiredIndex];
    for (const predecessor of required.slice(0, requiredIndex)) {
      if (hasToolMentionBefore(text, tool, predecessor)) {
        return `required tool ${tool} appears before ${predecessor} in ${location}`;
      }
    }
  }
  return undefined;
}

function firstAllowedExtraTextOrderFailure(text, allowedExtraToolsBefore, location) {
  for (const [tool, beforeTool] of Object.entries(allowedExtraToolsBefore)) {
    if (hasToolMentionBefore(text, beforeTool, tool)) {
      return `allowed extra tool ${tool} appears after ${beforeTool} in ${location}`;
    }
  }
  return undefined;
}

function hasToolMentionBefore(text, firstTool, secondTool) {
  const firstMatches = nonSafeToolMatches(text, firstTool);
  const secondMatches = nonSafeToolMatches(text, secondTool);
  return firstMatches.some((firstMatch) =>
    secondMatches.some((secondMatch) =>
      firstMatch.index < secondMatch.index &&
      !isExplicitAfterConstraint(text, firstMatch, secondMatch) &&
      !isExplicitBeforeConstraint(text, firstMatch, secondMatch)));
}

function isExplicitAfterConstraint(text, firstMatch, secondMatch) {
  const between = text.slice(firstMatch.index + firstMatch.length, secondMatch.index);
  return /\b(?:only\s+)?after\s*[`'"\[({]*\s*$/i.test(between);
}

function isExplicitBeforeConstraint(text, firstMatch, secondMatch) {
  const before = text.slice(0, firstMatch.index);
  const between = text.slice(firstMatch.index + firstMatch.length, secondMatch.index);
  return /(?:^|[.!?;]\s*)before\s*[`'"\[({]*\s*$/i.test(before) &&
    /^\s*[`'")\]}]*\s*,\s*(?:(?:first|then)\s+)?(?:run|call|use|invoke|execute|perform|take|create|check|inspect)\s+[`'"\[({]*\s*$/i.test(between);
}

function nonSafeToolMatches(text, tool) {
  return exactToolMatches(text, tool).filter((match) => !isSafeForbiddenWarningAtMatch(text, match));
}

function includesIgnoreCase(text, needle) {
  return text.toLowerCase().includes(String(needle).toLowerCase());
}

function containsForbiddenTerm(text, term) {
  const needle = String(term);
  const matches = forbiddenTermMatches(text, needle);
  for (const match of matches) {
    if (!isSafeForbiddenWarningAtMatch(text, match)) {
      return true;
    }
  }
  return false;
}

function forbiddenTermMatches(text, term) {
  if (isConfirmedMutationTerm(term)) {
    const matches = [];
    const confirmQuote = "[`\"']";
    const confirmName = `(?:\\\\?${confirmQuote})*confirm(?:\\\\?${confirmQuote})*`;
    const pattern = new RegExp(String.raw`(?:${confirmName}\s*[:=]\s*true|(?:set|pass|use|include|call|run\s+with)\s+${confirmName}\s+(?:(?:to|as)\s+)?true)`, "gi");
    for (const match of text.matchAll(pattern)) {
      matches.push({
        text: match[0],
        index: match.index ?? 0,
        length: match[0].length,
      });
    }
    return matches;
  }

  const matches = [];
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  let offset = 0;
  while (offset < haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) {
      return matches;
    }
    matches.push({
      text: text.slice(index, index + term.length),
      index,
      length: term.length,
    });
    offset = index + term.length;
  }
  return matches;
}

function isConfirmedMutationTerm(term) {
  const normalized = term.toLowerCase().replace(/\s+/g, "");
  return normalized === "confirm:true" || normalized === "\"confirm\":true" || normalized === "confirm=true";
}

function isSafeForbiddenWarningAtMatch(text, match) {
  const before = text.slice(Math.max(0, match.index - 120), match.index);
  const after = text.slice(match.index + match.length, Math.min(text.length, match.index + match.length + 120));
  const beforePattern = /\b(?:do not|don't|never|avoid|must not|should not)\s+(?:(?:use|using|pass|passing|set|setting|include|including|call|calling|run\s+with|running\s+with)\s+)?(?:(?:any|all|the|a|an)\s+)?[`'"([{]*\s*$/i;
  const noPattern = /\b(?:no|without)\s+[`'"([{]*\s*$/i;
  const notClassificationPattern = /\bnot\s+(?:(?:a|an|the)\s+)?[`'"([{]*\s*$/i;
  const afterPattern = /^\s*[`'")\]}.,:;]*\s*(?:is forbidden|is not allowed|must not be used|should not be used|must never be used|should never be used|must not be passed|should not be passed|must never be passed|should never be passed)\b/i;
  return beforePattern.test(before) || noPattern.test(before) || notClassificationPattern.test(before) || afterPattern.test(after);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function invokesLiveDockerOrYdb(command) {
  return commandSegments(command).some((segment) => commandInvokesLiveDockerOrYdb(shellTokens(segment)));
}

function commandSegments(command) {
  const segments = splitCommandSegments(command);
  const seen = new Set(segments);
  const addSegments = (candidates) => {
    for (const candidate of candidates) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        segments.push(candidate);
      }
    }
  };
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const shellCommand = shellWrappedCommand(shellTokens(segment));
    if (shellCommand) {
      addSegments(splitCommandSegments(shellCommand));
    }
    for (const substitution of commandSubstitutionSegments(segment)) {
      addSegments(splitCommandSegments(substitution));
    }
  }
  return segments;
}

function commandInvokesLiveDockerOrYdb(tokens, depth = 0) {
  const executableIndexValue = executableIndex(tokens);
  if (executableIndexValue === -1) {
    return false;
  }
  const executable = commandName(tokens[executableIndexValue]);
  if (isLiveDockerOrYdbName(executable)) {
    return true;
  }
  if (executable === "ssh" && depth < 2) {
    const remoteTokens = sshRemoteCommandTokens(tokens, executableIndexValue);
    return remoteTokens.length > 0 && splitCommandSegments(remoteTokens.join(" "))
      .some((segment) => commandInvokesLiveDockerOrYdb(shellTokens(segment), depth + 1));
  }
  return false;
}

function executableIndex(tokens, start = 0) {
  let index = start;
  while (index < tokens.length && shellControlKeywords.has(commandName(tokens[index]))) {
    index += 1;
  }
  while (index < tokens.length) {
    const token = tokens[index];
    const name = commandName(token);
    if (isEnvironmentAssignment(token)) {
      index += 1;
    } else if (name === "sudo") {
      index += 1;
      while (tokens[index]?.startsWith("-")) {
        index += sudoOptionConsumesArgument(tokens[index]) ? 2 : 1;
      }
    } else if (name === "timeout") {
      index += 1;
      while (tokens[index]?.startsWith("-")) {
        index += timeoutOptionConsumesArgument(tokens[index]) ? 2 : 1;
      }
      if (index < tokens.length) {
        index += 1;
      }
    } else if (name === "env") {
      index += 1;
      while (tokens[index]?.startsWith("-")) {
        if (tokens[index] === "--") {
          index += 1;
          break;
        }
        index += envOptionConsumesArgument(tokens[index]) ? 2 : 1;
      }
    } else if (name === "time") {
      index += 1;
      while (tokens[index]?.startsWith("-")) {
        if (tokens[index] === "--") {
          index += 1;
          break;
        }
        index += timeOptionConsumesArgument(tokens[index]) ? 2 : 1;
      }
    } else if (name === "nice") {
      index += 1;
      while (tokens[index]?.startsWith("-")) {
        if (tokens[index] === "--") {
          index += 1;
          break;
        }
        index += niceOptionConsumesArgument(tokens[index]) ? 2 : 1;
      }
    } else if (name === "command") {
      index += 1;
      while (/^-p+$/.test(tokens[index] ?? "")) {
        index += 1;
      }
      if (tokens[index] === "--") {
        index += 1;
      }
    } else {
      return index;
    }
  }
  return -1;
}

function sudoOptionConsumesArgument(token) {
  return !token.includes("=") && new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-T", "-t", "-u"]).has(token);
}

function timeoutOptionConsumesArgument(token) {
  return !token.includes("=") && new Set(["-k", "--kill-after", "-s", "--signal"]).has(token);
}

function envOptionConsumesArgument(token) {
  return !token.includes("=") && new Set(["-u", "--unset", "-C", "--chdir"]).has(token);
}

function timeOptionConsumesArgument(token) {
  return !token.includes("=") && new Set(["-o", "--output", "-f", "--format"]).has(token);
}

function niceOptionConsumesArgument(token) {
  return !token.includes("=") && new Set(["-n", "--adjustment"]).has(token);
}

function sshRemoteCommandTokens(tokens, sshIndex) {
  let index = sshIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) {
      break;
    }
    index += sshOptionConsumesArgument(token) ? 2 : 1;
  }
  if (index >= tokens.length) {
    return [];
  }
  return tokens.slice(index + 1);
}

function sshOptionConsumesArgument(token) {
  return new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]).has(token);
}

function splitCommandSegments(command) {
  const segments = [];
  let current = "";
  let quote;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      current += char;
      quote = char;
    } else if (char === ";" || char === "|" || char === "&" || char === "\n") {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    segments.push(current.trim());
  }
  return segments;
}

function commandSubstitutionSegments(segment) {
  const segments = [];
  let quote;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" && !quote) {
      quote = "'";
      continue;
    }
    if (char === "\"") {
      quote = quote === "\"" ? undefined : "\"";
      continue;
    }
    if (char === "$" && segment[index + 1] === "(") {
      const substitution = readParenthesizedSubstitution(segment, index + 2);
      if (substitution) {
        segments.push(substitution.text);
        index = substitution.endIndex;
      }
    } else if (!quote && (char === "<" || char === ">") && segment[index + 1] === "(") {
      const substitution = readParenthesizedSubstitution(segment, index + 2);
      if (substitution) {
        segments.push(substitution.text);
        index = substitution.endIndex;
      }
    } else if (char === "`") {
      const endIndex = segment.indexOf("`", index + 1);
      if (endIndex !== -1) {
        segments.push(segment.slice(index + 1, endIndex));
        index = endIndex;
      }
    }
  }
  return segments;
}

function readParenthesizedSubstitution(text, startIndex) {
  let depth = 1;
  let quote;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
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
    if (char === "'" || char === "\"") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          text: text.slice(startIndex, index),
          endIndex: index,
        };
      }
    }
  }
  return undefined;
}

function shellTokens(segment) {
  const tokens = [];
  let current = "";
  let quote;
  let escaped = false;
  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };
  for (const char of segment) {
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
    } else if (/\s/.test(char)) {
      pushCurrent();
    } else {
      current += char;
    }
  }
  pushCurrent();
  return tokens;
}

function shellWrappedCommand(tokens) {
  const index = executableIndex(tokens);
  if (index === -1 || !["bash", "sh", "zsh"].includes(commandName(tokens[index]))) {
    return undefined;
  }
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (!token.startsWith("-")) {
      return undefined;
    }
    if (!token.startsWith("--") && token.slice(1).includes("c")) {
      const commandIndex = tokens[cursor + 1] === "--" ? cursor + 2 : cursor + 1;
      return tokens.slice(commandIndex).join(" ");
    }
  }
  return undefined;
}

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
  if (!value || value.startsWith("--")) {
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
