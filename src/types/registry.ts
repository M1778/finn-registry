/**
 * Wire types for the registry's public API.
 *
 * These mirror `docs/REGISTRY-CONTRACT.md` §3 exactly, including its snake_case
 * field names. The contract is what the `finn` CLI deserializes, so the names
 * are part of the interface and are not camelCased on the way through the UI.
 */

export type TrustLevel = "verified" | "trusted" | "recognized";

/** What the registry asserts about a package. `finn` branches on `level` alone. */
export interface Trust {
  level: TrustLevel;
  publisher_verified: boolean;
  package_trusted: boolean;
  repo_ownership_confirmed: boolean;
}

export interface Publisher {
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  kind: "user" | "organization";
  is_verified: boolean;
}

/**
 * A publisher as their own page shows them. Same identity fields as the one
 * embedded in a package record, plus when the account joined.
 *
 * There is deliberately no download or star count. The registry records
 * neither, and a profile is the most tempting place to invent them.
 */
export interface PublisherProfile extends Publisher {
  created_at: string;
}

/** A checksum the publisher asserted. The registry never computes one: it does
 *  not hold the code. See contract §4.1. */
export type ChecksumOrigin = "publisher_attested";

export interface VersionRecord {
  version: string;
  git_ref: string;
  commit: string;
  checksum: string | null;
  checksum_origin: ChecksumOrigin | null;
  yanked: boolean;
  published_at: string;
}

export interface PackageRecord {
  name: string;
  description: string | null;
  repo_url: string;
  homepage: string | null;
  license: string | null;
  keywords: string[];
  /** `null` when no version has been registered. Never substitute a default. */
  latest_version: string | null;
  publisher: Publisher;
  trust: Trust;
  is_deprecated: boolean;
  deprecation_message: string | null;
  created_at: string;
  updated_at: string;
}
