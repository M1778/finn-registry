/**
 * Authorisation on `POST /api/me/verification-request`, docs/REGISTRY-CONTRACT.md
 * §3.10.
 *
 * The one endpoint on the register that asks a human to make a claim about
 * somebody's identity, and the entry point to the queue the admin bench rules
 * on (`tests/admin/actions.test.ts` covers the other end). What matters here is
 * not the happy path — it is *whose* request gets filed, and how many.
 *
 * Two properties carry the weight:
 *
 *  - the subject is the caller. The handler takes the account id from the
 *    session and nothing else, so there is no field in the body that could aim a
 *    request at a third party. The tests below try to aim one anyway, because
 *    "there is no such field" is a claim that stops being true the moment
 *    somebody adds one.
 *  - one pending request per account, enforced by a partial unique index rather
 *    than only by the read that precedes the insert — two requests can both pass
 *    that read before either lands.
 *
 * The per-IP write ceiling (§3.7, 100 per 15 minutes) is the other half of the
 * spam story and is deliberately not asserted here: reaching it needs 100 real
 * proof-of-work solutions, and the proof itself is what makes a flood expensive
 * long before the counter does.
 */

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  apiPost,
  captchaHeaders,
  seedPublisher,
  seedSession,
  type SeededPublisher,
  type SeededSession,
} from "../setup";
import { getDb } from "@/lib/db";
import { sessions, users, verificationRequests } from "@/lib/db/schema";
import { CAPTCHA_HEADER } from "@/lib/captcha-shared";
import { expectErrorEnvelope } from "../contract";

const URL = "/api/me/verification-request";

async function signIn(
  options: { login?: string; is_verified?: boolean; expired?: boolean } = {},
): Promise<SeededSession> {
  const publisher = await seedPublisher({
    login: options.login ?? "applicant",
    is_verified: options.is_verified ?? false,
  });
  return seedSession({
    publisher,
    expires_at: options.expired ? Date.now() - 60_000 : undefined,
  });
}

/** Every request row, so a test can count them and see who they name. */
async function filed() {
  return getDb()
    .select({
      id: verificationRequests.id,
      userId: verificationRequests.userId,
      status: verificationRequests.status,
      note: verificationRequests.note,
    })
    .from(verificationRequests)
    .all();
}

describe("POST /api/me/verification-request — who may file one", () => {
  it("401s with no session", async () => {
    const { status, body } = await apiPost(URL, {});

    expect(status).toBe(401);
    expectErrorEnvelope(body);
    expect(await filed()).toEqual([]);
  });

  it("401s on a session that has expired", async () => {
    const session = await signIn({ expired: true });

    const { status } = await apiPost(URL, { token: session.token });

    expect(status).toBe(401);
    expect(await filed()).toEqual([]);
  });

  it("401s on a revoked session, whose token is still well-formed", async () => {
    const session = await signIn();
    await getDb().delete(sessions).where(eq(sessions.token, session.token));

    const { status } = await apiPost(URL, { token: session.token });

    expect(status).toBe(401);
    expect(await filed()).toEqual([]);
  });

  it("401s on a token nobody ever minted", async () => {
    const { status } = await apiPost(URL, { token: "a".repeat(64) });

    expect(status).toBe(401);
    expect(await filed()).toEqual([]);
  });

  /**
   * A live session whose account row is gone. `getAuth` looks the account up and
   * returns nobody when it is missing, so this is a 401 and not a request filed
   * against a dangling id.
   */
  it("401s on a live session whose account row no longer exists", async () => {
    const ghost: SeededPublisher = {
      id: "usr-ghost",
      login: "ghost",
      display_name: "Ghost",
      avatar_url: null,
      kind: "user",
      is_verified: false,
      role: "user",
      organization_id: null,
      owner_login: "ghost",
    };
    const session = await seedSession({ publisher: ghost });

    const { status } = await apiPost(URL, { token: session.token });

    expect(status).toBe(401);
    expect(await filed()).toEqual([]);
  });

  /**
   * The proof of work is a §3.12 gate on every §3.10 write, and being signed in
   * does not lift it: an account is free to create, so authentication alone puts
   * no cost on a flood.
   */
  it("428s a signed-in caller who sends no proof of work", async () => {
    const session = await signIn();

    const { status, body } = await apiPost(URL, { token: session.token, captcha: false });

    expect(status).toBe(428);
    expect(body.error).toBe("captcha_required");
    expect(await filed()).toEqual([]);
  });

  it("428s a signed-in caller who sends a forged proof", async () => {
    const session = await signIn();

    const { status, body } = await apiPost(URL, {
      token: session.token,
      headers: { [CAPTCHA_HEADER]: "not.a.real.token" },
    });

    expect(status).toBe(428);
    expect(body.error).toBe("captcha_required");
    expect(await filed()).toEqual([]);
  });

  /**
   * One solve, one request. A replayable proof would cost a flood a single
   * hashing run for as long as the token stayed valid, which is close to no cost
   * at all. Best-effort per isolate (`captcha.ts`), so this asserts the
   * behaviour of the isolate that issued the challenge — the only place it can
   * be asserted.
   */
  it("428s a proof of work that was already spent", async () => {
    const session = await signIn();
    const proof = await captchaHeaders("verify-request");

    const first = await apiPost(URL, { token: session.token, headers: proof });
    const second = await apiPost(URL, { token: session.token, headers: proof });

    expect(first.status).toBe(201);
    expect(second.status).toBe(428);
    expect(second.body.error).toBe("captcha_required");
    expect(await filed()).toHaveLength(1);
  });

  /**
   * A proof issued for one gate must not open another. The scopes exist so that
   * a solution collected on the cheap `register-check` challenge cannot be spent
   * here.
   */
  it("428s a proof of work issued for a different scope", async () => {
    const session = await signIn();

    const { status, body } = await apiPost(URL, {
      token: session.token,
      headers: await captchaHeaders("register-check"),
    });

    expect(status).toBe(428);
    expect(body.error).toBe("captcha_required");
    expect(await filed()).toEqual([]);
  });
});

describe("POST /api/me/verification-request — whose request it is", () => {
  /**
   * The subject comes from the session. The body here names somebody else in
   * every spelling the handler could plausibly have read, and the filed request
   * must still be the caller's — a request is an assertion about an identity,
   * and one filed in another account's name would put words in their mouth and
   * consume the single pending slot they are entitled to.
   */
  it("files the request against the caller, whoever the body names", async () => {
    const victim = await seedPublisher({ login: "victim", is_verified: false });
    const session = await signIn({ login: "attacker" });

    const { status } = await apiPost(URL, {
      token: session.token,
      body: {
        note: "please verify",
        user_id: victim.id,
        userId: victim.id,
        login: victim.login,
        id: victim.id,
      },
    });

    expect(status).toBe(201);
    const rows = await filed();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(session.publisher.id);
    expect(rows[0].userId).not.toBe(victim.id);
  });

  /** And filing one leaves the named account's pending slot free. */
  it("leaves the account named in the body able to file its own", async () => {
    const victim = await seedPublisher({ login: "victim", is_verified: false });
    const victimSession = await seedSession({ publisher: victim });
    const attacker = await signIn({ login: "attacker" });

    await apiPost(URL, { token: attacker.token, body: { user_id: victim.id } });
    const { status } = await apiPost(URL, { token: victimSession.token });

    expect(status).toBe(201);
    const rows = await filed();
    expect(rows.map((row) => row.userId).sort()).toEqual(
      [attacker.publisher.id, victim.id].sort(),
    );
  });

  /**
   * A caller must not be able to file against an account that has no session
   * here at all, which is the same claim as above stated from the victim's side:
   * nothing appears in the queue under an id the caller does not hold.
   */
  it("never files a request naming an account the caller does not hold", async () => {
    const stranger = await seedPublisher({ login: "stranger", is_verified: false });
    const session = await signIn({ login: "attacker" });

    await apiPost(URL, { token: session.token, body: { userId: stranger.id } });

    const rows = await filed();
    expect(rows.every((row) => row.userId !== stranger.id)).toBe(true);
  });
});

describe("POST /api/me/verification-request — how many", () => {
  it("409s a second request while one is pending, and files only one", async () => {
    const session = await signIn();

    const first = await apiPost(URL, { token: session.token, body: { note: "one" } });
    const second = await apiPost(URL, { token: session.token, body: { note: "two" } });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("request_pending");
    expectErrorEnvelope(second.body);

    const rows = await filed();
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("one");
  });

  /**
   * The race the partial unique index exists for: two requests that both pass
   * the pending read before either insert lands. One must win and one must be
   * told the queue already has theirs — not two rows, and not a 500.
   */
  it("keeps one row when two requests arrive together", async () => {
    const session = await signIn();

    const [a, b] = await Promise.all([
      apiPost(URL, { token: session.token, body: { note: "a" } }),
      apiPost(URL, { token: session.token, body: { note: "b" } }),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.body.error).toBe("request_pending");

    expect(await filed()).toHaveLength(1);
  });

  it("409s an account that is already verified, and files nothing", async () => {
    const session = await signIn({ is_verified: true });

    const { status, body } = await apiPost(URL, { token: session.token });

    expect(status).toBe(409);
    expect(body.error).toBe("already_verified");
    expectErrorEnvelope(body);
    expect(await filed()).toEqual([]);
  });

  /**
   * The duplicate rule is "one *pending*", not "one ever" (§3.10). People fix
   * what was wrong and ask again, so a refusal must not lock an account out —
   * the over-strict reading would be a denial of service on the queue.
   */
  it("lets an account whose request was refused file a new one", async () => {
    const session = await signIn();
    await getDb().insert(verificationRequests).values({
      id: "vreq-old",
      userId: session.publisher.id,
      status: "rejected",
      reviewerNote: "not enough evidence",
    });

    const { status } = await apiPost(URL, { token: session.token, body: { note: "again" } });

    expect(status).toBe(201);
    const rows = await filed();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
  });

  /** Filing a request does not verify anybody. Only an admin's ruling does. */
  it("does not verify the account that filed it", async () => {
    const session = await signIn();

    await apiPost(URL, { token: session.token });

    const row = await getDb()
      .select({ isVerified: users.isVerified, role: users.role })
      .from(users)
      .where(eq(users.id, session.publisher.id))
      .get();

    expect(Boolean(row?.isVerified)).toBe(false);
    expect(row?.role).toBe("user");
    expect((await filed())[0].status).toBe("pending");
  });
});
