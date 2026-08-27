# Deploy to Cloudflare Workers with the OpenNext adapter

The registry deploys to Cloudflare Workers via `@opennextjs/cloudflare`, with D1 for storage, on
the free plan. This is the adapter Cloudflare's own Next.js guide recommends, and the only
supported path for a Next.js app that has a real server-side API; `@cloudflare/next-on-pages` is
no longer referenced in those guides, and a static export plus a hand-written Worker would mean
maintaining two deployment artifacts and losing SSR on every page. The binding constraint behind
all of this is cost: the project cannot pay for servers or storage, and ADR-0001 is what makes
the free tier sufficient, since a registry that hosts no bytes has no storage bill.

## Consequences

**GitHub Pages was never an option** and should stop being described as one. The API, the D1
binding, and the OAuth client secret all require a server; Pages serves static files only.

**10 ms of CPU per request is the real ceiling**, not the request count. Two existing pieces of
code exceed it and must change before this can deploy: `getAuth` runs `scryptSync` against every
API-key row in the table on each authenticated request, and `/api/stats` reads every package row
and sorts it three times in JavaScript on the busiest page in the app. Neither is a
micro-optimisation — on this platform they are correctness problems.

**Node's `crypto` module is not available as written.** `src/lib/security.ts` imports
`scryptSync` and `timingSafeEqual`, and `runtime = "nodejs"` on the API route is not a runtime
Workers offers. `nodejs_compat` covers part of the gap but cannot be assumed to cover scrypt;
where it does not, WebCrypto PBKDF2 replaces it.

**Deleting `api_keys` (ADR-0003's contract doc, §2.6) is now also a platform requirement**, not
just a simplification: the linear scrypt scan cannot be made to fit the CPU budget while the
table exists.

The app has never successfully deployed. There is no `wrangler` configuration in the repository
and no adapter installed, while CI calls `wrangler deploy` — which is why `getDb()` carries three
fallback paths and none of them is ever the D1 one. Anyone reading that function should understand
it as evidence of a broken deployment, not as a deliberate multi-environment design.
