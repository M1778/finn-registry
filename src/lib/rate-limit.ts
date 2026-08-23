/**
 * Best-effort rate limiting, per isolate.
 *
 * Read this before treating any number here as a guarantee: the counters live in
 * one Worker isolate's memory, so two requests served by different isolates
 * count against different budgets. The effective ceiling is therefore higher and
 * less predictable than the configured number — never lower. That is accepted
 * deliberately: the hard limit that actually protects the service is the
 * platform's 100,000 requests/day, and a shared counter would cost a D1 row
 * write per request to buy precision nobody needs (ADR-0005).
 *
 * The configured ceilings are documented in REGISTRY-CONTRACT.md §3.7.
 */
// Both are types only: a value import of `Next` does not exist in `hono`, which
// typechecks but fails at runtime and at lint (`import/named`).
import type { Context, Next } from "hono";

interface RateLimitConfig {
  windowMs: number;
  max: number;
  message?: string;
  keyGenerator?: (c: Context) => string | Promise<string>;
}

/** Request counters. Per isolate; see the note at the top of this file. */
const store = new Map<string, { count: number; resetTime: number }>();

/**
 * Expired entries are swept while serving a request, not by a timer.
 *
 * `setInterval` at module scope throws on `workerd` — "Disallowed operation
 * called within global scope" — which fails the entire Worker at startup, before
 * any route runs. That is what the previous 30-second cleanup interval did, and
 * an unreachable API is a worse leak than a stale map entry.
 *
 * Bounded per call so the sweep cannot itself eat the 10 ms CPU budget.
 */
const SWEEP_LIMIT = 200;

function sweep(now: number) {
  let examined = 0;
  for (const [key, record] of store) {
    if (examined >= SWEEP_LIMIT) break;
    examined += 1;
    if (now > record.resetTime) store.delete(key);
  }
}

export const rateLimit = (config: RateLimitConfig) => {
  return async (c: Context, next: Next) => {
    // Default key is IP + Path, but can be overridden (e.g. for user-based limits)
    let key = "";
    if (config.keyGenerator) {
      key = await config.keyGenerator(c);
    } else {
      const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "anonymous";
      const path = c.req.path;
      key = `${ip}:${path}`;
    }

    const now = Date.now();
    sweep(now);

    let record = store.get(key);

    if (!record || now > record.resetTime) {
      record = {
        count: 0,
        resetTime: now + config.windowMs
      };
    }

    record.count++;
    store.set(key, record);

    const remaining = Math.max(0, config.max - record.count);
    const reset = Math.ceil(record.resetTime / 1000);

    c.header("X-RateLimit-Limit", config.max.toString());
    c.header("X-RateLimit-Remaining", remaining.toString());
    c.header("X-RateLimit-Reset", reset.toString());

    if (record.count > config.max) {
      const retryAfter = Math.ceil((record.resetTime - now) / 1000);
      c.header("Retry-After", retryAfter.toString());

      // §3.8's envelope: `error` is a machine-readable code the CLI branches on,
      // `message` is the sentence for a human. It used to put the sentence in
      // `error`, which left a caller matching on prose.
      return c.json({
        error: "rate_limited",
        message: config.message || "You have exceeded the rate limit for this action. Please try again later.",
        retryAfter,
        limit: config.max,
        remaining: 0,
        reset
      }, 429);
    }

    await next();
  };
};
