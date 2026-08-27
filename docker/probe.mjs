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
    path: "/api/packages/nosuchpackage",
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
  // The captcha is the only thing here that signs with WebCrypto HMAC. `workerd`
  // has no `node:crypto`, so a 200 carrying a signature is the evidence that
  // `importKey`/`sign` resolved to the platform implementation and not to a
  // polyfill that got dropped from the bundle.
  {
    path: "/api/captcha?scope=register",
    want: 200,
    check: (body) => {
      const json = JSON.parse(body);
      if (!/^[0-9a-f]{32}$/.test(json.salt)) throw new Error(`bad salt ${json.salt}`);
      if (!/^[0-9a-f]{64}$/.test(json.sig)) throw new Error("signature is not a SHA-256 HMAC");
      if (json.bits !== 15) throw new Error(`bits was ${json.bits}`);
    },
  },
];

/**
 * Solve one challenge on this runtime and spend it: issued by `workerd`, verified
 * by `workerd`, over HTTP. This is the round trip the unit tests cannot make.
 *
 * It goes through `/api/auth/github` rather than one of the `POST`s, because that
 * is the only route that checks proof of work before it checks anything else. The
 * `POST`s check the session first, so a signed-out probe would get the same 401
 * whether the proof was valid or absent — which would assert nothing.
 *
 * `verify.sh` sets GITHUB_CLIENT_ID for the same reason: without it the route
 * refuses on configuration before it ever looks at the proof.
 */
async function probeProofOfWork() {
  const label = "solve a challenge and spend it";
  try {
    // No proof: the challenge page, and definitely not a redirect to GitHub.
    const unsolved = await fetch(`${base}/api/auth/github`, { redirect: "manual" });
    const page = await unsolved.text();
    if (unsolved.status !== 200) throw new Error(`challenge page was ${unsolved.status}`);
    if (!page.includes("Checking your browser")) {
      throw new Error("no challenge page came back");
    }
    if (page.includes("github.com/login/oauth")) {
      throw new Error("redirected to GitHub without asking for any proof");
    }

    // Solve the challenge the page itself carries, exactly as a browser would.
    const salt = page.match(/var salt = "([0-9a-f]{32})"/)?.[1];
    const bits = Number(page.match(/var bits = (\d+)/)?.[1]);
    const exp = page.match(/var exp = "(\d+)"/)?.[1];
    const sig = page.match(/var sig = "([0-9a-f]{64})"/)?.[1];
    if (!salt || !bits || !exp || !sig) throw new Error("challenge page carried no challenge");

    const encoder = new TextEncoder();
    const zeros = (bytes, want) => {
      let seen = 0;
      for (const byte of bytes) {
        if (byte === 0) {
          seen += 8;
          if (seen >= want) return seen;
          continue;
        }
        return seen + (Math.clz32(byte) - 24);
      }
      return seen;
    };

    let nonce = -1;
    search: for (let start = 0; start < 1 << 22; start += 256) {
      const digests = await Promise.all(
        Array.from({ length: 256 }, (_, i) =>
          crypto.subtle.digest("SHA-256", encoder.encode(`${salt}.${start + i}`)),
        ),
      );
      for (let i = 0; i < digests.length; i += 1) {
        if (zeros(new Uint8Array(digests[i]), bits) >= bits) {
          nonce = start + i;
          break search;
        }
      }
    }
    if (nonce < 0) throw new Error(`no solution for ${bits} bits`);

    const token = ["v1", salt, bits, exp, sig, nonce].join(".");
    const spend = (t) =>
      fetch(`${base}/api/auth/github?cr=1&captcha=${encodeURIComponent(t)}`, {
        redirect: "manual",
      });

    const accepted = await spend(token);
    const redirect = await accepted.text();
    if (!redirect.includes("github.com/login/oauth/authorize")) {
      throw new Error(`a solved proof did not get through: ${redirect.slice(0, 300)}`);
    }
    if (!accepted.headers.get("set-cookie")?.includes("oauth_state=")) {
      throw new Error("got through without the OAuth state cookie being set");
    }

    // Same token again: single-use, so this must not get through.
    const replayed = await spend(token);
    if ((await replayed.text()).includes("github.com/login/oauth/authorize")) {
      throw new Error("a spent proof was accepted a second time");
    }

    // A forged signature must not get through either.
    const forged = await spend(["v1", salt, bits, exp, "0".repeat(64), nonce].join("."));
    if ((await forged.text()).includes("github.com/login/oauth/authorize")) {
      throw new Error("a forged signature was accepted");
    }

    console.log(`  ok    ${label} (${bits} bits, nonce ${nonce}; replay and forgery refused)`);
    return 0;
  } catch (err) {
    console.log(`  FAIL  ${label}\n        ${err.message}`);
    return 1;
  }
}

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

failed += await probeProofOfWork();
const total = PROBES.length + 1;

console.log(
  failed === 0
    ? `\nAll ${total} probes passed against ${base}.`
    : `\n${failed} of ${total} probes failed against ${base}.`,
);
process.exit(failed === 0 ? 0 : 1);
