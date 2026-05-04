import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "node24",
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // Integration specs in this package each TRUNCATE the same Postgres test
    // database in their `beforeAll`. Vitest's default file parallelism makes
    // them race — one file's setup wipes the other's data mid-test. The DB-gated
    // route specs explicitly assume sequential execution; honor that by
    // disabling cross-file parallelism.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts"],
    },
  },
});
