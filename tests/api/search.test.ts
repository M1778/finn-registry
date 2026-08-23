/**
 * `GET /api/packages` — search and browse, docs/REGISTRY-CONTRACT.md §3.5.
 *
 * The response is an envelope, not a bare array: the CLI needs `total` to
 * paginate, and §3.8 requires that "all packages" is never one call.
 */

import { describe, expect, it } from "vitest";
import { apiGet, seedPackage, seedPublisher } from "../setup";
import { expectErrorEnvelope, expectItemShape, expectNoCounters, ITEM_KEYS } from "../contract";

const names = (body: { items: Array<{ name: string }> }): string[] =>
  body.items.map((item) => item.name);

/**
 * One package at each trust level (§2.4):
 *   - `by-verified`   — verified publisher            → level `verified`
 *   - `moderated`     — moderator's vouch, no verified publisher → `trusted`
 *   - `plain`         — registered and nothing more   → `recognized`
 */
async function seedTrustLadder(): Promise<void> {
  const verified = await seedPublisher({ login: "acme", is_verified: true });
  const unverified = await seedPublisher({ login: "hobbyist", is_verified: false });

  await seedPackage({ name: "by-verified", publisher: verified });
  await seedPackage({ name: "moderated", publisher: unverified, package_trusted: true });
  await seedPackage({ name: "plain", publisher: unverified });
}

describe("GET /api/packages", () => {
  it("returns the {total, items} envelope, not a bare array", async () => {
    await seedPackage({ name: "http" });

    const { status, body } = await apiGet("/api/packages");

    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["items", "total"]);
    expect(typeof body.total).toBe("number");
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("returns the envelope on an empty registry", async () => {
    const { status, body } = await apiGet("/api/packages");

    expect(status).toBe(200);
    expect(body).toEqual({ total: 0, items: [] });
  });

  it("returns exactly the contract's item fields, publisher and trust nested", async () => {
    const publisher = await seedPublisher({ login: "acme", is_verified: true });
    await seedPackage({
      name: "http",
      description: "An HTTP client and server for Fin",
      publisher,
      created_at: "2026-03-04T05:06:07Z",
      versions: [{ version: "1.2.0" }],
    });

    const { body } = await apiGet("/api/packages");
    const [item] = body.items;

    // Exactly these keys, no more: §3.9 serves the same shape, and the web UI
    // normalizes both through one path.
    expect(Object.keys(item).sort()).toEqual([...ITEM_KEYS].sort());
    expectItemShape(item, "item");

    expect(item.name).toBe("http");
    expect(item.description).toBe("An HTTP client and server for Fin");
    expect(item.latest_version).toBe("1.2.0");
    expect(item.is_deprecated).toBe(false);
    expect(item.created_at).toBe("2026-03-04T05:06:07Z");
    expect(item.publisher.login).toBe("acme");
    expect(item.publisher.is_verified).toBe(true);
    expect(item.trust.level).toBe("verified");
  });

  /**
   * The registry measures neither downloads nor stars, so a page of items
   * publishes neither — the same decision `sort` makes below by refusing to
   * order by them. Declining to sort on a number while still printing it was the
   * inconsistent half-measure.
   */
  it("publishes no download or star counter on an item", async () => {
    await seedPackage({ name: "http", downloads: 4321, stars: 987 });

    const { body, text } = await apiGet("/api/packages");

    expectNoCounters(body, "§3.5 page");
    expect(body.items[0].downloads).toBeUndefined();
    expect(text).not.toContain("4321");
    expect(text).not.toContain("987");
  });

  it("reports is_deprecated true on a deprecated package", async () => {
    await seedPackage({
      name: "old",
      is_deprecated: true,
      deprecation_message: "Use `http` instead",
    });

    const { body } = await apiGet("/api/packages");

    // The flag rides along so a browse page can mark the row; the message does
    // not, because §3.5's item shape does not carry it.
    expect(body.items[0].is_deprecated).toBe(true);
    expect(body.items[0].deprecation_message).toBeUndefined();
  });

  it("reports latest_version null on an item with no version records", async () => {
    await seedPackage({ name: "http", versions: [] });

    const { body } = await apiGet("/api/packages");

    expect(body.items[0].latest_version).toBeNull();
  });

  it("leaks no camelCase keys (§3.1)", async () => {
    await seedPackage({ name: "http" });

    const { body } = await apiGet("/api/packages");
    const [item] = body.items;

    expect(Object.keys(item).filter((key) => /[A-Z]/.test(key))).toEqual([]);
    expect(item.repoUrl).toBeUndefined();
    expect(item.latestVersion).toBeUndefined();
    expect(item.isVerified).toBeUndefined();
    expect(item.isDeprecated).toBeUndefined();
    expect(item.createdAt).toBeUndefined();
  });

  it("counts every match in total, not just the returned page", async () => {
    await seedPackage({ name: "http" });
    await seedPackage({ name: "json" });
    await seedPackage({ name: "toml" });

    const { body } = await apiGet("/api/packages?limit=2");

    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(2);
  });

  it("defaults to a limit of 25", async () => {
    for (let index = 0; index < 30; index += 1) {
      await seedPackage({ name: `pkg-${index}` });
    }

    const { body } = await apiGet("/api/packages");

    expect(body.total).toBe(30);
    expect(body.items).toHaveLength(25);
  });

  it("caps limit at 100", async () => {
    const publisher = await seedPublisher({ login: "acme" });
    for (let index = 0; index < 105; index += 1) {
      await seedPackage({ name: `pkg-${index}`, publisher });
    }

    const { body } = await apiGet("/api/packages?limit=500");

    expect(body.total).toBe(105);
    expect(body.items).toHaveLength(100);
  });

  it("pages with offset", async () => {
    await seedPackage({ name: "alpha" });
    await seedPackage({ name: "bravo" });
    await seedPackage({ name: "charlie" });

    const { body } = await apiGet("/api/packages?sort=name&limit=1&offset=1");

    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe("bravo");
  });

  it("filters by q against the name", async () => {
    await seedPackage({ name: "http", description: "networking" });
    await seedPackage({ name: "toml", description: "config parsing" });

    const { body } = await apiGet("/api/packages?q=htt");

    expect(body.total).toBe(1);
    expect(names(body)).toEqual(["http"]);
  });

  it("filters by q against the description", async () => {
    await seedPackage({ name: "http", description: "networking" });
    await seedPackage({ name: "toml", description: "config parsing" });

    const { body } = await apiGet("/api/packages?q=config");

    expect(body.total).toBe(1);
    expect(names(body)).toEqual(["toml"]);
  });

  it("returns an empty page with total 0 when q matches nothing", async () => {
    await seedPackage({ name: "http" });

    const { status, body } = await apiGet("/api/packages?q=zzzz");

    expect(status).toBe(200);
    expect(body).toEqual({ total: 0, items: [] });
  });

  // --- sort -----------------------------------------------------------------

  it("sorts by recent, newest registration first", async () => {
    await seedPackage({ name: "oldest", created_at: "2026-01-01T00:00:00Z" });
    await seedPackage({ name: "newest", created_at: "2026-08-01T00:00:00Z" });
    await seedPackage({ name: "middle", created_at: "2026-04-01T00:00:00Z" });

    const { body } = await apiGet("/api/packages?sort=recent");

    expect(names(body)).toEqual(["newest", "middle", "oldest"]);
  });

  it("defaults to recent when sort is omitted", async () => {
    await seedPackage({ name: "oldest", created_at: "2026-01-01T00:00:00Z" });
    await seedPackage({ name: "newest", created_at: "2026-08-01T00:00:00Z" });
    await seedPackage({ name: "middle", created_at: "2026-04-01T00:00:00Z" });

    const { body } = await apiGet("/api/packages");

    expect(names(body)).toEqual(["newest", "middle", "oldest"]);
  });

  it("sorts by updated, most recently updated first", async () => {
    // created_at order is the reverse of updated_at order, so a handler that
    // ignores `sort=updated` and falls through to `recent` fails here.
    await seedPackage({
      name: "stale",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    });
    await seedPackage({
      name: "fresh",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-20T00:00:00Z",
    });

    const { body } = await apiGet("/api/packages?sort=updated");

    expect(names(body)).toEqual(["fresh", "stale"]);
  });

  it("sorts by name, ascending", async () => {
    // Registration order is deliberately not alphabetical.
    await seedPackage({ name: "toml", created_at: "2026-08-01T00:00:00Z" });
    await seedPackage({ name: "http", created_at: "2026-08-02T00:00:00Z" });
    await seedPackage({ name: "json", created_at: "2026-08-03T00:00:00Z" });

    const { body } = await apiGet("/api/packages?sort=name");

    expect(names(body)).toEqual(["http", "json", "toml"]);
  });

  /**
   * `sort` is an allowlist of `recent | updated | name`.
   *
   * `downloads` and `stars` are the specific values this must reject: the UI
   * offered both for months while nothing incremented a download count and
   * stars were never recorded, so they ordered every row by the same number and
   * silently did nothing. Accepting them with a 200 and the default ordering is
   * the bug, not a lenient fallback — a caller that asks for an ordering the
   * registry cannot provide has to be told.
   */
  it.each(["downloads", "stars", "trending"])(
    "does not silently accept sort=%s",
    async (sort) => {
      await seedPackage({ name: "http" });

      const { status, body } = await apiGet(`/api/packages?sort=${encodeURIComponent(sort)}`);

      expect(status).toBe(400);
      expect(body.error).toBe("invalid_sort");
      expectErrorEnvelope(body);
      expect(body.items).toBeUndefined();
    },
  );

  // --- trust ----------------------------------------------------------------

  it("filters trust=verified to verified publishers only", async () => {
    await seedTrustLadder();

    const { status, body } = await apiGet("/api/packages?trust=verified");

    expect(status).toBe(200);
    expect(names(body)).toEqual(["by-verified"]);
    expect(body.total).toBe(1);
  });

  /**
   * `trust=trusted` means *trusted or better*, so it must include packages by a
   * verified publisher.
   *
   * Asserted as an explicit membership check rather than a set comparison,
   * because an implementation that filters on the raw `is_trusted` column
   * instead of the derived level returns only `moderated` — and that is the
   * exact mistake §2.4 and §3.5 both warn about.
   */
  it("includes verified packages in trust=trusted, because it means at least trusted", async () => {
    await seedTrustLadder();

    const { status, body } = await apiGet("/api/packages?trust=trusted");

    expect(status).toBe(200);
    expect(names(body)).toContain("by-verified");
    expect(names(body)).toContain("moderated");
    expect(names(body)).not.toContain("plain");
    expect(body.total).toBe(2);
    expect(body.items.map((item: { trust: { level: string } }) => item.trust.level).sort()).toEqual([
      "trusted",
      "verified",
    ]);
  });

  it("does not filter at all when trust is omitted", async () => {
    await seedTrustLadder();

    const { body } = await apiGet("/api/packages");

    expect(body.total).toBe(3);
  });

  /**
   * `trust=recognized` is a documented no-op.
   *
   * Recognized is the floor of the ladder (§2.4) — everything on the register is
   * at least recognized, because a row only exists once push access was proven.
   * So "at least recognized" is the whole register, and the filter is accepted
   * rather than refused: a generated client that always sends the user's
   * selection should not have to special-case the bottom of its own dropdown,
   * and rejecting a value that is semantically meaningful would be surprising.
   *
   * Asserted as "identical to the same query with no filter", which is stronger
   * than a count: a handler that quietly filtered on the raw `is_trusted` column
   * would still return three rows here if the ladder happened to line up.
   */
  it("treats trust=recognized as no filter at all", async () => {
    await seedTrustLadder();

    const unfiltered = await apiGet("/api/packages?sort=name");
    const recognized = await apiGet("/api/packages?sort=name&trust=recognized");

    expect(recognized.status).toBe(200);
    expect(recognized.body).toEqual(unfiltered.body);
    expect(names(recognized.body)).toEqual(["by-verified", "moderated", "plain"]);
  });

  it.each(["unrecognized", "banana"])(
    "rejects trust=%s rather than filtering on a level it cannot publish",
    async (trust) => {
      await seedTrustLadder();

      const { status, body } = await apiGet(`/api/packages?trust=${encodeURIComponent(trust)}`);

      expect(status).toBe(400);
      expect(body.error).toBe("invalid_trust");
      expectErrorEnvelope(body);
      expect(body.items).toBeUndefined();
    },
  );

  it("applies q and trust together", async () => {
    await seedTrustLadder();

    const { body } = await apiGet("/api/packages?q=e&trust=verified");

    expect(names(body)).toEqual(["by-verified"]);
  });
});
