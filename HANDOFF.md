# HANDOFF.md — where this project stands, and what is left

**Written**: 2026-08-26. **By**: the planning agent, after twelve verified work cycles.
**Audience**: whoever picks this up next — a fresh agent with no memory of this work, or a human
deciding what to fund. Read this file first and read it whole; it is the only document that holds
all three projects at once.

**Why this file exists.** The work is moving to another machine. Everything below is either
committed in git or stated here; nothing load-bearing lives only in a conversation. Where a claim
is a measurement, the command that produced it is named so you can re-take it rather than trust it.

---

## 1. The three projects, and the one-paragraph version

| Repo | What it is | Language / stack | Licence |
|---|---|---|---|
| `~/Fin` | The **Fin** language and its compiler, `finc` | C++ / LLVM / CMake | GPL-3.0-only |
| `~/finn` | **finn**, the package manager (a CLI) | Rust, crate 0.4.0, edition 2024 | GPL-3.0-only |
| `~/finn-registry` | **Finn Registry**, the index and its website | Next.js 15.5 App Router, React 19, Hono 4.13, Drizzle + D1, on Cloudflare **Workers** via `@opennextjs/cloudflare` | AGPL-3.0-only |

**The naming is load-bearing and everyone gets it wrong at least once.** **Fin** is the language.
**finc** is the compiler. **finn** — two n's — is the package manager. **Finn Registry** is the
registry. The extra letter is the whole distinction. `CONTEXT.md` in this repo is the glossary.

**The architecture in one sentence**: the registry *indexes*, GitHub *serves* — no package code is
ever hosted here (ADR-0001), so a registry entry is a name, a repository, a version record and a
trust level, and `finn` fetches the code from GitHub itself.

**Why that shape**: the owner's constraint is no server and no storage budget. Everything must run
on Cloudflare's free tier or GitHub Pages. That is not a preference to be optimised away later; it
is the reason the design is what it is.

---

## 2. Where to read next — the document map

Do not start from the code. Four documents carry the reasoning, and they have different jobs:

| Document | Job | Size |
|---|---|---|
| `finn-registry/Sync.md` | **The registry's state, seams and open work.** Twelve dated cycle records with what was verified and how. | ~1820 lines |
| `finn/Sync.md` | **The CLI's side of the same seams**, numbered to match (§3.1 here = §3.1 there). | ~1836 lines |
| `finn-registry/docs/REGISTRY-API.md` | **Authoritative on what the endpoints do** — payloads, status codes, limits. | — |
| `finn-registry/docs/REGISTRY-CONTRACT.md` | **Authoritative on intent** — why the surface is shaped this way, what is open. At rev 8. | ~1250 lines |

**Precedence when two disagree**: `REGISTRY-API.md` wins on *behaviour*; `REGISTRY-CONTRACT.md`
wins on *intent*; a disagreement about behaviour is a bug worth reporting, not a style question.

`finn/docs/REGISTRY-CONTRACT-REPLY.md` (636 lines) is the CLI side's reply to the contract. It was
written against **rev 2** and the contract is now rev 8, so read it as history — its eleven asks are
answered in `finn-registry/Sync.md` §4 with current status.

**The two `Sync.md` files are planner-only.** They are the handoff between planning agents. An
implementing agent should be *given* the relevant section, not asked to edit the file.

---

## 3. How far from production: honest answer

**The code is close. The deployment is not started.** Nothing has ever been deployed. There is no
hostname. That is the gap, and it is mostly configuration and credentials rather than engineering.

### What is green, measured 2026-08-26 on this machine

**Registry** — every exit code taken unpiped, because `$?` after a pipe is the *last* stage's status
and reading it as the command's has produced a false green twice in this project:

| gate | result |
|---|---|
| `npx tsc --noEmit` | 0, and 0 bytes of output |
| `npm run lint` (`eslint src tests --max-warnings=0`) | 0 |
| `npx vitest run` | **374 passed / 19 files**, 0 failed, 191s |
| `npm run cf:build` | 0 — `OpenNext build complete.`, 26 routes |

**finn**:

| gate | result |
|---|---|
| `cargo build` | 0 |
| `cargo test` | **157 passed** across 14 suites, 0 failed, 0 ignored |
| `cargo fmt --check` | 0, and 0 bytes of output |
| `cargo clippy` | 0, and 0 warning/error lines |

The test totals are **summed from the per-file lines by hand**, not read off the summary. A test
filter matching zero tests is a harness error, not a pass — so a count is part of the evidence.

### What "green" does not mean

- **Not deployed.** `wrangler.jsonc` carries a placeholder D1 `database_id`. Migrations have never
  been applied to a remote database. No secrets are set.
- **Barely exercised on the deploy runtime.** The suite runs on **Node** against a temp SQLite file.
  Only `/api/health`, `/api/packages` and a 404 on an unregistered name have been served from real
  `workerd` with a D1 binding, and that against an empty register. `docker/verify.sh` is the gate
  that covers this and it needs `sudo docker`.
- **The register is empty.** All seven rows in the local dev database are fictions pointing at
  third-party repositories.
- **No version records exist anywhere.** See §5.1 — this is the largest open design question.

---

## 4. The deployment path, in order

Nothing here is blocked on engineering. Steps 1–5 are credentials and configuration; step 6 is the
one that makes discovery work.

1. **Merge to the default branch.** Registry work is on `feat/registry-implementation`; `origin`
   holds only `master`. **This is the highest-leverage action in either repository** — and not for
   tidiness: `registry/v1/url.txt` and `registry/v1/packages.json` are the discovery files `finn`
   fetches from GitHub raw, and raw URLs resolve against the **default branch**. Until this merges,
   both 404 and `finn` has nothing to fall through to.
2. **`wrangler d1 create`**, then put the real `database_id` into `wrangler.jsonc`.
3. **Apply migrations remotely** — `drizzle/0000_registry_schema.sql`.
4. **Create a GitHub OAuth app.** Sign-in asks for `user:email` only; the wider repository scope is
   requested incrementally at registration (ADR-0004), so create it with no special permissions.
   Callback URL must be `<APP_URL>/api/auth/github/callback`, port included — a mismatch surfaces as
   GitHub's `redirect_uri_mismatch`, which reads like the app being misconfigured rather than a URL
   typo.
5. **Set three secrets** with `wrangler secret put`, never in `wrangler.jsonc` (it is committed):
   `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `CAPTCHA_SECRET`. Set `APP_URL` in `wrangler.jsonc`'s
   `vars` — it is not a secret, and it is the **only** source of the origin; sign-in refuses and
   names it rather than guessing from a request header. `.dev.vars.example` documents every variable
   and why.
6. **Publish, then append the real URL to `registry/v1/url.txt`.** One line, to a file already on
   the default branch. No second merge, no CI change, **no finn release** — the whole point of the
   pointer design.
7. **Run `docker/verify.sh`** against the real thing, and re-run `npm run build:fallback-index`.

**Read §4.1 before step 6.**

### 4.1 Why `url.txt` has no URL in it, and must not get a guessed one

`registry/v1/url.txt` is 135 lines of comments and **zero** URL lines. That is deliberate, it is
recorded in the file itself, and it is the single easiest thing for a new agent to "helpfully" break.

A placeholder URL **passes every format rule the file documents** — https, non-empty host, no
trailing slash, no path. So `finn` would accept it, **cache it for 24 hours**, and then report the
registry as *unreachable* rather than *undeployed*. That converts "not deployed yet" into "your
package does not exist", which is exactly the failure the CLI's tier-3 removal was designed to
prevent, reintroduced one layer up.

With no URL line, `finn`'s `parse_pointer` (`~/finn/src/discovery.rs:453`, message at `:463`)
reports *"it contains no URL line -- every line is blank or a comment"*, finds no cache and no
compiled-in default, and errors naming both escape hatches. **That is the honest failure and the one we want.**

Three guards enforce this and were each exercised in both directions:
`tests/regressions/no-guessed-registry-url.test.ts`, `scripts/build-fallback-index.mjs` (refuses to
generate from a placeholder pointer), and `scripts/check-fallback-index.mjs --pointer` plus a
preflight in `.github/workflows/fallback-index.yml`.

### 4.2 The three-tier URL discovery, because it is unusual

`finn` never has a compiled-in registry address. It resolves one:

- **Tier 1** — `[registry].url` in `finn.toml`, then `$FINN_REGISTRY_URL`.
- **Tier 2** — the pointer file `registry/v1/url.txt` on GitHub raw, cached 24 hours.
- **Tier 3** — **deliberately none.** `DEFAULT_REGISTRY: Option<&str> = None`. A compiled-in host
  that 404s turns "not deployed" into "your package does not exist".
- **Fallback index** — `registry/v1/packages.json`, for when the registry is unreachable. Standard
  library and recognised packages resolve from this single file.

So the registry's hostname can change at will and no `finn` release is needed. **Never hardcode a
registry URL, and never guess a repository from a package name.**

---

## 5. What is genuinely unfinished

Ordered by whether it blocks a working product.

### 5.1 BLOCKING DESIGN DECISION: how version records get created

**Nothing in either codebase has ever written to the `versions` table.** Not a route, not a server
action, not a script. Consequences, all of which are the normal case today: `latest_version` is
`null` on every package, `GET /api/packages/:name/versions` returns `[]`, and §3.4 404s for every
version of every package.

This gates three of the CLI's eleven asks and it is the one place the two designs genuinely fail to
compose. It has been narrowed to a single question:

> **Does the registry acquire a GitHub identity of its own?**

Because today the only GitHub credential the registry ever holds is the registrant's, and it lasts
as long as their browser session. The registry has no writer. `finn` *has* the data — its
`LockedPackage` already holds exactly the four fields a version record needs — and will never hold a
credential to submit it with.

Three shapes, none chosen: a browser form per release; a GitHub App on tag push; or read tags from
GitHub at resolve time. **This is an owner decision, not an agent's.**

### 5.2 Open, needs an owner's ruling

1. **`checksum` → `commit`** (§3.3 both files). The CLI side's headline recommendation: a commit SHA
   identifies "the same code" more honestly than a checksum of an archive whose bytes GitHub does not
   guarantee to be stable. The argument is sound; the cost is a migration plus a user-facing docs
   rewrite. Should be accepted or rejected explicitly rather than left to drift.
2. **`repo_ownership_confirmed` → `ownership_proven_at`?** Today it is a literal `true`, which is
   honest (a registration that cannot prove push access is refused, so no row exists with it false)
   but says nothing after a repository is transferred, deleted or abandoned. A *timestamp* would be
   checkable. It is a migration, so it is the owner's.
3. **Do stdlib modules become registered packages?** `scripts/fallback-stdlib.mjs` ships
   `STDLIB_ENTRIES = []` deliberately: per `~/Fin/docs/finc-interface-contract.md` the stdlib ships
   *inside the compiler archive* and `finn` never fetches it. `~/Fin/lib/std/` now exists with 11
   modules, so this is live rather than hypothetical. Deciding otherwise changes both repositories;
   the empty array is the seam.
4. **Who owns the shared vocabulary.** `finn-registry/CONTEXT.md` and the glossary in the reply's §6
   are two copies of one thing and have already drifted once. One should be the source.
5. **Wave composition.** Some fixes need *both* repos changed before they can be tested at all.
   Independent agents on independent repos will each report success while the pair stays broken. The
   clearest case is version-pinned resolve (§3.6 both files).

### 5.3 Registry: known and unfixed

- **The OAuth callback flow has no end-to-end test.** Two regressions pin two specific historical
  bugs in it (`no-state-to-parent-frame`, `no-origin-from-headers`, 9 cases each) but nothing walks
  the callback from start to finish. This is the last real coverage gap.
- **`GET /api/auth/status` returns the entire `users` row** — `bio`, `blog`, `location`, `githubId`,
  the internal `id`. Documented as deliberate in `REGISTRY-API.md` §7, but the dashboard was narrowed
  in cycle 12 and the two endpoints now disagree about what an account looks like. The narrowed one
  is correct. `dashboardUserColumns` in `src/lib/registry/queries.ts` carries the reasoning.
- **Two page components have no test at all** — `src/app/new/RegisterForm.tsx` and the homepage
  specimen. There is no DOM test harness in this repo and adding one means a lockfile change (below).
  They rest on typecheck and review.
- **`/package/[name]` ships 94 kB of page JS** (200 kB First Load), the heaviest route.
- **Four dependency issues, all blocked on the lockfile being off-limits**: `fuse.js` and
  `@tailwindcss/typography` are declared and imported nowhere; `cmdk` is imported only by
  `src/components/ui/command.tsx`, which nothing imports; `jose` is a `dependencies` entry whose only
  importer is a test, so it belongs in `devDependencies`.
- **No CI job runs the fallback-index generator.** Until one does, the index is a snapshot someone
  remembered to regenerate. `generated_at` is the only field that moves on an unchanged register —
  entries are sorted for byte-stable output — so a scheduled job produces a one-line diff.

### 5.4 finn: known and unfixed

- **`release.yml` publishes no checksums** (`grep -c 'sha256\|shasum'` = 0). `install.sh` now
  verifies a checksum correctly and distinguishes all six failure modes — but **no release publishes
  one**, and there are zero releases and zero tags, so the archive 404s before the checksum code is
  reached. The real fix belongs in the release workflow.
- **No arm64/aarch64 support.** `install.sh` assigns `ARCH`, `VERSION` and `BINARY_NAME` and uses
  none of them.
- **Both release archives put `README.md` into `~/.finn/bin`** (`release.yml:50` Windows, `:73` unix).
- **`installer.iss:5` says `MyAppVersion "0.3.0"`** against crate 0.4.0.
- **`install.sh` tells Windows users to run `export PATH`.**
- **The banned word `official` survives in four `.rs` comments** (`install.rs:57-58`, `add.rs:23,28`)
  and in `docs/REGISTRY-CONTRACT-REPLY.md:211`.
- **`m1778` is missing from `FIN_KEYWORDS`** — 57 words against the register's 58. The register is
  right (`Fin/src/lexer/lexer.l:209` → `KW_M1778`). Blocked: `src/finname.rs` is **frozen**.
- **Open tickets**: rename `finn build` → `finn check`, add `finn doctor`, retire
  `finn healthcheck` (§3.10); `nowhere_to_ask()` prints the pointer URL twice.

### 5.5 Recommended, not started

- Branch protection and signed commits on the registry's default branch.
- A `CONTRIBUTING` file recording the **one-directional copy rule**: finn/Fin → registry, never back.

---

## 6. Settled — do not reopen these

Each was argued once and costs real work to relitigate. Full text in `finn-registry/Sync.md` §6.

- **The registry indexes; GitHub serves.** Never host code (ADR-0001). *Never phrased to end users
  as "we do nothing" — that is architecture, not copy.*
- **Names are bare and globally unique.** A slash always means GitHub and never reaches the registry
  (ADR-0002).
- **A registry name is a Fin identifier**: `^[a-z][a-z0-9]*$`, length 2–64, and not one of Fin's
  **58** reserved words — refused at registration, not normalised. Owner's ruling 2026-08-24. The
  list derives from `Fin/src/lexer/lexer.l`; **`Fin/src/diagnostics/DiagnosticEngine.cpp` looks like
  the keyword list you want and is not one** — it is diagnostics-only and names eight words the lexer
  does not reserve. Ordering constraint if anyone schedules this work: **the register narrows first,
  the CLI follows.** The reverse breaks working installs.
- **A name claim requires proven push access** to the repository it points at (ADR-0004).
- **Two independent trust signals**: admins verify *publishers*, moderators mark *packages* trusted.
  The CLI branches on `trust.level` only, never on a raw column.
- **snake_case on every CLI-facing response**, built by `serializers.ts`, never a Drizzle row. It is a
  wire contract: `finn`'s `PackageMetadata` derives `Deserialize` without `rename_all`, so a
  camelCase field deserializes as *absent* rather than failing loudly.
- **No CLI authentication, and no captcha on any CLI route.** A human cannot solve a challenge in a
  terminal. `finn` gets strict rate limits and token auth instead. The browser forms carry
  proof-of-work (login 13 bits, register and verify-request 15).
- **No hardcoded secret defaults, ever.**
- **Dark by default with a light toggle.** Brass, verdigris and oxblood are reserved trust pigments;
  radius encodes kind (`--radius-document: 2px`; only seals are pills); identifiers are mono.
- **No fabricated facts in the UI.** No download counts, no star counts, no "official" badge. Absent
  beats zero — a zero reads as "nobody uses this" rather than "we do not measure this".
- **`official` is a banned word in both projects.** It implies the Fin project endorses code it has
  never read.
- **The registry is a trust and credit layer — never say so to users.** It is architecture, not copy.

---

## 7. How to work on this — the method that earned the green gates

This section is the part most likely to be skipped and most expensive to relearn. Every rule below
was paid for by a real false result in this project.

**Verification**
- **Take every exit code unpiped.** `$?` after a pipe is the last stage's status. This produced a
  false green *and* a false red here.
- **A non-zero exit is not evidence until you have read why.** Four "enforcement passed" results
  were argument errors.
- **A test filter matching zero tests is a harness error, not a pass.** Record the baseline count.
- **A green suite proves nothing until it is shown to bite.** Reintroduce the defect, watch the test
  fail, restore, `diff` to confirm. A mutation that changed nothing is not a passing test — it is an
  unrun one.
- **Sum per-file counts by hand** rather than reading a total.
- **A readiness probe must establish identity, not just reachability.** A probe against a fixed port
  once passed instantly against *another process's leftover server* while the intended one had died
  with `EADDRINUSE`. Use a dynamic port plus a token endpoint, and check the PID is alive.
- **Before a negative result means anything, prove the instrument reaches the thing measured.** A
  grep that cannot decode a file reports *nothing*, not an error (pass `-a`). A sweep aimed at
  guessed values cannot report absence. An instrument that errors into `/dev/null` reports clean.

**Evidence and citations**
- **A range check catches typos, not wrong targets.** Four instances here, all found by reading, none
  by the mechanical sweep — including one in a brief handed to an agent. The citations most worth
  re-opening are the ones in your own instructions to someone else.
- **A cumulative diff against `HEAD` is not evidence about the current cycle.**
- **Compare files against files** (`find -newer <reference>`), never against a remembered clock
  reading: **the clock on this machine is not monotonic** — `date` read 13:18, then 20:41 a few
  operations later. Run a positive control last as well as first.
- **A failed request never means absence, and a 5xx never means absence.** Only a definitive 404
  does. `curl --fail` destroys that distinction by folding "the server said it's absent" into the
  same non-zero as "we never got an answer" — which is why `install.sh` deliberately omits `-f`.
- **A handoff that bills finished work as open sends the next agent to redo it.** Three entries in
  these files did exactly that. Update the figures a reader is told to *expect*; never the figures a
  reader is told were once *observed* — those are history and are how a later reader tells growth
  from drift.
- **An arm nothing has ever run is not code that works; it is code that has never been contradicted.**

**Local hazards**
- **Never run `npm install` / `npm ci` / `bun install` on the host.** The lockfile is not to be
  updated. `npm ci` runs *inside Docker only*.
- **Do not run a production build while the dev server is up.** `cf:build` overwrites `.next/` under
  it and every page starts 500ing with `MODULE_NOT_FOUND`. Restart with
  `npx next dev -H 0.0.0.0 -p 3000`. (I walked into this myself *after* documenting it — capture the
  recovery command first.)
- **The vitest timeout is 30s deliberately** (`vitest.config.ts`). Real proof-of-work means one test
  can do ~100k hashes; the 5s default was flaky under load. **The difficulty is not lowered for
  tests and there is no env knob to lower it** — it is a production security parameter, and a lever
  that weakens it for convenience is worse to own than a slow suite.
- **Order-blind fixtures need three shuffled names.** SQLite sorts a `DESC` key by scanning ascending
  and reversing, so a fixture in the exact reverse of the asserted order detects nothing.
- Docker needs `sudo -n`. Foreground `sleep` is blocked in this harness.

**Working agreement**
- **Commits and pushes happen only on the owner's explicit request.**
- Git identity is repo-local: `M1778M <m1778.pc@gmail.com>`.
- **`~/finn/src/finname.rs` is frozen.** Do not touch `Cargo.toml` / `Cargo.lock`,
  `vitest.config.ts`, or `registry/v1/url.txt` without saying so first.
- The GitHub org is **`M1778`**. `M1778M` is the owner's *former* account name and also the git
  author identity — `github.com/M1778M/finn` answers **301** to `M1778/finn`. Point new URLs at
  `M1778`.

---

## 8. State of the repositories at handoff

| Repo | Branch | HEAD after this commit | Notes |
|---|---|---|---|
| `finn-registry` | `feat/registry-implementation` | `5567e17` | **Not merged to `master`**; `origin/master` is `a5ef515`. Merging is step 1 of §4. |
| `finn` | `master` | `7c3b190` | Committed directly on `master`. `target/` is gitignored. |
| `Fin` | `wave3-semantics` | `848fde1` | **Another agent is preparing this repo — do not touch it.** Fully pushed. Three CMake artifacts are staged as *deletions*, which is correct: they were committed from another machine carrying a `/mnt/c/...` path and are gitignored. |

**Pushing is the owner's.** These commits are local until they push.

---

## 9. If you read only one thing

The registry works, is tested, and has never been deployed. The next three actions, in order:

1. **Merge `feat/registry-implementation` to `master`** — without it the discovery files 404 and
   `finn` cannot find the registry at all.
2. **Answer §5.1** — does the registry get a GitHub identity of its own? Nothing can write a version
   record until someone decides, and three of the CLI's asks are stuck behind it.
3. **Deploy, then append one line to `registry/v1/url.txt`.** Do not put a placeholder there first.
