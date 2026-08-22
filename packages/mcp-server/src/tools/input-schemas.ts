import type { Tool } from "@modelcontextprotocol/sdk/types.js";

function profileProperty(): { type: "string"; description: string } {
  return {
    type: "string",
    description:
      "Named profile from local-ydb.config.json. Defaults to config.defaultProfile.",
  };
}

function configPathProperty(): { type: "string"; minLength: number; description: string } {
  return {
    type: "string",
    minLength: 1,
    description:
      "Absolute path to an explicit local-ydb config file. Missing, unreadable, oversized, or invalid explicit files fail closed instead of using defaults.",
  };
}

function confirmProperty(action = "execute planned commands"): {
  type: "boolean";
  description: string;
} {
  return {
    type: "boolean",
    description:
      `Must be true together with the current plan's confirmationToken to ${action}. Omit or false for plan-only output.`,
  };
}

function confirmationTokenProperty(): {
  type: "string";
  minLength: number;
  maxLength: number;
  description: string;
} {
  return {
    type: "string",
    minLength: 1,
    maxLength: 256,
    description:
      "Ephemeral one-time token returned by the immediately preceding exact plan. Allowed only together with confirm=true; do not log or persist it.",
  };
}

export function profileSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
    },
    additionalProperties: false,
  };
}

export function logsSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["target"],
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      target: {
        type: "string",
        enum: ["static", "dynamic"],
        description: "Container role to read logs from: static node or primary dynamic tenant node.",
      },
      lines: {
        type: "integer",
        minimum: 1,
        description: "Number of recent log lines to read. Defaults to 200.",
      },
    },
    additionalProperties: false,
  };
}

export function healthcheckSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      databasePath: {
        type: "string",
        description:
          "YDB database path to check. Defaults to the configured tenant path; only the configured tenant path or root database path are accepted.",
      },
      noCache: {
        type: "boolean",
        description:
          "Pass --no-cache to force YDB to bypass cached healthcheck results.",
      },
      noMerge: {
        type: "boolean",
        description:
          "Pass --no-merge to keep individual YDB healthcheck issue records separate.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: 600_000,
        description:
          "Server-side YDB healthcheck timeout in milliseconds. Defaults to 120000.",
      },
      maxOutputBytes: {
        type: "integer",
        minimum: 1,
        maximum: 1_048_576,
        description:
          "Maximum UTF-8 bytes returned per raw stdout/stderr stream. Defaults to 65536.",
      },
      maxIssues: {
        type: "integer",
        minimum: 1,
        description:
          "Maximum number of issue_log entries returned in the issues field. Counts still cover the full response. Defaults to 100.",
      },
    },
    additionalProperties: false,
  };
}

export function schemeSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      action: {
        type: "string",
        enum: ["list", "describe"],
        description: "Scheme operation to run. Defaults to list.",
      },
      path: {
        type: "string",
        description:
          "Scheme path to inspect. Defaults to the configured tenant root.",
      },
      recursive: {
        type: "boolean",
        description: "For action=list, pass -R to recursively list subdirectories.",
      },
      long: {
        type: "boolean",
        description: "For action=list, pass -l for detailed object attributes.",
      },
      onePerLine: {
        type: "boolean",
        description: "For action=list, pass -1 to print one object per line.",
      },
      stats: {
        type: "boolean",
        description: "For action=describe, pass --stats.",
      },
      maxOutputBytes: {
        type: "integer",
        minimum: 1,
        maximum: 1_048_576,
        description:
          "Maximum UTF-8 bytes returned per stdout/stderr stream. Defaults to 65536.",
      },
    },
    additionalProperties: false,
  };
}

export function applySchemaSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["script"],
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      action: {
        type: "string",
        enum: ["validate", "apply"],
        description:
          "Schema operation to run. validate only checks the YQL DDL through the YDB SDK; apply validates first and executes only with confirm=true.",
      },
      databasePath: {
        type: "string",
        description:
          "YDB database path for SDK validation/application. Defaults to the configured tenant root; root database paths use the static gRPC port.",
      },
      script: {
        type: "string",
        minLength: 1,
        maxLength: 1_048_576,
        description:
          "YQL DDL script to validate or apply. Supports PRAGMA plus CREATE TABLE, ALTER TABLE, and DROP TABLE statements.",
      },
      confirm: {
        type: "boolean",
        description:
          "Must be true together with the current plan's confirmationToken to execute action=apply after SDK validation succeeds. Omit or false for validation plus plan-only output.",
      },
      confirmationToken: confirmationTokenProperty(),
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: 600_000,
        description:
          "SDK operation timeout in milliseconds. Defaults to 120000.",
      },
      maxOutputBytes: {
        type: "integer",
        minimum: 1,
        maximum: 1_048_576,
        description:
          "Maximum UTF-8 bytes returned per validation/execution issue stream. Defaults to 65536.",
      },
    },
    additionalProperties: false,
  };
}

const sqlPrimitiveNames = [
  "Bool",
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "Uint8",
  "Uint16",
  "Uint32",
  "Uint64",
  "Float",
  "Double",
  "String",
  "Utf8",
  "Json",
  "JsonDocument",
  "Yson",
  "Uuid",
  "Date",
  "Datetime",
  "Timestamp",
  "Interval",
  "TzDate",
  "TzDatetime",
  "TzTimestamp",
  "Date32",
  "Datetime64",
  "Timestamp64",
  "Interval64",
  "DyNumber",
] as const;

export function sqlSchema(): Tool["inputSchema"] {
  const typeRef = { $ref: "#/$defs/sqlParameterType" };
  return {
    type: "object",
    required: ["script"],
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      action: {
        type: "string",
        enum: ["query", "explain", "execute"],
        default: "query",
        description:
          "Managed YQL action. query uses SnapshotRO, explain returns plan/AST without execution, and execute always EXPLAIN-preflights before optional confirmed NoTx execution.",
      },
      script: {
        type: "string",
        minLength: 1,
        maxLength: 1_048_576,
        description:
          "Well-formed-Unicode YQL v1 script; lone UTF-16 surrogates are rejected. Parameter DECLARE statements are generated from parameters and prepended before execution.",
      },
      databasePath: {
        type: "string",
        minLength: 1,
        description:
          "Configured tenant or root database path. Defaults to the selected profile tenant path; root paths use the static gRPC port.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: 600_000,
        default: 120_000,
        description:
          "Single deadline in milliseconds shared by connection, session, preflight, execution, and cancellation.",
      },
      maxRows: {
        type: "integer",
        minimum: 1,
        maximum: 10_000,
        default: 100,
        description:
          "Maximum retained rows per result set. The first limit hit stops all further result capture: read-only execution is cancelled, while confirmed NoTx execution drains without capturing later output.",
      },
      maxOutputBytes: {
        type: "integer",
        minimum: 1,
        maximum: 1_048_576,
        default: 65_536,
        description:
          "Shared retained-output budget for issues, plan/AST, columns, and rows.",
      },
      parameters: {
        type: "object",
        maxProperties: 100,
        propertyNames: {
          pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
        },
        additionalProperties: {
          $ref: "#/$defs/sqlParameter",
        },
        description:
          "Typed YQL parameters keyed by bare name. The request is limited to 100 parameters, 1,000 descriptor nodes, 10,000 value nodes, and 1 MiB of serialized parameter data. Struct field names must be well-formed Unicode. Values use the documented JSON representation and are never echoed in response metadata. Json/JsonDocument numbers must be finite, integer values must be JavaScript safe integers, and negative zero is rejected because JSON encoding cannot preserve its sign.",
      },
      confirm: {
        type: "boolean",
        description:
          "Considered only for action=execute. Must be true together with the current plan's confirmationToken to send one NoTx execution after successful EXPLAIN; query remains SnapshotRO even when true.",
      },
      confirmationToken: confirmationTokenProperty(),
    },
    $defs: {
      sqlParameter: {
        oneOf: [{
          type: "object",
          required: ["type", "value"],
          properties: {
            type: typeRef,
            value: {
              description:
                "JSON value matching the declared YDB type; 64-bit integers, Decimal, and DyNumber use strings, Decimal also accepts canonical nan/inf/-inf, while String/Yson use canonical base64.",
            },
          },
          additionalProperties: false,
        }],
      },
      sqlParameterType: {
        oneOf: [
          {
            type: "object",
            required: ["kind", "name"],
            properties: {
              kind: { const: "primitive" },
              name: { type: "string", enum: sqlPrimitiveNames },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["kind", "precision", "scale"],
            properties: {
              kind: { const: "decimal" },
              precision: { type: "integer", minimum: 1, maximum: 35 },
              scale: {
                type: "integer",
                minimum: 0,
                maximum: 35,
                description: "Must not exceed precision.",
              },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["kind", "item"],
            properties: {
              kind: { const: "optional" },
              item: typeRef,
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["kind", "item"],
            properties: {
              kind: { const: "list" },
              item: typeRef,
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["kind", "items"],
            properties: {
              kind: { const: "tuple" },
              items: {
                type: "array",
                items: typeRef,
                maxItems: 1_000,
              },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["kind", "fields"],
            properties: {
              kind: { const: "struct" },
              fields: {
                type: "array",
                maxItems: 1_000,
                items: {
                  type: "object",
                  required: ["name", "type"],
                  properties: {
                    name: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Well-formed-Unicode Struct field name; lone UTF-16 surrogates are rejected.",
                    },
                    type: typeRef,
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["kind", "key", "value"],
            properties: {
              kind: { const: "dict" },
              key: typeRef,
              value: typeRef,
            },
            additionalProperties: false,
          },
        ],
      },
    },
    additionalProperties: false,
  };
}

const scalarSchema = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
  ],
};

const settingNameSchema = { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" };

const settingValueSchema = {
  oneOf: [
    ...scalarSchema.oneOf,
    {
      type: "object",
      required: ["token"],
      properties: {
        token: {
          type: "string",
          minLength: 1,
          pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
          description: "Bare YQL token value, for settings such as AUTO_PARTITIONING_BY_SIZE = ENABLED.",
        },
      },
      additionalProperties: false,
    },
  ],
};

const columnSchema = {
  type: "object",
  required: ["name", "type"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "Column name. The generator always backtick-quotes and escapes it in YQL.",
    },
    type: {
      type: "string",
      minLength: 1,
      description:
        "YDB primitive column type such as Uint64, Utf8, Timestamp, JsonDocument, or Decimal(precision, scale).",
    },
    notNull: {
      type: "boolean",
      description: "Emit NOT NULL for the column. Supported only for columns that are part of the CREATE TABLE primaryKey.",
    },
    default: {
      ...scalarSchema,
      description:
        "Optional DEFAULT value. The generator renders type-aware YQL defaults such as Utf8('x'), Uint64('1'), Date('2026-05-27'), or TRUE.",
    },
  },
  additionalProperties: false,
};

const alterAddColumnSchema = {
  ...columnSchema,
  description: "Column to add with ALTER TABLE. Only name and type are supported; NOT NULL and DEFAULT are rejected.",
  not: {
    anyOf: [
      { required: ["notNull"] },
      { required: ["default"] },
    ],
  },
};

const indexSchema = {
  type: "object",
  required: ["name", "columns"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "Index name. The generator always backtick-quotes and escapes it in YQL.",
    },
    columns: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
      description: "Index key columns, in order. For createTable, each must exist in columns.",
    },
    cover: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
      description: "Optional non-empty COVER columns for the index.",
    },
    global: {
      type: "boolean",
      description: "Emit GLOBAL for the index. Required for secondary and vector indexes.",
    },
    local: {
      type: "boolean",
      description: "Emit LOCAL for supported index types. Rejected for secondary and vector indexes in v1.",
    },
    unique: {
      type: "boolean",
      description: "Emit UNIQUE for the index. Unique indexes must be sync and are rejected for vector indexes.",
    },
    sync: {
      type: "string",
      enum: ["sync", "async"],
      description: "Emit SYNC or ASYNC for the index. unique and vector_kmeans_tree indexes require sync.",
    },
    using: {
      type: "string",
      enum: ["secondary", "vector_kmeans_tree"],
      description:
        "Optional index type. secondary is the default and is not rendered as USING secondary; vector_kmeans_tree requires a row-oriented GLOBAL SYNC non-unique index and complete vector WITH settings.",
    },
    with: {
      type: "object",
      propertyNames: settingNameSchema,
      additionalProperties: settingValueSchema,
      description:
        "Optional vector index WITH settings. Strings render as quoted YQL literals; vector_kmeans_tree requires vector_dimension, vector_type, distance or similarity, clusters, and levels.",
    },
  },
  additionalProperties: false,
  allOf: [
    {
      if: {
        required: ["using"],
        properties: {
          using: { const: "vector_kmeans_tree" },
        },
      },
      then: {
        required: ["global", "sync"],
        properties: {
          global: { const: true },
          local: { const: false },
          unique: { const: false },
          sync: { const: "sync" },
        },
      },
    },
    {
      if: {
        anyOf: [
          { not: { required: ["using"] } },
          {
            required: ["using"],
            properties: {
              using: { const: "secondary" },
            },
          },
        ],
      },
      then: {
        required: ["global"],
        properties: {
          global: { const: true },
          local: { const: false },
        },
        not: { required: ["with"] },
      },
    },
    {
      if: {
        required: ["unique"],
        properties: {
          unique: { const: true },
        },
      },
      then: {
        required: ["sync"],
        properties: {
          sync: { const: "sync" },
        },
      },
    },
  ],
};

const schemaStatementSchema = {
  oneOf: [
    {
      type: "object",
      required: ["kind", "tableName", "columns", "primaryKey"],
      properties: {
        kind: {
          type: "string",
          const: "createTable",
          description: "Generate a CREATE TABLE statement.",
        },
        tableName: {
          type: "string",
          minLength: 1,
          description: "Table name or relative YDB table path.",
        },
        ifNotExists: {
          type: "boolean",
          description: "Emit IF NOT EXISTS.",
        },
        columns: {
          type: "array",
          minItems: 1,
          items: columnSchema,
          description: "Columns for the new table.",
        },
        primaryKey: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          description: "Primary key columns, in order. Each must exist in columns.",
        },
        indexes: {
          type: "array",
          items: indexSchema,
          description: "Secondary indexes to define inside CREATE TABLE.",
        },
        partitionByHash: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          description:
            "Optional non-empty PARTITION BY HASH columns for column-oriented tables. Requires store: \"column\" and each partition column must be part of primaryKey.",
        },
        store: {
          type: "string",
          enum: ["row", "column"],
          description: "Optional table storage type rendered as STORE = ROW or STORE = COLUMN.",
        },
        with: {
          type: "object",
          propertyNames: settingNameSchema,
          additionalProperties: settingValueSchema,
          description: "Optional table WITH settings. Strings render as quoted YQL literals; use { token: \"ENABLED\" } for bare tokens. Use store instead of STORE in WITH settings.",
        },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["kind", "tableName", "actions"],
      properties: {
        kind: {
          type: "string",
          const: "alterTable",
          description: "Generate an ALTER TABLE statement.",
        },
        tableName: {
          type: "string",
          minLength: 1,
          description: "Table name or relative YDB table path.",
        },
        actions: {
          type: "array",
          minItems: 1,
          items: {
            oneOf: [
              {
                type: "object",
                required: ["kind", "column"],
                properties: {
                  kind: { type: "string", const: "addColumn" },
                  column: alterAddColumnSchema,
                },
                additionalProperties: false,
              },
              {
                type: "object",
                required: ["kind", "name"],
                properties: {
                  kind: { type: "string", const: "dropColumn" },
                  name: { type: "string", minLength: 1 },
                },
                additionalProperties: false,
              },
              {
                type: "object",
                required: ["kind", "index"],
                properties: {
                  kind: { type: "string", const: "addIndex" },
                  index: indexSchema,
                },
                additionalProperties: false,
              },
              {
                type: "object",
                required: ["kind", "name"],
                properties: {
                  kind: { type: "string", const: "dropIndex" },
                  name: { type: "string", minLength: 1 },
                },
                additionalProperties: false,
              },
            ],
          },
          description:
            "ALTER TABLE actions to render in order. Do not add an index on a column added or dropped in the same alterTable spec; use separate generate/apply cycles.",
        },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["kind", "tableName"],
      properties: {
        kind: {
          type: "string",
          const: "dropTable",
          description: "Generate a DROP TABLE statement.",
        },
        tableName: {
          type: "string",
          minLength: 1,
          description: "Table name or relative YDB table path.",
        },
      },
      additionalProperties: false,
    },
  ],
};

export function generateSchemaSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["statements"],
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      databasePath: {
        type: "string",
        description:
          "YDB database path to use when validate=true. Defaults to the configured tenant root.",
      },
      validate: {
        type: "boolean",
        description:
          "If true, validate the generated DDL through local_ydb_apply_schema action=validate. This tool never applies DDL.",
      },
      statements: {
        type: "array",
        minItems: 1,
        items: schemaStatementSchema,
        description:
          "Structured schema statement specs to render into YDB table DDL.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: 600_000,
        description:
          "SDK validation timeout in milliseconds when validate=true. Defaults to 120000.",
      },
      maxOutputBytes: {
        type: "integer",
        minimum: 1,
        maximum: 1_048_576,
        description:
          "Maximum UTF-8 bytes returned per validation issue stream when validate=true. Defaults to 65536.",
      },
    },
    additionalProperties: false,
  };
}

export function permissionsSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      action: {
        type: "string",
        enum: [
          "list",
          "grant",
          "revoke",
          "set",
          "clear",
          "chown",
          "set-inheritance",
          "clear-inheritance",
        ],
        description:
          "Permissions operation to run. Defaults to list, which is read-only and does not require confirm.",
      },
      path: {
        type: "string",
        description:
          "Scheme path to manage. Defaults to the configured tenant root.",
      },
      subject: {
        type: "string",
        description:
          "User or group subject for grant, revoke, and set actions.",
      },
      permissions: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
        description:
          "Permission names for grant, revoke, and set actions. Each item is passed as its own -p argument.",
      },
      owner: {
        type: "string",
        description: "New owner for action=chown.",
      },
      maxOutputBytes: {
        type: "integer",
        minimum: 1,
        maximum: 1_048_576,
        description:
          "For action=list, maximum UTF-8 bytes returned per stdout/stderr stream. Defaults to 65536.",
      },
      confirm: {
        type: "boolean",
        description:
          "Must be true together with the current plan's confirmationToken to execute mutating actions. Omit or false for plan-only output. Not required for action=list.",
      },
      confirmationToken: confirmationTokenProperty(),
    },
    additionalProperties: false,
  };
}

export function listVersionsSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      image: {
        type: "string",
        description:
          "GHCR or Docker Hub container image name to inspect. Defaults to ghcr.io/ydb-platform/local-ydb.",
      },
      pageSize: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Requested tags per registry page. Defaults to 100.",
      },
      maxPages: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description:
          "Maximum number of registry pages to fetch before truncating the result. Defaults to 10.",
      },
    },
    additionalProperties: false,
  };
}

export function pullImageSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty("start the background Docker pull"),
      confirmationToken: confirmationTokenProperty(),
      image: {
        type: "string",
        description:
          "Container image to pull. Defaults to the selected profile image.",
      },
    },
    additionalProperties: false,
  };
}

export function pullStatusSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["jobId"],
    properties: {
      jobId: {
        type: "string",
        description:
          "Background pull job id returned by local_ydb_pull_image.",
      },
    },
    additionalProperties: false,
  };
}

export function mutatingSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty(),
      confirmationToken: confirmationTokenProperty(),
    },
    additionalProperties: false,
  };
}

export function addDynamicNodesSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty(),
      confirmationToken: confirmationTokenProperty(),
      count: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description:
          "Number of additional dynamic nodes to add. Defaults to 1.",
      },
      startIndex: {
        type: "integer",
        minimum: 2,
        description:
          "Suffix for the first added container. It must be greater than profile.dynamicNodeCount. Defaults to profile.dynamicNodeCount + 1, producing <dynamicContainer>-<dynamicNodeCount + 1>.",
      },
      grpcPortStart: {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        description:
          "gRPC port for the first added node. Defaults to profile.dynamicGrpc + startIndex - 1.",
      },
      monitoringPortStart: {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        description:
          "Monitoring port for the first added node. Defaults to profile.dynamicMonitoring + startIndex - 1.",
      },
      icPortStart: {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        description:
          "Interconnect port for the first added node. Defaults to profile.dynamicIc + startIndex - 1.",
      },
    },
    additionalProperties: false,
  };
}

export function addStorageGroupsSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty(),
      confirmationToken: confirmationTokenProperty(),
      count: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "Number of storage groups to add. Defaults to 1.",
      },
      poolName: {
        type: "string",
        description:
          "Explicit storage pool name. Defaults to <tenantPath>:<storagePoolKind>.",
      },
    },
    additionalProperties: false,
  };
}

export function reduceStorageGroupsSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty(),
      confirmationToken: confirmationTokenProperty(),
      count: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description:
          "Number of storage groups to remove from the current tenant pool. Defaults to 1.",
      },
      dumpName: {
        type: "string",
        description:
          "Optional dump directory name under profile.dumpHostPath to preserve before rebuild.",
      },
      poolName: {
        type: "string",
        description:
          "Explicit storage pool name. Defaults to <tenantPath>:<storagePoolKind>.",
      },
    },
    additionalProperties: false,
  };
}

export function destroyStackSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty(),
      confirmationToken: confirmationTokenProperty(),
      removeBindMountPath: {
        type: "boolean",
        description:
          "Delete profile.bindMountPath when the profile uses a bind mount. Defaults to false.",
      },
      removeAuthArtifacts: {
        type: "boolean",
        description:
          "Delete explicit authConfigPath, dynamicNodeAuthTokenFile, and rootPasswordFile when configured. Defaults to false.",
      },
      removeDumpHostPath: {
        type: "boolean",
        description:
          "Delete profile.dumpHostPath. Defaults to false because it may be shared.",
      },
    },
    additionalProperties: false,
  };
}

export function removeDynamicNodesSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty(),
      confirmationToken: confirmationTokenProperty(),
      count: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description:
          "Number of dynamic nodes to remove when containers and nodeIds are omitted. Defaults to 1.",
      },
      startIndex: {
        type: "integer",
        minimum: 2,
        description:
          "Minimum suffix to consider removable. Without explicit containers or nodeIds, defaults to profile.dynamicNodeCount + 1 so configured suffixes are excluded. Explicit selectors default to 2. An explicit startIndex always overrides either default.",
      },
      containers: {
        type: "array",
        items: { type: "string" },
        description:
          "Explicit suffix dynamic-node container names to remove. Configured suffixes can be selected and become runtime drift; the profile's primary dynamicContainer remains protected.",
      },
      nodeIds: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        maxItems: 10,
        description:
          "Explicit YDB dynamic-node IDs to remove. IDs may resolve to configured or one-off suffix containers; the profile's primary dynamicContainer is not removable through this option.",
      },
    },
    additionalProperties: false,
  };
}

export function dumpSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty("dump the tenant"),
      confirmationToken: confirmationTokenProperty(),
      dumpName: {
        type: "string",
        description: "Optional dump directory name under profile.dumpHostPath.",
      },
      path: {
        type: "string",
        description:
          "Relative YDB object or directory path to dump inside the configured tenant. Defaults to . for tenant-wide dump semantics.",
      },
    },
    additionalProperties: false,
  };
}

export function listDumpsSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
    },
    additionalProperties: false,
  };
}

export function upgradeVersionSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["version"],
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty("execute the version upgrade plan"),
      confirmationToken: confirmationTokenProperty(),
      version: {
        type: "string",
        description: "Target image tag returned by local_ydb_list_versions.",
      },
      dumpName: {
        type: "string",
        description:
          "Optional dump directory name under profile.dumpHostPath for the upgrade backup.",
      },
    },
    additionalProperties: false,
  };
}

export function restoreSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["dumpName"],
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty("restore the tenant from the selected dump"),
      confirmationToken: confirmationTokenProperty(),
      dumpName: {
        type: "string",
        description: "Dump directory name under profile.dumpHostPath.",
      },
      path: {
        type: "string",
        description:
          "Destination directory path for YDB tools restore -p, relative to the configured tenant. Defaults to . for tenant root.",
      },
      describePaths: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional tenant-relative paths to verify with scheme describe after the restore command.",
      },
      countQueries: {
        type: "array",
        items: {
          type: "object",
          required: ["query"],
          properties: {
            label: {
              type: "string",
              description: "Optional label used in verification output for this count query.",
            },
            query: {
              type: "string",
              description:
                "Bounded whole-table count query to run after restore, for example SELECT COUNT(*) FROM `tenant-relative/path`;. Must be a single statement using COUNT(*) or COUNT(1) and at most 4096 UTF-8 bytes.",
            },
          },
          additionalProperties: false,
        },
        description:
          "Optional bounded whole-table SELECT COUNT(*) or COUNT(1) queries to verify restored data after the restore command.",
      },
    },
    additionalProperties: false,
  };
}

export function authHardeningSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty("apply the auth hardening config and restart local-ydb"),
      confirmationToken: confirmationTokenProperty(),
      configHostPath: {
        type: "string",
        description:
          "Reviewed config.yaml path on the selected target host. Defaults to profile.authConfigPath when present.",
      },
    },
    additionalProperties: false,
  };
}

export function prepareAuthConfigSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty("write the hardened config file"),
      confirmationToken: confirmationTokenProperty(),
      configHostPath: {
        type: "string",
        description:
          "Host path for the generated hardened config. Defaults to profile.authConfigPath when present.",
      },
      sid: {
        type: "string",
        description:
          "SID to place into viewer, monitoring, administration, and register_dynamic_node_allowed_sids. Defaults to profile.dynamicNodeAuthSid or root@builtin.",
      },
    },
    additionalProperties: false,
  };
}

export function dynamicAuthConfigSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty("write the dynamic-node auth token file"),
      confirmationToken: confirmationTokenProperty(),
      sid: {
        type: "string",
        description:
          "SID to store in both StaffApiUserToken and NodeRegistrationToken.",
      },
      tokenHostPath: {
        type: "string",
        description:
          "Host path for the generated text-proto auth token file. Defaults to profile.dynamicNodeAuthTokenFile when present.",
      },
    },
    additionalProperties: false,
  };
}

export function setRootPasswordSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["password"],
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty("rotate and persist the root password"),
      confirmationToken: confirmationTokenProperty(),
      password: {
        type: "string",
        minLength: 1,
        pattern: "^(?!.*[\\r\\n]).+$",
        description:
          "New non-empty root password without carriage returns or newlines to apply to the runtime root user and then persist into the host auth config and root password file. YDB defaults to no password complexity requirements, but the selected cluster may still reject the value when auth_config.password_complexity is configured.",
      },
    },
    additionalProperties: false,
  };
}

export function cleanupSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: profileProperty(),
      configPath: configPathProperty(),
      confirm: confirmProperty("remove the explicitly supplied storage paths or Docker volumes"),
      confirmationToken: confirmationTokenProperty(),
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "Explicit host filesystem paths to remove. Nothing is deleted unless each path is supplied here and confirm=true.",
      },
      volumes: {
        type: "array",
        items: { type: "string" },
        description:
          "Explicit Docker volume names to remove. Nothing is deleted unless each volume is supplied here and confirm=true.",
      },
    },
    additionalProperties: false,
  };
}
