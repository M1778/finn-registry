/**
 * Authorisation on the moderation bench — `src/app/admin/actions.ts`.
 *
 * These are server actions, which means they are public POST endpoints whatever
 * the page around them renders. `src/app/admin/page.tsx` hides the buttons from
 * anyone who is not a moderator, and that is presentation, not a permission
 * check: a caller who knows the action id can invoke it directly. So the claims
 * worth asserting are about who the action itself lets through, and every test
 * here calls the action function the way that caller would — no page, no form,
 * no button.
 *
 * WHAT IS MOCKED, AND WHY ONLY THAT. Two Next framework boundaries have no
 * meaning outside a request: `cookies()` from `next/headers`, which the action
 * reads the session out of, and `revalidatePath()` from `next/cache`, which
 * touches the router cache. Both are replaced here. Nothing of ours is: the
 * cookie goes through the real `verifySession`, the real `users` read in
 * `getViewer()` and the real `isAdmin`/`isModerator`, so an authorisation hole
 * in any of those three shows up as a failure here. Mocking `getViewer` instead
 * would assume away the entire thing under test.
 *
 * The two roles are not a ladder with one rung. Contract ADR-0003 splits them
 * because they carry independent trust signals: a *moderator* vouches for one
 * package (`packages.is_trusted`), an *admin* rules on who a publisher is
 * (`users.is_verified`). `trust.level` reads both, so collapsing the roles would
 * let one person manufacture `verified` on their own entry. Several tests below
 * exist only to hold those two signals apart.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

/**
 * The `auth_token` cookie the next action call will see. Mutable because the
 * interesting tests are about *which* caller reaches the action, and the mock
 * has to be installed before the module under test is imported.
 */
const cookieJar: { token: string | null } = { token: null };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "auth_token" && cookieJar.token
        ? { name, value: cookieJar.token }
        : undefined,
  }),
}));

/** Every path an action asked Next to revalidate, in order. */
const revalidated: string[] = [];

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));

import { approveVerification, refuseVerification, setPackageTrust } from "@/app/admin/actions";
import { getDb } from "@/lib/db";
import { packages, reviewMinutes, sessions, users, verificationRequests } from "@/lib/db/schema";
import { apiGet, seedPackage, seedPublisher, seedSession, type SeededPublisher } from "../setup";

type Role = "user" | "moderator" | "admin";

/** Signs a caller in for the next action call. `null` means nobody. */
function as(token: string | null) {
  cookieJar.token = token;
}

/**
 * An account with a role, plus a live session token for it.
 *
 * `role` has to be asked for: `seedPublisher` defaults to `"user"`, the same as
 * every real account, so no test here can be handed a privilege it did not
 * name.
 */
async function account(
  role: Role,
  options: { login?: string; expired?: boolean } = {},
): Promise<{ publisher: SeededPublisher; token: string }> {
  const publisher = await seedPublisher({ login: options.login ?? `a-${role}`, role });
  const session = await seedSession({
    publisher,
    expires_at: options.expired ? Date.now() - 60_000 : undefined,
  });
  return { publisher, token: session.token };
}

/** A package owned by somebody else, un-vouched. */
async function somebodyElsesPackage() {
  return seedPackage({
    name: "http",
    publisher: await seedPublisher({ login: "acme" }),
    package_trusted: false,
  });
}

/** A pending verification request from an unverified account. */
async function pendingRequest(login = "applicant") {
  const publisher = await seedPublisher({ login, is_verified: false });
  const id = `vreq-${login}`;
  await getDb()
    .insert(verificationRequests)
    .values({ id, userId: publisher.id, status: "pending", note: "please" });
  return { id, publisher };
}

function trustForm(packageId: string, trusted: boolean): FormData {
  const form = new FormData();
  form.set("packageId", packageId);
  form.set("trusted", String(trusted));
  return form;
}

function approveForm(requestId: string, userId: string): FormData {
  const form = new FormData();
  form.set("requestId", requestId);
  form.set("userId", userId);
  return form;
}

function refuseForm(requestId: string, reason: string): FormData {
  const form = new FormData();
  form.set("requestId", requestId);
  form.set("reason", reason);
  return form;
}

async function isTrusted(packageId: string): Promise<boolean> {
  const row = await getDb()
    .select({ isTrusted: packages.isTrusted })
    .from(packages)
    .where(eq(packages.id, packageId))
    .get();
  return Boolean(row?.isTrusted);
}

async function isVerified(userId: string): Promise<boolean> {
  const row = await getDb()
    .select({ isVerified: users.isVerified })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return Boolean(row?.isVerified);
}

async function requestStatus(requestId: string): Promise<string | undefined> {
  const row = await getDb()
    .select({ status: verificationRequests.status })
    .from(verificationRequests)
    .where(eq(verificationRequests.id, requestId))
    .get();
  return row?.status;
}

/** Every minute in the book. A refused action must add none. */
async function minutes() {
  return getDb()
    .select({
      reviewerId: reviewMinutes.reviewerId,
      action: reviewMinutes.action,
      subjectUserId: reviewMinutes.subjectUserId,
      subjectPackageId: reviewMinutes.subjectPackageId,
    })
    .from(reviewMinutes)
    .all();
}

beforeEach(() => {
  as(null);
  revalidated.length = 0;
});

describe("setPackageTrust — a moderator's vouch", () => {
  it("refuses a caller with no session at all", async () => {
    const pkg = await somebodyElsesPackage();

    await expect(setPackageTrust(trustForm(pkg.id, true))).rejects.toThrow(
      /only a moderator/i,
    );

    expect(await isTrusted(pkg.id)).toBe(false);
    expect(await minutes()).toEqual([]);
  });

  /**
   * The question asked directly: can a signed-in ordinary account mark a
   * package trusted? `trusted` is one of the two inputs to `trust.level`, so a
   * yes here would let anyone with an account manufacture a seal on any entry
   * on the register, including their own.
   */
  it("refuses a signed-in account with the default role", async () => {
    const pkg = await somebodyElsesPackage();
    const { token } = await account("user");
    as(token);

    await expect(setPackageTrust(trustForm(pkg.id, true))).rejects.toThrow(
      /only a moderator/i,
    );

    expect(await isTrusted(pkg.id)).toBe(false);
    expect(await minutes()).toEqual([]);
  });

  it("refuses the owner of the package, who is still not a moderator", async () => {
    const owner = await seedPublisher({ login: "acme", role: "user" });
    const pkg = await seedPackage({ name: "http", publisher: owner, package_trusted: false });
    const session = await seedSession({ publisher: owner });
    as(session.token);

    await expect(setPackageTrust(trustForm(pkg.id, true))).rejects.toThrow(
      /only a moderator/i,
    );

    expect(await isTrusted(pkg.id)).toBe(false);
  });

  it("refuses a session that has expired", async () => {
    const pkg = await somebodyElsesPackage();
    const { token } = await account("moderator", { expired: true });
    as(token);

    await expect(setPackageTrust(trustForm(pkg.id, true))).rejects.toThrow(
      /only a moderator/i,
    );

    expect(await isTrusted(pkg.id)).toBe(false);
  });

  /**
   * Revocation is a row deletion (`deleteSession`), so the token keeps its
   * shape and only the lookup fails. A moderator whose session was revoked must
   * lose the bench immediately, not at some expiry.
   */
  it("refuses a revoked session even though the token is well-formed", async () => {
    const pkg = await somebodyElsesPackage();
    const { token } = await account("moderator");
    await getDb().delete(sessions).where(eq(sessions.token, token));
    as(token);

    await expect(setPackageTrust(trustForm(pkg.id, true))).rejects.toThrow(
      /only a moderator/i,
    );

    expect(await isTrusted(pkg.id)).toBe(false);
  });

  /**
   * A live session whose account row is gone — a deleted account, or a restore
   * that brought the sessions back and not the users. `verifySession` succeeds
   * and the role lookup finds nothing, and the safe answer to "what role does
   * an account that does not exist hold" is none.
   */
  it("refuses a live session whose account row no longer exists", async () => {
    const pkg = await somebodyElsesPackage();
    const ghost: SeededPublisher = {
      id: "usr-ghost",
      login: "ghost",
      display_name: "Ghost",
      avatar_url: null,
      kind: "user",
      is_verified: false,
      role: "moderator",
      organization_id: null,
      owner_login: "ghost",
    };
    const session = await seedSession({ publisher: ghost });
    as(session.token);

    await expect(setPackageTrust(trustForm(pkg.id, true))).rejects.toThrow(
      /only a moderator/i,
    );

    expect(await isTrusted(pkg.id)).toBe(false);
  });

  it("refuses a token that was never issued", async () => {
    const pkg = await somebodyElsesPackage();
    as("not-a-token-anyone-minted");

    await expect(setPackageTrust(trustForm(pkg.id, true))).rejects.toThrow(
      /only a moderator/i,
    );

    expect(await isTrusted(pkg.id)).toBe(false);
  });

  /**
   * The boundary has to let the right caller through, or every refusal above
   * would also pass against an action that refuses everyone.
   */
  it("lets a moderator vouch, and records who did it", async () => {
    const pkg = await somebodyElsesPackage();
    const { publisher, token } = await account("moderator");
    as(token);

    await setPackageTrust(trustForm(pkg.id, true));

    expect(await isTrusted(pkg.id)).toBe(true);
    expect(await minutes()).toEqual([
      {
        reviewerId: publisher.id,
        action: "package_vouched",
        subjectUserId: null,
        subjectPackageId: pkg.id,
      },
    ]);
    expect(revalidated).toEqual(["/admin"]);
  });

  /**
   * `isModerator` is true for an admin as well, and that is the design rather
   * than an accident: ADR-0003 gives admins the moderator's bench plus the
   * identity queue. Asserted so that narrowing it later is a deliberate change
   * with a failing test attached, not a silent one.
   */
  it("lets an admin vouch too, because admin includes the moderator's bench", async () => {
    const pkg = await somebodyElsesPackage();
    const { token } = await account("admin");
    as(token);

    await setPackageTrust(trustForm(pkg.id, true));

    expect(await isTrusted(pkg.id)).toBe(true);
  });

  /**
   * The first half of keeping the two signals apart. A vouch is about one
   * package; it must not touch the publisher's identity, or `trust.level` would
   * read `verified` off a single moderator's judgement.
   */
  it("does not verify the publisher as a side effect of vouching", async () => {
    const pkg = await somebodyElsesPackage();
    const { token } = await account("moderator");
    as(token);

    await setPackageTrust(trustForm(pkg.id, true));

    expect(await isTrusted(pkg.id)).toBe(true);
    expect(await isVerified(pkg.publisher.id)).toBe(false);
  });

  it("refuses to withdraw a vouch for a caller who could not have made one", async () => {
    const owner = await seedPublisher({ login: "acme" });
    const pkg = await seedPackage({ name: "http", publisher: owner, package_trusted: true });
    const { token } = await account("user");
    as(token);

    await expect(setPackageTrust(trustForm(pkg.id, false))).rejects.toThrow(
      /only a moderator/i,
    );

    expect(await isTrusted(pkg.id)).toBe(true);
  });
});

describe("approveVerification — an admin's ruling on identity", () => {
  it("refuses a caller with no session at all", async () => {
    const { id, publisher } = await pendingRequest();

    await expect(approveVerification(approveForm(id, publisher.id))).rejects.toThrow(
      /only an admin/i,
    );

    expect(await isVerified(publisher.id)).toBe(false);
    expect(await requestStatus(id)).toBe("pending");
    expect(await minutes()).toEqual([]);
  });

  it("refuses a signed-in account with the default role", async () => {
    const { id, publisher } = await pendingRequest();
    const { token } = await account("user");
    as(token);

    await expect(approveVerification(approveForm(id, publisher.id))).rejects.toThrow(
      /only an admin/i,
    );

    expect(await isVerified(publisher.id)).toBe(false);
    expect(await requestStatus(id)).toBe("pending");
    expect(await minutes()).toEqual([]);
  });

  /**
   * The question that decides whether the two roles have collapsed into one. A
   * moderator can vouch for packages; if they could also verify publishers,
   * ADR-0003's split would be decoration and one account would control both
   * inputs to `trust.level`.
   */
  it("refuses a moderator, who holds the other trust signal and not this one", async () => {
    const { id, publisher } = await pendingRequest();
    const { token } = await account("moderator");
    as(token);

    await expect(approveVerification(approveForm(id, publisher.id))).rejects.toThrow(
      /only an admin/i,
    );

    expect(await isVerified(publisher.id)).toBe(false);
    expect(await requestStatus(id)).toBe("pending");
    expect(await minutes()).toEqual([]);
  });

  /** An applicant must not be able to approve their own application. */
  it("refuses the applicant themselves", async () => {
    const publisher = await seedPublisher({ login: "applicant", is_verified: false });
    await getDb()
      .insert(verificationRequests)
      .values({ id: "vreq-self", userId: publisher.id, status: "pending" });
    const session = await seedSession({ publisher });
    as(session.token);

    await expect(approveVerification(approveForm("vreq-self", publisher.id))).rejects.toThrow(
      /only an admin/i,
    );

    expect(await isVerified(publisher.id)).toBe(false);
    expect(await requestStatus("vreq-self")).toBe("pending");
  });

  it("refuses an expired session held by a real admin", async () => {
    const { id, publisher } = await pendingRequest();
    const { token } = await account("admin", { expired: true });
    as(token);

    await expect(approveVerification(approveForm(id, publisher.id))).rejects.toThrow(
      /only an admin/i,
    );

    expect(await isVerified(publisher.id)).toBe(false);
  });

  it("lets an admin approve, and records who did it", async () => {
    const { id, publisher } = await pendingRequest();
    const admin = await account("admin");
    as(admin.token);

    await approveVerification(approveForm(id, publisher.id));

    expect(await isVerified(publisher.id)).toBe(true);
    expect(await requestStatus(id)).toBe("approved");
    expect(await minutes()).toEqual([
      {
        reviewerId: admin.publisher.id,
        action: "publisher_verified",
        subjectUserId: publisher.id,
        subjectPackageId: null,
      },
    ]);
    expect(revalidated).toEqual(["/admin"]);
  });

  /**
   * The second half of keeping the two signals apart. Verifying an account says
   * who they are; it must not vouch for the code they published, or one admin
   * would produce `verified` on their own.
   */
  it("does not vouch for the applicant's packages as a side effect", async () => {
    const applicant = await seedPublisher({ login: "applicant", is_verified: false });
    const pkg = await seedPackage({ name: "http", publisher: applicant, package_trusted: false });
    await getDb()
      .insert(verificationRequests)
      .values({ id: "vreq-side", userId: applicant.id, status: "pending" });
    const admin = await account("admin");
    as(admin.token);

    await approveVerification(approveForm("vreq-side", applicant.id));

    expect(await isVerified(applicant.id)).toBe(true);
    expect(await isTrusted(pkg.id)).toBe(false);
  });

  /**
   * The form carries the account id, so the authorisation check is the only
   * thing standing between a caller and verifying an arbitrary account —
   * including one that never applied.
   */
  it("refuses a non-admin naming an account that never applied", async () => {
    const stranger = await seedPublisher({ login: "stranger", is_verified: false });
    const { token } = await account("user");
    as(token);

    await expect(
      approveVerification(approveForm("vreq-does-not-exist", stranger.id)),
    ).rejects.toThrow(/only an admin/i);

    expect(await isVerified(stranger.id)).toBe(false);
  });
});

describe("refuseVerification — an admin's refusal", () => {
  it("refuses a caller with no session at all", async () => {
    const { id } = await pendingRequest();

    await expect(refuseVerification(refuseForm(id, "not enough evidence"))).rejects.toThrow(
      /only an admin/i,
    );

    expect(await requestStatus(id)).toBe("pending");
    expect(await minutes()).toEqual([]);
  });

  it("refuses a signed-in account with the default role", async () => {
    const { id } = await pendingRequest();
    const { token } = await account("user");
    as(token);

    await expect(refuseVerification(refuseForm(id, "no"))).rejects.toThrow(/only an admin/i);

    expect(await requestStatus(id)).toBe("pending");
    expect(await minutes()).toEqual([]);
  });

  it("refuses a moderator ruling on identity", async () => {
    const { id } = await pendingRequest();
    const { token } = await account("moderator");
    as(token);

    await expect(refuseVerification(refuseForm(id, "no"))).rejects.toThrow(/only an admin/i);

    expect(await requestStatus(id)).toBe("pending");
    expect(await minutes()).toEqual([]);
  });

  /** An applicant must not be able to close their own application either. */
  it("refuses the applicant themselves", async () => {
    const publisher = await seedPublisher({ login: "applicant", is_verified: false });
    await getDb()
      .insert(verificationRequests)
      .values({ id: "vreq-self", userId: publisher.id, status: "pending" });
    const session = await seedSession({ publisher });
    as(session.token);

    await expect(refuseVerification(refuseForm("vreq-self", "changed my mind"))).rejects.toThrow(
      /only an admin/i,
    );

    expect(await requestStatus("vreq-self")).toBe("pending");
  });

  /**
   * Order of checks, asserted as a property rather than read off the source.
   * The role is checked before the request row is read, so a non-admin gets the
   * same sentence for a real id and an invented one and learns nothing about
   * the queue from the difference.
   */
  it("tells a non-admin nothing about whether the request exists", async () => {
    const { id } = await pendingRequest();
    const { token } = await account("user");
    as(token);

    const real = await refuseVerification(refuseForm(id, "no")).catch((err: Error) => err.message);
    const invented = await refuseVerification(refuseForm("vreq-nope", "no")).catch(
      (err: Error) => err.message,
    );

    expect(real).toBe(invented);
    expect(real).toMatch(/only an admin/i);
  });

  /**
   * And the same for the missing reason: a non-admin must not be able to use
   * the difference between "needs a reason" and "not allowed" to discover that
   * they would otherwise have been allowed.
   */
  it("refuses a non-admin before it notices the reason is missing", async () => {
    const { id } = await pendingRequest();
    const { token } = await account("user");
    as(token);

    await expect(refuseVerification(refuseForm(id, ""))).rejects.toThrow(/only an admin/i);
  });

  it("lets an admin refuse, with the reason recorded once", async () => {
    const { id, publisher } = await pendingRequest();
    const admin = await account("admin");
    as(admin.token);

    await refuseVerification(refuseForm(id, "the linked account does not match"));

    expect(await requestStatus(id)).toBe("rejected");
    expect(await isVerified(publisher.id)).toBe(false);
    expect(await minutes()).toEqual([
      {
        reviewerId: admin.publisher.id,
        action: "verification_refused",
        subjectUserId: publisher.id,
        subjectPackageId: null,
      },
    ]);
  });
});

/**
 * The premise every test above rests on: that `users.role` is not something a
 * caller can set. If any request could write it, none of the refusals here
 * would mean anything — a caller would simply promote themselves first.
 */
describe("users.role is not writable by the account it belongs to", () => {
  it("ignores role and is_verified in PATCH /api/me/settings", async () => {
    const { publisher, token } = await account("user", { login: "climber" });

    const { status } = await apiGet("/api/me/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: `auth_token=${token}` },
      body: JSON.stringify({
        name: "Climber",
        role: "admin",
        is_verified: true,
        isVerified: true,
      }),
    });

    expect(status).toBe(200);

    const row = await getDb()
      .select({ role: users.role, isVerified: users.isVerified, name: users.name })
      .from(users)
      .where(eq(users.id, publisher.id))
      .get();

    // The one field the route documents is written; the two it does not are not.
    expect(row?.name).toBe("Climber");
    expect(row?.role).toBe("user");
    expect(Boolean(row?.isVerified)).toBe(false);
  });

  /**
   * And with the role write standing alone, so a route that quietly merged the
   * whole body would have nothing else in the request to hide behind.
   */
  it("does not promote an account that sends nothing but a role", async () => {
    const { publisher, token } = await account("user", { login: "climber" });

    await apiGet("/api/me/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: `auth_token=${token}` },
      body: JSON.stringify({ role: "admin" }),
    });

    const row = await getDb()
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, publisher.id))
      .get();

    expect(row?.role).toBe("user");
  });
});
