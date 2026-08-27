import type { NextConfig } from "next";
import createMDX from "@next/mdx";
import remarkGfm from "remark-gfm";

/**
 * Whether this build is destined for the Cloudflare Worker.
 *
 * Set by the `cf:*` scripts in package.json. `opennextjs-cloudflare build` runs
 * `next build` internally, so there is otherwise nothing to distinguish the
 * deploy build from a local one — and the two need different module graphs.
 */
const forWorker = process.env.CF_WORKER_BUILD === "1";

/**
 * The libsql driver, dropped from the Worker bundle.
 *
 * `getDb()` has three branches (src/lib/db/index.ts): an injected D1 binding, a
 * D1 binding found on the Workers runtime, and a local SQLite file for `next dev`
 * and vitest. Only the third uses libsql, and on Workers it is unreachable — it
 * throws before constructing anything, because a Worker with no D1 binding is
 * misconfigured, not a Worker that should open a file.
 *
 * Bundling it anyway is not merely wasteful, it is fatal, and for two separate
 * reasons. `@libsql/client` advertises a `workerd` export condition pointing at a
 * `web.js` that is absent from the published package. And the driver's transitive
 * `@libsql/hrana-client` needs a websocket shim whose `workerd` entry Next never
 * copied, because Next traced the dependency under `node` conditions while esbuild
 * resolves it under `workerd` ones. Either failure alone means no worker is
 * produced at all.
 *
 * `resolve.alias` is not the lever. The App Router server build externalises
 * node_modules rather than resolving them, emitting `import("@libsql/client/node")`
 * and leaving it for esbuild — so an alias is never consulted. Declaring the
 * external's type as `var undefined` is what actually works: webpack substitutes
 * the expression, no specifier survives into the output, and esbuild has nothing
 * left to resolve.
 *
 * `undefined` is safe precisely because the branch is unreachable. If that ever
 * stops being true the failure is loud and immediate rather than subtle, which is
 * the right trade for code that must never be entered on this runtime.
 */
const workerDropped: Record<string, string> = {
  "@libsql/client": "var undefined",
  "@libsql/client/node": "var undefined",
  "drizzle-orm/libsql": "var undefined",
};

const nextConfig: NextConfig = {
  // Docs are .mdx files that are real routes under src/app/docs/.
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  /**
   * Framing is denied for every page, as it is for every API response.
   *
   * The router sets these itself for everything under `/api` (see `router.ts`),
   * because that is application code and ships wherever the router ships. The
   * pages cannot be covered that way — they are server components with no
   * request-level hook of their own — so they are covered here, which means
   * build configuration, which means this half is only as good as whether
   * OpenNext actually emits it on the Worker. `next dev` honouring it proves
   * nothing about the deploy target; a header that exists only in development is
   * worse than none, because it reads as covered. See the report for the probe
   * against the built Worker on workerd.
   *
   * `source: "/(.*)"` rather than `"/:path*"` so that the root path is included:
   * the two are usually equivalent but differ on `/`, and the home page is a
   * page like any other.
   *
   * The API paths match here too, and are then set again by the router's own
   * middleware. That is deliberate duplication for the same reason the two
   * headers are both sent — whichever layer is bypassed, the other still speaks
   * — and it is not additive: both layers set identical values, so the header
   * cannot end up with two conflicting values the way an appended one could.
   */
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    // Client bundles never reach for a database driver, so there is nothing to
    // drop there and `externals` may not even be an array.
    if (forWorker && isServer) {
      config.externals = [workerDropped, ...(config.externals ?? [])];
    }
    return config;
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
      { protocol: "https", hostname: "github.com" },
    ],
  },
};

const withMDX = createMDX({
  options: {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [],
  },
});

export default withMDX(nextConfig);
