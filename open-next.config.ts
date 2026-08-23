import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * OpenNext's Cloudflare adapter config.
 *
 * `opennextjs-cloudflare build` refuses to run without this file, which is why
 * `npm run cf:build` failed immediately before it existed — the deploy has never
 * been exercised end to end.
 *
 * Deliberately empty of caching overrides. The defaults use no incremental cache,
 * which is the correct choice here rather than a missing one: every API response
 * is per-request (`dynamic = "force-dynamic"` in the route adapter), the pages
 * that could be cached are static already, and both R2 and KV-backed caches cost
 * either money or a request-per-lookup against a 100,000-requests/day allowance
 * (ADR-0005). If a cache is ever added it should be because a specific page was
 * measured as slow, not on principle.
 */
export default defineCloudflareConfig();
