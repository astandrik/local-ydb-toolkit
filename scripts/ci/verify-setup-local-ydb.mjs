import { callLocalYdbToolForTest } from "../../packages/mcp-server/dist/index.js";

const profileName = "ci-action";
const tenantPath = requiredEnv("LOCAL_YDB_DATABASE");
const dynamicEndpoint = requiredEnv("LOCAL_YDB_ENDPOINT");
const staticEndpoint = requiredEnv("LOCAL_YDB_STATIC_ENDPOINT");
const monitoringUrl = requiredEnv("LOCAL_YDB_MONITORING_URL");
const image = requiredEnv("LOCAL_YDB_IMAGE");
const containerPrefix = requiredEnv("LOCAL_YDB_CONTAINER_PREFIX");

const config = {
  defaultProfile: profileName,
  profiles: {
    [profileName]: {
      mode: "local",
      image,
      staticContainer: `${containerPrefix}-static`,
      dynamicContainer: `${containerPrefix}-dynamic`,
      tenantPath,
      volume: `${containerPrefix}-data`,
      network: `${containerPrefix}-net`,
      monitoringBaseUrl: monitoringUrl,
      ports: {
        staticGrpc: endpointPort(staticEndpoint, "LOCAL_YDB_STATIC_ENDPOINT"),
        dynamicGrpc: endpointPort(dynamicEndpoint, "LOCAL_YDB_ENDPOINT"),
        monitoring: endpointPort(monitoringUrl, "LOCAL_YDB_MONITORING_URL"),
      },
    },
  },
};

const statusReport = await callTool("local_ydb_status_report", { profile: profileName });
assert(statusReport.tenant?.ok === true, statusReport.tenant?.stderr || "tenant check failed");
assert(statusReport.nodes?.ok === true, statusReport.nodes?.error || "node check failed");

const scheme = await callTool("local_ydb_scheme", {
  profile: profileName,
  path: tenantPath,
  onePerLine: true,
});
assert(scheme.ok === true, scheme.stderr || "scheme list failed");

const graphshard = await callTool("local_ydb_graphshard_check", { profile: profileName });
assert(graphshard.ok === true, graphshard.tabletInfoError || "GraphShard check failed");

console.log("local-ydb-toolkit MCP tools verified the setup-local-ydb instance.");

async function callTool(name, args) {
  console.log(`::group::${name}`);
  const result = await callLocalYdbToolForTest(name, args, { config });
  console.log(JSON.stringify(summarize(result), null, 2));
  console.log("::endgroup::");
  return result;
}

function summarize(value) {
  return {
    summary: value?.summary,
    ok: value?.ok,
    tenantOk: value?.tenant?.ok,
    nodesOk: value?.nodes?.ok,
    graphShardExists: value?.graphShardExists,
    command: value?.command,
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function endpointPort(value, name) {
  const port = Number(new URL(value).port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must include a valid port: ${value}`);
  }
  return port;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
