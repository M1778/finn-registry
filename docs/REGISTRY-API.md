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
12. [Registry discovery and the offline fallback index](#12-registry-discovery-and-the-offline-fallback-index)

---

## 1. What the registry is

A **trust and attribution layer over GitHub**. It records that a name belongs to
a repository, and who stands behind it. It does not store, serve, proxy or
rewrite a single byte of anyone's code.

```
     finn (CLI)                 finn-registry                 GitHub
         │                            │                          │
         │  GET /api/packages/http    │                          │
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
  "name": "http",
  "description": "An HTTP client.",
  "repo_url": "https://github.com/acme/fin-http",
  "homepage": null,
  "license": "MIT",
  "keywords": ["net", "http"],
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
  "name": "http",
  "description": "An HTTP client.",
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

**There is no stable hostname, and there is not going to be one.** The base URL is
not a constant to be settled once and compiled in — it is **discovered at run
time** from a pointer file published in this repository, on the default branch, at
`registry/v1/url.txt`. [§12](#12-registry-discovery-and-the-offline-fallback-index)
specifies that file and the fallback index that sits beside it; read it before
hard-coding anything.

The precedence a client should implement is two-tiered, plus a cache:

| Tier | Source | When it wins |
|---|---|---|
| 1 | an explicit override — config file or `FINN_REGISTRY_URL` | always, and it is never overridden by discovery |
| 2 | the pointer file, fetched over HTTPS from GitHub raw at `HEAD` | no override was given |
| — | the client's own 24-hour cache of what tier 2 last said | the pointer could not be fetched at all |

> **Do not hard-code a default you cannot verify.** `finn` used to ship
> `DEFAULT_REGISTRY = "https://finn-registry.pages.dev"` — a Cloudflare **Pages**
> hostname, where this registry deploys as a Cloudflare **Worker**
> (`@opennextjs/cloudflare` + `wrangler`, ADR-0005), so it would not have served
> these routes: every call 404s. That constant is now `None`
> (`src/discovery.rs`), and a client implementing this spec should keep it that
> way. A wrong URL compiled into a released binary cannot be corrected remotely,
> and it is the single most misleading failure this API can hand a user, since "no
> such host" and "wrong host" both surface as *package not found* for every
> package. An empty answer is recoverable; a confident wrong one is not.
>
> Whatever tier supplied the URL, **fail with a message that names the URL you
> tried and which tier it came from.** A transport error is a registry problem and
> must never be reported as a package not existing ([§8.1](#81-the-distinction-that-matters-most)).

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

### 4.1.1 What `repo_ownership_confirmed` actually asserts

It is `true` on every response, and always will be. A name cannot be claimed
without proving push access to the repository it points at, so there is no
registered package for which it is false — and therefore no column behind it.
Two consequences worth stating rather than leaving a client to discover:

- **It does not distinguish one package from another.** Reading it as a
  discriminator between packages would be reading information that is not there.
  This is a second reason to branch on `level` alone.
- **It is past tense.** The proof is taken once, when the name is claimed, and
  never retaken. A publisher who later loses push access, or whose repository is
  deleted or transferred, keeps an entry that still reports `true`. Read it as
  *ownership was proven when this name was claimed*.

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
GET /api/packages/http
```

`:name` is a **single path segment**. A name is bare and globally unique; a
slash always means GitHub to `finn` and so can never be a registry name. The
single-segment route parameter enforces that for free — `GET /api/packages/acme/http`
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
GET /api/packages/http/versions
```

```json
{
  "name": "http",
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
GET /api/packages/http/versions/1.4.2
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
  "repo_url": "https://github.com/acme/fin-http"
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

**Syntax is checked before existence.** `GET /api/packages/unregistered/versions/%3E=1.2`
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
  "items": [ { "name": "http", "description": "…", "latest_version": "1.4.2",
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
    { "id": "…", "name": "http", "description": "…", "category": null,
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
GET /api/search/suggestions?q=ht
```

Returns a **bare JSON array of name strings**, at most 5: `["http","httpclient"]`.

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

`items` are ordered **newest registration first, ties broken by `name` ascending**
— the same total order as [§5.4](#54-get-apipackages--search-and-browse) under
`sort=recent`. That is a guarantee and not an implementation detail, because this
endpoint pages: `offset` over an order that leaves ties unresolved repeats a row
on one page and drops it from another, and two names registered in the same second
is not a contrived case. A future editor may change the order the profile is
presented in, but not to one that leaves ties unbroken.

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
{ "repo_url": "https://github.com/acme/fin-http" }
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
{ "name": "http", "repo_url": "acme/fin-http",
  "description": "optional", "homepage": "optional" }
```

Name grammar: `^[a-z][a-z0-9]*$`, 2–64 characters, and not one of Fin's reserved
words. Lowercase letters and digits, starting with a letter — **no hyphens,
underscores or dots**, and **no slash**, because a slash always means GitHub and a
name containing one could never be resolved as a bare name.

The grammar is Fin's identifier grammar, deliberately: `ID` is
`{ALPHA}({ALPHA}|{DIGIT})*` over `ALPHA [a-zA-Z_]`, so `-` lexes as `MINUS` and
`import http-client;` would not be a bad-name error — it would read as a
subtraction of two undeclared names. Every registered name is therefore spellable
as `import <name>;`. The reserved words are the ones Fin's lexer has today
(`let`, `type`, `string`, `true`, `as`, …); the list lives in
`src/lib/package-name.ts`.

A refused name is **refused, not corrected**. `http-client` does not become
`http_client` or `httpclient`: one package with two spellings is a fact the
registry would have invented, and the user would be left to reconcile it.

Enforced here, not only in the browser: the form is a convenience, this is the
rule. A **repository** name is unaffected — `acme/fin-http` keeps its hyphen,
since that string is GitHub's, not the register's.

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
| `400` | `invalid_name` | Fails the grammar, the length bounds, or is a Fin reserved word. `message` names the rule that was broken. |
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
{ "error": "not_found", "message": "No package named \"http\" is registered." }
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

1. ~~**The base URL default is wrong**~~ — **done, and better than asked for.**
   `DEFAULT_REGISTRY` used to be `https://finn-registry.pages.dev`, a Pages host
   for a Worker deployment ([§3.1](#31-base-url)). It is now `None`, and
   `src/discovery.rs` implements the pointer file and a 24-hour cache instead
   ([§12](#12-registry-discovery-and-the-offline-fallback-index)), so there is no
   hostname left to correct and no release needed when ours changes. Overrides
   still win: `[registry].url` in `finn.toml`, then `$FINN_REGISTRY_URL`. Note
   there is no `--registry` flag — do not document one.
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
/api/packages/nosuchpackage                 -> 404
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

## 12. Registry discovery and the offline fallback index

Two files in this repository are read by clients directly, over HTTPS, without
going through the API at all. They are what makes the registry findable when its
hostname is unknown, and resolvable when it is unreachable.

| File | Purpose |
|---|---|
| `registry/v1/url.txt` | the pointer: names the current registry base URL |
| `registry/v1/packages.json` | the fallback index: package → repository for the standard library and the first-party libraries |

Both are fetched from the **default branch** of this public repository:

```
https://raw.githubusercontent.com/M1778/finn-registry/HEAD/registry/v1/url.txt
https://raw.githubusercontent.com/M1778/finn-registry/HEAD/registry/v1/packages.json
```

`HEAD` — not `master`, not `main` — is deliberate. It resolves to whatever this
repository's default branch is called, so renaming the default branch cannot break
an already-installed binary. The repository is public, so no token, no
`Authorization` header and no authenticated transport is involved; a plain
unauthenticated `GET` is the whole protocol.

> **Both URLs 404 right now, and merging is the fix.** `HEAD` resolves to the
> default branch, and every file described in this section lives on
> `feat/registry-implementation`. The default branch does not have them. Until that
> branch merges, discovery gets a 404 at tier 2 and there is nothing behind it: the
> client's compiled-in default is `None`, deliberately, because a URL baked into a
> binary that 404s turns "not deployed" into "your package does not exist".
> Nothing about the files themselves is wrong; they are simply not on the branch
> that is served. Merging them is worth doing **before** a deployment exists — see
> [§12.2](#122-registryv1urltxt--the-pointer), which is published as comments only
> for exactly that reason.

### 12.1 Both paths are permanent API

An installed binary cannot be updated remotely. Whatever path a released `finn`
was compiled with is the path it will fetch for as long as that copy exists on
somebody's machine — so these two strings are as much a public interface as any
route in [§5](#5-endpoints-for-a-package-manager), and they are frozen on the same
terms.

Three specific choices follow from that, and each is load-bearing:

1. **Under `registry/`, not `docs/`.** These are machine-facing files. Documentation
   gets reorganised, split, renamed and moved, and a documentation reshuffle must
   never be able to break package resolution for installed clients. Keeping them
   out of `docs/` removes the whole class of accident.
2. **Under `v1/`.** The `schema` field inside `packages.json` versions the *format*
   of the index — add a field, change a field's meaning, and `schema` goes to `2`.
   It cannot version the discovery model itself: if the pointer stops being a text
   file, or the index splits into shards, or discovery moves to a signed manifest,
   there is no field inside the old file that can express it. `v1/` is that escape
   hatch. A future model lands at `registry/v2/…` and `registry/v1/…` keeps being
   published for as long as clients read it.
3. **`packages.json`, not `index.json`.** The `Fin` project already publishes an
   `index.json` — the `finc` compiler release index, which carries its own
   `SCHEMA = 1` that means something completely different. Two files named
   `index.json`, each with a `schema` field, each versioned independently, is a
   confusion that costs an afternoon the first time somebody hits it and is free to
   avoid now.

### 12.2 `registry/v1/url.txt` — the pointer

Plain text, UTF-8, one meaningful line. The format is deliberately the smallest
thing that can be parsed correctly by a client with no dependencies:

- a line whose first character is `#` is a comment;
- blank lines are ignored;
- the **first** non-comment, non-blank line is the registry base URL;
- that URL must be `https://`, must carry **no trailing slash**, and must carry
  **no path** — the client appends `/api/...` itself;
- **nothing after that line is read.** A second URL further down the file is not
  a second answer.

The file as published today, minus its comment block, is **nothing**. There is no
URL line, and that is a decision rather than an omission:

```
(comments only — no URL line)
```

> **Why an empty answer beats a placeholder.** This file used to end with
> `https://finn-registry.REPLACE-WITH-ACCOUNT-SUBDOMAIN.workers.dev`, in the same
> placeholder idiom as `wrangler.jsonc`'s `database_id`. In a JSON config that is
> harmless, because nothing accepts it. Here it is not, because **it satisfies
> every rule listed above**: https, a non-empty host, no trailing slash, no path.
> A client cannot tell it from a real answer. It accepts it, caches it for 24
> hours, fails to connect, and reports the registry as **unreachable** — when the
> truth is that the registry has never been **deployed**. A package manager needs
> different words for those two, and a placeholder that validates destroys the
> difference.
>
> A file of comments has no such problem. `finn` reads it, reports that it
> *"contains no URL line — every line is blank or a comment"*, finds no cache and
> no compiled-in default, and says plainly that it knows of no deployment, naming
> `$FINN_REGISTRY_URL` and finn.toml's `[registry]` table as the way to point it at
> one. That is the honest failure, and it is immediately useful to somebody running
> their own registry.
>
> It also means this section can merge and be exercised **now** rather than waiting
> on a deploy. Nothing has been deployed yet: `wrangler.jsonc` still carries
> `"database_id": "REPLACE_WITH_D1_DATABASE_ID"`, so no D1 database exists, no
> migration has been applied remotely, and no Worker has been published
> ([§10.6](#106-nothing-is-deployed)).

**Activating the pointer is one appended line.** A `workers.dev` origin is
`<worker-name>.<account-subdomain>.workers.dev`, and the account subdomain is
assigned to the Cloudflare account that first publishes the Worker — it is not
knowable in advance, which is why nothing is written here now. Whoever deploys
appends the origin `wrangler` prints, in the same change that publishes the Worker:

```diff
  # A wrong URL here breaks every user of the language. This is the one line in
  # this repository that must never be guessed.
+
+ https://finn-registry.<account-subdomain>.workers.dev
```

Then regenerate the index — `npm run build:fallback-index` — because
`packages.json`'s `registry_url` is read out of this file and the two must not
disagree. Nothing else moves: no CI change, no `finn` release, and no second merge,
since the file is already on the default branch. The two-label form
`finn-registry.workers.dev` is **not** a shortcut for the unknown subdomain: it
names an *account* subdomain anybody could register.

**Three guards refuse a placeholder in URL position**, and none of them minds one
in a comment — the file documents this hazard by name:

| Guard | Where |
|---|---|
| `tests/regressions/no-guessed-registry-url.test.ts` | the merge gate: `npm test`, on every push |
| `scripts/build-fallback-index.mjs` | refuses to generate an index from a placeholder pointer |
| `scripts/check-fallback-index.mjs` + the `Preflight` step of `.github/workflows/fallback-index.yml` | refuses to publish one, and refuses a pointer and an index that disagree |


**The pointer is a trust root, and it is publicly auditable.** Push access to this
repository redirects package resolution for every `finn` user, which is a real
security property and worth being explicit about. The mitigation that comes for
free from this being a public git repository is that **`git log registry/v1/url.txt`
is a complete, public record of every URL the ecosystem has ever been pointed
at** — a redirect cannot be issued quietly, and anyone can audit the whole history
after the fact. That is strictly more than a hostname compiled into a binary can
offer, where a redirect requires a new release nobody can diff. The rest is
procedural, and *recommended* rather than configured here: **branch protection and
signed commits on the default branch.**

### 12.3 `registry/v1/packages.json` — the fallback index

Read when the live API is unreachable. It answers exactly one question — *where
does this package's code live* — for the standard library and the first-party
libraries. It is not a mirror of the register.

```json
{
  "schema": 1,
  "registry_url": null,
  "generated_at": "2026-08-24T06:48:59.467Z",
  "packages": {}
}
```

| Field | Type | Meaning |
|---|---|---|
| `schema` | integer | format version. **`1` today.** Emitted first, and checked first — see [§12.4](#124-schema-is-checked-before-anything-else-is-read) |
| `registry_url` | string \| null | the same base URL the pointer names, byte for byte. Generated from the pointer, so it cannot drift. **`null` today**, because the pointer names none ([§12.2](#122-registryv1urltxt--the-pointer)) — a client that fetches the index therefore recovers *no* URL from it, which is correct and is not a fetch failure |
| `generated_at` | string | ISO 8601 UTC, when **these contents** were generated. Informational, not a cache directive — and it moves only when something else in the file moves, see [§12.6](#126-the-ci-job-that-regenerates-it) |
| `packages` | object | a **name-keyed map**, not an array. The key is the registry name; a client resolving a name does one lookup, not a scan |

Each value in `packages` is:

| Field | Type | Meaning |
|---|---|---|
| `repo_url` | string | the git repository. The only field with no useful null case — an entry without it would answer nothing |
| `latest_version` | string \| null | the highest non-yanked version on record, semver-ordered |
| `tag` | string \| null | the git ref for that version (`git_ref`) |
| `commit` | string \| null | the commit that ref pointed at when the version was recorded |
| `trust` | `"verified"` \| `"trusted"` \| `"recognized"` | the package's trust level, per [§4](#4-trust) |
| `kind` | `"stdlib"` \| `"library"` | whether the entry is part of the standard library or an ordinary library |

Two rules about the values, both of which a client may rely on:

- **`trust` is read verbatim and is never a guess.** It is derived by the same
  ladder as the API — `src/lib/trust.ts`, from `users.is_verified` and
  `packages.is_trusted` — and it is never defaulted to a floor value to fill the
  field in. Branch on it the same way you branch on the API's `trust.level`, and
  do not reconstruct it from anything else.
- **An unknown value is `null`, never a plausible-looking placeholder.** A package
  with no version records emits `"latest_version": null, "tag": null, "commit": null`.
  This is the same discipline `tests/regressions/no-fabricated-version.test.ts`
  enforces on the API, for the same reason: a fabricated `"1.0.0"` is a false claim
  about somebody else's code, and a client that trusts it checks out a tag that
  does not exist. Since nothing writes to `versions` yet
  ([§10.1](#101-there-is-no-write-path-for-version-records--anywhere)), **`null`
  is the ordinary case today, not an edge case** — handle it first.

`"packages": {}` — an empty map — is a valid index and is what is published today.
It means *the register holds no first-party package with a recorded version*, which
is true, and it is not the same as the file being missing. A client that gets an
empty map falls through to its next resolution step; a client that gets a 404 has a
discovery failure. Do not collapse the two.

### 12.4 `schema` is checked before anything else is read

`schema` is emitted as the first key in the object, and the guarantee to a client
is this: **check `schema` before reading any other field, and refuse an unknown
value rather than guessing.** That is the same rule `finn` already implements for
the `finc` release index (`INDEX_SCHEMA` in its `src/commands/download.rs`), and the
reasoning carries over unchanged.

If a client sees a `schema` it does not know:

- **Refuse.** Do not parse the rest optimistically, do not treat missing fields as
  null, and do not fall back to a heuristic. A format bump exists precisely because
  a field's meaning changed, and a client that reads a `2` as though it were a `1`
  produces a confidently wrong answer about where code lives.
- **Say which side is behind.** A newer `schema` than the client knows means the
  client is old — tell the user to upgrade. That distinction is the difference
  between a two-second fix and a bug report.

Correspondingly, this repository will not repurpose a field within a `schema`. If
the meaning of `latest_version`, `tag`, `commit`, `trust` or `kind` changes, or a
field becomes required, `schema` goes to `2`.

### 12.5 How the index is generated

The index is **generated from the database, never hand-maintained**:

```bash
npm run build:fallback-index                          # the default local database
npm run build:fallback-index -- --db file:export.db   # an explicit one
npm run build:fallback-index -- --out /tmp/x.json     # somewhere other than the fixed path

# And the guard CI runs before it commits anything, which is worth running by
# hand on any index you generated somewhere other than the fixed path:
node scripts/check-fallback-index.mjs --candidate /tmp/x.json

# The guard also reads the pointer, because the one rule the generator cannot
# enforce is that the two files agree: the generator writes both, so it cannot be
# the thing that catches itself writing them inconsistently.
node scripts/check-fallback-index.mjs --candidate /tmp/x.json --pointer registry/v1/url.txt
```

The script is `scripts/build-fallback-index.mjs`. It reads the same local SQLite
file the test suite and `npm run db:apply:local` use, and writes
`registry/v1/packages.json`. It is `.mjs` rather than `.ts` because nothing in this
repository can execute a TypeScript file — there is no `ts-node` or `tsx` — and it
imports only `@libsql/client/node` and `semver`, both already dependencies.

It is generated because the alternative is worse: the index duplicates
package → repository data that already lives in D1, and a hand-edited duplicate
becomes a second, *wrong* source of truth about where a package's code lives —
consulted at exactly the moment the client has no other answer to check it
against.

Three properties of the generator are worth knowing if you read its output:

- **Only first-party packages are included** — those whose `repo_url` is
  `https://github.com/M1778/<repo>`. That is what the index is for, and it also
  means a development seed cannot leak into a published index: a local database
  full of invented packages pointing at repositories that do not exist produces an
  empty index, not seven wrong answers. The script prints how many rows it
  excluded, which is the number to check before committing a diff.
- **Yanked versions are excluded from `latest_version` and from nothing else.** A
  version stored as something that is not valid semver is skipped and reported,
  never string-ordered into place.
- **`registry_url` comes out of the pointer, or comes out `null`.** The generator
  is the only thing that reads `registry/v1/url.txt`, and it does not invent a URL
  when the pointer names none — a pointer of comments produces
  `"registry_url": null`, which is the state published today
  ([§12.2](#122-registryv1urltxt--the-pointer)). A pointer that names a
  *placeholder* is a hard failure instead: nothing is written, because a placeholder
  passes every format rule and would be indistinguishable from a real answer to a
  client.

**Standard library entries are the exception.** The standard library is not in the
register — nothing registered it, so there is no row to read and no trust state to
derive — so those entries are authored, in `scripts/fallback-stdlib.mjs`, and the
generator merges them. They live in a checked-in source file rather than inline in
the generator so that adding one is a data change with a reviewable diff, and the
generator validates them on the same terms as register rows: name rule, first-party
repository, and refusal on a name that collides with a registered package. An
authored entry never passed through registration, so that is the only place the
name rule is ever applied to one — and the rule is **read out of**
`src/lib/package-name.ts` by both `scripts/build-fallback-index.mjs` and
`scripts/check-fallback-index.mjs` rather than restated in them, because a
generator that accepted `http-client` would publish a name the register refuses.

`STDLIB_ENTRIES` is currently **empty, deliberately**. Per `finc`'s own interface
contract the standard library ships *inside the compiler archive*, at
`<exe dir>/../lib/std`, and is resolved from disk — `finn` never fetches it, and it
has no repository of its own to point at. Authoring entries for it would invent a
distribution model that does not exist and make `finn add` clone the compiler
repository. The file and its shape exist so that the day the stdlib does become
separately distributed, the change is one array literal.

### 12.6 The CI job that regenerates it

`.github/workflows/fallback-index.yml` runs the generator against **production
D1** and commits the result. Its own header carries the reasoning in full; this
section is what a reader of the *index* needs to know about how the file gets
there.

**It is currently inert, on purpose.** No `push` trigger, a commented-out
`schedule`, and a manual dispatch that does not commit unless asked. Three
conditions have to be met before it can do anything, and its preflight step fails
on each in one readable line: `master` has to actually carry the generator and the
pointer, `wrangler.jsonc` has to carry a real `database_id` instead of
`REPLACE_WITH_D1_DATABASE_ID`, and someone has to watch the first few runs.

**Reading production D1 from CI needs a credential — there is no way around it.**
D1 has no unauthenticated read path: no public endpoint, and both the REST API and
`wrangler d1` want `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. It needs no
*new* secret, though — those are the same two `deploy.yml` already passes to
`npm run db:apply`, and a token that can apply a migration can read the database.
The credential-free alternative was considered and rejected: deriving the index
from `GET /api/packages` would derive the fallback from the service the fallback
exists to survive, so an outage would produce no index and a serializer bug would
produce a confidently wrong one.

The pipeline, and where each stage can stop:

| Stage | Refuses when |
|---|---|
| preflight | the ref lacks the generator or pointer, the pointer names a **placeholder in URL position**, `database_id` is still a placeholder, `sqlite3` is missing |
| `wrangler d1 export --remote` | the export fails or writes an empty file |
| load into a SQLite snapshot | the dump is cut mid-statement, or a table the generator reads is absent |
| `npm run build:fallback-index` | the pointer file is malformed **or names a placeholder**, a register name is invalid, an authored entry collides |
| `node scripts/check-fallback-index.mjs` | the candidate is malformed, carries a third-party repository, claims a version with no tag or commit behind it, has **lost a name**, has **repointed one**, carries a placeholder `registry_url`, or **disagrees with the pointer** |
| commit | never reached unless every stage above passed *and* the contents changed |

Two properties are worth calling out because they are what make an unattended job
safe to point at this file:

- **The candidate is generated out of the working tree** and copied over
  `registry/v1/packages.json` only after the guard passes. A bad index therefore
  never exists at the published path, not even briefly.
- **The guard is comparative, not just structural.** A truncated database read
  produces a *well-formed* index describing a smaller register — it parses, the
  schema is right, and the diff looks like an ordinary removal. So the guard
  refuses any run where a name disappeared or a `repo_url` moved. Both are safe to
  treat as errors because nothing in the register can do either: there is no
  `DELETE` route, and no route rewrites `packages.repo_url`.

**A timestamp-only diff is not committed.** Entries are sorted for byte-stable
output, so a run against an unchanged register differs from the committed file in
`generated_at` and nothing else. The guard compares the two with `generated_at`
removed and the commit is skipped. Two reasons:

- **`git log registry/v1/` is a security property, not a changelog.** This
  repository is the trust root for package resolution
  ([§12.2](#122-registryv1urltxt--the-pointer)), and its being a *complete and
  meaningful* record of every change to what clients read is worth more than a
  fresh timestamp. Every commit to these paths should mean the answer changed.
- **The client says the field is not a cache directive, in writing.** `finn`
  deserializes `generated_at` into a field it marks dead, with the note that it is
  "the only field that moves when nothing else has, so treating a change in it as
  invalidation would re-download an unchanged index forever". Committing that
  change daily is the write-side of the same mistake.

The cost, stated rather than hidden: a stale `generated_at` no longer
distinguishes "the register has not changed" from "the job has been broken for a
month". The run history is what covers that — a green run that committed nothing
is the liveness evidence, and the job writes the entry counts to its step summary
on every run, including refusals.

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
