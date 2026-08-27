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
    // The auth and verification suites solve real proof-of-work: `verify-request`
    // and `register` are 15 bits, so a single test that signs in and then posts
    // twice does ~100k hashes before it asserts anything. Vitest's 5s default is
    // enough on an idle machine and not enough on a shared CI runner, which makes
    // the suite go red for reasons that have nothing to do with the code — the
    // worst failure mode a gate can have, because it teaches everyone to re-run
    // until green. The difficulty is deliberately NOT lowered for tests: it is a
    // production security parameter, and an env knob that weakens it is a worse
    // thing to own than a slow suite. So the budget moves instead. A genuine hang
    // still fails, just later.
    testTimeout: 30_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
