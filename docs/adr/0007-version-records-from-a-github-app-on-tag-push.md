# Version records are written by a GitHub App on tag push

Nothing had ever written to the `versions` table, so `latest_version` was `null` on every package,
§3.3 returned an empty array and §3.4 404'd for every version of every package. The question was
narrowed until only one thing was being asked: **does the registry acquire a GitHub identity of its
own?** Until now the only GitHub credential it ever held was the registrant's OAuth token, taken
from their session and spent on the push-access check (ADR-0004), which exists for as long as that
person is in a browser. So the registry had no writer, and `finn` — which holds exactly the four
fields a version record needs, in `LockedPackage` — will never hold a credential to submit them
with.

**The answer is yes.** A GitHub App, installed by a publisher on a repository they can administer,
delivers the `push` event; the registry verifies the delivery's signature and inserts one version
record per tag that names a version. Owner's ruling, 2026-08-27.

## Considered options

**A browser form per release.** The only one of the three that composes with the credential model
already in place: the publisher is present, their token is in hand, and `checkPushAccess` already
proves they can push to the repository the tag came from — no new secret, no new identity, nothing
that outlives a session. Rejected because it makes cutting a release a manual act performed
somewhere other than where releases are cut. The publisher has already tagged the commit; `finn`
already knows the version and the commit; asking a person to retype both into a web form is a step
that will be skipped, and it will be skipped selectively — the first release gets recorded and the
next four do not. A register whose version records are *usually* missing is worse than one that has
none at all, because `latest_version: null` is an honest answer that `finn` already handles as the
normal case, while a `latest_version` three releases stale is a wrong answer that resolves.

**Read tags from GitHub at resolve time.** Rejected on three counts, and the third is fatal on its
own. It has no credential at the moment it runs: unauthenticated GitHub REST is 60 requests an hour
per source address, a Worker egresses from shared Cloudflare addresses, so that budget is not merely
tight but shared with strangers and cannot be reasoned about — which means this option needs a
registry-owned *outbound* token, a strictly larger credential than the one below. It puts an
outbound request inside a resolve, against a 10 ms CPU budget and a 100,000-request day (ADR-0005),
so the cost scales with reads rather than with releases. And it cannot honour §2.11: a record read
fresh from GitHub follows a moved tag *by construction*, which is precisely the failure the
immutability guarantee exists to prevent. Making it comply would mean caching the first answer
forever — at which point it is a write path with a worse trigger.

**A GitHub App on tag push.** Chosen.

## Why tag-push won

The event carries all four fields at the moment they become true, and nobody has to be present. It
writes once and never re-reads, which is exactly the shape §2.11 requires: insert only, no update,
no delete. Its cost is one inbound request per release rather than one outbound request per resolve,
which is the direction a free tier can absorb. And consent is explicit and revocable at the
granularity that matters — a publisher installs the App on the repositories they choose, and
uninstalls it without asking us.

**The decisive property, and the reason this is safe to take: the App never calls GitHub.** Every
field of a version record is read out of the delivery payload, so the registry mints no installation
token, holds no App private key, and signs no JWT. What it acquires is a GitHub *identity* — an App
with a name that publishers install — and not a GitHub *credential*. The one long-lived secret is
inbound-only: it can be used to forge deliveries *to us*, and it cannot be used to act as us on
anybody's repository. Both rejected options require the outbound credential this one declines. That
asymmetry, not the automation, is what settles it.

## Consequences

**The secret is `GITHUB_WEBHOOK_SECRET`, it has no default, and it has no degraded mode.** Set with
`wrangler secret put`, never in the committed `wrangler.jsonc`. Unset, the endpoint refuses every
delivery with a `503` that names the variable, the way sign-in refuses and names `APP_URL` rather
than guessing an origin. Do not copy `CAPTCHA_SECRET`'s fallback here: a random per-isolate captcha
key still cannot be forged and costs a reader one extra challenge, whereas a random per-isolate
webhook key rejects *every* delivery, because the other end of this secret is configured on GitHub
and cannot be re-derived. Either the variable is set or the write path is closed. A hardcoded
default would be a published forgery key, which is the hole the removed JWT fallback had.

**Authentication is HMAC-SHA256 over the raw body, and "raw" is load-bearing.** The signature is
compared against `X-Hub-Signature-256` in constant time; the body is read as text *first* and the
verified string is what gets parsed. Verifying a re-serialized parse would verify a different
document — `JSON.parse` then `JSON.stringify` does not round-trip byte for byte — and the signature
would then attest to nothing. `X-Hub-Signature` (SHA-1) is still sent by GitHub and is not accepted:
honouring it offers an attacker a downgrade. A delivery that fails the check is a `401` whose body
was never read.

**Authorisation is the repository, never the payload's opinion of a name.** A delivery may write
only to the package whose registered repository it came from. The name-to-repository binding was
proved at registration with push access (ADR-0004); the delivery supplies the version coordinate and
nothing else. An App installed on a repository nobody registered produces no records at all, and no
field of the payload can widen that.

**A repository is matched by GitHub's immutable numeric id where one is recorded.** `full_name`
changes under a rename or a transfer, and a repository name or an owner login freed by a rename can
be claimed by somebody else — so matching on the URL alone would eventually let a stranger's tag
pushes land on the original publisher's name. The id is captured at registration, out of the same
`GET /repos/{owner}/{repo}` response that proves push access, and a mismatch is refused rather than
followed. A package registered before that column existed has no id and falls back to matching on
the canonical URL; that is the weaker case and it is named rather than hidden.

**A transfer or a rename stops version records silently, and that is the correct failure.** The
registry does not follow a repository that moves. Re-pointing a registered name at a new repository
is an admin act, which ADR-0004's consequences already reserve for transfers and abandoned names.

**An uninstall stops deliveries and changes nothing else.** Records already written stand — §2.11
makes them immutable and there is nothing to clean up. `latest_version` freezes at the last version
the registry was told about, which is honest: it knows what it was told and has stopped being told.
No package is deprecated, yanked or delisted as a side effect. An uninstall is a statement about a
webhook, not about a package.

**A re-delivery is "already recorded", not an error, and a moved tag does not repoint anything.**
The unique index on `(package_id, version)` is what enforces §2.11 here: a second delivery for a
version that exists is refused by the database, and the receiver reports it as already recorded. If
a publisher force-pushes `v1.2.0` to a different commit, the record keeps the original commit and
becomes evidence of a discrepancy — which is what §2.11 asks for, and which an update would destroy.
GitHub retries deliveries, so idempotency is not optional; the index supplies it for free.

**A tag deletion writes nothing.** Creation writes, deletion does not, and the asymmetry is
deliberate: a version is never deleted, and the only lever over a published one is `yanked`, which
is a moderation act with a minute against it (ADR-0006) and not an automatic consequence of
`git push --delete`.

**A tag that is not a version is ignored with a 2xx.** Repositories carry `nightly`, `latest`, `v1`
and dated tags. Refusing those with a 4xx would make GitHub mark the delivery failed and eventually
disable the hook, so the receiver answers `200` with the reason it did nothing. The same is true of
every event that is not a tag creation.

**`commit` is read from `head_commit`, not from `after`.** For an annotated tag the ref points at a
tag object, so the payload's `after` is the tag object's SHA rather than a commit's. `commit` has to
be a commit: it is what a checkout resolves, and §2.11 tells a client to prefer it over the tag and
to treat a mismatch as rewritten history. Recording a tag object SHA would make that signal fire on
every annotated release.

**One delivery can write more than one record.** `packages.repo_url` is not unique, so two
registered names may point at one repository; each gets its own row and each is separately immutable.
D1 has no transaction across statements (ADR-0006 depends on the same fact), so a two-package
delivery can half-fail — which costs nothing here, because every insert is independent and
idempotent and GitHub's redelivery closes the gap.

**`checksum` can never be populated on this path.** The App never sees the bytes (ADR-0001) and a
Worker cannot clone a repository, so a tag-push record carries `version`, `git_ref` and `commit`, and
leaves `checksum` and `checksum_origin` null. This does not settle the open recommendation to drop
both columns in favour of `commit`, but it removes the last route by which they could have been filled
in without a publisher submitting a value by hand.

**`dependencies` still has no writer.** The push payload carries no dependency information, and
reading `finn.toml` out of the repository would need the outbound credential this decision declines.
Out of scope, and out of scope on purpose.

**The registry-wide read limiter still runs in front of this endpoint.** It is not
exempted: it keys on the source address, so a flood from elsewhere cannot spend GitHub's allowance,
and 1000 requests per fifteen minutes is orders of magnitude above any real release rate. The
consequence is named rather than hidden, because a `429` is a delivery failure in GitHub's eyes and
enough of them disable the hook — so if a delivery rate ever approaches that ceiling, the answer is
to give this endpoint its own bucket, not to widen the shared one.

**Nothing is provisioned.** No App exists, no secret is set, and `GITHUB_WEBHOOK_SECRET` is
documented and unset (owner's ruling, 2026-08-27: no deployment). Until an App is created the only
reachable behaviour of the endpoint is the refusal that names the missing variable — which is
therefore the one behaviour with a test that runs against the real, unconfigured deployment.
