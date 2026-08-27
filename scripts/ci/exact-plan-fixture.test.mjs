import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./verify-live-mcp-server.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("verify-live-mcp-server.mjs", source, ts.ScriptTarget.Latest, true);

test("live restart assertion binds recreation to the independently observed configured container ID", () => {
  // Source-only loading keeps npm test independent of a prior core build.
  const apiSource = readFileSync(new URL("../../packages/core/src/api-client.ts", import.meta.url), "utf8");
  const apiAst = ts.createSourceFile("api-client.ts", apiSource, ts.ScriptTarget.Latest, true);
  const quoteDeclaration = apiAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "shellQuote");
  assert.ok(quoteDeclaration);
  const quoteCode = ts.transpileModule(quoteDeclaration.getText(apiAst), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const shellQuote = runInNewContext(quoteCode + "\nshellQuote", { exports: {} }, { timeout: 1000 });
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "plansExactContainerRecreation");
  assert.ok(declaration, "missing exact-container recreation matcher");
  // Evaluate only the pure matcher; importing the live script would start Docker/YDB.
  const matches = runInNewContext("(" + declaration.getText(ast) + ")", { shellQuote }, { timeout: 1000 });
  const name = "configured-node-2";
  const id = "a".repeat(64);
  const failure = "printf '%s\\n' 'Reviewed Docker container identity changed.' >&2; exit 1";
  const guard = "expected_id=" + id + "\nactual_id=$(docker inspect --type container --format '{{.Id}}' " + name + " 2>/dev/null) || { " + failure + "; }";
  const equality = '\n[ "$actual_id" = "$expected_id" ] || { ' + failure + '; }';
  const removal = '\ndocker rm -f "$expected_id"\n';
  const creation = "created_id=$(docker create --name " + name + " fixture-image)";
  const command = script => "bash -lc " + shellQuote("set -euo pipefail\n" + script);
  const valid = guard + equality + removal + creation;
  assert.equal(matches({ plannedCommands: [command(valid)] }, name, id), true);
  for (const script of [
    valid.replace(id, "b".repeat(64)),
    valid.replace(" " + name + " 2>/dev/null)", " another-node 2>/dev/null)"),
    valid.replace(equality, ""),
    valid.replace(removal, "\ndocker rm -f " + name + "\n"),
    valid.replace(creation, "created_id=$(docker create --name another-node fixture-image)"),
    "not-a-guard-" + valid,
    guard + equality + "\n" + guard.replace(id, "b".repeat(64)) + equality + removal + creation,
    creation + "\n" + guard + equality + removal,
  ]) assert.equal(matches({ plannedCommands: [command(script)] }, name, id), false);
  assert.equal(matches({ plannedCommands: ["echo " + shellQuote(valid)] }, name, id), false);
  assert.equal(matches({ plannedCommands: [command(valid) + " extra-argument"] }, name, id), false);
  assert.equal(matches({ plannedCommands: [command(guard + equality), command(removal + creation)] }, name, id), false);
  assert.equal(matches({ plannedCommands: [] }, name, id), false);
  assert.equal(matches({}, name, id), false);
  assert.match(source, /plansExactContainerRecreation\(restartPlan, configuredNodeTwo, restartingContainerId\)/);
  assert.match(source, /restartingContainerId = restartingFixture\.stdout\.trim\(\)/);
  assert.match(source, /restartingContainerId\.startsWith\(restartingNode\.id\)/);
  assert.ok(source.includes('!plannedCommandsText(restartPlan).includes(".State.Running")'));
  assert.ok(source.includes('findContainer(afterRestart, configuredNodeTwo)?.id !== restartingNode.id'));
  assert.ok(source.includes('oneOffAfter?.id === oneOffBefore.id'));
  assert.doesNotMatch(readFileSync(new URL(import.meta.url), "utf8"), /\bfrom\s+["']@local-ydb-toolkit\/core["']/);
});
