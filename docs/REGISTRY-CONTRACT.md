# Finn Registry ↔ Finn CLI: architecture and endpoint contract

**Audience**: whoever works on `finn`, the package manager (separate repository).
**Status**: decisions below are settled unless a section says OPEN.
**Written**: 2026-08-22. **Revised**: 2026-08-25 (rev 8).

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

### Since rev 6

**One decision changed, and it is one you have code for.** Rev 6 stated the name rule as
`^[a-z][a-z0-9]*(-[a-z0-9]+)*$` and §2.10 explained at length why such a name is not always
spellable in Fin source. The owner read that finding and took the other branch: **the rule is now
`^[a-z][a-z0-9]*$`, length 2–64, plus Fin's reserved words, refused at registration.** §2.10 is
rewritten to record the decision and keeps the evidence that produced it.

- **Hyphens, underscores and dots are gone from registry names.** `httpclient` is a name;
  `http-client` is a `400 invalid_name`. Refused, not normalised — the register will not map
  `http-client` to `httpclient` and hand back a name nobody typed.
- **Fin's keywords are refused too**, so `let`, `type`, `string` and the rest can never be claimed.
  The list is derived from `Fin/src/lexer/lexer.l` and lives in
  `src/lib/package-name.ts`; it is today's keywords only, and §2.10 says why not tomorrow's.
- **Every registry name is now a Fin identifier by construction**, so `import <name>;` works for
  every package on the register. That retires the per-name import decision rev 6 asked you to make
  — for *registry* names.
- **It does not retire `finname.rs`.** A GitHub-shorthand dependency is not a registry name and
  keeps its hyphen — `acme/fin-http` is still a legal thing to depend on — so `import_advice` is
  still the right call at `add.rs:76` and `sync.rs:61`. What changed is that it can no longer fire
  for a registry-resolved name.
- **Nothing migrates.** The register holds no registrations, so there is no existing name this
  invalidates. See §6.
- **The list is 58 words, and your `FIN_KEYWORDS` is 57.** The difference is `m1778`, in that
  direction only — diffed both ways. Adjudicated on the planning side rather than settled inside
  either implementation: the lexer is authoritative, `m1778` is genuinely reserved there
  (`lexer.l:209` → `KW_M1778`, a parser production, an `ASTTokenKind`, a codegen arm), and the
  register keeps it. **Your list is a strict subset and the gap is a ticket, not a request** —
  omitting `m1778` from `FIN_KEYWORDS` costs one warning nobody printed, whereas omitting it here
  would have let somebody claim a keyword. **And a warning for whoever tightens `finn` next:**
  `Fin/src/diagnostics/DiagnosticEngine.cpp` looks like the keyword list you want and is not one —
  it is diagnostics-only and names eight words the lexer does not reserve (`bez`, `beton`,
  `elseif`, `self`, `short`, `uint`, `ulong`, `ushort`). Derive from the lexer. §2.10 has the
  detail.

### Since rev 5

**Three of your asks are answered here, and none of them changes a payload.** Asks 3, 7 and 9
needed a document rather than an endpoint; they are now §2.9, §2.10 and §2.11. Two of the three
say yes and stop; the third comes back with a finding.

- **§2.9 answers ask 3 — trust is package-level, and that is a guarantee, not an accident.**
  `versions` has no trust column and will not grow one. A version inherits its package's level, so
  a level read from `GET /api/packages/:name` is the level for every version of it. You called this
  *"the only open question that changes my control flow rather than my structs"*; the control flow
  is one resolve, cached per package, no per-version trust fetch.
- **§2.10 answers ask 7 — the rule is `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, length 2–64, and it is
  *not* safe as a bare Fin identifier.** That is the finding, and it is a real one: you asked the
  right question. A hyphenated name cannot be written as `import http-client;` at all, and about
  thirty otherwise-legal registry names collide with Fin keywords. One import form does work for
  every legal name, and §2.10 says which and why. **This constrains what `finn` writes on disk and
  what it can tell a user to type.** Nothing about the registry changes.
  *Superseded in rev 7: the finding was accepted and the rule was narrowed instead, so a registry
  name now always is safe as a bare Fin identifier. The analysis is still in §2.10 as the evidence.*
- **§2.11 answers ask 9 — a published version record is immutable, permanently.** Your argument is
  the one that settles it: ***"`finn.lock` is meaningless without it."*** §2.11 also says what
  happens when a publisher moves a tag, which is the case the guarantee is actually about.
- **§3's base-URL premise is replaced.** Rev 5 said the hostname was not settled and that we would
  send you the final one. There is no hostname to send: the registry base URL is now **discovered
  at run time** from a pointer file this repository publishes on its default branch. §3 carries the
  precedence, `REGISTRY-API.md` §12 carries the file formats, and `Sync.md` §3.1 carries the
  design. §5.7 changes from a literal to correct into a tier to implement.

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
^[a-z][a-z0-9]*$      length 2–64, and not a Fin reserved word
```

Lowercase ASCII letters and digits, starting with a letter. **No hyphens, no underscores, no dots**,
no uppercase — so a name is never two names that differ only by case or separator, and it is always
safe as a directory name, a URL segment and a TOML bare key. Narrowed in rev 7; the rule up to rev
6 allowed single interior hyphens.

**It is a bare Fin identifier, and that is now the point of the rule.** Fin's `ID` is
`{ALPHA}({ALPHA}|{DIGIT})*` over `ALPHA [a-zA-Z_]`, so this grammar is a strict subset of it, and
the reserved-word list closes the remaining gap. `import <name>;` therefore compiles for every name
the register can issue. §2.10 has the evidence, the keyword list and the arguments that were
weighed.

The registry enforces this at registration (`validatePackageName` in `src/lib/package-name.ts`,
called from `src/app/api/[[...route]]/router.ts`). Please apply the same rule in the CLI when
parsing `finn add <input>`: anything that fails it and contains no slash is a malformed name, which
you can reject locally without a network round trip. (A slash still means GitHub, always.) Two
cautions if you do:

- **Your copy of the keyword list can only ever be advisory.** It is a copy of a third project's
  grammar and can fall out of date, and the failure modes are not symmetric: a name your list
  misses is a warning you did not print, whereas an install you refuse for a name the register
  issued is a package the user cannot have. Keep `FIN_KEYWORDS` warning-only. The registry's copy
  decides, because the registry's copy is the one that has to say no while a rename is still free.
- **Do not apply it to GitHub shorthand.** `acme/fin-http` contains a slash and a hyphen and is a
  perfectly good dependency; the name rule is about names the register issues, nothing else.

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

**This is implemented as of 2026-08-25**, and the paragraph that used to stand here — "Today
`install.rs:15` hard-fails on anything with `is_official: false`" — no longer describes `finn`.
The field is gone from the CLI entirely: `is_official` now appears in `finn/src/` only inside
comments recording its removal. Kept because the reasoning is still the reason the table below is
shaped this way: the refusal, combined with §2.1, blocked *every* `owner/repo` install by default,
which trained users to pass the escape-hatch flag reflexively and so destroyed the signal it was
protecting.

The policy:

| Level | Behaviour |
|---|---|
| `verified`, `trusted` | Print one provenance line. Proceed. |
| `recognized` | Print one-line notice. Proceed. |
| `unrecognized` | **Prompt**: show the source, ask whether to install anyway, default **No**. |

- `--verified-only` (or a `finn.toml` setting) refuses anything below `trusted`.
  - The flag's name is narrower than its rule, and the rule is the one to hold to: it means
    *vouched for*, not `level == verified`. `verified` and `trusted` both pass, because both
    carry a human judgement; `recognized` does not, and neither does a level this build of finn
    cannot parse. `vouched_for()` in `finn/src/trust.rs` is the single place that decides, which
    is what keeps the provenance line and the refusal from describing a level differently.
- `--yes` accepts the prompt non-interactively.
- **Non-interactive contexts must not hang.** With no TTY and no `--yes`, an `unrecognized`
  package fails closed with a message naming the flag.
- The `is_official` field on `PackageSource` goes away; `trust.level` replaces it.
- **`--ignore-regulations` stays**, and is narrowed to one check: the package **layout** sniff in
  `validate_package` (`finn/src/validator.rs`), which looks for the files a package is expected
  to have. It cannot switch off a trust decision, and `finn install` no longer consults it when
  deciding about a source.

  Why it survives when the refusal it used to bypass does not: one flag stood in front of two
  unrelated gates, and only one of the two was a fake trust signal. Skipping a file-existence
  check on a package you are looking at is an ordinary thing to want. "Regulations" also
  appearing to waive provenance is what trained people to pass the flag reflexively, which is
  what made the refusal worthless. So the layout half keeps the flag and the provenance half is
  gone, and the warning names which one is being skipped rather than leaving the reader to
  assume the wider meaning:

  > `[WARN] Skipping the package layout check (--ignore-regulations). This says nothing about
  > where the package came from or who vouches for it.`

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

### 2.9 Trust is package-level, and version endpoints will never carry it

**Answers your ask 3.** You called it *"the only open question that changes my control flow rather
than my structs"*, which is exactly right, so here is the guarantee in the form your control flow
needs it.

**A trust level belongs to a package, not to a version.** `versions` has no trust column
(`src/lib/db/schema.ts`), nothing computes a per-version level, and no version response has ever
carried one. That is not an omission waiting to be filled in — it is the model:

- The two signals trust is derived from are both package-scoped or publisher-scoped.
  `packages.is_trusted` is set on a package by a moderator (§2.7); `users.is_verified` is set on an
  account by an admin (§2.3). Neither has a version to attach to. There is no reviewer act in the
  system whose subject is a version.
- Repo ownership, the third input, is proved once against the repository at registration (§2.2) and
  is `true` for any row that exists at all.

So: **a version inherits its package's trust level, and the inheritance is total.** One resolve of
`GET /api/packages/:name` gives you the level for every version of that package, past, present and
future. Cache it per package. Do not fetch per version, do not diff levels between versions, and do
not build a UI element that could ever show two versions of one package at two different levels —
there is no state in this system that produces that.

**What this deliberately gives up.** A moderator cannot vouch for `http@1.2.0` and withhold the
vouch from `http@1.3.0`. If `1.3.0` turns out to be bad, the lever is not a downgraded version
level; it is `yanked` on that version record (§3.3), which is orthogonal to trust and which you
already read. Trust answers *do we know who this is*; yanking answers *is this specific release
safe to install*. Collapsing them into one per-version field would make both worse, because a
withdrawn vouch and a withdrawn release want different words in front of a user.

**If this ever changes, it changes by adding, and you will not have to guess.** A per-version level
would arrive as a new optional field on the version record, and the rule would be *absent means
inherit*. A `trust` object on `GET /api/packages/:name` will not stop being authoritative, so code
written against this paragraph will still be correct.

### 2.10 The name rule is Fin's identifier grammar

**Answers your ask 7, and rev 7 answers it differently from rev 6.** The rule is the one in §2.1:

```
^[a-z][a-z0-9]*$      length 2–64, and not a Fin reserved word
```

Lowercase ASCII letters and digits, starting with a letter. No uppercase, no hyphens, no
underscores, no dots. The registry enforces it at registration — `validatePackageName`,
`NAME_RULE`, `NAME_MIN`, `NAME_MAX` and `FIN_RESERVED_WORDS`, all in `src/lib/package-name.ts`,
called from `src/app/api/[[...route]]/router.ts`. Apply it in the CLI too: an input that fails it
and contains no slash is a malformed name you can reject with no network round trip. A slash still
always means GitHub (§2.1).

**Rev 6 said this rule was not safe as a bare Fin identifier and put the consequence on you. That
was the wrong place to put it.** The owner's ruling: the register should not issue a name that
cannot be written in the language the register exists to serve. So the grammar moved instead of the
CLI. The rest of this section is the analysis that produced the old answer, kept because it is the
evidence for the new one — and because two of its three findings are still live for names the
register does *not* issue.

**What changed for you, concretely.** For a registry-resolved name: nothing has to be chosen any
more, `import <name>;` always compiles, and the per-name branch is dead code for that path. For a
GitHub-shorthand or Git-URL source: nothing changed at all, because those names are GitHub's and
keep their hyphens. `import_advice` stays where it is.

**Your reason for asking is the important part, and it turned up a problem.** You asked because *a
registry name becomes a directory name and therefore an import name in Fin source*. Under rev 6's
rule those were two different claims and only the first held. Under rev 7's rule both hold, which is
the entire purpose of the change.

**As a directory name and a URL segment: safe, unconditionally.** `[a-z0-9]` needs no escaping in
a path or a URL, needs no quoting in a shell, and is a bare TOML key. Because the rule is
lowercase-only there is no case-folding collision on macOS or Windows — two distinct registry names
can never land in the same directory. One filesystem caveat rather than a language one: `con`,
`prn`, `aux`, `nul`, `com1`–`com9` and `lpt1`–`lpt9` all satisfy the rule and are **reserved device
names on Windows**, where a directory by that name cannot be created. Narrowing the grammar did not
remove them and deliberately does not reserve them: they are not Fin keywords, they are one
platform's device table, and a registry that refused `aux` would be encoding Windows into a language
that does not care. That is a client-side layout concern, not a registry one — but it is yours,
since you are the one making directories.

**As a bare Fin identifier, under rev 6's rule: no, and this was a finding, not a formality — it is
what got the rule changed.** Fin's identifier is
`[a-zA-Z_]([a-zA-Z_]|[0-9])*` (`Fin/src/lexer/lexer.l`, the `ID` macro) — **no hyphen**. `-` lexes
as `MINUS`. And Fin's import grammar has six productions
(`Fin/src/parser/parser.y`, `import_statement`), of which the unquoted ones take `IDENTIFIER`
sequences. Verified against a built `finc`, with a package directory actually on the search path:

| Written in Fin source | Result |
|---|---|
| `import { greet } from "http-client";` | **compiles, and binds the symbol** |
| `import "http-client";` | compiles — but see below |
| `http-client.greet()` | `error: Undefined variable 'http'` + `Undefined variable 'client'` |
| `import http-client;` | `error: syntax error, unexpected MINUS, expecting KW_AS or SEMICOLON or DOUBLE_COLON` |
| `import "http-client" as hc;` | `error: syntax error, unexpected KW_AS, expecting SEMICOLON` — the grammar has no aliased *quoted* import |
| `import type;` | `error: syntax error, unexpected KW_TYPE` |

Three separate problems, in increasing order of nastiness:

1. **A hyphen cannot appear in an unquoted import.** `import http-client;` is a syntax error, and
   so is `import http-client.sub;`. Only the quoted forms can name a hyphenated package.
2. **A plain quoted import of a hyphenated package compiles and is then unusable.** `import
   "http-client";` succeeds, and the analyzer binds the module to a namespace symbol whose name is
   the path stem — literally `http-client`
   (`Fin/src/semantics/impl/Analyzer_Decl.cpp`, the no-targets branch of `visit(ImportModule&)`).
   No expression can spell that symbol, and there is no `import "…" as alias` production to rename
   it. So the import silently binds something unreachable: a green compile that gave the user
   nothing. This is the worst of the three, because nothing reports it.
3. **Keywords were legal registry names.** `type`, `class`, `if`, `in`, `as`, `do`, `fn`, `for`,
   `let`, `new`, `try`, `any`, `pub`, `priv`, `from`, `enum`, `null`, `true`, `false`, `super`,
   `while`, `break`, `macro`, `static`, `import`, `struct`, `return`, `extern`, `sizeof`, `typeof`,
   `operator`, `interface`, `implements`, `m1778` and the rest all satisfied rev 6's name rule.
   Every one of them is a syntax error in an unquoted import, and all of them work quoted. Rev 7
   refuses all of them at registration.

**What survives all three:** `import { A, B } from "<name>";` — the named quoted import. It works
for every name rev 6's rule permitted, hyphenated and keyword-colliding alike, because the path is a
string literal and the bound names are the *exported symbols*, which are Fin identifiers chosen by
the library author rather than by whoever claimed the registry name. Confirmed compiling for both
`"http-client"` and `"type"`. That property is why the reserved-word list is only today's keywords —
see below.

**The decision: the rule narrowed, and the constraint left the CLI.** Rev 6 ended this section by
naming `^[a-z][a-z0-9]*$` plus a keyword denylist as the registry-side alternative and rejecting it.
The owner reversed that. It is now the rule. Two of rev 6's three "yours" items survive the reversal
and one is retired:

- **Keep installing to a directory named exactly the registry name.** Unchanged, and now trivially
  safe: the name is an identifier, so the directory is one too.
- **Do not "fix" anything by normalising a name into an identifier.** Unchanged, and the registry
  holds itself to it: a refused name is refused, never rewritten. `http-client` does not become
  `http_client` or `httpclient` server-side. Two spellings of one package is a fact neither of us
  should invent — the same rule as never inventing a version.
- **Retired: choosing the import form per registry name.** There is nothing left to choose for a
  registry name. Keep choosing it for GitHub shorthand and Git URLs, where hyphens are still real.

**The two arguments rev 6 rejected this with, and what answers them.**

- *"It bans hyphens, which is the separator every comparable ecosystem's users expect."* True, and
  it is the real cost. What it buys is that the most obvious thing a user can write —
  `import <name>;` — always works. The rev 6 alternative was a register where the obvious form is a
  syntax error and the next-most-obvious form compiles green while binding a symbol no expression
  can spell (finding 2 above, the one nothing reports). Multi-word names run together, and the
  *repository* keeps its hyphen: `acme/fin-http` publishes `http`, which was already the convention
  in §2.1.
- *"A keyword denylist pins registry validation to the compiler's grammar, so adding a Fin keyword
  would retroactively invalidate a registered name."* This one is answerable, and the answer is why
  the list is deliberately not forward-looking. The check runs **only at registration** —
  `validatePackageName` has exactly two call sites, the `POST /api/packages` handler and the browser
  form, and no lookup, resolve, search or version endpoint validates a name — so no future edit to
  the list can unregister anything or make an existing package unresolvable. And if Fin gains a
  keyword that an existing package already holds, that package keeps
  `import { A, B } from "<name>";`, which never lexes the name at all. A future keyword therefore
  costs a name five of its six import forms and leaves it installable and usable. That is a
  degradation, not an invalidation, and it is not worth reserving `select`, `union`, `assert`,
  `some`, `none`, `with` or `go` today to prevent.

**What is reserved is exactly what the lexer has today**, derived mechanically from the keyword
rules in `Fin/src/lexer/lexer.l` and filtered to the strings a registry name could actually be —
`^[a-z][a-z0-9]*$`, two characters or more. Entries that cannot be spelled as a name (`Self`,
`as_ptr`, `#for`, `#index`) are excluded, because a reserved word no name can collide with is dead
weight. `src/lib/package-name.ts` carries the list and the derivation note; the test suite asserts
every entry is a name the register could otherwise have issued, so dead weight cannot creep in.
Two countings agree on 58: the lexer's 60 explicit keyword rules less `Self` and `as_ptr`, or every
quoted literal in the same region less those two, `#for`, `#index` and the operators `->`, `::`,
`=>`.

**Two notes on the list, both of which matter more to you than to us.** First, `m1778` is on it and
is the one entry that does not look like a keyword: `lexer.l:209` → `KW_M1778`, with a parser
production, an `ASTTokenKind` and a codegen arm, written `blame m1778;`. It matches the narrowed rule
exactly, it is the project owner's own handle — so among the likelier names anybody would try — and
it is **missing from `FIN_KEYWORDS`**. Had this list been copied from `finn` instead of derived from
the lexer, that is the single name that would have slipped through. Second,
`Fin/src/diagnostics/DiagnosticEngine.cpp` is **not** the source and must not become one: it is a
diagnostics list for highlighting and suggestions, and it names eight words the lexer does not
reserve (`bez`, `beton`, `elseif`, `self`, `short`, `uint`, `ulong`, `ushort`). Reserving one of
those would cost a registrant a legal name and nothing would fail to reveal it.

### 2.11 A published version record is immutable

**Answers your ask 9, and your phrasing is what settles it:** ***"`finn.lock` is meaningless
without it."*** That is not rhetoric; it is the whole argument. A lockfile is a promise that a
resolved coordinate keeps resolving to the same bytes. If the registry may rewrite what a version
record points at, then a lockfile pins a name to a row that can change under it, and the file
records nothing that a fresh resolve would not have produced anyway.

**The guarantee.** Once a version record exists for `<name>@<version>`, its `version`, `tag` and
`commit` never change. Not corrected, not repointed, not tidied. A version is not deleted either:
the only lever over a published version is `yanked`, which is additive, reversible, and leaves the
coordinate resolvable so that a lockfile already pinning it keeps working (§3.3). Yanking removes a
version from *selection*, never from *existence* — those are different operations and the
distinction is the reason `yanked` is a flag rather than a `DELETE`.

**What happens when a publisher moves a tag.** This is the case the guarantee is actually about,
because it is the one that happens by accident. Suppose `v1.2.0` was recorded at commit `abc123`,
and the publisher force-pushes the tag to `def456`:

- **The registry does not notice, and does not follow.** It stores `commit` at the moment the
  version is recorded and never re-reads the repository. `abc123` is what the record says a week
  later and a year later. Deliberately: a registry that chased a tag would silently change what a
  lockfile resolves to, which is precisely the failure the immutability guarantee exists to prevent.
- **The record is now a claim about a commit the tag no longer names**, and that is the correct
  state for it to be in. It is *evidence of a discrepancy*, which a mutable record would have
  destroyed. `commit` is the coordinate to check out; `tag` is provenance, and the honest thing for
  a client to do is prefer the commit and treat a mismatch as a signal.
- **What `finn` should do:** resolve by `commit`, not by `tag`, wherever the record gives you both.
  If you fetch by tag and get a commit that is not the one on the record, that is not a
  hash-mismatch error to retry — it is history having been rewritten upstream, and it deserves a
  message that says so and names both commits. Do not silently accept the new one, and do not
  report it as a network problem.
- **What the registry will do:** nothing automatic. A moved tag is a moderation matter, and the
  levers are the ones that already exist — `yanked` on the affected version, and, if it is a
  pattern, `is_trusted` withdrawn on the package with a minute recorded against it (§2.8). Neither
  lever edits the record, which is the point.

**Where the guarantee is currently free.** Nothing in this codebase has ever written to `versions`
(§6, and `REGISTRY-API.md` §10.1). So immutability is trivially true today, and this section is
here to be written down *before* the write path exists rather than after — because whatever writes
version records has to be built to honour it, and "insert only, no update, no delete" is a much
easier constraint to design in than to retrofit. `Sync.md` §3.2 tracks how records come to be
written at all; this section constrains it.

---

## 3. Endpoint contract

**Base URL**: `<registry>/api`

**The base URL is discovered, not configured — and this supersedes rev 5's version of this
paragraph.** Rev 5 said the hostname was unsettled and that we would send you the final one. There
is nothing to send. The registry has no stable hostname and is not expected to get one, so the
current base URL is **published in this repository, on the default branch**, and `finn` fetches it:

```
https://raw.githubusercontent.com/M1778/finn-registry/HEAD/registry/v1/url.txt
```

Precedence, in the order a client must apply it:

| Tier | Source | Notes |
|---|---|---|
| 1 | `[registry].url` in `finn.toml` → `FINN_REGISTRY_URL` → an explicit argument | what `finn/src/registry.rs:38-41` already does, minus the default. Never overridden by discovery |
| 2 | the pointer file above | plain text, one URL, `#` comments. Format in `REGISTRY-API.md` §12.2 |
| 3 | a compiled-in last-known-good URL | only when tier 2 cannot be fetched at all |

Beside the pointer, on the same branch, is `registry/v1/packages.json` — a generated fallback index
of package → repository for the standard library and the first-party libraries, `schema: 1`, read
when the live API is unreachable. `REGISTRY-API.md` §12 is the reference for both files: exact
formats, the guarantee that `schema` is checked before any other field is read, and why both paths
are permanent API. `Sync.md` §3.1 is the design and carries what each side owes.

Two consequences worth carrying into your own planning. **It decouples our deploy from your
release** — we can move hosts without a `finn` release, and `finn` can ship before we have ever
deployed, so the hostname stops being a cross-project blocker. And **the pointer is a trust root**:
push access to this repository redirects package resolution for every user. That is mitigated by the
repository being public, which makes `git log registry/v1/url.txt` a complete public record of every
redirect ever issued — a hostname compiled into a binary could offer nothing comparable.

**Two things about it are not true yet, and you should know both.** The pointer publishes **no URL
at all** — it is comments only — because nothing has been deployed and a `workers.dev` account
subdomain is not knowable before the first publish; and both files currently live on
`feat/registry-implementation`, not on the default branch, so **`HEAD` 404s for both until that
branch merges.**

It used to end with a placeholder (`…REPLACE-WITH-ACCOUNT-SUBDOMAIN…`), and that was removed on
purpose: it satisfies every rule the format states — https, a non-empty host, no trailing slash, no
path — so you cannot tell it from a real answer. You would accept it, cache it for 24 hours, fail
to connect, and report the registry as *unreachable* when the truth is that it has never been
*deployed*. A file of comments produces the honest failure instead: no URL line, no cache, no
compiled-in default, and a message that says so. Nothing on your side needs to change for that —
`parse_pointer` already errors with *"it contains no URL line"*, and `registry_url: null` in the
index is already handled. Do **not** add a placeholder denylist; the guard belongs where the file is
authored, and `finn-registry` has one (a generator refusal, a CI step, and a test).

Neither is a design problem, but tier 2 does not answer today, which makes your error messages
load-bearing in the meantime. There is no tier 3 to lean on and should not be.

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

`{ "status": "ok", "time": "..." }`. Useful if you want `finn doctor` to report registry
reachability; nothing requires it. (`finn healthcheck` was the name here until §3.10 of
`Sync.md` retired it; the diagnostic that inspects an *installation* is `doctor`.)

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
| `invalid_name`     | 400    | A package name failing the §2.1 grammar, its length bounds, or the reserved-word list |
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

7. ~~**`DEFAULT_REGISTRY` points at the wrong host**~~ — **settled, and settled better than this
   item asked.** `finn` shipped `https://finn-registry.pages.dev`, a Cloudflare **Pages** URL,
   where the registry deploys to Cloudflare **Workers** (ADR-0005) because Pages has no D1 binding
   and every endpoint in §3 is a database read — so a Pages host would have served the static
   pages and 404ed every API route. Rev 5 said we would send you the final hostname; per §3 there
   is no final hostname, and rev 6 proposed demoting the constant to a tier 3 last-known-good.
   What you built is better: `DEFAULT_REGISTRY` is `None` and there is no tier 3, only the pointer
   and your own 24-hour cache of it. That is the right call and we are not asking for it back. A
   wrong URL in a released binary cannot be corrected remotely, and "no such host" and "wrong
   host" both surface to a user as *package not found* for every package — an empty answer is
   recoverable, a confident wrong one is not. Whatever supplied the URL, keep naming it in the
   error: the URL you tried and where it came from. `nowhere_to_ask` already does.

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
| Verification requests (§3.10) plus the reviewers’ bench (§2.7) | Live, covered            |
| `trust` on every response (§2.4)                       | Live — §2.5 is yours              |
| Search envelope (§3.5)                                 | Live                               |
| Pointer file `registry/v1/url.txt` (§3)                | Written — **no URL line yet**, and on a feature branch |
| Fallback index `registry/v1/packages.json` (§3)        | Generated — empty, `registry_url: null`, on a feature branch |
| Name rule narrowed to `^[a-z][a-z0-9]*$` + reserved words (§2.10) | Live, both enforcement sites |

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

**What the test suite covers** (`tests/`), re-measured 2026-08-25 at **374 tests across 19 files**:
dedicated suites for `trust.level` derivation (§2.4), §3.6 health, §3.2 resolve, §3.3 and §3.4
version records, §3.5 search and browse, §3.9 publisher profiles, and both registration endpoints of
§3.10 including their `401`s. Plus, on the browser-only side you do not call but which shares this
code: verification requests, the reviewers' bench, `GET /api/stats`, `GET /api/dashboard/data`, the
proof-of-work gate, and the fallback-index generator. Plus five permanent regression suites, each
pinning a bug that actually happened: no endpoint invents a `1.0.0` version; no forged session token
is accepted; the OAuth state never reaches a parent frame; a request origin is never taken from
headers; and neither discovery file may carry a guessed registry URL.

**What it does not**, corrected 2026-08-25 — **an earlier revision of this paragraph named five
untested surfaces and three of them had tests, which is how finished work gets billed as open.**
What is genuinely still uncovered is the **OAuth sign-in flow end to end**: two regressions pin two
specific historical bugs in it, but nothing exercises the callback from start to finish. Two page
components (`RegisterForm.tsx`, the homepage specimen) have no test at all, because there is no DOM
test harness in this repository and adding one means a lockfile change; they rest on typecheck and
review. None of that weakens what §3 promises you — it is all browser-only surface.

**What "live" does not mean.** It means implemented, typechecked, and — for everything in the
covered list above — covered by the test suite, which drives the real Hono router in Node against a
temporary SQLite file. It does **not** mean exercised on the deploy runtime: of §3, only
`/api/health`, `/api/packages` and a `404` on an unregistered name have been served from `workerd`
with a D1 binding, and that against an empty register (§3.8). It does not mean deployed. Nothing
is deployed yet: `wrangler.jsonc` still carries a placeholder D1 database id, the generated
migrations have never been applied to a remote database, and there is no hostname to be given
(§3, §5.7). So do not point `finn` at a URL and expect an answer. The pointer file is the mechanism
that answers that question from now on — but read the two rows added to the table above before you
rely on it. **Corrected 2026-08-25: the pointer carries no URL line at all, and this paragraph used
to say it carried a placeholder.** That was true for one revision and the placeholder was removed
deliberately, because a syntactically valid guess passes every format rule the file documents and
`finn` would cache it for 24 hours — turning *not deployed yet* into *unreachable*, which is the
failure your own tier-3 decision exists to prevent. `url.txt` is comments only (0 non-comment
non-blank lines) and `packages.json` carries `"registry_url": null`, so `parse_pointer` reports that
no registry deployment is known, which is the honest answer. Both files are still on
`feat/registry-implementation` rather than on the default branch, so `HEAD` 404s for both until that
merges. Discovery is built and
not yet serving; ask us when you are ready to integrate and we will tell you whether it is.

What is waiting on you: §2.5, the `recognized` prompt, which is the only thing that blocks the trust
model being end-to-end; §4.3, whether the CLI wants attribution at all; and, new in rev 6, the
import-form consequence of §2.10 — a hyphenated or keyword-colliding package name is installable and
resolvable but cannot be written as a bare `import`, which is a decision about what `finn` puts on
disk and prints to a user, not about anything the registry serves. §4.1 (what a checksum can honestly
mean) is still open and still hinges on one answer — whether `calculate_package_hash` is reproducible
from a clean clone.
