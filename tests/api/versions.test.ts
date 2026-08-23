/**
 * Version records — docs/REGISTRY-CONTRACT.md §3.3 and §3.4.
 *
 * The registry publishes version records and the CLI picks (§1). So the list is
 * ordered by semver descending and the single-version route resolves exact
 * versions only: a range must not resolve here, ever.
 */

import { describe, expect, it } from "vitest";
import { apiGet, seedPackage } from "../setup";

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const VERSION_KEYS = [
  "version",
  "git_ref",
  "commit",
  "checksum",
  "checksum_origin",
  "yanked",
  "published_at",
];

describe("GET /api/packages/:name/versions", () => {
  it("returns the {name, versions} envelope", async () => {
    await seedPackage({ name: "http", versions: [{ version: "1.2.0" }] });

    const { status, body } = await apiGet("/api/packages/http/versions");

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["name", "versions"]);
    expect(body.name).toBe("http");
    expect(Array.isArray(body.versions)).toBe(true);
  });

  it("returns exactly the contract's fields on each version record", async () => {
    await seedPackage({
      name: "http",
      versions: [
        {
          version: "1.2.0",
          git_ref: "v1.2.0",
          commit: "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
          checksum: "sha256:aaa",
          checksum_origin: "publisher_attested",
          yanked: false,
          published_at: "2026-08-20T00:00:00Z",
        },
      ],
    });

    const { body } = await apiGet("/api/packages/http/versions");
    const [record] = body.versions;

    expect(Object.keys(record).sort()).toEqual([...VERSION_KEYS].sort());
    expect(record.version).toBe("1.2.0");
    expect(record.git_ref).toBe("v1.2.0");
    expect(record.commit).toBe("9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3");
    expect(record.checksum).toBe("sha256:aaa");
    expect(record.checksum_origin).toBe("publisher_attested");
    expect(record.yanked).toBe(false);
    expect(record.published_at).toMatch(ISO_INSTANT);
  });

  it("orders newest first, semver-descending", async () => {
    await seedPackage({
      name: "http",
      versions: [
        { version: "1.2.0" },
        { version: "0.9.0" },
        { version: "2.0.0" },
        { version: "1.10.0" },
        { version: "0.10.0" },
      ],
    });

    const { body } = await apiGet("/api/packages/http/versions");

    expect(body.versions.map((v: { version: string }) => v.version)).toEqual([
      "2.0.0",
      "1.10.0",
      "1.2.0",
      "0.10.0",
      "0.9.0",
    ]);
  });

  it("orders 0.10.0 above 0.9.0, where semver and string order disagree", async () => {
    await seedPackage({
      name: "http",
      versions: [{ version: "0.9.0" }, { version: "0.10.0" }],
    });

    const { body } = await apiGet("/api/packages/http/versions");

    // "0.10.0" < "0.9.0" lexicographically, and 0.10.0 > 0.9.0 by semver.
    expect(body.versions.map((v: { version: string }) => v.version)).toEqual([
      "0.10.0",
      "0.9.0",
    ]);
  });

  it("does not fall back to insertion order", async () => {
    await seedPackage({
      name: "http",
      versions: [
        { version: "0.1.0", published_at: "2026-08-19T00:00:00Z" },
        { version: "0.3.0", published_at: "2026-08-01T00:00:00Z" },
        { version: "0.2.0", published_at: "2026-08-20T00:00:00Z" },
      ],
    });

    const { body } = await apiGet("/api/packages/http/versions");

    expect(body.versions.map((v: { version: string }) => v.version)).toEqual([
      "0.3.0",
      "0.2.0",
      "0.1.0",
    ]);
  });

  it("still lists a yanked version, flagged", async () => {
    await seedPackage({
      name: "http",
      versions: [{ version: "1.0.0", yanked: true }, { version: "0.9.0" }],
    });

    const { body } = await apiGet("/api/packages/http/versions");

    expect(body.versions.map((v: { version: string }) => v.version)).toEqual([
      "1.0.0",
      "0.9.0",
    ]);
    expect(body.versions[0].yanked).toBe(true);
    expect(body.versions[1].yanked).toBe(false);
    expect(typeof body.versions[0].yanked).toBe("boolean");
  });

  it("only ever reports checksum_origin publisher_attested, or null", async () => {
    await seedPackage({
      name: "http",
      versions: [
        { version: "1.0.0", checksum: null, checksum_origin: null },
        { version: "1.1.0", checksum: "sha256:bbb" },
      ],
    });

    const { body } = await apiGet("/api/packages/http/versions");

    for (const record of body.versions) {
      expect([null, "publisher_attested"]).toContain(record.checksum_origin);
    }
  });

  it("returns an empty list, not a 404, for a package with no versions", async () => {
    await seedPackage({ name: "http", versions: [] });

    const { status, body } = await apiGet("/api/packages/http/versions");

    expect(status).toBe(200);
    expect(body).toEqual({ name: "http", versions: [] });
  });

  it("leaks no camelCase keys (§3.1)", async () => {
    await seedPackage({ name: "http", versions: [{ version: "1.0.0" }] });

    const { body } = await apiGet("/api/packages/http/versions");

    expect(Object.keys(body.versions[0]).filter((key) => /[A-Z]/.test(key))).toEqual([]);
    expect(body.versions[0].gitRef).toBeUndefined();
    expect(body.versions[0].publishedAt).toBeUndefined();
  });

  it("404s an unregistered name with the contract's error body", async () => {
    const { status, body } = await apiGet("/api/packages/nonexistent/versions");

    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
    expect(typeof body.message).toBe("string");
  });
});

describe("GET /api/packages/:name/versions/:version", () => {
  const seedOne = () =>
    seedPackage({
      name: "http",
      repo_url: "https://github.com/acme/fin-http",
      versions: [
        {
          version: "1.2.0",
          git_ref: "v1.2.0",
          commit: "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
          checksum: "sha256:aaa",
          checksum_origin: "publisher_attested",
          yanked: false,
          published_at: "2026-08-20T00:00:00Z",
        },
        { version: "1.0.0" },
      ],
    });

  it("returns the version record plus repo_url, and nothing else", async () => {
    await seedOne();

    const { status, body } = await apiGet("/api/packages/http/versions/1.2.0");

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([...VERSION_KEYS, "repo_url"].sort());
    expect(body.version).toBe("1.2.0");
    expect(body.git_ref).toBe("v1.2.0");
    expect(body.commit).toBe("9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3");
    expect(body.checksum).toBe("sha256:aaa");
    expect(body.checksum_origin).toBe("publisher_attested");
    expect(body.yanked).toBe(false);
    expect(body.published_at).toMatch(ISO_INSTANT);
    expect(body.repo_url).toBe("https://github.com/acme/fin-http");
  });

  it("resolves a yanked version, so a lockfile that pins one still works", async () => {
    await seedPackage({ name: "http", versions: [{ version: "1.0.0", yanked: true }] });

    const { status, body } = await apiGet("/api/packages/http/versions/1.0.0");

    expect(status).toBe(200);
    expect(body.version).toBe("1.0.0");
    expect(body.yanked).toBe(true);
  });

  // Range semantics belong to the CLI (§1). The registry resolves exact
  // versions only, so a range must never come back resolved.
  //
  // A non-exact version is 400 `invalid_version`, never 404 (§3.4): the
  // distinction matters because §3.8 lets the CLI treat a genuine 404 as "this
  // does not exist" and stop looking, and a malformed request must not be
  // allowed to masquerade as that answer.
  it.each(["^1.0.0", "~1.2.0", ">=1.0.0", "1.2.x", "1.2", "latest"])(
    "rejects the range %s as invalid_version, not as a 404",
    async (range) => {
      await seedOne();

      const { status, body } = await apiGet(
        `/api/packages/http/versions/${encodeURIComponent(range)}`,
      );

      expect(status).toBe(400);
      expect(body.error).toBe("invalid_version");
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(0);
      // Nothing resolved: no version record leaked into the error body.
      expect(body.version).toBeUndefined();
      expect(body.git_ref).toBeUndefined();
      expect(body.commit).toBeUndefined();
    },
  );

  it("404s an unknown exact version", async () => {
    await seedOne();

    const { status, body } = await apiGet("/api/packages/http/versions/9.9.9");

    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
    expect(typeof body.message).toBe("string");
  });

  it("404s a known version on an unregistered name", async () => {
    await seedOne();

    const { status, body } = await apiGet("/api/packages/nonexistent/versions/1.2.0");

    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
  });
});
