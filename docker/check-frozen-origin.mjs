// Has the OAuth callback origin been frozen into the build artifact?
//
// WHY THIS CANNOT BE A UNIT TEST. `configuredOrigin()` in the API router reads
// `process.env.APP_URL`, which must stay a *runtime* read: on Workers the value
// arrives from `wrangler.jsonc` `vars` when the isolate starts. The read once was
// `process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL`, and `NEXT_PUBLIC_*` is
// a build-time inline — Next substitutes the literal, so with any value present
// on the build machine the minifier saw a truthy constant left of `||` and
// deleted the `APP_URL` branch outright. The compiled function became
//
//     function bb(){let a="http://130.185.120.193:3000"; ... }
//
// which sends OAuth codes to whatever origin the build box carried, makes the
// `APP_URL` var unreachable, and disables the placeholder guard because there is
// no longer a variable for it to test.
//
// vitest cannot see any of that: it runs on Node against source, where no
// substitution happens. The failure exists only in the artifact, so the check
// belongs against the artifact or nowhere.
//
// Usage:  node docker/check-frozen-origin.mjs [.open-next]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? ".open-next";
const NEEDLE = "process.env.APP_URL";
const INLINE = "process.env.NEXT_PUBLIC_APP_URL";

/**
 * The compiled API route, found by walking rather than by literal path.
 *
 * The source path contains `[[...route]]`, which is awkward to quote and, more to
 * the point, is a Next routing detail that could be reorganised. A check that
 * silently passes because its target moved is worse than no check, so a missing
 * bundle is a failure below, not a skip.
 */
function findApiBundles(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findApiBundles(path));
    } else if (entry.name === "route.js" && path.includes("api")) {
      found.push(path);
    }
  }
  return found;
}

let ok = true;
const fail = (msg) => {
  ok = false;
  console.log(`  FAIL  ${msg}`);
};

try {
  statSync(root);
} catch {
  console.log(`  FAIL  no build artifact at ${root} — run \`npm run cf:build\` first`);
  process.exit(1);
}

const bundles = findApiBundles(root).filter((p) => !p.includes("/cache/"));

if (bundles.length === 0) {
  fail(`found no compiled API route under ${root}; the check cannot pass by default`);
} else {
  for (const bundle of bundles) {
    const code = readFileSync(bundle, "utf8");
    const runtime = code.includes(NEEDLE);
    const inlined = code.includes(INLINE);

    if (!runtime) {
      fail(
        `${bundle}\n        contains no runtime \`${NEEDLE}\` read, which is the signature of the\n` +
          `        callback origin having been frozen into the build. Check for a stray\n` +
          `        .env.local on the build machine, and make sure configuredOrigin() reads\n` +
          `        only APP_URL and never a NEXT_PUBLIC_ variable.`,
      );
    } else {
      console.log(`  ok    ${bundle} keeps a runtime ${NEEDLE} read`);
    }

    // The router must not read the inlined copy at all. Its presence here means
    // the coupling this check exists to prevent has come back.
    if (inlined) {
      fail(
        `${bundle}\n        reads \`${INLINE}\`. That is a build-time inline and cannot be set by\n` +
          `        wrangler vars; the API router must read APP_URL only. (layout.tsx may\n` +
          `        read it for metadataBase — that is a different bundle.)`,
      );
    }
  }
}

process.exit(ok ? 0 : 1);
