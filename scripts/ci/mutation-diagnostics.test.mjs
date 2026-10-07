import assert from "node:assert/strict";
import test from "node:test";
import { assertSuccessfulMutation } from "./mutation-diagnostics.mjs";

const description = "fresh three-node declarative bootstrap";
const success = { ok: true, exitCode: 0, timedOut: false, stderr: "" };
const failure = {
  ok: false,
  exitCode: 125,
  timedOut: false,
  stderr: "Bind for 0.0.0.0:35001 failed: port is already allocated",
};

function failureDiagnostic(results, redactStderr = (text) => text) {
  let message;
  assert.throws(
    () => assertSuccessfulMutation({ executed: true, results }, description, redactStderr),
    (error) => {
      message = error.message;
      assert.ok(message.startsWith(`${description} returned a failed command result: `));
      return true;
    },
  );
  return { message, diagnostic: JSON.parse(message.slice(message.indexOf(": ") + 2)) };
}

test("preserves successful mutation behavior", () => {
  assert.equal(assertSuccessfulMutation({ executed: true, results: [success, success] }, description), undefined);
});

test("still rejects a plan that was not executed", () => {
  assert.throws(
    () => assertSuccessfulMutation({ executed: false, results: [success] }, description),
    { message: `${description} did not execute.` },
  );
});

for (const results of [undefined, []]) {
  test(`still rejects ${results ? "empty" : "missing"} command results`, () => {
    assert.throws(
      () => assertSuccessfulMutation({ executed: true, results }, description),
      { message: `${description} returned no command results.` },
    );
  });
}

test("identifies the first failed command after three successes", () => {
  const { diagnostic, message } = failureDiagnostic([
    success, success, success,
    { ...failure, command: "command-must-not-appear", stdout: "stdout-must-not-appear" },
    { ...failure, stderr: "later-failure-must-not-appear" },
  ]);

  assert.deepEqual(diagnostic, {
    commandIndex: 4,
    exitCode: 125,
    timedOut: false,
    stderr: failure.stderr,
    stderrTruncated: false,
  });
  assert.doesNotMatch(message, /must-not-appear/);
});

test("preserves timeout and null exit code", () => {
  const { diagnostic } = failureDiagnostic([{ ...failure, exitCode: null, timedOut: true, stderr: "" }]);

  assert.equal(diagnostic.commandIndex, 1);
  assert.equal(diagnostic.exitCode, null);
  assert.equal(diagnostic.timedOut, true);
  assert.equal(diagnostic.stderr, "");
});

test("uses the redactor output instead of raw stderr", () => {
  let observed;
  const { diagnostic, message } = failureDiagnostic([
    { ...failure, stderr: "fixture-secret /fixture-private/password-file" },
  ], (text) => {
    observed = text;
    return "<redacted> <redacted>";
  });

  assert.equal(observed, "fixture-secret /fixture-private/password-file");
  assert.equal(diagnostic.stderr, "<redacted> <redacted>");
  assert.doesNotMatch(message, /fixture-secret|fixture-private/);
});

test("removes terminal escapes before redaction and escapes workflow-command newlines", () => {
  let observed;
  const { diagnostic, message } = failureDiagnostic([{
    ...failure,
    stderr: "\u001b[31mcolored error\u001b[0m\n::error::untrusted-output",
  }], (text) => {
    observed = text;
    return text;
  });

  assert.equal(observed, "colored error\n::error::untrusted-output");
  assert.equal(diagnostic.stderr, observed);
  assert.doesNotMatch(message, /\u001b/);
  assert.equal(message.includes("\n"), false);
});

test("redacts a secret crossing the limit before truncating stderr", () => {
  const secret = "sensitive-value-crossing-the-limit";
  const { diagnostic, message } = failureDiagnostic([{
    ...failure,
    stderr: "x".repeat(2_044) + secret + "trailing-output".repeat(100),
  }], (text) => text.replaceAll(secret, "<redacted>"));

  assert.equal(diagnostic.stderr.length, 2_048);
  assert.equal(diagnostic.stderrTruncated, true);
  assert.doesNotMatch(message, /sens|trailing-output/);
});

test("does not mark stderr at the exact limit as truncated", () => {
  const { diagnostic } = failureDiagnostic([{ ...failure, stderr: "x".repeat(2_048) }]);

  assert.equal(diagnostic.stderr.length, 2_048);
  assert.equal(diagnostic.stderrTruncated, false);
});

test("does not serialize malformed diagnostic fields", () => {
  const { diagnostic, message } = failureDiagnostic([{
    ok: false,
    exitCode: { secret: "must-not-appear" },
    timedOut: "must-not-appear",
    stderr: { secret: "must-not-appear" },
  }]);

  assert.equal(diagnostic.exitCode, null);
  assert.equal(diagnostic.timedOut, null);
  assert.equal(diagnostic.stderr, "");
  assert.doesNotMatch(message, /must-not-appear/);
});
