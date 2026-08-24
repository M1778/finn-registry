# Finn Registry ↔ Finn CLI: architecture and endpoint contract

**Audience**: whoever works on `finn`, the package manager (separate repository).
**Status**: decisions below are settled unless a section says OPEN.
**Written**: 2026-08-22. **Revised**: 2026-08-23 (rev 5).

Read the first section before the endpoints. The endpoints only make sense once the
distribution model is clear, and the model is not the one the registry's own published docs
currently describe.

**Read this next to `docs/REGISTRY-API.md`.** That document is the reference for *what the API
actually does* — exact payload shapes, status codes, query parameters and limits; this one is the
decision record, and its job is *why* the surface is shaped the way it is and what is still open.
Where the two disagree about behaviour, `REGISTRY-API.md` is authoritative and this document is
simply out of date.

---

## 0. What changed

### Since rev 4

**Nothing in this revision changes any endpoint `finn` calls.** If you only read one line of this
section, read that one.

- **The browser writes now require proof of work** (§3.12). The three `POST`s in §3.10, plus the
  sign-in redirect, will not act without a small SHA-256 search having been done by the caller.
  Everything in §3.2–§3.6 and §3.9 — the entire CLI surface — is untouched: still public, still
  plain `GET`, still no headers required. §3.12 exists so that if you see a `428` in a route table
  or a server log you know what it is and that it is not aimed at you.
- **One new error code, `captcha_required` (428)**, and one more, `invalid_scope` (400), on the
  challenge endpoint. Both are browser-only, bringing the never-yours list to eleven.
- **One new browser-only endpoint, `GET /api/captcha`.** It hands out challenges. It is not
  authenticated, because a form on the sign-in page needs one before there is a session — but it
  does nothing except issue a puzzle, and no CLI has any reason to call it.

### Since rev 3

Nothing in this revision removes or renames a field the CLI reads. It is additive: one new
browser-only endpoint, three new error codes that belong to it, one new decision recorded, and one
new open question for you.

- **New §2.8: the register now keeps minutes.** Every act of verifying a publisher, refusing a
  request, or vouching for a package is recorded against the reviewer who did it. This changes
  nothing on the wire *today* — see §4.3, which asks whether it should.
- **New endpoint in §3.10: `POST /api/me/verification-request`.** Browser-only, like the rest of
  §3.10. It is how a signed-in publisher asks to be verified. Listed so that if you see it in the
  route table you know it is not yours.
- **Three new error codes in §3.11**: `invalid_note` (400), `already_verified` (409),
  `request_pending` (409). All three belong to that one endpoint, so the CLI should never see any
  of them. That list runs to nine — see §3.11, which also now documents `internal_error`, the one
  code in the table the CLI certainly will see.
- **The reviewing surface exists.** Verification requests and package vouching are ruled on by a
  human at `/admin`, backed by server actions rather than API routes — deliberately, so that §3
  stays exactly the surface `finn` consumes and nothing more. There is no moderation endpoint for
  you to find, and there will not be one.

### Since rev 2

Rev 2 is the version that was handed over first, so start here. Unlike rev 2, **one payload field
was removed**, so this revision can invalidate code.

- **`downloads` is gone from every response.** Not on a §3.2 record, not on a §3.5 item, not as a
  total anywhere. Nothing had ever incremented the column, so it was `0` on every package in the
  register — a number that reads as "nobody uses this" rather than "we do not measure this". If you
  wrote a struct field for it, delete it; a missing key is now correct. Full reasoning in §3.5, and
  §4.2 records what is still open (whether the CLI should ever report installs at all).
- **§3.7 is resolved, and the numbers are much higher.** Reads get 1000 per 15 minutes, separate
  from writes. The old single 100-per-15-minutes ceiling covered everything and would have failed a
  large `finn sync`. Response headers now tell you your remaining budget, and a `429` carries an
  exact `Retry-After` — please read it rather than guessing. One caveat documented there: the
  counter is per Worker isolate, so the effective ceiling is higher and less predictable than the
  stated number, never lower.
- **New §3.11: the error-code table.** Every code, with the status each arrives on. Two
  worth noting because they are new behaviour, not just newly written down: `sort=downloads` and
  `sort=stars` return `400 invalid_sort` rather than silently sorting by something else, and every
  error now uses `{ "error": "<code>", "message": "<sentence>" }` — a couple of endpoints used to
  put a capitalised sentence in `error`, so if you matched on that string, match on the code now.
- **§3.4 is now explicit that a non-exact version is `400`, never `404`.** This was implied before
  and is worth re-reading: it is what lets you keep treating a genuine `404` as "does not exist".
- **§3.5 gained a parameter table**, including `trust=recognized` as an accepted no-op, and §3.9
  and §3.10 document the browser-only endpoints so that they are recognisable as not-for-you.
- **§3.8's numbers are the platform's published allowances, not measurements.** Nothing has been
  profiled under load. What *has* been proved is narrower, and worth stating exactly: the worker
  builds for `workerd` and boots on it, and `/api/health`, `/api/packages` and a `404` on an
  unregistered name have been served from that runtime with a D1 binding — three routes, against an
  empty register. Everything else in §3 has only ever run in the test harness, which is Node
  against a temporary SQLite file rather than `workerd` against D1. Read §3.8 as ceilings to design
  against, not as observed behaviour.

### Since rev 1

- **New §2.7**: moderator and admin are now distinct roles, split along the two trust signals.
  Moderators mark packages trusted; admins verify publishers. This does not change what the API
  returns — `trust.level` is still the only field you branch on.
- **New §3.8**: the registry's runtime limits, and what they mean for how you call it. Read this
  one. The 10 ms CPU ceiling per request is the reason some responses will stay lean, and it
  changes the rate-limit picture in §3.7.
- **§2.6 hardened**: `api_keys` and `auth_codes` are being deleted outright, not just left
  unused. There is no path by which the CLI authenticates. If you had any plan that depended on
  a CLI token, raise it now.
- **§4.1 unchanged but more urgent**: still waiting on whether `calculate_package_hash` is
  reproducible from a clean clone. That single answer decides whether `checksum` stays in §3.3
  or is deleted.
- Registry schema is being reshaped (roles, verification requests, `versions.git_ref`,
  `versions.commit`, `versions.yanked`, recovered `license`/`keywords`). All of it was already
  reflected in rev 1's §3 payloads, so this is FYI, not a contract change.

---

## 1. What Finn Registry is

Finn Registry **hosts no code**. It stores no tarballs, no source archives, no build outputs,
and it does not proxy or cache package contents. GitHub is the content server: package bytes
are fetched from GitHub, and package history and versions are version-controlled in the
publisher's own Git repository.

What the registry owns is *recognition*. It answers one question the CLI cannot answer on its
own:

> Who stands behind this name, and does anyone vouch for them?

So the registry is the **distributor of record** — it is the authority on what a package name
means and who may claim it, and it is where a resolution begins — while GitHub remains the
**content server** that actually serves the bytes. Both halves of that sentence matter. Saying
"the registry distributes packages" is correct at the level of names and provenance; saying it
"hosts packages" is not.

A consequence worth stating plainly: **the registry never sees package contents**, so it cannot
compute a checksum, cannot scan code, and cannot sign an artifact. Any trust it reports is trust
about *identity*, not about code. The registry's current published docs claim cryptographic
signing and global content caching; those claims are false and are being removed.

### Division of responsibility

| Concern | Owner |
|---|---|
| Package name → repository pointer | Registry |
| Who may claim a name | Registry |
| Publisher identity and verification | Registry |
| Trust signals | Registry |
| Version records (which tag/commit is `1.2.0`) | Registry (mirrors the repo) |
| Package bytes, history, tags | GitHub |
| Semver range resolution | **CLI** |
| Fetching, building, integrity of the working tree | **CLI** |
| Lockfile | **CLI** |

The registry deliberately does **not** resolve semver ranges. It publishes the version records
it knows about and the CLI picks. This keeps the registry dumb and keeps range semantics in one
place — the tool that already has `finn.lock` and the dependency graph.

---

## 2. Decisions

### 2.1 Package names are bare and globally unique

A package is `http`, not `acme/http`. One flat namespace, first claim wins, subject to §2.2.

This settles a live contradiction. The registry's docs said names must be `owner/name`, but
`finn/src/commands/add.rs:195-199` treats *anything containing a slash* as GitHub shorthand
**before** it ever reaches the registry lookup:

```rust
if base_input.contains('/') && !base_input.contains('\\') {
    let url = format!("https://github.com/{}.git", base_input);
    return Ok(PackageSource { ... is_official: false });
}
// Registry Lookup  ← unreachable for any name with a slash
```

So a scoped name was structurally unresolvable. Rather than break the CLI's most-used input
syntax for an empty namespace, bare names win and **a slash always means GitHub, permanently**.
The docs are being corrected, not the resolver.

If scoping is ever wanted, it comes in as an *alias* layer on top of bare names, and it needs a
new disambiguating prefix for GitHub shorthand (e.g. `gh:acme/http`). That is not planned.

**The name grammar**, decided while building the registration form, since a form cannot validate
against an unwritten rule:

```
^[a-z][a-z0-9]*(-[a-z0-9]+)*$      length 2–64
```

Lowercase only, digits allowed, single hyphens between segments, must start with a letter. No
underscores, no dots, no leading/trailing/doubled hyphens, no uppercase — so a name is never two
names that differ only by case or separator, and it is always safe as a directory name, a URL
segment, and a TOML bare key.

The registry enforces this at registration. Please apply the same rule in the CLI when parsing
`finn add <input>`: anything that fails it and contains no slash is a malformed name, which you
can reject locally without a network round trip. (A slash still means GitHub, always.)

By convention a Fin package repository is named `fin-<name>` — `acme/fin-http` registers as
`http`. That is a convention for humans, not a rule: the registry stores whatever bare name was
claimed and never derives one from the repository.

### 2.2 A name claim requires proven push access to the repository it points at

Registration is refused unless the authenticated GitHub user has push access to the repository
being claimed. This is checked against the GitHub API at registration time; no human is
involved.

Without this gate the entire product is theatre — anyone could claim `http` and point it at
their own repository. It also means "registered by X" carries weight even when X is not a
verified publisher.

Registry-side consequence: the OAuth scope currently requested is `user:email` (`requestedScope`,
`src/app/api/[[...route]]/router.ts:985-989`), which cannot see repository permissions. The wider
scope is requested incrementally *at registration*, not at sign-in, so browsing and logging in
do not demand repository access.

### 2.3 Two independent trust signals, and a promotion path

There are two signals, not one:

- **Verified publisher** — a human admin has reviewed a verification request and confirmed the
  account or organisation is who it claims to be. Travels to everything that publisher
  registers.
- **Trusted package** — a human moderator has flagged one specific package as trustworthy (§2.7;
  `setPackageTrust` requires only `isModerator`, `src/app/admin/actions.ts:157`). Does
  **not** require the publisher to be verified: a good package from an unknown individual can be
  marked trusted on its own merits.

They are orthogonal on purpose. Accumulated trusted packages are grounds for an admin to verify
the publisher's account, so the second signal is a route to the first rather than a lesser
version of it.

### 2.4 The CLI branches on one field, not on the raw signals

The registry computes a single `trust.level` and the CLI switches on that. The individual
booleans are returned for display only. When the registry adds a signal later, the CLI does not
change.

| `trust.level` | Meaning |
|---|---|
| `verified` | Publisher is a verified identity, repo ownership confirmed |
| `trusted` | Package is moderator-flagged trusted; publisher not (yet) verified |
| `recognized` | Registered, repo ownership confirmed, no reviewer signal |
| `unrecognized` | **CLI-side only.** Not registry-resolved at all — raw Git URL, GitHub shorthand, or local path. The registry never returns this. |

### 2.5 The CLI asks the user rather than refusing

Today `finn/src/commands/install.rs:15` hard-fails on anything with `is_official: false` unless
`--ignore-regulations` is passed. Combined with §2.1 that means *every* `owner/repo` install is
blocked by default, which trains users to pass the escape-hatch flag reflexively and destroys
the signal. Replace it with:

| Level | Behaviour |
|---|---|
| `verified`, `trusted` | Print one provenance line. Proceed. |
| `recognized` | Print one-line notice. Proceed. |
| `unrecognized` | **Prompt**: show the source, ask whether to install anyway, default **No**. |

- `--verified-only` (or a `finn.toml` setting) refuses anything below `trusted`.
- `--yes` accepts the prompt non-interactively.
- **Non-interactive contexts must not hang.** With no TTY and no `--yes`, an `unrecognized`
  package fails closed with a message naming the flag.
- `--ignore-regulations` and the `is_official` field on `PackageSource` both go away;
  `trust.level` replaces them.

⚠️ One item here needs your acknowledgement: I have `recognized` *not* prompting. Prompting on
it would mean every ordinary registry package raises a dialog, which is the reflexive-yes
problem again. If you want `recognized` to prompt too, say so — it's a one-line change on your
side and I'll match the docs to it.

### 2.6 The CLI needs no authentication

Every endpoint the CLI reads — §3.2 through §3.6, and §3.9 — is public and unauthenticated. The
exception is §3.10, which is not yours: those three endpoints require a browser session and answer
`401 unauthorized` without one (`router.ts:736, 794, 1327`). Registration, verification requests,
and package management are **web flows** — the publisher signs in with GitHub in a browser. There
is no `finn login`, no token in `finn.toml`, no device-code flow.

Those same three endpoints also now require proof of work (§3.12). That, too, is not yours: no
endpoint the CLI reads issues a challenge or checks for one.

The registry's docs currently document `finn login`, `finn verify`, and `finn publish`, and its
database carries unwired `auth_codes` and `api_keys` tables. **Both tables are being deleted.**
None of that is part of this contract. If CI-driven registration is wanted later it arrives as an
API key and a new conversation — but if you have any design that assumes the CLI can hold a
token, say so now rather than after the tables are gone.

### 2.7 Moderators mark packages trusted; admins verify publishers

The two signals in §2.3 are administered by two different roles, because they carry very
different weight. A **moderator** — a trusted community member — can mark an individual package
trusted: reversible, blast radius of one package, and a judgement about code they know. An
**admin** — a project maintainer — verifies publisher identity, which is an assertion that an
account really is who it claims to be, travels to everything that account ever registers, and
carries legal weight when the account is a company. Admins also grant roles, transfer names, and
handle deprecation. Moderators can escalate to an admin but cannot verify.

Nothing about this reaches you: `trust.level` is computed registry-side and remains the only
field the CLI reads (§2.4). It is documented here so that "who decided this package is trusted"
has an answer when a user asks you.

### 2.8 The register keeps minutes

Until this revision, `is_trusted` and `is_verified` were bare booleans: the register asserted that
a package was worth trusting without recording who had said so, when, or on what grounds. Every
other assertion in the system is attributable — a version names its commit, a name claim names the
repository it was proved against — and this one was not.

So there is now a `review_minutes` table, append-only, one row per reviewer act: publisher
verified, verification refused, package vouched, vouch withdrawn. It carries the reviewer, the
subject, the reason where one was required, and the time.

The booleans stay. They are the fast answer that `trust.level` is computed from, and a page that
had to reduce a history to a flag on every read would not fit the CPU budget in §3.8. The minutes
are the history. The two are allowed to disagree — D1 gives no transaction across the two writes,
so a half-failure leaves a boolean without a minute — and when they do, the boolean is the record
of effect and the minute is the record of intent. A missing minute is a visible gap that a
reviewer can close by repeating the act; a minute for an effect that never happened would be a
false record, which is why the minute is written last.

This is here for a reason beyond bookkeeping: it is the only part of the trust model that cannot
be added retroactively. A vouching UI can be built any week. History that was never written down
is gone. Everything trusted before this revision is marked in the interface as vouched before the
register kept minutes, rather than being backfilled with a guess.

---

## 3. Endpoint contract

**Base URL**: `<registry>/api`

**Registry URL precedence**, as `finn/src/registry.rs:38-41` already implements it:
`[registry].url` in `finn.toml` → `FINN_REGISTRY_URL` env → `https://finn-registry.pages.dev`.

### 3.1 Casing: snake_case on every CLI-facing response

Non-negotiable, and no longer violated. The mapping layer this section used to ask for exists:
every CLI-facing response is built in `src/app/api/[[...route]]/serializers.ts` — a §3.5 item by
`serializePackageSummary` (`:250`), a §3.2 record by `serializePackage` — so `GET /api/packages`
emits `repo_url`, `latest_version` and `is_verified`, never the camelCase Drizzle rows behind them.
Your `PackageMetadata` struct derives `Deserialize` with no `rename_all` and is right as written.
The web UI's internal camelCase is the registry's problem, not yours — with the one leak noted in
§3.10; `REGISTRY-API.md` §3.3 lists every camelCase field that survives, and where.

### 3.2 `GET /api/packages/:name` — resolve one package

**This endpoint exists** (`src/app/api/[[...route]]/router.ts:565`). It is the one your
`RegistryClient::get_package` already calls (`finn/src/registry.rs:52`), and its absence was why
`finn add <bare-name>` 404ed; it was first in the build order and is live (§6). The body below is
illustrative — `REGISTRY-API.md` §5.1 is the field-by-field reference.

Because serde ignores unknown fields by default, **your existing `PackageMetadata` struct
deserializes this response unchanged** — shipping this endpoint fixes `finn add` with zero CLI
changes. The trust fields need a struct extension only when you implement §2.5.

```json
{
  "name": "http",
  "description": "An HTTP client and server for Fin",
  "repo_url": "https://github.com/acme/fin-http",
  "homepage": null,
  "license": "MIT",
  "keywords": ["net", "http"],
  "latest_version": "1.2.0",
  "publisher": {
    "login": "acme",
    "display_name": "Acme Corp",
    "avatar_url": "https://...",
    "kind": "organization",
    "is_verified": true
  },
  "trust": {
    "level": "verified",
    "publisher_verified": true,
    "package_trusted": true,
    "repo_ownership_confirmed": true
  },
  "is_deprecated": false,
  "deprecation_message": null,
  "created_at": "2026-08-01T00:00:00Z",
  "updated_at": "2026-08-20T00:00:00Z"
}
```

- `latest_version` is `null` when the package has no version records yet. **Do not substitute a
  default.** The registry UI currently fabricates `"1.0.0"` when this is missing; that bug is
  being removed on our side and must not be reproduced on yours.
- `publisher.kind` is `"user"` or `"organization"`.
- 404 → `{ "error": "not_found", "message": "..." }`. You already map 404 to
  `RegistryError::NotFound`.

### 3.3 `GET /api/packages/:name/versions` — version records

Newest first, semver-descending.

```json
{
  "name": "http",
  "versions": [
    {
      "version": "1.2.0",
      "git_ref": "v1.2.0",
      "commit": "9f2c1ab...",
      "checksum": "sha256:...",
      "checksum_origin": "publisher_attested",
      "yanked": false,
      "published_at": "2026-08-20T00:00:00Z"
    }
  ]
}
```

`git_ref` and `commit` are what you need for a deterministic checkout, and they map directly
onto `LockedPackage { version, source, commit, checksum }` in `finn/src/lock.rs`.

On `checksum_origin` — read §4.1 before you trust this field. It is `null` exactly when
`checksum` is `null` (`serializers.ts:235`), which is **every record today**, because nothing
writes `versions.checksum` (§4.1). If a value ever appears it can only be `"publisher_attested"`:
the registry cannot compute a checksum because it never sees the code. Deserialize both as
nullable.

`yanked` means "do not select this version for a fresh resolve, but honour it if a lockfile
already pins it."

### 3.4 `GET /api/packages/:name/versions/:version` — one version record

Same object as an element of §3.3, plus `repo_url` so a version can be resolved in one request.
**Exact versions only** — no range syntax. Ranges are yours (§1).

Status codes, because the distinction matters to you:

| Situation                                                   | Status | Body                            |
| ----------------------------------------------------------- | ------ | ------------------------------- |
| `:version` is not exact — checked first, whatever the name   | `400`  | `{ "error": "invalid_version", ... }` |
| `:version` is exact, name not on the register                | `404`  | `{ "error": "not_found", ... }` |
| Name exists, that exact version has no record                | `404`  | `{ "error": "not_found", ... }` |

**The syntax check runs before the name lookup** — `isExactVersion` at `router.ts:481`, the package
read at `:491` — so a range against a name nobody ever registered is `400 invalid_version`, not
`404`. A `400` therefore says nothing about whether the package exists; only an exact version can
produce a `404`.

A non-exact version is **400, never 404**. §3.8 tells you a genuine 404 means the package does not
exist; if an unresolvable range came back as 404 you could conclude a package was gone when only
your range was unsupported. So `>=1.2` gets 400 and a name you never registered gets 404, and the
two are never confusable.

### 3.5 `GET /api/packages` — search and browse

Query parameters:

| Param    | Values                             | Notes                                     |
| -------- | ---------------------------------- | ----------------------------------------- |
| `q`      | free text                          | matches name and description              |
| `sort`   | `recent` \| `updated` \| `name`    | default `recent`                          |
| `trust`  | `verified` \| `trusted` \| `recognized` | "at least this level"; `recognized` is everything, so it is an accepted no-op |
| `limit`  | 1–100                              | default 25                                |
| `offset` | integer                            | default 0                                 |

```json
{ "total": 42, "items": [ { "name": "...", "description": "...", "latest_version": "1.2.0",
  "publisher": { "login": "acme", "is_verified": true }, "trust": { "level": "verified" },
  "is_deprecated": false, "created_at": "2026-08-01T00:00:00Z" } ] }
```

`sort=downloads` and `sort=stars` return **400 `invalid_sort`** rather than silently falling back
to the default — a sort that quietly ignores you is indistinguishable from one that worked. The
registry UI previously offered exactly those two options and they did nothing at all.

**There is no `downloads` field on any response, at any level.** Not on a record, not on an item,
not as a total. `packages.downloads` exists as a column and nothing has ever incremented it, so
publishing it would put `0` on every package in the register — which reads as "nobody uses this"
rather than "we do not measure this", and invites you to render it. Refusing to sort by a number
while still publishing it is the inconsistent position, so the field is gone. If download counting
is ever agreed (§4.2), it returns deliberately and this paragraph changes with it.

Also absent from every §3 response: `stars`, `total_downloads`, `download_count` and `category`.
Not for want of a column — `packages.downloads`, `packages.stars` and `packages.category` all
exist (`src/lib/db/schema.ts:104-106`), and `stars` and `downloads` even carry indexes
(`schema.ts:127-128`) that no query uses. The reason is that nothing *populates* `stars` or
`downloads`: an index over a column that reads the same on every row cannot rank anything, which
is why no endpoint sorts by either and `sort=stars` is a `400`. `category` is a different case —
it has a `"Utilities"` default nobody has ever chosen, so publishing it on a CLI-facing record
would dress a default up as a classification. One browser endpoint does publish it per package,
`GET /api/stats` (`router.ts:269, 310`); if you see `category` in a response you are looking at
web-UI surface, not at §3.

`trust=trusted` means *trusted or better* — it includes packages by a verified publisher. Filter
on the derived `trust.level`, not on the raw signals; see §2.4.

The envelope above is what ships: `{ total, items }`, `limit` defaulting to 25 and clamped to
1–100, `offset` defaulting to 0 (`router.ts:358-359, 458`). The bare array with a hardcoded limit
of 50 and no total is gone — that breaking change was made registry-side and is done. Out-of-range
paging values are clamped rather than refused; `REGISTRY-API.md` §5.4 is the authoritative
parameter reference.

### 3.6 `GET /api/health` — optional

`{ "status": "ok", "time": "..." }`. Useful if you want `finn healthcheck` to report registry
reachability; nothing requires it.

### 3.7 Rate limiting

**Resolved since rev 1.** Reads and writes are now budgeted separately, because a single
100-per-15-minutes ceiling across everything was tripped immediately by a `finn sync` over a
large dependency graph or by any CI runner behind a shared egress IP.

| Bucket                                   | Ceiling                    |
| ---------------------------------------- | -------------------------- |
| Reads (everything the CLI calls)         | 1000 per 15 min per IP     |
| Writes (browser session endpoints)       | 100 per 15 min per IP      |
| Registration                             | 30 per 15 min per IP       |
| OAuth start (two requests per sign-in)   | 20 per 5 min per IP        |
| OAuth callback                           | 10 per 5 min per IP        |
| Proof-of-work challenges (§3.12)         | 120 per 5 min per IP       |

Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`
(reset is a Unix timestamp in seconds). A `429` adds `Retry-After` in seconds. **Read
`Retry-After` rather than guessing** — it is exact, and the window is fixed rather than sliding,
so a wait that long always succeeds.

Two caveats you should design around:

1. **The ceiling is per isolate, not global.** The counter lives in Worker memory, so two
   requests routed to different isolates count against different budgets. In practice this makes
   the effective limit *higher* and less predictable than the table — never lower. Do not treat
   a successful burst as evidence the limit is not enforced.

2. **The hard limit is the platform's, not ours.** The free tier allows 100,000 requests/day
   across the whole registry for all users combined (§3.8). Our per-IP ceilings exist to stop one
   caller consuming that. Sequential requests with backoff cost you a few seconds; a burst that
   exhausts the daily allowance takes the registry down for everyone.

CLI side: please handle `429` with backoff. `reqwest-retry` and `reqwest-middleware` are already
in your `Cargo.toml` but `registry.rs` builds a plain `Client` and uses neither.

### 3.8 The registry runs on a free tier, and it shapes the API

The registry deploys to Cloudflare Workers (via `@opennextjs/cloudflare`) with a D1 database, on
the free plan. This is a deliberate consequence of §1: because we host no package bytes, there is
no storage cost, and the whole service fits in an allowance of 100,000 requests/day, 5 million D1
rows read/day, and **10 ms of CPU per request**.

Three things follow that affect you:

1. **Responses stay lean and are never computed by scanning tables.** If you ask for something
   that would require the registry to aggregate across all packages, expect it to be paginated or
   refused rather than slow. Don't design a flow that needs "all packages" in one call — use
   §3.5 with `limit`/`offset`.

2. **Batch where you can, but do not parallelise aggressively.** A `finn sync` over a large
   dependency graph is the heaviest thing that will ever hit this API. Sequential requests with
   backoff are strictly better than a burst that trips the rate limit and fails the whole sync.
   If §3.5-style batch resolution (many names in one request) would materially reduce your call
   count, ask for it and I'll add it — that is a cheaper conversation than either of us
   optimising around the limit separately.

3. **Daily allowances reset at 00:00 UTC and exceeding them returns errors, not slow
   responses.** Treat a `5xx` from the registry as retryable-with-backoff and never as "package
   does not exist" — only a genuine `404` means that. Your current code correctly distinguishes
   404 from other failures; keep that.

None of this is a near-term constraint at the current scale. It is written down so that neither
of us designs something that only works on a paid plan.

### 3.9 `GET /api/publishers/:login` — not for you, documented so it doesn't surprise you

This one exists for the website's publisher profile page. The CLI has no reason to call it, and
nothing in `finn` should start depending on it — it is listed here only so you don't discover an
undocumented endpoint later and wonder whether you were meant to use it.

```json
{
  "publisher": { "login": "acme", "display_name": "Acme Corp", "avatar_url": "https://...",
    "kind": "organization", "is_verified": true, "created_at": "2026-08-01T00:00:00Z" },
  "total": 3,
  "items": [ /* the same item shape as §3.5 */ ]
}
```

It pages, with the same clamping as §3.5 but a different default: `limit` defaults to **100**,
not 25, and is clamped to 1–100; `offset` defaults to 0 (`router.ts:602-603`). A profile is a
publisher's whole shelf rather than a page of search results, which is why its default is the
maximum. `REGISTRY-API.md` §6.3 has the table.

`404` when the login has registered nothing. Per the glossary a publisher *is* an account that
registered a package, so "has an account but has claimed no names" is genuinely not a publisher
and correctly 404s here.

It reports no download or star totals, for the reason given in §3.5.

### 3.10 Registration endpoints — browser-only, and deliberately not yours

Registration happens in a browser, by a signed-in human, at `/new`. Two endpoints back it:

- `POST /api/registrations/check` → `{ repo_url }` ⇒
  `{ push_access, needs_scope, repo: { full_name, description, homepage, license, default_branch } | null, reason }`.
  Checks §2.2 push access against the GitHub API using the signed-in user's token. `needs_scope`
  is `true` when the session was created with only `user:email` and the wider scope has not been
  granted yet — the UI then sends the user through incremental authorization.
- `POST /api/packages` → `{ name, repo_url, description?, homepage? }` ⇒ `201` with the §3.2
  record. Re-checks push access server-side; never trusts the check call. **`license` is not a
  field of this request.** It is always whatever GitHub reports for the repository
  (`router.ts:886`), and deliberately so: a licence is a legal statement about someone's code and
  the registry will not repeat an unverified claim about one. A `license` in the body is ignored,
  not honoured. `description` and `homepage` *are* read, and fall back to GitHub's values when
  omitted (`router.ts:878, 881`).

One more, on the same footing:

- `POST /api/me/verification-request` → `{ note? }` ⇒ `201 { request: { status: "pending",
  createdAt } }` — `createdAt`, camelCase (`router.ts:1392`), which is an inconsistency with §3.1
  rather than a contract; it is tolerated only because this endpoint is browser-only and nothing in
  `finn` reads it. How a signed-in publisher asks an admin to verify them (§2.3). `note` is the
  evidence the account submits for who it claims to be, up to 1000 characters; over that is a
  refusal (`invalid_note`), not a truncation, because silently cutting somebody's evidence in half
  is worse than telling them it was too long. `409 already_verified` if the account already is;
  `409 request_pending` if one is already in the queue. A previously *refused* account may ask
  again, so a `rejected` request never blocks a new one.

**The CLI must not call these, and `finn publish` must not exist.** This is the concrete form of
§2.6: registration requires a browser session and a GitHub OAuth grant, so there is nothing here
for a CLI to authenticate against. If `finn` ever needs to record a *release* against an
already-registered name, that is a separate conversation and a separate endpoint — it is listed
in §4 as undecided, not implied by these two.

Name availability needs no endpoint: `GET /api/packages/:name` returning `404` *is* the answer.

### 3.11 Error codes, in full

Every error response is `{ "error": "<code>", "message": "<human sentence>" }`. Branch on `error`;
`message` is written for a person and may be reworded at any time. Below is every code the
registry emits; `REGISTRY-API.md` §8 is the authoritative copy, and lists which endpoints raise
each one:

| Code               | Status | When                                                             |
| ------------------ | ------ | ---------------------------------------------------------------- |
| `not_found`        | 404    | The name is not on the register, or that exact version has no record |
| `internal_error`   | 500    | A database read failed. **Every §3 handler that reads the database returns it** — all of them but §3.6 (`router.ts:114-116`, called at `:332, :461, :518, :549, :577, :617`) |
| `invalid_version`  | 400    | A version that is not exact — a range, a partial, or junk (§3.4)  |
| `invalid_sort`     | 400    | A `sort` value outside `recent` \| `updated` \| `name`            |
| `invalid_trust`    | 400    | A `trust` value outside `verified` \| `trusted` \| `recognized`    |
| `rate_limited`     | 429    | §3.7. Carries `Retry-After`, plus `retryAfter` in the body        |
| `invalid_request`  | 400    | A §3.10 request body that is not JSON (`router.ts:741, 799`)     |
| `invalid_name`     | 400    | A package name failing the §2.1 grammar                          |
| `invalid_repo_url` | 400    | A `repo_url` that is not a GitHub repository URL                 |
| `name_taken`       | 409    | Registration, name already claimed                               |
| `unauthorized`     | 401    | A browser-session endpoint called without a session              |
| `scope_required`   | 403    | Registration where the session's token cannot *see* repository permissions, so the UI re-authorizes (`router.ts:848`) |
| `push_access_denied` | 403  | Registration where GitHub says the account cannot push to the repository (§2.2) |
| `invalid_note`     | 400    | A verification-request note over 1000 characters (§3.10)         |
| `already_verified` | 409    | A verification request from an already-verified account          |
| `request_pending`  | 409    | A verification request while one is already in the queue         |
| `captcha_required` | 428    | A §3.10 request with no valid proof of work (§3.12)              |
| `invalid_scope`    | 400    | A `scope` outside `register` \| `register-check` \| `verify-request` on `GET /api/captcha` |

The two `403`s are refusals on the merits rather than malformed requests, which is why neither is a
`400`: `push_access_denied` is GitHub saying the account cannot push to the repository (§2.2), and
`scope_required` is the token not being able to see permissions well enough to tell.

**`internal_error` is the one code here that is yours.** It is not browser-only: every CLI-facing
handler wraps its database read and answers `500 internal_error` when that throws, so a `finn` that
only ever reads §3.2–§3.5 and §3.9 will meet it eventually. Retry it with backoff and never read it
as "the package does not exist" (§3.8) — that is the distinction a lockfile depends on.

Eleven codes the CLI will never legitimately see, listed so an unexpected one is recognisable rather
than mysterious: `invalid_request`, `invalid_name`, `invalid_repo_url`, `name_taken`,
`scope_required` and `push_access_denied` belong to the browser registration flow, and
`invalid_note`, `already_verified` and `request_pending` to the verification request — all of §3.10,
whose `unauthorized` you will not see either, for the same reason. `captcha_required` and
`invalid_scope` belong to §3.12, which guards those same endpoints. If `finn` receives any of them,
it called an endpoint it should not have.

### 3.12 Proof of work on the browser writes — also not yours

The three endpoints in §3.10 and the sign-in redirect require the caller to have spent some CPU
before they will act. `GET /api/captcha?scope=…` issues a signed challenge; the browser finds a
`nonce` whose `SHA-256("<salt>.<nonce>")` starts with 13–15 zero bits and sends it back in an
`x-finn-captcha` header. Without a valid one the answer is `428 captcha_required`. The exact wire
format is in `REGISTRY-API.md` §7.4.

**The CLI is not affected and must not implement any of this.** §3.2–§3.6 and §3.9 do not look at
the header, do not issue challenges, and cannot return `428`. There is a test that fails if that
ever stops being true (`tests/captcha.test.ts`, "does not gate the reads the CLI depends on"),
precisely so this promise does not quietly rot.

Why it exists: every §3.10 endpoint already requires a GitHub session, so this is not about telling
humans from scripts — a script with a valid session is a signed-in human's script. It is about the
*cost* of bulk submission. Filing ten thousand verification requests, or claiming a thousand names,
previously cost an attacker nothing but HTTP; now each attempt costs about 2^15 hashes while
verifying one costs the registry a single HMAC. It sits on top of the session check and the §3.7
rate limits rather than replacing either.

Deliberately not a third-party captcha: no API key, no account with anybody, no script from another
origin, nothing sent about the reader to a service we do not run. That also means it makes no claim
to stop a determined attacker — native code hashes far faster than a phone browser. It raises a
floor; it is not a wall.

---

## 4. OPEN — not decided, your input wanted

### 4.1 What a registry checksum can honestly mean

`versions.checksum` exists in the registry schema and nothing writes it. The deeper problem:
the registry cannot compute one. It never receives package bytes, and it runs on Cloudflare
Workers where it cannot clone a repository.

Meanwhile your side computes `integrity::calculate_package_hash` over the *installed directory*
and stores it in `finn.lock`, so today integrity is trust-on-first-use: the lockfile only
catches drift after the first install.

The only way the registry can carry a checksum is if the **publisher's CLI computes and submits
it at registration**, which makes it publisher-attested — it proves the contents haven't changed
since registration, not that they're what the publisher intended. That is still worth having
(it upgrades trust-on-first-use to trust-from-registry for every user after the first), but it
is weaker than it sounds and must be labelled as such wherever it's shown, hence
`checksum_origin`.

Questions for you: is a publisher-attested checksum worth the submission step? And does
`calculate_package_hash` produce a value that is stable across a fresh clone — does it hash
`.git`, or ignore-file-dependent content? If it isn't reproducible from a clean checkout, the
field is useless and should be dropped from §3.3.

### 4.2 Download counts

**Decided for now, still open for you.** The registry cannot observe a download, because GitHub
serves the bytes. Nothing has ever incremented `packages.downloads`, and it was nonetheless the
default sort key and the headline number on the front page — so the registry sorted by, and
advertised, zero.

Taken registry-side: option (b). The metric is gone from every response and every screen, ordering
is by recency, update time or name, and `sort=downloads` is a `400` rather than a silent fallback
(§3.5). The column stays in the schema, unpublished, so that reversing this is a decision rather
than a migration.

What is still yours: whether the CLI should ever report installs at all. The version worth
considering is a fire-and-forget `POST /api/packages/:name/installs` after a successful install —
best-effort, unauthenticated, never blocking. Two things make it a real decision rather than a
feature: it is trivially inflatable, so the number would be a popularity signal that anyone can
forge; and it sends usage data your users do not currently send, which is a privacy-relevant change
in behaviour and must not arrive as a side effect of a UI sort order. If it happens it should be
opt-in and announced.

The alternative worth naming: show GitHub stars, fetched by the reader's browser from GitHub,
attributed to GitHub, and never called downloads. That costs the registry nothing, cannot be
inflated by the CLI, and is honest about whose number it is. It also means the register itself
stores no popularity data, which is consistent with §1.

### 4.3 Should attribution reach the CLI?

**New, and genuinely yours to decide.** §2.8 means the registry can now answer "who vouched for
this package, and when". Nothing on the wire carries that answer, because `trust.level` is
deliberately the only field you branch on (§2.4) and adding attribution to it would invite you to
branch on the reviewer instead of the level.

The case for sending it anyway is the §2.5 prompt. When `finn` stops and asks a user whether to
install something that is merely *recognized*, the most useful sentence it could print is not
"this package is recognized" but something closer to who has and has not looked at it. A user
deciding in a terminal has no other way to find that out.

The case against: the moment a reviewer login appears in CLI output it becomes a thing to
impersonate and a thing to argue with, and every reviewer becomes personally addressable for a
judgement the project made. A date is much cheaper than a name — "vouched for eight months ago"
answers the user's real question, which is *has anyone looked at this recently*, without pointing
at a person.

What the registry would like from you: whether the §2.5 prompt would actually use either field. If
the answer is no, this stays internal and §3 does not grow. If it is yes, say which — a date alone,
or a date and a login — and it goes on the `trust` object as an optional field rather than as a new
endpoint. The registry will not add attribution to the wire speculatively; unread fields in a
contract are a liability for both sides.

---

## 5. Bugs found in `finn` while writing this

Reported as found; all in `finn`, none blocking the registry work.

1. **`add.rs:203` — registry lookup uses the wrong variable.** `client.get_package(input)` is
   passed the raw input *including* `@version`, while every other branch uses `base_input`. Any
   registry lookup with an explicit version requests `http@1.2.0` as a literal name and 404s.

2. **Same line — the requested version is discarded.** The returned `PackageSource` takes
   `version: metadata.latest_version`, throwing away the version the user asked for. Combined
   with (1), `finn add http@1.0.0` cannot work against the registry.

3. **`registry.rs` has no retry or backoff** despite `reqwest-retry` and `reqwest-middleware`
   being dependencies. See §3.7.

4. **User-Agent disagrees with the crate version** — `registry.rs:53` sends `finn-cli/0.5.0`,
   `Cargo.toml` says `0.4.0`.

5. **`install.rs:33` invokes the compiler as a Python script**
   (`Command::new("python").arg(compiler)`), which targets `~/Fin/pyprototype` rather than
   `finc`. Presumably deliberate for now, but it means `finn install` cannot work against a
   released compiler.

6. **`README.md` documents `finn check`**, which is not a subcommand — `main.rs:52-82` has
   `Healthcheck`. The registry's docs additionally document `finn login`, `finn verify`, and
   `finn publish`; per §2.6 those are not planned, and I am deleting them from our docs.

7. **`DEFAULT_REGISTRY` points at the wrong host.** `finn` ships
   `https://finn-registry.pages.dev`, a Cloudflare **Pages** URL. The registry deploys to
   Cloudflare **Workers** (ADR-0005), because Pages has no D1 binding and every endpoint in §3 is
   a database read. A Pages host would serve the static pages and 404 every API route. The hostname
   is not settled yet on our side — treat it as a value to make configurable rather than one to
   correct to a different literal, and we will send you the final one before either side ships.

8. **`add.rs:204` sets `is_official: true`** for anything resolved from the registry. There is no
   such property. Being on the register means a name claim was proved against a repository (§2.2)
   — the floor, not a distinction — and the field as written would mark every `recognized` package
   as official. `trust.level` is the only field that carries this (§2.4). `official` is also a word
   the glossary bans outright, for both of us: it implies an endorsement by the Finn project of
   code the Finn project has never read.

---

## 6. Status on the registry side

Rev 1 listed this as a build order. All seven steps are now written, so it is a status list
instead — but "Live" means written, not covered: the test suite reaches most of §3 and almost none
of the browser-session surface. What is and is not covered is spelled out under the table.

| Step                                                   | State                              |
| ------------------------------------------------------ | ---------------------------------- |
| `GET /api/packages/:name` (§3.2)                       | Live                               |
| Read-endpoint rate limit raised (§3.7)                 | Live                               |
| Registration with the push-access gate (§2.2)          | Live                               |
| Version records, so `latest_version` resolves          | **Not built — see below**          |
| `GET /api/packages/:name/versions` (§3.3) and §3.4     | Live                               |
| Verification requests (§3.10) plus the reviewers’ bench (§2.7) | Live, untested          |
| `trust` on every response (§2.4)                       | Live — §2.5 is yours              |
| Search envelope (§3.5)                                 | Live                               |

**Correction to an earlier revision of this table.** Up to rev 5 the registration row also claimed
version records. It was wrong, and `REGISTRY-API.md` §10.1 was right: **nothing in this codebase
has ever written to the `versions` table** — not a route, not a server action, not a script. So
`latest_version` is `null` on every package, §3.3 returns an empty array, and §3.4 404s for every
version of every package. Treat all three as the normal case. Your reply's ask 5 (a
version-existence answer) is blocked on this, not on the route, which exists and 404s distinctly
already. How version records come to be written is now the largest open question between the two
projects; it is stated as such in `Sync.md` §3.2, because your `LockedPackage` already holds
exactly the four fields a version record needs and you will never hold a credential to submit
them with.

**What the test suite covers** (`tests/`): dedicated suites for `trust.level` derivation (§2.4),
§3.6 health, §3.2 resolve, §3.3 and §3.4 version records, §3.5 search and browse, §3.9 publisher
profiles, and both registration endpoints of §3.10 including their `401`s — plus a permanent
regression suite asserting that no endpoint invents a `1.0.0` version.

**What it does not.** `POST /api/me/verification-request` has no test at all. Neither
`GET /api/stats`, `/api/dashboard/data`, `/api/me/settings` nor the OAuth sign-in flow has a
behavioural test; the first three are only swept by the no-fabricated-version regression, which
checks one string and nothing else. All of that is browser-only surface, so none of it weakens what
§3 promises you — but it is why the verification-request row above says untested.

**What "live" does not mean.** It means implemented, typechecked, and — for everything in the
covered list above — covered by the test suite, which drives the real Hono router in Node against a
temporary SQLite file. It does **not** mean exercised on the deploy runtime: of §3, only
`/api/health`, `/api/packages` and a `404` on an unregistered name have been served from `workerd`
with a D1 binding, and that against an empty register (§3.8). It does not mean deployed. Nothing
is deployed yet: `wrangler.jsonc` still carries a placeholder D1 database id, the generated
migrations have never been applied to a remote database, and the hostname is unsettled (§5.7). So
do not point `finn` at a URL and expect an answer — ask us for the host when you are ready to
integrate, and we will tell you whether it is answering.

The two things still waiting on you: §2.5, the `recognized` prompt, which is the only thing that
blocks the trust model being end-to-end; and §4.3, whether the CLI wants attribution at all. §4.1
(what a checksum can honestly mean) is still open and still hinges on one answer — whether
`calculate_package_hash` is reproducible from a clean clone.
