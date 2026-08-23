import { createClient, type Client } from "@libsql/client/node";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import * as schema from "./schema";

/**
 * Database access.
 *
 * Three environments have to work: Cloudflare Workers with a D1 binding (the
 * deploy target, ADR-0005), local `next dev`, and vitest. They differ only in
 * where the handle comes from, so `getDb` is the one place that knows.
 *
 * Nothing here runs at import time. Constructing a client in module scope is not
 * a style question on `workerd` — the global scope has no I/O and no request
 * context, so an eager `createClient` fails the whole Worker at load. That is
 * what the previous `export const db = getDb()` did.
 *
 * The libsql import is deliberately the `/node` subpath rather than the bare
 * package name. The bare specifier advertises a `workerd` export condition
 * pointing at `./lib-esm/web.js`, and that file does not exist in the published
 * package — so bundling for Workers failed to resolve it and `npm run cf:build`
 * could not produce a worker at all. Naming `/node` says what is actually true:
 * this client is only ever constructed under Node, by `next dev` and by vitest.
 * On Workers the D1 branches below always win, so the module is bundled but
 * never entered.
 */

/** The slice of the D1 binding drizzle needs. */
interface D1Binding {
  prepare: (query: string) => unknown;
  batch: (queries: unknown[]) => Promise<unknown[]>;
  exec: (query: string) => Promise<unknown>;
}

/**
 * The local client is memoised per URL: one connection for the process, and a
 * fresh one if a test points `DATABASE_URL` at a different file.
 */
let localClient: { url: string; client: Client } | null = null;

function localDatabase(url: string) {
  if (localClient?.url !== url) {
    localClient = { url, client: createClient({ url }) };
  }

  return drizzleLibsql(localClient.client, { schema });
}

/**
 * The D1 binding as `@opennextjs/cloudflare` exposes it.
 *
 * Bindings are objects, so they cannot travel in `process.env` — the old
 * `process.env.DB` branch could never have matched. Outside the Workers runtime
 * this throws, which is the signal to fall back to a local file.
 */
function cloudflareD1(): D1Binding | undefined {
  try {
    const env = getCloudflareContext().env as Record<string, unknown> | undefined;
    return env?.DB as D1Binding | undefined;
  } catch {
    // Not running on Workers (local dev, vitest, or a build-time render).
    return undefined;
  }
}

/**
 * Whether this code is executing on the Workers runtime.
 *
 * `workerd` sets this exact user-agent string, and it is the check the Workers
 * documentation itself uses. It is not a substitute for looking for the binding —
 * it only tells us which failure to report when the binding is missing.
 */
function onWorkers(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers"
  );
}

/**
 * Get a database handle.
 *
 * @param env A Workers `env` when the caller already has one (Hono's `c.env`,
 *            or a test harness threading a binding in). Typed loosely because
 *            the framework hands it over as `unknown`.
 */
export function getDb(env?: unknown) {
  // 1. A binding handed in explicitly.
  const provided = (env as { DB?: unknown } | null | undefined)?.DB;
  if (provided) {
    return drizzleD1(provided as Parameters<typeof drizzleD1>[0], { schema });
  }

  // 2. The Workers runtime, via the OpenNext adapter.
  const binding = cloudflareD1();
  if (binding) {
    return drizzleD1(binding as Parameters<typeof drizzleD1>[0], { schema });
  }

  // 3. Local development and tests.
  //
  // Reaching here on Workers means the D1 binding is absent — an unset
  // `database_id` in wrangler.jsonc, or a binding renamed on one side only.
  // Opening a local file would be the wrong recovery: the Worker filesystem is
  // read-only and empty, so it would fail later with a libsql error that says
  // nothing about the real cause. Fail here instead, naming it.
  if (onWorkers()) {
    throw new Error(
      "No D1 binding named DB. Check `d1_databases` in wrangler.jsonc and that " +
        "its database_id is a real database id rather than the placeholder.",
    );
  }

  return localDatabase(process.env.DATABASE_URL || "file:local.db");
}
