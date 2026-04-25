import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@local-ydb-toolkit/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["packages/**/*.test.ts"],
    environment: "node"
  }
});
