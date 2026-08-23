# Finn Registry — API reference

**Audience:** agents and developers building a client against this registry —
principally the `finn` CLI, but the surface is public and anything may read it.

**Status:** describes the code as it stands in this repository. Every shape,
status code and default below was read out of the handlers, not out of a design
document, and the CLI-facing endpoints have been exercised against a real
Cloudflare Worker (see [Verifying against a running instance](#11-verifying-against-a-running-instance)).

**This is not the contract.** [`REGISTRY-CONTRACT.md`](./REGISTRY-CONTRACT.md) is
the negotiation record: it argues *why* the API is shaped this way, carries open
questions, and proposes things that are not built. This file only says what is
there and how to call it. Where the two disagree, this file is right about
behaviour and the contract is right about intent — and the disagreement is a bug
in one of them worth reporting.

---

## Table of contents

1. [What the registry is](#1-what-the-registry-is)
2. [The objects](#2-the-objects)
3. [Calling conventions](#3-calling-conventions)
4. [Trust](#4-trust)
5. [Endpoints for a package manager](#5-endpoints-for-a-package-manager)
6. [Endpoints for the web UI](#6-endpoints-for-the-web-ui)
7. [Endpoints that require a browser session](#7-endpoints-that-require-a-browser-session)
8. [Error catalogue](#8-error-catalogue)
9. [Rate limits](#9-rate-limits)
10. [What does not exist yet](#10-what-does-not-exist-yet)
11. [Verifying against a running instance](#11-verifying-against-a-running-instance)

---

## 1. What the registry is

A **trust and attribution layer over GitHub**. It records that a name belongs to
a repository, and who stands behind it. It does not store, serve, proxy or
rewrite a single byte of anyone's code.

```
     finn (CLI)                 finn-registry                 GitHub
         │                            │                          │
         │  GET /api/packages/left-pad│                          │
         ├───────────────────────────► │                          │
         │  { repo_url, trust, … }    │                          │
         │ ◄───────────────────────────┤                          │
         │                            │                          │
         │  git fetch / tarball        │                          │
         ├────────────────────────────────────────────────────────►│
         │  the actual code            │                          │
         │ ◄────────────────────────────────────────────────────────┤
```

The consequences are the whole design, so they are worth stating flatly:

| The registry does | The registry does not |
|---|---|
| Map a bare name to a repository URL | Host, cache, or mirror package contents |
| Record who claimed the name, and whether an admin verified them | Serve tarballs, or know when one is downloaded |
| Record version records that point at git refs and commits | Create releases, tag repositories, or publish |
| Publish one derived `trust.level` per package | Decide whether an install proceeds — the CLI does |
| Refuse a name claim without proven push access to the repo | Compute or verify a checksum of anyone's code |

Because nothing is served, there is **no download count anywhere in this API**,
and there never will be one that is silently zero. Ordering by a number that is
identical for every row looks like a ranking and is not one; `sort=downloads`
and `sort=stars` are rejected rather than accepted-and-ignored.

### Actors

| Actor | Gets | How |
|---|---|---|
| Anyone | Read every endpoint in §5 and §6 | No credentials at all |
| Signed-in account | Claim names, request verification, edit own settings | GitHub OAuth, cookie session |
| Publisher | An account that has registered ≥ 1 package | Consequence of claiming, not a role |
| Moderator | Mark one package `trusted` | Granted by an admin |
| Admin | Verify a publisher's identity | Maintainers |

"Publisher" is defined by having claimed something. An account that signed in
once and claimed nothing is not a publisher and `GET /api/publishers/:login`
returns 404 for it.

---

## 2. The objects

### 2.1 Package record

The full record, returned by `GET /api/packages/:name`.

```json
{
  "name": "left-pad",
  "description": "Pads a string on the left.",
  "repo_url": "https://github.com/acme/left-pad",
  "homepage": null,
  "license": "MIT",
  "keywords": ["string", "padding"],
  "latest_version": "1.4.2",
  "publisher": {
    "login": "acme",
    "display_name": "Acme, Inc.",
    "avatar_url": "https://avatars.githubusercontent.com/u/1",
    "kind": "organization",
    "is_verified": true
  },
  "trust": {
    "level": "verified",
    "publisher_verified": true,
    "package_trusted": false,
    "repo_ownership_confirmed": true
  },
  "is_deprecated": false,
  "deprecation_message": null,
  "created_at": "2026-08-01T00:00:00Z",
  "updated_at": "2026-08-12T09:31:04Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | Bare, globally unique, lowercase. Never contains `/`. |
| `description` | `string \| null` | Publisher's, else GitHub's at registration time. |
| `repo_url` | `string` | Canonical `https://github.com/owner/repo`. **This is what you fetch from.** |
| `homepage` | `string \| null` | |
| `license` | `string \| null` | GitHub's SPDX id for the repo. Never what the claimant typed — see §7.2. |
| `keywords` | `string[]` | Always an array; a malformed stored value degrades to `[]`. |
| `latest_version` | `string \| null` | **`null` when no version is recorded — and also when every recorded version is yanked.** Never a fabricated `1.0.0`. |
| `publisher` | object | See below. |
| `trust` | object | See [§4](#4-trust). |
| `is_deprecated` | `boolean` | The name was withdrawn. Still resolvable. |
| `deprecation_message` | `string \| null` | |
| `created_at` | `string` | ISO-8601 UTC. `""` if unknown — never invented. |
| `updated_at` | `string` | Falls back to `created_at`. |

**`latest_version` is the field most likely to break a client.** It is `null`
for every package that has claimed a name but recorded no version — which today
is *all of them*, because no write path for version records exists ([§10](#10-what-does-not-exist-yet)).
Do not default it to `"1.0.0"`, `"0.0.0"`, or `"latest"`. If your resolver needs
a version and the field is `null`, that package cannot be resolved by version and
the honest report is "no released version recorded", not a guess.

### 2.2 Publisher

```json
{
  "login": "acme",
  "display_name": "Acme, Inc.",
  "avatar_url": "https://avatars.githubusercontent.com/u/1",
  "kind": "organization",
  "is_verified": true
}
```

`kind` is `"user"` or `"organization"`. When a package was registered under an
organisation, `login` is the **organisation's** name, but `is_verified` stays the
signal for the *account* that registered it — an admin reviewed a person, not a
namespace.

### 2.3 Version record

```json
{
  "version": "1.4.2",
  "git_ref": "v1.4.2",
  "commit": "9f2c1ab4e0d3c7a1b5e8f2049d6c3a7b1e5f8021",
  "checksum": null,
  "checksum_origin": null,
  "yanked": false,
  "published_at": "2026-08-12T09:31:04Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `version` | `string` | Exact semver, no leading `v`. |
| `git_ref` | `string` | The tag or ref in the repository. May carry a leading `v`. |
| `commit` | `string` | The commit the ref pointed at when recorded. |
| `checksum` | `string \| null` | Publisher-asserted, or `null`. |
| `checksum_origin` | `"publisher_attested" \| null` | `null` exactly when `checksum` is `null`. |
| `yanked` | `boolean` | Withdrawn, but still listed and still resolvable. |
| `published_at` | `string` | ISO-8601 UTC, or `""`. |

`checksum_origin` has one possible non-null value on purpose. The registry never
sees the code, so it can never compute a checksum; anything it stores was
asserted by the publisher, and the field exists so that a client can never
mistake an assertion for verification. **A `checksum` here is not evidence the
bytes are intact** — it is evidence of what the publisher claimed they would be.

`yanked` records are returned by the versions list so a lockfile that already
pins one can still be honoured. They are excluded only from `latest_version`.

### 2.4 Package summary

The list element in `GET /api/packages` and `GET /api/publishers/:login`.
Deliberately smaller than a full record — it is not a substitute for one.

```json
{
  "name": "left-pad",
  "description": "Pads a string on the left.",
  "latest_version": "1.4.2",
  "publisher": { "login": "acme", "is_verified": true },
  "trust": { "level": "verified" },
  "is_deprecated": false,
  "created_at": "2026-08-01T00:00:00Z"
}
```

Note `publisher` and `trust` are *narrowed* objects, not the full ones. If you
need `repo_url`, you need `GET /api/packages/:name`; the summary has no
repository URL and cannot be used to fetch anything.

---

## 3. Calling conventions

### 3.1 Base URL

Every route below is mounted under **`/api`** on the registry host.

> **Unresolved, and it will break your client:** `finn` currently ships
> `DEFAULT_REGISTRY = "https://finn-registry.pages.dev"`. That is a Cloudflare
> **Pages** hostname, and this registry deploys as a Cloudflare **Worker**
> (`@opennextjs/cloudflare` + `wrangler`, ADR-0005). A Pages URL will not serve
> these routes — every call 404s. The real hostname is not settled yet.
>
> **Do not hard-code a default you cannot verify.** `finn` already reads an
> override — a constructor argument, else the `FINN_REGISTRY_URL` environment
> variable, else the baked-in default — so pointing it at a working host is a
> configuration change today. Keep it that way, and fail with a message that names
> the URL it tried. A wrong baked-in default produces "package not found" for
> every package, which is the single most misleading failure this API can hand a
> user.

### 3.2 Authentication

**The CLI never authenticates.** Every endpoint in [§5](#5-endpoints-for-a-package-manager)
and [§6](#6-endpoints-for-the-web-ui) is public and unauthenticated. Do not send
an `Authorization` header; nothing reads one, and no proof-of-work header either
([§7.4](#74-proof-of-work-on-the-browser-writes) applies to browser writes only).

Reading is public because a registry that requires a token to resolve a name has
made itself a chokepoint on builds. The authenticated endpoints ([§7](#7-endpoints-that-require-a-browser-session))
exist for the website and use a cookie session, which a CLI has no way to obtain
and no reason to want.

### 3.3 Casing

**snake_case on every CLI-facing response.** This is part of the interface, not a
style preference: `finn`'s `PackageMetadata` derives `Deserialize` with no
`rename_all`, so a camelCase field does not arrive at all — it silently
deserialises as absent.

The guarantee covers everything in [§5](#5-endpoints-for-a-package-manager) and
`GET /api/publishers/:login`, which share one serializer module — the single
chokepoint every contracted response passes through.

Three places are camelCase, none of them for a CLI, each flagged where it appears:

- `GET /api/stats` ([§6.1](#61-get-apistats--front-page-figures)) — camelCase throughout.
- The `retryAfter` field in a 429 body ([§9.3](#93-the-429-body)) — an
  inconsistency, so prefer the `Retry-After` header.
- The browser-session endpoints in [§7](#7-endpoints-that-require-a-browser-session),
  which are camelCase or mixed and are not contracted at all.

If you find a camelCase field in §5, that is a bug — report it.

### 3.4 Timestamps

ISO-8601, UTC, `Z`-suffixed, no sub-second component: `"2026-08-12T09:31:04Z"`.

An absent or unparseable timestamp serialises as the **empty string** `""`, not
`null` and never a substituted date. Treat `""` as "unknown"; a wrong timestamp
is worse than a visibly missing one.

(Internally the store is SQLite, whose `CURRENT_TIMESTAMP` writes
`"2026-08-12 09:31:04"` — UTC, but with no `T` and no zone. That is rewritten on
the way out rather than parsed, because handing it to a `Date` constructor
interprets it as local time and shifts every timestamp the registry publishes.)

### 3.5 Response envelopes

There are exactly two shapes, and which one you get is not arbitrary:

- **A single record is the body.** `GET /api/packages/:name` returns the package
  record at the top level. There is no `{ "package": … }` wrapper.
- **A collection is `{ total, items }`.** `total` is a `COUNT` over the whole
  matching set, not `items.length`, so it stays correct under `limit`.

### 3.6 Content type, CORS, caching

| | |
|---|---|
| Request body | `application/json` on the two `POST`s. Reads take no body. |
| Response body | `application/json` on every documented route. |
| CORS | **No CORS headers are sent.** Browser-based cross-origin clients will be blocked. A CLI is unaffected. |
| `Cache-Control` | **Not set.** Nothing is declared cacheable or uncacheable. |
| `ETag` / `If-None-Match` | **Not implemented.** Conditional requests are not supported. |

The absence of caching headers is a gap, not a statement that responses are
volatile. Until it is closed, do your own caching client-side and pick your own
TTL — and see [§9](#9-rate-limits) for why you should.

### 3.7 Unknown routes behave differently from known ones

An unrecognised path — or an unsupported method on a recognised path — falls
through to Hono's built-in handler, which returns **`404` with the plain-text
body `404 Not Found`**, not the JSON error envelope every documented failure
uses.

**So a `404` is not reliably JSON.** Guard your deserialisation: parse the body
only after confirming a JSON content type, and treat a parse failure on a 404 as
"no such route" rather than crashing. This is a known defect ([§10](#10-what-does-not-exist-yet)),
and when it is fixed the envelope will become consistent — code that already
guards will keep working either way.

---

## 4. Trust

The registry publishes **one derived level** plus the raw signals it came from.

```
publisher_verified && repo_ownership_confirmed   →  "verified"
package_trusted                                  →  "trusted"
otherwise                                        →  "recognized"
```

| Level | Means | What a CLI should do |
|---|---|---|
| `verified` | An admin confirmed the publisher's identity, and repository ownership is proven. | Proceed. |
| `trusted` | A moderator vouched for **this one package** on its merits. The publisher is not (yet) verified. | Proceed. |
| `recognized` | Registered, with proven repository ownership, and nothing further. | **Proceed. This is the ordinary case.** |

### 4.1 Branch on `level`, never on the signals

`trust.publisher_verified`, `trust.package_trusted` and
`trust.repo_ownership_confirmed` are returned **for display only**. Branch on
`level` alone. That is what lets the registry add a fourth signal later without
changing — or breaking — your client.

### 4.2 `recognized` is the floor, not a warning

Everything on the register is at least `recognized`: a name cannot be claimed
without proving push access to the repository it points at, so the floor already
carries a real assertion. **`recognized` must not produce a prompt, a warning, or
a delay.** If it does, the registry has trained users to click through the one
signal that is supposed to mean something, and the prompts that matter stop
working.

There is no `unverified`, `untrusted`, or `unknown` level. `unrecognized` is a
**CLI-side** state for a source the registry has never seen — a raw Git URL,
GitHub shorthand, a local path — and the registry never returns it, because it
has nothing to say about those.

### 4.3 A package is never *verified*; a publisher is never *trusted*

The two signals are orthogonal and the vocabulary is load-bearing:
*verification* is about an identity and travels to everything that account
registers; *trust* is about one package on its own merits and deliberately does
not require a verified publisher. Keep the words apart in your user-facing
strings — a package that says "verified" is claiming something nobody checked.

---

## 5. Endpoints for a package manager

These five are the whole CLI surface. All public, all `GET`, all unauthenticated,
and none of them asks for the proof of work the browser forms carry ([§7.4](#74-proof-of-work-on-the-browser-writes)).

### 5.1 `GET /api/packages/:name` — resolve one package

The endpoint `finn add <bare-name>` needs. Returns the [package record](#21-package-record)
as the body, no envelope.

```http
GET /api/packages/left-pad
```

`:name` is a **single path segment**. A name is bare and globally unique; a
slash always means GitHub to `finn` and so can never be a registry name. The
single-segment route parameter enforces that for free — `GET /api/packages/acme/left-pad`
does not match this route and falls through to §3.7's plain-text 404.

| Status | Body | When |
|---|---|---|
| `200` | [Package record](#21-package-record) | Found. |
| `404` | `{"error":"not_found","message":"No package named \"x\" is registered."}` | Not on the register. |
| `500` | `{"error":"internal_error","message":"Could not resolve the package."}` | Query failed. **Retryable.** |

**A `500` is not "no such package".** Treat it as retryable with backoff and
never cache it as absence — a registry outage that reads as "your dependency
does not exist" turns a transient failure into a wrong lockfile.

### 5.2 `GET /api/packages/:name/versions` — every version record

```http
GET /api/packages/left-pad/versions
```

```json
{
  "name": "left-pad",
  "versions": [
    { "version": "1.4.2", "git_ref": "v1.4.2", "commit": "9f2c1ab…", "checksum": null,
      "checksum_origin": null, "yanked": false, "published_at": "2026-08-12T09:31:04Z" },
    { "version": "1.4.1", "git_ref": "v1.4.1", "commit": "3ba77de…", "checksum": null,
      "checksum_origin": null, "yanked": true,  "published_at": "2026-07-02T11:04:55Z" }
  ]
}
```

Ordered **semver-descending**, newest first — not `published_at`-descending,
which puts a backfilled `1.9.0` above `1.10.0`, and not string order, which does
the same thing outright. Prerelease precedence follows semver.org §11, so
`1.4.2-rc.1` sorts below `1.4.2`.

**Yanked records are included**, carrying `yanked: true`. That is deliberate: a
lockfile that already pins a yanked version can still be honoured. Exclude them
yourself when choosing something *new*; do not treat their presence as a bug.

`versions` is `[]` for a registered name with nothing recorded — which is the
normal state today ([§10](#10-what-does-not-exist-yet)). An empty array is not an error.

| Status | Body | When |
|---|---|---|
| `200` | `{ name, versions }` | Found; `versions` may be `[]`. |
| `404` | `{"error":"not_found", …}` | Name not on the register. |
| `500` | `{"error":"internal_error","message":"Could not read version records."}` | Retryable. |

### 5.3 `GET /api/packages/:name/versions/:version` — one exact version

```http
GET /api/packages/left-pad/versions/1.4.2
```

Returns a [version record](#23-version-record) **plus `repo_url`**, flattened into
the same object, so that resolving a pinned dependency to something fetchable is
one request rather than two:

```json
{
  "version": "1.4.2",
  "git_ref": "v1.4.2",
  "commit": "9f2c1ab4e0d3c7a1b5e8f2049d6c3a7b1e5f8021",
  "checksum": null,
  "checksum_origin": null,
  "yanked": false,
  "published_at": "2026-08-12T09:31:04Z",
  "repo_url": "https://github.com/acme/left-pad"
}
```

**Exact versions only.** `^1.0.0`, `1.x`, `>=1.0.0 <2.0.0`, `v1.2.0` and `latest`
are all refused with `400 invalid_version`. Range resolution is the CLI's job —
it belongs next to the lockfile and the dependency graph, and doing it here too
would put the semantics in two places that can disagree.

The refusal is a `400` and **not** a `404` on purpose: `finn` maps 404 to
`NotFound`, and "you sent a range" is not "this version does not exist".

| Status | Body | When |
|---|---|---|
| `200` | Version record + `repo_url` | Found. |
| `400` | `{"error":"invalid_version", …}` | Not an exact semver — a range, a `v` prefix, junk. |
| `404` | `{"error":"not_found","message":"No package named \"x\" is registered."}` | Name unknown. |
| `404` | `{"error":"not_found","message":"Package \"x\" has no version 1.4.2."}` | Name known, version not recorded. |
| `500` | `{"error":"internal_error","message":"Could not read the version record."}` | Retryable. |

The two 404s share a code and differ in `message`. If you need to tell them
apart, call §5.1 — do not pattern-match the prose.

**Syntax is checked before existence.** `GET /api/packages/never-registered/versions/%3E=1.2`
returns `400 invalid_version`, *not* `404` — the version string is rejected before
the package is ever looked up. So a `400` here tells you nothing about whether the
package exists, and a client that reads `400` as "bad request, package must be
fine" is wrong.

### 5.4 `GET /api/packages` — search and browse

```http
GET /api/packages?q=lint&sort=recent&trust=verified&limit=25&offset=0
```

| Param | Type | Default | Bounds | Notes |
|---|---|---|---|---|
| `q` | string | `""` | — | Substring match against **name or description** (`LIKE '%q%'`). Case-insensitive for ASCII, case-*sensitive* for anything outside it — that is SQLite's default `LIKE`, not a choice made here. |
| `sort` | enum | `recent` | `recent` \| `updated` \| `name` | Anything else is a `400`. |
| `trust` | enum | none | `verified` \| `trusted` \| `recognized` | Filters to *that level or better*. Anything else is a `400`. |
| `limit` | int | `25` | clamped to `1…100` | Out-of-range values are **clamped, not rejected**. |
| `offset` | int | `0` | clamped to `≥ 0` | |

A non-numeric `limit` or `offset` falls back to its default rather than erroring.
An out-of-range one is clamped — `limit=5000` returns 100, quietly. Read `total`
if you need to know there is more.

`trust=recognized` is a **no-op** that returns everything, because everything on
the register is at least recognized. It is accepted so that the CLI and the web
UI can name the same states without one of them special-casing the floor.

There is no `sort=downloads` and no `sort=stars`. Both are rejected with
`400 invalid_sort` rather than accepted and ignored — the registry measures
neither, so both would order every row by an identical number. An unknown sort is
refused precisely because a sort that appears to work and does not is the bug
being avoided.

```json
{
  "total": 41,
  "items": [ { "name": "left-pad", "description": "…", "latest_version": "1.4.2",
               "publisher": { "login": "acme", "is_verified": true },
               "trust": { "level": "verified" },
               "is_deprecated": false, "created_at": "2026-08-01T00:00:00Z" } ]
}
```

`items` holds [package summaries](#24-package-summary), which carry **no
`repo_url`**. This endpoint is for discovery, not resolution.

Withdrawn (`is_deprecated: true`) packages **are** listed. Hiding them would make
the list disagree with a resolve, and the name is still claimed.

| Status | Body | When |
|---|---|---|
| `200` | `{ total, items }` | Always, including zero matches (`total: 0`, `items: []`). |
| `400` | `{"error":"invalid_sort", …}` | Unknown `sort`. |
| `400` | `{"error":"invalid_trust", …}` | Unknown `trust`. |
| `500` | `{"error":"internal_error","message":"Could not search the registry."}` | Retryable. |

### 5.5 `GET /api/health` — liveness

```http
GET /api/health
```

```json
{ "status": "ok", "time": "2026-08-23T14:02:11.418Z" }
```

Always `200`. No parameters, no error path.

**It does not touch the database.** This handler returns a constant and a clock
reading, so a `200` here proves the Worker is running and routing — nothing more.
It cannot tell you D1 is reachable. Do not use it as a dependency-health gate;
its one honest use is telling "the registry is unreachable" apart from "your
package does not exist", which without it are the same 404-shaped disappointment.

Note `time` here carries milliseconds (`.418Z`) because it comes straight from
`new Date().toISOString()`, unlike the stored timestamps in §3.4. Do not write a
parser that depends on their being identical.

---

## 6. Endpoints for the web UI

Public and unauthenticated like §5, but **not part of the CLI contract**. They
exist for this repository's own front end. Documented so that finding them does
not lead to building on them.

### 6.1 `GET /api/stats` — front-page figures

**camelCase, unlike everything in §5.** That is the marker that it is not for you.

```json
{
  "totalPackages": 41,
  "totalPublishers": 12,
  "totalVersions": 0,
  "recentPackages": [
    { "id": "…", "name": "left-pad", "description": "…", "category": null,
      "isTrusted": false, "isDeprecated": false, "trustLevel": "verified",
      "publisherLogin": "acme", "publisherVerified": true,
      "latestVersion": null, "createdAt": "2026-08-01T00:00:00Z" }
  ]
}
```

`recentPackages` holds at most 8 entries, newest first. There is no downloads
total and no "trending": the registry cannot observe a download, and nothing
populates a star count, so both would be fabricated.

`200` always, or `500 internal_error` ("Could not read registry statistics.").

### 6.2 `GET /api/search/suggestions` — typeahead

```http
GET /api/search/suggestions?q=le
```

Returns a **bare JSON array of name strings**, at most 5: `["left-pad","lexer"]`.

Not an envelope, not objects. `q` shorter than 2 characters returns `[]`.

**It answers `200` with `[]` on internal failure**, swallowing the error, because
a typeahead that shows a stack trace is worse than one that shows nothing. That
makes it structurally unable to distinguish "no matches" from "the database is
down" — which is exactly why you must not resolve against it. Use §5.4.

### 6.3 `GET /api/publishers/:login` — a publisher and their names

snake_case, and `items` is byte-for-byte the §5.4 element shape so both pages
share one row component.

```http
GET /api/publishers/acme?limit=100&offset=0
```

| Param | Default | Bounds |
|---|---|---|
| `limit` | `100` | clamped to `1…100` |
| `offset` | `0` | clamped to `≥ 0` |

```json
{
  "publisher": { "login": "acme", "display_name": "Acme, Inc.",
                 "avatar_url": "…", "kind": "organization",
                 "is_verified": true, "created_at": "2026-07-01T00:00:00Z" },
  "total": 3,
  "items": [ /* package summaries, §2.4 */ ]
}
```

A `:login` resolves to an **account first**, then to an organisation of that name
— both are possible, because a package record's `publisher.login` can be either
and a profile link built from one has to land somewhere. GitHub keeps user and
organisation names in one namespace, so the two lookups cannot both match.

An organisation's packages do **not** appear on its owner's personal profile.
Otherwise one package would sit on two profiles under two different publishers,
and a human who owns an organisation would look as though they had registered its
packages personally.

| Status | When |
|---|---|
| `200` | The login has registered at least one package. |
| `404` | No such login, **or** a login that exists but has claimed nothing. Both are "not a publisher". |
| `500` | Retryable. |

---

## 7. Endpoints that require a browser session

**No CLI should call anything in this section.** They authenticate with a cookie
session obtained through GitHub OAuth in a browser — there is no token flow, by
design ([§3.2](#32-authentication)). They are listed so the surface is complete
and so nobody mistakes one for a publish API.

Their request and response shapes are **not contracted** and are mostly
camelCase. They serve exactly one first-party consumer and may change without
notice.

`GET /api/auth/status` illustrates why: it answers `{ authenticated, user }` where
`user` is the **entire `users` row**, handed straight to the serialiser — so it is
camelCase, it includes the account's own `email` and `role`, and any column added
to the table in future is published automatically. (It does *not* expose the
GitHub access token: that lives in `sessions`, not `users`.) Nothing in §5 works
this way — every contracted response passes through an explicit field mapping
precisely so that a new column cannot leak into the public API by accident.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/auth/github` | Begin OAuth. Answers a proof-of-work page, then redirects to GitHub (§7.4). 20 req / 5 min — two per sign-in. |
| `GET` | `/api/captcha` | Issue a proof-of-work challenge for a browser form (§7.4). 120 req / 5 min. |
| `GET` | `/api/auth/github/callback` | OAuth return leg. Sets the session cookie. 10 req / 5 min. |
| `GET` | `/api/auth/status` | Whether this cookie is a live session. |
| `POST` | `/api/auth/logout` | Destroy the session. |
| `GET` | `/api/dashboard/data` | Everything the signed-in user's dashboard renders. |
| `PATCH` | `/api/me/settings` | Update the signed-in account's own settings. |
| `POST` | `/api/me/verification-request` | Ask an admin to verify this account (§7.3). Needs a proof. |
| `POST` | `/api/registrations/check` | Pre-flight: may I claim a name for this repo? (§7.1) Needs a proof. |
| `POST` | `/api/packages` | Claim a name (§7.2). Needs a proof. |

Unauthenticated calls to these get `401 {"error":"unauthorized","message":…}`. The
session is checked first, so a signed-out caller is told to sign in rather than
handed a puzzle. The three marked "needs a proof" then require the header
described in §7.4, and answer `428` without one.

### 7.1 `POST /api/registrations/check` — pre-flight

```json
{ "repo_url": "https://github.com/acme/left-pad" }
```

`repo_url` accepts a full URL or `owner/repo`; max 512 chars.

**A completed check answers `200` whatever the verdict.** "You cannot push there"
is a *successful check with a negative result*, and the form needs `reason` to
explain it. `4xx` is reserved for a request the registry could not act on at all.

```json
{ "push_access": true, "needs_scope": false,
  "repo": { "…": "GitHub repo metadata" }, "reason": "…" }
```

`needs_scope` separates "not allowed" from "not told": signing in asks GitHub only
for `user:email`, which cannot see repository permissions. That is a round trip
through incremental authorization, not a refusal.

`400` bodies from this route carry the error envelope **and** the negative check
fields (`push_access: false, needs_scope: false, repo: null, reason`), so one
client-side shape handles both.

| Status | Error code | When |
|---|---|---|
| `200` | — | Check completed. Read `push_access`. |
| `400` | `invalid_request` | Body was not JSON. |
| `400` | `invalid_repo_url` | Missing, or not a GitHub repository. |
| `401` | `unauthorized` | Not signed in. |
| `429` | `rate_limited` | 30 req / 15 min ([§9](#9-rate-limits)). |
| `500` | `internal_error` | Retryable. |

### 7.2 `POST /api/packages` — claim a name

```json
{ "name": "left-pad", "repo_url": "acme/left-pad",
  "description": "optional", "homepage": "optional" }
```

Name grammar: `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, 2–64 characters. Lowercase, digits,
single interior hyphens, must start with a letter, **no slash** — a slash always
means GitHub, so a name containing one could never be resolved as a bare name.
Enforced here, not only in the browser: the form is a convenience, this is the
rule.

Push access is re-checked against GitHub here with the signed-in user's token.
The §7.1 call is a **courtesy to the user, not evidence** — nothing stops a
client skipping it, so this endpoint assumes it never happened.

Two fields are taken from GitHub and not from your request body:

- **`license`** is whatever GitHub reports for the repository. A licence is a
  legal statement about someone's code and the registry will not repeat an
  unverified claim about one. Absent stays `null`.
- **`description`** and **`homepage`** fall back to GitHub's when you omit them.

**A registration claims a name; it does not create a release.** The `201` body is
a full package record with **`latest_version: null`**. Nothing is tagged, nothing
is published, and no version record exists.

| Status | Error code | When |
|---|---|---|
| `201` | — | Claimed. Body is a [package record](#21-package-record). |
| `400` | `invalid_request` | Body was not JSON. |
| `400` | `invalid_name` | Fails the grammar or the length bounds. |
| `400` | `invalid_repo_url` | Missing, or not a GitHub repository. |
| `401` | `unauthorized` | Not signed in, or the session no longer matches an account. |
| `403` | `push_access_denied` | GitHub says you cannot push there. Carries `needs_scope: false`. |
| `403` | `scope_required` | The token cannot *see* permissions. Carries `needs_scope: true` — re-authorize. |
| `409` | `name_taken` | Names are global and first-come. |
| `429` | `rate_limited` | 30 req / 15 min. |
| `500` | `internal_error` | Retryable. |

`name_taken` is returned from two places: a pre-check before GitHub is called (so
a taken name costs no API budget) and the unique index on `packages.name`, which
is what actually settles a race between two simultaneous claims. The loser of the
race sees the same `409`.

### 7.3 `POST /api/me/verification-request`

Asks an admin to verify the signed-in account. `201` with
`{ "request": { "status": "pending", "createdAt": … } }` — note the camelCase.

| Status | Error code | When |
|---|---|---|
| `201` | — | Queued for review. |
| `400` | `invalid_note` | The optional `note` is not a string, or exceeds 1000 characters (measured after trimming). |
| `404` | `not_found` | The account no longer exists. |
| `409` | `already_verified` | Nothing to ask for. |
| `409` | `request_pending` | One is already awaiting review. |
| `500` | `internal_error` | Retryable. |

A previous **refusal** does not block a new request: people fix what was wrong
and ask again, which is the normal path rather than an abuse case. Only a
*pending* request blocks, and that is enforced by a partial unique index as well
as the check, because a double-click fires two requests that can both pass the
read before either insert lands.

---

### 7.4 Proof of work on the browser writes

The three `POST`s above, and the sign-in redirect, require the caller to have
burnt some CPU. This is not a puzzle a person solves — there is nothing to read,
click, or type — it is arithmetic the browser does on its own while the form is
being filled in.

**No CLI is affected.** Every endpoint in §5 and §6 is a plain public `GET` and
none of them look at any of this. If you are writing a package manager, skip this
section.

How it works:

1. `GET /api/captcha?scope=<scope>` returns a signed challenge:

   ```json
   { "salt": "9f2c1ab4e8d07b3c5a1f6e2d8b04c7a9", "bits": 15,
     "exp": 1787000000000, "sig": "…64 hex chars…" }
   ```

   `scope` is one of `register`, `register-check`, `verify-request`. The response
   is `Cache-Control: no-store`, because a reused challenge is a replayed one.

2. The browser searches for a `nonce` where
   `SHA-256("<salt>.<nonce>")` begins with at least `bits` zero bits. That takes
   about `2^bits` hashes — a second or so on a laptop at 15 bits.

3. It sends `x-finn-captcha: v1.<salt>.<bits>.<exp>.<sig>.<nonce>` with the
   `POST`. (A `?captcha=` query parameter is accepted for the same value, which
   is what the sign-in page uses, since it navigates rather than fetches.)

Verifying costs the registry one HMAC and one SHA-256. That asymmetry is the
whole mechanism: nothing is stored, no row is written, and no third-party service
is contacted.

Difficulties, by scope: sign-in 13 bits, `registrations/check` 14, `packages` 15,
`verification-request` 15.

Every refusal is `428 Precondition Required`:

```json
{ "error": "captcha_required", "reason": "expired",
  "message": "The proof-of-work check went stale. Reload the page and try again." }
```

`reason` is one of `missing`, `malformed`, `expired`, `bad_signature`,
`insufficient_work`, `replayed`. A challenge is good for ten minutes and for
exactly one submission; `replayed` and `expired` both mean fetch a new one.

`428` was chosen over `403` deliberately: this is a missing precondition on the
request, not a judgement about the account, and it must not be logged or shown as
one.

**What this does and does not do.** It does not prove a human is present, and it
does not stop a determined attacker — native code hashes far faster than a phone
browser does. What it does is put a real, per-attempt CPU cost on bulk
submission, which turns a script that files ten thousand verification requests
into one that files a handful. It sits on top of the session requirement and the
rate limits rather than replacing either.

---

## 8. Error catalogue

Every documented failure uses one envelope:

```json
{ "error": "not_found", "message": "No package named \"left-pad\" is registered." }
```

- **`error`** is a stable machine-readable code. Branch on this.
- **`message`** is a sentence for a human. **Never branch on it** — the wording
  changes, and two different conditions can share a code and differ only in prose
  (see §5.3).

The one exception is §3.7: an unknown route returns plain text, not this envelope.

| `error` | Status | Endpoints | Meaning | What a client should do |
|---|---|---|---|---|
| `not_found` | `404` | §5.1–5.3, §6.3, §7.3 | The named thing is not on the register. | Report absence. Safe to cache. |
| `invalid_version` | `400` | §5.3 | A range, `v`-prefix, or junk where an exact version was required. | Fix the request. Resolve ranges yourself. |
| `invalid_sort` | `400` | §5.4 | Unknown `sort` value. | Fix the request. |
| `invalid_trust` | `400` | §5.4 | Unknown `trust` value. | Fix the request. |
| `invalid_request` | `400` | §7.1, §7.2 | Body was not JSON. | Fix the request. |
| `invalid_name` | `400` | §7.2 | Fails the name grammar or length bounds. | Fix the request. |
| `invalid_repo_url` | `400` | §7.1, §7.2 | Not a GitHub repository. | Fix the request. |
| `unauthorized` | `401` | §7.* | No live session. | Not applicable to a CLI — §5/§6 need no credentials. |
| `push_access_denied` | `403` | §7.2 | GitHub says the user cannot push there. | Terminal. |
| `scope_required` | `403` | §7.2 | The token cannot see permissions. | Re-authorize with a wider scope. |
| `name_taken` | `409` | §7.2 | Names are global and first-come. | Terminal. Choose another name. |
| `already_verified` | `409` | §7.3 | Nothing to request. | Terminal. |
| `request_pending` | `409` | §7.3 | A request is already awaiting review. | Terminal. Wait. |
| `captcha_required` | `428` | §7.1–7.3 | No valid proof of work (§7.4). | Not applicable to a CLI — §5/§6 need none. |
| `invalid_scope` | `400` | §7.4 | Unknown `scope` on `/api/captcha`. | Fix the request. |
| `rate_limited` | `429` | all | Ceiling exceeded. | Honour `Retry-After`, back off. |
| `internal_error` | `500` | all | The registry failed. | **Retryable.** Never cache as absence. |

### 8.1 The distinction that matters most

**`404` means "not registered". `5xx` means "ask again".**

A `5xx` must never be reported to a user as "no such package", and must never be
written to a lockfile or a cache as absence. They are the same 404-shaped
disappointment to a naive client, and conflating them turns a thirty-second
registry blip into a wrong lockfile that outlives it.

---

## 9. Rate limits

### 9.1 The ceilings

| Bucket | Applies to | Window | Max | Keyed on |
|---|---|---|---|---|
| read | **every route** (`*`) | 15 min | **1000** | client IP |
| write | `/api/me/*`, `/api/dashboard/*` | 15 min | 100 | client IP |
| register | `POST /api/registrations/check`, `POST /api/packages` | 15 min | 30 | client IP **+ path** (so 30 each) |
| auth | `GET /api/auth/github` | 5 min | 20 | client IP **+ path**. One sign-in costs two: the challenge page and the solved one (§7.4), so this is ten attempts. |
| auth | `GET /api/auth/github/callback` | 5 min | 10 | client IP **+ path** |
| captcha | `GET /api/captcha` | 5 min | 120 | client IP **+ path**. High because a challenge is cheap to issue and single-use (§7.4). |

The read bucket is mounted on `*`, so it applies to **everything** — the write and
register routes consume the read budget as well as their own.

The read ceiling is 1000 rather than the 100 it once was, because a single
`finn sync` over a large dependency graph — or any CI runner behind a shared
egress IP — trips 100 immediately.

Client IP comes from `x-forwarded-for` (first entry), then `x-real-ip`, else the
literal key `anonymous`. **Everything behind one NAT or one CI egress address
shares a budget**, and anything the registry cannot identify shares the
`anonymous` bucket with every other unidentifiable caller.

### 9.2 Headers

Sent on **every** response, not only on a 429:

| Header | Value |
|---|---|
| `X-RateLimit-Limit` | The configured max for that bucket. |
| `X-RateLimit-Remaining` | Requests left in this window, floored at 0. |
| `X-RateLimit-Reset` | **Unix seconds** when the window resets — not a duration. |
| `Retry-After` | Seconds to wait. **429 only.** |

**On a route with more than one limiter, these describe the last one to run, not
the tightest.** Because the read bucket is mounted on `*`, a request to
`/api/me/*` passes through both limiters and the headers report the write bucket's
`100`; a registration reports `30`. The read budget it also consumed is never
reflected. So the headers are a valid signal for the bucket they name and not a
complete picture of what you have left.

### 9.3 The 429 body

```json
{ "error": "rate_limited",
  "message": "Too many read requests from this IP. Retry with backoff.",
  "retryAfter": 412, "limit": 1000, "remaining": 0, "reset": 1787670000 }
```

**`retryAfter` is camelCase**, inconsistent with every other CLI-facing field
([§3.3](#33-casing)). Prefer the **`Retry-After` header**, which is standard,
correctly spelled, and will not change under you if the body is fixed.

### 9.4 These numbers are a floor, not a guarantee

The counters live in **one Worker isolate's memory**. Two requests served by
different isolates count against different budgets, so the effective ceiling is
**higher and less predictable than the configured number — never lower**, and
`X-RateLimit-Remaining` describes only the isolate that answered you.

That is a deliberate trade: a shared counter would cost a D1 row write per
request to buy precision nobody needs, and the limit that actually protects the
service is Cloudflare's 100,000 requests/day for the whole registry.

**So do not calibrate to these numbers.** Do not compute "I have 1000 requests,
therefore I may fire 1000". Honour the headers you are given, back off on 429,
and keep your steady-state request count low — see §9.5.

### 9.5 What this asks of a client

The whole registry runs inside a free tier: 100,000 requests/day, 10 ms of CPU
per invocation, 5 million D1 row reads/day, shared across every user. That budget
is the real constraint, and it shapes what a well-behaved client does:

1. **One request per package, not per version.** §5.2 returns every version record
   in one response; §5.3 includes `repo_url` so a pinned resolve needs no second
   call.
2. **Cache locally.** Nothing sets `Cache-Control` yet ([§3.6](#36-content-type-cors-caching)),
   so choose your own TTL. A resolved `name → repo_url` mapping is nearly static.
3. **Exponential backoff on `429` and `5xx`**, seeded from `Retry-After`.
4. **Never poll.** There is no change feed, no webhook, and no `If-Modified-Since`.
5. **Do not fan out in parallel across a dependency graph.** Serial-with-cache
   beats parallel-then-throttled, and a CI fleet behind one IP shares one bucket.

---

## 10. What does not exist yet

Read this section before planning client work. Several things a package manager
would reasonably expect are **absent**, not merely undocumented, and building
against the assumption that they exist is the most likely way to waste a day.

### 10.1 There is no write path for version records — anywhere

**Nothing in this codebase ever inserts, updates, or deletes a row in the
`versions` table.** Not an API route, not a server action, not a script. The
table is read by four endpoints and written by nothing.

Everything downstream follows from that:

| Consequence | What you actually get |
|---|---|
| `latest_version` on every package | `null` |
| `GET /api/packages/:name/versions` | `{ "name": "…", "versions": [] }` |
| `GET /api/packages/:name/versions/:version` | `404` for every version of every package |
| `checksum`, `checksum_origin`, `git_ref`, `commit` | Never populated |

So today the registry can answer **"what repository is this name?"** and cannot
answer **"what versions does it have?"**. A resolver must handle `latest_version:
null` and an empty `versions` array as the *normal* case, and fall back to reading
tags from `repo_url` on GitHub if it needs a version. Registering a name is
explicitly not releasing anything ([§7.2](#72-post-apipackages--claim-a-name)).

### 10.2 No endpoint publishes, yanks, or withdraws

There is no publish API, no yank endpoint, and no way to set `is_deprecated`
over HTTP. `yanked` and `is_deprecated` are read-only fields that only a direct
database write can currently change.

### 10.3 Moderator and admin actions are not HTTP endpoints

Verifying a publisher (`users.isVerified`) and marking a package trusted
(`packages.isTrusted`) happen in **Next.js server actions** in
`src/app/admin/actions.ts`, reachable only from the admin page in a browser.
There is no admin API, so there is no way to script trust changes and nothing for
a CLI to call. Trust levels can therefore only be *read* through this API.

### 10.4 No checksum can be verified, only reported

The registry never holds the code, so it cannot compute a checksum. Any future
`checksum` is `publisher_attested` by construction ([§2.3](#23-version-record)).
A client that wants integrity guarantees must compute them against what it
fetched from GitHub, and must not present a registry checksum as verification.

### 10.5 Smaller gaps, each a real edge

| Gap | Effect on a client |
|---|---|
| Unknown routes return plain-text `404` ([§3.7](#37-unknown-routes-behave-differently-from-known-ones)) | A `404` is not reliably JSON. Guard your parse. |
| No `Cache-Control`, no `ETag` | No conditional requests; pick your own TTL. |
| No CORS headers | Browser cross-origin clients are blocked. |
| `offset` pagination only, unbounded above | No cursor; deep offsets are permitted and expensive. |
| Search is `LIKE '%q%'`, no ranking | Results are ordered by `sort`, never by relevance. |
| No change feed, webhook, or `If-Modified-Since` | Polling is the only option, so don't ([§9.5](#95-what-this-asks-of-a-client)). |

### 10.6 Nothing is deployed

`wrangler.jsonc` still carries `"database_id": "REPLACE_WITH_D1_DATABASE_ID"`. No
D1 database has been created and no Worker has been published, so there is no live
host to point a client at yet — only the local verification described in §11. The
hostname question in [§3.1](#31-base-url) is open for the same reason.

### 10.7 The `finn` client as it stands

Verified against `~/finn` rather than assumed. Useful because it tells you what
already works and what has to change:

**What matches.** `src/registry.rs` calls `GET {base}/api/packages/{name}` — §5.1,
correctly. Its `PackageMetadata` deserializes `name`, `description`, `repo_url`
and `latest_version`, all snake_case, all matching this API exactly. Unknown
fields are ignored by serde, so everything the registry adds is
backward-compatible. It maps `404` to a `NotFound` error and returns before
parsing a body, so §3.7's plain-text 404 does not break it.

**What needs work, in the order it will bite:**

1. **The base URL default is wrong** — `DEFAULT_REGISTRY` is
   `https://finn-registry.pages.dev`, a Pages host for a Worker deployment
   ([§3.1](#31-base-url)). It *is* overridable via a constructor argument or the
   `FINN_REGISTRY_URL` environment variable, so this is a one-line change once the
   real hostname exists.
2. **Every non-404 failure collapses into one error.** `!status.is_success()`
   becomes `ApiError("Status 500")`, so a `429` and a `500` are indistinguishable
   from a `400`, nothing is retried, and `Retry-After` is ignored. This is the
   §8.1 and §9 guidance, unimplemented — and the failure mode it produces is a
   hard error on a transient blip.
3. **The error envelope is never parsed**, so the `error` code and its human
   `message` are both discarded in favour of a status number.
4. **`trust` is not read at all** — no `TrustLevel` type exists in the CLI. The
   whole point of the registry is unconsumed. `install.rs:21` refuses on
   `!source.is_official` unless `--ignore-regulations`, which is a *hard refusal*
   where `REGISTRY-CONTRACT.md` §2.5 calls for asking the user, and it does not
   consult the registry's trust level to decide.
5. **No client for §5.2 or §5.3.** `finn add <name>@<version>` cannot resolve a
   version against a bare registry name, because nothing calls the versions
   endpoints — and per §10.1 there would be nothing there to find yet anyway.

---

## 11. Verifying against a running instance

You do not need a deployed registry to test a client. The repository can boot the
real Cloudflare Worker locally, on the same runtime it deploys to:

```bash
npm run cf:build          # build the Worker bundle (NOT `npm run build`)
npm run db:apply:local    # create the schema in the local D1
npx wrangler dev          # serves on http://127.0.0.1:8787
```

Requires **Node ≥ 22** — `wrangler` refuses to start below it.

Or run the whole gate in Docker, which reproduces CI exactly and finishes by
booting the Worker and probing it:

```bash
sudo docker build -t finn-registry-ci .
sudo docker run --rm finn-registry-ci
```

### 11.1 What has actually been verified

The endpoints in §5 have been exercised against a live `workerd` instance, not
just typechecked:

```
/api/health                                 -> 200
/api/packages                               -> 200
/api/packages/a-name-nobody-has-registered  -> 404
```

plus the page routes, and a deliberately D1-less Worker confirming that a missing
database binding reports itself rather than failing obscurely.

### 11.2 What that does not prove

The local database is **empty**. Every probe above ran against zero registered
packages, so `200` proves routing, bundling and D1 connectivity — not that a
populated response has the right shape. The response shapes in this document come
from reading `serializers.ts`, which is the single chokepoint every CLI-facing
response passes through, and from the test suite (147 tests, including
regression tests asserting no endpoint invents a `1.0.0`).

If you are building a client, insert a row locally and probe against it. Do not
assume a shape here is field-for-field right until you have seen it once.

---

## Appendix: endpoint index

| Method | Path | § | Audience |
|---|---|---|---|
| `GET` | `/api/packages/:name` | [5.1](#51-get-apipackagesname--resolve-one-package) | CLI |
| `GET` | `/api/packages/:name/versions` | [5.2](#52-get-apipackagesnameversions--every-version-record) | CLI |
| `GET` | `/api/packages/:name/versions/:version` | [5.3](#53-get-apipackagesnameversionsversion--one-exact-version) | CLI |
| `GET` | `/api/packages` | [5.4](#54-get-apipackages--search-and-browse) | CLI |
| `GET` | `/api/health` | [5.5](#55-get-apihealth--liveness) | CLI |
| `GET` | `/api/stats` | [6.1](#61-get-apistats--front-page-figures) | web only |
| `GET` | `/api/search/suggestions` | [6.2](#62-get-apisearchsuggestions--typeahead) | web only |
| `GET` | `/api/publishers/:login` | [6.3](#63-get-apipublisherslogin--a-publisher-and-their-names) | web |
| `POST` | `/api/registrations/check` | [7.1](#71-post-apiregistrationscheck--pre-flight) | session |
| `POST` | `/api/packages` | [7.2](#72-post-apipackages--claim-a-name) | session |
| `POST` | `/api/me/verification-request` | [7.3](#73-post-apimeverification-request) | session |
| `GET` | `/api/auth/github` | [7](#7-endpoints-that-require-a-browser-session) | session |
| `GET` | `/api/auth/github/callback` | [7](#7-endpoints-that-require-a-browser-session) | session |
| `GET` | `/api/auth/status` | [7](#7-endpoints-that-require-a-browser-session) | session |
| `POST` | `/api/auth/logout` | [7](#7-endpoints-that-require-a-browser-session) | session |
| `GET` | `/api/dashboard/data` | [7](#7-endpoints-that-require-a-browser-session) | session |
| `PATCH` | `/api/me/settings` | [7](#7-endpoints-that-require-a-browser-session) | session |
