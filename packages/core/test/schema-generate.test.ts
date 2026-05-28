import { describe, expect, it } from "vitest";
import {
  createContext,
  generateSchema,
  type SchemaSdkExecuteRequest,
  type SchemaSdkExecuteResult,
} from "../src/index.js";
import { ConfigSchema } from "../src/validation.js";

function successfulSdkRecorder(calls: SchemaSdkExecuteRequest[] = []): (request: SchemaSdkExecuteRequest) => Promise<SchemaSdkExecuteResult> {
  return async (request) => {
    calls.push(request);
    return {
      ok: true,
      status: "SUCCESS",
      issues: "",
    };
  };
}

describe("schema generation", () => {
  it("renders row CREATE TABLE with primary key, secondary index, and WITH settings", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        ifNotExists: true,
        columns: [
          { name: "tenant_id", type: "Utf8", notNull: true },
          { name: "order_id", type: "Uint64", notNull: true },
          { name: "created_at", type: "Timestamp" },
          { name: "total", type: "Decimal(22, 9)" },
        ],
        primaryKey: ["tenant_id", "order_id"],
        indexes: [{
          name: "orders_by_created_at",
          columns: ["created_at"],
          cover: ["total"],
          global: true,
          sync: "async",
        }],
        store: "row",
        with: {
          AUTO_PARTITIONING_BY_SIZE: { token: "ENABLED" },
          AUTO_PARTITIONING_MIN_PARTITIONS_COUNT: 4,
        },
      }],
    });

    expect(response).toMatchObject({
      summary: "Generated 1 YDB schema statement for /local/example.",
      databasePath: "/local/example",
      applyRisk: "low",
      warnings: [],
      statements: {
        count: 1,
        kinds: ["CREATE TABLE"],
      },
    });
    expect(response.script).toBe([
      "CREATE TABLE IF NOT EXISTS `orders` (",
      "  `tenant_id` Utf8 NOT NULL,",
      "  `order_id` Uint64 NOT NULL,",
      "  `created_at` Timestamp,",
      "  `total` Decimal(22, 9),",
      "  INDEX `orders_by_created_at` GLOBAL ASYNC ON (`created_at`) COVER (`total`),",
      "  PRIMARY KEY (`tenant_id`, `order_id`)",
      ")",
      "WITH (",
      "  STORE = ROW,",
      "  AUTO_PARTITIONING_BY_SIZE = ENABLED,",
      "  AUTO_PARTITIONING_MIN_PARTITIONS_COUNT = 4",
      ");",
    ].join("\n"));
    expect(response.scriptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(response.references.map((reference) => reference.label)).toContain("YDB CREATE TABLE syntax");
    expect(response.verification.join("\n")).toContain("local_ydb_apply_schema action=validate");
    expect(response.verification.join("\n")).toContain("local_ydb_apply_schema action=apply confirm=false");
    expect(response.verification.join("\n")).toContain("Use confirm=true only after explicit approval of that plan.");
  });

  it("renders column CREATE TABLE with PARTITION BY HASH", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "metrics",
        columns: [
          { name: "tenant_id", type: "Utf8", notNull: true },
          { name: "ts", type: "Timestamp", notNull: true },
          { name: "value", type: "Double" },
        ],
        primaryKey: ["tenant_id", "ts"],
        partitionByHash: ["tenant_id"],
        store: "column",
      }],
    });

    expect(response.script).toBe([
      "CREATE TABLE `metrics` (",
      "  `tenant_id` Utf8 NOT NULL,",
      "  `ts` Timestamp NOT NULL,",
      "  `value` Double,",
      "  PRIMARY KEY (`tenant_id`, `ts`)",
      ")",
      "PARTITION BY HASH (`tenant_id`)",
      "WITH (",
      "  STORE = COLUMN",
      ");",
    ].join("\n"));
  });

  it("renders ALTER TABLE column and index actions as separate statements", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "addColumn", column: { name: "status", type: "Utf8" } },
          { kind: "dropColumn", name: "legacy_status" },
          {
            kind: "addIndex",
            index: {
              name: "orders_by_customer",
              columns: ["customer_id"],
              global: true,
              sync: "sync",
            },
          },
          { kind: "dropIndex", name: "orders_by_legacy_status" },
        ],
      }],
    });

    expect(response.applyRisk).toBe("high");
    expect(response.summary).toBe("Generated 4 YDB schema statements for /local/example.");
    expect(response.statements.count).toBe(4);
    expect(response.statements.kinds).toEqual(["ALTER TABLE"]);
    expect(response.warnings).toEqual([
      "Generated ALTER TABLE DROP COLUMN. Apply only after confirming data loss is acceptable.",
      "Generated ALTER TABLE DROP INDEX. Query plans using this index may regress.",
    ]);
    expect(response.script).toBe([
      "ALTER TABLE `orders`",
      "  ADD COLUMN `status` Utf8;",
      "",
      "ALTER TABLE `orders`",
      "  DROP COLUMN `legacy_status`;",
      "",
      "ALTER TABLE `orders`",
      "  ADD INDEX `orders_by_customer` GLOBAL SYNC ON (`customer_id`);",
      "",
      "ALTER TABLE `orders`",
      "  DROP INDEX `orders_by_legacy_status`;",
    ].join("\n"));
  });

  it("renders DROP TABLE as high risk", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      statements: [{ kind: "dropTable", tableName: "orders" }],
    });

    expect(response.applyRisk).toBe("high");
    expect(response.statements.kinds).toEqual(["DROP TABLE"]);
    expect(response.warnings).toEqual([
      "Generated DROP TABLE. Apply only after confirming table and data loss is acceptable.",
    ]);
    expect(response.script).toBe("DROP TABLE `orders`;");
  });

  it("rejects generated scripts above the apply schema size limit", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));
    const columns = [
      { name: "id", type: "Uint64", notNull: true },
      ...Array.from({ length: 70_000 }, (_, index) => ({ name: `field_${index}`, type: "Utf8" })),
    ];

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "oversized",
        columns,
        primaryKey: ["id"],
      }],
    })).rejects.toThrow(/script must be at most 1048576 characters/);
  });

  it("quotes path identifiers and escapes backticks", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "dir/table`name",
        columns: [{ name: "select", type: "Utf8" }],
        primaryKey: ["select"],
      }],
    });

    expect(response.script).toContain("CREATE TABLE `dir/table\\`name` (");
    expect(response.script).toContain("`select` Utf8");
    expect(response.script).toContain("PRIMARY KEY (`select`)");
  });

  it("escapes string defaults with YQL C-style literal escapes", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "note", type: "Utf8", default: "safe\\'; DROP TABLE orders; --\nnext\t\u0001" },
        ],
        primaryKey: ["id"],
      }],
    });

    expect(response.script).toContain(String.raw`DEFAULT Utf8('safe\\\'; DROP TABLE orders; --\nnext\t\x01')`);
    expect(response.script).not.toContain("safe\\'; DROP TABLE orders; --\nnext");
  });

  it("renders typed numeric and temporal defaults", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64", default: 1 },
          { name: "created_on", type: "Date", default: "2026-05-27" },
          { name: "amount", type: "Decimal(22, 9)", default: "12.34" },
          { name: "raw", type: "String", default: "abc" },
        ],
        primaryKey: ["id"],
      }],
    });

    expect(response.script).toContain("`id` Uint64 DEFAULT Uint64('1')");
    expect(response.script).toContain("`created_on` Date DEFAULT Date('2026-05-27')");
    expect(response.script).toContain("`amount` Decimal(22, 9) DEFAULT Decimal('12.34', 22, 9)");
    expect(response.script).toContain("`raw` String DEFAULT 'abc'");
  });

  it("renders string WITH settings as string literals", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "items",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "embedding", type: "String" },
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "embedding_vector_idx",
          columns: ["embedding"],
          global: true,
          sync: "sync",
          using: "vector_kmeans_tree",
          with: {
            distance: "cosine",
            vector_type: "float",
            vector_dimension: 3,
            clusters: 2,
            levels: 1,
          },
        }],
      }],
    });

    expect(response.script).toContain("WITH (distance = 'cosine', vector_type = 'float', vector_dimension = 3, clusters = 2, levels = 1)");
  });

  it("treats explicit secondary index type as the default", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "status", type: "Utf8" },
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "orders_by_status",
          columns: ["status"],
          global: true,
          sync: "sync",
          using: "secondary",
        }],
      }],
    });

    expect(response.script).toContain("INDEX `orders_by_status` GLOBAL SYNC ON (`status`)");
    expect(response.script).not.toContain("USING secondary");
  });

  it("warns when creating a table with a vector index", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "items",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "embedding", type: "String" },
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "embedding_vector_idx",
          columns: ["embedding"],
          global: true,
          sync: "sync",
          using: "vector_kmeans_tree",
          with: {
            distance: "cosine",
            vector_type: "float",
            vector_dimension: 3,
            clusters: 2,
            levels: 1,
          },
        }],
      }],
    });

    expect(response.warnings).toContain("Generated CREATE TABLE with a vector index. YDB recommends adding vector indexes after loading representative data; a vector index created on an empty table can degrade to full scans.");
  });

  it("rejects secondary indexes on column-oriented tables", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "created_at", type: "Timestamp" },
        ],
        primaryKey: ["id"],
        store: "column",
        indexes: [{ name: "orders_by_created_at", columns: ["created_at"], global: true }],
      }],
    })).rejects.toThrow(/Secondary indexes are supported only for row-oriented tables/);
  });

  it("rejects unsupported secondary index modifiers", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "created_at", type: "Timestamp" },
        ],
        primaryKey: ["id"],
        indexes: [{ name: "orders_by_created_at", columns: ["created_at"], local: true }],
      }],
    })).rejects.toThrow(/secondary index orders_by_created_at cannot be local/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "created_at", type: "Timestamp" },
        ],
        primaryKey: ["id"],
        indexes: [{ name: "orders_by_created_at", columns: ["created_at"] }],
      }],
    })).rejects.toThrow(/secondary index orders_by_created_at must be global/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "order_no", type: "Utf8" },
        ],
        primaryKey: ["id"],
        indexes: [{ name: "orders_by_order_no", columns: ["order_no"], unique: true, global: true, sync: "async" }],
      }],
    })).rejects.toThrow(/unique index orders_by_order_no must be sync/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "order_no", type: "Utf8" },
        ],
        primaryKey: ["id"],
        indexes: [{ name: "orders_by_order_no", columns: ["order_no"], unique: true, global: true }],
      }],
    })).rejects.toThrow(/unique index orders_by_order_no must be sync/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "created_at", type: "Timestamp" },
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "orders_by_created_at",
          columns: ["created_at"],
          global: true,
          with: {
            AUTO_PARTITIONING_BY_SIZE: { token: "ENABLED" },
          },
        }],
      }],
    })).rejects.toThrow(/secondary index orders_by_created_at cannot have WITH settings/);
  });

  it("rejects duplicate index names within one statement", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "status", type: "Utf8" },
        ],
        primaryKey: ["id"],
        indexes: [
          { name: "orders_by_status", columns: ["status"], global: true, sync: "sync" },
          { name: " orders_by_status ", columns: ["id"], global: true, sync: "sync" },
        ],
      }],
    })).rejects.toThrow(/Duplicate index name: orders_by_status/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "addIndex", index: { name: "orders_by_status", columns: ["status"], global: true, sync: "sync" } },
          { kind: "addIndex", index: { name: " orders_by_status ", columns: ["customer_id"], global: true, sync: "sync" } },
        ],
      }],
    })).rejects.toThrow(/Duplicate index name: orders_by_status/);
  });

  it("rejects duplicate names in ordered name lists", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64", notNull: true }],
        primaryKey: ["id", " id "],
      }],
    })).rejects.toThrow(/primaryKey contains duplicate name: id/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "status", type: "Utf8" },
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "orders_by_status",
          columns: ["status", " status "],
          global: true,
          sync: "sync",
        }],
      }],
    })).rejects.toThrow(/index orders_by_status columns contains duplicate name: status/);
  });

  it("rejects unsupported NOT NULL placement", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "status", type: "Utf8", notNull: true },
        ],
        primaryKey: ["id"],
      }],
    })).rejects.toThrow(/NOT NULL column status must be part of primaryKey/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "metrics",
        columns: [
          { name: "tenant_id", type: "Utf8" },
          { name: "ts", type: "Timestamp", notNull: true },
        ],
        primaryKey: ["tenant_id", "ts"],
        store: "column",
      }],
    })).rejects.toThrow(/column-oriented table primaryKey column tenant_id must be NOT NULL/);
  });

  it("rejects unsupported column-oriented table types", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "metrics",
        columns: [
          { name: "enabled", type: "Bool", notNull: true },
          { name: "value", type: "Utf8" },
        ],
        primaryKey: ["enabled"],
        store: "column",
      }],
    })).rejects.toThrow(/column-oriented table primaryKey column enabled type Bool is not supported/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "metrics",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "created_on", type: "Date32" },
        ],
        primaryKey: ["id"],
        store: "column",
      }],
    })).rejects.toThrow(/column-oriented table column created_on type Date32 is not supported/);
  });

  it("rejects invalid setting tokens before rendering", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64" }],
        primaryKey: ["id"],
        with: {
          AUTO_PARTITIONING_BY_SIZE: { token: "ENABLED; DROP TABLE orders" },
        },
      }],
    })).rejects.toThrow(/Invalid YDB setting token/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64" }],
        primaryKey: ["id"],
        with: {
          AUTO_PARTITIONING_BY_SIZE: { token: 1 } as unknown as { token: string },
        },
      }],
    })).rejects.toThrow(/YDB setting object values must be \{ token: string \}/);
  });

  it("rejects duplicate WITH setting names after normalization", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64", notNull: true }],
        primaryKey: ["id"],
        with: {
          AUTO_PARTITIONING_BY_SIZE: { token: "ENABLED" },
          auto_partitioning_by_size: { token: "DISABLED" },
        },
      }],
    })).rejects.toThrow(/Duplicate YDB setting name: AUTO_PARTITIONING_BY_SIZE/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "items",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "embedding", type: "String" },
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "embedding_vector_idx",
          columns: ["embedding"],
          global: true,
          sync: "sync",
          using: "vector_kmeans_tree",
          with: {
            distance: "cosine",
            " distance ": "euclidean",
            vector_type: "float",
            vector_dimension: 3,
            clusters: 2,
            levels: 1,
          },
        }],
      }],
    })).rejects.toThrow(/Duplicate YDB setting name: distance/);
  });

  it("rejects STORE inside table WITH settings", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64", notNull: true }],
        primaryKey: ["id"],
        store: "column",
        with: {
          store: { token: "ROW" },
        },
      }],
    })).rejects.toThrow(/Use the store field instead of with\.STORE/);
  });

  it("rejects primary keys and indexes that reference missing columns", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64" }],
        primaryKey: ["missing_id"],
      }],
    })).rejects.toThrow(/primaryKey column missing_id must exist in columns/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64" }],
        primaryKey: ["id"],
        indexes: [{ name: "bad_index", columns: ["missing_status"] }],
      }],
    })).rejects.toThrow(/index bad_index column missing_status must exist in columns/);
  });

  it("rejects partitionByHash columns that reference missing table columns", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64", notNull: true }],
        primaryKey: ["id"],
        store: "column",
        partitionByHash: ["tenant_id"],
      }],
    })).rejects.toThrow(/partitionByHash column tenant_id must exist in columns/);
  });

  it("rejects partitionByHash columns that are not part of the primary key", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "metrics",
        columns: [
          { name: "id", type: "Uint64", notNull: true },
          { name: "bucket", type: "Uint32" },
        ],
        primaryKey: ["id"],
        store: "column",
        partitionByHash: ["bucket"],
      }],
    })).rejects.toThrow(/partitionByHash column bucket must be part of primaryKey/);
  });

  it("rejects PARTITION BY HASH on row-oriented tables", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64" }],
        primaryKey: ["id"],
        partitionByHash: ["id"],
      }],
    })).rejects.toThrow(/partitionByHash is supported only for column-oriented tables/);
  });

  it("rejects ASCII control characters in identifiers", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "i\td", type: "Uint64", notNull: true }],
        primaryKey: ["i\td"],
      }],
    })).rejects.toThrow(/YDB identifiers cannot contain ASCII control characters/);
  });

  it("rejects reserved YDB column prefixes", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "__ydb_id", type: "Uint64", notNull: true }],
        primaryKey: ["__ydb_id"],
      }],
    })).rejects.toThrow(/Column name __ydb_id must not start with reserved prefix __ydb_/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [{ kind: "addColumn", column: { name: "__ydb_status", type: "Utf8" } }],
      }],
    })).rejects.toThrow(/Column name __ydb_status must not start with reserved prefix __ydb_/);
  });

  it("rejects incomplete vector index settings", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "items",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "embedding", type: "String" },
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "embedding_vector_idx",
          columns: ["embedding"],
          global: true,
          using: "vector_kmeans_tree",
          with: {
            distance: "cosine",
            vector_type: "float",
            vector_dimension: 3,
            clusters: 2,
            levels: 1,
          },
        }],
      }],
    })).rejects.toThrow(/vector_kmeans_tree index embedding_vector_idx must be sync/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "items",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "embedding", type: "String" },
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "embedding_vector_idx",
          columns: ["embedding"],
          global: true,
          sync: "sync",
          using: "vector_kmeans_tree",
          with: {
            distance: "cosine",
            vector_type: "float",
            vector_dimension: 3,
          },
        }],
      }],
    })).rejects.toThrow(/vector_kmeans_tree index embedding_vector_idx requires numeric clusters/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "items",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "embedding", type: "String" },
        ],
        primaryKey: ["id"],
        indexes: [{
          name: "embedding_vector_idx",
          columns: ["embedding"],
          global: true,
          unique: true,
          sync: "sync",
          using: "vector_kmeans_tree",
          with: {
            distance: "cosine",
            vector_type: "float",
            vector_dimension: 3,
            clusters: 2,
            levels: 1,
          },
        }],
      }],
    })).rejects.toThrow(/vector_kmeans_tree index embedding_vector_idx cannot be unique/);
  });

  it("rejects indexes that reference columns added in the same ALTER TABLE spec", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "addColumn", column: { name: "status", type: "Utf8" } },
          { kind: "addIndex", index: { name: "orders_by_status", columns: ["status"], global: true } },
        ],
      }],
    })).rejects.toThrow(/index orders_by_status cannot reference column status added in the same alterTable spec/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "addIndex", index: { name: "orders_by_status", columns: ["status"], global: true } },
          { kind: "addColumn", column: { name: "status", type: "Utf8" } },
        ],
      }],
    })).rejects.toThrow(/index orders_by_status cannot reference column status added in the same alterTable spec/);
  });

  it("rejects unsupported ALTER TABLE ADD COLUMN constraints", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [{ kind: "addColumn", column: { name: "status", type: "Utf8", notNull: true } }],
      }],
    })).rejects.toThrow(/ALTER TABLE ADD COLUMN status cannot include notNull/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [{ kind: "addColumn", column: { name: "status", type: "Utf8", default: "new" } }],
      }],
    })).rejects.toThrow(/ALTER TABLE ADD COLUMN status cannot include default/);
  });

  it("rejects duplicate ALTER TABLE column actions", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "addColumn", column: { name: "status", type: "Utf8" } },
          { kind: "addColumn", column: { name: " status ", type: "Utf8" } },
        ],
      }],
    })).rejects.toThrow(/Duplicate ALTER TABLE ADD COLUMN name: status/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "dropColumn", name: "status" },
          { kind: "dropColumn", name: " status " },
        ],
      }],
    })).rejects.toThrow(/Duplicate ALTER TABLE DROP COLUMN name: status/);
  });

  it("rejects duplicate ALTER TABLE DROP INDEX actions", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "dropIndex", name: "orders_by_status" },
          { kind: "dropIndex", name: " orders_by_status " },
        ],
      }],
    })).rejects.toThrow(/Duplicate ALTER TABLE DROP INDEX name: orders_by_status/);
  });

  it("rejects indexes that reference columns dropped in the same ALTER TABLE spec", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "dropColumn", name: "status" },
          { kind: "addIndex", index: { name: "orders_by_status", columns: ["status"], global: true } },
        ],
      }],
    })).rejects.toThrow(/index orders_by_status cannot reference column status dropped in the same alterTable spec/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "alterTable",
        tableName: "orders",
        actions: [
          { kind: "addIndex", index: { name: "orders_by_status", columns: ["id"], cover: ["status"], global: true } },
          { kind: "dropColumn", name: "status" },
        ],
      }],
    })).rejects.toThrow(/index orders_by_status cannot cover column status dropped in the same alterTable spec/);
  });

  it("rejects unknown and malformed data types before rendering", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Serial" }],
        primaryKey: ["id"],
      }],
    })).rejects.toThrow(/Unsupported YDB column type: Serial/);

    await expect(generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "amount", type: "Decimal(36, 1)" }],
        primaryKey: ["amount"],
      }],
    })).rejects.toThrow(/Decimal precision must be between 1 and 35/);
  });

  it("normalizes DyNumber primitive type", async () => {
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [
          { name: "id", type: "Uint64" },
          { name: "amount", type: "dynumber" },
        ],
        primaryKey: ["id"],
      }],
    });

    expect(response.script).toContain("`amount` DyNumber");
  });

  it("optionally validates generated DDL through schema validation", async () => {
    const calls: SchemaSdkExecuteRequest[] = [];
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));

    const response = await generateSchema(ctx, {
      validate: true,
      statements: [{
        kind: "createTable",
        tableName: "orders",
        columns: [{ name: "id", type: "Uint64" }],
        primaryKey: ["id"],
      }],
      sdkExecutor: successfulSdkRecorder(calls),
    });

    expect(response.validation).toMatchObject({
      ok: true,
      status: "SUCCESS",
      issues: "",
    });
    expect(calls.map((call) => call.mode)).toEqual(["validate"]);
    expect(calls[0]?.script).toBe(response.script);
  });
});
