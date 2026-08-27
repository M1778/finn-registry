/**
 * `GET /api/publishers/:login` — the publisher profile, docs/REGISTRY-CONTRACT.md §3.9.
 *
 * The CLI never calls this. It is tested anyway for one reason: its `items` are
 * specified as "the same item shape as §3.5", and a second serializer for the
 * same shape is exactly how the two drift apart.
 */

import { describe, expect, it } from "vitest";
import { apiGet, seedPackage, seedPublisher } from "../setup";
import {
  allKeys,
  expectItemShape,
  expectNoCounters,
  expectSnakeCase,
  ISO_INSTANT,
  PUBLISHER_PROFILE_KEYS,
} from "../contract";

describe("GET /api/publishers/:login", () => {
  it("returns exactly {publisher, total, items}", async () => {
    const publisher = await seedPublisher({ login: "acme" });
    await seedPackage({ name: "http", publisher });

    const { status, body } = await apiGet("/api/publishers/acme");

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["items", "publisher", "total"]);
    expect(body.total).toBe(1);
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("returns exactly the contract's publisher fields", async () => {
    const publisher = await seedPublisher({
      login: "acme",
      display_name: "Acme Corp",
      avatar_url: "https://avatars.example/acme.png",
      is_verified: true,
      created_at: "2026-02-03T04:05:06Z",
    });
    await seedPackage({ name: "http", publisher });

    const { body } = await apiGet("/api/publishers/acme");

    expect(Object.keys(body.publisher).sort()).toEqual([...PUBLISHER_PROFILE_KEYS].sort());
    expectSnakeCase(body.publisher, "publisher");
    expect(body.publisher.login).toBe("acme");
    expect(body.publisher.display_name).toBe("Acme Corp");
    expect(body.publisher.avatar_url).toBe("https://avatars.example/acme.png");
    expect(body.publisher.kind).toBe("user");
    expect(body.publisher.is_verified).toBe(true);
    expect(body.publisher.created_at).toBe("2026-02-03T04:05:06Z");
    expect(body.publisher.created_at).toMatch(ISO_INSTANT);
  });

  /**
   * An organisation profile resolves as an organisation.
   *
   * This depends on an ordering that is easy to break. The handler resolves
   * `:login` against `users.login` FIRST and only falls through to
   * `organizations.name` when no account matches, so a users row whose login
   * equals an organisation's name makes the organisation branch unreachable: the
   * profile comes back `kind: "user"`, with the wrong display name and avatar,
   * and — because the two branches also select packages differently, one by
   * `owner_id` and one by `organization_id` — quite possibly a 404 for an
   * organisation that has registered plenty.
   *
   * What makes the ordering safe is external to this codebase: GitHub logins are
   * unique across users AND organisations, so the shadowing row cannot exist in
   * real data. That is a load-bearing assumption about someone else's namespace,
   * so it is written down here rather than left implicit in the seed helper —
   * which mirrors the uniqueness by giving an organisation's owning account its
   * own distinct login.
   *
   * If the accounts and organisations tables ever stop being fed by GitHub, or a
   * local/test account can pick an arbitrary login, this ordering has to become
   * an explicit disambiguation rather than a fallback.
   */
  it("reports kind organization for an organisation profile", async () => {
    const publisher = await seedPublisher({
      login: "acme",
      display_name: "Acme Corp",
      kind: "organization",
      is_verified: true,
    });
    await seedPackage({ name: "http", publisher });

    const { status, body } = await apiGet("/api/publishers/acme");

    expect(status).toBe(200);
    expect(body.publisher.kind).toBe("organization");
    expect(body.publisher.login).toBe("acme");
    expect(body.publisher.display_name).toBe("Acme Corp");
    // Verification lives on the account that registered the name (§2.4), and it
    // has to survive being read through the organisation.
    expect(body.publisher.is_verified).toBe(true);
    // The organisation's packages are found by the organisation link, not by the
    // owning account's id.
    expect(body.total).toBe(1);
    expect(body.items[0].name).toBe("http");
  });

  /**
   * The other half of the same invariant: the account that owns the organisation
   * is a separate login with a separate profile, and it has registered nothing
   * under its own name.
   *
   * Together with the test above this pins the ordering in both directions — the
   * organisation login must not resolve to its owner, and the owner login must
   * not inherit the organisation's packages.
   */
  it("does not conflate an organisation with the account that owns it", async () => {
    const publisher = await seedPublisher({
      login: "acme",
      display_name: "Acme Corp",
      kind: "organization",
    });
    await seedPackage({ name: "http", publisher });

    // Distinct, as GitHub's global uniqueness guarantees.
    expect(publisher.owner_login).not.toBe(publisher.login);

    const owner = await apiGet(`/api/publishers/${publisher.owner_login}`);

    // The human owns the organisation but has claimed no names personally, so by
    // the glossary they are not a publisher.
    expect(owner.status).toBe(404);
    expect(owner.body.error).toBe("not_found");
  });

  it("serves the §3.5 item shape", async () => {
    const publisher = await seedPublisher({ login: "acme", is_verified: true });
    await seedPackage({ name: "http", publisher, downloads: 3, versions: [{ version: "1.2.0" }] });

    const { body } = await apiGet("/api/publishers/acme");

    expectItemShape(body.items[0], "items[0]");
  });

  /**
   * The same package, served by both endpoints, must serialize identically —
   * byte for byte, key order included.
   *
   * Key order is not cosmetic here: two objects that differ only in order came
   * out of two different pieces of code, which is the thing this test exists to
   * prevent. §3.5 and §3.9 have to share one serializer.
   */
  it("serves items byte-identical to §3.5", async () => {
    const publisher = await seedPublisher({ login: "acme", is_verified: true });
    await seedPackage({
      name: "http",
      description: "An HTTP client",
      publisher,
      downloads: 12,
      is_deprecated: true,
      deprecation_message: "Use `fetch`",
      created_at: "2026-05-06T07:08:09Z",
      versions: [{ version: "2.1.0" }],
    });

    const search = await apiGet("/api/packages?q=http");
    const profile = await apiGet("/api/publishers/acme");

    expect(search.body.items).toHaveLength(1);
    expect(profile.body.items).toHaveLength(1);
    expect(profile.body.items[0]).toEqual(search.body.items[0]);
    expect(JSON.stringify(profile.body.items[0])).toBe(JSON.stringify(search.body.items[0]));
  });

  it("lists only that publisher's packages", async () => {
    const acme = await seedPublisher({ login: "acme" });
    const other = await seedPublisher({ login: "hobbyist" });
    await seedPackage({ name: "http", publisher: acme });
    await seedPackage({ name: "json", publisher: acme });
    await seedPackage({ name: "toml", publisher: other });

    const { body } = await apiGet("/api/publishers/acme");

    expect(body.total).toBe(2);
    expect(body.items.map((item: { name: string }) => item.name).sort()).toEqual(["http", "json"]);
  });

  /**
   * The order, asked as its own question.
   *
   * The membership assertion above normalises with `.sort()` on purpose, and it
   * stays that way: "these two names and no others" and "in this order" are
   * different claims, and converting the first into the second would leave the
   * first unasked.
   *
   * Newest registration first, ties broken by `name` ascending — the same total
   * order as §5.4 under `sort=recent`, and a documented guarantee (REGISTRY-API
   * §6.3) rather than an implementation detail, because this endpoint pages.
   * `offset` over an order that leaves ties unresolved repeats a row on one page
   * and drops it from another.
   *
   * `alpha` and `omega` share a `created_at` so the tie-break is what separates
   * them, and the three are registered in neither the asserted order nor its
   * reverse — measured, not assumed. Removing the `orderBy` outright returns
   * *reversed* registration order rather than registration order, because
   * `desc(created_at)` is sorted by scanning ascending and reversing, so a fixture
   * registered in the reverse of the asserted order would come back in exactly the
   * asserted order and detect nothing.
   */
  it("lists newest registration first, ties broken by name", async () => {
    const acme = await seedPublisher({ login: "acme" });
    const sameInstant = "2026-03-01T00:00:00Z";
    await seedPackage({ name: "alpha", publisher: acme, created_at: sameInstant });
    await seedPackage({ name: "newest", publisher: acme, created_at: "2026-08-01T00:00:00Z" });
    await seedPackage({ name: "omega", publisher: acme, created_at: sameInstant });

    const { body } = await apiGet("/api/publishers/acme");

    expect(body.items.map((item: { name: string }) => item.name)).toEqual([
      "newest",
      "alpha",
      "omega",
    ]);
  });

  /**
   * Per the glossary a publisher *is* an account that registered a package, so
   * an account that has claimed no names is not a publisher and 404s — the same
   * answer as a login that was never seen at all. Anything else would turn this
   * endpoint into an account-existence oracle.
   */
  it("404s a login that has an account but has registered nothing", async () => {
    await seedPublisher({ login: "ghost" });

    const { status, body } = await apiGet("/api/publishers/ghost");

    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
    expect(typeof body.message).toBe("string");
    expect(body.publisher).toBeUndefined();
    expect(body.items).toBeUndefined();
  });

  it("404s an unknown login", async () => {
    const publisher = await seedPublisher({ login: "acme" });
    await seedPackage({ name: "http", publisher });

    const { status, body } = await apiGet("/api/publishers/nobody");

    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
  });

  it("does not prefix-match a login", async () => {
    const publisher = await seedPublisher({ login: "acme" });
    await seedPackage({ name: "http", publisher });

    const { status } = await apiGet("/api/publishers/ac");

    expect(status).toBe(404);
  });

  /**
   * §3.9: no download or star counter, anywhere.
   *
   * Not "no totals" — none at all. The registry measures neither, so a
   * permanently-zero column is worse than silence: it would render as a real
   * figure on a profile page. Seeded with non-zero values so a serializer that
   * passes the columns straight through cannot hide behind a coincidental zero,
   * and asserted over the whole response rather than a field list, so an
   * aggregate added to the envelope later trips it too.
   */
  it("publishes no download or star counter anywhere in the response", async () => {
    const publisher = await seedPublisher({ login: "acme" });
    await seedPackage({ name: "http", publisher, downloads: 4321, stars: 987 });
    await seedPackage({ name: "json", publisher, downloads: 5678, stars: 654 });

    const { body, text } = await apiGet("/api/publishers/acme");

    expectNoCounters(body, "§3.9 profile");
    expect(body.items[0].downloads).toBeUndefined();
    expect(body.publisher.downloads).toBeUndefined();
    for (const figure of ["4321", "5678", "987", "654"]) {
      expect(text, `profile leaks the counter ${figure}`).not.toContain(figure);
    }
    // `total` is a package count, not a download count.
    expect(body.total).toBe(2);
  });

  it("leaks no camelCase keys (§3.1)", async () => {
    const publisher = await seedPublisher({ login: "acme" });
    await seedPackage({ name: "http", publisher });

    const { body } = await apiGet("/api/publishers/acme");

    expect([...allKeys(body)].filter((key) => /[A-Z]/.test(key))).toEqual([]);
  });
});
