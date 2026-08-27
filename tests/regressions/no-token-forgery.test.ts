/**
 * Permanent regression: identity comes from the session table, never from a token.
 *
 * `getAuth` used to have a second branch. After the session lookup failed it
 * verified the token as an HS256 JWT and, if the signature checked out, returned
 * the decoded payload *as* the caller — no database read, no shape validation. So
 * whatever the token claimed is what the API believed, including `id`, `login`
 * and `githubAccessToken`.
 *
 * The signing key was `process.env.JWT_SECRET || "default_secret"`, and nothing
 * provisioned `JWT_SECRET`: no `vars` block in wrangler.jsonc, nothing in the
 * deploy workflow. An instance that skipped `wrangler secret put` therefore ran
 * on a key published in this repository. Nothing ever *issued* one of these
 * tokens either — `generateToken` had zero call sites — so the only way to
 * present one was to forge it.
 *
 * The worst case was not impersonation for its own sake. `POST /packages` checks
 * push access with `auth.githubAccessToken` and then records `ownerId: auth.id`,
 * so a forged token carrying the attacker's own GitHub token and a victim's id
 * registered the attacker's repository under the victim's account — and inherited
 * the victim's seal.
 *
 * These tests forge exactly that token, with the literal key, and require every
 * authenticated route to refuse it. `KEYS` covers the published default plus the
 * shapes a re-introduced fallback would plausibly use, so this fails if the
 * branch comes back under any of them. It is not a test of `jose`: it is a test
 * that a signature — any signature — buys a caller nothing.
 */

import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { apiGet, apiPost, seedPublisher, seedSession } from "../setup";

/**
 * Keys a resurrected fallback might sign with. The first is the one that shipped.
 * An empty key is absent on purpose: `jose` refuses to sign with one, so it is not
 * a shape a fallback could take.
 */
const KEYS = ["default_secret", "secret", "changeme"];

async function forge(
  claims: Record<string, unknown>,
  key: string = KEYS[0],
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(new TextEncoder().encode(key));
}

/**
 * Every route that reads `getAuth`, with a body where one is required.
 *
 * `/auth/status` is the odd one out: unauthenticated it answers 200
 * `{authenticated: false}` rather than 401, so it is asserted separately below.
 */
const AUTHENTICATED_ROUTES: Array<{
  method: "GET" | "POST" | "PATCH";
  url: string;
  body?: unknown;
}> = [
  { method: "GET", url: "/api/dashboard/data" },
  { method: "PATCH", url: "/api/me/settings", body: { name: "attacker" } },
  { method: "POST", url: "/api/registrations/check", body: { repo_url: "attacker/fin-evil" } },
  { method: "POST", url: "/api/packages", body: { name: "evil", repo_url: "attacker/fin-evil" } },
  { method: "POST", url: "/api/me/verification-request", body: { evidence: "trust me" } },
];

async function call(
  route: (typeof AUTHENTICATED_ROUTES)[number],
  headers: Record<string, string>,
) {
  if (route.method === "GET") return apiGet(route.url, { headers });
  return apiGet(route.url, {
    method: route.method,
    headers: { "Content-Type": "application/json", ...headers },
    body: route.body === undefined ? undefined : JSON.stringify(route.body),
  });
}

describe("a signed token is not a credential", () => {
  for (const key of KEYS) {
    const label = `the key "${key}"`;

    it(`refuses a token signed with ${label} on every authenticated route`, async () => {
      const victim = await seedPublisher({ login: "victim", is_verified: true });
      const token = await forge(
        {
          id: victim.id,
          login: victim.login,
          githubAccessToken: "gho_attacker_own_token",
          githubScope: "repo",
        },
        key,
      );

      for (const route of AUTHENTICATED_ROUTES) {
        const viaHeader = await call(route, { Authorization: `Bearer ${token}` });
        expect(viaHeader.status, `${route.method} ${route.url} (Bearer)`).toBe(401);

        const viaCookie = await call(route, { Cookie: `auth_token=${token}` });
        expect(viaCookie.status, `${route.method} ${route.url} (cookie)`).toBe(401);
      }
    });
  }

  // A bearer credential in a query string ends up in logs, referrers and
  // history. The parameter is still read, so it is worth pinning that a forged
  // value gets nothing through it either.
  it("refuses a forged token passed as ?token=", async () => {
    const victim = await seedPublisher({ login: "victim" });
    const token = await forge({ id: victim.id, login: victim.login });

    const dashboard = await apiGet(`/api/dashboard/data?token=${token}`);
    expect(dashboard.status).toBe(401);

    const status = await apiGet(`/api/auth/status?token=${token}`);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ authenticated: false });
  });

  it("reports a forged token as unauthenticated, leaking no account row", async () => {
    const victim = await seedPublisher({ login: "victim", is_verified: true });
    const token = await forge({ id: victim.id, login: victim.login });

    const response = await apiGet("/api/auth/status", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authenticated: false });
    // The row carries email and role. Neither may appear for a forged caller.
    expect(response.text).not.toContain("victim");
  });

  // The forgery does not need a real account id to be dangerous: a token for an
  // id that does not exist used to authenticate too, which told an attacker the
  // key was right before they had a victim in mind.
  it("gives no oracle for a made-up account id", async () => {
    const token = await forge({ id: "no-such-user", login: "nobody" });

    const status = await apiGet("/api/auth/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status.body).toEqual({ authenticated: false });

    const check = await apiPost("/api/registrations/check", {
      body: { repo_url: "attacker/fin-evil" },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(check.status).toBe(401);
  });

  // The control: a real session token still works, so the tests above are
  // measuring forgery and not a blanket 401.
  it("still admits a real session token", async () => {
    const publisher = await seedPublisher({ login: "genuine" });
    const session = await seedSession({ publisher });

    const status = await apiGet("/api/auth/status", {
      headers: { Cookie: `auth_token=${session.token}` },
    });
    expect(status.body.authenticated).toBe(true);
    expect(status.body.user?.login).toBe("genuine");

    const dashboard = await apiGet("/api/dashboard/data", {
      headers: { Cookie: `auth_token=${session.token}` },
    });
    expect(dashboard.status).toBe(200);
  });
});
