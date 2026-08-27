/**
 * Reading a GitHub App delivery: the only path by which a version record is
 * ever written (ADR-0007).
 *
 * Two jobs, both pure, both testable without a database:
 *
 *  1. **Authenticate** the delivery — `verifyDeliverySignature`. The App holds a
 *     shared secret and signs every delivery body with it, so an HMAC match is
 *     the whole of the authentication. There is no session, no token and no
 *     account behind this endpoint.
 *  2. **Read** it — `interpretPush`. Decide whether the push names a version and,
 *     if it does, pull out the three coordinates a version record needs.
 *
 * Deciding *who* the delivery may write for is not here: that is authorisation,
 * it needs the database, and it lives in the route (ADR-0007, "authorisation is
 * the repository, never the payload's opinion of a name").
 *
 * The registry never calls GitHub from this path. Every field of a version
 * record is read out of the delivery, which is what keeps the App an inbound
 * *identity* rather than an outbound *credential* — see ADR-0007.
 */
import { isExactVersion } from "./semver";

/** GitHub's HMAC-SHA256 header. The SHA-1 one is deliberately not read. */
export const SIGNATURE_HEADER = "X-Hub-Signature-256";

/** Which kind of delivery this is. */
export const EVENT_HEADER = "X-GitHub-Event";

const TAG_PREFIX = "refs/tags/";

/** A commit sha, in either object format git supports. */
const COMMIT_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Length-independent, early-exit-free comparison — same reasoning as captcha.ts. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Does this delivery carry a signature the shared secret can account for?
 *
 * `rawBody` must be the body **exactly as it arrived**. Signing a re-serialized
 * parse verifies a different document — `JSON.parse` followed by
 * `JSON.stringify` does not round-trip byte for byte, so key order, number
 * formatting and escaping all drift — and a signature over a document nobody
 * acted on attests to nothing. So the caller reads text first, verifies the
 * text, and parses only what verified.
 *
 * The key is imported per call rather than cached for the isolate. A delivery
 * arrives once per release, so the import costs nothing that matters, and not
 * caching means a rotated secret takes effect on the next request instead of the
 * next isolate.
 */
export async function verifyDeliverySignature(input: {
  secret: string;
  rawBody: string;
  header: string | null | undefined;
}): Promise<boolean> {
  const { secret, rawBody, header } = input;
  if (!secret || !header) return false;

  // `sha256=` and nothing else. Accepting a bare hex digest, or the older
  // `sha1=` header, would hand an attacker a downgrade: they get to pick the
  // algorithm the comparison is made in.
  if (!header.startsWith("sha256=")) return false;
  const offered = header.slice("sha256=".length);
  if (!/^[0-9a-f]+$/i.test(offered)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody) as unknown as ArrayBuffer,
  );

  return sameString(toHex(new Uint8Array(mac)), offered.toLowerCase());
}

/**
 * Is this the database refusing a version record that already exists?
 *
 * The unique index on `(package_id, version)` is what enforces the immutability
 * of a version record (contract §2.11), so this is not an error condition: GitHub
 * retries deliveries, and a retry for a version already recorded is the ordinary
 * outcome. Telling that apart from a real write failure is the whole job here,
 * because reporting a real failure as "already recorded" would lose a release
 * silently, and reporting a retry as a failure would eventually make GitHub
 * disable the hook for every installation.
 *
 * **The message is not on the error thrown.** Drizzle wraps a driver failure in a
 * `DrizzleQueryError` whose own message is `Failed query: insert into "versions"
 * …`, and the constraint is named only on the `cause` beneath it. Matching
 * `err.message` alone therefore matched nothing and turned every retry into a
 * `500` — so the chain is walked, to a bounded depth in case a driver ever hands
 * back a cycle.
 *
 * The sentence matched is SQLite's own, which both engines carry: `@libsql/client`
 * prefixes it with `SQLITE_CONSTRAINT_UNIQUE:` and D1 wraps it in a `D1_ERROR`.
 * Matching on `versions.version` rather than on `versions.` is deliberate: a
 * collision on `versions.id` is a fresh UUID colliding, which is a real fault and
 * must not be reported as an already-recorded release.
 */
const DUPLICATE_VERSION = /UNIQUE constraint failed:[^:]*\bversions\.version\b/i;

export function isDuplicateVersion(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const message =
      current instanceof Error ? current.message : typeof current === "string" ? current : "";
    if (DUPLICATE_VERSION.test(message)) return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

/**
 * The version a tag names, or `null` if it names none.
 *
 * A bare `1.2.0` and a `v`-prefixed `v1.2.0` are the same version; the `v` is
 * punctuation on the tag, not part of the version, and stripping it here is what
 * keeps `versions.version` a semantic version that `compareVersions` can order.
 * The tag itself is kept separately, because it is the provenance half of the
 * record (contract §2.11) and the only string that will find the tag again.
 *
 * Nothing else is guessed at. `release-1.2.0`, `2026-08-27`, `nightly` and `v1`
 * are all tags that are not versions, and inventing a version for them would put
 * a row in `versions` that no `git checkout` can reach.
 */
export function versionFromTag(tag: string): string | null {
  if (!tag) return null;
  const candidate = /^[vV]/.test(tag) ? tag.slice(1) : tag;
  return isExactVersion(candidate) ? candidate : null;
}

/** What a `push` delivery turned out to be. */
export type PushReading =
  | {
      kind: "record";
      /** The semantic version, with no leading `v`. */
      version: string;
      /** The tag as pushed. Stored as `git_ref`: provenance, not the coordinate. */
      tag: string;
      /** The commit the tag resolves to. The coordinate a checkout uses. */
      commit: string;
      /** `owner/repo`, as GitHub spells it. */
      repoFullName: string;
      /** GitHub's immutable numeric repository id, or `null` if absent. */
      repoId: number | null;
    }
  | { kind: "ignore"; reason: string };

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read a `push` payload.
 *
 * Ignoring is a normal outcome, not a failure: repositories push branches far
 * more often than tags, and carry `nightly`, `latest` and dated tags besides.
 * Every ignore carries the reason it ignored, because the alternative — a silent
 * 200 — makes "the App is misconfigured" and "that tag is not a version" look
 * identical from outside.
 */
export function interpretPush(payload: unknown): PushReading {
  const push = (payload ?? {}) as Record<string, unknown>;

  const repository = (push.repository ?? null) as Record<string, unknown> | null;
  const repoFullName = repository ? asText(repository.full_name) : null;
  if (!repoFullName) {
    return { kind: "ignore", reason: "The delivery names no repository." };
  }

  const rawId = repository?.id;
  const repoId = typeof rawId === "number" && Number.isInteger(rawId) && rawId > 0 ? rawId : null;

  const ref = asText(push.ref);
  if (!ref) {
    return { kind: "ignore", reason: "The delivery carries no ref." };
  }
  if (!ref.startsWith(TAG_PREFIX)) {
    return {
      kind: "ignore",
      reason: `"${ref}" is not a tag, and only a tag names a version.`,
    };
  }
  const tag = ref.slice(TAG_PREFIX.length);

  // Creation writes, deletion does not. A version is never deleted (§2.11) and
  // the only lever over a published one is `yanked`, which is a moderation act
  // with a minute against it (ADR-0006) — never a consequence of a `git push
  // --delete`.
  if (push.deleted === true) {
    return {
      kind: "ignore",
      reason: `The tag "${tag}" was deleted. A version record is never deleted (§2.11).`,
    };
  }

  const version = versionFromTag(tag);
  if (!version) {
    return { kind: "ignore", reason: `The tag "${tag}" does not name a version.` };
  }

  // `head_commit`, never `after`. For an annotated tag the ref points at a tag
  // *object*, so `after` is that object's sha and not a commit's. `commit` has
  // to be a commit: it is what a checkout resolves, and §2.11 tells a client to
  // prefer it over the tag and to read a mismatch as rewritten history.
  // Recording a tag object's sha would fire that signal on every annotated
  // release.
  const headCommit = (push.head_commit ?? null) as Record<string, unknown> | null;
  const commit = headCommit ? asText(headCommit.id) : null;
  if (!commit || !COMMIT_SHA.test(commit)) {
    return {
      kind: "ignore",
      reason: `The delivery for "${tag}" carries no head commit, so there is no commit to record.`,
    };
  }

  return {
    kind: "record",
    version,
    tag,
    commit: commit.toLowerCase(),
    repoFullName,
    repoId,
  };
}
