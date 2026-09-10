#!/usr/bin/env bash
#
# The full gate, in the environment that ships.
#
# Mirrors the Verify job in .github/workflows/deploy.yml, in CI's Node version
# rather than the host's, and then does the one thing CI does not do at all: boots
# the built Worker on `workerd` and makes requests to it.
#
# Usage (from the repo root):
#   sudo docker build -t finn-registry-ci .
#   sudo docker run --rm finn-registry-ci
set -euo pipefail

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "Node and npm"
node --version
npm --version

step "Typecheck"
npx tsc --noEmit

step "Lint"
npx eslint src tests --max-warnings=0

step "Build the Worker"
# Not `npm run build`. The Node target and the Worker compile different module
# graphs — see next.config.ts — and only one of them is deployed.
npm run cf:build

step "Check the callback origin is still a runtime read"
# The one class of defect the test suite cannot see. vitest runs on Node against
# source; `NEXT_PUBLIC_*` inlining happens only in a build, so an origin frozen
# into the artifact is invisible to every test in tests/ by construction. This
# runs after cf:build because the artifact is the only place the evidence exists.
node docker/check-frozen-origin.mjs

step "Tests"
npm test

step "Apply migrations to the local D1"
# Miniflare keys its local database off the binding and database_name, so the
# placeholder database_id in wrangler.jsonc is not an obstacle here. That is worth
# knowing: local verification does not wait on a Cloudflare account.
npm run db:apply:local

step "Boot the Worker and probe it"
# GITHUB_CLIENT_ID is set purely so `/api/auth/github` gets past its
# configuration check: that route verifies proof of work before it needs a
# session, which makes it the only place a probe can prove the captcha is
# actually being checked on workerd. Nothing here talks to GitHub.
#
# APP_URL is set for the same class of reason, and without it this step could not
# pass. `wrangler.jsonc` binds APP_URL as `https://REPLACE_WITH_DEPLOYMENT_ORIGIN`,
# and `configuredOrigin()` in router.ts refuses that placeholder on purpose (a
# value that validates but is not an answer would come back as GitHub's
# `redirect_uri_mismatch` instead of naming the real problem). So the proof-of-work
# probe used to verify its solution, set both OAuth cookies, and then get a 400
# "Configuration Missing" from the origin check one line later — a failure with
# nothing to do with what the probe asserts. The value is any origin at all; this
# one never receives a request, because nothing here talks to GitHub either.
npx wrangler dev --port 8787 --ip 127.0.0.1 \
  --var GITHUB_CLIENT_ID:Iv1.probeonly \
  --var APP_URL:http://127.0.0.1:8787 >/tmp/wrangler.log 2>&1 &
worker_pid=$!
# Kill the runtime however this script exits, so a failed probe does not leave a
# process holding the port.
trap 'kill "${worker_pid}" 2>/dev/null || true' EXIT

if ! node docker/probe.mjs http://127.0.0.1:8787; then
  echo
  echo "--- wrangler log ---"
  tail -60 /tmp/wrangler.log
  exit 1
fi

step "Boot without a D1 binding and check the error names the cause"
# The other half of excluding libsql from the bundle. `getDb()` throws rather than
# falling through to a local file, so that an unset database_id reports itself
# instead of surfacing as a missing module. Untested, that is just a comment.
kill "${worker_pid}" 2>/dev/null || true
wait "${worker_pid}" 2>/dev/null || true

npx wrangler dev -c docker/wrangler.no-db.jsonc --port 8788 --ip 127.0.0.1 \
  >/tmp/wrangler-no-db.log 2>&1 &
nodb_pid=$!
trap 'kill "${nodb_pid}" 2>/dev/null || true' EXIT

# Both halves of this check are one script on purpose. The previous version split
# them — a Node probe asserting a 5xx, then a bash loop grepping the log — and the
# split is what made it report "the 5xx did not mention the missing binding" while
# the 5xx assertion passed. Three separate reasons, all of them in the check rather
# than in the error message, which does name the cause:
#
#   1. No readiness gate. The probe looped until a connection succeeded and took
#      the first status it got. During boot, wrangler answers on the port before
#      the user Worker is running, so a 5xx from wrangler itself satisfied
#      `status >= 500` — a pass produced by no handler, which therefore logged
#      nothing for the grep to find.
#   2. The assertion was `>= 500` and nothing else. A wrangler-level 5xx and this
#      registry`s `internal_error` envelope are the two things that most need
#      telling apart here, and any-5xx cannot tell them apart.
#   3. The log poll never re-requested. Having missed its one chance to make a
#      handler run, it spent 20 seconds re-reading a log that nothing was going to
#      write to.
#
# So: gate on `/api/health`, which returns 200 with no database and is the only
# route that does; assert the envelope, not the status class; and re-request on
# every poll iteration, because the message only exists if a handler ran.
node --input-type=module -e '
import { readFileSync } from "node:fs";

const base = "http://127.0.0.1:8788";
const log = "/tmp/wrangler-no-db.log";
const WANTED = "No D1 binding named DB";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logged = () => {
  try {
    return readFileSync(log, "utf8").includes(WANTED);
  } catch {
    return false;
  }
};

// Readiness. `/api/health` is deliberately databaseless (router.ts), so a 200
// here means the user Worker is running and nothing else. Until it answers, a
// response from this port is wrangler talking, not the registry.
let ready = false;
const bootDeadline = Date.now() + 90_000;
let lastBootError = "never responded";
while (Date.now() < bootDeadline) {
  try {
    const res = await fetch(`${base}/api/health`);
    if (res.ok) { ready = true; break; }
    lastBootError = `HTTP ${res.status}`;
  } catch (err) {
    lastBootError = err.message;
  }
  await sleep(500);
}
if (!ready) {
  console.log(`  FAIL  worker never became ready (${lastBootError})`);
  process.exit(1);
}

// The request that must fail, and the shape it must fail in.
let body = "";
let status = 0;
const probe = async () => {
  const res = await fetch(`${base}/api/packages`);
  status = res.status;
  body = await res.text();
};
await probe();

if (status !== 500) {
  console.log(`  FAIL  /api/packages returned ${status} without a D1 binding, wanted 500`);
  console.log(`        ${body.slice(0, 400)}`);
  process.exit(1);
}

let envelope = null;
try {
  envelope = JSON.parse(body);
} catch {
  console.log("  FAIL  the 500 body is not JSON, so it did not come from the registry");
  console.log(`        ${body.slice(0, 400)}`);
  process.exit(1);
}
if (envelope?.error !== "internal_error") {
  console.log(`  FAIL  the 500 is not the registry\u0027s error envelope: ${body.slice(0, 400)}`);
  process.exit(1);
}
console.log("  ok    /api/packages -> 500 internal_error without a D1 binding");

// Now the message itself. The Worker`s console output travels workerd ->
// wrangler -> this file asynchronously and routinely lands after the response
// that caused it, so this waits rather than grepping once. It also re-requests
// each time round: if the first request somehow did not reach the handler, the
// line will never appear no matter how long a grep loop waits.
let named = logged();
const logDeadline = Date.now() + 20_000;
while (!named && Date.now() < logDeadline) {
  await sleep(1000);
  named = logged();
  if (named) break;
  try { await probe(); } catch { /* the assertions above already passed once */ }
  named = logged();
}

if (named) {
  console.log("  ok    the error names the missing binding");
  process.exit(0);
}

console.log("  FAIL  the 500 never named the missing binding, so something else threw");
console.log(`        last body: ${body.slice(0, 400)}`);
console.log("----- wrangler log (no-db) -----");
try { process.stdout.write(readFileSync(log, "utf8")); } catch { console.log("(no log file)"); }
console.log("----- end -----");
process.exit(1);
'

step "All gates passed"
