import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export function profileSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: {
        type: "string",
        description:
          "Named profile from local-ydb.config.json. Defaults to config.defaultProfile.",
      },
      configPath: {
        type: "string",
        description:
          "Explicit local-ydb config file path to load for this tool call. Useful when the MCP server should pick up a different config without restart.",
      },
    },
    additionalProperties: false,
  };
}

export function logsSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["target"],
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      target: { type: "string", enum: ["static", "dynamic"] },
      lines: {
        type: "integer",
        minimum: 1,
        description: "Number of recent log lines to read. Defaults to 200.",
      },
    },
    additionalProperties: false,
  };
}

export function schemeSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: {
        type: "string",
        description:
          "Named profile from local-ydb.config.json. Defaults to config.defaultProfile.",
      },
      configPath: {
        type: "string",
        description:
          "Explicit local-ydb config file path to load for this tool call.",
      },
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
      profile: { type: "string" },
      configPath: {
        type: "string",
        description:
          "Explicit local-ydb config file path to load for this tool call.",
      },
      confirm: {
        type: "boolean",
        description:
          "Must be true to start the background Docker pull. Omit or false for plan-only output.",
      },
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
      profile: { type: "string" },
      configPath: {
        type: "string",
        description:
          "Explicit local-ydb config file path to load for this tool call.",
      },
      confirm: {
        type: "boolean",
        description:
          "Must be true to execute commands. Omit or false for plan-only output.",
      },
    },
    additionalProperties: false,
  };
}

export function addDynamicNodesSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: {
        type: "boolean",
        description:
          "Must be true to execute commands. Omit or false for plan-only output.",
      },
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
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: {
        type: "boolean",
        description:
          "Must be true to execute commands. Omit or false for plan-only output.",
      },
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
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: {
        type: "boolean",
        description:
          "Must be true to execute commands. Omit or false for plan-only output.",
      },
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
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: {
        type: "boolean",
        description:
          "Must be true to execute commands. Omit or false for plan-only output.",
      },
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
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: {
        type: "boolean",
        description:
          "Must be true to execute commands. Omit or false for plan-only output.",
      },
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
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean" },
      dumpName: {
        type: "string",
        description: "Optional dump directory name under profile.dumpHostPath.",
      },
    },
    additionalProperties: false,
  };
}

export function upgradeVersionSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    required: ["version"],
    properties: {
      profile: { type: "string" },
      configPath: {
        type: "string",
        description:
          "Explicit local-ydb config file path to load for this tool call.",
      },
      confirm: {
        type: "boolean",
        description:
          "Must be true to execute commands. Omit or false for plan-only output.",
      },
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
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean" },
      dumpName: {
        type: "string",
        description: "Dump directory name under profile.dumpHostPath.",
      },
    },
    additionalProperties: false,
  };
}

export function authHardeningSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean" },
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
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: {
        type: "boolean",
        description:
          "Must be true to execute commands. Omit or false for plan-only output.",
      },
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
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: {
        type: "boolean",
        description:
          "Must be true to execute commands. Omit or false for plan-only output.",
      },
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
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: {
        type: "boolean",
        description:
          "Must be true to execute commands. Omit or false for plan-only output.",
      },
      password: {
        type: "string",
        description:
          "New root password to apply to the runtime root user and then persist into the host auth config and root password file.",
      },
    },
    additionalProperties: false,
  };
}

export function cleanupSchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      profile: { type: "string" },
      configPath: { type: "string" },
      confirm: { type: "boolean" },
      paths: { type: "array", items: { type: "string" } },
      volumes: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  };
}
