import { z } from "zod";

export const ProfileArgs = z.object({
  profile: z.string().optional(),
  configPath: z.string().optional(),
});

export const LogsArgs = ProfileArgs.extend({
  target: z.enum(["static", "dynamic"]),
  lines: z.number().int().positive().optional(),
});

export const SchemeArgs = ProfileArgs.extend({
  action: z.enum(["list", "describe"]).optional(),
  path: z.string().min(1).optional(),
  recursive: z.boolean().optional(),
  long: z.boolean().optional(),
  onePerLine: z.boolean().optional(),
  stats: z.boolean().optional(),
  maxOutputBytes: z.number().int().positive().max(1_048_576).optional(),
});

export const ApplySchemaArgs = ProfileArgs.extend({
  action: z.enum(["validate", "apply"]).optional(),
  databasePath: z.string().min(1).optional(),
  script: z.string().min(1).max(1_048_576),
  confirm: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  maxOutputBytes: z.number().int().positive().max(1_048_576).optional(),
});

const SchemaScalarValue = z.union([z.string(), z.number(), z.boolean()]);
const SchemaSettingTokenValue = z.object({
  token: z.string().min(1).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
}).strict();
const SchemaSettingValue = z.union([SchemaScalarValue, SchemaSettingTokenValue]);

const SchemaColumnArgs = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  notNull: z.boolean().optional(),
  default: SchemaScalarValue.optional(),
}).strict();

const SchemaIndexArgs = z.object({
  name: z.string().min(1),
  columns: z.array(z.string().min(1)).nonempty(),
  cover: z.array(z.string().min(1)).nonempty().optional(),
  global: z.boolean().optional(),
  local: z.boolean().optional(),
  unique: z.boolean().optional(),
  sync: z.enum(["sync", "async"]).optional(),
  using: z.enum(["secondary", "vector_kmeans_tree"]).optional(),
  with: z.record(SchemaSettingValue).optional(),
}).strict();

const CreateTableStatementArgs = z.object({
  kind: z.literal("createTable"),
  tableName: z.string().min(1),
  ifNotExists: z.boolean().optional(),
  columns: z.array(SchemaColumnArgs).nonempty(),
  primaryKey: z.array(z.string().min(1)).nonempty(),
  indexes: z.array(SchemaIndexArgs).optional(),
  partitionByHash: z.array(z.string().min(1)).nonempty().optional(),
  store: z.enum(["row", "column"]).optional(),
  with: z.record(SchemaSettingValue).optional(),
}).strict();

const AlterTableActionArgs = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("addColumn"),
    column: SchemaColumnArgs,
  }).strict(),
  z.object({
    kind: z.literal("dropColumn"),
    name: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("addIndex"),
    index: SchemaIndexArgs,
  }).strict(),
  z.object({
    kind: z.literal("dropIndex"),
    name: z.string().min(1),
  }).strict(),
]);

const AlterTableStatementArgs = z.object({
  kind: z.literal("alterTable"),
  tableName: z.string().min(1),
  actions: z.array(AlterTableActionArgs).nonempty(),
}).strict();

const DropTableStatementArgs = z.object({
  kind: z.literal("dropTable"),
  tableName: z.string().min(1),
}).strict();

const SchemaStatementArgs = z.discriminatedUnion("kind", [
  CreateTableStatementArgs,
  AlterTableStatementArgs,
  DropTableStatementArgs,
]);

export const GenerateSchemaArgs = ProfileArgs.extend({
  databasePath: z.string().min(1).optional(),
  validate: z.boolean().optional(),
  statements: z.array(SchemaStatementArgs).nonempty(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  maxOutputBytes: z.number().int().positive().max(1_048_576).optional(),
}).superRefine((args, ctx) => {
  const normalizedName = (name: string) => name.trim();
  const validateIdentifier = (name: string, path: (string | number)[]) => {
    if (/[\u0000-\u001F\u007F]/.test(normalizedName(name))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: "YDB identifiers cannot contain ASCII control characters",
      });
    }
  };
  const validateNameList = (names: string[], path: (string | number)[], label: string) => {
    const seen = new Set<string>();
    names.forEach((name, index) => {
      const normalized = normalizedName(name);
      validateIdentifier(name, [...path, index]);
      if (seen.has(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, index],
          message: `${label} contains duplicate name: ${normalized}`,
        });
      }
      seen.add(normalized);
    });
  };
  const validateSettingNames = (
    settings: Record<string, z.infer<typeof SchemaSettingValue>> | undefined,
    path: (string | number)[],
    nameCase: "preserve" | "upper",
  ) => {
    if (settings === undefined) {
      return;
    }
    const seen = new Set<string>();
    Object.keys(settings).forEach((name) => {
      const normalized = nameCase === "upper" ? name.trim().toUpperCase() : name.trim();
      if (seen.has(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `Duplicate YDB setting name: ${normalized}`,
        });
      }
      seen.add(normalized);
    });
  };
  const validateIndexNames = (indexes: z.infer<typeof SchemaIndexArgs>[], path: (string | number)[]) => {
    const seen = new Set<string>();
    indexes.forEach((index, indexIndex) => {
      const normalized = normalizedName(index.name);
      validateIdentifier(index.name, [...path, indexIndex, "name"]);
      if (seen.has(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, indexIndex, "name"],
          message: `Duplicate index name: ${normalized}`,
        });
      }
      seen.add(normalized);
    });
  };
  const validateIndex = (index: z.infer<typeof SchemaIndexArgs>, path: (string | number)[]) => {
    const indexType = index.using ?? "secondary";
    validateNameList(index.columns, [...path, "columns"], `index ${index.name} columns`);
    if (index.cover !== undefined) {
      validateNameList(index.cover, [...path, "cover"], `index ${index.name} cover`);
    }
    validateSettingNames(index.with, [...path, "with"], "preserve");
    if (index.global && index.local) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "local"],
        message: `index ${index.name} cannot be both global and local`,
      });
    }
    if (indexType === "secondary" && index.local) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "local"],
        message: `secondary index ${index.name} cannot be local`,
      });
    }
    if (indexType === "secondary" && index.global !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "global"],
        message: `secondary index ${index.name} must be global`,
      });
    }
    if (indexType === "secondary" && index.with !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "with"],
        message: `secondary index ${index.name} cannot have WITH settings`,
      });
    }
    if (index.unique && index.sync !== "sync") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "sync"],
        message: `unique index ${index.name} must be sync`,
      });
    }
    if (index.using === "vector_kmeans_tree") {
      if (index.global !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "global"],
          message: `vector_kmeans_tree index ${index.name} must be global`,
        });
      }
      if (index.local) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "local"],
          message: `vector_kmeans_tree index ${index.name} cannot be local`,
        });
      }
      if (index.unique) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "unique"],
          message: `vector_kmeans_tree index ${index.name} cannot be unique`,
        });
      }
      if (index.sync !== "sync") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "sync"],
          message: `vector_kmeans_tree index ${index.name} must be sync`,
        });
      }
    }
  };

  args.statements.forEach((statement, statementIndex) => {
    validateIdentifier(statement.tableName, ["statements", statementIndex, "tableName"]);
    if (statement.kind === "createTable") {
      validateNameList(statement.primaryKey, ["statements", statementIndex, "primaryKey"], "primaryKey");
      if (statement.partitionByHash !== undefined) {
        validateNameList(statement.partitionByHash, ["statements", statementIndex, "partitionByHash"], "partitionByHash");
      }
      validateSettingNames(statement.with, ["statements", statementIndex, "with"], "upper");
      const primaryKeyNames = new Set(statement.primaryKey.map(normalizedName));
      const columnsByName = new Map(statement.columns.map((column) => [normalizedName(column.name), column]));
      const columnNames = new Set<string>();
      statement.columns.forEach((column, columnIndex) => {
        const name = normalizedName(column.name);
        validateIdentifier(column.name, ["statements", statementIndex, "columns", columnIndex, "name"]);
        if (columnNames.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["statements", statementIndex, "columns", columnIndex, "name"],
            message: `Duplicate column name: ${name}`,
          });
        }
        columnNames.add(name);
        if (column.notNull && !primaryKeyNames.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["statements", statementIndex, "columns", columnIndex, "notNull"],
            message: `NOT NULL column ${name} must be part of primaryKey`,
          });
        }
      });
      if (statement.store === "column") {
        statement.primaryKey.forEach((key, primaryKeyIndex) => {
          const name = normalizedName(key);
          if (columnsByName.get(name)?.notNull !== true) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["statements", statementIndex, "primaryKey", primaryKeyIndex],
              message: `column-oriented table primaryKey column ${name} must be NOT NULL`,
            });
          }
        });
      }
      if (statement.with !== undefined && Object.keys(statement.with).some((name) => name.trim().toUpperCase() === "STORE")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["statements", statementIndex, "with"],
          message: "Use the store field instead of with.STORE",
        });
      }
      validateIndexNames(statement.indexes ?? [], ["statements", statementIndex, "indexes"]);
      statement.indexes?.forEach((index, indexIndex) => {
        validateIndex(index, ["statements", statementIndex, "indexes", indexIndex]);
      });
    }
    if (statement.kind === "alterTable") {
      const addedIndexes = statement.actions.flatMap((action) => action.kind === "addIndex" ? [action.index] : []);
      validateIndexNames(addedIndexes, ["statements", statementIndex, "actions"]);
      statement.actions.forEach((action, actionIndex) => {
        if (action.kind === "addIndex") {
          validateIndex(action.index, ["statements", statementIndex, "actions", actionIndex, "index"]);
        }
      });
    }
  });
});

export const PermissionsArgs = ProfileArgs.extend({
  action: z.enum([
    "list",
    "grant",
    "revoke",
    "set",
    "clear",
    "chown",
    "set-inheritance",
    "clear-inheritance",
  ]).optional(),
  path: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  permissions: z.array(z.string().min(1)).nonempty().optional(),
  owner: z.string().min(1).optional(),
  maxOutputBytes: z.number().int().positive().max(1_048_576).optional(),
  confirm: z.boolean().optional(),
});

export const MutatingArgs = ProfileArgs.extend({
  confirm: z.boolean().optional(),
});

export const AddDynamicNodesArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  startIndex: z.number().int().min(2).optional(),
  grpcPortStart: z.number().int().positive().max(65535).optional(),
  monitoringPortStart: z.number().int().positive().max(65535).optional(),
  icPortStart: z.number().int().positive().max(65535).optional(),
});

export const RemoveDynamicNodesArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  startIndex: z.number().int().min(2).optional(),
  containers: z.array(z.string()).optional(),
  nodeIds: z.array(z.number().int().positive()).max(10).optional(),
});

export const AddStorageGroupsArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  poolName: z.string().optional(),
});

export const ReduceStorageGroupsArgs = MutatingArgs.extend({
  count: z.number().int().positive().max(10).optional(),
  dumpName: z.string().optional(),
  poolName: z.string().optional(),
});

export const DestroyStackArgs = MutatingArgs.extend({
  removeBindMountPath: z.boolean().optional(),
  removeAuthArtifacts: z.boolean().optional(),
  removeDumpHostPath: z.boolean().optional(),
});

export const DumpArgs = MutatingArgs.extend({
  dumpName: z.string().optional(),
});

export const RestoreArgs = MutatingArgs.extend({
  dumpName: z.string(),
});

export const AuthHardeningArgs = MutatingArgs.extend({
  configHostPath: z.string().optional(),
});

export const PrepareAuthConfigArgs = MutatingArgs.extend({
  configHostPath: z.string().optional(),
  sid: z.string().optional(),
});

export const DynamicAuthConfigArgs = MutatingArgs.extend({
  sid: z.string().optional(),
  tokenHostPath: z.string().optional(),
});

export const SetRootPasswordArgs = MutatingArgs.extend({
  password: z.string().min(1).refine((value) => !/[\r\n]/.test(value), "password must not contain carriage returns or newlines"),
});

export const CleanupArgs = MutatingArgs.extend({
  paths: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
});

export const ListVersionsArgs = z.object({
  image: z.string().optional(),
  pageSize: z.number().int().positive().max(1000).optional(),
  maxPages: z.number().int().positive().max(100).optional(),
});

export const PullImageArgs = MutatingArgs.extend({
  image: z.string().min(1).optional(),
});

export const PullStatusArgs = z.object({
  jobId: z.string().min(1),
});

export const UpgradeVersionArgs = MutatingArgs.extend({
  version: z.string().min(1),
  dumpName: z.string().optional(),
});
