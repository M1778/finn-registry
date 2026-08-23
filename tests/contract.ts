/**
 * Shapes and helpers shared across the suites.
 *
 * This is not a test file (no `.test.ts`), so vitest does not collect it.
 *
 * The point of putting the key lists here rather than in each suite is drift:
 * §3.9's `items` are specified as "the same item shape as §3.5", and the web UI
 * feeds both through one normalizer, so a field that appears on one endpoint and
 * not the other shows up as a blank column rather than an error. One list,
 * asserted from both sides, is the only way that stays true.
 */

import { expect } from "vitest";

/** An ISO-8601 instant in UTC, as every timestamp in §3 is written. */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** §3.2 — the full package record. */
export const PACKAGE_KEYS = [
  "name",
  "description",
  "repo_url",
  "homepage",
  "license",
  "keywords",
  "latest_version",
  "publisher",
  "trust",
  "is_deprecated",
  "deprecation_message",
  "created_at",
  "updated_at",
];

/** §3.2 — the embedded publisher. */
export const PUBLISHER_KEYS = ["login", "display_name", "avatar_url", "kind", "is_verified"];

/** §3.9 — the publisher profile: the embedded publisher plus when it joined. */
export const PUBLISHER_PROFILE_KEYS = [...PUBLISHER_KEYS, "created_at"];

/** §3.2 — the trust object: one derived level plus the raw signals. */
export const TRUST_KEYS = [
  "level",
  "publisher_verified",
  "package_trusted",
  "repo_ownership_confirmed",
];

/** §3.3 — one version record. §3.4 is this plus `repo_url`. */
export const VERSION_KEYS = [
  "version",
  "git_ref",
  "commit",
  "checksum",
  "checksum_origin",
  "yanked",
  "published_at",
];

/** §3.5 — one row of a browse, search, or publisher page. */
export const ITEM_KEYS = [
  "name",
  "description",
  "latest_version",
  "publisher",
  "trust",
  "is_deprecated",
  "created_at",
];

/**
 * Counters the registry does not publish anywhere, on any endpoint.
 *
 * Nothing increments a download count and stars are not recorded at all, so
 * every row would serialise `downloads: 0` forever. A field that is permanently
 * zero for every package does not read as "not measured" — it reads as "nobody
 * uses this", and it invites a consumer to render it as if it meant something.
 * The registry says nothing rather than something false.
 *
 * This is the same decision as `sort` refusing `downloads` and `stars` (§3.5):
 * declining to order by a number while still publishing it was the inconsistent
 * half-measure.
 */
export const ABSENT_COUNTER_KEYS = [
  "downloads",
  "download_count",
  "downloads_total",
  "total_downloads",
  "stars",
  "star_count",
  "stargazers_count",
];

/** Every key anywhere in `value`, however deeply nested. */
export function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      allKeys(nested, into);
    }
  }
  return into;
}

/**
 * No download or star counter appears anywhere in a response — not per row, not
 * as an aggregate, not on a publisher.
 */
export function expectNoCounters(body: unknown, label: string): void {
  const present = [...allKeys(body)].filter(
    (key) => ABSENT_COUNTER_KEYS.includes(key) || /^(downloads?|stars?)_/.test(key),
  );
  expect(present, `${label} publishes a counter the registry does not measure`).toEqual([]);
}

/** §3.5 — the item's publisher is deliberately smaller than §3.2's. */
export const ITEM_PUBLISHER_KEYS = ["login", "is_verified"];

/** §3.5 — an item publishes the derived level and not the raw signals. */
export const ITEM_TRUST_KEYS = ["level"];

/** §3.10 — what `POST /api/registrations/check` reports. */
export const REGISTRATION_CHECK_KEYS = ["push_access", "needs_scope", "repo", "reason"];

/** §3.10 — what the registry is willing to copy out of a repository. */
export const REPO_FACTS_KEYS = [
  "full_name",
  "description",
  "homepage",
  "license",
  "default_branch",
];

export function expectKeys(value: unknown, keys: string[], label: string): void {
  expect(value, `${label} is not an object`).toBeTypeOf("object");
  expect(value, `${label} is null`).not.toBeNull();
  expect(Object.keys(value as object).sort(), label).toEqual([...keys].sort());
}

/** No camelCase anywhere on a CLI-facing response (§3.1). */
export function expectSnakeCase(value: unknown, label: string): void {
  expect(
    Object.keys(value as object).filter((key) => /[A-Z]/.test(key)),
    `${label} leaks camelCase keys`,
  ).toEqual([]);
}

/**
 * The error envelope every failure uses: a machine-readable snake_case code the
 * caller can branch on, and a message a human can act on.
 */
export function expectErrorEnvelope(body: any, label = "error body"): void {
  expect(typeof body?.error, `${label}: error is not a string`).toBe("string");
  expect(body.error, `${label}: error code is not snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
  expect(typeof body?.message, `${label}: message is not a string`).toBe("string");
  expect(body.message.length, `${label}: message is empty`).toBeGreaterThan(0);
}

/** Asserts one page item against §3.5, from whichever endpoint served it. */
export function expectItemShape(item: unknown, label: string): void {
  expectKeys(item, ITEM_KEYS, label);
  expectSnakeCase(item, label);
  expectNoCounters(item, label);

  const row = item as Record<string, any>;
  expectKeys(row.publisher, ITEM_PUBLISHER_KEYS, `${label}.publisher`);
  expectKeys(row.trust, ITEM_TRUST_KEYS, `${label}.trust`);
  expect(["verified", "trusted", "recognized"], `${label}.trust.level`).toContain(row.trust.level);
  expect(typeof row.is_deprecated, `${label}.is_deprecated`).toBe("boolean");
  expect(row.created_at, `${label}.created_at`).toMatch(ISO_INSTANT);
  expect(row.latest_version === null || typeof row.latest_version === "string").toBe(true);
}
