# Sync.md — the `finn-registry` side

**Audience**: the planning agent that will read this file alongside `finn/Sync.md`, hold both
projects in mind, and hand scoped work to other agents. You will not write code; this is written so
that every plan you hand out can be grounded in a fact rather than an assumption.

**Pairs with**: `~/finn/Sync.md` (the CLI side).
**Written**: 2026-08-24, against `finn-registry` at `a0eb5d6` and `finn` at `1e73a4c`.
**Not the behaviour spec.** `docs/REGISTRY-API.md` is authoritative on what the endpoints do. This
file is about *state, seams, and what is unfinished* — the things a plan has to be built from.

**Verified independently by the planner after cycle 3.** Not read from the agent's report — re-run.
Typecheck `exit 0`, `eslint src tests --max-warnings=0` `exit 0`, `vitest run` **257 passed / 13
files** `exit 0`, `npm run build` `exit 0` with 22 routes. Every exit code taken unpiped: `$?` after
a pipe is the *last* stage's status, and reading it as the command's has now produced a false green
twice in this project, once in each direction. `vitest.config.ts` md5 unchanged
(`9e17d6476687e3894412efaa0d874140`) and `registry/v1/url.txt` unchanged
(`8089f946b28bfefb4261c13a379e81f9`) — both were off-limits and both held.

**Both of those baselines have since been re-checked, and one of them was a trap.** As of
2026-08-25 `vitest.config.ts` still hashes to `9e17d64…` exactly — but it also shows as ` M` in
`git status`, because the `9e17d64…` I recorded after cycle 3 was taken of a file that *already*
carried the `testTimeout: 30_000` change (§7). So "unchanged" there means unchanged **against my
baseline**, not identical to `HEAD`, and an agent reading it as the latter will report a violation
that is not one. `registry/v1/url.txt` now hashes to `bc3607914602b094579f6e151181710b`: I rewrote
it myself in a later cycle (§3.16), it is untracked so `git status` cannot show the change, and
`8089f946…` is simply the wrong number to guard with today. **A guard whose expected value is stale
fires falsely every time, and a guard that cries wolf is worse than no guard** — it trains the next
agent to wave the check through. Both numbers above are kept as history; the ones to compare against
are these.

**The denylist was re-derived from `Fin/src/lexer/lexer.l` by the planner, from scratch**, not
diffed against the agent's: 112 quoted-literal rules in the lexer, filtered to those `NAME_RULE` can
spell, gives **58** words. Set difference with `FIN_RESERVED_WORDS` is empty **in both directions**,
`m1778` is present, and none of the eight `DiagnosticEngine.cpp`-only words appears. Two independent
derivations agreeing is the only reason to believe a hand-crossed repository boundary.

**Mutation-tested, because a green suite proves nothing until it is shown to bite.** The agent
red-tested the denylist; the planner tested the *narrowing*, which it had not. Baseline
`registrations.test.ts` = **58 tests** (a filter matching zero tests is a harness error, not a pass —
that is why the baseline count is recorded). Widening `NAME_RULE` back to permit interior hyphens:
**2 failed**. Dropping `m1778` alone from the set: **1 failed**. File restored and `md5sum -c`
confirmed byte-identical after each. Separately, `scripts/check-fallback-index.mjs` refuses
`http-client`, `let` and `m1778` as index keys (`exit 1`, each naming the rule), passes the real
index (`exit 0`), and dies fatally — not silently — when `NAME_RULE` is renamed out from under its
extractor. The planner's first attempt at those four probes was invalid: the script needs
`--candidate`, so the `exit 1`s were argument errors, not enforcement. **A non-zero exit is not
evidence until you have read why it is non-zero.**

---

## 0. Read this first: there is an unanswered reply sitting on the table

`~/finn/docs/REGISTRY-CONTRACT-REPLY.md` (636 lines) is the finn agent's reply to our
`docs/REGISTRY-CONTRACT.md`. It was written against **rev 2**. Revisions 3, 4 and 5 were written
without it having been read.

**Rev 6 (2026-08-24) is the first revision written in answer to it**, and it closes the three asks
that needed no new code: §2.9 (ask 3, trust is package-level), §2.10 (ask 7, the name rule), §2.11
(ask 9, version immutability). Its §0 carries a "Since rev 5" block. **Rev 7 (same day) reverses
rev 6's answer to ask 7**: the name rule narrowed to `^[a-z][a-z0-9]*$` plus Fin's reserved words,
so ask 7 is now closed as implemented rather than answered — §3.12's addendum has the detail and the
one number that does not match. **Eight asks remain**, and every one of them is either blocked on
§3.2 or is real code. The reply itself is **still
untracked** — see §7.

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
profiles, health, both registration endpoints with the push-access gate, trust derivation, the
proof-of-work gate, and — new in cycle 2 — **the whole privileged surface**. 236 tests, `tsc` clean,
`eslint` clean, Worker bundles, and `docker/verify.sh` boots the built Worker on real `workerd` with
a real D1 and passes 9 HTTP probes.

**Live but untested**: `/api/stats`, `/api/dashboard/data`, `/api/me/settings` beyond its
mass-assignment guard, and the OAuth sign-in flow.

### 2.1 The authorization boundary was audited, and it held

Cycle 2 put 45 tests on `src/app/admin/actions.ts` and `POST /api/me/verification-request`, the two
places where the wrong caller would do the most damage. **No hole was found.** The brief required
any hole to be reported with a red test *before* being fixed, so that instruction simply never
triggered — worth stating plainly, because "we looked and found nothing" and "we did not look" are
indistinguishable in a report unless someone says which happened.

What is now pinned: `setPackageTrust` refused for no session, a default-role user, the package's own
owner, an expired session, a revoked session, an unminted token, and a live session whose account
row is gone. `approveVerification` / `refuseVerification` refused for all of those **and for a
moderator**, and for the applicant themselves. Two information-leak assertions: a non-admin gets the
identical message for a real and an invented request id, and is refused *before* the missing-reason
check. On-behalf-of is impossible four ways (`user_id`, `userId`, `login`, `id` in the body are all
ignored; the row is always `auth.id`). Duplicates are stopped sequentially and in a `Promise.all`
race. `users.role` is not reachable through `PATCH /api/me/settings`.

**An admin performing a moderator action is allowed, and that is now asserted rather than
incidental** — it is ADR-0003's deliberate overlap, so narrowing it later has to be a decision.

**Why this result is worth trusting: I mutated the code to check the tests would notice.** Changing
`refuseVerification` to accept a moderator as well as an admin turned exactly one test red — "refuses
a moderator ruling on identity" — with no collateral failures. One mutation, one precise failure. A
suite that catches a boundary change at exactly one assertion is a suite that was measuring the
boundary. `tests/setup.ts` also gained `role` on its seed input, because before cycle 2 nothing in
the harness could even *create* a privileged caller — which is the likeliest reason this surface went
untested for so long.

**"Live" does not mean deployed.** Nothing is deployed. `wrangler.jsonc:19` still carries
`"database_id": "REPLACE_WITH_D1_DATABASE_ID"`; no D1 database has been created, no migration has
been applied remotely, no Worker published. **There is no URL to point `finn` at.** Any plan that
assumes an integration test against a live host is planning against something that does not exist.

Branch: `feat/registry-implementation`. `master` is untouched.

---

## 3. The seams — every place the two projects must agree

This is the part to build work packages from. Each seam names what both sides do *today*, verified
against the code at the two commits in the header.

### 3.1 The registry URL is discovered, not configured — and we publish it

**Supersedes the previous version of this section, which told both sides to settle a
hostname in one cycle.** There is no hostname to settle. The registry has no stable URL and
is not expected to get one; the current URL is **published in this repository** and finn
fetches it. finn's `Sync.md` §3.1 carries the full design and the client-side rules — this
is what *we* owe.

| | |
|---|---|
| **finn will do** | tier 1 explicit override → tier 2 pointer file on GitHub raw → its own 24-hour cache of tier 2. **There is no tier 3:** `DEFAULT_REGISTRY` is `None` (`~/finn/src/discovery.rs:65`), decided after rev 6 proposed a compiled-in last-known-good. Package resolution: live API → fallback index in this repo → a source the user typed → `not_found`. |
| **we must do** | publish and maintain **two files on the default branch**: `registry/v1/url.txt` (the pointer) and `registry/v1/packages.json` (stdlib + first-party libs, `schema: 1`). Nothing else in this repo currently produces either. |
| **breaks how** | every one of those files is fetched at `https://raw.githubusercontent.com/M1778/finn-registry/HEAD/<path>`. **`HEAD` resolves to the default branch — and all of our work is on `feat/registry-implementation`.** Until it merges to `master`, both files 404, and with no tier 3 behind them finn has no address at all — which it reports as *no registry is known*, not as *package not found*. |
| **also on us** | the index **must be generated from D1 by a script and a CI job**, not hand-maintained. It duplicates package→repo data that already lives in the database; a hand-edited copy becomes a second, wrong source of truth within a month. Stdlib entries are the exception — the stdlib is not in the register, so those are authored. |
| **who decides** | the paths and the schema, and we should decide them *before* an agent hardcodes a string in each repo. This is the one literal that must match across two codebases. |

Two consequences worth carrying into every downstream decision:

- **It decouples our deploy from their release.** We can move hosts without a finn release,
  and finn `0.5.0` can ship before we have ever deployed. §3.1 stops being a blocker.
- **`registry/v1/url.txt` becomes a trust root for the whole ecosystem.** Push access to this
  repository now redirects package resolution for every finn user. Branch protection on the
  default branch is no longer a nicety. The first resolve of a new package has no lockfile
  entry to check the payload against, so the pointer is genuinely load-bearing.

**Confirmed by the owner: this repository is public, and all three projects are open source**
(`finn` and `Fin` are GPL-3.0). So raw needs no token and discovery works as designed. It also
means the trust root is **publicly auditable** — `git log registry/v1/url.txt` is a complete,
public record of every redirect ever issued, which a hostname compiled into a binary could never
provide. The remaining mitigation is procedural: **branch protection and signed commits on the
default branch**, because push access to this repo now redirects package resolution for every
finn user.

**Two paperwork gaps that contradicted the stated intent — both now closed.** ~~no LICENSE file,
no `license` field, `package.json` named `"app"`~~

**RESOLVED BY THE OWNER, 2026-08-24: the registry is AGPL-3.0.** `finn` and `Fin` stay GPL-3.0.
Done in the same change: `LICENSE` is the canonical AGPL-3.0 text from gnu.org (34523 bytes, 661
lines, sha256 `0d96a4ff…9abcb0`, verified free of CR bytes and markup); `package.json` gains
`"license": "AGPL-3.0-only"` and a `repository` field and is renamed `"app"` → `"finn-registry"`;
`package-lock.json` gets the same rename in its two `name` positions, hand-edited, no dependency
line touched and no install run. Nothing in `src/`, `tests/`, `scripts/` or `docker/` reads
`package.json`, so the rename has no runtime reach — checked, not assumed.

**AGPL-3.0 is not only a file, and this is the part worth carrying forward.** §13 obliges whoever
*runs* the register to offer its Corresponding Source to anyone interacting with it over a network.
That is a product requirement, not paperwork: `src/components/Footer.tsx` now carries a **Source**
link to the repository on every page, and the colophon names the licence so the link is legible as
that offer. A deployment that drops the footer link is out of compliance, so it is not a decoration
to be tidied away.

**Licence compatibility, since these are sibling repos that will copy code.** AGPL-3.0 §13 ¶2
explicitly permits combining AGPL-3.0 work with GPL-3.0 work, so lifting code from `finn` or `Fin`
into this repository is fine. The reverse is not symmetric: AGPL-3.0 code must not be pasted into
GPL-3.0-only `finn`. In practice the owner holds copyright on all three and can relicense their own
code freely, so this bites only for outside contributions — but the ecosystem is public and outside
contributions are the point, so the asymmetry should be written into CONTRIBUTING when it exists.
Concretely relevant today: the reserved-word list below travels **`Fin` → here**, which is the
permitted direction.

One finn-side inconsistency to fold in, **re-verified 2026-08-24 and still live** at
`install.rs:24` (it has drifted from `:18`): it builds its client with
`RegistryClient::new(None, ctx)` while `add.rs:58` and `sync.rs:23` both pass `registry_url`.

**My earlier description of the blast radius was wrong and is corrected here.** I wrote that
`finn install` "would ignore both a user override *and* the discovered URL". It does not ignore
the discovered URL: `$FINN_REGISTRY_URL` and the whole tier-2 pointer path live *inside*
`RegistryClient::new` (`registry.rs:90-91`), so they still apply when `custom_url` is `None`. What
is actually lost is exactly one thing — the `[registry].url` setting in `finn.toml`. So a project
that pins its register in its own manifest is honoured by `finn add` and `finn sync` and silently
ignored by `finn install`, which is a real inconsistency and a smaller one than I claimed.

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

**Narrowed 2026-08-25, by me, and it reduces to one question.** Those three options are not equally
available, because **the registry has no GitHub identity of its own.** Its only GitHub call today,
`checkPushAccess` (`src/app/api/[[...route]]/github.ts:114`), spends the *registrant's* OAuth token —
`Authorization: Bearer ${accessToken}`, taken from the session — which exists only while that person
is in a browser. Verified by reading the function, not inferred from its name. So:

- **Reading tags at resolve time has no credential at the moment it runs.** Unauthenticated GitHub
  REST is 60 requests per hour per source IP, and a Worker egresses from shared Cloudflare addresses,
  so that budget is not merely tight — it is shared with strangers and cannot be reasoned about. This
  option needs a registry-owned token held as a Worker secret. (Reasoned from GitHub's published
  limits and from how Workers egress; not measured from here, and worth measuring before it is built.)
- **A webhook or GitHub App on tag push** likewise requires the registry to hold an identity, and adds
  inbound signature verification.
- **A browser form per release** is the only one of the three that composes with the credential model
  that already exists: the publisher is present, their token is in hand, and `checkPushAccess` already
  proves they can push to the repository the tag came from.

So this is one question, not three: **does the registry acquire a GitHub identity of its own?**
Everything else follows. If yes, lazy-read-at-resolve behind a cache is the cheapest automated design
on a free tier, and §3.3's ruling gets heavier, because a `commit` the registry read is attested by
the registry rather than by the publisher — a different claim with a different blast radius. If no,
cutting a release is a browser action, finn stays a pure consumer, and the trust posture is the one
the project already has.

I am not deciding this. It changes what the registry is permitted to do in someone else's name, which
is yours.

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

### 3.11 The no-D1 verify check was wrong — the error message was always right

`docker/verify.sh`'s last phase boots the built Worker with the D1 binding removed and asserts the
5xx names the missing binding. It failed, and both `Sync.md` files recorded that as *"the 5xx did
not mention the missing binding"*. **That reading was wrong. The handler's message is correct and
does reach the log; the check had three defects, each of which produces exactly that symptom:**

1. **No readiness gate.** The probe looped until *any* connection succeeded and took the first
   status. wrangler answers the port before the user Worker runs, so a wrangler-level 5xx satisfied
   `status >= 500` — a pass produced by no handler at all, which therefore logged nothing.
2. **`>= 500` and nothing else** — which cannot distinguish a wrangler 5xx from the registry's own
   `internal_error` envelope, and that distinction is the entire point of the check.
3. **The log poll never re-requested.** Having missed its one chance to make a handler run, it
   spent 20 seconds re-reading a log that nothing would ever write to.

Rewritten as one Node block: gate on `/api/health` (the only databaseless route), assert `500`
**and** `error === "internal_error"`, then poll the log while **re-requesting each iteration**,
dumping the last body and the full log on failure. Smoke-tested against a live no-DB worker with a
freshly truncated log — passed in 1.9s, which is what proves the handler writes the line *on
request*. The readiness-failure path prints `FAIL worker never became ready (fetch failed)` and
exits 1. **Docker itself was not run**, and a fresh `npm run cf:build` was not run either (a dev
server holds port 3000 and §7 warns a production build breaks it), so this was tested against the
already-built `.open-next` bundle.

**The general lesson, which is worth more than the fix:** a check that asserts a symptom class
(`>= 500`) rather than the specific fact it cares about can pass for the wrong reason and fail for
the wrong reason. Both happened here, and for a day the blame sat on correct code.

---

### 3.12 A legal package name is not always a Fin identifier — the finding of the cycle

**This is the real answer to ask #7, and it is the first thing in either file that touches all
three projects.** Verified against `~/Fin` source and re-verified independently against the built
`finc`.

`NAME_RULE` admits `http-client`. Fin's lexer is `ALPHA [a-zA-Z_]` / `ID {ALPHA}({ALPHA}|{DIGIT})*`
(`~/Fin/src/lexer/lexer.l:63-64`) — **no hyphen**, and `-` lexes as `MINUS`. Running `finc`:
`http-client.greet()` yields `Undefined variable 'http'` **and** `Undefined variable 'client'`. The
lexer splits the name and the parser reads a subtraction.

There is **no aliasing escape hatch for a quoted path.** `~/Fin/src/parser/parser.y:717` has six
`import_statement` productions; `KW_AS` appears in exactly one, attached to `module_path` (bare
identifiers), never to `STRING_LITERAL`. Confirmed: `import "http-client" as hc;` →
`syntax error, unexpected KW_AS, expecting SEMICOLON`.

And roughly thirty Fin keywords — `type`, `class`, `if`, `in`, `as`, `do`, `fun`, `for`, `let`,
`try`, `pub` — all satisfy `NAME_RULE`.

**What survives:** `import { A, B } from "<name>";` works for every legal name, hyphenated and
keyword-colliding alike, because the path is a string literal and the bound names are the library's
own exported symbols.

**REVERSED BY THE OWNER, 2026-08-24. The name rule narrows.** ~~rev 6 §2.10 recorded that the
rule does not change~~ — that decision stands rejected, and the door §2.10 left open is the one
being walked through. Rev 6's reasoning was not wrong, it was just outvoted by the owner on a
question that was always theirs: the window closes at the first real registration, and there has
not been one.

**The new rule: `^[a-z][a-z0-9]*$`, length 2–64, plus a reserved-word denylist.** Enforced at
registration, server-side, as a refusal — not a warning and not a normalisation. A name is
permanent and first-come-first-served, so accepting `let` means nobody can ever write `import let;`
against it; refusing it costs the registrant one rename at registration time, which is the cheapest
moment there will ever be.

**The denylist is exactly Fin's 57 current reserved words, and I verified the number rather than
inheriting it.** *(Corrected: the count is **58**. Adjudicated on the planning side after the
implementing agent's derivation disagreed — the lexer's 60 explicit keyword rules less `Self` and
`as_ptr`, both already unregisterable under the narrowed rule. The extra word is `m1778`, and it is
kept. See the addendum at the end of this section.)* `~/Fin/src/lexer/lexer.l` has 59 quoted keyword literals; `Self` and `as_ptr` are
the two that no name matching the rule could spell anyway, leaving 57. `finn/src/finname.rs`'s
`FIN_KEYWORDS` is byte-for-byte that same 57-element set — I diffed them, it is exact, not
approximately right.

**Decision: no speculative reservations.** The tempting move is to also reserve words Fin does not
have yet but plausibly will (`await`, `match`, `switch`, `impl`, …). I considered it and rejected
it, because the premise is wrong. `import { A, B } from "<name>";` takes the name as a **string
literal**, which never lexes as a keyword, so a name that collides with a *future* keyword loses
its other import forms and keeps that one. A future collision therefore degrades a name; it does not
break it. Reserving 27 speculative words to prevent a degradation would steal good names
(`select`, `union`, `assert`, `some`, `none`, `with`, `go`) permanently, to buy something worth less
than they cost. If Fin later reserves a word, existing packages keep working via the `from "<name>"`
form, and that sentence belongs in the docs.

**State the guarantee honestly.** Narrowing does not fix a correctness bug — the string-literal
import form always worked. What it buys is that **every legal package name is now a usable Fin
identifier**, so all six `import_statement` forms work for every name on the register, and the
per-name "which import form do I get" reasoning in §3.12 disappears instead of having to be
documented. That is a usability guarantee, and overselling it as a safety fix would be wrong.

**Migration cost, measured not estimated.** Package names that become illegal: fixtures
`by-verified` (`tests/api/search.test.ts`, 5 assertions), `no-releases` and `with-releases`
(`tests/regressions/no-fabricated-version.test.ts`); the running example `left-pad` at 7 places in
`docs/REGISTRY-API.md`; and `name = "my-app"` in `src/app/docs/starting-a-project/page.mdx:47`.
`registrations.test.ts:455` currently asserts hyphens are *accepted* and has to invert. Both copies
of the rule move together — `router.ts:696` is the enforcement point and
`src/app/new/RegisterForm.tsx:29` is the client-side echo of it; a narrowing that lands in only one
of them is worse than not narrowing, because the form would accept what the API then refuses.

The three obligations therefore land on `finn`, and they are recorded on that side's §3.12: install
to a directory named **exactly** the registry name (no normalising `http-client` → `http_client`,
which would give one package two spellings); choose the import form per name; and warn at
`finn add` time rather than letting it surface as a compiler error the user cannot connect to the
package they installed. **Amended by the narrowing:** the first and third stand; the second is
retired for *registry* names, because after the narrowing there is only one import form to choose.
It stays live for GitHub shorthand and Git URLs, where the name is GitHub's and keeps its hyphen —
so `finname.rs` is still load-bearing and must not be deleted.

**One claim to treat as unconfirmed.** A plain `import "http-client";` is reported to **compile
green** while binding a namespace to the unspellable symbol `http-client` — via the no-targets
branch of `visit(ImportModule&)` in `~/Fin/src/semantics/impl/Analyzer_Decl.cpp`, which binds
`path.stem()`. On re-verification module resolution failed before reaching that branch
(`module not found: http-client`, and an unhyphenated control name failed identically), so what was
observed was the load path, not the binding. If it is right it is the worst of the three, because
nothing reports it. **Worth ten minutes from whoever next touches `~/Fin`; do not build on it
either way.**

#### Addendum, cycle 3: implemented, and one number does not match

The narrowing is live on this side. `src/lib/package-name.ts` is the single home of the rule —
`NAME_RULE`, `NAME_MIN`, `NAME_MAX`, `FIN_RESERVED_WORDS`, `validatePackageName` — imported by both
enforcement sites (`router.ts` and `src/app/new/RegisterForm.tsx`), so the form and the API can no
longer disagree. `docs/REGISTRY-CONTRACT.md` is at **rev 7** with §2.10 rewritten,
`docs/REGISTRY-API.md` §7.2 restated, ADR-0002 given a superseding note, and the two docs pages
rewritten. The migration list above is closed: fixtures renamed to `attested`, `released`,
`unreleased`, `unregistered`; `left-pad` replaced by `http` throughout `REGISTRY-API.md`;
`my-app` → `myapp` in `starting-a-project`. `registrations.test.ts` now asserts the inverse plus the
denylist, the length bounds and the whole set.

**The count is 58, not 57, and the extra word is `m1778`.** Derived mechanically rather than
transcribed: the quoted rule literals in `~/Fin/src/lexer/lexer.l`, filtered to `^[a-z][a-z0-9]*$`
with length ≥ 2, are exactly 58. Seven literals in that region are excluded because no legal name
could spell them — `Self`, `as_ptr`, `#for`, `#index`, and the operators `->`, `::`, `=>` — which is
where "59 − 2 = 57" loses two of them. `finn`'s `FIN_KEYWORDS` is 57: diffed both ways, the only
difference is `m1778`, in either direction.

`m1778` is a keyword in Fin today, not an artefact: `lexer.l:209` emits `KW_M1778`, `parser.y` has
the `%token` and a production for it, and it reaches `tokens.hpp`, `ASTNode.hpp` and
`CodeGen_LLVM.cpp` — it is Fin's "not implemented" marker, written `blame m1778;`. **Raised as a
disagreement rather than resolved inside the cycle, and then adjudicated on the planning side: the
register keeps it.** The lexer is authoritative, `FIN_KEYWORDS` is a strict subset of it, and the
asymmetry is what decides the tie — a word missing from `FIN_KEYWORDS` is a warning nobody printed,
whereas the same word missing here lets somebody claim a keyword. `m1778` is also the project
owner's own handle, which makes it likelier to be tried than most entries on the list.

**Third list, and it is a trap: `Fin/src/diagnostics/DiagnosticEngine.cpp`.** It looks like the tidy
keyword list the lexer refuses to be, and it is diagnostics-only — highlighting and did-you-mean
suggestions. It over- and under-states, naming eight words the lexer does not reserve: `bez`,
`beton`, `elseif`, `self`, `short`, `uint`, `ulong`, `ushort`. None of them is on the denylist and
none should be; verified against the lexer, which has no rule for any of them. Reserving one would
cost a registrant a legal name, and nothing would fail to reveal it. `src/lib/package-name.ts` says
so in a comment, because that file is where the next person will look.

**`finn`'s missing `m1778` is a real gap on that side, recorded as a ticket.** `src/finname.rs` is
frozen this cycle and nobody is to edit it; the omission is harmless while the list only warns, and
becomes load-bearing the day `finn` starts refusing names locally.

**Also found on the finn side, not fixed (that repo is read-only from here).** The doc comment at
`finn/src/finname.rs:1-24` still states the registry rule as `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` and
calls `http-client` "the register's own worked example". Both are now false. The code below it stays
correct and stays needed. Separately: `finn` does not validate `[project].name` at all — `init.rs`
takes `--name` or the directory name verbatim — so a local project may still be called `my-app`;
only a *registered* name is constrained. The docs on this side say so explicitly.

### 3.13 The auth path — four defects confirmed by the planner, cycle 4 brief

All four read off the source directly, not reported by an agent. Assigned as cycle 4; recorded here
because a confirmed defect is worth more to a planner than a fix that has not landed.

**1. The origin is derived from a request header and feeds the OAuth `redirect_uri`.**
`getOrigin` (`router.ts:249`) prefers `APP_URL`/`NEXT_PUBLIC_APP_URL` and otherwise builds an origin
from `x-forwarded-host` or `host`. That value becomes `redirectUri` at `:1104` and `:1172` and is
sent to GitHub in both the authorize URL and the token exchange. `APP_URL` is documented in
`.dev.vars.example` as required and is **set nowhere in `wrangler.jsonc`, the workflows, or
`docker/`** — verified by grep — so the header path is the one a real deploy runs, and Cloudflare
neither sets nor strips `x-forwarded-host`.

*State the severity accurately.* GitHub matches `redirect_uri` against the OAuth app's registered
callback host, so a poisoned origin does not deliver an auth code to an attacker — the exchange is
refused. This is latent and defence-in-depth. It is worth fixing on the `url.txt` principle: not
knowing the origin and guessing it are different, and a guess turns "this deployment never set
`APP_URL`" into GitHub's opaque `redirect_uri_mismatch`, which reads as a misconfigured OAuth app.

Ruling: configuration is the only source, the header reading is deleted, absent the variable the
route refuses and names it. **Two of the three call sites need no origin at all** — `authError`'s
links can be `/` and `/api/auth/github`, and `:1257` can be `c.redirect(returnTo)` because
`safeReturnPath` already guarantees a site-relative path. A relative URL cannot be poisoned, so
deleting the dependency beats hardening it.

**2. Three Orchids/Daytona scaffold survivors, all in the auth path.** `:260-262` rewrites
`.proxy.daytona.works` to `.orchids.page`. `:1247` sets the session cookie's `domain` **only** when
the host contains `orchids.page`; every other host already gets `undefined`, so removing the
condition makes host-only cookies unconditional — the tighter scope and the right default.

**3. `authError` interpolates into HTML unescaped** (`:961-984`, four values). Seven of its eight
call sites pass in-repo constants; `:1182` passes GitHub's `error_description`. The reason to fix it
is not the current call sites but the next one somebody adds. The same page loads
`https://cdn.tailwindcss.com` — an error page that needs the network to render, reachable during a
failed sign-in.

**4. `@tailwindcss/typography` is declared (`package.json:60`) and never registered.** Tailwind v4
needs `@plugin "@tailwindcss/typography";` and `globals.css` has only `@import "tailwindcss"`, so
the nineteen `prose-*` classes at `PackageTabs.tsx:116-124` are inert and a rendered README is
unstyled. Either outcome — register it, or drop it and write the rules by hand — is acceptable;
nineteen inert classes are not. Removing the dependency needs a lockfile change, which agents may
not make.

---

#### Cycle 4 outcome, verified by the planner 2026-08-24

All four landed. Gates re-run by me, unpiped: `tsc --noEmit` exit 0 / 0 lines, `eslint src tests
--max-warnings=0` exit 0 / 0 lines, `vitest run` exit 0 with **265 across 14 files**, summed from
the per-file lines myself (58+31+28+28+20+20+17+17+12+9+8+7+6+4), `npm run build` exit 0, 22/22
routes. Baseline was 257 across 13; the new `tests/regressions/no-origin-from-headers.test.ts`
carries the 8.

`getOrigin` is gone — zero references in `src/`. `configuredOrigin()` reads the two variables and
returns `null` otherwise; the three header reads are deleted from the auth path. The two call sites
that only needed a link are now site-relative (`c.redirect(returnTo)`, and `authError`'s buttons).
`escapeHtml` covers the five entities and wraps `title`, `message`, `details`. The `cdn.tailwindcss.com`
stylesheet is inlined; the hostname survives only in the comment explaining its removal. The
`daytona`/`orchids` sweep returns hits in this file alone. `@tailwindcss/typography` was dropped in
favour of a `.readme` block in `@layer components`.

**Four mutants of my own, all bit, all restored byte-identical (`md5sum -c` OK four times):**
deriving the origin from `x-forwarded-host` again → 2 failed; accepting the `REPLACE_WITH`
placeholder → 1 failed; neutering `escapeHtml` → 1 failed; making the post-sign-in redirect
absolute → 1 failed.

**My first attempt at the header mutant was worthless and I nearly counted it.** It read a
`globalThis` hook nothing sets, so the "restored" fallback still returned `null`, the behaviour never
came back, and 8/8 passed. A mutant that does not change behaviour is not evidence about a test —
it is evidence about the mutant. The real one, threading `c` into the signature and both call
sites, failed 2.

**Two premises in the brief above were wrong**, and the agent said so rather than working around
them. `authError` had **seven** call sites, not eight — the eighth grep line was the definition, and
I labelled a seven-item list "eight". And **two** callers of `configuredOrigin` remain, not one: the
authorize URL and the token exchange are separate uses, both of which send the value to GitHub and
so genuinely need an absolute origin. The shape of the ruling is unaffected; the count in it was
not researched.

**`master` has not moved.** The agent closed by reporting HEAD 15 commits ahead as though the branch
had advanced under it. `origin/master` is still `a5ef515`; HEAD is `b496ff2` on
`feat/registry-implementation`, and those 15 commits are this session's own. The claim that matters
held — none of them are the agent's, `git stash list` is empty, and no PR exists.

**The deviation I was offered, and accept.** The brief said to set `APP_URL` in `wrangler.jsonc`
vars. The agent set it to `https://REPLACE_WITH_DEPLOYMENT_ORIGIN`, matching the `database_id`
idiom, and taught `configuredOrigin` to refuse that pattern. This is right and I would have got it
wrong: a plausible-looking `http://localhost:3000` would satisfy every check and build a
`redirect_uri` pointing at the deployer's laptop — the exact failure item 1 exists to prevent. It is
the `url.txt` principle applied to a file I did not think to apply it to.

**Item 4 is unverified by the suite and no test was added.** The evidence is compiled CSS byte
counts (153,958 unregistered / 176,048 registered / 156,427 with `.readme`), Tailwind v4 layer
order, and computed contrast: `prose-invert` carries no theme condition, so on the paper theme it
puts body text at **1.25:1** and headings at **1.18:1** against 14.44:1 for `--ink`. That is a WCAG
failure rather than a preference, which is why registering the plugin was rejected instead of
chosen. No browser was available; this is measurement, not a screenshot.

**A regression the agent introduced, and what caught it.** Putting the origin check at the top of
`/auth/github` turned the proof-of-work interstitial — a documented 200 with nothing to do with the
origin — into a 400. **Its targeted run passed 8/8; the full suite failed 6**, all in
`captcha.test.ts`. A residual failure then exposed that one captcha test had been getting its origin
from the deleted header fallback; `tests/setup.ts` now sets `APP_URL` so the harness models a
configured deployment. Second time in this cycle-set that only the full suite caught what a targeted
run called green.

**`@tailwindcss/typography` is now an unused dependency.** `package.json:60`, referenced in `src/`
only by the comments explaining the rejection. Agents may not run install commands, so the removal
and the lockfile change are the owner's.

---

### 3.14 The sign-in interstitial posts the OAuth state to any parent frame

Found by the cycle-4 agent, **reported and deliberately not fixed** under the standing rule that a
finding is reported before it is repaired. Confirmed by me at `router.ts:1235`:

```js
window.parent.postMessage({ type: "OPEN_EXTERNAL_URL", data: { url } }, "*");
```

`url` is the GitHub authorize URL and it carries the OAuth `state` — the login-CSRF token. The
target origin is `"*"`, so any parent frame receives it. Reading it in context sharpens the
finding beyond the report: the call is guarded by `if (window.self !== window.top)`, so it fires
**only** when the page is framed and never otherwise. The guard is not a mitigation; it is the
trigger condition.

There are **no frame protections anywhere in the repository** — verified: no `X-Frame-Options`, no
CSP `frame-ancestors`, no `src/middleware.ts`, no `headers()` in `next.config.ts`.

This is the fourth scaffold survivor, and the three already deleted are why it is here: the block
exists so a preview tool could open OAuth in a top-level window. Nothing in this product is framed
on purpose.

Ruling for cycle 5: delete the branch and always assign `window.location.href`, then add frame
protections repository-wide so the guard's premise cannot recur. Both halves, because deleting the
leak without denying framing leaves the next such block one paste away.

#### Cycle 5 outcome, verified by the planner 2026-08-24

Fixed and verified. The `postMessage`/`OPEN_EXTERNAL_URL`/`window.self !== window.top` branch is
gone from `router.ts`; the interstitial now assigns `window.location.href` directly. Framing is
denied in **two independent layers**, because the router serves the API and interstitials while
Next serves the page routes and neither covers the other:

- `router.ts:142-143` — Hono middleware sets `X-Frame-Options: DENY` and
  `Content-Security-Policy: frame-ancestors 'none'` on every response it emits.
- `next.config.ts:74-80` — a `headers()` rule at `source: "/(.*)"` sets the same pair on every
  page route. It compiles into `routes-manifest.json`; the built Worker reads it there.

**What I verified, and how — not from the source, from the shipped artifact.** The claim that
matters is that these headers survive the build, because a header that only appears under
`next dev` is worse than none: it reads as covered. So the pass was run on the OpenNext Worker
under `wrangler dev --local` (workerd), the runtime we deploy to, not on the dev server.

- Both headers present on `/`, `/explore`, `/new`, `/docs`, `/docs/trust`, a publisher page and a
  package page — **including the 500s** an un-migrated D1 produces, so an error page cannot be
  framed either. Both present on `/api/health`, `/api/auth/github`, `/api/packages/*`.
- The compiled interstitial carries **zero** `postMessage`, `OPEN_EXTERNAL_URL`, `window.top` or
  `window.self`. I reached the real sign-in interstitial (not the proof-of-work bootstrap that
  precedes it, and not the config-error page) by solving the SHA-256 PoW challenge in Python and
  following the `?cr=1&captcha=` redirect — a page-count check on the wrong page would have proved
  nothing.
- Two mutants confirm the tests bite, not just pass. Restoring the `postMessage` branch →
  `no-state-to-parent-frame.test.ts` fails 3 of 9 (the leak, the frame-branch, the
  cookie-value-reuse assertions). Removing the router's `app.use` frame guard → the same suite
  fails 5 of 9 (all four routes plus the single-directive CSP check). Working tree restored and
  `md5sum -c` clean after each.

**One instrument error worth keeping, the fourth of this shape from me this stretch.** My first
mutant script asserted a two-line `const url = …` form that the fixed code no longer contains; it
exited without mutating, vitest ran on unmutated source and passed 9/9, and I nearly filed that
9/9 as a result. It is not one — *before a negative result means anything, prove the instrument
reaches the thing being measured.* The re-aimed mutant, anchored on the real one-line
`window.location.href = "${authorizeUrl}";`, failed exactly as predicted.


### 3.15 A local `.env.local` bakes a wrong origin into the build, silently — found while verifying cycle 5

Not a code defect and not on the branch. A build-hygiene trap I walked into while probing cycle 5,
recorded because the next person to run `cf:build` on a working box will hit it and misread the
result — exactly as I did for three tool calls.

**What happens.** `configuredOrigin()` reads `process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL`.
The `NEXT_PUBLIC_` half is a Next.js build-time inline, not a runtime read. This box carries a
gitignored `.env.local` (a scaffold leftover, dated Aug 23) with
`NEXT_PUBLIC_APP_URL=http://130.185.120.193:3000`. So the compiled function froze to:

```js
function bb(){let a="http://130.185.120.193:3000";return!a||/REPLACE[_-]WITH/i.test(a)?null:a.replace(/\/$/,"")}
```

The minifier then saw a truthy constant on the left of `||` and **dead-code-eliminated the
`process.env.APP_URL` fallback entirely** — zero runtime `APP_URL` lookups survive. The interstitial
built a `redirect_uri` pointing at that VPS IP, which is neither the `wrangler.jsonc` placeholder nor
the request host. On a real deploy this box's build would ship an origin nobody set, and the
placeholder guard that is supposed to force `ORIGIN_UNCONFIGURED` never runs because there is no
placeholder left to test.

**Why it is not cycle 4 regressing.** I proved the mechanism rather than reasoning it: moved
`.env.local` aside, rebuilt clean, and the same function compiled to
`process.env.NEXT_PUBLIC_APP_URL||process.env.APP_URL` with the IP gone and three runtime `APP_URL`
occurrences restored. On the clean Worker the cycle-4 refusal fires end-to-end on workerd for the
first time in my checking: PoW interstitial stays 200, then a **400** whose body is the exact
`ORIGIN_UNCONFIGURED` text — naming `APP_URL`, "port included", with `&#39;` proving `escapeHtml`
ran — and both frame headers on the error page. `.env.local` restored afterward, byte-identical.

**So CI is fine and this box is not.** The GitHub build has no `.env.local`, so it inlines the
runtime lookups and the placeholder guard works. The exposure is only a human running `cf:build`
locally and deploying that artifact. Worth a one-line defence for the owner to weigh: have
`cf:build` refuse when `NEXT_PUBLIC_APP_URL` resolves to anything but the placeholder, or drop
`.env.local` from any box that produces deploy artifacts. Recorded, not fixed — it is the owner's
call and touches no branch code.

### 3.16 None of the last four cycles is in a commit, and `url.txt` said the wrong thing about why

Found and fixed by me, 2026-08-25, while re-reading my own correction. Two findings, and the
second is much larger than the one I went looking for.

**The small one: `registry/v1/url.txt` carried a false claim about itself.** Its activation
section said:

> Nothing else moves: **this file is already on the default branch**, so there is no second merge,
> no CI change and no finn release involved.

It is not, and the correction took three passes, each one wrong in a smaller way than the last.
That sequence is the finding, so it is recorded rather than tidied:

1. *"Already on the default branch."* False. `git ls-remote --heads origin` returns one ref,
   `refs/heads/master`, still at `a5ef515` — the commit before the implementation. HEAD is
   `feat/registry-implementation` at `b496ff2`, 15 commits ahead, never pushed.
2. *"It exists only on the unpushed branch."* Also false, and **wrong in the direction that looks
   right**: it implies pushing would publish the pointer. `git ls-tree -r
   feat/registry-implementation` matches nothing under `registry/`. The push would have succeeded,
   the merge would have succeeded, and the file still would not be there.
3. *"A finn reading the 404 gets no honest message."* False, and I caught it by running the real
   binary rather than reasoning about it. finn prints "No registry address is known", names the
   pointer it tried, names `$FINN_REGISTRY_URL` and `finn.toml`'s `[registry]`, and does **not**
   claim the package is absent. Its behaviour is already correct.

All three are now stated correctly in the file, with the superseded claims quoted in place rather
than swapped out, and the invariant holds: still **no content line**, so nothing reached URL
position. `tests/regressions/no-guessed-registry-url.test.ts` green — 6 tests — after each pass.

**The large one: `registry/` is untracked, and so is most of cycles 3 through 6.** Not ignored —
`git check-ignore` excludes nothing, `git add -An` would take both files cleanly. Simply never
added. Once I looked past `registry/`, the inventory is **42 files of uncommitted work**: 28 tracked
files modified, and **14 untracked**, including —

- `LICENSE` — the AGPL-3.0 file the owner explicitly ruled on. Not in the repository.
- `src/lib/package-name.ts` — the narrowed name rule, the other explicit owner ruling.
- `scripts/build-fallback-index.mjs` and its two siblings, plus
  `.github/workflows/fallback-index.yml` and `docker/check-frozen-origin.mjs`.
- `registry/v1/url.txt` and `registry/v1/packages.json`.
- **Five test files, three of them the regression suites for cycles 4, 5 and 6**:
  `no-origin-from-headers`, `no-state-to-parent-frame`, `no-guessed-registry-url`.

**The consequence that matters most.** A fresh clone of this branch is *self-consistent* — I
checked, and no committed file imports the untracked module, so nothing dangles and nothing fails
to build. It is simply the codebase from before cycle 3. Concretely: **10 committed test suites
against 15 on disk.** Every guard I mutation-tested over the last three cycles — the frame-ancestors
headers, the `postMessage` state leak, the header-derived origin, the placeholder URL — is verified
against a test file that exists on one machine and in no commit. A regression could land on the
default branch and nothing would catch it, because the test that catches it is not in the
repository. "The guard is green" has been a local fact this whole time, and I have been reporting it
as a property of the project.

This is mine, not an agent's. I set the cycles, I checked the gates, and I never once checked
whether the work was committed — for four cycles, while writing rules about proving the instrument
reaches the thing being measured.

**The owner's call, and now clearly the highest-value one:** committing and pushing. Not one step
but two, in order, and the second without the first publishes nothing. Until then there is no
registry, no degraded tier-3 path behind it, no CI coverage of three security findings, and no copy
of any of it anywhere but this box.

**One finn-side wart, cosmetic, for a later cycle.** The failure prints the pointer URL twice —
once as the file it reads, then again inside the quoted reason (`"<url> answered 404 Not Found"`),
because the reason string embeds the URL the line above already named.

#### Rule audit, same pass

Two files I had told agents not to touch turned out to be modified. Both check out, and I would
rather record that than let the rule quietly rot:

- **`vitest.config.ts`** — adds `testTimeout: 30_000`, with a comment explaining that the
  `verify-request` and `register` suites solve real 15-bit proof-of-work and that the difficulty is
  a production security parameter which must not be weakened for tests. The rule exists so a red
  suite cannot be made green by editing the harness; a timeout bump cannot turn a failing assertion
  green — only a timeout into a completed run. **Accepted on the merits.**
- **`package.json` / `package-lock.json`** — `name` fixed from `app` to `finn-registry`,
  `license: AGPL-3.0-only` added, repository URL added, one script added. The lock diff is two
  lines, both the mirrored name. **1314 packages on each side**, so no install ran and the
  no-`npm install` rule held.

#### Cycle 6 outcome, verified by the planner 2026-08-25

**Ticket 1 landed.** `configuredOrigin()` reads `process.env.APP_URL` and nothing else
(`router.ts:336`). What I checked myself rather than taking on report:

- `src/app/layout.tsx` is **clean** in `git diff` — the legitimate build-time `metadataBase` read
  was not collateral.
- The only surviving `NEXT_PUBLIC_APP_URL` mentions in `src/` are that one real use and three
  comments explaining why the router must not join it.
- `docker/check-frozen-origin.mjs` is wired into `verify.sh` at line 36, immediately after
  `npm run cf:build`. It reports **ok** against the current artifact and **exits 1** with
  "no build artifact" when run from a directory without one — so the failure arm has executed,
  which is the arm that matters.
- **275 tests across 15 files**, and the fifteen per-file counts in the report sum to exactly 275
  and match what the run printed. The suite now contains a test named "does not accept
  `NEXT_PUBLIC_APP_URL` as the origin, because it is a build-time inline".
- `grep APP_URL .github/workflows/deploy.yml` returns nothing, which is what makes §3.17 below real.

**Both of the agent's pushbacks are correct, and both are corrections to my brief.**

1. *"No `130.185.120.193` anywhere in the bundle" was not achievable as specified.* The IP survives
   in 21 files, every occurrence downstream of `metadataBase` in `layout.tsx` — the file the same
   ticket forbade touching. I wrote a demand that contradicted its own constraint. Narrowed to the
   API route bundle, where it holds.

2. *Calling the old `wrangler.jsonc` prose "false" was too strong — it was conditionally true, which
   is worse.* This is corroborated by my own cycle-5 evidence, which I had already seen and not
   drawn the conclusion from: my clean rebuild with `.env.local` moved aside produced
   `let a=process.env.NEXT_PUBLIC_APP_URL||process.env.APP_URL` — a live runtime read. So when the
   var is unset at build time the documented mechanism worked, and since `deploy.yml` sets neither
   var, CI-built artifacts kept the runtime read and the prose was accurate *for them*. The real
   defect is that whether the documented behaviour held depended on an invisible property of the
   build machine. That is worse than a false sentence, because no amount of reading the sentence
   finds it. Production deploys were probably never frozen; the box I was testing on was.

**One catch the other way.** The report grouped four stale present-tense claims as all sitting in
"dated review sections where rewriting would destroy the record", and asked me to leave them. Three
do. The fourth, `REGISTRY-CONTRACT.md:324`, sits under **§2.5 — a live normative section**, and it
claimed "Today `install.rs:15` hard-fails on anything with `is_official: false`". I checked finn:
`is_official` appears in `finn/src/` only inside comments recording its own removal. That is not a
preserved record, it is a false statement in the part of the document that tells the reader what is
true now. Rewritten to say the policy is implemented, with the old reasoning kept because it is
still why the table is shaped that way. Header bumped to **rev 8 / 2026-08-25** — a factual
correction is exactly what a revision marker is for. The other three stay as they are.

#### Cycle 7 outcome, verified by the planner 2026-08-25

Three tickets, all in `scripts/` and `.github/`, all landed. Verified here rather than on report:

- **The generator picks its database again.** `node scripts/build-fallback-index.mjs` with no
  arguments now resolves the single real D1 instead of refusing; `metadata.sqlite` was fact-checked
  before being excluded — it holds one table, `_cf_ALARM`, which is Durable Object alarm
  bookkeeping. I re-ran the mutant myself: copy a second real `.sqlite` in beside it and the
  refusal returns with the identical message and exit 1. Not weakened into a silent pick. The
  exclusion is a denylist rather than a shape match on D1's 64-hex filenames, so a renamed
  bookkeeping file lands back on the loud refusal instead of falling through to `local.db` and
  reading the wrong database.
- **The likeliest failure is three lines instead of thirty-one.** An unmigrated database now says
  the `packages` table is missing, names the file, and names `npm run db:apply:local`. Verified by
  running it. The agent widened the catch past my ticket to `packages`/`users`/`versions`, because
  the first statement joins two of them and a missing `users` would have re-thrown a stack while
  `packages` got the clean line — correct, and the mutant proves the widening did not become a
  swallow: rename the queried table to `packagez` and the full `LibsqlError` stack comes back with
  zero mentions of `db:apply:local`.
- **§3.17's build-time half is wired**, with a preflight that fails the deploy when `vars.APP_URL`
  is unset or matches `REPLACE[_-]WITH`, case- and separator-insensitively. `NEXT_PUBLIC_APP_URL`
  is deliberately not passed, with the reason recorded in the workflow: it would also satisfy
  `metadataBase`, and its inlining is what froze the OAuth origin in the first place.

**A judgment call better than my brief.** I said to wire `APP_URL` into "the `cf:build` step". There
are two, and the agent wired only the Deploy job's — leaving the Verify job's build without it,
because that artifact is thrown away and wiring it there would fail **every pull request** whenever
the variable is unset, gating contributions on a repository setting rather than on the code. That is
the right answer and it is not the one I asked for.

**275 across 15 files, unchanged, and that is the correct expectation rather than a stale number:**
nothing under `tests/` references `scripts/`, so this cycle's work cannot move the count. I checked
that rather than accepting the identical figure twice.

**The gap the agent stated plainly, and it is the real one.** No automated test touches any of this
cycle's work. The generator executes at import — top-level `await` plus main-line code — so it
cannot be unit-imported, and covering it needs a subprocess harness with a temporary migrated
database, a pattern `tests/` does not have. The agent declined to introduce it unbidden and said so
instead of quietly shipping hand-verification as coverage. That is the right call twice over, and
the harness is now cycle 8: this is the script that writes the file `finn` falls back to when the
API is unreachable, so its failure mode is *confidently wrong data about where a package's code
lives*, delivered at the moment the client has nothing to check it against.

#### Cycle 8 outcome, verified by the planner 2026-08-25

One ticket, one new file: `tests/scripts/build-fallback-index.test.ts`, 973 lines, 36 cases. No
other file in the repository changed — `git status` plus mtimes across `src/ scripts/ docs/
.github/ registry/` agree, and the generator's md5 is the same `51c75cad…` it carried before the
cycle. **311 tests across 16 files**, which is my own run rather than a figure taken on report, and
275 + 36 sums.

The design is the part worth keeping. The generator is a program, not a module: no exports, work at
import time under a top-level `await`, results via `process.exit` and stdout. So it is spawned — and
spawned from a **mirrored repository root**, a temp directory holding copies of the five files it
reads. The script derives `repoRoot` from `fileURLToPath(import.meta.url)`, so a copy relocates
every repository-relative path it computes. That one fact makes `registry/v1/packages.json`
*unreachable* rather than merely unvisited: the script's own default output path lands in the temp
tree, and one case deliberately passes no `--out` at all to prove it. A guard that depends on every
future test remembering a flag is a guard that one forgotten flag removes. It also makes the
local-D1 scan testable without going near the real `.wrangler` state that `wrangler` and `next dev`
share, and it is what lets a mutation case edit the *copy*.

What I checked myself rather than took on report:

- **No back door in the generator.** The real risk in "make a program testable" is that the program
  grows a hook. It has exactly two env reads, `FALLBACK_INDEX_DB` and `DATABASE_URL`, both
  predating this cycle, and no `NODE_ENV`/`VITEST`/mock branch anywhere. The harness *deletes* both
  from the child environment, so the D1-scan cases genuinely reach the scan instead of being
  short-circuited by the suite-wide `DATABASE_URL` — the "prove the instrument reaches the thing
  being measured" rule, applied by the agent to its own fixture.
- **The shared fixture is actually isolated.** `fixtureDb()` is `tests/setup.ts`'s database, shared
  by every suite; `resetDatabase` is registered there as a `beforeEach`, so it is truncated before
  each case. Accumulation across cases would have made "entries 1" order-dependent.
- **The committed index survived three of my runs, two of them red.** md5 `d1bb196f…` and mtime
  2026-08-24 11:55:40 unchanged, and zero `/tmp/finn-registry-generator-*` left behind — a failing
  run is exactly when cleanup gets skipped, so that is the arm worth proving.
- Typecheck 0, lint 0 (and `lint` covers `tests`, so the new file is linted rather than exempt),
  clean `cf:build` 0, `check-frozen-origin` 0.

Three mutants of my own, on the real generator, restored after each:

| mine | result |
|---|---|
| `registry_url` hardcoded `null` | 2 red — the two synthesised-pointer cases. "Agrees with the committed pointer" stayed **green** |
| first-party owner check dropped | 2 red, incl. the authored-entry one |
| JS `entries.sort` removed, SQL `order by` kept | **0 red** |

The first confirms a vacuity the agent disclosed itself, against its own interest: the
pointer-agreement case is green under that mutant because the committed pointer names no URL, so it
asserts `null === null` today. It is still the right case to have — it reads the pointer instead of
hardcoding, so it starts asserting a real URL the day one is appended, with no edit — but it is not
what catches a regression now. The two synthesised-pointer cases are. An agent that names its own
dead case is worth more than one that reports 36 green.

The third confirms the agent's own reading: neither sort is detectable alone, because the SQL
`order by p.name` already delivers sorted rows. That is a property of the script, not a gap.

I also got the second mutant wrong the first time and have to record it. My `sed` anchor silently
failed to match, the suite came back 36 green, and for a moment I had "the boundary is uncovered" —
from a mutation that never applied. **This is the exact failure the agent's own harness guards
against**: `makeRoot` throws when `mutate` changes nothing, saying the case "would have tested the
unmutated script and passed for the wrong reason". I had that guard in front of me and still ran my
own mutants without one. Re-run with an asserted anchor, the boundary is covered. The rule:
*a mutation that changed nothing is not a passing test, it is an unrun one* — and it applies to the
planner's hand-run mutants, not just to the suite's.

**One real gap, found by me, that the agent's ten mutants did not surface.** The JS sort is
redundant against register rows but *not* against authored stdlib entries, which are merged in
after the query — interleaving them is its only non-redundant job, and there is a case for exactly
that ("marks an authored entry stdlib and sorts it in with the rest"). It passed under my third
mutant. The reason is the fixture: it seeds `http` from the register and injects `io` as stdlib, and
`http` < `io`, so append order already equals sorted order. I proved this rather than reasoned it —
renamed the injected entry to `bytes`, which sorts *before* the register entry, and with the JS sort
removed the case fails on order, `[ 'http', 'bytes' ]` against `[ 'bytes', 'http' ]`. Then restored
both files byte-exact. The gap is one word wide in the fixture, and the transferable rule is
sharper than the fix: **a fixture whose values happen to be in the order under test cannot detect
order.** Pick a value that sorts against the grain, or the assertion is decoration. Cycle 9.

Untracked, and joining §3.16's pile: `tests/scripts/` is itself in no commit. The suite that pins
the file `finn` falls back to exists on one machine.

#### Cycle 9 outcome, verified by the planner 2026-08-25

Three test files changed and **no source file** — which git can prove rather than assert. The
modified list is exactly the cycle-8 list plus `tests/api/versions.test.ts`, `src/lib/registry/
queries.ts` is *absent* from it (byte-identical to `HEAD`, so one of the four source mutations is
provably restored), and `router.ts` and `semver.ts` come back to the md5s I took before my own
mutants. **311 across 16 files**, unchanged and correct — no case was added or removed, only made
capable of failing.

Four order assertions could not fail before this cycle. I verified two of them the whole way round
rather than in one direction:

- `versions.test.ts:130`, the yanked-version listing. With the descending comparator replaced by
  `return 0` — a comparator that orders nothing — the case now goes red along with the three
  neighbours that always could. Then I put the *old* fixture order back under the same mutant and it
  passed. So the fix was necessary, not decorative: the old fixture seeded `1.0.0` first, insertion
  order already equalled the asserted order, and the one case covering the *yanked* path was blind.
- `search.test.ts`, `sort=name` rewritten to order by `created_at`. Three cases go red — "pages with
  offset", "sorts by name, ascending", "treats `trust=recognized` as no filter at all" — matching
  the agent's table exactly, where the first and third were green before.

`:180` had **two** accidents stacked, and the second is the better catch: three rows seeded
alphabetically at `limit=1&offset=1` return the *median*, which is invariant under reversal. Even
un-sorting it could not move the answer. Fixed by seeding `charlie, alpha, bravo` and taking a
two-wide window off the end. `seedTrustLadder()` now registers `plain, moderated, attested` —
deliberately the reverse of the asserted name order — and that is load-bearing because
`tests/setup.ts:558` defaults every row's `created_at` to one constant, so an unordered query comes
back in insertion order. I confirmed that default myself; it is the mechanism behind the whole class.

**Correction, made in cycle 10, to my own rule.** "Register in the reverse of the asserted order" is
*half* right and I recorded it without the qualification it needs. It holds when the primary sort is
ascending, or when the sorted column carries no index. It is exactly backwards when the primary sort
is `desc` over an **indexed** column — which is every `sort=recent`, `sort=updated` and `/api/stats`
assertion, because `packages` carries `packages_created_at_idx` and `packages_updated_at_idx`. Agent
B measured this against my instruction; I reproduced it, and the query plan is the mechanism:

```
no index on created_at:  SCAN t | USE TEMP B-TREE FOR ORDER BY  -> ties keep insertion order, both directions
index on created_at:     SCAN t USING INDEX t_created_at_idx    -> `desc` REVERSES ties, `asc` keeps them
```

So with the tie-break deleted under `desc(created_at)`, a fixture registered in the reverse of the
asserted order comes back in *exactly* the asserted order, and the case passes having tested nothing.
The rule that governs, which needs neither the scan direction nor the index list to be known:
**register in neither the asserted order nor its exact reverse.** Two rows cannot satisfy that, so an
order assertion over tied rows needs three. `seedTrustLadder()` above is unaffected — `sort=name`
orders by the asserted column itself, so there is no tie to residualise — but the sentence
generalised out of it was wrong, and this paragraph is the version that stands.

My own first probe of this reported the opposite and was invalid: it built `create table t (name
text, created_at text)` with no index, so it measured a plan the registry never uses. A negative
result from an instrument that does not reach the thing being measured is not a negative result.

**A finding beyond the ticket.** The fixture's old name `by-verified` carries a hyphen, which the
name rule narrowed on 2026-08-24 (`^[a-z][a-z0-9]*$`) no longer admits — a fixture asserting
behaviour for a name the register would refuse to issue. Renamed to `attested`. Fixtures bypass
`validatePackageName` entirely (`seedPackage` inserts straight into the table), so nothing was
failing; the corpus had simply drifted from the rule.

I considered a ticket making `seedPackage` refuse a name the rule refuses, and **dropped it after
checking**: `tests/scripts/build-fallback-index.test.ts:506` seeds `http-client` on purpose, to
assert the generator refuses to publish it. Validating in the helper would make that test
unwritable. The scan that raised the question was also too crude to support the alarm — it swept
every `name:` in `tests/`, so most of its hits were publisher display names, a repo shorthand and a
filename. One real hit, and it was deliberate.

**Three orderings with no assertion at all, disclosed by the agent, and one of them I re-measured
because it could have gone stale.** The agent found the `SORTS.recent`/`.updated` tie-break
`asc(packages.name)` (`router.ts:544-545`) unasserted — but it reported that *in the same cycle it
fixed `:180` and `:355`*, and a fix to a paging assertion is exactly the thing that might
incidentally start covering a tie-break. So I reversed both tie-breaks to `desc` against the
**fixed** suite: **311 still green**. The disclosure holds post-fix. That matters more than the
other two, because with a constant `created_at` the tie-break is what makes offset paging
deterministic at all — it is the difference between paging and rows reappearing on page two.
`/api/stats`'s `recentPackages` is documented at `docs/REGISTRY-API.md:598` as "at most 8 entries,
newest first" and has no test file whatsoever. The publisher profile listing
(`src/lib/registry/queries.ts:374`) reverses green too.

**My ruling on the question the agent referred up** — whether to pin an ordering §6.3 does not
document. Pin it, and document it. The reasoning is not a preference: §6.3 already commits to
`limit` and `offset`, and offset paging over a non-total order is a correctness bug rather than an
unspecified nicety — rows repeat or vanish between pages when ties are broken differently on two
requests. Having committed to paging, the endpoint has already committed to a total order whether
the prose names one or not. So the order was never mine to decline to pin. Cycle 10, with the
tie-break and the missing stats coverage.

### Cycle 10 (2026-08-25) — order assertions that can fail, and `/api/stats` covered at all

**Tickets.** (1) The `SORTS` tie-break at `router.ts:544-546` was asserted nowhere, in `recent` and
`updated` both, and the publisher listing's identical order at `queries.ts:374` likewise. (2)
`/api/stats` had **no test file at all**, against `docs/REGISTRY-API.md:598` documenting "at most 8
entries, newest first".

**Result: 327 passing over 17 files**, up from 311 — search +2, publishers +1, and a new
`tests/api/stats.test.ts` carrying 13.

**Verified rather than trusted.**

- 327/17 reproduced on my own run, exit status taken without a pipe. `typecheck`, `lint`, `cf:build`
  and `docker/check-frozen-origin.mjs` all 0.
- `registry/v1/packages.json` unchanged: `d1bb196f19f45e884f36571690a10ae6`, 106 bytes.
- `git status` matched the agent's account exactly — `docs/REGISTRY-API.md`,
  `tests/api/publishers.test.ts` and `tests/api/search.test.ts` modified, `tests/api/stats.test.ts`
  new, and **no source file touched**. `router.ts` back at `15888877773be6a86c82ec77cac40308`;
  `src/lib/registry/queries.ts` clean against `HEAD`.
- Five mutants of my own, each anchored with a count assertion so a mutation that changed nothing
  could not be mistaken for a green:

| mutant | outcome |
|---|---|
| drop `asc(name)` from `SORTS.recent` | KILLED — "breaks a created_at tie by name, so a page boundary is stable" |
| drop `asc(name)` from `SORTS.updated` | KILLED — "breaks an updated_at tie by name, not by created_at" |
| drop `asc(name)` from stats `recentPackages` | KILLED — "breaks a created_at tie by name" |
| stats `limit(8)` -> `limit(80)` | KILLED — "holds at most 8 entries, dropping the oldest" |
| stats `desc(createdAt)` -> `asc(createdAt)` | KILLED — two cases |

- I checked each of the four new fixtures by hand against the corrected rule, and each is registered
  in neither the asserted order nor its reverse.
- §6.3 now states the publisher order as a guarantee, with the paging reason, and binds future
  editors: "A future editor may change the order the profile is presented in, but not to one that
  leaves ties unbroken." That is the ruling I gave, written where the next reader will find it.

**The agent contradicted my instruction and was right.** I specified two rows registered in the
reverse of the asserted order. It measured that this is blind for a `desc` primary sort, wrote three
shuffled names instead, and said so plainly rather than quietly complying. See the correction in
Cycle 9. This is the behaviour the arrangement needs: an instruction from me is not evidence.

**One misattribution, corrected in the agent's favour.** Its report cites `queries.ts` md5
`4b80d08d9672eef0bdfb9fa8b8597037` as "the md5s you recorded". I never recorded one for that file. I
verified it by its absence from `git status` instead, which is the stronger check: an md5 proves a
file matches a hash I may have taken *after* a change, while cleanness against `HEAD` proves it
matches the committed state.

**Method rules added, both now general.** A fixture must be registered in neither the asserted order
nor its exact reverse, and two rows cannot satisfy that. And: a negative result from an instrument
that does not reach the thing being measured is not a negative result.

### 3.17 Every CI-built deploy advertises its social-card image at localhost

Reported by the cycle-6 agent outside both tickets, verified by me. Pre-existing, in the deploy
pipeline rather than the application.

`layout.tsx` sets `metadataBase` from `NEXT_PUBLIC_APP_URL || APP_URL || "http://localhost:3000"`.
`APP_URL` **never appears in `.github/workflows/deploy.yml`** — the build step passes only
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. So in CI both are unset, the fallback wins, and
every statically prerendered page ships `og:image` and `twitter:image` resolved against
`http://localhost:3000`. Any link shared to Slack, Discord, or anywhere else that unfurls gets no
image at all.

Two properties worth stating before anyone fixes it. It is **build-time only for prerendered pages** —
dynamically rendered routes still resolve `process.env.APP_URL` from the Worker's vars at runtime, so
the bug is uneven across the site, which is exactly the shape that makes it survive spot-checks. And
`metadataBase` has **no placeholder guard**, unlike `configuredOrigin()`: `new URL(...)` accepts
`https://REPLACE_WITH_DEPLOYMENT_ORIGIN` happily, so naively wiring a repository variable through
substitutes one wrong absolute URL for another rather than failing.

Not fixed, because the fix needs a value only the owner has — the deployment origin, as a repository
variable or an inlined literal in the workflow. Worth pairing with the placeholder check, so a
misconfigured build fails instead of shipping.

### 3.18 `trust.repo_ownership_confirmed` is a literal, so `verified` claims two signals and has one

`src/app/api/[[...route]]/serializers.ts:94` is
`function repoOwnershipConfirmed(_pkg: PackageIdentity): boolean { return true; }`. Its doc comment
justifies the absent column: ownership is proven at registration and a claim is refused without it
(ADR-0004), so no row can exist with it false. That may well be sound. But `src/lib/trust.ts:63` is
`if (publisherVerified && repoOwnershipConfirmed) return "verified";` — so if the second signal is
unconditionally `true`, the `verified` level is `publisherVerified` under another name, while
presenting itself as the conjunction of two independent checks. The registry publishes
`repo_ownership_confirmed: true` to every caller including `finn`, and there is **no column anywhere
in the schema** to back it: I grepped `src/lib/db/schema.ts` and `drizzle/0000_registry_schema.sql`
and neither has one.

Two claims are separable here, and cycle 11 is dispatched to tell them apart rather than to assume:

1. **The premise may hold.** If every path that inserts into `packages` — the registration endpoint,
   the admin surface, any seed or backfill — really does prove push access first, then the literal is
   correct and the only defect is that nothing pins it, so a future path can skip the proof silently.
2. **The comment's uniqueness claim is already false.** It says "this is the one place that has to
   learn about it" while `router.ts:469`, `src/app/page.tsx:33` and `src/app/admin/page.tsx:433`
   hardcode the same literal independently. Agent B reported this two cycles ago; it is still true.

Whether a column is required is a schema decision and therefore the owner's. The agent is instructed
to stop at the analysis rather than write a migration, because I would rather have the reasoning than
an unreviewed schema change.

**Answered in cycle 11, and both halves came back as stated.** Claim 1 holds: there is exactly one
statement in the tree that inserts into `packages` (`router.ts:993`), and the push-access proof runs
before it — verified by my own sweep, not read from the report. Claim 2 was true and is fixed: there
were **five** hardcodes, not the four I named, and the two I missed were the worse ones. Details in
the Cycle 11 block below. The literal survives, deliberately, as a single named constant
(`src/lib/trust.ts:77`) that every publishing site imports — so the invariant is now pinned by tests
and documented in `docs/REGISTRY-API.md` §4.1.1 rather than merely uncontradicted.

### Cycle 11 (2026-08-25) — the unbacked claim: premise sound, five sites not four, and a hole I found myself

The ticket was to test §3.18's premise rather than assume it, fix the false uniqueness comment, and
**stop at analysis if a schema column turned out to be the answer**. All three were honoured.

**Verified by me, on my own runs, every exit code taken unpiped:**

| gate | result |
|---|---|
| `npx tsc --noEmit` | 0 |
| `npm run lint` | 0 |
| `npx vitest run` | **353 passed / 18 files** (352 from the agent, +1 mine — below) |
| `npm run cf:build` | 0 |
| `node docker/check-frozen-origin.mjs` | 0 |

The eighteen per-file counts sum to exactly 353. `registry/v1/packages.json` byte-identical
(`d1bb196f…`, 106 bytes). No pre-existing test was modified: every ` M` test file has an mtime at or
before 07:38, and the agent's first write was 09:50. `Sync.md` untouched by it, as instructed.

**The premise holds, and I checked it independently rather than accepting the table.** My own sweep
for `.insert(` across `src` and `scripts` returns six targets — `packages`, `users`, `logins`,
`verificationRequests`, `reviewMinutes`, `sessions` — and exactly one touches `packages`. So
`repo_ownership_confirmed: true` is not a fabricated claim today.

**What the agent found that I had not.** I named three bypassing hardcodes; there were five, and the
two I missed matter more than the three I found:

- `src/app/new/RegisterForm.tsx` carried a hardcoded `true` **and its own restatement of the ladder**
  (`viewer.isVerified ? "verified" : "recognized"`) — a fourth independent copy of trust logic.
- `scripts/build-fallback-index.mjs` carried its own constant **and its own `deriveTrustLevel`**, and
  it publishes trust levels into the static index that `finn` falls back to when the registry is
  unreachable. That is the tier-3 path: the one place a wrong trust level would be served with no
  registry available to correct it. I had audited the TypeScript and not the generator.

The single definition is now `src/lib/trust.ts:77`, imported by `serializers.ts`, `/api/stats` and
the moderation bench. The generator keeps the one unavoidable duplicate — it is Node and cannot
import TypeScript — and a test pins the two together. `src/app/page.tsx` keeps its literals because
it is a specimen record for an unclaimed name, with a comment explaining that a specimen calling the
real ladder would make invented data look measured. That distinction is right.

**A hole I found by mutating the agent's own strongest arm.** The agent disclosed, unprompted, that
its structural check is "a tripwire, not a proof" — a regex over source text that cannot see an
insert written in a spelling the pattern misses. Rather than accept the disclosure, I tested it: I
planted a second real insert path in a new file using `import { packages as pkgTable }` and ran the
suite. **It survived — 25/25 green with a live second path into the table.** The disclosure was
honest and the gap was exactly where it said, but "disclosed" is not "bounded", and the aliased
import is a spelling an ordinary developer would write without thinking.

So I strengthened it, and this arm is **mine, not the agent's**: instead of asking "does any insert
name `packages`", the new test enumerates *every* insert target in the tree and pins the set. An
alias cannot hide from that, because the alias itself becomes the new target. Mutant replanted → the
arm fails with a diagnostic naming the risk; mutant removed → green. That is the +1 test, and the
sequence matters: the mutant survived **before** the fix and dies **after**, which is the only
evidence that the new arm does anything.

The price is that adding any insert, to any table, now fails this test. That is deliberate and worth
saying plainly to whoever hits it: the failure is a prompt to check whether the new target can reach
`packages` under another name, and it is cheap to clear once checked.

**One correction to how the agent described its own work.** It reports that `RegisterForm.tsx` now
*measures* ownership (`access.status === "granted"`) instead of importing the constant, and that is
true and is the right call — nothing is registered yet, so a register-wide invariant about rows does
not apply to a preview. But `:302` returns `null` unless access is granted, so the value passed to
the ladder is `true` in every case that ever renders. **The change fixes provenance, not behaviour**,
and nobody should later read it as "the preview now varies". It is still an improvement: if that
guard changes, the value follows GitHub rather than a literal.

**Three disclosures of its own worth keeping**, because each is a limit a later planner would
otherwise have to rediscover: `RegisterForm.tsx` and `page.tsx` have **no test at all** (no
`@testing-library`, no `jsdom`, and installing one is forbidden), so they rest on typecheck and
reading; the "verified is decided by the publisher signal" test is a tautology today and exists to
start carrying weight the day ownership varies; and mutant M12 — reformatting the generator's ladder
without changing behaviour — **survived, correctly**, which is the evidence that the comparison pins
behaviour rather than text. An agent that reports a survivor as a success, with the reason, is doing
mutation testing rather than performing it.

**On the column, which I asked it not to decide:** it recommends against one, and the reasoning is
better than mine was. A column would hold one value for every row, and this schema already carries
`downloads`/`stars` as a standing caution about columns that publish a constant. The real gap
ADR-0004 names is the transfer/abandonment path, and the honest shape for that is a re-proof
*timestamp* (`ownership_proven_at`) — **when** was it proven — not a boolean restating what the
invariant already guarantees. That is now item 6 below. `REPO_OWNERSHIP_CONFIRMED` is the one line it
would replace.

### Cycle 12 (2026-08-25) — the counterfoil published two figures nothing measures, and only the whole defect bites

The ticket was §5 item 7's last real gap: `GET /api/dashboard/data` built every entry as
`{ ...pkg, ... }` — a whole Drizzle row — and so published `downloads` and `stars`, two columns
nothing in this codebase increments. It also had **no assertion anywhere about its body.** Not "no
assertion at all" — `no-token-forgery.test.ts` exercises it three ways and I re-read the file rather
than repeat the ticket's summary: a forged token gets a 401 on every signing key (`:98-104`), a
forged `?token=` gets a 401 (`:115-116`), and a real session gets a 200 (`:167-170`). All three are
authorization questions. Nothing had ever looked at what the endpoint returned. **My own brief said
"exactly one assertion" and cited `:165-169`, which is the `/api/auth/status` login check one
statement earlier — in range of the file, and the wrong lines.** Fourth instance of the same error
class recorded in §7: a range check catches typos, not wrong targets.

**Verified by me, on my own runs, every exit code taken unpiped:**

| gate | result |
|---|---|
| `npx tsc --noEmit` | 0, and 0 bytes of output |
| `npm run lint` | 0 |
| `npx vitest run` | **374 passed / 19 files**, 0 failed, 341.48s |
| `npm run cf:build` | 0 — `Worker saved in .open-next/worker.js`, `OpenNext build complete.` |

The nineteen per-file counts sum to exactly 374; I added them rather than reading the total line.
`queries.ts` gained two exported column sets and `router.ts:1506` was rewritten; `registry/v1/` and
`vitest.config.ts` are byte-identical. Registry `HEAD` is still `b496ff2` on
`feat/registry-implementation` — the agent remarked that HEAD had moved under it, and it had not: all
four commit dates predate this cycle, which is a thing to read rather than to take on report.

**Red before green, and the red is mine.** The defect was measured live in the previous cycle by
seeding `downloads: 4321, stars: 987` and reading the response, so this did not start from an
argument. What I added is the other half — proof that the new test *detects* it — by reconstructing
the defect in the fixed tree and running the suite against it. Five mutations, each reverted and
`diff -q`-verified, `queries.ts` untouched throughout:

| # | mutation | result |
|---|---|---|
| base | none | 21 passed |
| A | entry built as `{ ...pkg }` again, narrowed select kept | **21 passed** |
| B | select widened to `select()`, named construction kept | **21 passed** |
| C | **both — the original defect verbatim** | **2 failed / 19 passed** |
| D | account select widened to the whole `users` row | 1 failed |
| E | `userId` added to the sign-in select | 1 failed |

```
C: dashboard body publishes a counter the registry does not measure:
     expected [ 'downloads', 'stars' ] to deeply equal []
   dashboard entry: expected [ 'category', 'createdAt', …(17) ] to deeply equal
     [ 'createdAt', 'description', …(6) ]
D: dashboard user: expected [ 'avatarUrl', 'bio', 'blog', …(9) ] to deeply equal
     [ 'avatarUrl', 'createdAt', …(5) ]
E: sign-in: expected [ Array(5) ] to deeply equal [ Array(4) ]
```

**A and B surviving is the correct result, not a gap in the tests, and this is worth understanding
before someone "strengthens" it.** There are now two independent barriers — the select names its
columns, and the response names its fields — and *either alone is sufficient*: a whole row spread
into a narrowed shape publishes nothing extra, and a wide row that is never spread publishes nothing
extra either. Only removing both reproduces the bug, which is exactly what mutant C shows. The agent
reported this itself, unprompted, rather than presenting two survivors as two passes; I checked it by
building the mutants myself and got the same answer. **The guard belongs at the output**, because the
output is the thing that has to be true — the narrowed select is defence in depth and a performance
win, not the invariant.

**Two sibling defects the agent found that the ticket did not name**, each now with a mutation that
bites (D and E above):

- The account section published the whole `users` row — `bio`, `blog`, `location`, `githubId` and the
  internal `id` — to the account itself. Not a credential leak (the GitHub token a sign-in was minted
  with lives on `sessions`, ADR-0004, and I re-checked that), but five columns no page renders and no
  form offers.
- Each recorded sign-in published its `userId`. Redundant at best — the caller *is* that user — and
  an internal identifier in a response that had no reason to carry one.

Both are now named-column selects (`dashboardUserColumns`, and an explicit `{ id, ipAddress,
userAgent, createdAt }`), and the verification section withholds the requester's own `note` and the
`reviewerId` while publishing the reviewer's `reviewerNote`. I checked the credentials directly
rather than by field list: the suite asserts on the raw response text that neither the session token
nor a GitHub-token-shaped string appears anywhere in the body.

**The asymmetry the tests pin, which is the part a later reader will be tempted to "fix":**
`latestVersion` **excludes** yanked records and `versionCount` **includes** them. Both are right and
they are right for different reasons — `latest_version` is what a fresh resolve would pick (§3.3), so
a yanked record must never surface there; a version record that was written and can still be honoured
by an existing lockfile pin is nonetheless a record, so it counts. Five of the 21 tests exist to keep
that difference from being flattened in either direction, including the case where *every* record is
yanked and the honest answer is `null` rather than a fabricated `1.0.0` (§3.2).

`expectNoCounters` now guards six endpoints instead of five. It was never applied here, which is how
the one endpoint with no test was also the one endpoint that failed the rule.

**Two corrections the agent made to my brief, both of which I accept.**

1. I cited `REGISTRY-CONTRACT.md` §3.1 ("never return a Drizzle row") as the rule being broken. §3.1
   does not reach this endpoint: it is explicitly about **CLI-facing** responses, and
   `/api/dashboard/data` is browser-only camelCase surface that `finn` never calls. The rule that
   actually bites is §6's *no fabricated facts in the UI* — absent beats zero. The fix is the same
   either way; the citation was wrong, and a handoff that cites the wrong rule teaches the next agent
   a boundary that is not there.
2. **A spread is not automatically the bug.** Spreading a *narrowed* column set is safe and is used
   elsewhere in this tree deliberately. What made this a defect was spreading a whole row — the
   defect is the unbounded source, not the syntax. Written down because "grep for `...`" would be the
   obvious wrong lesson to draw from this cycle.

**Found and not fixed, correctly left to me:**

- **`docs/REGISTRY-CONTRACT.md:1227` is now false because of this work** — it tells the finn side that
  neither `/api/stats`, `/api/dashboard/data`, `/api/me/settings` nor the OAuth flow has a
  behavioural test, and that `POST /api/me/verification-request` has none at all. Three of those five
  claims are now wrong (stats 13, dashboard 21, verification-requests 17), and the paragraph is the
  reason that document's own status table says "untested". The agent flagged the doc impact of its own
  change instead of leaving it for someone to trip over. **Corrected by me this cycle** — see below.
- **`GET /api/auth/status` still returns the entire `users` row**, which `REGISTRY-API.md` §7 states
  in as many words, so it is documented rather than accidental. But the two endpoints now disagree
  about what an account looks like, and the narrowed one is the correct one. `dashboardUserColumns`
  carries a docblock saying exactly this, so whoever reconciles them has the reasoning to hand.

**A hazard I hit myself, documented in §7 of this file, while verifying a cycle.** I ran
`npm run cf:build` with the dev server up. It overwrote `.next/` underneath the running server and
every page began 500ing with `Cannot find module './873.js'`. The only reason this cost nothing is
that I captured the exact invocation *before* the build specifically because §7 warns about this —
so restoring it was one command, and `/`, `/explore` and `/docs` were re-probed back to 200 rather
than assumed. Knowing a hazard is written down is not the same as not walking into it; capturing the
recovery first is what made the difference.

## 4. finn's eleven asks, with this side's answer

From the reply §5, in their priority order. This table is the fastest route to a first wave of work.

| # | Ask | Status here |
|---|---|---|
| 1 | `GET /api/packages/:name` as specced | **Done.** Live and tested. Fixes `finn add <bare-name>` with zero CLI changes. |
| 2 | snake_case on CLI-facing responses | **Done.** Enforced by `serializers.ts`; responses are never raw Drizzle rows. |
| 3 | `trust` on version endpoints, *or* a guarantee it is package-level | **Answered, rev 6 §2.9.** It is package-level and version endpoints will never carry it (§3.4). |
| 4 | Never fabricate `latest_version` | **Done**, and permanently guarded — `tests/regressions/no-fabricated-version.test.ts`. |
| 5 | A version-existence answer, so `pkg@9.9.9` fails cleanly | **Blocked by §3.2.** The route exists and 404s distinctly; it 404s for *everything*, so it cannot yet distinguish. |
| 6 | Ship `GET /api/health` | **Done.** Live, tested, probed on `workerd`. Goes into `finn doctor`. |
| 7 | A documented name-normalisation rule | **Answered twice. Rev 6 §2.10 said the rule stays; the owner reversed that on 2026-08-24 and the rule narrows.** Old: `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/` — safe as a URL segment, **not** safe as a Fin identifier. New: `^[a-z][a-z0-9]*$`, length 2–64, plus a reserved-word denylist, refused at registration. Every legal name is now a usable Fin identifier, which retires §3.12's per-name import reasoning rather than documenting it. **Implemented, cycle 3**, at both enforcement sites, with the reserved-word list derived from the lexer — 58 words, adjudicated; the extra word over `FIN_KEYWORDS` is `m1778` and the register keeps it (§3.12). finn may now tighten to match, but keep `FIN_KEYWORDS` warning-only and keep `finname.rs` for GitHub shorthand. See §3.12. |
| 8 | Keep responses `file://`-mirror-able | **Satisfied on this side, and worth protecting.** Plain JSON at predictable paths; `§3.5`'s query parameters are the one place it could drift. The public repo makes mirroring a property of the design rather than a feature. **The remaining gap is on finn's side:** it accepts a `file://` base URL but `reqwest` cannot fetch one, so a mirror fails at request time (their §5.8b). |
| 9 | Immutability stated as a guarantee | **Answered, rev 6 §2.11.** Stated as a guarantee, not merely a current behaviour, on the grounds the reply gave: *"`finn.lock` is meaningless without it."* |
| 10 | Batch resolve | **Not built.** Their shape: `GET /api/packages/resolve?names=http,json@1.2.0,fs` — a `GET` because it is edge-cacheable on Workers; accepts `name` or `name@version`; returns a **name-keyed map with explicit `{"error":"not_found"}` entries** (silent absence is useless to them); capped at our choice; one indexed `WHERE name IN (…)`. Takes a cold 30-package resolve from 30 requests to 4–6. |
| 11 | Embed the latest version record in §3.2, or accept `?resolve=latest` | **Not built.** Cheapest item in the list, no new route, halves the unpinned case. |

Note that **#5, #10 and #11 all depend on §3.2** — version records existing at all. That
dependency should shape the wave ordering.

---

## 5. What remains on this side, in dependency order

Framed as assignable packages. Every one is verifiable locally; none needs a deploy.

1. ~~**Answer the reply.**~~ — **done, cycle 1.** Contract was at **rev 6**
   (`docs/REGISTRY-CONTRACT.md:5`) with new §2.9 / §2.10 / §2.11, a "Since rev 5" block in §0, §2.1
   cross-referenced, and §5.7 and §6 corrected. The three free asks are closed. What is *not* closed:
   the eight remaining asks are code or are blocked on (2).
   **Now at rev 7, cycle 3:** the name rule narrowed to `^[a-z][a-z0-9]*$` plus Fin's reserved words
   (§3.12 addendum), so §2.10 records a decision instead of a caveat and ask 7 is closed as
   implemented rather than answered.
2. **Decide the version-record write path** (§3.2). This is a design decision before it is code,
   and it gates 3 of their 11 asks. See §8.
3. **`checksum` → `commit`** (§3.3), if adopted: schema, serializers, types, homepage specimen,
   `Countersignature`, and a rewrite of `docs/integrity`. Needs a migration.
4. **Batch resolve** (ask 10) and **`?resolve=latest`** (ask 11). Both need (2) to be meaningful.
5. **Publish the pointer and the fallback index** (§3.1) — **written, cycle 1; not yet published.**
   `registry/v1/url.txt` (**8111 bytes, 135 lines, every one of them a comment or blank — verified
   2026-08-25 with `grep -vcE '^\s*#|^\s*$'` returning 0, which is the check that matters here, not
   the byte count; it read "5180 bytes, 89 lines" for several cycles after the file grew**) and
   `registry/v1/packages.json` (`schema: 1`, `registry_url`, `generated_at`, `packages: {}`) both
   exist, at the paths agreed with the finn side. `scripts/build-fallback-index.mjs` generates the
   index from the local D1 and merges authored entries from `scripts/fallback-stdlib.mjs`;
   `npm run build:fallback-index` runs it. Documented in `REGISTRY-API.md` §12.

   **Three things still open, and the first is the whole point of the ticket:**
   - **Neither file is on the default branch, so both raw URLs 404.** They are on
     `feat/registry-implementation`; `origin/master` is `a5ef515`; `HEAD` resolves to `master`.
     Until this merges, finn has no address to fall through to — tier 3 was removed, so it reports
     that no registry is known rather than that the package does not exist. Honest, and still
     unusable. **This is the highest-leverage merge in either repository.**
   - **No CI job runs the generator yet.** Until one does, the index is a snapshot someone
     remembered to regenerate. `generated_at` is the only field that moves on an unchanged
     register — entries are sorted for byte-stable output — so a scheduled job produces a one-line
     diff, not a reordered file.
   - ~~**The URL line is a placeholder**~~ — **closed, cycle 2.** The line is gone;
     `registry/v1/url.txt` is now comments only and says in the file why, and
     `registry/v1/packages.json` carries `"registry_url": null`. The decision below is implemented,
     including the check it asked for. **This was more dangerous than it looked — see below.**

   **DECISION: `url.txt` merges as comments only, with no URL line, until a real deployment exists.**

   The placeholder **passes every format rule** the file itself documents — https, non-empty host,
   no trailing slash, no path. So if it merges unchanged, finn accepts it, **caches it for 24
   hours**, and then reports the registry as *unreachable* rather than as *undeployed*. That is
   exactly the failure the finn side's tier-3 decision was made to prevent (a compiled-in host that
   404s turns "not deployed yet" into "your package does not exist"), reintroduced one layer up.
   Raised by the finn agent in cycle 3, and it is right.

   A client-side placeholder denylist is **not** the fix: that would be finn hardcoding a guess
   about the contents of this repository's file, which is the same mistake pointing the other way.

   Verified end to end against finn's implementation: a comments-only pointer makes
   `parse_pointer` (`~/finn/src/discovery.rs:396`) return *"it contains no URL line — every line is
   blank or a comment"*, which flows into the tier-2 failure arm, finds no cache and no compiled-in
   default, and produces an error naming both escape hatches and stating plainly that no registry
   deployment is known. That is the honest failure and the one we want.

   What it buys: **the path gets merged and proven now**, so the highest-leverage merge stops being
   blocked on a deploy that has not happened; the placeholder is never cached as an address; and
   when the deploy lands, **one line is appended to a file already on the default branch** — no
   second merge, no CI change, no finn release.

   **Owed on this side, and it is cheap:** a check that the string `REPLACE-WITH` can never appear
   in URL position in `registry/v1/url.txt`. A test is enough; a CI step is better.
   **Delivered, cycle 2, in three places** — `tests/regressions/no-guessed-registry-url.test.ts`
   (the committed bytes of both files, no database and no generator involved),
   `scripts/build-fallback-index.mjs` (refuses to generate from a placeholder pointer), and
   `scripts/check-fallback-index.mjs --pointer` plus a preflight step in
   `.github/workflows/fallback-index.yml`. The guard covers `packages.json` too, because finn writes
   the index's `registry_url` into the same 24-hour cache the pointer feeds
   (`~/finn/src/discovery.rs:362`), which makes a placeholder there the identical hazard one file
   over; and it asserts the two files cannot disagree — the one rule the generator cannot enforce,
   since the generator writes both. Each guard was exercised in both directions with temporary
   fixtures, then the fixtures reverted byte-identically. Every assertion is an invariant, not a
   snapshot: appending the real URL after a deploy needs no test, CI or doc change.

   `packages` is empty **on purpose**: all seven rows in the local dev database are fictions
   pointing at third-party repos, and the generator publishes only `github.com/M1778/*`. Verified
   against a temp database seeded with real first-party rows — the entry shape is emitted
   correctly, yanked versions are excluded from `latest_version`, the trust level derives from the
   same two columns as `src/lib/trust.ts`, and a package with no version rows emits `null` rather
   than a placeholder for `latest_version`/`tag`/`commit`.
6. **Deploy for real**: `wrangler d1 create`, apply migrations remotely, set `CAPTCHA_SECRET` and
   the GitHub OAuth pair as Worker secrets, publish, **then write the new URL into `registry/v1/url.txt`**
   — which is now the only place the hostname has to change (§3.1). No finn release required.
7. **Test the untested browser surface** (§2). Re-measured 2026-08-25 after cycle 12: **five of the
   six named here are done, and OAuth is the only one genuinely open.** Current state, by suite:
   - verification requests — `tests/api/verification-requests.test.ts` (17 cases). Done.
   - stats — `tests/api/stats.test.ts` (13). Done.
   - the admin bench — `tests/admin/actions.test.ts` (28). Done.
   - settings — covered where it counts: `admin/actions.test.ts:599` proves `PATCH /api/me/settings`
     ignores `role` and `is_verified`, standalone and mixed into a larger body. Privilege escalation
     is the risk on that route, and it is pinned.
   - **OAuth — partially.** Two regressions exist (`no-state-to-parent-frame.test.ts`,
     `no-origin-from-headers.test.ts`, 9 cases each) but they pin two specific historical bugs, not
     the callback flow end to end. Still genuinely open.
   - ~~**dashboard — the real gap, and worse than "untested".**~~ **Closed, cycle 12.**
     `tests/api/dashboard.test.ts` is 21 cases and `expectNoCounters` now guards six endpoints
     instead of five. **This entry's "exactly one assertion anywhere, `:165-169`" was wrong in two
     ways** — the endpoint had three authorization assertions in `no-token-forgery.test.ts`
     (`:98-104`, `:115-116`, `:167-170`) and none about its body, and `:165` is a different
     endpoint's check. What was true is the part that mattered: nothing had ever read the response.
     The defect was real and was measured, not argued: seeding
     `downloads: 4321, stars: 987` and reading the response showed the endpoint publishing both,
     because the handler built each entry as `{ ...pkg, ... }` — a whole Drizzle row. Two sibling
     defects came out with it (the whole `users` row, and `userId` on every sign-in record). Every
     section is now built from named fields over a named column set, and each of the three has a
     mutation that fails the suite. **One correction to what this entry used to say:** it cited §3.1
     ("never return a Drizzle row"), and §3.1 is about CLI-facing responses — this endpoint is
     browser-only camelCase surface that `finn` never calls. The rule it broke is §6's *no fabricated
     facts in the UI*. Full record in Cycle 12 above, including why only the whole defect bites.
8. **Smaller, known, and out of scope so far.** Re-measured 2026-08-25; two entries this list
   carried for several cycles were already fixed, so what is left is:
   - `/package/[name]` ships 94 kB of page JS (200 kB First Load), the heaviest route.
   - `fuse.js` and `@tailwindcss/typography` are declared in `dependencies` and imported nowhere.
     Typography is deliberate, not an oversight: `globals.css:338` records that the `readme` class
     replaced it because `prose-invert` carries no theme condition and put body text at 1.25:1 on
     the paper theme. The dependency is what is left over.
   - `cmdk` is imported by exactly one file, `src/components/ui/command.tsx`, which **nothing
     imports** — a leftover shadcn component. Dead code holding a live dependency, so removing the
     dependency means deleting the component too.
   - `jose` is in `dependencies` but its only importer is `tests/regressions/no-token-forgery.test.ts`,
     which forges a JWT to prove the session verifier rejects it. That is load-bearing, so `jose`
     stays — it belongs in `devDependencies`, which is the same lockfile problem as the others.

   All four need a lockfile update, which has been off-limits.

   **Already fixed — do not re-open.** `authError` no longer loads `https://cdn.tailwindcss.com`;
   the handful of rules it used are written out inline, and `router.ts:1069` explains why in the
   past tense (an error page that needs the network to render goes blank when the network is the
   thing that is wrong). `rounded-3xl` is gone from the codebase — zero occurrences, so the house
   radius rule is not violated anywhere. The nineteen `prose-*` classes in `PackageTabs.tsx` are
   also gone, replaced by the `readme` class; `PackageTabs.tsx:112-126` records that registering
   the plugin as a v4 `@plugin` was tried and rejected on contrast. This list billed all three as
   open long after they were done, which is how a handoff sends the next agent to redo finished
   work.

---

## 6. Settled — do not let an agent reopen these

Each of these was argued once and costs real work to relitigate.

- **The registry indexes; GitHub serves.** We never host code. ADR-0001. *Never phrased to end
  users as "we do nothing" — the owner was explicit about that. It is architecture, not copy.*
- **Names are bare and globally unique**; a slash always means GitHub, permanently.
- **A registry name is a Fin identifier**: `^[a-z][a-z0-9]*$`, 2–64, and not a Fin reserved word,
  refused at registration rather than normalised or warned. Owner's ruling, 2026-08-24, reversing
  rev 6 §2.10. The list is **58 words derived from `Fin/src/lexer/lexer.l`**, adjudicated after a
  derivation disagreement — including `m1778`, and excluding `DiagnosticEngine.cpp`'s eight
  non-keywords. See §3.12.
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
npx vitest run               # 374 tests across 19 files (cycle 12, 2026-08-25 — re-measure)
npm run build
sudo docker build -t finn-verify . && sudo docker run --rm finn-verify   # the full gate on workerd
```

**The suite was flaky and is now not; do not undo the fix.** Several endpoints sit behind real
proof-of-work (`captcha-shared.ts`: `login` 13 bits, `register` and `verify-request` 15), and a
single test that signs in and then posts twice does ~100k hashes before it asserts anything.
Vitest's 5s default was enough on an idle machine and not enough on a loaded one: I measured one
`verify-request` test at 11.5s under 6x CPU oversubscription, and got one red run and one green run
from identical code. `vitest.config.ts` now sets `testTimeout: 30_000`. The difficulty is
deliberately **not** lowered for tests and there is **no env knob** to lower it: it is a production
security parameter, and a lever that weakens it for convenience is a worse thing to own than a slow
suite. A flaky gate is the worst kind, because it teaches everyone to re-run until green.

`docker/verify.sh` is the only thing that proves the Worker boots on the runtime we deploy to:
everything else runs on Node. It also boots the Worker **without** a D1 binding and asserts the 5xx
names the missing binding, because that is the state a first deploy lands in.

**Two ways a figure in this file goes wrong, both of which happened.**

The `236` above was one of them: true when written, corrected in a later cycle, never updated here.
A stale figure in a handoff document is not a cosmetic problem — quoted forward by the next planner
it becomes a claim nobody measured, and if it is stale in the pessimistic direction it invites a
whole cycle spent re-fixing what is already clean. (`~/finn`'s §8 had four of those: it advertised
184 formatting hunks and 19 clippy errors as "red" long after all four gates went green.)
**Re-measure before quoting any number in this file** — but only the *instructions*. The figures
inside a dated cycle record (`257 passed / 13 files` after cycle 3, `236` in cycle 2, `275/15`,
`311/16`) are correct as history and must be left alone: they say what was true when that cycle was
verified, which is how a later planner can tell growth from drift. Update the numbers a reader is
told to expect; never the numbers a reader is told were once observed.

The other is subtler, and I did it while hunting for the first. I swept this file for stale figures
by grepping for `147|39 passed|184|19 errors` — the specific wrong values I *expected* to find. It
matched nothing, so I concluded there were none, and the actual stale figure said `236` and sat
three lines above where I was looking. **A sweep aimed at guessed values cannot report absence**;
read the figures and check them, or grep for the shape (`grep -nE '[0-9]+ (tests|passed)'`) rather
than for the values you already suspect.

**And a grep that cannot decode a file reports nothing, not an error.** One invalid byte makes GNU
grep treat a whole file as binary and return exit 1 with no output and no warning — so a sweep
concluding "not present" is worthless over an undecodable file unless it passed `-a`. This repository
happens to be clean (every tracked and untracked source file decodes as UTF-8, checked with `iconv`),
so it is not a live hazard here; `~/finn`'s `install.sh` is undecodable and the full account is in
that file's Cycle 11. All three of these are the same rule wearing different clothes: *before a
negative result means anything, prove the instrument reaches the thing being measured.*

**Check this file's own line citations before trusting one.** Every `file.ts:NN` reference here is
a claim that can rot silently — the file gets rewritten and the number now points at unrelated
code. A mechanical sweep catches the cheap half:

```
python3 - <<'EOF'
import re, os
CITE = re.compile(r"`([\w./\[\]@-]+\.(?:ts|tsx|rs|md|mjs|css|sql|sh|iss|yml|py)):(\d+)(?:[-–](\d+))?`")
SKIP = {"node_modules", ".git", "target", ".next", ".open-next", ".wrangler"}
# Both trees, so a cross-repo citation resolves instead of reporting NO SUCH FILE.
ROOTS = [".", "../finn", "../finn-registry"]
idx = {}
for root in ROOTS:
    if not os.path.isdir(root):
        continue
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP]
        for fn in fns:
            idx.setdefault(fn, []).append(os.path.join(dp, fn))
total = bad = 0
for n, line in enumerate(open("Sync.md", encoding="utf-8"), 1):
    for m in CITE.finditer(line):
        rel, a = m.group(1), int(m.group(2))
        b = int(m.group(3)) if m.group(3) else a
        total += 1
        base = os.path.basename(rel)
        # Strip a leading repo name so `finn-registry/docs/X.md` matches `../finn-registry/docs/X.md`.
        tail = re.sub(r"^(finn-registry|finn)/", "", rel)
        cands = [p for p in idx.get(base, []) if p.endswith(tail)] or idx.get(base, [])
        if not cands:
            print(f"NO SUCH FILE  Sync.md:{n}  {rel}"); bad += 1; continue
        if not any(b <= sum(1 for _ in open(p, encoding="utf-8", errors="replace")) for p in cands):
            print(f"OUT OF RANGE  Sync.md:{n}  {rel}:{a}"); bad += 1
print(f"{total} citations, {bad} broken")
EOF
```

Run on 2026-08-25 with both trees present, after cycle 12: **57 citations in this file, 84 in
finn's, 23 in `docs/REGISTRY-CONTRACT.md`, 0 broken in any of the three.** The contract is worth
sweeping too — it is the document the finn side reads as authoritative. The `ROOTS` list is what earned the zero — an earlier version walked only `.`, so all 16
of this file's `.rs` citations into finn's tree came back "NO SUCH FILE" and had to be waved off in
prose as expected-not-defects. Sixteen standing exceptions is how a real breakage hides, so the
sweep now resolves both trees and every line of its output is something to look at. (The snippet in
this file has been executed as written, in this form. An earlier draft had a quoting error and did
not run at all — a documented command nobody has run is the same class of claim as an untested code
path.)

But understand what
that does *not* prove. **A range check catches typos, not wrong targets** — four instances now, all
found by reading, none by the sweep:

- finn's `-q` citation was `main.rs:120-131`, in range of a 214-line file, pointing at the clap
  `Commands` enum rather than the error guard it claimed to describe.
- finn's Sync.md cited `finn-registry/docs/REGISTRY-CONTRACT.md:335` for "refuses anything below
  `trusted`". `:335` is a Markdown table separator, `|---|---|`. The sentence is at `:340`.
- The same file cited `:339` for a sentence about `--ignore-regulations` and `is_official`. `:339`
  is a **blank line**, and the two real bullets at `:349`–`:350` say what the ruling decided — so
  the "contract divergence, needs a registry-side edit" ticket built on that citation was for work
  already done. A wrong citation is how finished work gets billed as open.
- **My own, cycle 12.** §5 item 7 said `/api/dashboard/data` had "exactly one assertion anywhere:
  `no-token-forgery.test.ts:165-169`". `:165` asserts a login on `/api/auth/status`; the dashboard
  call is `:167-170`, and there were two more assertions on the endpoint elsewhere in the same file.
  In range every time, and the number of assertions was understated by three. **The claim that
  mattered — nothing had ever read the response body — was true, which is exactly what makes this
  worth recording:** a citation that is nearly right lends unearned precision to a summary nobody
  re-derived.

All four sat inside a large file and passed the sweep every time it ran. The content half needs a
reader opening both sides, and the citations worth that effort are the ones someone is about to act
on. The fourth is the cheapest to generalise: **the citations most worth re-opening are the ones in
your own brief to an agent**, because those are the ones that will be acted on without being
re-derived.

Never run `npm install` / `npm ci` on the host — the lockfile is not to be updated. `npm ci` runs
inside Docker only.

A dev server is usually up on port 3000 for UI review. Do not run `npm run build` while it is
running: the production build overwrites `.next/` underneath it and every page starts 500ing with
`MODULE_NOT_FOUND`. Restart the dev server after a build.

---

## 8. What only you can decide, holding both projects

1. **How version records get created** (§3.2), now narrowed to a single question —
   *does the registry acquire a GitHub identity of its own?* — because the only GitHub credential it
   has today is the registrant's, and it lasts as long as their browser session. The registry has no
   writer; finn has the data
   (`LockedPackage`) and will never have a credential. Browser form per release, GitHub App on tag
   push, or read tags from GitHub at resolve time? This gates asks 5, 10 and 11, and it is the one
   place the two designs genuinely fail to compose.
2. **Whether `repo_ownership_confirmed` becomes `ownership_proven_at`** (§3.18, Cycle 11). Not
   "should there be a column" — cycle 11 answered that with a reasoned no. The live question is
   whether the register should record *when* ownership was proven, which is the only version of this
   signal that would still be true after a repository is transferred, deleted, or abandoned. Today
   the field is past tense and says so in the docs; a timestamp would make it checkable. It is a
   migration, so it is yours.
3. **Whether to adopt `commit` over `checksum`** (§3.3). The argument is sound; the cost is a
   migration and a user-facing docs rewrite. It is the reply's headline recommendation and it
   should be accepted or rejected explicitly, not left to drift.
4. ~~**The registry's licence**~~ **ANSWERED BY THE OWNER, 2026-08-24: AGPL-3.0.** Implemented —
   see §3.1 for the canonical text, the `package.json` identity fields, the §13 source-offer
   obligation now met in the footer, and the one-directional compatibility with GPL-3.0 `finn`.
3b. **Getting the two discovery files onto the default branch.** They resolve at `HEAD`, which is
   `master`, and `master` knows none of this exists. Whatever the merge story is, it has to
   happen before a single finn can discover anything.
3c. **Do stdlib modules become registered packages?** `scripts/fallback-stdlib.mjs` ships with
   `STDLIB_ENTRIES = []`, deliberately. Per `~/Fin/docs/finc-interface-contract.md` the stdlib
   ships **inside the compiler archive** at `<exe dir>/../lib/std` and `finn` never fetches it — it
   has no repository of its own and no register state to derive a trust level from, so authoring
   entries would fabricate a distribution model and make `finn add` clone the compiler repository.
   (`~/Fin/lib/std/` now exists — 11 modules — so this is a live question, not a hypothetical.)
   Deciding otherwise changes both repositories; the file and its exact entry shape exist so that
   change is one array literal.
3d. ~~**Narrow `NAME_RULE`, or leave it?**~~ **ANSWERED BY THE OWNER, 2026-08-24: narrow it.** The
   time-sensitive item on this list is now spent, correctly, while the window was still open. New
   rule, denylist, the no-speculative-reservations decision and the measured migration cost are all
   in §3.12. **Ordering constraint for whoever schedules the work: the register narrows first, the
   CLI follows.** If `finn` tightened ahead of the register it would refuse names the register had
   already accepted — the one direction that breaks a working install. The reverse merely wastes a
   round trip and returns a clear server-side refusal. `finn`'s agent has been told in writing not
   to touch `finname.rs` until the register has moved.
5. **Wave composition.** §3.6 is the clearest example of why: version-pinned resolve needs a fix in
   *both* repos before it can be tested at all. Independent agents on independent repos will each
   report success while the pair remains broken.
6. **Who owns the shared vocabulary.** `CONTEXT.md` here and the glossary in the reply's §6 are two
   copies of one thing. They have already drifted once (`finn healthcheck`, §3.10). One of them
   should be the source.
