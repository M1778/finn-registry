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
  verifyToken,
  createSession,
  verifySession,
  deleteSession,
  generateRandomString,
  hasRepositoryScope,
} from "@/lib/security";
import { deriveTrustLevel } from "@/lib/trust";
import { canonicalRepoUrl, checkPushAccess, parseGitHubRepo } from "./github";
import { isoTimestamp, serializePackage, serializeVersionWithRepo } from "./serializers";
import { isExactVersion } from "./semver";

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
  /** Present only for a session sign-in; a bare JWT carries no GitHub grant. */
  githubAccessToken?: string | null;
  githubScope?: string | null;
}

/**
 * Resolve the signed-in web user, if any.
 *
 * Session cookie or JWT only. There is no API-key branch: it loaded every row of
 * `api_keys` and ran `scryptSync` against each one on every authenticated
 * request, which on its own can exceed the whole 10 ms CPU budget (ADR-0005),
 * and the table it scanned is gone (§2.6).
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

  // JWT (fallback)
  try {
    const payload = await verifyToken(token);
    if (payload) {
      return payload as unknown as AuthenticatedUser;
    }
  } catch (err) {
    console.error("[AUTH] JWT verification error:", err);
  }

  return null;
}

// Get request origin
function getOrigin(c: any) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (appUrl) {
    return appUrl.replace(/\/$/, "");
  }

  const host = c.req.header("x-forwarded-host") || c.req.header("host") || "";
  const proto = c.req.header("x-forwarded-proto") || "https";

  let originHost = host;
  // Handle Daytona/Orchids proxying
  if (host.includes(".proxy.daytona.works")) {
    originHost = host.replace(".proxy.daytona.works", ".orchids.page");
  }

  const origin = `${proto}://${originHost}`;
  return origin.replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// §3.6 Health
// ---------------------------------------------------------------------------

app.get("/health", (c) => {
  return c.json({ status: "ok", time: new Date().toISOString() });
});

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
        repoOwnershipConfirmed: true,
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

/**
 * §2.1 name grammar: lowercase letters, digits, single interior hyphens, must
 * start with a letter. No slash — a slash always means GitHub to `finn`
 * (ADR-0002), so a name containing one could never be resolved as a bare name.
 *
 * Enforced here and not only in the browser: the form is a convenience, this is
 * the rule.
 */
const NAME_RULE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const NAME_MIN = 2;
const NAME_MAX = 64;

/** Registration is a write and a GitHub API call, so it gets its own ceiling. */
const registerLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (c: any) => `${clientIp(c)}:register`,
});

function validateName(name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") {
    return "A name is required.";
  }

  const value = name.trim();
  if (value !== name) {
    return "A name cannot begin or end with whitespace.";
  }
  if (value.length < NAME_MIN) {
    return `A name needs at least ${NAME_MIN} characters.`;
  }
  if (value.length > NAME_MAX) {
    return `A name can be at most ${NAME_MAX} characters.`;
  }
  if (value.includes("/")) {
    return "Names are bare — no slash. A slash always means GitHub to finn.";
  }
  if (!NAME_RULE.test(value)) {
    return (
      "A name uses lowercase letters, digits and single hyphens between them, " +
      "and must start with a letter."
    );
  }

  return null;
}

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

  const body = await readJsonBody(c);
  if (!body) {
    return badRequest(c, "invalid_request", "The request body must be JSON.");
  }

  const nameProblem = validateName(body.name);
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
// Web auth flow
// ---------------------------------------------------------------------------

// Auth error page
function authError(c: any, title: string, message: string, details?: string) {
  const origin = getOrigin(c);
  const detailsHtml = details ? `<div class="bg-black/50 p-4 mb-6 border border-zinc-800 text-red-400 text-sm mono">${details}</div>` : "";

  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Auth Error - Finn Registry</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>body { font-family: system-ui; background: #09090b; color: #fafafa; }</style>
    </head>
    <body class="min-h-screen flex items-center justify-center p-4">
      <div class="max-w-xl w-full bg-zinc-900 border border-zinc-800 rounded-3xl p-8 shadow-2xl">
        <h1 class="text-2xl font-bold mb-4">${title}</h1>
        <p class="text-zinc-400 mb-6">${message}</p>
        ${detailsHtml}
        <div class="flex gap-3">
          <a href="${origin}" class="flex-1 bg-zinc-100 text-zinc-950 font-semibold py-3 rounded-xl text-center">Return Home</a>
          <a href="${origin}/api/auth/github" class="flex-1 bg-zinc-800 text-zinc-100 font-semibold py-3 rounded-xl text-center border border-zinc-700">Try Again</a>
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

// GitHub auth
app.get("/auth/github", rateLimit({ windowMs: 5 * 60 * 1000, max: 10 }), (c) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return authError(c, "Configuration Missing", "GitHub Client ID is not configured.");

  const origin = getOrigin(c);
  const redirectUri = `${origin}/api/auth/github/callback`;
  const state = generateRandomString(32);
  const scope = requestedScope(c.req.query("scope"));
  const returnTo = safeReturnPath(c.req.query("return"));

  setCookie(c, "oauth_state", state, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 600 });
  setCookie(c, "oauth_return", returnTo, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 600 });

  const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&state=${state}`;

  return c.html(`
    <!DOCTYPE html><html><head><title>Redirecting...</title></head><body style="background:#09090b;color:white;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;">
      <div style="text-align:center;"><p>Connecting to GitHub...</p></div>
      <script>
        const url = "${authorizeUrl}";
        if (window.self !== window.top) {
          window.parent.postMessage({ type: "OPEN_EXTERNAL_URL", data: { url } }, "*");
        } else {
          window.location.href = url;
        }
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
  const origin = getOrigin(c);
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

    const domain = origin.replace("https://", "").split(":")[0];

    setCookie(c, "auth_token", sessionToken, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 30 * 24 * 60 * 60,
      domain: domain.includes("orchids.page") ? domain : undefined
    });

    // Re-validated rather than trusted: the cookie is httpOnly and set by this
    // server, but a redirect target read back out of a request is exactly the
    // input an open redirect is built from.
    const returnTo = safeReturnPath(getCookie(c, "oauth_return"));
    setCookie(c, "oauth_return", "", { path: "/", maxAge: 0 });

    return c.redirect(`${origin}${returnTo}`);
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

/**
 * Everything the publisher's own dashboard renders, in one request.
 *
 * Browser-only, so the payload stays camelCase — the snake_case rule is the CLI
 * contract (§3.1) and this is not part of it.
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
    const user = await currentDb.select().from(users).where(eq(users.id, auth.id)).get();
    if (!user) return notFound(c, "This account no longer exists.");

    const userPackages = await currentDb.select().from(packages).where(eq(packages.ownerId, auth.id));

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
        ...pkg,
        createdAt: isoOrNull(pkg.createdAt),
        updatedAt: isoOrNull(pkg.updatedAt),
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

    let userLogins: { createdAt: string | null }[] = [];
    try {
      const rows = await currentDb.select().from(logins).where(eq(logins.userId, auth.id)).orderBy(desc(logins.createdAt)).limit(10);
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
