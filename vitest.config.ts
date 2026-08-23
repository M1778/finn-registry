import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // API tests drive the real Hono router in-process against a temp SQLite file.
    // No dev server, no mocks, no network.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Each suite seeds its own database file; running them in one process keeps
    // the temp-file bookkeeping in one place.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
