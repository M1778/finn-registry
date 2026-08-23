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
npx wrangler dev --port 8787 --ip 127.0.0.1 \
  --var GITHUB_CLIENT_ID:Iv1.probeonly >/tmp/wrangler.log 2>&1 &
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

node --input-type=module -e '
const base = "http://127.0.0.1:8788";
const deadline = Date.now() + 90_000;
let status = null;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`${base}/api/packages`);
    status = res.status;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (status === null) throw new Error("worker never accepted a connection");
if (status < 500) throw new Error(`expected a 5xx without a D1 binding, got ${status}`);
console.log(`  ok    /api/packages -> ${status} without a D1 binding`);
'

# Poll rather than grep once. The Worker's console output travels workerd ->
# wrangler -> this file asynchronously, so it routinely lands after the response
# that caused it: a single grep here read a log holding nothing but wrangler's
# startup banner. The wait is what makes a missing message mean missing.
named=""
deadline=$((SECONDS + 20))
while [ "${SECONDS}" -lt "${deadline}" ]; do
  if grep -q "No D1 binding named DB" /tmp/wrangler-no-db.log; then
    named="yes"
    break
  fi
  sleep 1
done

if [ -n "${named}" ]; then
  echo "  ok    the error names the missing binding"
else
  echo "  FAIL  the 5xx never named the missing binding, so something else threw"
  echo "----- wrangler log (no-db) -----"
  cat /tmp/wrangler-no-db.log
  echo "----- end -----"
  exit 1
fi

step "All gates passed"
