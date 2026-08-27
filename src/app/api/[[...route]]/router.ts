import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import { getDb } from "@/lib/db";
import {
  users,
  packages,
  versions,
  logins,
  organizations,
  verificationRequests,
} from "@/lib/db/schema";
import { eq, like, or, desc, asc, sql, and, inArray, type SQL } from "drizzle-orm";
import { rateLimit } from "@/lib/rate-limit";
import {
  createSession,
  verifySession,
  deleteSession,
  generateRandomString,
  hasRepositoryScope,
} from "@/lib/security";
import { deriveTrustLevel, REPO_OWNERSHIP_CONFIRMED } from "@/lib/trust";
import {
  CAPTCHA_HEADER,
  CAPTCHA_MESSAGES,
  type CaptchaScope,
  issueChallenge,
  verifyCaptcha,
} from "@/lib/captcha";
import { canonicalRepoUrl, checkPushAccess, parseGitHubRepo } from "./github";
import {
  EVENT_HEADER,
  SIGNATURE_HEADER,
  interpretPush,
  isDuplicateVersion,
  verifyDeliverySignature,
} from "./webhook";
import { isoTimestamp, serializePackage, serializeVersionWithRepo } from "./serializers";
import { isExactVersion } from "./semver";
/**
 * §2.1's name grammar, and the only copy of it. `validatePackageName` is
 * enforced here and not only in the browser: the form is a convenience, this is
 * the rule, and these endpoints are reachable with a cookie and `curl`.
 */
import { validatePackageName } from "@/lib/package-name";

/**
 * The read queries these handlers used to define for themselves.
 *
 * The package and publisher *pages* server-render from the same functions, so
 * "latest version", the trust ladder and the publisher resolution order have one
 * definition each and the CLI and the browser cannot disagree about a record.
 * `c.env` is threaded through so a handler that already holds the D1 binding
 * hands it over rather than making the module look it up again.
 */
import {
  dashboardPackageColumns,
  dashboardUserColumns,
  findPackage,
  findPublisher,
  latestVersionOf,
  organizationColumns,
  packageColumns,
  publisherColumns,
  summarizePage,
} from "@/lib/registry/queries";

/**
 * The registry API.
 *
 * There is no `runtime = "nodejs"` export here: the deploy target is Cloudflare
 * Workers via `@opennextjs/cloudflare` (ADR-0005), and Workers does not offer a
 * Node runtime. Everything below has to hold on `workerd`, inside 10 ms of CPU
 * and a 5-million-row-per-day D1 read budget, which is why no handler reads a
 * whole table.
 *
 * Every route in §3 of the contract is public and unauthenticated: the CLI never
 * authenticates (§2.6). The authenticated routes here serve the web UI only.
 */

export const app = new Hono().basePath("/api");

function clientIp(c: any): string {
  const forwardedFor = c.req.header("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return c.req.header("x-real-ip") || "anonymous";
}

/**
 * Rate limits.
 *
 * Reads and writes are budgeted separately (§3.7). The old single limit of 100
 * requests per 15 minutes covered everything, which a `finn sync` over a large
 * dependency graph — or any CI runner behind a shared egress IP — trips
 * immediately.
 *
 * Both limiters key on the caller plus the bucket name rather than the request
 * path, because the default path-based key gives every package name its own
 * allowance and so limits nothing at all on `/packages/:name`.
 */
const readLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: "Too many read requests from this IP. Retry with backoff.",
  keyGenerator: (c) => `${clientIp(c)}:read`,
});

const writeLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: "Too many requests from this IP",
  keyGenerator: (c) => `${clientIp(c)}:write`,
});

/**
 * Framing is denied for everything this router serves.
 *
 * Nothing in this product is meant to be embedded — there is no widget, no embed
 * route, no `iframe` anywhere in `src/` — so this is a flat denial rather than an
 * allowlist. It is here because the sign-in flow is the part that most needs it:
 * the interstitial's URL carries the OAuth `state`, and a scaffold left over from
 * a preview tool used to post that URL to whatever framed the page. The branch is
 * gone; this makes sure its premise cannot come back the next time somebody
 * pastes a block of frame-aware code.
 *
 * Both headers, on purpose. They are not redundant in the way they look:
 * `X-Frame-Options` is not a standard, `ALLOW-FROM` never worked, and it is the
 * only one some older engines honour — while `frame-ancestors` is the one that is
 * actually specified, and the only one that constrains a nested chain of frames
 * rather than just the immediate parent. Sending one and not the other means
 * picking which browsers to protect.
 *
 * `frame-ancestors` is the *only* directive in this CSP, and that is a
 * constraint, not an omission. The proof-of-work bootstrap and the sign-in
 * interstitial are inline `<script>` blocks with no bundle behind them — there is
 * no build step on those pages and no nonce plumbing — so adding `default-src`
 * or `script-src` here would stop sign-in working. A test pins the directive
 * count so that a later, well-meant "let us tighten the CSP" fails loudly rather
 * than silently breaking the gate.
 *
 * Set on the response after `next()`, so it lands on every route, error handler
 * and 404 alike rather than only the handlers that remembered to ask. Written as
 * a plain inline handler rather than through `createMiddleware` from
 * `hono/factory`: the factory only adds typing that the `app.use` overload
 * already supplies, and next.config.ts records at length how easily a new module
 * specifier resolves differently under esbuild's `workerd` conditions than under
 * Next's `node` ones. There is no reason to put a new subpath import into the
 * Worker graph for four lines of header setting.
 */
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
});

app.use("*", readLimit);
app.use("/me/*", writeLimit);
app.use("/dashboard/*", writeLimit);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * §3.8: a 5xx from the registry is retryable and must never read as "package
 * does not exist" — only a genuine 404 means that. So a failing query returns an
 * error, and never an empty success that a CLI would cache as absence.
 */
function notFound(c: any, message: string) {
  return c.json({ error: "not_found", message }, 404);
}

function badRequest(c: any, error: string, message: string) {
  return c.json({ error, message }, 400);
}

function internalError(c: any, message: string) {
  return c.json({ error: "internal_error", message }, 500);
}

/**
 * Refuse unless the caller did the work.
 *
 * Returns a response to send, or `null` to carry on. Runs after the session
 * check on every route that has one: an anonymous caller should learn it needs
 * to sign in, not that its proof-of-work was missing.
 *
 * Only browser-facing writes are gated. Everything the CLI reads (§3.2-§3.6,
 * §3.9) is a public GET and is untouched, so this adds nothing for `finn` to
 * implement — see §2.6.
 */
async function requireCaptcha(c: any, scope: CaptchaScope) {
  const token = c.req.header(CAPTCHA_HEADER) || c.req.query("captcha");
  const result = await verifyCaptcha(token, scope);
  if (result.ok) return null;
  return c.json(
    {
      error: "captcha_required",
      reason: result.reason,
      message: CAPTCHA_MESSAGES[result.reason],
    },
    // 428: the request is fine, it is missing a precondition the client can
    // satisfy and retry. A 403 would read as "your account may not do this".
    428,
  );
}

/**
 * ISO-8601 UTC, or `null` when there is no timestamp.
 *
 * `isoTimestamp` degrades an absent or unparseable value to `""` because the
 * CLI-facing records document a string; the browser payloads document
 * `string | null`, so the empty string is mapped through here.
 *
 * Every timestamp the API emits goes through one of these two. SQLite writes
 * `"2026-01-01 00:00:00"` — UTC, but with no `T` and no zone — and `new Date()`
 * reads that as *local* time, so handing a raw column to a client shifts the
 * value by the reader's offset and can land a date on the wrong day. Converting
 * at the boundary means no consumer has to know which convention a field uses.
 */
function isoOrNull(raw: string | null | undefined): string | null {
  return isoTimestamp(raw) || null;
}

/**
 * Now, in the format SQLite's `CURRENT_TIMESTAMP` writes.
 *
 * Written explicitly where a handler has to publish the timestamp it just
 * stored: it keeps one insert to one round trip, and it keeps every stored
 * timestamp in the same text format, which is what makes `ORDER BY created_at`
 * chronological rather than merely lexicographic-by-accident.
 */
function sqliteNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** The signed-in web user, plus whatever the sign-in itself granted. */
interface AuthenticatedUser {
  id: string;
  login: string;
  /** Read from the session row, never from anything the caller supplied. */
  githubAccessToken?: string | null;
  githubScope?: string | null;
}

/**
 * Resolve the signed-in web user, if any.
 *
 * A session token and nothing else. Every field of the returned principal comes
 * from the `sessions` row and the `users` row it points at, so a caller cannot
 * assert who they are — only present a token the register issued.
 *
 * Two other branches used to be here. The API-key branch loaded every row of
 * `api_keys` and ran `scryptSync` against each one on every authenticated
 * request, which on its own can exceed the whole 10 ms CPU budget (ADR-0005),
 * and the table it scanned is gone (§2.6). The JWT branch verified a signature
 * and then returned the token's own claims as the caller's identity, including
 * `id` and `githubAccessToken` — so a forged token could register a package
 * under someone else's account, and inherit their seal. Nothing ever issued one.
 */
async function getAuth(c: any): Promise<AuthenticatedUser | null> {
  const authHeader = c.req.header("Authorization");
  let token = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : (authHeader || c.req.query("token"));

  if (!token) {
    token = getCookie(c, "auth_token");
  }

  if (!token) return null;

  // Session token
  try {
    const session = await verifySession(token, c.env);
    if (session) {
      const currentDb = getDb(c.env);
      const user = await currentDb.select().from(users).where(eq(users.id, session.userId)).get();
      if (user) {
        return {
          id: user.id,
          login: user.login,
          githubAccessToken: session.githubAccessToken,
          githubScope: session.githubScope,
        };
      }
    }
  } catch (err) {
    console.error("[AUTH] Session verification error:", err);
  }

  return null;
}

/**
 * The origin this deployment answers on, or `null` if nobody configured one.
 *
 * Configuration is the only source. This used to fall back to `x-forwarded-host`
 * or `host` when neither variable was set, which let a header any client can
 * send help build the `redirect_uri` handed to GitHub — in the authorize URL and
 * again in the token exchange. GitHub caught the consequence, because it matches
 * `redirect_uri` against the OAuth app's registered callback and refuses a host
 * that does not match, so a poisoned origin failed the exchange rather than
 * delivering an authorization code anywhere. That made it latent rather than
 * live, and it is still not a decision a request header gets to take part in.
 *
 * Absent the variable the caller refuses and names it, the way a missing
 * `GITHUB_CLIENT_ID` already does. Guessing would turn "this deployment never
 * set `APP_URL`" into GitHub's opaque `redirect_uri_mismatch`, which reads as
 * "the OAuth app is misconfigured" — a different problem needing different
 * words. Not knowing the origin and guessing it are different things, and only
 * one of them is safe.
 *
 * Callers that only need to point at this site should use a site-relative path
 * instead of calling this: a relative URL cannot be poisoned by anything, and
 * needs no configuration to be correct.
 *
 * `APP_URL` AND NOTHING ELSE, and specifically not `NEXT_PUBLIC_APP_URL`. This
 * read used to be `NEXT_PUBLIC_APP_URL || APP_URL`, which looked like a harmless
 * convenience and was not, because the two are not the same kind of value.
 * `NEXT_PUBLIC_*` is a *build-time* inline: Next substitutes the literal into the
 * compiled output, so a value present on the build machine is frozen into the
 * artifact. `wrangler.jsonc` `vars` are a *runtime* value, and they arrive in
 * `process.env` when the Worker starts. Preferring the inline therefore made the
 * documented configuration mechanism a no-op, and worse than a no-op: with a
 * stray `.env.local` on the build box this function compiled to
 *
 *     function bb(){let a="http://130.185.120.193:3000"; ... }
 *
 * — the minifier saw a truthy constant on the left of `||` and deleted the
 * `process.env.APP_URL` branch outright. The deployment then built its
 * `redirect_uri` from whatever origin the build machine happened to carry, no
 * `APP_URL` could reach it, and the placeholder guard below could never fire
 * because there was no longer a variable for it to test.
 *
 * `src/app/layout.tsx` still reads `NEXT_PUBLIC_APP_URL`, and should: it feeds
 * `metadataBase`, which is baked into prerendered HTML anyway, so build-time is
 * the correct time for it. Same variable name, genuinely different requirement —
 * which is exactly why one function must not serve both.
 */
function configuredOrigin(): string | null {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return null;
  // The repository's placeholder idiom, refused in origin position for the
  // reason `registry/v1/url.txt` sets out: a value that validates but is not an
  // answer is worse than no value, because it turns "nobody configured this"
  // into a failure that describes something else. `wrangler.jsonc` ships
  // `https://REPLACE_WITH_DEPLOYMENT_ORIGIN`, which would otherwise sail through
  // and come back as GitHub's `redirect_uri_mismatch`.
  if (/REPLACE[_-]WITH/i.test(appUrl)) return null;
  return appUrl.replace(/\/$/, "");
}

/** Said in both places that need an origin, so they say it identically. */
const ORIGIN_UNCONFIGURED =
  "APP_URL is not set, so the OAuth callback URL cannot be built. Set it to the origin this deployment answers on — it has to match the GitHub app's registered callback exactly, port included.";

// ---------------------------------------------------------------------------
// §3.6 Health
// ---------------------------------------------------------------------------

app.get("/health", (c) => {
  return c.json({ status: "ok", time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Proof of work (web UI)
// ---------------------------------------------------------------------------

/**
 * Hand out a challenge for one action.
 *
 * Costs one HMAC and no storage, so the ceiling here is generous — it exists to
 * stop the endpoint being used as a free signing oracle, not to ration honest
 * use. A page that solves on mount asks for exactly one of these per form.
 *
 * `login` is not offerable here: the sign-in interstitial issues its own, and a
 * caller able to mint login challenges could pre-solve them in bulk.
 */
app.get(
  "/captcha",
  rateLimit({ windowMs: 5 * 60 * 1000, max: 120 }),
  async (c) => {
    const scope = c.req.query("scope");
    if (scope !== "register" && scope !== "register-check" && scope !== "verify-request") {
      return badRequest(
        c,
        "invalid_scope",
        "Ask for a challenge by scope: register, register-check or verify-request.",
      );
    }
    const challenge = await issueChallenge(scope);
    // Never cached: a reused challenge is a replayed challenge.
    c.header("Cache-Control", "no-store");
    return c.json(challenge);
  },
);

// ---------------------------------------------------------------------------
// Stats (web UI)
// ---------------------------------------------------------------------------

/**
 * Front-page figures.
 *
 * Previously this read every row of `packages` and sorted the result three times
 * in JavaScript, on the busiest page in the app. At 10 ms of CPU per request and
 * 5 million D1 row reads per day that is a correctness problem, not an
 * optimisation (ADR-0005), so each figure is now its own indexed query with a
 * LIMIT or a COUNT.
 *
 * There is no downloads total and no "trending". The registry cannot observe a
 * download — GitHub serves the bytes (ADR-0001, §4.2) — and nothing populates
 * `packages.stars`, so both would be fabricated: ordering by a number that is
 * identical for every row looks like a ranking and is not one. What is published
 * instead is what the registry actually knows: how many names it holds, how many
 * accounts stand behind them, how many version records it has recorded, and
 * which names arrived most recently.
 */
app.get("/stats", async (c) => {
  try {
    const currentDb = getDb(c.env);

    const statsColumns = {
      id: packages.id,
      name: packages.name,
      description: packages.description,
      category: packages.category,
      isTrusted: packages.isTrusted,
      isDeprecated: packages.isDeprecated,
      createdAt: packages.createdAt,
      publisherLogin: users.login,
      publisherVerified: users.isVerified,
    } as const;

    const [packageCount, publisherCount, versionCount, recent] = await Promise.all([
      currentDb.select({ value: sql<number>`count(*)` }).from(packages).get(),
      // Accounts standing behind at least one name, not accounts that signed in.
      currentDb.select({ value: sql<number>`count(distinct ${packages.ownerId})` }).from(packages).get(),
      currentDb.select({ value: sql<number>`count(*)` }).from(versions).get(),
      currentDb
        .select(statsColumns)
        .from(packages)
        .innerJoin(users, eq(packages.ownerId, users.id))
        .orderBy(desc(packages.createdAt), asc(packages.name))
        .limit(8),
    ]);

    // One extra query for the handful of packages on the page, so the UI never
    // has to invent a version number. Never N+1.
    const ids = recent.map((row) => row.id);
    const latestByPackage = new Map<string, string | null>();

    if (ids.length > 0) {
      const versionRows = await currentDb
        .select({ packageId: versions.packageId, version: versions.version, yanked: versions.yanked })
        .from(versions)
        .where(inArray(versions.packageId, ids));

      for (const id of ids) {
        latestByPackage.set(id, latestVersionOf(versionRows.filter((row) => row.packageId === id)));
      }
    }

    const toEntry = (row: (typeof recent)[number]) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      isTrusted: row.isTrusted,
      isDeprecated: row.isDeprecated,
      trustLevel: deriveTrustLevel({
        publisherVerified: row.publisherVerified,
        packageTrusted: row.isTrusted,
        // The register-wide invariant, not a column and not a local `true`: this
        // is a published level for a real row, so it reads the one definition.
        repoOwnershipConfirmed: REPO_OWNERSHIP_CONFIRMED,
      }),
      publisherLogin: row.publisherLogin,
      publisherVerified: row.publisherVerified,
      latestVersion: latestByPackage.get(row.id) ?? null,
      createdAt: isoTimestamp(row.createdAt),
    });

    return c.json({
      totalPackages: packageCount?.value ?? 0,
      totalPublishers: publisherCount?.value ?? 0,
      totalVersions: versionCount?.value ?? 0,
      recentPackages: recent.map(toEntry),
    });
  } catch (err) {
    console.error("[STATS] Error:", err);
    return internalError(c, "Could not read registry statistics.");
  }
});

// Search suggestions (web UI typeahead)
app.get("/search/suggestions", async (c) => {
  const q = c.req.query("q") || "";
  if (q.length < 2) return c.json([]);
  try {
    const currentDb = getDb(c.env);
    const results = await currentDb
      .select({ name: packages.name })
      .from(packages)
      .where(like(packages.name, `%${q}%`))
      .limit(5);
    return c.json(results.map((r) => r.name));
  } catch (err) {
    console.error("[SUGGESTIONS] Error:", err);
    return c.json([]);
  }
});

// ---------------------------------------------------------------------------
// §3.5 Search and browse
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * `trust` filters to a level or better, and takes the glossary levels rather
 * than booleans so that the CLI and the web UI name the same states.
 *
 * `recognized` is the floor — everything in the registry is at least recognized
 * (ADR-0003) — so filtering on it is a no-op rather than an empty result.
 */
function trustFilter(level: string | undefined): SQL | undefined {
  if (level === "verified") return eq(users.isVerified, true);
  if (level === "trusted") return or(eq(users.isVerified, true), eq(packages.isTrusted, true));
  return undefined;
}

/**
 * The orderings the registry can honestly offer.
 *
 * There is no `downloads` and no `stars`. Nothing increments a download count
 * (§4.2 is open) and stars are not recorded, so both would order every row by
 * the same number — the register UI offered exactly those two sorts and they
 * silently did nothing. An unknown value is refused rather than quietly treated
 * as the default, because a sort that appears to work and doesn't is the bug
 * being fixed here.
 */
const SORTS = {
  recent: () => [desc(packages.createdAt), asc(packages.name)],
  updated: () => [desc(packages.updatedAt), asc(packages.name)],
  name: () => [asc(packages.name)],
} as const;

app.get("/packages", async (c) => {
  const q = c.req.query("q")?.trim() || "";
  const sort = c.req.query("sort")?.trim() || "recent";
  const trust = c.req.query("trust")?.trim() || "";
  const limit = parseBoundedInt(c.req.query("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  if (trust && trust !== "verified" && trust !== "trusted" && trust !== "recognized") {
    return badRequest(
      c,
      "invalid_trust",
      `Unknown trust level "${trust}". Expected one of: verified, trusted, recognized.`,
    );
  }

  if (!Object.hasOwn(SORTS, sort)) {
    return badRequest(
      c,
      "invalid_sort",
      `Unknown sort "${sort}". Expected one of: recent, updated, name. ` +
        "The registry does not order by downloads or stars: it measures neither.",
    );
  }

  try {
    const currentDb = getDb(c.env);

    const conditions: (SQL | undefined)[] = [];
    if (q) conditions.push(or(like(packages.name, `%${q}%`), like(packages.description, `%${q}%`)));
    conditions.push(trustFilter(trust));

    const present = conditions.filter((condition): condition is SQL => Boolean(condition));
    const where = present.length > 0 ? and(...present) : undefined;

    const orderBy = SORTS[sort as keyof typeof SORTS]();

    const [totalRow, rows] = await Promise.all([
      currentDb
        .select({ value: sql<number>`count(*)` })
        .from(packages)
        .innerJoin(users, eq(packages.ownerId, users.id))
        .where(where)
        .get(),
      currentDb
        .select({
          id: packages.id,
          pkg: packageColumns,
          owner: publisherColumns,
          organization: organizationColumns,
        })
        .from(packages)
        .innerJoin(users, eq(packages.ownerId, users.id))
        .leftJoin(organizations, eq(packages.organizationId, organizations.id))
        .where(where)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
    ]);

    // One query for the whole page's version records: never one per package.
    const items = await summarizePage(currentDb, rows);

    return c.json({ total: totalRow?.value ?? items.length, items });
  } catch (err) {
    console.error("[PACKAGES] Search error:", err);
    return internalError(c, "Could not search the registry.");
  }
});

// ---------------------------------------------------------------------------
// §3.4 One version record
// ---------------------------------------------------------------------------

/**
 * Exact versions only. A range is refused rather than resolved: range semantics
 * live in the CLI, next to the lockfile and the dependency graph (§1), and
 * quietly resolving `^1.0.0` here would put them in two places.
 *
 * The refusal is a 400 and not a 404 on purpose — `finn` maps 404 to
 * `NotFound`, and "you sent a range" is not "this version does not exist".
 */
app.get("/packages/:name/versions/:version", async (c) => {
  const name = c.req.param("name");
  const version = c.req.param("version");

  if (!isExactVersion(version)) {
    return badRequest(
      c,
      "invalid_version",
      `"${version}" is not an exact version. The registry does not resolve ranges; ask for a version listed by /api/packages/${name}/versions.`,
    );
  }

  try {
    const currentDb = getDb(c.env);
    const pkg = await currentDb
      .select({ id: packages.id, repoUrl: packages.repoUrl })
      .from(packages)
      .where(eq(packages.name, name))
      .get();

    if (!pkg) return notFound(c, `No package named "${name}" is registered.`);

    const row = await currentDb
      .select({
        version: versions.version,
        gitRef: versions.gitRef,
        commit: versions.commit,
        checksum: versions.checksum,
        checksumOrigin: versions.checksumOrigin,
        yanked: versions.yanked,
        createdAt: versions.createdAt,
      })
      .from(versions)
      .where(and(eq(versions.packageId, pkg.id), eq(versions.version, version)))
      .get();

    if (!row) return notFound(c, `Package "${name}" has no version ${version}.`);

    return c.json(serializeVersionWithRepo(row, pkg.repoUrl));
  } catch (err) {
    console.error("[PACKAGES] Version lookup error:", err);
    return internalError(c, "Could not read the version record.");
  }
});

// ---------------------------------------------------------------------------
// §3.3 Version records
// ---------------------------------------------------------------------------

/**
 * Newest first, semver-descending — not `created_at`-descending, which reorders
 * a backfilled `1.9.0` above a `1.10.0`, and not string order, which puts
 * `1.9.0` above `1.10.0` outright.
 *
 * Yanked records are listed. They carry `yanked: true` so a lockfile that
 * already pins one can still be honoured (§3.3); they are only excluded from
 * `latest_version`.
 */
app.get("/packages/:name/versions", async (c) => {
  const name = c.req.param("name");

  try {
    // One lookup covers both halves of this response: whether the name is on the
    // register, and the records under it. `findPackage` reads the version rows to
    // derive `latest_version` anyway, so asking it separately would read them
    // twice.
    const found = await findPackage(name, c.env);
    if (!found) return notFound(c, `No package named "${name}" is registered.`);

    return c.json({ name: found.record.name, versions: found.versions });
  } catch (err) {
    console.error("[PACKAGES] Versions error:", err);
    return internalError(c, "Could not read version records.");
  }
});

// ---------------------------------------------------------------------------
// §3.2 Resolve one package
// ---------------------------------------------------------------------------

/**
 * The endpoint `finn add <bare-name>` calls. Its absence is why that command
 * 404s today, so it is first in the build order (§6).
 *
 * A name is bare and globally unique (§2.1, ADR-0002): a slash always means
 * GitHub and never reaches the registry, which the single-segment route
 * parameter enforces for free.
 */
app.get("/packages/:name", async (c) => {
  const name = c.req.param("name");

  try {
    const found = await findPackage(name, c.env);
    if (!found) return notFound(c, `No package named "${name}" is registered.`);

    // The record itself is the response body — no envelope. §3.2 documents these
    // fields at the top level and `finn` deserializes them there.
    return c.json(found.record);
  } catch (err) {
    console.error("[PACKAGES] Resolve error:", err);
    return internalError(c, "Could not resolve the package.");
  }
});

// ---------------------------------------------------------------------------
// Publisher profile (web UI)
// ---------------------------------------------------------------------------

/**
 * A publisher and the names they stand behind.
 *
 * Not part of the CLI contract — `finn` reads the publisher embedded in a
 * package record — but snake_case all the same, and `items` is byte-for-byte the
 * §3.5 element shape so the browse page and this page share one row component.
 *
 * A login resolves to an account or to an organisation of that name, because
 * that is what a package record's `publisher.login` can be, and a profile link
 * built from one has to land somewhere.
 *
 * An account that has claimed nothing is a 404: per the glossary a publisher
 * *is* an account that registered a package, so "signed in once" does not make
 * one. No download or star totals — the registry records neither (ADR-0001).
 */
app.get("/publishers/:login", async (c) => {
  const login = c.req.param("login");
  const limit = parseBoundedInt(c.req.query("limit"), MAX_LIMIT, 1, MAX_LIMIT);
  const offset = parseBoundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  try {
    // `null` covers both ways this can come up empty — no such login, and a login
    // that exists but has claimed nothing — because neither is a publisher.
    const found = await findPublisher(login, limit, offset, c.env);

    if (!found) {
      return notFound(c, `No publisher named "${login}" has registered a package.`);
    }

    return c.json({ publisher: found.profile, total: found.total, items: found.items });
  } catch (err) {
    console.error("[PUBLISHERS] Profile error:", err);
    return internalError(c, "Could not read the publisher profile.");
  }
});

// ---------------------------------------------------------------------------
// §3.10 Registration (browser only)
// ---------------------------------------------------------------------------

/** Registration is a write and a GitHub API call, so it gets its own ceiling. */
const registerLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (c: any) => `${clientIp(c)}:register`,
});

/** Untrusted free text, kept short so a row cannot be used as storage. */
function trimmedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** A homepage is a link the site will render, so only http(s) is accepted. */
function homepageOrNull(value: unknown): string | null {
  const raw = trimmedText(value, 512);
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function readJsonBody(c: any): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

function unauthorized(c: any, message: string) {
  return c.json({ error: "unauthorized", message }, 401);
}

/**
 * A refusal that the form shows verbatim.
 *
 * Carries both the `{error, message}` shape every other error in this file uses
 * and the `{push_access, needs_scope, repo, reason}` shape §3.10 documents, so a
 * caller that reads either one gets the same sentence.
 */
function checkRefusal(c: any, status: 400, error: string, reason: string) {
  return c.json(
    { error, message: reason, push_access: false, needs_scope: false, repo: null, reason },
    status,
  );
}

/**
 * Can the signed-in user claim a name for this repository?
 *
 * A completed check answers 200 whatever the verdict: "you cannot push there" is
 * a successful check with a negative result, and the form needs the `reason` to
 * show. 4xx is reserved for a request the registry could not act on at all.
 *
 * `needs_scope` separates "not allowed" from "not told" — signing in asks GitHub
 * only for `user:email` (ADR-0004), which cannot see repository permissions, and
 * that is a round trip through incremental authorization rather than a refusal.
 */
app.post("/registrations/check", registerLimit, async (c) => {
  const auth = await getAuth(c);
  if (!auth) {
    return unauthorized(c, "Sign in with GitHub before checking a repository.");
  }

  const challenged = await requireCaptcha(c, "register-check");
  if (challenged) return challenged;

  const body = await readJsonBody(c);
  if (!body) {
    return checkRefusal(c, 400, "invalid_request", "The request body must be JSON.");
  }

  const rawRepo = trimmedText(body.repo_url, 512);
  if (!rawRepo) {
    return checkRefusal(c, 400, "invalid_repo_url", "Name the repository you are claiming.");
  }

  const ref = parseGitHubRepo(rawRepo);
  if (!ref) {
    return checkRefusal(
      c,
      400,
      "invalid_repo_url",
      "That does not look like a GitHub repository. Paste its URL, or owner/repo. " +
        "The registry only records names that point at GitHub.",
    );
  }

  try {
    const access = await checkPushAccess({
      ref,
      accessToken: auth.githubAccessToken,
      hasRepositoryScope: hasRepositoryScope(auth.githubScope),
    });

    return c.json({
      push_access: access.pushAccess,
      needs_scope: access.needsScope,
      repo: access.repo,
      reason: access.reason,
    });
  } catch (err) {
    console.error("[REGISTRATIONS] Check error:", err);
    return internalError(c, "The check could not be completed. Try again in a moment.");
  }
});

/**
 * Claim a name.
 *
 * Push access is checked here, against GitHub, with the signed-in user's token —
 * the `POST /registrations/check` call the form makes first is a courtesy to the
 * user, not evidence. Nothing stops a client from skipping it, so this endpoint
 * assumes it never happened (§3.10, ADR-0004).
 *
 * A registration claims a name; it does not create a release. There is no
 * version record and `latest_version` is `null` — the field that four separate
 * files used to fill in with a fabricated "1.0.0".
 */
app.post("/packages", registerLimit, async (c) => {
  const auth = await getAuth(c);
  if (!auth) {
    return unauthorized(c, "Sign in with GitHub before registering a name.");
  }

  const challenged = await requireCaptcha(c, "register");
  if (challenged) return challenged;

  const body = await readJsonBody(c);
  if (!body) {
    return badRequest(c, "invalid_request", "The request body must be JSON.");
  }

  const nameProblem = validatePackageName(body.name);
  if (nameProblem) {
    return badRequest(c, "invalid_name", nameProblem);
  }
  const name = (body.name as string).trim();

  const rawRepo = trimmedText(body.repo_url, 512);
  const ref = rawRepo ? parseGitHubRepo(rawRepo) : null;
  if (!ref) {
    return badRequest(
      c,
      "invalid_repo_url",
      "A registration points at a GitHub repository. Give its URL, or owner/repo.",
    );
  }

  try {
    const currentDb = getDb(c.env);

    // Checked before GitHub is called so a taken name costs no API budget. The
    // insert below is still the authority: two registrations can race here.
    const existing = await currentDb
      .select({ name: packages.name })
      .from(packages)
      .where(eq(packages.name, name))
      .get();

    if (existing) {
      return c.json(
        {
          error: "name_taken",
          message: `The name "${name}" is already registered. Names are global and first-come (§2.1).`,
        },
        409,
      );
    }

    const access = await checkPushAccess({
      ref,
      accessToken: auth.githubAccessToken,
      hasRepositoryScope: hasRepositoryScope(auth.githubScope),
    });

    if (!access.pushAccess) {
      return c.json(
        {
          error: access.needsScope ? "scope_required" : "push_access_denied",
          message: access.reason,
          needs_scope: access.needsScope,
        },
        403,
      );
    }

    const publisher = await currentDb
      .select({
        login: users.login,
        name: users.name,
        avatarUrl: users.avatarUrl,
        isVerified: users.isVerified,
      })
      .from(users)
      .where(eq(users.id, auth.id))
      .get();

    if (!publisher) {
      return unauthorized(c, "That sign-in no longer matches an account. Sign in again.");
    }

    const inserted = await currentDb
      .insert(packages)
      .values({
        id: crypto.randomUUID(),
        name,
        // The publisher may describe the name differently from the repository,
        // but if they say nothing GitHub's own description is the honest default.
        description: trimmedText(body.description, 500) ?? access.repo.description,
        repoUrl: canonicalRepoUrl(ref),
        // Captured here and nowhere else: this is the one moment the registry
        // has GitHub's own answer for this repository in hand. Without it a
        // later tag-push delivery has only the URL to match on, and a URL is not
        // an identity (ADR-0007).
        githubRepoId: access.repoId,
        ownerId: auth.id,
        homepage: homepageOrNull(body.homepage) ?? access.repo.homepage,
        // The licence is whatever GitHub reports for the repository right now,
        // never what the request claims: a licence is a legal statement about
        // someone's code, and the registry will not repeat an unverified one. No
        // default — absent stays null (§3.10).
        license: access.repo.license,
      })
      .returning();

    const row = inserted[0];

    return c.json(
      serializePackage({
        pkg: row,
        owner: publisher,
        organization: null,
        // Claiming a name is not releasing anything. Never a default version.
        latestVersion: null,
      }),
      201,
    );
  } catch (err) {
    // The unique index on `packages.name` is what actually settles a race
    // between two registrations of the same name; the loser sees it here.
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed: packages\.name/i.test(message)) {
      return c.json(
        {
          error: "name_taken",
          message: `The name "${name}" was registered a moment ago. Names are global and first-come (§2.1).`,
        },
        409,
      );
    }

    console.error("[REGISTRATIONS] Create error:", err);
    return internalError(c, "The registration could not be recorded. Try again in a moment.");
  }
});

// ---------------------------------------------------------------------------
// Version records (§3.3, §3.4) — the GitHub App's delivery endpoint
// ---------------------------------------------------------------------------

/**
 * The only writer of version records anywhere in the registry (ADR-0007).
 *
 * A publisher installs the registry's GitHub App on a repository they can
 * administer; GitHub then delivers a `push` event here, and a push that creates a
 * tag naming a version becomes a row in `versions`. Nobody has to be present, and
 * the registry never calls GitHub back — every field of the record is read out of
 * the delivery, so the App is an inbound identity and not an outbound credential.
 *
 * Not a §3 endpoint, and not for `finn`: no CLI reaches this, there is no captcha
 * on it and there is no session behind it. Its one caller is GitHub, and its one
 * form of authentication is the HMAC below.
 *
 * WHY SO MANY 200s. A GitHub App has *one* delivery URL shared by every
 * installation, and GitHub disables a hook that keeps failing. So a 4xx here is
 * not a message to one publisher — it is a step towards switching the write path
 * off for all of them. The split is therefore: defects in the *request* get a 4xx
 * (unconfigured, unsigned, unparseable), and decisions about a *valid* delivery
 * get a 200 that says what was decided.
 */
app.post("/webhooks/github", async (c) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  // No default, and no degraded mode. `CAPTCHA_SECRET`'s random-per-isolate
  // fallback is safe there because an unforgeable random key only costs a reader
  // an extra challenge; the same fallback here would reject *every* delivery,
  // because the other end of this secret is configured on GitHub and cannot be
  // re-derived. And a literal default would be a published forgery key. So the
  // variable is either set or the write path is closed, and the refusal names it.
  if (!secret || secret.length < 16) {
    return c.json(
      {
        error: "webhook_unconfigured",
        message:
          "This registry has no GITHUB_WEBHOOK_SECRET set, so it cannot tell a " +
          "real delivery from a forged one and accepts neither.",
      },
      503,
    );
  }

  // Text first. The signature covers the bytes GitHub sent, so those are the
  // bytes that must be verified — parsing and re-serializing produces a
  // different document, and a signature over a document nobody acted on proves
  // nothing.
  const rawBody = await c.req.text();

  const signed = await verifyDeliverySignature({
    secret,
    rawBody,
    header: c.req.header(SIGNATURE_HEADER),
  });
  if (!signed) {
    return c.json(
      {
        error: "invalid_signature",
        message: `This delivery has no valid ${SIGNATURE_HEADER}, so its body was not read.`,
      },
      401,
    );
  }

  const event = c.req.header(EVENT_HEADER) ?? "";

  // GitHub sends this when the App is installed, and treats the answer as
  // proof the endpoint exists. It carries no payload worth reading.
  if (event === "ping") {
    return c.json({ status: "ok", event: "ping" }, 200);
  }

  if (event !== "push") {
    return c.json(
      { status: "ignored", reason: `A "${event || "nameless"}" event names no version.` },
      200,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Signed and still unreadable is a defect in the request rather than a
    // decision about it, so this is the one push that gets a 4xx.
    return badRequest(c, "invalid_request", "The delivery body is signed but is not JSON.");
  }

  const reading = interpretPush(payload);
  if (reading.kind === "ignore") {
    return c.json({ status: "ignored", reason: reading.reason }, 200);
  }

  try {
    const currentDb = getDb(c.env);

    const repoRef = parseGitHubRepo(reading.repoFullName);
    // `lower(...)` because GitHub's `full_name` carries the repository's real
    // casing while `repo_url` carries whatever the registrant typed, and SQLite's
    // `=` on text is case-sensitive. GitHub's own comparison is not.
    const urlKey = repoRef ? canonicalRepoUrl(repoRef).toLowerCase() : null;

    const candidates = await currentDb
      .select({
        id: packages.id,
        name: packages.name,
        githubRepoId: packages.githubRepoId,
      })
      .from(packages)
      .where(
        reading.repoId === null
          ? sql`lower(${packages.repoUrl}) = ${urlKey}`
          : urlKey === null
            ? eq(packages.githubRepoId, reading.repoId)
            : or(
                eq(packages.githubRepoId, reading.repoId),
                sql`lower(${packages.repoUrl}) = ${urlKey}`,
              ),
      );

    // The security check, and the reason the id column exists. A package whose
    // recorded id disagrees with the delivery's is a package whose repository
    // moved and whose old `owner/repo` somebody else now holds — so the URL match
    // is refused rather than followed. A null id is a row registered before the
    // column existed: the URL is all there is, and that is the weaker case.
    const eligible = candidates.filter(
      (pkg) => pkg.githubRepoId === null || pkg.githubRepoId === reading.repoId,
    );

    if (eligible.length === 0) {
      return c.json(
        {
          status: "ignored",
          reason:
            `No registered name points at ${reading.repoFullName}. A name is claimed ` +
            "by proving push access (ADR-0004); installing the App does not claim one.",
        },
        200,
      );
    }

    // `repo_url` is not unique, so two names may legitimately point at one
    // repository. Each gets its own row, and each is separately immutable.
    const recorded: string[] = [];
    const alreadyRecorded: string[] = [];

    for (const pkg of eligible) {
      try {
        await currentDb
          .insert(versions)
          .values({
            id: crypto.randomUUID(),
            packageId: pkg.id,
            version: reading.version,
            // The tag as pushed, `v` and all: provenance, not the coordinate.
            gitRef: reading.tag,
            commit: reading.commit,
            // Never populatable on this path. The App does not see the bytes
            // (ADR-0001) and a Worker cannot clone a repository, so an attested
            // checksum would have to be attested by somebody — and nobody is
            // here. Absent beats invented.
            checksum: null,
            checksumOrigin: null,
            yanked: false,
            createdAt: sqliteNow(),
          });
        recorded.push(pkg.name);
      } catch (err) {
        // The unique index on (package_id, version) is what enforces §2.11 here.
        // GitHub retries deliveries, so this is the ordinary case rather than an
        // error: the version is already recorded, and a re-delivery must not
        // repoint it. A tag force-pushed to a different commit lands here too,
        // and the original commit standing is exactly what §2.11 asks for — the
        // record becomes evidence of the discrepancy instead of losing it.
        if (isDuplicateVersion(err)) {
          alreadyRecorded.push(pkg.name);
          continue;
        }
        throw err;
      }
    }

    // D1 has no transaction across statements, so a two-name delivery can
    // half-fail. That costs nothing here: every insert is independent and
    // idempotent, and GitHub's redelivery closes the gap.
    return c.json(
      {
        status: recorded.length > 0 ? "recorded" : "already_recorded",
        version: reading.version,
        git_ref: reading.tag,
        commit: reading.commit,
        recorded,
        already_recorded: alreadyRecorded,
      },
      recorded.length > 0 ? 201 : 200,
    );
  } catch (err) {
    console.error("[WEBHOOK] Version record error:", err);
    // A 5xx is the one thing that should make GitHub retry, and it retries on
    // exactly this. The delivery was genuine and the registry failed, which is
    // the case redelivery exists for.
    return internalError(c, "The version record could not be written. GitHub will retry.");
  }
});

// ---------------------------------------------------------------------------
// Web auth flow
// ---------------------------------------------------------------------------

/**
 * Escapes text for interpolation into an HTML template.
 *
 * The five characters that can end an element, start one, or close an attribute.
 * Everything the error page interpolates goes through this — not because most of
 * today's call sites pass constants we wrote, but because the next person to add
 * one will not check, and one of the current seven already passes GitHub's own
 * `error_description` straight through.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Auth error page.
 *
 * Styles are inlined. This page is reachable when a sign-in has just failed,
 * which is exactly the moment the network is least trustworthy, and it used to
 * pull its entire stylesheet from `cdn.tailwindcss.com` — an error page that
 * needs the network to render is one that goes blank when the network is the
 * thing that is wrong. The handful of rules it actually used are written out
 * below instead; this is not worth a build step.
 *
 * The two links are site-relative on purpose. They point at this site, so they
 * need no origin, and a relative URL cannot be poisoned by a request header.
 */
function authError(c: any, title: string, message: string, details?: string) {
  const detailsHtml = details
    ? `<div class="details">${escapeHtml(details)}</div>`
    : "";

  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Auth Error - Finn Registry</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        *, *::before, *::after { box-sizing: border-box; }
        body {
          font-family: system-ui, sans-serif; background: #09090b; color: #fafafa;
          min-height: 100vh; margin: 0; display: flex; align-items: center;
          justify-content: center; padding: 1rem;
        }
        .card {
          max-width: 36rem; width: 100%; background: #18181b;
          border: 1px solid #27272a; border-radius: 1.5rem; padding: 2rem;
          box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.5);
        }
        h1 { font-size: 1.5rem; font-weight: 700; margin: 0 0 1rem; }
        .message { color: #a1a1aa; margin: 0 0 1.5rem; }
        .details {
          background: rgb(0 0 0 / 0.5); padding: 1rem; margin-bottom: 1.5rem;
          border: 1px solid #27272a; color: #f87171; font-size: 0.875rem;
          font-family: ui-monospace, monospace; overflow-wrap: anywhere;
        }
        .actions { display: flex; gap: 0.75rem; }
        .actions a {
          flex: 1; font-weight: 600; padding: 0.75rem; border-radius: 0.75rem;
          text-align: center; text-decoration: none;
        }
        .primary { background: #f4f4f5; color: #09090b; }
        .secondary { background: #27272a; color: #f4f4f5; border: 1px solid #3f3f46; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>${escapeHtml(title)}</h1>
        <p class="message">${escapeHtml(message)}</p>
        ${detailsHtml}
        <div class="actions">
          <a class="primary" href="/">Return Home</a>
          <a class="secondary" href="/api/auth/github">Try Again</a>
        </div>
      </div>
    </body>
    </html>
  `, 400);
}

/**
 * Where to send the user after signing in.
 *
 * Only a path on this site is ever accepted. An absolute URL, a
 * protocol-relative `//evil.example`, or a backslash-smuggled variant would turn
 * the sign-in endpoint into an open redirect, and a sign-in flow is exactly what
 * a phisher wants one for. Anything unacceptable falls back to the dashboard
 * rather than erroring, because the user did nothing wrong.
 */
function safeReturnPath(raw: string | undefined): string {
  const fallback = "/dashboard";
  if (!raw) return fallback;

  const candidate = raw.trim();
  if (!candidate.startsWith("/")) return fallback;
  if (candidate.startsWith("//")) return fallback;
  if (candidate.includes("\\") || candidate.includes(":")) return fallback;
  if (candidate.length > 512) return fallback;
  if (!/^\/[A-Za-z0-9\-._~/?&=%]*$/.test(candidate)) return fallback;

  return candidate;
}

/**
 * The OAuth scope to request.
 *
 * Signing in asks for `user:email` and nothing more. The wider grant that
 * reading repository permissions needs is requested incrementally, at
 * registration, so that browsing and signing in never demand repository access
 * (ADR-0004) — that is what `?scope=repo` is for, and only the caller's own
 * `/new` flow ever sends it.
 */
function requestedScope(raw: string | undefined): string {
  if (raw === "repo") return "user:email repo";
  if (raw === "public_repo") return "user:email public_repo";
  return "user:email";
}

/**
 * The page that stands in front of the redirect while the browser does the work.
 *
 * `/auth/github` already answered with an HTML shim that bounced the reader on
 * with script, so the sign-in path was never reachable without JavaScript and
 * this adds no new requirement. It also means the five places that link to
 * `/api/auth/github` stay plain anchors: the gate lives behind the link rather
 * than in every call site.
 *
 * The challenge is inlined rather than fetched so this costs one round trip, and
 * the solver is written out longhand because there is no bundle here to import
 * from. It must stay in step with `captcha-shared.ts` — same digest over
 * `salt.nonce`, same leading-zero-bit count. `tests/captcha.test.ts` pins the
 * shared side; if you change the algorithm, change it here too.
 */
function captchaBootstrap(
  c: any,
  challenge: { salt: string; bits: number; exp: number; sig: string },
  nextUrl: string,
) {
  return c.html(`
    <!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Checking...</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="background:#09090b;color:#fafafa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui,sans-serif;">
      <div style="text-align:center;padding:0 1.5rem;">
        <p id="msg" style="font-size:0.9375rem;">Checking your browser...</p>
        <p style="font-size:0.8125rem;color:#a1a1aa;">This takes a moment and needs no input from you.</p>
      </div>
      <script>
        (async function () {
          var salt = "${challenge.salt}";
          var bits = ${challenge.bits};
          var exp = "${challenge.exp}";
          var sig = "${challenge.sig}";
          var next = "${nextUrl}";
          var enc = new TextEncoder();
          function lz(bytes, want) {
            var seen = 0;
            for (var i = 0; i < bytes.length; i++) {
              var b = bytes[i];
              if (b === 0) { seen += 8; if (seen >= want) return seen; continue; }
              return seen + (Math.clz32(b) - 24);
            }
            return seen;
          }
          var BATCH = 256;
          try {
            for (var base = 0; base < 4194304; base += BATCH) {
              var jobs = [];
              for (var i = 0; i < BATCH; i++) {
                jobs.push(crypto.subtle.digest("SHA-256", enc.encode(salt + "." + (base + i))));
              }
              var out = await Promise.all(jobs);
              for (var j = 0; j < out.length; j++) {
                if (lz(new Uint8Array(out[j]), bits) >= bits) {
                  var token = "v1." + salt + "." + bits + "." + exp + "." + sig + "." + (base + j);
                  window.location.replace(next + encodeURIComponent(token));
                  return;
                }
              }
            }
          } catch (err) {}
          document.getElementById("msg").textContent =
            "The check could not be completed. Reload the page to try again.";
        })();
      </script>
    </body></html>
  `);
}

// GitHub auth
// 20 rather than 10: one sign-in now costs two requests here — the challenge
// page and the solved one — so the reader-facing ceiling is unchanged at ten
// attempts per five minutes.
app.get("/auth/github", rateLimit({ windowMs: 5 * 60 * 1000, max: 20 }), async (c) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return authError(c, "Configuration Missing", "GitHub Client ID is not configured.");

  const state = generateRandomString(32);
  const scope = requestedScope(c.req.query("scope"));
  const returnTo = safeReturnPath(c.req.query("return"));

  /*
   * Proof of work before the redirect. Two attempts, because the signing key
   * falls back to per-isolate random bytes when CAPTCHA_SECRET is unset, and a
   * challenge issued by one isolate will not verify in another — a reader
   * should not be dead-ended by that, but they should not loop on it either.
   */
  const presented = c.req.query("captcha");
  // Anything can arrive here, and a NaN would compare false against every bound
  // and then be written back as "NaN" — a redirect loop. Junk counts as a first
  // attempt, which is the safe reading: the bootstrap always writes an integer.
  const counter = Number(c.req.query("cr"));
  const attempt = Number.isInteger(counter) && counter > 0 ? counter : 0;
  const verdict = await verifyCaptcha(presented, "login");

  if (!verdict.ok) {
    if (attempt >= 2) {
      return authError(
        c,
        "Check Failed",
        CAPTCHA_MESSAGES[verdict.reason],
      );
    }
    const challenge = await issueChallenge("login");
    const params = new URLSearchParams();
    if (c.req.query("scope")) params.set("scope", String(c.req.query("scope")));
    if (c.req.query("return")) params.set("return", String(c.req.query("return")));
    params.set("cr", String(attempt + 1));
    // The solver appends the URL-encoded token to this.
    const nextUrl = `/api/auth/github?${params.toString()}&captcha=`;
    return captchaBootstrap(c, challenge, nextUrl);
  }

  setCookie(c, "oauth_state", state, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 600 });
  setCookie(c, "oauth_return", returnTo, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 600 });

  // Checked here rather than at the top of the handler, because this is the
  // first line that actually needs an origin. Checking earlier would turn the
  // proof-of-work interstitial — a documented 200 that has nothing to do with
  // the origin — into a 400 on any deployment that had not set `APP_URL`.
  const origin = configuredOrigin();
  if (!origin) return authError(c, "Configuration Missing", ORIGIN_UNCONFIGURED);
  const redirectUri = `${origin}/api/auth/github/callback`;

  const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${state}`;

  /*
   * The interstitial navigates top-level, unconditionally.
   *
   * It used to branch on whether it was framed, and in the framed case posted
   * the authorize URL to the parent window with target origin "*" instead of
   * navigating — an `OPEN_EXTERNAL_URL` message for a preview tool's parent
   * frame. Nothing in this product ever listened for it; the tool is not part of
   * this product. The branch is deleted rather than narrowed, for two reasons.
   *
   * The URL carries `state` — the login-CSRF token this same response has just
   * set as the `oauth_state` cookie — so the framed case handed the token to any
   * document that framed the page. And the frame check was not a guard around
   * that, it was the condition that selected it: the leak fired only when framed,
   * which is the one circumstance an attacker arranges and no ordinary use
   * produces.
   *
   * A sign-in page has no business inside somebody else's document, so the
   * premise is now denied outright rather than handled: `frameGuard` sends
   * `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'` on every response
   * this router serves, and `headers()` in next.config.ts does the same for the
   * pages. Note the comment must stay out here in TypeScript rather than inside
   * the template below — anything written in there is served to the reader, and
   * naming the old API in the shipped HTML would be both noise and a false hit
   * for anyone grepping the deployed page for it.
   */
  return c.html(`
    <!DOCTYPE html><html><head><title>Redirecting...</title></head><body style="background:#09090b;color:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;">
      <div style="text-align:center;"><p>Connecting to GitHub...</p></div>
      <script>
        window.location.href = "${authorizeUrl}";
      </script>
    </body></html>
  `);
});

app.get("/auth/github/callback", rateLimit({ windowMs: 5 * 60 * 1000, max: 10 }), async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const storedState = getCookie(c, "oauth_state");

  if (!code) return authError(c, "Invalid Request", "No authorization code was provided.");
  if (!state || state !== storedState) return authError(c, "Session Expired", "Authentication session expired. Please try again.");

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const origin = configuredOrigin();
  if (!origin) return authError(c, "Configuration Missing", ORIGIN_UNCONFIGURED);
  const redirectUri = `${origin}/api/auth/github/callback`;

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) return authError(c, "Token Exchange Failed", tokenData.error_description || tokenData.error);

    const accessToken = tokenData.access_token;
    const [userRes, emailsRes] = await Promise.all([
      fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "Finn-Registry" } }),
      fetch("https://api.github.com/user/emails", { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "Finn-Registry" } })
    ]);

    if (!userRes.ok) return authError(c, "GitHub Profile Error", "Failed to retrieve profile information.");
    const githubUser = await userRes.json();
    let primaryEmail = "";
    if (emailsRes.ok) {
      const emails = await emailsRes.json();
      primaryEmail = emails.find((e: any) => e.primary && e.verified)?.email || emails[0]?.email;
    }

    const currentDb = getDb(c.env);
    let user = await currentDb.select().from(users).where(eq(users.githubId, githubUser.id)).get();

    if (!user) {
      const result = await currentDb.insert(users).values({
        id: crypto.randomUUID(),
        githubId: githubUser.id,
        login: githubUser.login,
        email: primaryEmail || githubUser.email || "",
        name: githubUser.name || githubUser.login,
        avatarUrl: githubUser.avatar_url,
      }).returning();
      user = result[0];
    } else {
      await currentDb.update(users).set({
        login: githubUser.login,
        avatarUrl: githubUser.avatar_url,
        name: githubUser.name || githubUser.login,
        email: primaryEmail || user.email || ""
      }).where(eq(users.id, user.id));
    }

    // The token and the scopes GitHub actually granted are kept for the life of
    // the session: registration has to prove push access against the GitHub API
    // as this user (ADR-0004), and the granted scope is what tells the
    // registration form whether that check can even be attempted yet.
    const sessionToken = await createSession(user.id, c.env, {
      accessToken,
      scope: typeof tokenData.scope === "string" ? tokenData.scope : null,
    });
    const userId = user.id;

    try {
      await currentDb.insert(logins).values({
        id: crypto.randomUUID(),
        userId,
        ipAddress: clientIp(c),
        userAgent: c.req.header("user-agent") || "Unknown",
      });
    } catch { }

    // No `domain`, deliberately: the cookie is host-only, scoped to exactly the
    // host that set it and sent to no subdomain. A `domain` attribute used to be
    // set for one vendor's preview hosts and left `undefined` everywhere else;
    // host-only was already what every real deployment got, and it is the
    // tighter scope, so it is now unconditional.
    setCookie(c, "auth_token", sessionToken, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 30 * 24 * 60 * 60,
    });

    // Re-validated rather than trusted: the cookie is httpOnly and set by this
    // server, but a redirect target read back out of a request is exactly the
    // input an open redirect is built from.
    const returnTo = safeReturnPath(getCookie(c, "oauth_return"));
    setCookie(c, "oauth_return", "", { path: "/", maxAge: 0 });

    // Site-relative. `safeReturnPath` guarantees a path beginning with a single
    // `/`, so this lands on this deployment whatever host it answers on, without
    // an origin having to be known or guessed.
    return c.redirect(returnTo);
  } catch (err: any) {
    console.error("[AUTH] Fatal Error:", err);
    return authError(c, "Server Error", "An unexpected error occurred.");
  }
});

app.get("/auth/status", async (c) => {
  const auth = await getAuth(c);
  if (!auth) return c.json({ authenticated: false });
  const currentDb = getDb(c.env);
  const dbUser = await currentDb.select().from(users).where(eq(users.id, auth.id)).get();
  return c.json({ authenticated: true, user: dbUser });
});

app.post("/auth/logout", async (c) => {
  const token = getCookie(c, "auth_token");
  if (token) await deleteSession(token, c.env);
  setCookie(c, "auth_token", "", { path: "/", maxAge: 0 });
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Dashboard (web UI)
// ---------------------------------------------------------------------------

/** One recorded sign-in, as the counterfoil publishes it. */
interface DashboardLogin {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string | null;
}

/**
 * Everything the publisher's own dashboard renders, in one request.
 *
 * Browser-only, so the payload stays camelCase — the snake_case rule is the CLI
 * contract (§3.1) and this is not part of it.
 *
 * **Every section is built from named fields.** Not one of the four returns a
 * Drizzle row, and none of the three queries reads a column the page does not
 * render (`dashboardUserColumns` and `dashboardPackageColumns` in
 * `@/lib/registry/queries`). This was not always true, and what it cost is worth
 * recording: spreading a `packages` row published `downloads` and `stars` on
 * every entry — two columns nothing in this codebase increments — so a publisher
 * was shown a permanently-zero figure about their own package as though the
 * registry had counted something (ADR-0001, and the same decision as §3.5's
 * refusal to sort by either). `tests/api/dashboard.test.ts` pins each section's
 * keys exactly, so a column added to any of these tables cannot arrive on the
 * wire without somebody choosing it.
 *
 * Deliberately absent:
 *
 *  - **`apiKeys`.** The CLI never authenticates, so there are no keys to manage
 *    and the table is gone (§2.6).
 *  - **`githubAnalytics`.** Stars, forks and language shares describe an
 *    account's GitHub presence, not its standing on the register — GitHub
 *    already shows them, and better. Publishing them here made the page read as
 *    popularity analytics, which is the one thing the registry cannot honestly
 *    offer (ADR-0001). Two of its four members were also permanently zero, and
 *    the language percentages were shares of the top five languages rather than
 *    of the account, so they summed to 100 regardless of what it contained.
 *
 * What a publisher genuinely cannot compute for themselves is release state and
 * where their verification request stands, so both are here: each package
 * carries `latestVersion`/`versionCount`, and `verification` reports the account's
 * most recent request.
 *
 * Every timestamp is ISO-8601 UTC via `isoOrNull`, not the raw column. See that
 * function for why a raw SQLite timestamp is a trap for any client that parses
 * it.
 */
app.get("/dashboard/data", async (c) => {
  const auth = await getAuth(c);
  if (!auth) return unauthorized(c, "Sign in to view your dashboard.");

  try {
    const currentDb = getDb(c.env);
    const user = await currentDb
      .select(dashboardUserColumns)
      .from(users)
      .where(eq(users.id, auth.id))
      .get();
    if (!user) return notFound(c, "This account no longer exists.");

    const userPackages = await currentDb
      .select(dashboardPackageColumns)
      .from(packages)
      .where(eq(packages.ownerId, auth.id));

    // One query for the whole page of packages, not one per package: an N+1 here
    // is a round trip per name against a 10 ms CPU budget (§3.8).
    const packageIds = userPackages.map((pkg) => pkg.id);
    const versionRows = packageIds.length
      ? await currentDb
          .select({
            packageId: versions.packageId,
            version: versions.version,
            yanked: versions.yanked,
          })
          .from(versions)
          .where(inArray(versions.packageId, packageIds))
      : [];

    const dashboardPackages = userPackages.map((pkg) => {
      const own = versionRows.filter((row) => row.packageId === pkg.id);
      return {
        // Named one by one rather than spread. A `{ ...pkg }` published every
        // column on the row, which is how `downloads` and `stars` — two figures
        // nothing in this codebase increments — came to be reported to a
        // publisher about their own package as if they were measurements
        // (ADR-0001, §3.5). The same spread also carried `ownerId`,
        // `organizationId` and the `category` default nobody has ever chosen.
        id: pkg.id,
        name: pkg.name,
        description: pkg.description,
        isTrusted: pkg.isTrusted,
        isDeprecated: pkg.isDeprecated,
        createdAt: isoOrNull(pkg.createdAt),
        // Derived by exactly the same rule as §3.2's `latest_version`, yanked
        // records excluded, so a publisher's dashboard and their public package
        // page can never disagree about what the latest version is. `null` means
        // the name is held and nothing has been released under it — the most
        // actionable state a publisher can be in, and the page could not see it
        // before.
        latestVersion: latestVersionOf(own),
        // Every version record, yanked ones included: they are still recorded,
        // and a package showing `versionCount: 3` with `latestVersion: null` is
        // telling the publisher something true and useful.
        versionCount: own.length,
      };
    });

    // Named, for the same reason as the entries above: a sign-in row carries the
    // account's own `userId`, which the page has no use for and which nothing
    // outside the database has any reason to see.
    let userLogins: DashboardLogin[] = [];
    try {
      const rows = await currentDb
        .select({
          id: logins.id,
          ipAddress: logins.ipAddress,
          userAgent: logins.userAgent,
          createdAt: logins.createdAt,
        })
        .from(logins)
        .where(eq(logins.userId, auth.id))
        .orderBy(desc(logins.createdAt))
        .limit(10);
      userLogins = rows.map((row) => ({ ...row, createdAt: isoOrNull(row.createdAt) }));
    } catch (e) {
      console.error("[DASHBOARD] Logins fetch error:", e);
    }

    // Where the account stands *now*, not its application history: one row, the
    // most recent. On a same-second tie a pending row wins, because a pending
    // request is the state the page has to report — the ordering has to be
    // total, and `CURRENT_TIMESTAMP` has one-second resolution, so two rows
    // written moments apart can compare equal.
    const request = await currentDb
      .select({
        status: verificationRequests.status,
        createdAt: verificationRequests.createdAt,
        reviewedAt: verificationRequests.reviewedAt,
        reviewerNote: verificationRequests.reviewerNote,
      })
      .from(verificationRequests)
      .where(eq(verificationRequests.userId, auth.id))
      .orderBy(
        desc(verificationRequests.createdAt),
        sql`case when ${verificationRequests.status} = 'pending' then 0 else 1 end`,
      )
      .limit(1)
      .get();

    // "none" is not "rejected": an account that has never asked and an account
    // that asked and was refused need different words from the page.
    const verification = request
      ? {
          status: request.status,
          requestedAt: isoOrNull(request.createdAt),
          reviewedAt: isoOrNull(request.reviewedAt),
          // The reviewer's reason only. The requester's own `note` is evidence
          // submitted to a human reviewer, not something to read back to them.
          reviewerNote: request.reviewerNote,
        }
      : { status: "none" as const, requestedAt: null, reviewedAt: null, reviewerNote: null };

    return c.json({
      // The spread here is of `dashboardUserColumns`, not of a `users` row — the
      // named list is in `@/lib/registry/queries`, one file with every "which
      // columns does this reader need" answer in it. Spreading a *row* is what
      // this handler used to do, and what put `downloads` and `stars` on every
      // entry above; a column added to `users` cannot arrive here without being
      // added to that list first.
      user: { ...user, createdAt: isoOrNull(user.createdAt) },
      packages: dashboardPackages,
      logins: userLogins,
      verification,
    });
  } catch (err) {
    console.error("[DASHBOARD] Error:", err);
    return internalError(c, "Could not load your dashboard.");
  }
});

app.patch("/me/settings", async (c) => {
  const auth = await getAuth(c);
  if (!auth) return unauthorized(c, "Sign in to change your account settings.");
  try {
    const { name, email, bio, location, blog } = await c.req.json();
    const currentDb = getDb(c.env);
    await currentDb.update(users).set({ name, email, bio, location, blog }).where(eq(users.id, auth.id));
    return c.json({ success: true });
  } catch {
    return internalError(c, "Could not save your settings.");
  }
});

// ---------------------------------------------------------------------------
// Verification requests (browser only)
// ---------------------------------------------------------------------------

/**
 * Long enough to explain who you are and point at evidence, short enough that
 * the review queue stays readable. Measured after trimming.
 */
const NOTE_MAX = 1000;

/**
 * The requester's note: optional, trimmed, `null` when empty.
 *
 * Over-length is a refusal rather than a silent truncation — this text is the
 * case an account is making to a human reviewer, and quietly cutting off the
 * half that mattered is worse than saying no.
 */
function parseRequestNote(value: unknown): { ok: true; note: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, note: null };
  if (typeof value !== "string") return { ok: false };

  const trimmed = value.trim();
  if (!trimmed) return { ok: true, note: null };
  if (trimmed.length > NOTE_MAX) return { ok: false };

  return { ok: true, note: trimmed };
}

/**
 * Ask a human to verify this account (§2.4, ADR-0003).
 *
 * The other half of a promise the docs already make — "verification is
 * requested, then reviewed by a human admin" — which until now had no way to be
 * requested. Browser only: `finn` never calls this, and verification is a fact
 * about a publisher that the CLI only ever reads.
 *
 * Ruling on a request is deliberately **not** here. Approve, reject, trust and
 * untrust are server actions in the admin pages: they need no versioned
 * contract, and keeping them out of the Hono app means the CLI-facing surface
 * stays exactly what §3 documents.
 *
 * Inherits `writeLimit` from `/me/*`.
 */
app.post("/me/verification-request", async (c) => {
  const auth = await getAuth(c);
  if (!auth) return unauthorized(c, "Sign in to request verification.");

  const challenged = await requireCaptcha(c, "verify-request");
  if (challenged) return challenged;

  // A note is optional, so no body at all is a valid request.
  const body = (await readJsonBody(c)) ?? {};
  const parsed = parseRequestNote(body.note);
  if (!parsed.ok) {
    return badRequest(
      c,
      "invalid_note",
      `A note must be text of at most ${NOTE_MAX} characters. ` +
        "Link to the evidence rather than pasting it.",
    );
  }

  try {
    const currentDb = getDb(c.env);

    const user = await currentDb
      .select({ isVerified: users.isVerified })
      .from(users)
      .where(eq(users.id, auth.id))
      .get();
    if (!user) return notFound(c, "This account no longer exists.");

    if (user.isVerified) {
      return c.json(
        {
          error: "already_verified",
          message: "This account is already a verified publisher.",
        },
        409,
      );
    }

    // Checked here for the sentence, enforced by a partial unique index for the
    // race: a double-click fires two requests that can both pass this read
    // before either insert lands.
    const pending = await currentDb
      .select({ id: verificationRequests.id })
      .from(verificationRequests)
      .where(
        and(eq(verificationRequests.userId, auth.id), eq(verificationRequests.status, "pending")),
      )
      .get();
    if (pending) {
      return c.json(
        {
          error: "request_pending",
          message: "A verification request from this account is already awaiting review.",
        },
        409,
      );
    }

    // A previous refusal does not stand in the way: people fix what was wrong
    // and ask again, which is the normal path rather than an abuse case.
    const createdAt = sqliteNow();
    await currentDb.insert(verificationRequests).values({
      id: crypto.randomUUID(),
      userId: auth.id,
      status: "pending",
      note: parsed.note,
      createdAt,
    });

    return c.json({ request: { status: "pending", createdAt: isoOrNull(createdAt) } }, 201);
  } catch (err) {
    if (/UNIQUE constraint failed: verification_requests/i.test(String(err))) {
      return c.json(
        {
          error: "request_pending",
          message: "A verification request from this account is already awaiting review.",
        },
        409,
      );
    }

    console.error("[VERIFICATION] Request error:", err);
    return internalError(c, "Could not submit your verification request.");
  }
});
