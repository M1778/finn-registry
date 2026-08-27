/**
 * The registry's read queries — one definition, shared by the API and the pages.
 *
 * Both readers used to have their own. The Hono handlers read D1 and serialized;
 * the package and publisher pages fetched those handlers over HTTP from the
 * browser, which cost three or four Cloudflare requests per page view instead of
 * one — the free tier allows 100,000 a day and the CLI shares them (ADR-0005) —
 * and served a document with no heading and no name in it to every crawler and
 * link preview. Both now call the functions below.
 *
 * That matters beyond tidiness: the latest-version derivation, the trust ladder,
 * and the publisher resolution order each existed in more than one place and
 * could drift. What `finn` resolves and what a reader sees on the page are now
 * the same computation over the same rows.
 *
 * Everything here returns the **serialized** wire shapes, never Drizzle rows.
 * The serializers are the single place that knows how a record is published
 * (§3.1), and the trust level in particular is only ever what `serializeTrust`
 * derives: a caller that read `is_trusted` for itself would be a second,
 * divergent definition of the trust ladder (ADR-0003).
 *
 * Nothing here catches a database error. A failed read is not an absent record —
 * "only a genuine 404 means the package does not exist" (§3.8) — so a broken
 * query must reach the caller's error handling rather than be reported as a
 * missing name. The API turns a thrown error into a 500 and `null` into a 404;
 * the pages let it reach the error boundary and render their designed "not on the
 * register" panel only for `null`.
 *
 * The three lookups are wrapped in React's `cache()`, which memoises per request
 * during a server render, so a page's `generateMetadata` and its component body
 * share one read instead of doubling every query. Outside a React request — the
 * Hono handlers, vitest — `cache()` degrades to a plain call, so nothing below
 * relies on it for its query count: a caller that needs a package *and* its
 * versions gets both from one `findPackage`.
 *
 * @param env Every function takes an optional Workers `env` last, for a caller
 *            that already holds the D1 binding (Hono's `c.env`). Without it
 *            `getDb` finds the binding through the OpenNext context, which is
 *            what a server-rendered page does.
 */

import { cache } from "react";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { organizations, packages, users, versions } from "@/lib/db/schema";
import {
  serializePackage,
  serializePackageSummary,
  serializePublisherProfile,
  serializeVersion,
  type PackageIdentity,
  type PackageSummary,
  type PublisherIdentity,
} from "@/app/api/[[...route]]/serializers";
import { compareVersions, compareVersionsDescending } from "@/app/api/[[...route]]/semver";
import type { PackageRecord, PublisherProfile, VersionRecord } from "@/types/registry";

// ---------------------------------------------------------------------------
// Shared query pieces
// ---------------------------------------------------------------------------

/**
 * The columns a serializer needs, and nothing more. Selecting explicitly keeps
 * new columns out of the public API and keeps the rows small.
 */
export const packageColumns = {
  name: packages.name,
  description: packages.description,
  repoUrl: packages.repoUrl,
  homepage: packages.homepage,
  license: packages.license,
  keywords: packages.keywords,
  isTrusted: packages.isTrusted,
  isDeprecated: packages.isDeprecated,
  deprecationMessage: packages.deprecationMessage,
  createdAt: packages.createdAt,
  updatedAt: packages.updatedAt,
} as const;

/**
 * The columns the publisher's own counterfoil needs, and nothing more.
 *
 * Deliberately *not* `packageColumns`: that set is what a §3 serializer reads, and
 * the dashboard reads less of a package and one thing more. It needs the row id,
 * which no serialized record carries, and it has no use for `repoUrl`, `license`,
 * `keywords`, `homepage`, `deprecationMessage` or `updatedAt` — none of which the
 * page renders.
 *
 * It lives here rather than beside the handler so that every "which columns does
 * this reader need" answer is in one file: adding a column to `packages` should
 * mean one place to look and one decision per reader, and the column that started
 * this — `downloads`, spread onto every dashboard entry by a `{ ...pkg }` — is
 * exactly what an implicit `select()` costs.
 */
export const dashboardPackageColumns = {
  id: packages.id,
  name: packages.name,
  description: packages.description,
  isTrusted: packages.isTrusted,
  isDeprecated: packages.isDeprecated,
  createdAt: packages.createdAt,
} as const;

/**
 * The columns the counterfoil publishes about the account itself.
 *
 * `publisherColumns` plus the three things only the account itself is shown — its
 * own contact `email`, its moderation `role`, and when it joined. It leaves out
 * the internal `id`, the `githubId`, and the `bio`/`location`/`blog` columns that
 * no page renders and no form offers.
 *
 * Written out rather than left implicit because `GET /api/auth/status` does the
 * opposite — it hands back the whole `users` row, which REGISTRY-API.md §7 says in
 * as many words, so a column added to the table is published there by default.
 * This list is what stops that being true of the dashboard as well. Nothing on
 * `users` is a credential today (the GitHub access token a sign-in was minted with
 * lives on `sessions`, ADR-0004), and the point of naming the columns is that
 * whether that stays true is not something this handler has to depend on.
 */
export const dashboardUserColumns = {
  login: users.login,
  name: users.name,
  email: users.email,
  avatarUrl: users.avatarUrl,
  role: users.role,
  isVerified: users.isVerified,
  createdAt: users.createdAt,
} as const;

export const publisherColumns = {
  login: users.login,
  name: users.name,
  avatarUrl: users.avatarUrl,
  isVerified: users.isVerified,
} as const;

export const organizationColumns = {
  name: organizations.name,
  displayName: organizations.displayName,
  avatarUrl: organizations.avatarUrl,
} as const;

/**
 * Most packages are registered by an account directly rather than under an
 * organisation, so the left join yields a row of nulls rather than no row.
 * Narrowed in one place because every reader of a package row needs the same
 * shape.
 */
export function organizationOrNull(
  row: { name: string | null; displayName: string | null; avatarUrl: string | null } | null,
) {
  if (!row?.name) return null;
  return { name: row.name, displayName: row.displayName, avatarUrl: row.avatarUrl };
}

/**
 * The version a fresh resolve would pick: highest semver precedence, yanked
 * records excluded.
 *
 * Yanked means "do not select for a fresh resolve, but honour an existing
 * lockfile pin" (§3.3), and `latest_version` is exactly what a fresh resolve
 * reads — so a yanked version must never surface here. A package whose every
 * version is yanked therefore has no latest version, which is the honest answer,
 * and never a fabricated `1.0.0` (§3.2).
 *
 * This is the one definition. A package page, a dashboard row, a §3.5 summary and
 * a §3.2 record all call it, so they cannot disagree about what "latest" means.
 */
export function latestVersionOf(rows: { version: string; yanked: boolean }[]): string | null {
  const selectable = rows.filter((row) => !row.yanked);
  if (selectable.length === 0) return null;

  return selectable.reduce(
    (highest, row) => (compareVersions(row.version, highest) > 0 ? row.version : highest),
    selectable[0].version,
  );
}

/** The row shape every paginated package listing selects. */
export interface PackagePageRow {
  id: string;
  pkg: PackageIdentity;
  owner: PublisherIdentity;
  organization: { name: string | null; displayName: string | null; avatarUrl: string | null } | null;
}

/**
 * Turn a page of package rows into §3.5 summaries.
 *
 * The version records for the whole page are fetched in **one** query rather
 * than one query per package. A latest-version-per-package lookup is the
 * natural place for an N+1 to appear, and at 100 rows per page an N+1 is 101
 * round trips against a 10 ms CPU budget (§3.8).
 */
export async function summarizePage(
  db: ReturnType<typeof getDb>,
  rows: PackagePageRow[],
): Promise<PackageSummary[]> {
  if (rows.length === 0) return [];

  const versionRows = await db
    .select({ packageId: versions.packageId, version: versions.version, yanked: versions.yanked })
    .from(versions)
    .where(inArray(versions.packageId, rows.map((row) => row.id)));

  return rows.map((row) =>
    serializePackageSummary({
      pkg: row.pkg,
      owner: row.owner,
      organization: organizationOrNull(row.organization),
      latestVersion: latestVersionOf(versionRows.filter((v) => v.packageId === row.id)),
    }),
  );
}

// ---------------------------------------------------------------------------
// §3.3 Version records
// ---------------------------------------------------------------------------

/**
 * Every version record for one package, newest first.
 *
 * Semver-descending, not `created_at`-descending — which reorders a backfilled
 * `1.9.0` above a `1.10.0` — and not string order, which puts `1.9.0` above
 * `1.10.0` outright. Yanked records are listed and carry `yanked: true`, because
 * a lockfile that already pins one can still be honoured; they are excluded only
 * from the latest version.
 */
export const listPackageVersions = cache(
  async (packageId: string, env?: unknown): Promise<VersionRecord[]> => {
    const db = getDb(env);

    const rows = await db
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
      .where(eq(versions.packageId, packageId));

    return rows
      .map(serializeVersion)
      .sort((a, b) => compareVersionsDescending(a.version, b.version));
  },
);

// ---------------------------------------------------------------------------
// §3.2 One package
// ---------------------------------------------------------------------------

/** A package on the register: the §3.2 record, its version records, and its row id. */
export interface FoundPackage {
  id: string;
  record: PackageRecord;
  /**
   * The §3.3 records, newest first — the same read `record.latest_version` was
   * derived from. Handed back rather than left for the caller to fetch again, so
   * that resolving a package and listing its versions is two queries whether or
   * not `cache()` is memoising.
   */
  versions: VersionRecord[];
}

/**
 * One package by its bare name, or `null` when the name is not on the register.
 *
 * A name is bare and globally unique (§2.1, ADR-0002): a slash always means
 * GitHub and never reaches the registry.
 */
export const findPackage = cache(
  async (name: string, env?: unknown): Promise<FoundPackage | null> => {
    const db = getDb(env);

    const row = await db
      .select({
        id: packages.id,
        pkg: packageColumns,
        owner: publisherColumns,
        organization: organizationColumns,
      })
      .from(packages)
      .innerJoin(users, eq(packages.ownerId, users.id))
      .leftJoin(organizations, eq(packages.organizationId, organizations.id))
      .where(eq(packages.name, name))
      .get();

    if (!row) return null;

    const versionRecords = await listPackageVersions(row.id, env);

    return {
      id: row.id,
      record: serializePackage({
        pkg: row.pkg,
        owner: row.owner,
        organization: organizationOrNull(row.organization),
        latestVersion: latestVersionOf(versionRecords),
      }),
      versions: versionRecords,
    };
  },
);

// ---------------------------------------------------------------------------
// Publisher profile
// ---------------------------------------------------------------------------

/**
 * The default page of entries. Matches the API's own `MAX_LIMIT`, which is also
 * what `GET /publishers/:login` returns when the caller names no limit; the
 * publisher page never paginates and takes the whole page in one go.
 */
const DEFAULT_ENTRY_LIMIT = 100;

/** A publisher and the names attributed to them. */
export interface FoundPublisher {
  profile: PublisherProfile;
  /**
   * How many names the publisher holds. Counted, not inferred from `items`, so it
   * stays true when a page of entries is capped by `limit`.
   */
  total: number;
  /** §3.5 summaries — byte-for-byte the browse-page row shape. */
  items: PackageSummary[];
}

/**
 * One publisher by login, or `null` when nothing on the register is attributed
 * to that login.
 *
 * Two invariants this function exists to hold, both load-bearing:
 *
 *  1. **Resolution order.** A login resolves to an *account* first and only then
 *     to an organisation of that name. Both are possible because a package
 *     record's `publisher.login` can be either, and a profile link built from one
 *     has to land somewhere. The order is not arbitrary: GitHub's logins and
 *     organisation names share one namespace, so the two lookups cannot both
 *     match, and checking the account first keeps the common case to one query.
 *
 *  2. **An organisation's names do not appear on its owner's profile.** An
 *     account's packages are selected with `organizationId IS NULL`. A package
 *     registered under an organisation publishes the organisation as its
 *     `publisher.login`, so listing it on the owner's profile too would put one
 *     package on two profiles under two different publishers, and would make the
 *     human who owns an organisation look as though they registered its packages
 *     personally.
 *
 * An account that has claimed nothing is not a publisher: by the glossary a
 * publisher *is* an account that registered a package, so signing in once does
 * not make one. That is why an empty result is `null` — a 404 to the API, the
 * "no signatory" panel to a reader — and not an empty profile.
 */
export const findPublisher = cache(
  async (
    login: string,
    limit: number = DEFAULT_ENTRY_LIMIT,
    offset: number = 0,
    env?: unknown,
  ): Promise<FoundPublisher | null> => {
    const db = getDb(env);

    const account = await db
      .select({
        id: users.id,
        login: users.login,
        name: users.name,
        avatarUrl: users.avatarUrl,
        isVerified: users.isVerified,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.login, login))
      .get();

    let profile: PublisherProfile;
    let claimedBy;

    if (account) {
      profile = serializePublisherProfile(account, null);
      claimedBy = and(eq(packages.ownerId, account.id), isNull(packages.organizationId));
    } else {
      // The verification signal lives on the account that registered the name,
      // so the organisation is joined to its owner to read it.
      const org = await db
        .select({
          id: organizations.id,
          createdAt: organizations.createdAt,
          organization: organizationColumns,
          owner: publisherColumns,
        })
        .from(organizations)
        .innerJoin(users, eq(organizations.ownerId, users.id))
        .where(eq(organizations.name, login))
        .get();

      if (!org) return null;

      profile = serializePublisherProfile(
        { ...org.owner, createdAt: org.createdAt },
        org.organization,
      );
      claimedBy = eq(packages.organizationId, org.id);
    }

    const [totalRow, rows] = await Promise.all([
      db.select({ value: sql<number>`count(*)` }).from(packages).where(claimedBy).get(),
      db
        .select({
          id: packages.id,
          pkg: packageColumns,
          owner: publisherColumns,
          organization: organizationColumns,
        })
        .from(packages)
        .innerJoin(users, eq(packages.ownerId, users.id))
        .leftJoin(organizations, eq(packages.organizationId, organizations.id))
        .where(claimedBy)
        .orderBy(desc(packages.createdAt), asc(packages.name))
        .limit(limit)
        .offset(offset),
    ]);

    const total = totalRow?.value ?? 0;
    if (total === 0) return null;

    return { profile, total, items: await summarizePage(db, rows) };
  },
);
