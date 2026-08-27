import { handle } from "hono/vercel";
import { app } from "./router";

/**
 * The Next.js entry point for the API, and nothing else.
 *
 * The router itself lives in `./router.ts` because Next validates a route
 * module's export surface against a fixed list — the HTTP verbs plus config
 * fields like `dynamic` — and `export const app` is not on it, so a `route.ts`
 * that also exported the Hono instance failed `next build` ("app" is not a valid
 * Route export field) even though the code was correct. `tsc --noEmit` cannot
 * see that error, which is why the build stays in CI.
 *
 * Tests and any other in-process caller import `app` from `./router` and call
 * `app.request(...)`; this file only adapts it to the framework.
 */

export const dynamic = "force-dynamic";

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const DELETE = handle(app);
export const PATCH = handle(app);
