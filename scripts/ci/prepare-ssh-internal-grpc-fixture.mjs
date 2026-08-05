import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, isIP, Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const REMOTE_PASSWORD_FILE = "/run/secrets/ydb-root-password";
const DYNAMIC_AUTH_DESTINATION = "/run/local-ydb/dynamic-node-auth.pb";
const CONTAINER_DOCKER_SOCKET = "/var/run/docker.sock";
const FORWARDED_YDB_ENVIRONMENT = new Set([
  "GRPC_PORT",
  "GRPC_TLS_PORT",
  "MON_PORT",
  "YDB_ANONYMOUS_CREDENTIALS",
  "YDB_FEATURE_FLAGS",
  "YDB_GRPC_ENABLE_TLS",
  "YDB_LOCAL_SURVIVE_RESTART",
]);

export async function prepareSshInternalGrpcFixture(env = process.env) {
  const prefix = requiredEnv(env, "LOCAL_YDB_CONTAINER_PREFIX");
  const image = requiredEnv(env, "LOCAL_YDB_IMAGE");
  const database = requiredEnv(env, "LOCAL_YDB_DATABASE");
  const rootUser = requiredEnv(env, "LOCAL_YDB_USER");
  const rootPasswordFile = requiredEnv(env, "LOCAL_YDB_PASSWORD_FILE");
  const staticPort = endpointPort(requiredEnv(env, "LOCAL_YDB_STATIC_ENDPOINT"));
  const dynamicPort = endpointPort(requiredEnv(env, "LOCAL_YDB_ENDPOINT"));
  const staticContainer = `${prefix}-static`;
  const dynamicContainer = `${prefix}-dynamic`;
  const sshContainer = `${prefix}-ssh`;
  const sshImage = `${prefix}-ssh-fixture:issue-120`;
  const network = `${prefix}-net`;
  const volume = `${prefix}-data`;

  assertSafeDockerName(prefix, "LOCAL_YDB_CONTAINER_PREFIX");
  await assertRegularFile(rootPasswordFile, "LOCAL_YDB_PASSWORD_FILE");
  const dockerSocketSource = await resolveDockerSocket(env);
  const fixtureDir = await mkdtemp(join(tmpdir(), "local-ydb-ssh-fixture-"));
  const state = {
    fixtureDir,
    sshContainer,
    sshContainerCreated: false,
    sshImage,
    sshImageCreated: false,
  };

  try {
    await assertDockerResourceAbsent("container", sshContainer);
    await assertDockerResourceAbsent("image", sshImage);

    const [staticInspect, dynamicInspect] = await Promise.all([
      inspectContainer(staticContainer),
      inspectContainer(dynamicContainer),
    ]);
    validateYdbContainer(staticInspect, {
      expectedName: staticContainer,
      expectedImage: image,
      expectedVolume: volume,
      expectedVolumeReadOnly: false,
    });
    validateYdbContainer(dynamicInspect, {
      expectedName: dynamicContainer,
      expectedImage: image,
      expectedVolume: volume,
      expectedVolumeReadOnly: true,
    });
    assertSharedNetworkNamespace(dynamicInspect, staticInspect, staticContainer);
    configuredNetworkAddress(staticInspect, network);

    const staticEnv = selectedYdbEnvironment(staticInspect, staticPort);
    const dynamicEnv = selectedYdbEnvironment(dynamicInspect, dynamicPort);
    const dynamicCommand = stringArray(dynamicInspect.Config?.Cmd, "dynamic Config.Cmd");
    const dynamicEntrypoint = stringArray(
      dynamicInspect.Config?.Entrypoint,
      "dynamic Config.Entrypoint",
    );
    if (dynamicEntrypoint.length !== 1 || dynamicEntrypoint[0] !== "/bin/bash") {
      throw new Error("The live dynamic container uses an unexpected entrypoint.");
    }
    if (
      dynamicCommand.length !== 2
      || dynamicCommand[0] !== "-lc"
      || !dynamicCommand[1]?.includes(`--auth-token-file ${DYNAMIC_AUTH_DESTINATION}`)
    ) {
      throw new Error("The live dynamic container uses an unexpected command.");
    }
    const dynamicAuthSource = await validatedDynamicAuthSource(
      dynamicInspect,
      rootPasswordFile,
    );
    const password = await readFile(rootPasswordFile);

    await run("docker", ["container", "rm", "--force", dynamicContainer]);
    await run("docker", ["container", "rm", "--force", staticContainer]);
    await run("docker", [
      "run", "-d",
      "--name", staticContainer,
      "--no-healthcheck",
      "--network", network,
      "--restart", "no",
      "--volume", `${volume}:/ydb_data`,
      ...environmentArgs(staticEnv),
      image,
    ]);

    await waitForAuthenticatedScheme(
      "static database metadata",
      staticContainer,
      staticPort,
      "/local",
      rootUser,
      password,
    );
    await assertAnonymousSchemeDenied(staticContainer, staticPort, "/local");

    await run("docker", [
      "run", "-d",
      "--name", dynamicContainer,
      "--no-healthcheck",
      "--network", `container:${staticContainer}`,
      "--restart", "no",
      "--volume", `${volume}:/ydb_data:ro`,
      "--mount", bindMount(dynamicAuthSource, DYNAMIC_AUTH_DESTINATION, true),
      ...environmentArgs(dynamicEnv),
      "--entrypoint", dynamicEntrypoint[0],
      image,
      ...dynamicCommand,
    ]);

    await waitForAuthenticatedScheme(
      "tenant database metadata",
      staticContainer,
      dynamicPort,
      database,
      rootUser,
      password,
    );
    await assertAnonymousSchemeDenied(staticContainer, dynamicPort, database);

    await assertNoPublishedPorts(staticContainer);
    await assertNoPublishedPorts(dynamicContainer);
    await assertPortClosed(staticPort);
    await assertPortClosed(dynamicPort);

    const staticAddress = configuredNetworkAddress(
      await inspectContainer(staticContainer),
      network,
    );
    const identityFile = join(fixtureDir, "id_ed25519");
    const publicKeyFile = `${identityFile}.pub`;
    const authorizedKeysFile = join(fixtureDir, "authorized_keys");
    const sshdConfigFile = join(fixtureDir, "sshd_config");
    const knownHostsFile = join(fixtureDir, "known_hosts");
    const sshBin = join(fixtureDir, "bin");
    const sshWrapper = join(sshBin, "ssh");
    const sshPort = await allocateLocalPort();

    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identityFile]);
    await writeFile(
      authorizedKeysFile,
      `${(await readFile(publicKeyFile, "utf8")).trim()}\n`,
      { mode: 0o600 },
    );
    await chmod(identityFile, 0o600);
    await mkdir(sshBin, { mode: 0o700 });
    await writeFile(sshdConfigFile, [
      "Port 22",
      "ListenAddress 0.0.0.0",
      "AuthorizedKeysFile /root/.ssh/authorized_keys",
      "AuthenticationMethods publickey",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "ChallengeResponseAuthentication no",
      "PubkeyAuthentication yes",
      "PermitRootLogin prohibit-password",
      "UsePAM no",
      "StrictModes no",
      "AllowUsers root",
      "AllowTcpForwarding local",
      "AllowAgentForwarding no",
      "GatewayPorts no",
      "PermitTTY no",
      "X11Forwarding no",
      `PermitOpen ${staticAddress}:${staticPort} ${staticAddress}:${dynamicPort}`,
      "LogLevel ERROR",
      "",
    ].join("\n"), { mode: 0o600 });

    const dockerfile = resolve("scripts/ci/Dockerfile.ssh-fixture");
    await run("docker", [
      "build",
      "--pull",
      "--file", dockerfile,
      "--tag", sshImage,
      dirname(dockerfile),
    ]);
    state.sshImageCreated = true;
    await run("docker", [
      "run", "-d",
      "--name", sshContainer,
      "--network", network,
      "--restart", "no",
      "--publish", `127.0.0.1:${sshPort}:22`,
      "--mount", bindMount(dockerSocketSource, CONTAINER_DOCKER_SOCKET, false),
      "--mount", bindMount(authorizedKeysFile, "/root/.ssh/authorized_keys", true),
      "--mount", bindMount(sshdConfigFile, "/etc/ssh/sshd_config", true),
      "--mount", bindMount(rootPasswordFile, REMOTE_PASSWORD_FILE, true),
      sshImage,
    ]);
    state.sshContainerCreated = true;

    let hostKeys = "";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const scan = await run(
        "ssh-keyscan",
        ["-T", "2", "-p", String(sshPort), "-H", "127.0.0.1"],
        { allowFailure: true },
      );
      if (scan.ok && scan.stdout.trim()) {
        hostKeys = scan.stdout;
        break;
      }
      await delay(100);
    }
    if (!hostKeys) {
      throw new Error("The temporary SSH container did not publish a host key.");
    }
    await writeFile(knownHostsFile, `${hostKeys.trim()}\n`, { mode: 0o600 });
    const sshExecutable = await resolveExecutable("ssh");
    const sshWrapperCommand = [
      "exec",
      shellQuote(sshExecutable),
      "-F /dev/null",
      `-o UserKnownHostsFile=${shellQuote(knownHostsFile)}`,
      "-o GlobalKnownHostsFile=/dev/null",
      "-o StrictHostKeyChecking=yes",
      "-o IdentitiesOnly=yes",
      '"$@"',
    ].join(" ");
    await writeFile(sshWrapper, [
      "#!/bin/sh",
      sshWrapperCommand,
      "",
    ].join("\n"), { mode: 0o700 });

    const remoteSmokeCommand = [
      `test -r ${shellQuote(REMOTE_PASSWORD_FILE)}`,
      `docker inspect --type container ${shellQuote(staticContainer)} >/dev/null`,
    ].join(" && ");
    await run("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-p", String(sshPort),
      "-i", identityFile,
      "root@127.0.0.1",
      "bash", "-lc", shellQuote(remoteSmokeCommand),
    ], { env: isolatedSshEnv(env, sshBin) });

    return {
      ...state,
      database,
      image,
      rootUser,
      localPasswordFile: rootPasswordFile,
      remotePasswordFile: REMOTE_PASSWORD_FILE,
      staticContainer,
      dynamicContainer,
      network,
      volume,
      staticGrpcPort: staticPort,
      dynamicGrpcPort: dynamicPort,
      staticTargetAddress: staticAddress,
      sshPort,
      sshUser: "root",
      identityFile,
      sshBin,
    };
  } catch (error) {
    try {
      await cleanupSshInternalGrpcFixture(state);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "SSH Docker-internal gRPC fixture preparation and cleanup failed.",
      );
    }
    throw error;
  }
}

export async function cleanupSshInternalGrpcFixture(fixture) {
  if (fixture.sshContainerCreated) {
    await run(
      "docker",
      ["container", "rm", "--force", fixture.sshContainer],
      { allowFailure: true },
    );
  }
  if (fixture.sshImageCreated) {
    await run(
      "docker",
      ["image", "rm", fixture.sshImage],
      { allowFailure: true },
    );
  }
  await rm(fixture.fixtureDir, { recursive: true, force: true });

  const [containerExists, imageExists] = await Promise.all([
    dockerResourceExists("container", fixture.sshContainer),
    dockerResourceExists("image", fixture.sshImage),
  ]);
  if (containerExists || imageExists) {
    throw new Error("The temporary SSH fixture did not clean up completely.");
  }
}

async function inspectContainer(container) {
  const result = await run("docker", ["inspect", "--type", "container", container]);
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`docker inspect returned invalid JSON for ${container}.`);
  }
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new Error(`docker inspect returned an unexpected result for ${container}.`);
  }
  return value[0];
}

function validateYdbContainer(inspect, expected) {
  const name = typeof inspect.Name === "string" ? inspect.Name.replace(/^\//, "") : "";
  if (name !== expected.expectedName || inspect.Config?.Image !== expected.expectedImage) {
    throw new Error("The live YDB container does not match the requested fixture.");
  }
  const mounts = arrayOfRecords(inspect.Mounts, "container Mounts");
  const dataMount = mounts.find((mount) => mount.Destination === "/ydb_data");
  if (
    dataMount?.Type !== "volume"
    || dataMount.Name !== expected.expectedVolume
    || dataMount.RW !== !expected.expectedVolumeReadOnly
  ) {
    throw new Error("The live YDB data mount does not match the requested fixture.");
  }
}

function assertSharedNetworkNamespace(dynamicInspect, staticInspect, staticContainer) {
  const networkMode = dynamicInspect.HostConfig?.NetworkMode;
  if (typeof networkMode !== "string" || !networkMode.startsWith("container:")) {
    throw new Error("The live dynamic container does not share a container namespace.");
  }
  const reference = networkMode.slice("container:".length).replace(/^\//, "");
  const staticId = typeof staticInspect.Id === "string" ? staticInspect.Id : "";
  const staticName = typeof staticInspect.Name === "string"
    ? staticInspect.Name.replace(/^\//, "")
    : "";
  if (!(
    reference === staticId
    || (reference.length >= 12 && staticId.startsWith(reference))
    || reference === staticName
    || reference === staticContainer
  )) {
    throw new Error("The live dynamic container shares an unexpected namespace.");
  }
}

async function validatedDynamicAuthSource(dynamicInspect, rootPasswordFile) {
  const mounts = arrayOfRecords(dynamicInspect.Mounts, "dynamic Mounts");
  const authMount = mounts.find((mount) => mount.Destination === DYNAMIC_AUTH_DESTINATION);
  if (
    authMount?.Type !== "bind"
    || authMount.RW !== false
    || typeof authMount.Source !== "string"
    || basename(authMount.Source) !== "dynamic-node-auth.pb"
  ) {
    throw new Error("The authenticated dynamic-node mount is missing or unsafe.");
  }
  const [authSource, passwordSource] = await Promise.all([
    realpath(authMount.Source),
    realpath(rootPasswordFile),
  ]);
  if (dirname(authSource) !== dirname(passwordSource)) {
    throw new Error("The authenticated dynamic-node mount is outside the action auth directory.");
  }
  await assertRegularFile(authSource, "dynamic-node auth token");
  return authSource;
}

function configuredNetworkAddress(inspect, network) {
  const networkSettings = inspect.NetworkSettings?.Networks?.[network];
  const address = networkSettings?.IPAddress;
  if (typeof address !== "string" || isIP(address) !== 4) {
    throw new Error("The static container has no IPv4 address in the fixture network.");
  }
  return address;
}

function selectedYdbEnvironment(inspect, expectedGrpcPort) {
  const selected = stringArray(inspect.Config?.Env, "Config.Env").filter((entry) => {
    const separator = entry.indexOf("=");
    return separator > 0 && FORWARDED_YDB_ENVIRONMENT.has(entry.slice(0, separator));
  });
  const grpcPorts = selected.filter((entry) => entry.startsWith("GRPC_PORT="));
  if (
    grpcPorts.length !== 1
    || grpcPorts[0] !== `GRPC_PORT=${expectedGrpcPort}`
  ) {
    throw new Error("The live YDB container uses an unexpected gRPC port.");
  }
  return selected;
}

function environmentArgs(environment) {
  return environment.flatMap((entry) => ["--env", entry]);
}

async function waitForAuthenticatedScheme(
  label,
  container,
  port,
  database,
  user,
  password,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await run("docker", [
      "exec", "-i", container,
      "/ydb",
      "-e", `grpc://localhost:${port}`,
      "-d", database,
      "--user", user,
      "--password-file", "/dev/stdin",
      "scheme", "ls", database,
    ], { allowFailure: true, input: password });
    if (result.ok) {
      return;
    }
    await delay(1_000);
  }
  throw new Error(`${label} did not become ready.`);
}

async function assertNoPublishedPorts(container) {
  const result = await run("docker", ["port", container]);
  if (result.stdout.trim()) {
    throw new Error(`${container} still has a published port.`);
  }
}

async function assertAnonymousSchemeDenied(container, port, database) {
  const result = await run("docker", [
    "exec", container,
    "/ydb",
    "-e", `grpc://localhost:${port}`,
    "-d", database,
    "scheme", "ls", database,
  ], { allowFailure: true });
  if (result.ok) {
    throw new Error("The authenticated YDB fixture accepted anonymous access.");
  }
}

async function assertPortClosed(port) {
  const open = await new Promise((resolvePromise) => {
    const socket = new Socket();
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
  if (open) {
    throw new Error(`Host loopback port ${port} is still reachable.`);
  }
}

async function allocateLocalPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("Failed to allocate a temporary SSH port."));
        return;
      }
      server.close((error) => error
        ? rejectPromise(error)
        : resolvePromise(address.port));
    });
  });
}

async function assertDockerResourceAbsent(type, name) {
  if (await dockerResourceExists(type, name)) {
    throw new Error(`Refusing to replace an existing Docker ${type} for the SSH fixture.`);
  }
}

async function dockerResourceExists(type, name) {
  if (type === "container") {
    const result = await run("docker", [
      "container", "ls", "--all",
      "--filter", `name=^/${name}$`,
      "--format", "{{.Names}}",
    ]);
    return result.stdout.split(/\r?\n/).some((entry) => entry === name);
  }
  if (type === "image") {
    const result = await run("docker", [
      "image", "ls",
      "--filter", `reference=${name}`,
      "--format", "{{.Repository}}:{{.Tag}}",
    ]);
    return result.stdout.split(/\r?\n/).some((entry) => entry === name);
  }
  throw new Error(`Unsupported Docker resource type: ${type}.`);
}

async function assertRegularFile(path, label) {
  let value;
  try {
    value = await stat(path);
  } catch {
    throw new Error(`${label} must reference an existing file.`);
  }
  if (!value.isFile()) {
    throw new Error(`${label} must reference a regular file.`);
  }
}

async function assertSocket(path) {
  let value;
  try {
    value = await stat(path);
  } catch {
    throw new Error("The Docker socket required by the SSH fixture is unavailable.");
  }
  if (!value.isSocket()) {
    throw new Error("The Docker socket required by the SSH fixture is invalid.");
  }
}

async function resolveDockerSocket(env) {
  let endpoint = env.DOCKER_HOST;
  if (!endpoint) {
    const result = await run(
      "docker",
      ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      { env },
    );
    try {
      endpoint = JSON.parse(result.stdout);
    } catch {
      throw new Error("The active Docker context returned an invalid endpoint.");
    }
  }
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///")) {
    throw new Error("The SSH fixture requires a local Unix-socket Docker context.");
  }
  const socketPath = endpoint.slice("unix://".length);
  await assertSocket(socketPath);
  return realpath(socketPath);
}

function bindMount(source, destination, readOnly) {
  return [
    "type=bind",
    `src=${source}`,
    `dst=${destination}`,
    ...(readOnly ? ["readonly"] : []),
  ].join(",");
}

async function resolveExecutable(name) {
  const result = await run("which", [name]);
  const executable = result.stdout.trim();
  if (!executable) {
    throw new Error(`${name} is unavailable.`);
  }
  const resolved = await realpath(executable);
  await assertRegularFile(resolved, name);
  return resolved;
}

function isolatedSshEnv(env, sshBin) {
  const isolated = {
    ...env,
    PATH: `${sshBin}:${env.PATH ?? ""}`,
  };
  delete isolated.SSH_AUTH_SOCK;
  return isolated;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", rejectPromise);
    child.once("close", (exitCode) => {
      const result = {
        ok: exitCode === 0,
        stdout: Buffer.concat(stdout).toString("utf8"),
      };
      if (!result.ok && !options.allowFailure) {
        rejectPromise(new Error(`${command} failed with exit code ${exitCode}.`));
      } else {
        resolvePromise(result);
      }
    });
    child.stdin.end(options.input);
  });
}

function endpointPort(endpoint) {
  const port = Number(new URL(endpoint).port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Endpoint does not include a valid port: ${endpoint}`);
  }
  return port;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
}

function arrayOfRecords(value, label) {
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
    throw new Error(`${label} must be an array of objects.`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSafeDockerName(value, label) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,71}$/.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
}

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
