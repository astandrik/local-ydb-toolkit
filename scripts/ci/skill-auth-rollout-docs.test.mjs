import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const auth = read("skills/local-ydb/references/auth-hardening.md");
const copies = [
  ["root", read("MCP_TOOL_TEST_SCENARIOS.md")],
  ["skill", read("skills/local-ydb/references/mcp-tool-scenarios.md")],
];

function section(source, title) {
  const marker = `## ${title}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing section: ${title}`);
  const end = source.indexOf("\n## ", start + marker.length);
  return source.slice(start + marker.length, end === -1 ? undefined : end).trim();
}

function calls(source) {
  return [...source.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .flatMap(([, block]) => block.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}

function rotationPredicate(source) {
  const rotation = section(source, "Scenario 10A: Root Password Rotation");
  const block = rotation.match(/```js\n([\s\S]*?)\n```/);
  assert.ok(block, "rotation success predicate is documented");
  return (result) => runInNewContext(`${block[1]}\nrotationSucceeded`, { rotation: result }, { timeout: 100 });
}

function checkScenario(source) {
  const rollout = section(source, "Scenario 9: Auth Rollout");
  const rotation = section(source, "Scenario 10A: Root Password Rotation");
  const verify = section(source, "Scenario 10: Post-Auth Verification");
  assert.ok(source.indexOf("## Scenario 9:") < source.indexOf("## Scenario 10A:"));
  assert.ok(source.indexOf("## Scenario 10A:") < source.indexOf("## Scenario 10:"));
  assert.deepEqual(calls(rollout).map(({ arguments: args }) => args.confirm), [false, true]);
  assert.deepEqual(calls(rotation), [false, true].map((confirm) => ({
    tool: "local_ydb_set_root_password",
    arguments: { profile: "ghcr261-auth", password: "<new-password>", confirm },
  })));
  const prerequisites = rotation.split("Calls:")[0];
  assert.match(prerequisites, /authConfigPath/);
  assert.match(prerequisites, /rootPasswordFile/);
  assert.match(prerequisites, /Scenario 9/);
  assert.match(verify.split("Calls:")[0], /Scenario 10A.*must pass/);
  assert.match(rotation, /old password must be rejected by a fresh login/);
  assert.match(rotation, /without existing cookies or tokens/);
  assert.match(rotation, /one negative login attempt/);
  assert.match(rotation, /lockout policy/);
  assert.match(rotation, /Keep the stack isolated/);
  assert.match(rotation, /Do not retry blindly or automatically restore the weak default password/);
  assert.match(verify, /new root password/);
  assert.ok(calls(verify).every(({ arguments: args }) => args.profile === "ghcr261-auth"));
  const succeeds = rotationPredicate(source);
  assert.equal(succeeds({ executed: true, results: Array.from({ length: 4 }, () => ({ ok: true })) }), true);
  for (const result of [
    { executed: false },
    { executed: true },
    { executed: true, results: [] },
    { executed: true, results: [{ ok: true }] },
    ...Array.from({ length: 4 }, (_, failed) => ({
      executed: true,
      results: Array.from({ length: 4 }, (_, index) => ({ ok: index !== failed })),
    })),
  ]) assert.equal(succeeds(result), false, JSON.stringify(result));
}

function checkRollout(source) {
  const credentials = section(source, "User Credentials");
  assert.match(credentials, /Never retain the known default root password outside an isolated test/);
  const rollout = section(source, "Rollout Sequence");
  const steps = [...rollout.matchAll(/^\d+\. (.+)$/gm)].map(([, step]) => step);
  const start = steps.findIndex((step) => step.startsWith("Start only the static node"));
  const rotate = steps.findIndex((step) => step.startsWith("Rotate the root password"));
  const verify = steps.findIndex((step) => step.startsWith("Verify rotation"));
  const admit = steps.findIndex((step) => step.startsWith("Admit clients"));
  assert.ok(start >= 0 && start < rotate && rotate < verify && verify < admit, "start → rotate → verify → admit");
  assert.ok(!steps.slice(0, verify).some((step) => /(?:start|admit|enable).*(?:clients|public monitoring)/i.test(step) && !step.includes("keep clients stopped")));
  const mcpSteps = steps.slice(steps.findIndex((step) => step.includes("local_ydb_dump_tenant")));
  const harden = mcpSteps.findIndex((step) => step.includes("local_ydb_apply_auth_hardening"));
  const plan = mcpSteps.findIndex((step) => step.includes("local_ydb_set_root_password(confirm=false"));
  const apply = mcpSteps.findIndex((step) => step.includes("local_ydb_set_root_password(confirm=true"));
  const final = mcpSteps.findIndex((step) => step.startsWith("verify rotation"));
  assert.ok(harden >= 0 && harden < plan && plan < apply && apply < final);
}

test("hardening requires rotation before client admission", () => checkRollout(auth));
for (const [name, source] of copies) {
  test(`${name} scenarios require plan, confirmed rotation and complete verification`, () => checkScenario(source));
}
test("both copies keep the auth rollout, rotation and acceptance contract synchronized", () => {
  for (const title of ["Scenario 9: Auth Rollout", "Scenario 10A: Root Password Rotation", "Scenario 10: Post-Auth Verification"]) {
    assert.equal(section(copies[0][1], title), section(copies[1][1], title));
  }
});

const scenarioMutations = [
  ["removed rotation", (source) => source.replace("## Scenario 10A: Root Password Rotation", "## Removed rotation")],
  ["plan-only rotation", (source) => source.replace(/^\{ "tool": "local_ydb_set_root_password".*"confirm": true.*\}\n/m, "")],
  ["no old-password rejection", (source) => source.replace("old password must be rejected by a fresh login", "old password need not be checked")],
  ["executed is not complete success", (source) => source.replace(/```js\n[\s\S]*?\n```/, "```js\nconst rotationSucceeded = rotation.executed === true;\n```")],
  ["final verification before rotation", (source) => {
    const start = source.indexOf("## Scenario 10A:");
    const end = source.indexOf("## Scenario 10:", start);
    const next = source.indexOf("## Scenario 11:", end);
    return source.slice(0, start) + source.slice(end, next) + source.slice(start, end) + source.slice(next);
  }],
];
for (const [name, mutate] of scenarioMutations) {
  test(`negative control: ${name}`, () => {
    checkScenario(copies[1][1]);
    const mutant = mutate(copies[1][1]);
    assert.notEqual(mutant, copies[1][1]);
    assert.throws(() => checkScenario(mutant));
  });
}
test("negative control: clients started before credential verification", () => {
  checkRollout(auth);
  const mutant = auth.replace("Start only the static node, then the dynamic nodes; keep clients stopped", "Start static and dynamic nodes and clients");
  assert.notEqual(mutant, auth);
  assert.throws(() => checkRollout(mutant));
});
