/**
 * `GET /api/dashboard/data` — docs/REGISTRY-API.md §7.
 *
 * The counterfoil: the half of the register the signatory keeps. Browser-only,
 * so it is camelCase and not part of the §3 contract — the same footing as
 * `GET /api/stats`, and tested for the same two reasons.
 *
 * **It must publish no counter.** The registry measures neither downloads nor
 * stars; nothing increments either column. Five §3 endpoints have an
 * `expectNoCounters` guard for that (search, stats, publishers, packages,
 * registrations) and this one — the only session endpoint that returns package
 * rows — had none, which is how a whole Drizzle row came to be spread into every
 * entry. A permanently-zero figure renders as a real number, and a publisher
 * reading `stars: 0` beside their own name is being told something false about
 * their own package.
 *
 * **And it had no behavioural assertions at all.** The only call anywhere in the
 * suite was `tests/regressions/no-token-forgery.test.ts`, which checks
 * `status === 200` as the control for a forgery test. The handler documents two
 * rules in comments — `latestVersion` excludes yanked records and is `null`
 * rather than a fabricated `1.0.0` when there are none; `versionCount` counts
 * every record including yanked ones — and neither had ever been run.
 */

import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { logins, verificationRequests } from "@/lib/db/schema";
import { apiGet, seedPackage, seedPublisher, seedSession } from "../setup";
import { expectKeys, expectNoCounters, ISO_INSTANT } from "../contract";

const URL = "/api/dashboard/data";

/** §7 — the four sections of the counterfoil. */
const DASHBOARD_KEYS = ["user", "packages", "logins", "verification"];

/**
 * One entry the publisher holds.
 *
 * Exactly the fields `DashboardClient`'s own `DashboardPackage` declares. The
 * list is short on purpose: the page shows a name, its standing and its release
 * state, and every other column on `packages` is either internal (`ownerId`,
 * `organizationId`), already public elsewhere (`repoUrl`, `license`), or a figure
 * the registry does not measure (`downloads`, `stars`) or has never asked anyone
 * to choose (`category`, which defaults to "Utilities").
 */
const ENTRY_KEYS = [
  "id",
  "name",
  "description",
  "isTrusted",
  "isDeprecated",
  "latestVersion",
  "versionCount",
  "createdAt",
];

/** The account, as the page renders it. */
const USER_KEYS = ["login", "name", "email", "avatarUrl", "role", "isVerified", "createdAt"];

/** One recorded sign-in. */
const LOGIN_KEYS = ["id", "ipAddress", "userAgent", "createdAt"];

/** Where the account's verification stands *now*, not its whole history. */
const VERIFICATION_KEYS = ["status", "requestedAt", "reviewedAt", "reviewerNote"];

/** A signed-in publisher, and the dashboard as that publisher sees it. */
async function signIn(login = "acme", overrides: Parameters<typeof seedPublisher>[0] = {}) {
  const publisher = await seedPublisher({ login, ...overrides });
  const session = await seedSession({ publisher });
  return { publisher, session };
}

function dashboard(token: string) {
  return apiGet(URL, { headers: { Cookie: `auth_token=${token}` } });
}

/**
 * One recorded sign-in. Written directly because nothing else in the suite needs
 * one: the rows are only ever produced by the OAuth callback, which is not what
 * this file is about.
 */
async function recordSignIn(
  userId: string,
  row: { id: string; ipAddress?: string | null; userAgent?: string | null; createdAt?: string },
) {
  await getDb()
    .insert(logins)
    .values({
      id: row.id,
      userId,
      ipAddress: row.ipAddress ?? "198.51.100.7",
      userAgent: row.userAgent ?? "Mozilla/5.0",
      createdAt: row.createdAt ?? "2026-08-20T00:00:00Z",
    });
}

describe("GET /api/dashboard/data", () => {
  // --- counters -------------------------------------------------------------

  /**
   * The one guard the other five suites already have. Seeded non-zero so that a
   * column passed straight through cannot hide behind a coincidental `0`: the
   * defect this catches published the seeded figure verbatim.
   *
   * The raw text is checked as well as the parsed keys, because a renamed key
   * would smuggle the same number past `expectNoCounters` — what must not reach
   * a publisher is the figure, not the spelling.
   */
  it("publishes no download or star counter on an entry", async () => {
    const { publisher, session } = await signIn();
    await seedPackage({ name: "http", publisher, downloads: 4321, stars: 987 });

    const { status, body, text } = await dashboard(session.token);

    expect(status).toBe(200);
    expectNoCounters(body, "dashboard body");
    expect(body.packages[0].downloads).toBeUndefined();
    expect(body.packages[0].stars).toBeUndefined();
    expect(text).not.toContain("4321");
    expect(text).not.toContain("987");
  });

  // --- shape ----------------------------------------------------------------

  it("returns the four sections and nothing else", async () => {
    const { session } = await signIn();

    const { status, body } = await dashboard(session.token);

    expect(status).toBe(200);
    expectKeys(body, DASHBOARD_KEYS, "dashboard body");
  });

  /**
   * Exactly these fields on an entry. An exact key list is the assertion that
   * makes the counter test above permanent: a spread of a Drizzle row cannot
   * satisfy it, so a future column cannot arrive on the wire unnoticed.
   */
  it("builds an entry from named fields, not from a whole row", async () => {
    const { publisher, session } = await signIn();
    await seedPackage({
      name: "http",
      publisher,
      description: "An HTTP client and server for Fin",
      package_trusted: true,
      created_at: "2026-03-04T05:06:07Z",
      versions: [{ version: "1.2.0" }],
    });

    const { body } = await dashboard(session.token);

    expect(body.packages).toHaveLength(1);
    const entry = body.packages[0];
    expectKeys(entry, ENTRY_KEYS, "dashboard entry");

    expect(entry.name).toBe("http");
    expect(entry.description).toBe("An HTTP client and server for Fin");
    expect(entry.isTrusted).toBe(true);
    expect(entry.isDeprecated).toBe(false);
    expect(entry.latestVersion).toBe("1.2.0");
    expect(entry.versionCount).toBe(1);
    expect(entry.createdAt).toBe("2026-03-04T05:06:07Z");
    expect(typeof entry.id).toBe("string");
  });

  /** The account row is published by name too, for the same reason. */
  it("builds the account from named fields", async () => {
    const { session } = await signIn("acme", {
      display_name: "Acme Corp",
      is_verified: true,
      created_at: "2026-01-02T03:04:05Z",
    });

    const { body } = await dashboard(session.token);

    expectKeys(body.user, USER_KEYS, "dashboard user");
    expect(body.user.login).toBe("acme");
    expect(body.user.name).toBe("Acme Corp");
    expect(body.user.isVerified).toBe(true);
    expect(body.user.role).toBe("user");
    expect(body.user.createdAt).toBe("2026-01-02T03:04:05Z");
  });

  it("reports no verification request as 'none' rather than as a refusal", async () => {
    const { session } = await signIn();

    const { body } = await dashboard(session.token);

    expectKeys(body.verification, VERIFICATION_KEYS, "verification");
    expect(body.verification).toEqual({
      status: "none",
      requestedAt: null,
      reviewedAt: null,
      reviewerNote: null,
    });
  });

  /**
   * The requester's `note` is the case an account makes for itself to a human
   * reviewer. The reviewer's `reviewerNote` is the answer, and the only one of the
   * two the page has any business showing — the columns were separate precisely
   * because a single one lost the evidence when a refusal was written. Checked on
   * the raw text as well as the keys: what must not come back is the wording.
   */
  it("publishes the reviewer's reason and not the requester's own note", async () => {
    const { publisher, session } = await signIn();
    await getDb().insert(verificationRequests).values({
      id: "vreq-1",
      userId: publisher.id,
      status: "rejected",
      note: "MY-OWN-EVIDENCE-FOR-WHO-I-AM",
      reviewerNote: "Not enough evidence yet.",
      createdAt: "2026-08-02T00:00:00Z",
      reviewedAt: "2026-08-03T00:00:00Z",
    });

    const { body, text } = await dashboard(session.token);

    expectKeys(body.verification, VERIFICATION_KEYS, "verification");
    expect(body.verification.status).toBe("rejected");
    expect(body.verification.requestedAt).toBe("2026-08-02T00:00:00Z");
    expect(body.verification.reviewedAt).toBe("2026-08-03T00:00:00Z");
    expect(body.verification.reviewerNote).toBe("Not enough evidence yet.");
    expect(text).not.toContain("MY-OWN-EVIDENCE-FOR-WHO-I-AM");
    // Nor who ruled on it: attribution is the minutes' business (§2.8), not a
    // field on a page that a refused account reads.
    expect(text).not.toContain("reviewerId");
  });

  /**
   * Where the account stands *now*, not its history. A refused request followed by
   * a fresh one must read as pending, or the page tells a publisher their
   * application was turned down while it is sitting in the queue.
   */
  it("reports the most recent request, not the first", async () => {
    const { publisher, session } = await signIn();
    await getDb().insert(verificationRequests).values([
      {
        id: "vreq-old",
        userId: publisher.id,
        status: "rejected",
        reviewerNote: "not enough evidence",
        createdAt: "2026-08-01T00:00:00Z",
        reviewedAt: "2026-08-02T00:00:00Z",
      },
      {
        id: "vreq-new",
        userId: publisher.id,
        status: "pending",
        createdAt: "2026-08-10T00:00:00Z",
      },
    ]);

    const { body } = await dashboard(session.token);

    expect(body.verification.status).toBe("pending");
    expect(body.verification.requestedAt).toBe("2026-08-10T00:00:00Z");
    expect(body.verification.reviewedAt).toBeNull();
  });

  /**
   * And on a tie a pending row wins. `CURRENT_TIMESTAMP` has one-second
   * resolution, so two rows written moments apart compare equal — the ordering
   * has to be total or the page reports whichever row the database happened to
   * hand back first.
   */
  it("prefers a pending request when two were written in the same second", async () => {
    const { publisher, session } = await signIn();
    // The refusal is written *first*, so an unordered read hands it back first:
    // with the tie-break removed this test fails, which is the only way it can be
    // said to be measuring the tie-break at all.
    await getDb().insert(verificationRequests).values([
      {
        id: "vreq-rejected",
        userId: publisher.id,
        status: "rejected",
        reviewerNote: "no",
        createdAt: "2026-08-10T00:00:00Z",
        reviewedAt: "2026-08-10T00:00:00Z",
      },
      {
        id: "vreq-pending",
        userId: publisher.id,
        status: "pending",
        createdAt: "2026-08-10T00:00:00Z",
      },
    ]);

    const { body } = await dashboard(session.token);

    expect(body.verification.status).toBe("pending");
  });

  /**
   * The one genuinely secret thing this account has is not on `users` at all — the
   * GitHub access token a sign-in was minted with lives on `sessions`, so that it
   * can be replayed to GitHub at registration (ADR-0004) and cannot be hashed.
   * Nothing on the dashboard needs it and nothing on the page could use it.
   *
   * Asserted rather than assumed because this is the endpoint most likely to grow
   * a query that joins the two tables, and because it is what makes the exact-key
   * assertions above worth having: a secret that arrives as a *new* key is the
   * failure they exist to catch.
   */
  it("carries neither the session token nor the GitHub token it was minted with", async () => {
    const publisher = await seedPublisher({ login: "acme" });
    const session = await seedSession({
      publisher,
      github_access_token: "gho_A_REAL_LOOKING_GITHUB_TOKEN",
    });
    await seedPackage({ name: "http", publisher });

    const { text } = await dashboard(session.token);

    expect(text).not.toContain("gho_A_REAL_LOOKING_GITHUB_TOKEN");
    expect(text).not.toContain(session.token);
  });

  it("holds no entries for an account that has claimed nothing", async () => {
    const { session } = await signIn();

    const { body } = await dashboard(session.token);

    expect(body.packages).toEqual([]);
    expect(body.logins).toEqual([]);
  });

  /** Only the signatory's own half: another publisher's names are not here. */
  it("lists only the entries the signed-in account holds", async () => {
    const { publisher, session } = await signIn("acme");
    const other = await seedPublisher({ login: "somebodyelse" });
    await seedPackage({ name: "http", publisher });
    await seedPackage({ name: "json", publisher: other });

    const { body } = await dashboard(session.token);

    expect(body.packages.map((entry: { name: string }) => entry.name)).toEqual(["http"]);
  });

  /**
   * The sign-in list is built by name too. `userId` in particular is the account's
   * own internal row id, which the page has no use for and which no response has
   * any reason to carry.
   */
  it("builds a recorded sign-in from named fields", async () => {
    const { publisher, session } = await signIn();
    await recordSignIn(publisher.id, { id: "login-1" });

    const { body } = await dashboard(session.token);

    expect(body.logins).toHaveLength(1);
    expectKeys(body.logins[0], LOGIN_KEYS, "sign-in");
    expect(body.logins[0].id).toBe("login-1");
    expect(body.logins[0].ipAddress).toBe("198.51.100.7");
    expect(body.logins[0].userAgent).toBe("Mozilla/5.0");
    expect(body.logins[0].createdAt).toBe("2026-08-20T00:00:00Z");
  });

  /** Newest first, and at most ten: an audit list reads most-recent-first. */
  it("lists the ten most recent sign-ins, newest first", async () => {
    const { publisher, session } = await signIn();
    // Written oldest-first, which is the reverse of the asserted order, so an
    // ordering that has stopped working shows up rather than being masked by
    // insertion order.
    for (let day = 1; day <= 12; day += 1) {
      const stamp = `2026-08-${String(day).padStart(2, "0")}T00:00:00Z`;
      await recordSignIn(publisher.id, { id: `login-${day}`, createdAt: stamp });
    }

    const { body } = await dashboard(session.token);

    expect(body.logins).toHaveLength(10);
    expect(body.logins.map((row: { createdAt: string }) => row.createdAt)).toEqual([
      "2026-08-12T00:00:00Z",
      "2026-08-11T00:00:00Z",
      "2026-08-10T00:00:00Z",
      "2026-08-09T00:00:00Z",
      "2026-08-08T00:00:00Z",
      "2026-08-07T00:00:00Z",
      "2026-08-06T00:00:00Z",
      "2026-08-05T00:00:00Z",
      "2026-08-04T00:00:00Z",
      "2026-08-03T00:00:00Z",
    ]);
  });

  /** Another account's sign-ins are not this account's business. */
  it("lists only the signed-in account's own sign-ins", async () => {
    const { publisher, session } = await signIn("acme");
    const other = await seedPublisher({ login: "somebodyelse" });
    await recordSignIn(publisher.id, { id: "mine" });
    await recordSignIn(other.id, { id: "theirs" });

    const { body } = await dashboard(session.token);

    expect(body.logins.map((row: { id: string }) => row.id)).toEqual(["mine"]);
  });

  // --- latestVersion and versionCount ---------------------------------------

  /**
   * The same rule as §3.2's `latest_version`: yanked means "do not select for a
   * fresh resolve", so a yanked record can never be the latest. A publisher's
   * dashboard and their public package page must not disagree about what the
   * latest version of their own package is.
   */
  it("excludes a yanked record from latestVersion", async () => {
    const { publisher, session } = await signIn();
    await seedPackage({
      name: "http",
      publisher,
      versions: [
        { version: "1.2.0" },
        { version: "2.0.0", yanked: true },
      ],
    });

    const { body, text } = await dashboard(session.token);

    expect(body.packages[0].latestVersion).toBe("1.2.0");
    expect(text).not.toContain("2.0.0");
  });

  /** Semver precedence, not string order: `1.10.0` is above `1.9.0`. */
  it("picks the highest version by semver precedence", async () => {
    const { publisher, session } = await signIn();
    await seedPackage({
      name: "http",
      publisher,
      versions: [{ version: "1.9.0" }, { version: "1.10.0" }],
    });

    const { body } = await dashboard(session.token);

    expect(body.packages[0].latestVersion).toBe("1.10.0");
  });

  /**
   * A held name with nothing released is the most actionable state a publisher
   * can be in, and `null` is what says so. A fabricated `"1.0.0"` would tell
   * them a release exists that `finn add` cannot resolve.
   */
  it("reports latestVersion null for a name with no version records", async () => {
    const { publisher, session } = await signIn();
    await seedPackage({ name: "http", publisher, versions: [] });

    const { body, text } = await dashboard(session.token);

    expect(body.packages[0].latestVersion).toBeNull();
    expect(body.packages[0].versionCount).toBe(0);
    expect(text).not.toContain("1.0.0");
  });

  /** And when every record is yanked, which is the case a filter can get wrong. */
  it("reports latestVersion null when every record is yanked", async () => {
    const { publisher, session } = await signIn();
    await seedPackage({
      name: "http",
      publisher,
      versions: [
        { version: "1.0.0", yanked: true },
        { version: "1.1.0", yanked: true },
      ],
    });

    const { body } = await dashboard(session.token);

    expect(body.packages[0].latestVersion).toBeNull();
    // Counted, not selected: the records exist and the publisher should see that.
    expect(body.packages[0].versionCount).toBe(2);
  });

  /**
   * `versionCount` counts every record, yanked included — the handler says so and
   * this is what checks it. `latestVersion: 1.2.0` beside `versionCount: 3` is
   * the honest report of a package with a withdrawn release.
   */
  it("counts yanked records in versionCount", async () => {
    const { publisher, session } = await signIn();
    await seedPackage({
      name: "http",
      publisher,
      versions: [
        { version: "1.0.0" },
        { version: "1.2.0" },
        { version: "2.0.0", yanked: true },
      ],
    });

    const { body } = await dashboard(session.token);

    expect(body.packages[0].versionCount).toBe(3);
    expect(body.packages[0].latestVersion).toBe("1.2.0");
  });

  /** One query for the page, so a second package must not borrow the first's rows. */
  it("attributes version records to the right entry", async () => {
    const { publisher, session } = await signIn();
    await seedPackage({ name: "http", publisher, versions: [{ version: "1.2.0" }] });
    await seedPackage({ name: "json", publisher, versions: [] });

    const { body } = await dashboard(session.token);

    const byName = Object.fromEntries(
      body.packages.map((entry: { name: string }) => [entry.name, entry]),
    );
    expect(byName.http.latestVersion).toBe("1.2.0");
    expect(byName.http.versionCount).toBe(1);
    expect(byName.json.latestVersion).toBeNull();
    expect(byName.json.versionCount).toBe(0);
  });

  // --- timestamps -----------------------------------------------------------

  /**
   * Every timestamp is ISO-8601 UTC, never the raw SQLite `"2026-08-01 00:00:00"`
   * a client would parse as local time.
   */
  it("publishes ISO-8601 UTC timestamps", async () => {
    const { publisher, session } = await signIn();
    await seedPackage({ name: "http", publisher });

    const { body } = await dashboard(session.token);

    expect(body.user.createdAt).toMatch(ISO_INSTANT);
    expect(body.packages[0].createdAt).toMatch(ISO_INSTANT);
  });
});
