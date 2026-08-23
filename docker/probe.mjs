/**
 * Probe a running Worker.
 *
 * This is the check nothing else in the repo performs. `tsc` proves the types
 * agree, `next build` proves the pages compile, `cf:build` proves esbuild can
 * produce a bundle — and all three were green at various points while the Worker
 * either could not be built or, worse, could have booted and failed on the first
 * request. The only evidence that the artifact works is a response from it.
 *
 * Specifically it is the evidence that dropping the libsql driver from the Worker
 * bundle (see next.config.ts) left something that runs. That substitution is only
 * sound if `getDb()` never reaches its local-file branch on `workerd`, and reading
 * the bundle cannot prove a branch is unreachable. A 200 carrying rows out of D1
 * can.
 *
 * Usage: node docker/probe.mjs <baseUrl>
 */

const base = process.argv[2] ?? "http://127.0.0.1:8787";

/** Endpoints that must answer, and what "answered correctly" means for each. */
const PROBES = [
  {
    path: "/api/health",
    want: 200,
    // Cheapest possible liveness: no database, no session, no rendering.
    check: (body) => {
      const json = JSON.parse(body);
      if (json.status !== "ok") throw new Error(`status was ${json.status}`);
    },
  },
  {
    path: "/api/packages",
    want: 200,
    // The one that matters. Reaching a 200 here means `getDb()` resolved the D1
    // binding through branch 2 and ran a query, on the runtime where the libsql
    // driver does not exist. An empty register is a pass: the assertion is that
    // the query ran, not that anything is registered.
    check: (body) => {
      const json = JSON.parse(body);
      if (typeof json !== "object" || json === null) throw new Error("not an object");
    },
  },
  {
    path: "/api/packages/a-name-nobody-has-registered",
    want: 404,
    // A 404 has to come from a query that found nothing, not from a route that
    // failed to match. The error envelope is how the two are told apart.
    check: (body) => {
      const json = JSON.parse(body);
      if (!json.error) throw new Error("404 carried no error code");
    },
  },
  // Server-rendered pages, each of which queries the database during render.
  // A 500 here is the failure mode that a green `cf:build` cannot rule out.
  { path: "/", want: 200 },
  { path: "/explore", want: 200 },
  { path: "/docs", want: 200 },
  // Renders a refusal rather than a crash for a signed-out visitor.
  {
    path: "/admin",
    want: 200,
    check: (html) => {
      if (!/sign in/i.test(html)) throw new Error("no refusal in the response");
    },
  },
];

async function waitForBoot(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "never responded";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`worker never became ready (${lastError})`);
}

await waitForBoot();

let failed = 0;
for (const probe of PROBES) {
  const label = `${probe.path} -> ${probe.want}`;
  try {
    const res = await fetch(`${base}${probe.path}`, { redirect: "manual" });
    const body = await res.text();
    if (res.status !== probe.want) {
      throw new Error(`got ${res.status}\n${body.slice(0, 600)}`);
    }
    probe.check?.(body);
    console.log(`  ok    ${label}`);
  } catch (err) {
    console.log(`  FAIL  ${label}\n        ${err.message}`);
    failed += 1;
  }
}

console.log(
  failed === 0
    ? `\nAll ${PROBES.length} probes passed against ${base}.`
    : `\n${failed} of ${PROBES.length} probes failed against ${base}.`,
);
process.exit(failed === 0 ? 0 : 1);
