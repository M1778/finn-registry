# Sync.md — the `finn-registry` side

**Audience**: the planning agent that will read this file alongside `finn/Sync.md`, hold both
projects in mind, and hand scoped work to other agents. You will not write code; this is written so
that every plan you hand out can be grounded in a fact rather than an assumption.

**Pairs with**: `~/finn/Sync.md` (the CLI side).
**Written**: 2026-08-24, against `finn-registry` at `a0eb5d6` and `finn` at `1e73a4c`.
**Not the behaviour spec.** `docs/REGISTRY-API.md` is authoritative on what the endpoints do. This
file is about *state, seams, and what is unfinished* — the things a plan has to be built from.

---

## 0. Read this first: there is an unanswered reply sitting on the table

`~/finn/docs/REGISTRY-CONTRACT-REPLY.md` (636 lines) is the finn agent's reply to our
`docs/REGISTRY-CONTRACT.md`. It was written against **rev 2**. Our contract is now at **rev 5**,
and **rev 5 does not answer it.** Revisions 3, 4 and 5 were written without it having been read.

That is the single most important fact in this file. The reply contains:

- a **data-model change** for us (§1.5: drop `checksum`, make `commit` the integrity anchor),
- **eleven concrete asks**, ordered by how much each blocks the CLI (§5),
- a **new endpoint request** with a specified shape (§8.4, batch resolve),
- **settled answers** to three of our four open questions (§4.1, §4.2, §2.5),
- and a **confirmed "no"** on CLI authentication (§9).

Several of those are already satisfied on our side and simply have not been acknowledged; several
are not. §4 of this file walks all eleven with our current answer. **Any plan that does not start
by reconciling that reply will produce work that contradicts a decision the other side has already
committed to.**

---

## 1. The three documents on this side, and which one wins

| Document | Authority | Audience |
|---|---|---|
| `docs/REGISTRY-API.md` | **Behaviour.** If it disagrees with the contract, it is right. | the finn agent, any client |
| `docs/REGISTRY-CONTRACT.md` | **Intent** — why the surface is shaped this way, what is open. | the finn agent |
| `docs/adr/000*.md` | Decisions with their reasoning. Never shown to end users. | us |
| `CONTEXT.md` | Naming. **Fin** = language, **finc** = compiler, **finn** = CLI, **Finn Registry** = this. | everyone |

`README.md` states this order. Two corrections you should carry into any plan:

1. **The contract's §6 status table was wrong** and is corrected in this commit. It claimed
   "version records so `latest_version` resolves | Live". Nothing has ever written to the
   `versions` table (§3.2 below). `REGISTRY-API.md` §10.1 always said so. The finn agent may have
   read the wrong one.
2. The contract's §4.1 still says the checksum question "hinges on one answer — whether
   `calculate_package_hash` is reproducible from a clean clone". The reply answers it in full
   (§1.1–§1.6). That section is stale, not open.

---

## 2. What is built here, and what "built" does not mean

Stack: Next.js 15.5 App Router + React 19, Hono 4.13 on one catch-all route, Drizzle + D1 (SQLite),
Tailwind v4, deployed via `@opennextjs/cloudflare` to **Cloudflare Workers**. The budget constraint
is load-bearing and comes from the project owner: *no server, no storage we pay for.* Every design
choice that looks austere traces back to it.

**Live and covered by tests**: package resolve, both version endpoints, search/browse, publisher
profiles, health, both registration endpoints with the push-access gate, trust derivation, and
the proof-of-work gate. 185 tests, `tsc` clean, `eslint` clean, Worker bundles, and
`docker/verify.sh` boots the built Worker on real `workerd` with a real D1 and passes 9 HTTP probes.

**Live but untested**: `POST /api/me/verification-request`, `/api/stats`, `/api/dashboard/data`,
`/api/me/settings`, the OAuth sign-in flow, and the admin bench.

**"Live" does not mean deployed.** Nothing is deployed. `wrangler.jsonc:19` still carries
`"database_id": "REPLACE_WITH_D1_DATABASE_ID"`; no D1 database has been created, no migration has
been applied remotely, no Worker published. **There is no URL to point `finn` at.** Any plan that
assumes an integration test against a live host is planning against something that does not exist.

Branch: `feat/registry-implementation`. `master` is untouched.

---

## 3. The seams — every place the two projects must agree

This is the part to build work packages from. Each seam names what both sides do *today*, verified
against the code at the two commits in the header.

### 3.1 The hostname — blocks any real integration, both sides

| | |
|---|---|
| **finn does** | `registry.rs:7` — `DEFAULT_REGISTRY = "https://finn-registry.pages.dev"` (Cloudflare **Pages**) |
| **registry does** | deploys to Cloudflare **Workers** (ADR-0005), because Pages has no D1 binding and every endpoint is a database read |
| **breaks how** | a Pages host serves the static pages and **404s every API route**. `finn add <name>` would report "not found" for every package that exists. |
| **already fine** | overrides exist: `FINN_REGISTRY_URL` and `config.registry.url` (`registry.rs:41-43`). Only the compiled-in default is wrong. |
| **who decides** | us, and we have not. The contract (§5.7) asked finn to treat it as configurable rather than correct it to another literal, and promised to send the final host. **That promise is unkept.** |

One finn-side inconsistency to fold in: `install.rs:18` builds its client with
`RegistryClient::new(None)`, ignoring the configured registry that `add.rs:29` and `sync.rs:23`
both honour. So `finn install` would ignore a user's override.

### 3.2 Version records — the largest logic gap in either project

**Nothing writes to the `versions` table.** Verified: no `.insert(versions)` anywhere in `src/`;
the only inserts are `packages`, `users`, `logins`, `sessions`, `verificationRequests`,
`reviewMinutes`. Consequences, all of them the *normal* case today:

- `latest_version` is `null` on every package,
- `GET /api/packages/:name/versions` returns `{ versions: [] }`,
- `GET /api/packages/:name/versions/:version` 404s for every version of every package,
- `git_ref`, `commit`, `checksum` are never populated.

So the registry can answer *"what repository is this name?"* and cannot answer *"what versions does
it have?"*. Registering a name is not releasing anything.

The shape it needs already exists on the other side: finn's `LockedPackage` (`lock.rs:13-18`) holds
`version`, `source`, `commit`, `checksum` — which is a version record. finn already runs
`git rev-parse HEAD` to populate `commit`. **finn is the natural producer of version records and
will never hold a credential** (§3.7 below). That tension is unresolved and it is the one place
where the two projects' designs do not currently compose.

Options exist — a browser form per release, a GitHub App/webhook on tag push, reading tags from
GitHub on demand at resolve time — and choosing between them is a genuine cross-project decision.
It is listed in §8.

### 3.3 `checksum` vs `commit` — the reply asks us to delete a column

finn's reply §1.5 recommends: **drop `checksum` and `checksum_origin`; make `commit` the integrity
anchor.** The argument is strong and I have verified its premises against `integrity.rs` at
`1e73a4c` — all five defects it lists are still present, including the one that matters:

> `hasher.update(relative_path)` then `hasher.update(&bytes)` back to back, with no delimiter,
> length framing, or file count. A file named `ab` containing `c` hashes identically to a file named
> `a` containing `bc`.

Also real: a **dangling symlink makes a package unhashable** (`fs::read` → `?` aborts the whole
hash), and git can rewrite content at checkout (line endings), so a publisher-attested hash is not
reproducible across platforms. A commit SHA is a tree hash by construction, needs no algorithm
agreement, and detects the actual attack (a force-pushed tag).

**Blast radius on our side if adopted** — this is a work package, not a one-line change:

| Site | What is there |
|---|---|
| `src/lib/db/schema.ts:136-159` | `checksum`, `checksumOrigin` columns (+ a `CHECKSUM_ORIGINS` enum) |
| `src/app/api/[[...route]]/serializers.ts` | 4 references |
| `src/types/registry.ts` | 3 references |
| `src/app/page.tsx` | the homepage specimen ships a fake `checksum` and `checksum_origin: "publisher_attested"` |
| `src/components/registry/Countersignature.tsx` | renders it |
| `src/app/docs/integrity/page.mdx` | 8 references — a whole user-facing page built on the idea |
| `docs/REGISTRY-API.md` §2.3, §10.4 | documents it |

Note the honest complication: dropping it means rewriting a docs page that currently teaches
readers to rely on checksums. Do not let an agent delete the column and leave the page standing.

### 3.4 Trust — the CLI is currently blind to it

| | |
|---|---|
| **registry returns** | a nested `trust { level, publisher_verified, package_trusted, repo_ownership_confirmed }` on `GET /api/packages/:name` |
| **finn reads** | `PackageMetadata` (`registry.rs:20-26`) has **only** `name`, `description`, `repo_url`, `latest_version`. No `trust` field at all. |
| **why it doesn't crash** | serde ignores unknown fields. It parses fine and the CLI simply cannot see trust. |
| **their ask #3** | *is trust package-level or per-version?* It changes their control flow: package-level → resolve once per name and cache for the whole walk; per-version → needed on every version record. |
| **our answer, definitive** | **package-level.** It derives from `users.isVerified` and `packages.isTrusted`. `versions` (`schema.ts:136-159`) has no trust column and none is planned. Resolve once per name. |

That answer costs us nothing but a sentence in the contract, and it unblocks their dependency-walk
design. High value, near-zero work — a good first assignment.

### 3.5 The install prompt — finn currently does the opposite of the agreed policy

Agreed policy (contract §2.5, adopted verbatim in the reply §3): four levels, `verified` /
`trusted` / `recognized` never prompt, only **`unrecognized`** (not on the register at all) prompts;
non-interactive with no `--yes` fails closed; `--verified-only` fails once listing every offender.

What finn does at `1e73a4c`:

- `add.rs:204` sets `is_official: true` for **anything** resolved from the registry — so a
  `recognized` package is treated identically to a `verified` one.
- `install.rs:21` **hard-refuses** anything not from the registry: *"Security Error: Cannot install
  binary from unofficial source … without `--ignore-regulations`."* That is a refusal where the
  policy says prompt, and it uses `official`, a word the shared glossary bans outright.
- The reply commits to deleting `is_official` (`add.rs:20,174,192,199,204`), `ignore_regulations`
  (`main.rs:48,88,98`; `install.rs:14-15`; `add.rs:104`) and `validator.rs` entirely. **None of
  that is done yet.**

Registry side: no work. The provenance wording in the reply §3.1 renders from fields we already
return. Worth knowing so nobody assigns us a phantom "trust API" task.

### 3.6 Two live CLI bugs that make version-pinned resolve impossible

Still present at `1e73a4c`, both on one statement:

- `add.rs:203` — `client.get_package(input)` is passed the raw input **including** `@version`,
  while every other branch uses `base_input`. So `finn add http@1.2.0` asks the registry for a
  package literally named `http@1.2.0` and 404s.
- `add.rs:204` — `version: metadata.latest_version` discards the version the user asked for.

Consequence for planning: **there is no working version-pinned path today on either side** — ours
returns no versions, theirs discards the request. Any plan that tests version resolution end-to-end
needs both halves fixed in the same cycle.

### 3.7 CLI authentication — settled, closed, on both sides

The reply §9 is unambiguous: *"Nothing on my side holds, wants, or has ever held a registry
credential."* Verified by grep across `finn/src` for `token`, `api_key`, `credentials`, `login` →
zero matches. No `finn login`, no token in `finn.toml` (which is committed to source control by
design), no device-code flow. `api_keys` and `auth_codes` are **already gone** from our schema.

One disclosure they made in good faith: a `~/.finn/credentials.toml` is *sketched* for a future
**compiler-artifact mirror** (private toolchain builds behind a corporate proxy) — not for the
registry, nothing written, and no credential from it would ever be sent to a registry origin.

**The project owner's standing instruction**, which any future plan must honour: if a CLI-facing
authenticated endpoint ever becomes necessary, it is gated with **strict rate limiting and proven
CLI-auth methods** (device flow, or a pasted token) — **never a captcha**, because a person cannot
solve one in a terminal. See §3.8.

### 3.8 The proof-of-work gate — browser-only, nothing for finn to do

Shipped in `a0eb5d6`. An HMAC-signed challenge; the browser searches for a nonce whose
SHA-256 of `salt.nonce` has N leading zero bits; we verify with one HMAC and one hash. No vendor, no
API key, no new dependency.

| Gated | Bits |
|---|---|
| `GET /api/auth/github` (sign-in) | 13 |
| `POST /api/registrations/check` | 14 |
| `POST /api/packages` | 15 |
| `POST /api/me/verification-request` | 15 |

**Every gate is browser-facing. No endpoint `finn` calls issues or checks a challenge**, and none
ever will. Refusal is `428` with `{error:"captcha_required", reason, message}`. If a plan ever adds
a route the CLI calls, the reviewer's check is: it must not reach for `requireCaptcha`.

Operational note for whoever deploys: set `CAPTCHA_SECRET` (`openssl rand -hex 32`). Unset, the
signing key is random **per isolate** — deliberately not a hardcoded literal, since that would be
published in the source and forgeable. The cost is that a challenge issued by one isolate fails in
another; the client absorbs it with one retry and sign-in gets two attempts.

### 3.9 Rate limits, retry, and the free tier

Ours (`router.ts:85-99`): reads **1000 / 15 min** per IP, writes 100 / 15 min, registration 30 /
15 min, sign-in 20 / 5 min (two requests per sign-in since the interstitial), `/api/captcha` 120 /
5 min. Keyed on `x-forwarded-for` (`rate-limit.ts:56`) — so a shared NAT or a CI fleet shares one
bucket.

Theirs, now settled (reply §4 item 3): at most **3 attempts**; retry only on `429`, `5xx`, connect
timeouts; **never** other `4xx`; honour `Retry-After`; exponential backoff with jitter; a hard
overall deadline; **concurrency cap 4**. `reqwest-middleware` and `reqwest-retry` are being deleted
rather than wired up, so the observable backoff is that policy and not a library default. Critically:
**a `5xx` never means absence** — only a genuine `404` means the package does not exist.

`--offline` does not exist yet in `FinnContext` (`main.rs:84-89`) and is being introduced with that
same change.

### 3.10 Naming drift in our docs

The reply §6 retires `finn healthcheck`, splitting it into `finn check` (typechecks your code via
`finc`) and `finn doctor` (inspects your installation; `--fix` repairs). Our
`src/app/docs/installing-finn/page.mdx:55` still explains `finn healthcheck`. Small, but it is
user-facing and it will be wrong the moment they ship.

---

## 4. finn's eleven asks, with this side's answer

From the reply §5, in their priority order. This table is the fastest route to a first wave of work.

| # | Ask | Status here |
|---|---|---|
| 1 | `GET /api/packages/:name` as specced | **Done.** Live and tested. Fixes `finn add <bare-name>` with zero CLI changes. |
| 2 | snake_case on CLI-facing responses | **Done.** Enforced by `serializers.ts`; responses are never raw Drizzle rows. |
| 3 | `trust` on version endpoints, *or* a guarantee it is package-level | **Answerable now, unanswered.** It is package-level (§3.4). Needs writing into the contract. |
| 4 | Never fabricate `latest_version` | **Done**, and permanently guarded — `tests/regressions/no-fabricated-version.test.ts`. |
| 5 | A version-existence answer, so `pkg@9.9.9` fails cleanly | **Blocked by §3.2.** The route exists and 404s distinctly; it 404s for *everything*, so it cannot yet distinguish. |
| 6 | Ship `GET /api/health` | **Done.** Live, tested, probed on `workerd`. Goes into `finn doctor`. |
| 7 | A documented name-normalisation rule | **Answerable now.** `NAME_RULE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`, length 2–64 (`router.ts:696`). Lowercase only, so `My-Pkg` and `my_pkg` are **invalid**, not normalised — there is no collision to handle. This matters to them because a name becomes a directory and therefore an *import* name. |
| 8 | Keep responses `file://`-mirror-able | **Satisfied, and worth protecting.** Plain JSON at predictable paths. `§3.5`'s query parameters are the one place it could drift. |
| 9 | Immutability stated as a guarantee | **Not written down.** True in practice (`yanked` is a flag; nothing mutates a version row — nothing writes them at all). One paragraph of work. |
| 10 | Batch resolve | **Not built.** Their shape: `GET /api/packages/resolve?names=http,json@1.2.0,fs` — a `GET` because it is edge-cacheable on Workers; accepts `name` or `name@version`; returns a **name-keyed map with explicit `{"error":"not_found"}` entries** (silent absence is useless to them); capped at our choice; one indexed `WHERE name IN (…)`. Takes a cold 30-package resolve from 30 requests to 4–6. |
| 11 | Embed the latest version record in §3.2, or accept `?resolve=latest` | **Not built.** Cheapest item in the list, no new route, halves the unpinned case. |

Note that **#5, #10 and #11 all depend on §3.2** — version records existing at all. That
dependency should shape the wave ordering.

---

## 5. What remains on this side, in dependency order

Framed as assignable packages. Every one is verifiable locally; none needs a deploy.

1. **Answer the reply.** Contract rev 6: answer asks 3, 7, 9; retire the stale §4.1; correct §6;
   record the settled §2.5 four-level table and the retry policy. Pure documentation, unblocks
   their control-flow decisions. *No dependencies. Start here.*
2. **Decide the version-record write path** (§3.2). This is a design decision before it is code,
   and it gates 3 of their 11 asks. See §8.
3. **`checksum` → `commit`** (§3.3), if adopted: schema, serializers, types, homepage specimen,
   `Countersignature`, and a rewrite of `docs/integrity`. Needs a migration.
4. **Batch resolve** (ask 10) and **`?resolve=latest`** (ask 11). Both need (2) to be meaningful.
5. **Deploy for real**: `wrangler d1 create`, apply migrations remotely, set `CAPTCHA_SECRET` and
   the GitHub OAuth pair as Worker secrets, publish, **then** settle the hostname on both sides in
   one cycle (§3.1).
6. **Test the untested browser surface** (§2): verification requests, stats, dashboard, settings,
   OAuth, the admin bench.
7. **Smaller, known, and out of scope so far**: `authError`'s HTML loads `https://cdn.tailwindcss.com`
   (an external CDN script in a page we serve) and uses `rounded-3xl`, which violates the house
   radius rule; `/package/[name]` ships 94 kB of page JS; `@tailwindcss/typography` is a dependency
   that was never registered with Tailwind v4, so `.prose` compiles to nothing and the `prose-*`
   classes in `PackageTabs.tsx` are dead; `jose`, `cmdk` and `fuse.js` are unused. The last group
   needs a lockfile update, which has been off-limits.

---

## 6. Settled — do not let an agent reopen these

Each of these was argued once and costs real work to relitigate.

- **The registry indexes; GitHub serves.** We never host code. ADR-0001. *Never phrased to end
  users as "we do nothing" — the owner was explicit about that. It is architecture, not copy.*
- **Names are bare and globally unique**; a slash always means GitHub, permanently.
- **A name claim requires proven push access** to the repository it points at (ADR-0004).
- **Two independent trust signals**: admins verify publishers, moderators mark packages trusted.
  The CLI branches on `trust.level` only.
- **snake_case on every CLI-facing response**, built by `serializers.ts`. It is a wire contract.
- **No CLI authentication** (§3.7), and no captcha on any CLI route (§3.8).
- **No hardcoded secret defaults, ever.** A JWT fallback secret was removed in `571b207`; the
  captcha's key deliberately repeats none of it.
- **Dark by default with a light toggle**; brass/verdigris/oxblood are reserved trust pigments;
  radius encodes kind (`--radius-document: 2px`, only seals are pills); identifiers are mono.
- **No fabricated facts in the UI.** No download counts, no star counts, no "official" badge.
  Absent beats zero, because a zero reads as "nobody uses this" rather than "we do not measure it".
- **`official` is a banned word in both projects.** It implies the Fin project endorses code it has
  never read.

---

## 7. How to verify anything in this file

```
npx tsc --noEmit
npm run lint                 # eslint src tests --max-warnings=0 — `src` alone misses test lint
npx vitest run               # 185 tests
npm run build
sudo docker build -t finn-verify . && sudo docker run --rm finn-verify   # the full gate on workerd
```

`docker/verify.sh` is the only thing that proves the Worker boots on the runtime we deploy to:
everything else runs on Node. It also boots the Worker **without** a D1 binding and asserts the 5xx
names the missing binding, because that is the state a first deploy lands in.

Never run `npm install` / `npm ci` on the host — the lockfile is not to be updated. `npm ci` runs
inside Docker only.

A dev server is usually up on port 3000 for UI review. Do not run `npm run build` while it is
running: the production build overwrites `.next/` underneath it and every page starts 500ing with
`MODULE_NOT_FOUND`. Restart the dev server after a build.

---

## 8. What only you can decide, holding both projects

1. **How version records get created** (§3.2). The registry has no writer; finn has the data
   (`LockedPackage`) and will never have a credential. Browser form per release, GitHub App on tag
   push, or read tags from GitHub at resolve time? This gates asks 5, 10 and 11, and it is the one
   place the two designs genuinely fail to compose.
2. **Whether to adopt `commit` over `checksum`** (§3.3). The argument is sound; the cost is a
   migration and a user-facing docs rewrite. It is the reply's headline recommendation and it
   should be accepted or rejected explicitly, not left to drift.
3. **The hostname, and the order of operations around it** (§3.1). Ours must be created before
   theirs can be corrected, and both sides must land in one cycle or `finn` ships pointing at a
   host that 404s.
4. **Wave composition.** §3.6 is the clearest example of why: version-pinned resolve needs a fix in
   *both* repos before it can be tested at all. Independent agents on independent repos will each
   report success while the pair remains broken.
5. **Who owns the shared vocabulary.** `CONTEXT.md` here and the glossary in the reply's §6 are two
   copies of one thing. They have already drifted once (`finn healthcheck`, §3.10). One of them
   should be the source.
