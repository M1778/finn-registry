/**
 * Wire serializers.
 *
 * Every CLI-facing response passes through this file, and nothing else in the
 * API is allowed to hand a database row to `c.json()`. Two reasons:
 *
 *  1. **Casing.** Drizzle rows are camelCase (`repoUrl`); the contract is
 *     snake_case (`repo_url`), and `finn`'s `PackageMetadata` derives
 *     `Deserialize` with no `rename_all`, so a camelCase field simply does not
 *     arrive. Returning a raw row is how that broke in the first place (§3.1).
 *
 *  2. **Leakage.** A row carries columns the registry has no business
 *     publishing, and it grows columns over time. An explicit mapping means a
 *     new column never appears in the public API by accident.
 *
 * The inputs are structural subsets, not `InferSelectModel` rows, so handlers
 * can select only the columns they need and these functions stay callable
 * without a database.
 */

import { deriveTrustLevel, REPO_OWNERSHIP_CONFIRMED } from "@/lib/trust";
import type {
  ChecksumOrigin,
  PackageRecord,
  Publisher,
  PublisherProfile,
  Trust,
  VersionRecord,
} from "@/types/registry";

/** The account that registered a package. */
export interface PublisherIdentity {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
}

/** The organisation a package was registered under, when there is one. */
export interface OrganizationIdentity {
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface PackageIdentity {
  name: string;
  description: string | null;
  repoUrl: string;
  homepage: string | null;
  license: string | null;
  /** JSON-encoded string array, as stored. */
  keywords: string | null;
  isTrusted: boolean;
  isDeprecated: boolean;
  deprecationMessage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface VersionIdentity {
  version: string;
  gitRef: string;
  commit: string;
  checksum: string | null;
  checksumOrigin: ChecksumOrigin | null;
  yanked: boolean;
  createdAt: string | null;
}

/** The §3.5 list element: deliberately smaller than a `PackageRecord`. */
export interface PackageSummary {
  name: string;
  description: string | null;
  latest_version: string | null;
  publisher: Pick<Publisher, "login" | "is_verified">;
  trust: Pick<Trust, "level">;
  is_deprecated: boolean;
  created_at: string;
}

/** A §3.3 version record plus the repository, so §3.4 resolves in one request. */
export type VersionRecordWithRepo = VersionRecord & { repo_url: string };

const SQLITE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/**
 * Normalise a stored timestamp to ISO-8601 UTC, the format §3 publishes.
 *
 * SQLite's `CURRENT_TIMESTAMP` writes `"2026-08-01 00:00:00"` — UTC, but with no
 * `T` and no zone. Handing that to `new Date()` parses it as *local* time, which
 * silently shifts every timestamp the registry publishes, so it is rewritten
 * rather than parsed.
 *
 * An absent or unparseable value serialises as `""`. Nothing here invents a
 * date: a wrong timestamp is worse than a visibly missing one.
 */
export function isoTimestamp(raw: string | null | undefined): string {
  if (!raw) return "";

  const sqlite = SQLITE_TIMESTAMP.exec(raw);
  if (sqlite) return `${sqlite[1]}T${sqlite[2]}Z`;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";

  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Keywords are stored as a JSON string array. A malformed value degrades to an
 * empty list; a package's keywords are not worth failing a resolve over.
 */
export function parseKeywords(raw: string | null | undefined): string[] {
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * Who stands behind the name.
 *
 * When a package was registered under an organisation, the organisation is the
 * publisher for display purposes, but the verification signal stays on the
 * account that registered it — that account is what an admin reviewed.
 */
export function serializePublisher(
  owner: PublisherIdentity,
  organization?: OrganizationIdentity | null,
): Publisher {
  if (organization) {
    return {
      login: organization.name,
      display_name: organization.displayName,
      avatar_url: organization.avatarUrl,
      kind: "organization",
      is_verified: owner.isVerified,
    };
  }

  return {
    login: owner.login,
    display_name: owner.name,
    avatar_url: owner.avatarUrl,
    kind: "user",
    is_verified: owner.isVerified,
  };
}

/**
 * The trust object: one derived level, plus the raw signals for display. `finn`
 * branches on `level` alone (§2.4).
 *
 * `repoOwnershipConfirmed` is not read from the row. It has no column, because
 * every row reached `packages` through the one insert that proves push access
 * first — see `REPO_OWNERSHIP_CONFIRMED` in `src/lib/trust.ts` for what that
 * invariant does and does not assert. This file is *not* the only place that
 * publishes the signal (`/api/stats` and the moderation bench derive a level
 * too), which is why the value lives there and is imported here rather than
 * written out again.
 */
export function serializeTrust(pkg: PackageIdentity, owner: PublisherIdentity): Trust {
  const signals = {
    publisherVerified: owner.isVerified,
    packageTrusted: pkg.isTrusted,
    repoOwnershipConfirmed: REPO_OWNERSHIP_CONFIRMED,
  };

  return {
    level: deriveTrustLevel(signals),
    publisher_verified: signals.publisherVerified,
    package_trusted: signals.packageTrusted,
    repo_ownership_confirmed: signals.repoOwnershipConfirmed,
  };
}

/**
 * §3.2 — one resolved package.
 *
 * There is no `downloads` field, here or in the summary below. The registry
 * never serves a byte — GitHub does (ADR-0001) — so nothing increments the
 * column and every package would publish `downloads: 0`. A field that is
 * permanently zero for everyone reads as "nobody uses this" rather than "we do
 * not measure this", and it invites a consumer to render it as the former. That
 * is the same reasoning that removed `sort=downloads`, one layer down. The
 * column stays in the schema so that counting, if it is ever agreed (§4.2),
 * returns deliberately rather than by accident.
 */
export function serializePackage(input: {
  pkg: PackageIdentity;
  owner: PublisherIdentity;
  organization?: OrganizationIdentity | null;
  /** The highest version by semver precedence, or `null` if none is recorded. */
  latestVersion: string | null;
}): PackageRecord {
  const { pkg, owner, organization, latestVersion } = input;

  return {
    name: pkg.name,
    description: pkg.description,
    repo_url: pkg.repoUrl,
    homepage: pkg.homepage,
    license: pkg.license,
    keywords: parseKeywords(pkg.keywords),
    // Null when nothing is recorded. Never a fabricated "1.0.0" (§3.2).
    latest_version: latestVersion,
    publisher: serializePublisher(owner, organization),
    trust: serializeTrust(pkg, owner),
    is_deprecated: pkg.isDeprecated,
    deprecation_message: pkg.deprecationMessage,
    created_at: isoTimestamp(pkg.createdAt),
    updated_at: isoTimestamp(pkg.updatedAt ?? pkg.createdAt),
  };
}

/** §3.3 — one version record. */
export function serializeVersion(version: VersionIdentity): VersionRecord {
  return {
    version: version.version,
    git_ref: version.gitRef,
    commit: version.commit,
    checksum: version.checksum,
    // Only ever publisher-attested: the registry never sees the code (§4.1).
    checksum_origin: version.checksum ? version.checksumOrigin ?? "publisher_attested" : null,
    yanked: version.yanked,
    published_at: isoTimestamp(version.createdAt),
  };
}

/** §3.4 — one version record, resolvable without a second request. */
export function serializeVersionWithRepo(
  version: VersionIdentity,
  repoUrl: string,
): VersionRecordWithRepo {
  return { ...serializeVersion(version), repo_url: repoUrl };
}

/** §3.5 — one row of a browse or search page. */
export function serializePackageSummary(input: {
  pkg: PackageIdentity;
  owner: PublisherIdentity;
  organization?: OrganizationIdentity | null;
  latestVersion: string | null;
}): PackageSummary {
  const { pkg, owner, organization, latestVersion } = input;
  const publisher = serializePublisher(owner, organization);

  return {
    name: pkg.name,
    description: pkg.description,
    latest_version: latestVersion,
    publisher: { login: publisher.login, is_verified: publisher.is_verified },
    trust: { level: serializeTrust(pkg, owner).level },
    // A withdrawn name still appears in the register — it is a claimed name, and
    // hiding it would make the list disagree with a resolve — so the row has to
    // carry the flag that lets the UI mark it.
    is_deprecated: pkg.isDeprecated,
    created_at: isoTimestamp(pkg.createdAt),
  };
}

/**
 * A publisher's own page: the same identity fields a package record embeds, plus
 * when the account joined.
 *
 * No download or star totals. The registry records neither honestly (ADR-0001,
 * §4.2), and a profile page is the most tempting place to invent them.
 */
export function serializePublisherProfile(
  owner: PublisherIdentity & { createdAt: string | null },
  organization?: OrganizationIdentity | null,
): PublisherProfile {
  return {
    ...serializePublisher(owner, organization),
    created_at: isoTimestamp(owner.createdAt),
  };
}
