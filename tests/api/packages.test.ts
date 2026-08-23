/**
 * `GET /api/packages/:name` — docs/REGISTRY-CONTRACT.md §3.2.
 *
 * The field names below are the interface: the `finn` CLI deserializes this
 * response into `PackageMetadata`, so a camelCased or renamed key is a broken
 * contract, not a cosmetic difference (§3.1).
 */

import { describe, expect, it } from "vitest";
import { apiGet, seedPackage, seedPublisher } from "../setup";
import {
  expectNoCounters,
  ISO_INSTANT,
  PACKAGE_KEYS,
  PUBLISHER_KEYS,
  TRUST_KEYS,
} from "../contract";

async function seedContractExample() {
  const publisher = await seedPublisher({
    login: "acme",
    display_name: "Acme Corp",
    avatar_url: "https://avatars.example/acme.png",
    kind: "organization",
    is_verified: true,
  });

  return seedPackage({
    name: "http",
    description: "An HTTP client and server for Fin",
    repo_url: "https://github.com/acme/fin-http",
    homepage: null,
    license: "MIT",
    keywords: ["net", "http"],
    publisher,
    package_trusted: true,
    repo_ownership_confirmed: true,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    versions: [{ version: "1.2.0" }],
  });
}

describe("GET /api/packages/:name", () => {
  it("returns exactly the contract's top-level fields", async () => {
    await seedContractExample();

    const { status, body } = await apiGet("/api/packages/http");

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([...PACKAGE_KEYS].sort());
  });

  it("returns the contract's values for a fully populated package", async () => {
    await seedContractExample();

    const { body } = await apiGet("/api/packages/http");

    expect(body.name).toBe("http");
    expect(body.description).toBe("An HTTP client and server for Fin");
    expect(body.repo_url).toBe("https://github.com/acme/fin-http");
    expect(body.homepage).toBeNull();
    expect(body.license).toBe("MIT");
    expect(body.keywords).toEqual(["net", "http"]);
    expect(body.latest_version).toBe("1.2.0");
    expect(body.is_deprecated).toBe(false);
    expect(body.deprecation_message).toBeNull();
    expect(body.created_at).toMatch(ISO_INSTANT);
    expect(body.updated_at).toMatch(ISO_INSTANT);
  });

  /**
   * The registry measures neither downloads nor stars, so it reports neither.
   *
   * The column still exists and still holds a number; publishing it would mean
   * every package in the registry advertising `downloads: 0` forever, which
   * reads as "nobody uses this" rather than "not counted". Seeded here with a
   * non-zero value precisely so that a serializer passing the column straight
   * through cannot hide behind a coincidental zero.
   */
  it("publishes no download or star counter", async () => {
    const publisher = await seedPublisher({ login: "acme" });
    await seedPackage({ name: "http", publisher, downloads: 4321, stars: 987 });

    const { body, text } = await apiGet("/api/packages/http");

    expectNoCounters(body, "§3.2 record");
    expect(body.downloads).toBeUndefined();
    expect(text).not.toContain("4321");
    expect(text).not.toContain("987");
  });

  it("nests the publisher in a publisher{} object", async () => {
    await seedContractExample();

    const { body } = await apiGet("/api/packages/http");

    expect(Object.keys(body.publisher).sort()).toEqual([...PUBLISHER_KEYS].sort());
    expect(body.publisher.login).toBe("acme");
    expect(body.publisher.display_name).toBe("Acme Corp");
    expect(body.publisher.avatar_url).toBe("https://avatars.example/acme.png");
    expect(body.publisher.kind).toBe("organization");
    expect(body.publisher.is_verified).toBe(true);
  });

  it("nests the trust signals in a trust{} object", async () => {
    await seedContractExample();

    const { body } = await apiGet("/api/packages/http");

    expect(Object.keys(body.trust).sort()).toEqual([...TRUST_KEYS].sort());
    expect(body.trust.publisher_verified).toBe(true);
    expect(body.trust.package_trusted).toBe(true);
    expect(body.trust.repo_ownership_confirmed).toBe(true);
  });

  it("reports kind 'user' for an individual publisher", async () => {
    const publisher = await seedPublisher({ login: "ada", kind: "user" });
    await seedPackage({ name: "json", publisher });

    const { body } = await apiGet("/api/packages/json");

    expect(body.publisher.kind).toBe("user");
  });

  it("derives trust.level verified when the publisher is verified", async () => {
    const publisher = await seedPublisher({ login: "acme", is_verified: true });
    await seedPackage({ name: "http", publisher, package_trusted: false });

    const { body } = await apiGet("/api/packages/http");

    expect(body.trust.level).toBe("verified");
  });

  it("derives trust.level trusted when only the package is vouched for", async () => {
    const publisher = await seedPublisher({ login: "ada", is_verified: false });
    await seedPackage({ name: "http", publisher, package_trusted: true });

    const { body } = await apiGet("/api/packages/http");

    expect(body.trust.level).toBe("trusted");
  });

  it("derives trust.level recognized for a registration with no admin signal", async () => {
    const publisher = await seedPublisher({ login: "ada", is_verified: false });
    await seedPackage({ name: "http", publisher, package_trusted: false });

    const { body } = await apiGet("/api/packages/http");

    expect(body.trust.level).toBe("recognized");
  });

  it("never reports the CLI-only level 'unrecognized'", async () => {
    await seedPackage({ name: "http" });

    const { body } = await apiGet("/api/packages/http");

    expect(["verified", "trusted", "recognized"]).toContain(body.trust.level);
  });

  it("returns latest_version null when the package has no version records", async () => {
    await seedPackage({ name: "http", versions: [] });

    const { status, body } = await apiGet("/api/packages/http");

    expect(status).toBe(200);
    // §3.2: "Do not substitute a default." Fabricating "1.0.0" here is the bug
    // the contract calls out by name.
    expect(body.latest_version).toBeNull();
    expect(body.latest_version).not.toBe("1.0.0");
  });

  it("picks latest_version by semver, not by string order or insert order", async () => {
    await seedPackage({
      name: "http",
      versions: [{ version: "1.9.0" }, { version: "1.10.0" }, { version: "1.2.0" }],
    });

    const { body } = await apiGet("/api/packages/http");

    expect(body.latest_version).toBe("1.10.0");
  });

  it("returns booleans as booleans, not as SQLite 0/1", async () => {
    await seedPackage({ name: "http", is_deprecated: false });

    const { body } = await apiGet("/api/packages/http");

    expect(typeof body.is_deprecated).toBe("boolean");
    expect(typeof body.publisher.is_verified).toBe("boolean");
    expect(typeof body.trust.publisher_verified).toBe("boolean");
    expect(typeof body.trust.package_trusted).toBe("boolean");
    expect(typeof body.trust.repo_ownership_confirmed).toBe("boolean");
  });

  it("surfaces deprecation", async () => {
    await seedPackage({
      name: "http",
      is_deprecated: true,
      deprecation_message: "Use fetch instead",
    });

    const { body } = await apiGet("/api/packages/http");

    expect(body.is_deprecated).toBe(true);
    expect(body.deprecation_message).toBe("Use fetch instead");
  });

  it("leaks no camelCase keys (§3.1)", async () => {
    await seedContractExample();

    const { body } = await apiGet("/api/packages/http");

    const camelCased = (object: Record<string, unknown>) =>
      Object.keys(object).filter((key) => /[A-Z]/.test(key));

    expect(camelCased(body)).toEqual([]);
    expect(camelCased(body.publisher)).toEqual([]);
    expect(camelCased(body.trust)).toEqual([]);
    expect(body.repoUrl).toBeUndefined();
    expect(body.latestVersion).toBeUndefined();
    expect(body.isDeprecated).toBeUndefined();
    expect(body.isVerified).toBeUndefined();
  });

  it("404s an unregistered name with the contract's error body", async () => {
    await seedPackage({ name: "http" });

    const { status, body } = await apiGet("/api/packages/nonexistent");

    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("404s rather than matching a name by prefix", async () => {
    await seedPackage({ name: "http" });

    const { status, body } = await apiGet("/api/packages/htt");

    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
  });
});
