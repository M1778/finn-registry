/**
 * `GET /api/stats` — docs/REGISTRY-API.md §6.1.
 *
 * Not part of the CLI contract: it exists for this repository's own front page,
 * and camelCase is the marker that says so. It is tested anyway, for two reasons.
 *
 * It is the busiest read in the app, and it is the one endpoint whose figures a
 * human reads as facts about the registry — "41 packages, 12 publishers" — so a
 * figure that quietly stops counting what it claims to count is a lie told at
 * scale rather than a cosmetic bug. `totalPublishers` in particular counts
 * accounts *standing behind a name*, not accounts that signed in, and those two
 * numbers drift apart the moment someone signs in and registers nothing.
 *
 * And `recentPackages` is ordered and bounded (`desc(createdAt), asc(name)`,
 * `limit(8)`), which nothing asserted before this file existed. Every fixture
 * here is registered in an order that is *not* the asserted order, because a
 * fixture whose insertion order already equals the asserted order cannot detect
 * an ordering that has stopped working: `seedPackage` gives every row the same
 * `created_at` by default, and an unordered SQLite query comes back in insertion
 * order.
 */

import { describe, expect, it } from "vitest";
import { apiGet, seedPackage, seedPublisher } from "../setup";
import { allKeys, expectKeys, expectNoCounters, ISO_INSTANT } from "../contract";

/** §6.1 — the four figures, and nothing else. */
const STATS_KEYS = ["totalPackages", "totalPublishers", "totalVersions", "recentPackages"];

/** §6.1 — one `recentPackages` entry. */
const ENTRY_KEYS = [
  "id",
  "name",
  "description",
  "category",
  "isTrusted",
  "isDeprecated",
  "trustLevel",
  "publisherLogin",
  "publisherVerified",
  "latestVersion",
  "createdAt",
];

interface StatsEntry {
  name: string;
  trustLevel: string;
  latestVersion: string | null;
  publisherLogin: string;
  publisherVerified: boolean;
}

interface StatsBody {
  totalPackages: number;
  totalPublishers: number;
  totalVersions: number;
  recentPackages: StatsEntry[];
}

const names = (body: StatsBody): string[] => body.recentPackages.map((entry) => entry.name);

const entryFor = (body: StatsBody, name: string): StatsEntry => {
  const found = body.recentPackages.find((entry) => entry.name === name);
  if (!found) throw new Error(`no recentPackages entry named ${name}`);
  return found;
};

describe("GET /api/stats", () => {
  it("returns exactly the four documented figures", async () => {
    await seedPackage({ name: "http" });

    const { status, body } = await apiGet("/api/stats");

    expect(status).toBe(200);
    expectKeys(body, STATS_KEYS, "stats body");
  });

  /**
   * §6.1: "camelCase, unlike everything in §5. That is the marker that it is not
   * for you." A snake_case key here would make a web-only response look like the
   * contracted surface, which is the mistake the marker exists to prevent.
   */
  it("keeps every key camelCase, anywhere in the body", async () => {
    await seedPackage({ name: "http", versions: [{ version: "1.2.0" }] });

    const { body } = await apiGet("/api/stats");

    const snakeCased = [...allKeys(body)].filter((key) => key.includes("_"));
    expect(snakeCased, "stats leaks a snake_case key").toEqual([]);
  });

  it("answers zeros and an empty list on an empty registry", async () => {
    const { status, body } = await apiGet("/api/stats");

    expect(status).toBe(200);
    expect(body).toEqual({
      totalPackages: 0,
      totalPublishers: 0,
      totalVersions: 0,
      recentPackages: [],
    });
  });

  // --- the figures ----------------------------------------------------------

  it("counts every registered name", async () => {
    await seedPackage({ name: "http" });
    await seedPackage({ name: "json" });
    await seedPackage({ name: "toml" });

    const { body } = await apiGet("/api/stats");

    expect(body.totalPackages).toBe(3);
  });

  /**
   * "Accounts standing behind at least one name, not accounts that signed in."
   *
   * Both halves are asserted, because a plain `count(*)` over `users` and a
   * `count(distinct owner_id)` over `packages` agree on any fixture where every
   * account has exactly one package. So: one account with two names must count
   * once, and an account that registered nothing must not count at all.
   */
  it("counts accounts standing behind a name, not accounts that signed in", async () => {
    const acme = await seedPublisher({ login: "acme" });
    await seedPackage({ name: "http", publisher: acme });
    await seedPackage({ name: "json", publisher: acme });
    await seedPackage({ name: "toml", publisher: await seedPublisher({ login: "hobbyist" }) });
    await seedPublisher({ login: "lurker" });

    const { body } = await apiGet("/api/stats");

    expect(body.totalPublishers).toBe(2);
    expect(body.totalPackages).toBe(3);
  });

  /**
   * "How many version records it has recorded" — records, so a yanked one still
   * counts. It was recorded, a lockfile can still pin it (§3.3), and it is not a
   * package either, so neither `count(distinct package_id)` nor a filter on
   * `yanked` is what this figure means.
   */
  it("counts every version record, including a yanked one", async () => {
    await seedPackage({
      name: "http",
      versions: [{ version: "1.2.0" }, { version: "2.0.0", yanked: true }],
    });
    await seedPackage({ name: "json", versions: [{ version: "0.1.0" }] });
    await seedPackage({ name: "toml", versions: [] });

    const { body } = await apiGet("/api/stats");

    expect(body.totalVersions).toBe(3);
    expect(body.totalPackages).toBe(3);
  });

  it("publishes no download or star counter", async () => {
    await seedPackage({ name: "http", downloads: 99, stars: 42 });

    const { body } = await apiGet("/api/stats");

    expectNoCounters(body, "stats body");
  });

  // --- recentPackages: bound and order --------------------------------------

  /**
   * §6.1: "at most 8 entries". Nine are registered and the ninth is the *oldest*,
   * so a bound that has drifted upward shows up as the extra name rather than
   * only as a length.
   */
  it("holds at most 8 entries, dropping the oldest", async () => {
    // Registered oldest-first, which is the reverse of what the endpoint returns.
    for (let day = 1; day <= 9; day += 1) {
      const stamp = `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`;
      await seedPackage({ name: `pkg${day}`, created_at: stamp });
    }

    const { body } = await apiGet("/api/stats");

    expect(body.totalPackages).toBe(9);
    expect(body.recentPackages).toHaveLength(8);
    expect(names(body)).not.toContain("pkg1");
  });

  it("lists the newest registration first", async () => {
    await seedPackage({ name: "middle", created_at: "2026-04-01T00:00:00Z" });
    await seedPackage({ name: "oldest", created_at: "2026-01-01T00:00:00Z" });
    await seedPackage({ name: "newest", created_at: "2026-08-01T00:00:00Z" });

    const { body } = await apiGet("/api/stats");

    expect(names(body)).toEqual(["newest", "middle", "oldest"]);
  });

  /**
   * The tie-break. `limit(8)` over an order that leaves ties unresolved is the
   * same defect as offset paging over one: which eight rows you get stops being
   * determined by the data.
   *
   * Registered in neither the asserted order nor its reverse, which is measured
   * rather than assumed. With the tie-break removed, `desc(created_at)` over tied
   * rows returns *reversed* registration order — SQLite sorts a DESC key by
   * scanning ascending and reversing — so a fixture registered in the reverse of
   * the asserted order would come back in exactly the asserted order and detect
   * nothing. Three shuffled names is the only arrangement that is neither.
   */
  it("breaks a created_at tie by name", async () => {
    const sameInstant = "2026-08-01T00:00:00Z";
    await seedPackage({ name: "toml", created_at: sameInstant });
    await seedPackage({ name: "http", created_at: sameInstant });
    await seedPackage({ name: "zlib", created_at: sameInstant });

    const { body } = await apiGet("/api/stats");

    expect(names(body)).toEqual(["http", "toml", "zlib"]);
  });

  // --- recentPackages: the entry --------------------------------------------

  it("returns exactly the documented entry fields", async () => {
    await seedPackage({ name: "http", versions: [{ version: "1.2.0" }] });

    const { body } = await apiGet("/api/stats");

    expect(body.recentPackages).toHaveLength(1);
    expectKeys(body.recentPackages[0], ENTRY_KEYS, "recentPackages entry");
    expect(body.recentPackages[0].createdAt).toMatch(ISO_INSTANT);
  });

  /**
   * The front page must never invent a version, and it must not show a yanked one
   * as current — the same rule as §3.2's `latest_version`, reached through a
   * different code path (`latestVersionOf` in the handler, not the serializer).
   * `tests/regressions/no-fabricated-version.test.ts` sweeps this endpoint for the
   * one literal that was the historical bug; this asserts the positive.
   */
  it("reports the highest non-yanked version, and null when there is none", async () => {
    await seedPackage({
      name: "released",
      created_at: "2026-08-01T00:00:00Z",
      versions: [{ version: "1.2.0" }, { version: "2.0.0", yanked: true }, { version: "0.9.0" }],
    });
    await seedPackage({ name: "unreleased", created_at: "2026-08-02T00:00:00Z", versions: [] });

    const { body } = await apiGet("/api/stats");

    expect(entryFor(body, "released").latestVersion).toBe("1.2.0");
    expect(entryFor(body, "unreleased").latestVersion).toBeNull();
  });

  /**
   * The derived level, not the raw signals, and derived from this row's own
   * signals: a verified publisher's name reading `verified` while a vouched one
   * reads `recognized` would misreport trust on the most-read page in the app,
   * in the direction that flatters.
   *
   * Repository ownership is the third signal and is not asserted here because
   * there is no column for it — a registration that cannot prove push access is
   * refused, so no row exists with it false (serializers.ts:94, ADR-0004).
   */
  it("derives each entry's trust level from that row's signals", async () => {
    const verified = await seedPublisher({ login: "acme", is_verified: true });
    const unverified = await seedPublisher({ login: "hobbyist", is_verified: false });

    await seedPackage({ name: "plain", publisher: unverified, created_at: "2026-08-01T00:00:00Z" });
    await seedPackage({
      name: "vouched",
      publisher: unverified,
      package_trusted: true,
      created_at: "2026-08-02T00:00:00Z",
    });
    await seedPackage({ name: "attested", publisher: verified, created_at: "2026-08-03T00:00:00Z" });

    const { body } = await apiGet("/api/stats");

    expect(entryFor(body, "attested").trustLevel).toBe("verified");
    expect(entryFor(body, "attested").publisherVerified).toBe(true);
    expect(entryFor(body, "vouched").trustLevel).toBe("trusted");
    expect(entryFor(body, "plain").trustLevel).toBe("recognized");
    expect(entryFor(body, "plain").publisherLogin).toBe("hobbyist");
  });
});
