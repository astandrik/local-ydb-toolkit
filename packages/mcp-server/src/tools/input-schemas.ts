import type { Tool } from "@modelcontextprotocol/sdk/types.js";

function profileProperty(): { type: "string"; description: string } {
  return {
    type: "string",
    description:
      "Named profile from local-ydb.config.json. Defaults to config.defaultProfile.",
  };
}

function configPathProperty(): { type: "string"; description: string } {
  return {
    type: "string",
    description:
      "Explicit local-ydb config file path to load for this tool call. Useful when the MCP server should pick up a different config without restart.",
  };
}

function confirmProperty(action = "execute planned commands"): {
  type: "boolean";
  description: string;
} {
  return {
    type: "boolean",
    description:
      `Must be true to ${action}. Omit or false for plan-only output.`,
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
          "Must be true to execute action=apply after SDK validation succeeds. Omit or false for validation plus plan-only output.",
      },
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
          "Must be true to execute mutating actions. Omit or false for plan-only output. Not required for action=list.",
      },
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
          "Container image name to inspect. Defaults to ghcr.io/ydb-platform/local-ydb.",
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
          "Suffix for the first added container. Defaults to 2, producing <dynamicContainer>-2.",
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
      count: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "Number of extra dynamic nodes to remove. Defaults to 1.",
      },
      startIndex: {
        type: "integer",
        minimum: 2,
        description: "Minimum suffix to consider removable. Defaults to 2.",
      },
      containers: {
        type: "array",
        items: { type: "string" },
        description: "Explicit extra dynamic-node container names to remove.",
      },
      nodeIds: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        maxItems: 10,
        description:
          "Explicit YDB dynamic-node IDs to remove. IDs must resolve to extra dynamic-node containers; the profile's base dynamic node is not removable through this option.",
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
      version: {
        type: "string",
        description:
          "Target image tag such as 26.1.1.6, 26.1, latest, or nightly.",
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
                "Bounded SELECT COUNT(...) query to run after restore. Must be a single statement and at most 4096 UTF-8 bytes.",
            },
          },
          additionalProperties: false,
        },
        description:
          "Optional bounded SELECT COUNT(...) queries to verify restored data after the restore command.",
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
