import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import { decode, encode } from "@toon-format/toon";
import { countTokens } from "gpt-tokenizer";

const fixtures = [
  {
    name: "inventory",
    result: {
      summary: "Found 3 Docker containers and 1 Docker volumes for profile local.",
      profile: publicProfile(),
      containers: [
        dockerContainer("a1", "ydb-local", "running", "Up 2 minutes", "8765/tcp"),
        dockerContainer("b2", "ydb-dyn-example", "running", "Up 2 minutes", "2135/tcp"),
        dockerContainer("c3", "sidecar", "exited", "Exited (0) 1 hour ago", ""),
      ],
      volumes: ["ydb-local-data"],
      inspect: [
        { Name: "/ydb-local", Config: { Image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6" } },
        { Name: "/ydb-dyn-example", Config: { Image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6" } },
      ],
    },
  },
  {
    name: "status_report",
    result: {
      summary: "Status report for local: tenant=ok, nodes=ok.",
      inventory: {
        summary: "Found 2 Docker containers and 1 Docker volumes for profile local.",
        profile: publicProfile(),
        containers: [
          dockerContainer("a1", "ydb-local", "running", "Up 2 minutes", "8765/tcp"),
          dockerContainer("b2", "ydb-dyn-example", "running", "Up 2 minutes", "2135/tcp"),
        ],
        volumes: ["ydb-local-data"],
        inspect: [],
      },
      auth: {
        summary: "Anonymous viewer whoami returned 200.",
        viewerWhoamiStatus: 200,
        anonymousCliOk: true,
        anonymousCliCommand: "docker exec ydb-local ydb --endpoint grpc://localhost:2136 scheme ls /local/example",
        anonymousCliStderr: "",
      },
      tenant: {
        summary: "Tenant /local/example metadata is reachable.",
        ok: true,
        command: "docker exec ydb-local ydb scheme ls /local/example",
        stdout: "table-a\n",
        stderr: "",
      },
      nodes: {
        summary: "Viewer returned 2 nodes.",
        ok: true,
        nodes: [
          { NodeId: 1, Host: "localhost", Port: 19001, SystemState: "Green" },
          { NodeId: 2, Host: "localhost", Port: 19002, SystemState: "Green" },
        ],
      },
    },
  },
  {
    name: "bootstrap_plan",
    result: {
      summary: "Bootstrap local-ydb topology for /local/example. Not executed because confirm=true was not provided.",
      executed: false,
      risk: "high",
      plannedCommands: [
        "docker image inspect ghcr.io/ydb-platform/local-ydb:26.1.1.6",
        "docker network inspect ydb-local >/dev/null 2>&1 || docker network create ydb-local",
        "docker volume inspect ydb-local-data >/dev/null 2>&1 || docker volume create ydb-local-data",
        "docker run --detach --name ydb-local --network ydb-local ghcr.io/ydb-platform/local-ydb:26.1.1.6",
        "sleep 5",
        "docker exec ydb-local ydbd admin database /local/example create ssd:1",
      ],
      rollback: ["docker rm -f ydb-dyn-example", "docker rm -f ydb-local", "docker volume rm ydb-local-data"],
      verification: [
        "scheme ls /local/example",
        "viewer capabilities reports GraphShardExists=true",
        "dynamic node appears in viewer/json/nodelist",
      ],
    },
  },
  {
    name: "scheme",
    result: {
      summary: "Scheme list /local/example was read.",
      ok: true,
      action: "list",
      path: "/local/example",
      command: "docker exec ydb-local ydb scheme ls /local/example -R -1",
      stdout: ".sys\nseries\nusers\n",
      stderr: "",
      stdoutBytes: 19,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      maxOutputBytes: 65536,
    },
  },
  {
    name: "permissions_plan",
    result: {
      summary: "Plan permissions grant for /local/example/dir. Not executed because confirm=true was not provided.",
      executed: false,
      risk: "medium",
      plannedCommands: [
        "docker exec ydb-local ydb scheme permissions grant -p ydb.generic.read -p ydb.access.grant /local/example/dir testuser",
      ],
      rollback: [
        "Review prior ACL state with local_ydb_permissions action=list before applying a reverse permission change.",
      ],
      verification: ["local_ydb_permissions action=list shows the expected ACL state for /local/example/dir"],
      action: "grant",
      path: "/local/example/dir",
      subject: "testuser",
      permissions: ["ydb.generic.read", "ydb.access.grant"],
    },
  },
  {
    name: "list_versions",
    result: {
      summary: "Listed 5 tags for ydb-platform/local-ydb from ghcr.io. Version tags are sorted newest first.",
      image: "ghcr.io/ydb-platform/local-ydb",
      registry: "ghcr.io",
      repository: "ydb-platform/local-ydb",
      tags: ["26.1.2.0", "26.1.1.7", "26.1.1.6", "25.4.1.1", "latest"],
      count: 5,
      truncated: false,
    },
  },
  {
    name: "nodes_check",
    result: {
      summary: "Viewer returned 3 nodes.",
      ok: true,
      nodes: [
        { NodeId: 1, Host: "localhost", Port: 19001, SystemState: "Green", Database: "/local" },
        { NodeId: 2, Host: "localhost", Port: 19002, SystemState: "Green", Database: "/local/example" },
        { NodeId: 3, Host: "localhost", Port: 19003, SystemState: "Yellow", Database: "/local/example" },
      ],
    },
  },
];

const rows = fixtures.map(measureFixture);
const totals = rows.reduce(
  (acc, row) => ({
    jsonBytes: acc.jsonBytes + row.jsonBytes,
    toonBytes: acc.toonBytes + row.toonBytes,
    jsonTokens: acc.jsonTokens + row.jsonTokens,
    toonTokens: acc.toonTokens + row.toonTokens,
    roundTrip: acc.roundTrip && row.roundTrip,
  }),
  { jsonBytes: 0, toonBytes: 0, jsonTokens: 0, toonTokens: 0, roundTrip: true },
);

printRows([
  ...rows,
  {
    name: "TOTAL",
    ...totals,
    byteDeltaPercent: percentDelta(totals.toonBytes, totals.jsonBytes),
    tokenDeltaPercent: percentDelta(totals.toonTokens, totals.jsonTokens),
  },
]);

function measureFixture(fixture) {
  const jsonText = JSON.stringify(fixture.result, null, 2);
  const toonText = encode(fixture.result);
  const jsonBytes = Buffer.byteLength(jsonText, "utf8");
  const toonBytes = Buffer.byteLength(toonText, "utf8");
  const jsonTokens = countTokens(jsonText);
  const toonTokens = countTokens(toonText);
  return {
    name: fixture.name,
    jsonBytes,
    toonBytes,
    byteDeltaPercent: percentDelta(toonBytes, jsonBytes),
    jsonTokens,
    toonTokens,
    tokenDeltaPercent: percentDelta(toonTokens, jsonTokens),
    roundTrip: isDeepStrictEqual(decode(toonText), JSON.parse(jsonText)),
  };
}

function printRows(inputRows) {
  const headings = ["fixture", "jsonB", "toonB", "byteDelta", "jsonTok", "toonTok", "tokenDelta", "roundTrip"];
  const dataRows = inputRows.map((row) => [
    row.name,
    String(row.jsonBytes),
    String(row.toonBytes),
    formatPercent(row.byteDeltaPercent),
    String(row.jsonTokens),
    String(row.toonTokens),
    formatPercent(row.tokenDeltaPercent),
    row.roundTrip ? "yes" : "no",
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...dataRows.map((row) => row[index].length)),
  );

  console.log(formatRow(headings, widths));
  console.log(formatRow(widths.map((width) => "-".repeat(width)), widths));
  for (const row of dataRows) {
    console.log(formatRow(row, widths));
  }
}

function formatRow(cells, widths) {
  return cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
}

function formatPercent(value) {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function percentDelta(next, base) {
  return base === 0 ? 0 : ((next - base) / base) * 100;
}

function publicProfile() {
  return {
    name: "local",
    image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6",
    tenantPath: "/local/example",
    rootDatabase: "/local",
    staticContainer: "ydb-local",
    dynamicContainer: "ydb-dyn-example",
    network: "ydb-local",
    volume: "ydb-local-data",
    monitoringBaseUrl: "http://localhost:8765",
  };
}

function dockerContainer(id, names, state, status, ports) {
  return {
    id,
    image: "ghcr.io/ydb-platform/local-ydb:26.1.1.6",
    names,
    state,
    status,
    ports,
    networks: "ydb-local",
  };
}
