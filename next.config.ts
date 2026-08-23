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
