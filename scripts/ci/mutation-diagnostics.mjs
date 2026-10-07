import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

const MAX_STDERR_LENGTH = 2_048;

export function createDiagnosticRedactor(redact, redactions) {
  const orderedRedactions = redactions.filter(Boolean).sort((left, right) => right.length - left.length);
  return (stderr) => redact(stderr, orderedRedactions);
}

export function assertSuccessfulMutation(result, description, redactStderr) {
  assert(result.executed === true, `${description} did not execute.`);
  assert(
    Array.isArray(result.results) && result.results.length > 0,
    `${description} returned no command results.`,
  );
  const failedIndex = result.results.findIndex((commandResult) => commandResult.ok !== true);
  if (failedIndex === -1) {
    return;
  }
  const failed = result.results[failedIndex];
  const stderr = redactStderr(
    stripVTControlCharacters(typeof failed.stderr === "string" ? failed.stderr : ""),
  );
  const diagnostic = {
    commandIndex: failedIndex + 1,
    exitCode: Number.isInteger(failed.exitCode) ? failed.exitCode : null,
    timedOut: typeof failed.timedOut === "boolean" ? failed.timedOut : null,
    stderr: stderr.slice(0, MAX_STDERR_LENGTH),
    stderrTruncated: stderr.length > MAX_STDERR_LENGTH,
  };
  throw new Error(`${description} returned a failed command result: ${JSON.stringify(diagnostic)}`);
}
