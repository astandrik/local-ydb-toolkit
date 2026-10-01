import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../../", import.meta.url);
const suppression = "// codeql[js/insufficient-password-hash]";

const cases = [
  {
    path: "packages/core/src/confirmation.ts",
    rationale: "// This is a keyed capability HMAC, not password hashing.",
    sink: ".update(nonce)",
  },
  {
    path: "packages/core/src/confirmation-inputs.ts",
    rationale: "// This digest is a stable content-input identifier, not a password verifier.",
    sink: ".update(confirmationContentKey(input), \"utf8\")",
  },
  {
    path: "packages/core/test/confirmed-content.test.ts",
    rationale: "// This test checks response disclosure of content digests, not password storage.",
    sink: "expect(serialized).not.toContain(createHash(\"sha256\").update(content).digest(\"hex\"));",
  },
];

test("CodeQL suppressions use exact standalone comments before their sinks", () => {
  for (const fixture of cases) {
    const lines = readFileSync(new URL(fixture.path, repositoryRoot), "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim());
    const index = lines.indexOf(suppression);

    assert.notEqual(index, -1, `${fixture.path} is missing ${suppression}`);
    assert.equal(lines[index - 1], fixture.rationale, `${fixture.path} is missing its suppression rationale`);
    assert.equal(lines[index + 1], fixture.sink, `${fixture.path} suppression is not directly before its sink`);
    assert.equal(lines.filter((line) => line === suppression).length, 1, `${fixture.path} has duplicate suppressions`);
    assert.equal(lines.some((line) => line.startsWith(`${suppression}:`)), false, `${fixture.path} appends text to the suppression token`);
  }
});
