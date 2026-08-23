/**
 * Permanent regression: the registry never invents a version.
 *
 * Four separate files once defaulted a missing `latest_version` to `"1.0.0"` —
 * two serializers, a dashboard query and a page component — so a registered name
 * with no releases appeared to have a release. This is the worst possible failure
 * for `finn`: a fabricated version resolves, the checkout fails to find the tag,
 * and the publisher's repository takes the blame for the registry's guess.
 *
 * The rule enforced here: no response body from any endpoint may contain the
 * literal string `1.0.0` unless a version record with that exact version was
 * seeded. It is deliberately blunt — a substring scan over the raw response text,
 * with no knowledge of which field a default might hide in — because the point is
 * to catch the *next* place someone writes `?? "1.0.0"`, not the four that were
 * already found.
 *
 * A test here failing does not necessarily mean `latest_version` is wrong. It
 * means the string appears somewhere it was not seeded, and the response text in
 * the failure output says where.
 */

import { describe, expect, it } from "vitest";
import { apiGet, seedPackage, seedPublisher, seedSession, type SeededSession } from "../setup";

const FABRICATED = "1.0.0";

/**
 * Every endpoint a browser or CLI can read, with a registry seeded so that
 * `1.0.0` is nowhere in the data.
 *
 * No entry names a version in its own URL. An error message that repeats what
 * was asked for — `has no version 1.0.0` — is the endpoint quoting the caller,
 * not inventing data, and a sweep that flagged it would be pressuring the
 * handlers into vaguer errors. Resolving `1.0.0` is asserted separately below.
 */
const READ_ENDPOINTS = [
  "/api/health",
  "/api/stats",
  "/api/search/suggestions?q=h",
  "/api/search/suggestions?q=with-releases",
  "/api/packages",
  "/api/packages?sort=name",
  "/api/packages?q=no-releases",
  "/api/packages/no-releases",
  "/api/packages/no-releases/versions",
  "/api/packages/with-releases",
  "/api/packages/with-releases/versions",
  "/api/packages/with-releases/versions/2.3.4",
  "/api/packages/never-registered",
  "/api/publishers/acme",
  "/api/publishers/nobody",
  "/api/auth/status",
];

/** Endpoints that only answer a signed-in browser. */
const SESSION_ENDPOINTS = ["/api/dashboard/data", "/api/me/settings"];

/**
 * Two packages: one with no releases at all (the case that used to be filled in
 * with a fabricated version) and one whose only release is deliberately not
 * `1.0.0`, so a hardcoded default cannot hide behind a real value.
 */
async function seedWithoutThatVersion(): Promise<SeededSession> {
  const publisher = await seedPublisher({ login: "acme", is_verified: true });

  await seedPackage({ name: "no-releases", publisher, versions: [] });
  await seedPackage({
    name: "with-releases",
    publisher,
    versions: [{ version: "2.3.4" }, { version: "0.2.0" }],
  });

  return seedSession({ publisher });
}

describe("no endpoint invents version 1.0.0", () => {
  it.each(READ_ENDPOINTS)("%s", async (endpoint) => {
    await seedWithoutThatVersion();

    const { text } = await apiGet(endpoint);

    expect(text, `${endpoint} reported a version that was never seeded`).not.toContain(FABRICATED);
  });

  it.each(SESSION_ENDPOINTS)("%s (signed in)", async (endpoint) => {
    const session = await seedWithoutThatVersion();

    const { text } = await apiGet(endpoint, {
      headers: { Cookie: `auth_token=${session.token}` },
    });

    expect(text, `${endpoint} reported a version that was never seeded`).not.toContain(FABRICATED);
  });

  it("says nothing about versions for a package that has none", async () => {
    await seedWithoutThatVersion();

    const record = await apiGet("/api/packages/no-releases");
    expect(record.body.latest_version).toBeNull();

    const versions = await apiGet("/api/packages/no-releases/versions");
    expect(versions.body.versions).toEqual([]);

    // The one place `1.0.0` may legitimately appear in a response about a
    // package that has no such version: quoted back inside a 404. What must not
    // appear is anything resembling a resolved record.
    const resolve = await apiGet("/api/packages/no-releases/versions/1.0.0");
    expect(resolve.status).toBe(404);
    expect(resolve.body.version).toBeUndefined();
    expect(resolve.body.git_ref).toBeUndefined();
    expect(resolve.body.commit).toBeUndefined();
    expect(resolve.body.checksum).toBeUndefined();
  });

  /**
   * The control. Every assertion above is a negative, and a negative passes just
   * as happily when the sweep is broken, the seed is empty, or the endpoints all
   * 500. This proves the scan can still see a version that is genuinely there.
   */
  it("does report 1.0.0 when a 1.0.0 version really was seeded", async () => {
    const publisher = await seedPublisher({ login: "acme" });
    await seedPackage({ name: "real", publisher, versions: [{ version: "1.0.0" }] });

    const record = await apiGet("/api/packages/real");
    expect(record.body.latest_version).toBe(FABRICATED);
    expect(record.text).toContain(FABRICATED);

    const versions = await apiGet("/api/packages/real/versions");
    expect(versions.text).toContain(FABRICATED);

    const resolved = await apiGet("/api/packages/real/versions/1.0.0");
    expect(resolved.status).toBe(200);
    expect(resolved.body.version).toBe(FABRICATED);
  });
});
