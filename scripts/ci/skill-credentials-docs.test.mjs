import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const references = new URL("../../skills/local-ydb/references/", import.meta.url);
const password = 'fixture-only "quote" \\backslash Юникод with spaces ';
const token = "fixture-only-ydb-token";
const cookie = "fixture-only-session-cookie";

function bashBlocks(markdown) {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);
}

async function reference(name) {
  return readFile(new URL(name, references), "utf8");
}

function run(command, args, { cwd, env = {}, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env, PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function assertNoSecrets(result, args = []) {
  for (const secret of [password, token, cookie]) {
    assert.ok(!result.stdout.includes(secret), "secret in stdout");
    assert.ok(!result.stderr.includes(secret), "secret in stderr");
    assert.ok(args.every((argument) => !argument.includes(secret)), "secret in argv");
  }
}

test("argv leak detection rejects unescaped secrets, including quotes and backslashes", () => {
  for (const secret of [password, token, cookie]) {
    assert.throws(() => assertNoSecrets({ stdout: "", stderr: "" }, ["--data", secret]));
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ydb-doc-credentials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("the old printf JSON contract fails for quotes and backslashes", async () => {
  const old = 'PASS=$(cat)\nprintf \'{"user":"root","password":"%s"}\' "$PASS"';
  const plain = await run("bash", ["-c", old], { input: "fixture-plain" });
  assert.equal(JSON.parse(plain.stdout).password, "fixture-plain");
  const quote = await run("bash", ["-c", old], { input: 'fixture"quote' });
  assert.throws(() => JSON.parse(quote.stdout), SyntaxError);
  const slash = await run("bash", ["-c", old], { input: "fixture\\test" });
  assert.notEqual(JSON.parse(slash.stdout).password, "fixture\\test");
});

async function runViewer(t, { failure, secret = password, basePath = "/" } = {}) {
  const root = await fixture(t);
  await writeFile(join(root, "password"), secret + "\n", { mode: 0o600 });
  await writeFile(join(root, "sudo"), `#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
(root / "argv.json").write_text(json.dumps(sys.argv[1:]))
if os.environ.get("FIXTURE_FAILURE") == "read":
    sys.stderr.write(${JSON.stringify(password)})
    sys.exit(17)
sys.stdout.buffer.write((root / "password").read_bytes())
`, { mode: 0o700 });
  const requests = [];
  const viewerPrefix = basePath.replace(/\/+$/, "");
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, cookie: request.headers.cookie, body });
    if (failure === "timeout") return;
    if (request.url === "/login") {
      if (failure === "login") {
        response.writeHead(401);
        response.end(password + token + cookie);
      } else {
        response.writeHead(200, { "Set-Cookie": `ydb_session_id=${cookie}; Path=/; HttpOnly` });
        response.end();
      }
    } else if (failure === "json") {
      response.end("not JSON: " + password);
    } else if (request.url.startsWith(`${viewerPrefix}/viewer/json/capabilities?`)) {
      response.writeHead(307, { Location: "/node/1/viewer/json/capabilities" });
      response.end();
    } else if (request.url === "/node/1/viewer/json/capabilities" || request.url.startsWith(`${viewerPrefix}/viewer/json/nodelist?`)) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(request.url.includes("capabilities")
        ? { Settings: { Database: { GraphShardExists: true } } }
        : [{ Id: 1, Address: "localhost", Port: 19002 }]));
    } else {
      response.writeHead(404);
      response.end("Unknown fixture route");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const block = bashBlocks(await reference("verification.md")).find((body) => body.startsWith("python3 - <<'PY'"));
  assert.ok(block, "documented Python viewer example exists");
  const source = block.slice("python3 - <<'PY'\n".length, -3)
    .replace('"http://127.0.0.1:8765"', JSON.stringify(`http://127.0.0.1:${server.address().port}${basePath}`))
    .replace('"/local/example"', '"/local/space & Юникод"');
  const guard = `import os, sys
def forbid_writes(event, args):
    if event == "open" and args[0] != os.devnull and args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
        raise RuntimeError("Viewer example must not write files")
sys.addaudithook(forbid_writes)
`;
  const args = ["-c", guard + source];
  const result = await run("python3", args, {
    cwd: root,
    env: { PATH: `${root}:${process.env.PATH}`, FIXTURE_ROOT: root, FIXTURE_FAILURE: failure ?? "" },
  });
  assert.ok((await readdir(root)).includes("argv.json"), result.stderr);
  const sudoArgs = JSON.parse(await readFile(join(root, "argv.json"), "utf8"));
  assert.deepEqual(sudoArgs, ["cat", "/path/to/root.password"]);
  assertNoSecrets(result, [...args, ...sudoArgs]);
  assert.deepEqual((await readdir(root)).sort(), ["argv.json", "password", "sudo"]);
  return { result, requests };
}

test("viewer sends encoded credentials, keeps cookies in memory and follows redirects", async (t) => {
  for (const secret of ["fixture-plain", password]) {
    const { result, requests } = await runViewer(t, { secret });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(requests[0].body), { user: "root", password: secret });
    assert.equal(requests.length, 4);
    for (const request of requests.slice(1)) assert.equal(request.cookie, `ydb_session_id=${cookie}`);
    for (const request of [requests[1], requests[3]]) {
      assert.equal(new URL(request.url, "http://localhost").searchParams.get("database"), "/local/space & Юникод");
    }
    assert.deepEqual(JSON.parse(result.stdout), {
      graphShardExists: true, count: 1, nodes: [{ id: 1, address: "localhost", port: 19002 }],
    });
  }
});

for (const basePath of ["/proxy/ydb", "/proxy/ydb/"]) {
  test(`viewer resolves login from origin and keeps prefix ${basePath}`, async (t) => {
    const { result, requests } = await runViewer(t, { basePath });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requests.map(({ url }) => new URL(url, "http://localhost").pathname), [
      "/login", "/proxy/ydb/viewer/json/capabilities", "/node/1/viewer/json/capabilities", "/proxy/ydb/viewer/json/nodelist",
    ]);
    assert.deepEqual(JSON.parse(requests[0].body), { user: "root", password });
    for (const request of requests.slice(1)) assert.equal(request.cookie, `ydb_session_id=${cookie}`);
    assert.equal(JSON.parse(result.stdout).graphShardExists, true);
    for (const request of [requests[1], requests[3]]) {
      assert.equal(new URL(request.url, "http://localhost").searchParams.get("database"), "/local/space & Юникод");
    }
  });
}

for (const [failure, requestCount] of [["read", 0], ["login", 1], ["json", 2], ["timeout", 1]]) {
  test(`viewer stops without exposing credentials on ${failure} failure`, async (t) => {
    const { result, requests } = await runViewer(t, { failure });
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(requests.length, requestCount);
    assert.match(result.stderr, /Authenticated viewer verification failed/);
  });
}

test("viewer rejects an empty password before login", async (t) => {
  const { result, requests } = await runViewer(t, { secret: "" });
  assert.equal(result.code, 1);
  assert.equal(requests.length, 0);
});

async function credentialExamples() {
  const examples = [];
  for (const name of ["auth-hardening.md", "storage-migration.md"]) {
    for (const block of bashBlocks(await reference(name))) {
      if (!block.includes("password_input=$(mktemp)")) continue;
      const inner = block.match(/-lc '([\s\S]*?)' <"\$password_input"/);
      assert.ok(inner, `container script in ${name}`);
      examples.push({
        name: `${name} ${examples.length + 1}`,
        source: inner[1].replaceAll("<tenant>", "fixture").replaceAll("<timestamp>", "fixture"),
        block: block.replaceAll("<tenant>", "fixture").replaceAll("<timestamp>", "fixture").replaceAll("<user>", "fixture"),
      });
    }
  }
  assert.equal(examples.length, 4);
  return examples;
}

async function shellFixture(t) {
  const root = await fixture(t);
  await writeFile(join(root, "keep"), "unrelated file");
  await writeFile(join(root, "cli.py"), `import json, os, pathlib, stat, sys, time
args = sys.argv[1:]
flag = "--password-file" if "--password-file" in args else "--token-file"
path = pathlib.Path(args[args.index(flag) + 1])
expected = ${JSON.stringify(password)} if flag == "--password-file" else ${JSON.stringify(token)}
record = {"args": args, "directory": str(path.parent), "directoryMode": stat.S_IMODE(path.parent.stat().st_mode), "fileMode": stat.S_IMODE(path.stat().st_mode), "correct": path.read_text().rstrip("\\n") == expected}
with open(os.environ["FIXTURE_REPORT"], "a") as report:
    report.write(json.dumps(record) + "\\n")
time.sleep(0.03)
if os.environ.get("FIXTURE_FAILURE") == "cli": sys.exit(17)
if "get-token" in args: print(${JSON.stringify(token)})
`, { mode: 0o600 });
  const prefix = `
function /ydb() {
  python3 "$FIXTURE_ROOT/cli.py" "$@"
  if [ -n "\${FIXTURE_SIGNAL:-}" ]; then kill -s "$FIXTURE_SIGNAL" "$$"; fi
}
function /ydbd() { /ydb "$@"; }
`;
  return { root, prefix };
}

async function runCredential(fixture, source, { signal = "", failure = "", input = password + "\n", report = "report.jsonl" } = {}) {
  return run("bash", ["--noprofile", "--norc", "-c", fixture.prefix + source], {
    cwd: fixture.root, input,
    env: { TMPDIR: fixture.root, FIXTURE_ROOT: fixture.root, FIXTURE_REPORT: join(fixture.root, report), FIXTURE_SIGNAL: signal, FIXTURE_FAILURE: failure },
  });
}

async function records(root, file = "report.jsonl") {
  try {
    return (await readFile(join(root, file), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function assertCredentialContract(root, result, observations) {
  assertNoSecrets(result, observations.flatMap(({ args }) => args));
  for (const record of observations) {
    assert.equal(record.correct, true, "credential bytes preserved");
    assert.equal(record.directoryMode, 0o700, "private credential directory");
    assert.equal(record.fileMode, 0o600, "private credential file");
    await assert.rejects(readFile(join(record.directory, "root.password")), { code: "ENOENT" });
    assert.ok(!(await readdir(root)).includes(record.directory.split("/").at(-1)), "credential directory removed");
  }
  assert.equal(await readFile(join(root, "keep"), "utf8"), "unrelated file");
}

test("all container examples preserve credentials and clean up on success, failure and signals", async (t) => {
  for (const example of await credentialExamples()) {
    for (const [scenario, options, code] of [
      ["success", {}, 0], ["CLI failure", { failure: "cli" }, 17],
      ["INT", { signal: "INT" }, 130], ["TERM", { signal: "TERM" }, 143],
      ["empty input", { input: "" }, 1],
    ]) {
      await t.test(`${example.name}: ${scenario}`, async (t) => {
        const fixture = await shellFixture(t);
        const result = await runCredential(fixture, example.source, options);
        assert.equal(result.code, code, result.stderr);
        const observations = await records(fixture.root);
        assert.equal(observations.length > 0, scenario !== "empty input");
        if (scenario === "CLI failure" || scenario === "INT" || scenario === "TERM") assert.equal(observations.length, 1);
        await assertCredentialContract(fixture.root, result, observations);
        assert.ok((await readdir(fixture.root)).every((name) => ["keep", "cli.py", "report.jsonl"].includes(name)), "no temporary directory survives empty input either");
      });
    }
  }
});

test("parallel container invocations have distinct credential directories", async (t) => {
  for (const example of await credentialExamples()) {
    const fixture = await shellFixture(t);
    const results = await Promise.all(["one.jsonl", "two.jsonl"].map((report) => runCredential(fixture, example.source, { report })));
    const observations = await Promise.all(["one.jsonl", "two.jsonl"].map((report) => records(fixture.root, report)));
    assert.notEqual(observations[0][0].directory, observations[1][0].directory);
    for (let index = 0; index < results.length; index++) {
      assert.equal(results[index].code, 0, results[index].stderr);
      await assertCredentialContract(fixture.root, results[index], observations[index]);
    }
  }
});

test("complete host pipelines pass credentials through stdin and stop on reader failure", async (t) => {
  for (const example of await credentialExamples()) {
    for (const readFailure of ["", "empty", "partial"]) {
      const fixture = await shellFixture(t);
      await writeFile(join(fixture.root, "input.password"), password + "\n", { mode: 0o600 });
      await writeFile(join(fixture.root, "record-args.py"), `import json, os, sys
with open(os.environ["FIXTURE_ARGV"], "a") as report:
    report.write(json.dumps(sys.argv[1:]) + "\\n")
`);
      const wrappers = `
function sudo() {
  python3 "$FIXTURE_ROOT/record-args.py" sudo "$@"
  if [ "$1" = "cat" ]; then
    if [ "$FIXTURE_READ_FAILURE" = "empty" ]; then return 23; fi
    cat "$FIXTURE_ROOT/input.password"
    if [ "$FIXTURE_READ_FAILURE" = "partial" ]; then return 23; fi
  else
    mkdir -p "\${!#}"
  fi
}
function docker() {
  python3 "$FIXTURE_ROOT/record-args.py" docker "$@"
  if [ "$1" = "inspect" ]; then printf "{}"; return; fi
  bash --noprofile --norc -c "$FIXTURE_PREFIX\${!#}"
}
`;
      const block = example.block.replaceAll("/path/to/root.password", '"$FIXTURE_ROOT/input.password"')
        .replaceAll("/path/to/ydb-dump", '"$FIXTURE_ROOT/dumps"');
      const result = await run("bash", ["--noprofile", "--norc", "-c", wrappers + block], {
        cwd: fixture.root,
        env: {
          TMPDIR: fixture.root, FIXTURE_ROOT: fixture.root, FIXTURE_PREFIX: fixture.prefix,
          FIXTURE_REPORT: join(fixture.root, "report.jsonl"), FIXTURE_ARGV: join(fixture.root, "argv.jsonl"),
          FIXTURE_READ_FAILURE: readFailure,
        },
      });
      assert.equal(result.code === 0, !readFailure, result.stderr);
      const observations = await records(fixture.root);
      assert.equal(observations.length > 0, !readFailure);
      await assertCredentialContract(fixture.root, result, observations);
      const calls = (await readFile(join(fixture.root, "argv.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      assert.ok(calls.some(([command]) => command === "sudo"));
      assert.equal(calls.some(([command]) => command === "docker"), !readFailure);
      assertNoSecrets(result, calls.flat());
      assert.ok((await readdir(fixture.root)).every((name) => ["keep", "cli.py", "report.jsonl", "argv.jsonl", "input.password", "record-args.py", "dumps"].includes(name)), "host temporary input was removed");
    }
  }
});

test("negative controls reject wide permissions and missing cleanup without keyword scanning", async (t) => {
  const { source } = (await credentialExamples())[0];
  for (const mutation of [
    source.replace("umask 077", "umask 022"),
    source.replace("trap cleanup EXIT", "# cleanup intentionally omitted"),
  ]) {
    const fixture = await shellFixture(t);
    const result = await runCredential(fixture, mutation);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(assertCredentialContract(fixture.root, result, await records(fixture.root)));
  }
  const fixture = await shellFixture(t);
  const safeWithComment = source.replace("umask 077", "# <!-- BEGIN MANAGED SQL SCENARIOS -->\numask 077");
  const result = await runCredential(fixture, safeWithComment);
  assert.equal(result.code, 0, result.stderr);
  await assertCredentialContract(fixture.root, result, await records(fixture.root));
});

test("the isolation check rejects a shared-directory negative control", async (t) => {
  const fixture = await shellFixture(t);
  const { source } = (await credentialExamples())[0];
  const mutation = source.replace("credentials_dir=$(mktemp -d)", 'credentials_dir="$TMPDIR/shared"\nmkdir -p "$credentials_dir"').replace("trap cleanup EXIT", "# deliberately retain shared directory");
  const directories = [];
  for (const report of ["one.jsonl", "two.jsonl"]) {
    const result = await runCredential(fixture, mutation, { report });
    assert.equal(result.code, 0, result.stderr);
    directories.push((await records(fixture.root, report))[0].directory);
  }
  assert.throws(() => assert.notEqual(directories[0], directories[1]));
});

test("skill entrypoint uses the origin login contract from the verification reference", async () => {
  const skill = await readFile(new URL("../SKILL.md", references), "utf8");
  assert.doesNotMatch(skill, /<monitoringBaseUrl>\/login/);
  assert.match(skill, /resolve `\/login` from the origin/);
  assert.match(skill, /preserve any configured path prefix for viewer requests/);
  assert.match(skill, /references\/verification\.md/);
});
