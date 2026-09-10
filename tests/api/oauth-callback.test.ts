/**
 * The OAuth sign-in flow, end to end.
 *
 * Two regression suites already pin two specific bugs in this flow — the state
 * token must never reach a parent frame, and a session token must never be
 * forgeable — but nothing exercised the callback from start to finish, which the
 * contract has said in as many words for two revisions. That gap is the reason a
 * `domain` attribute sat on the session cookie for one vendor's preview hosts and
 * the reason the origin was once taken from a request header: both are decisions
 * this handler makes on the way to a session, and neither is visible from a test
 * of anything else.
 *
 * The seam is the one every other suite uses: the real Hono router over HTTP, and
 * `globalThis.fetch` stubbed at the network boundary. Nothing reads a row
 * directly. An account exists when `/api/auth/status` says so with the cookie the
 * callback handed back, and it does not exist when no session was issued at all —
 * which is the same evidence a browser has.
 *
 * The one thing worth stating about what is *not* asserted here: GitHub's own
 * side. The `state` this suite sends is the state this suite put in the cookie,
 * because the CSRF property is that those two must agree, and a test that fetched
 * the real value from `/api/auth/github` first would be testing the interstitial
 * (which `tests/captcha.test.ts` already does) rather than the callback.
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { apiGet, apiPost, stubGitHub, githubRepo, jsonResponse } from "../setup";

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const EMAILS_URL = "https://api.github.com/user/emails";

/** The `state` a real flow would have set as a cookie one request earlier. */
const STATE = "9f2c41ab7d0e5638bb1a4c7f0e2d9a63";

/** A GitHub `GET /user` payload, with only the fields the callback reads. */
function githubUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 90210,
    login: "octo-publisher",
    name: "Octo Publisher",
    email: "profile@acme.example",
    avatar_url: "https://avatars.example/u/90210",
    ...overrides,
  };
}

interface OAuthStub {
  /** What the token exchange answers. */
  token?: Record<string, unknown>;
  /** What `GET /user` answers, or a Response to answer with. */
  user?: Record<string, unknown> | Response;
  /** What `GET /user/emails` answers, or a Response to answer with. */
  emails?: unknown[] | Response;
  /** What `GET /repos/{owner}/{repo}` answers, for the one test that gets that far. */
  repo?: Record<string, unknown>;
}

/** Stubs the whole sign-in conversation. Returns the call log. */
function stubOAuth(overrides: OAuthStub = {}) {
  const token = overrides.token ?? {
    access_token: "gho_a_real_looking_token",
    scope: "read:user,user:email",
    token_type: "bearer",
  };

  return stubGitHub((url) => {
    if (url === TOKEN_URL) return jsonResponse(token);
    if (url === USER_URL) {
      const user = overrides.user ?? githubUser();
      return user instanceof Response ? user : jsonResponse(user);
    }
    if (url === EMAILS_URL) {
      const emails = overrides.emails ?? [
        { email: "listed-first@acme.example", primary: false, verified: true },
        { email: "primary@acme.example", primary: true, verified: true },
      ];
      return emails instanceof Response ? emails : jsonResponse(emails);
    }
    if (url.startsWith("https://api.github.com/repos/")) {
      return jsonResponse(overrides.repo ?? githubRepo());
    }
    throw new Error(`[test] unexpected GitHub call to ${url}`);
  });
}

/**
 * One request to the callback.
 *
 * `state` defaults to the cookie's value, because that is the case every
 * refusal here is measured against.
 */
function callback(
  options: {
    code?: string | null;
    state?: string | null;
    cookieState?: string | null;
    returnTo?: string | null;
  } = {},
) {
  const query = new URLSearchParams();
  if (options.code !== null) query.set("code", options.code ?? "gh_auth_code_abc123");
  const state = options.state === undefined ? STATE : options.state;
  if (state !== null) query.set("state", state);

  const cookies: string[] = [];
  const cookieState = options.cookieState === undefined ? STATE : options.cookieState;
  if (cookieState !== null) cookies.push(`oauth_state=${cookieState}`);
  if (options.returnTo) cookies.push(`oauth_return=${encodeURIComponent(options.returnTo)}`);

  const headers: Record<string, string> = {};
  if (cookies.length) headers.Cookie = cookies.join("; ");

  return apiGet(`/api/auth/github/callback?${query.toString()}`, { headers });
}

/** The session cookie the callback issued, or null if it issued none. */
function sessionToken(headers: Headers): string | null {
  const cookie = headers.getSetCookie().find((c) => c.startsWith("auth_token="));
  if (!cookie) return null;
  const value = cookie.slice("auth_token=".length).split(";")[0];
  return value.length ? value : null;
}

/** The one Set-Cookie line for a given name. */
function setCookieFor(headers: Headers, name: string): string {
  return headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "";
}

// The callback reads both of these and sends them to GitHub. They are set here
// rather than in the harness because every other suite gets to a session through
// `seedSession`, which never touches the OAuth app's credentials.
let savedId: string | undefined;
let savedSecret: string | undefined;

beforeEach(() => {
  savedId = process.env.GITHUB_CLIENT_ID;
  savedSecret = process.env.GITHUB_CLIENT_SECRET;
  process.env.GITHUB_CLIENT_ID = "Iv1.testclientid";
  process.env.GITHUB_CLIENT_SECRET = "test-client-secret-not-a-real-one";
});

afterEach(() => {
  if (savedId === undefined) delete process.env.GITHUB_CLIENT_ID;
  else process.env.GITHUB_CLIENT_ID = savedId;
  if (savedSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
  else process.env.GITHUB_CLIENT_SECRET = savedSecret;
});

describe("signing in for the first time", () => {
  it("creates the account and answers with a working session", async () => {
    stubOAuth();

    const res = await callback();

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");

    const token = sessionToken(res.headers);
    expect(token).toBeTruthy();

    // The account exists because the session it issued can be used, which is the
    // same evidence the browser gets on its next request.
    const status = await apiGet("/api/auth/status", {
      headers: { Cookie: `auth_token=${token}` },
    });
    expect(status.status).toBe(200);
    expect(status.body.authenticated).toBe(true);
    expect(status.body.user.githubId).toBe(90210);
    expect(status.body.user.login).toBe("octo-publisher");
    expect(status.body.user.name).toBe("Octo Publisher");
    expect(status.body.user.avatarUrl).toBe("https://avatars.example/u/90210");
  });

  it("scopes the session cookie to this host only, and clears the return cookie", async () => {
    stubOAuth();

    const res = await callback();

    const auth = setCookieFor(res.headers, "auth_token");
    expect(auth).toContain("HttpOnly");
    expect(auth).toContain("Secure");
    expect(auth).toContain("SameSite=Lax");
    expect(auth).toContain("Path=/");
    expect(auth).toContain("Max-Age=2592000");
    // Host-only. A `Domain` attribute would send the session to every subdomain,
    // which is how it was set for one vendor's preview hosts.
    expect(auth.toLowerCase()).not.toContain("domain=");

    // The return path has been consumed, so a later sign-in cannot inherit it.
    expect(setCookieFor(res.headers, "oauth_return")).toContain("Max-Age=0");
  });

  it("spends the code once, at the callback URL the GitHub app is registered with", async () => {
    const calls = stubOAuth();

    await callback({ code: "gh_auth_code_xyz789" });

    const exchanges = calls.filter((c) => c.url === TOKEN_URL);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].method).toBe("POST");

    const sent = JSON.parse(exchanges[0].body ?? "{}");
    expect(sent.code).toBe("gh_auth_code_xyz789");
    expect(sent.client_id).toBe("Iv1.testclientid");
    expect(sent.client_secret).toBe("test-client-secret-not-a-real-one");
    // Built from APP_URL and nothing else. GitHub compares this string against
    // the one registered on the app, so a derived-from-a-header origin is a
    // `redirect_uri_mismatch` on somebody else's deployment.
    expect(sent.redirect_uri).toBe("https://registry.test/api/auth/github/callback");
  });

  it("keeps the token GitHub issued, so the registration check presents that token", async () => {
    // Not a detail of the callback: ADR-0004 has registration prove push access
    // as this user, and the only place that token can come from is this exchange.
    // Nothing else connects the two ends.
    const calls = stubOAuth({
      token: { access_token: "gho_the_one_that_must_be_stored", scope: "repo" },
    });

    const res = await callback();
    const token = sessionToken(res.headers);

    const check = await apiPost("/api/registrations/check", {
      token: token ?? "",
      body: { repo_url: "https://github.com/acme/fin-http" },
    });
    expect(check.status).toBe(200);

    const repoCalls = calls.filter((c) => c.url.startsWith("https://api.github.com/repos/"));
    expect(repoCalls).toHaveLength(1);
    expect(repoCalls[0].headers.authorization).toBe("Bearer gho_the_one_that_must_be_stored");
  });

  it("takes the primary verified address over the first one listed", async () => {
    stubOAuth();

    const res = await callback();
    const status = await apiGet("/api/auth/status", {
      headers: { Cookie: `auth_token=${sessionToken(res.headers)}` },
    });

    expect(status.body.user.email).toBe("primary@acme.example");
  });

  it("falls back to the profile address when the address list is refused", async () => {
    // A token granted without `user:email` gets a 403 here. That is an ordinary
    // sign-in, not a failure, so it must not cost the reader their account.
    stubOAuth({ emails: new Response("Forbidden", { status: 403 }) });

    const res = await callback();
    expect(res.status).toBe(302);

    const status = await apiGet("/api/auth/status", {
      headers: { Cookie: `auth_token=${sessionToken(res.headers)}` },
    });
    expect(status.body.user.email).toBe("profile@acme.example");
  });

  it("records no address at all rather than a string saying null", async () => {
    stubOAuth({
      user: githubUser({ email: null }),
      emails: new Response("Forbidden", { status: 403 }),
    });

    const res = await callback();
    const status = await apiGet("/api/auth/status", {
      headers: { Cookie: `auth_token=${sessionToken(res.headers)}` },
    });

    expect(status.body.user.email).toBe("");
  });

  it("names the account after the login when GitHub carries no display name", async () => {
    stubOAuth({ user: githubUser({ name: null }) });

    const res = await callback();
    const status = await apiGet("/api/auth/status", {
      headers: { Cookie: `auth_token=${sessionToken(res.headers)}` },
    });

    expect(status.body.user.name).toBe("octo-publisher");
  });
});

describe("signing in again", () => {
  it("updates the one account rather than creating a second", async () => {
    stubOAuth();
    const first = await callback();
    const firstStatus = await apiGet("/api/auth/status", {
      headers: { Cookie: `auth_token=${sessionToken(first.headers)}` },
    });

    // Same GitHub id, everything else renamed — which is what a user who renames
    // themselves on GitHub looks like when they come back.
    stubOAuth({
      user: githubUser({
        login: "octo-renamed",
        name: "Octo Renamed",
        avatar_url: "https://avatars.example/u/90210-v2",
      }),
    });
    const second = await callback();
    const secondStatus = await apiGet("/api/auth/status", {
      headers: { Cookie: `auth_token=${sessionToken(second.headers)}` },
    });

    // The same row: a second account would carry a different id, and the id is
    // what every package's `owner_id` points at.
    expect(secondStatus.body.user.id).toBe(firstStatus.body.user.id);
    expect(secondStatus.body.user.login).toBe("octo-renamed");
    expect(secondStatus.body.user.name).toBe("Octo Renamed");
    expect(secondStatus.body.user.avatarUrl).toBe("https://avatars.example/u/90210-v2");
  });

  it("leaves the earlier session usable, since a session is keyed per token", async () => {
    // Stated rather than assumed: `sessions` is keyed by token, one row per
    // sign-in, so concurrent sessions are structural and a reader signed in on
    // two devices stays signed in on both. If that should ever become
    // single-session, this test is the thing that has to be changed on purpose —
    // which is the point of pinning it.
    stubOAuth();
    const first = await callback();
    const firstToken = sessionToken(first.headers);

    stubOAuth();
    await callback();

    const status = await apiGet("/api/auth/status", {
      headers: { Cookie: `auth_token=${firstToken}` },
    });
    expect(status.body.authenticated).toBe(true);
  });
});

describe("refusing a callback", () => {
  it("refuses a state that does not match the cookie, without spending the code", async () => {
    // The CSRF property. An attacker can make a browser fetch this URL with
    // their own `code`; what they cannot do is set this host's cookie. So the
    // comparison is the whole defence, and it has to happen before the exchange —
    // spending the code first would sign the victim in as the attacker.
    const calls = stubOAuth();

    const res = await callback({ state: "0000000000000000000000000000dead" });

    expect(res.status).toBe(400);
    expect(res.text).toContain("Session Expired");
    expect(sessionToken(res.headers)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("refuses when the cookie is absent, rather than accepting the query alone", async () => {
    const calls = stubOAuth();

    const res = await callback({ cookieState: null });

    expect(res.status).toBe(400);
    expect(sessionToken(res.headers)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("refuses a callback carrying no state", async () => {
    const calls = stubOAuth();

    const res = await callback({ state: null });

    expect(res.status).toBe(400);
    expect(sessionToken(res.headers)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("refuses a callback carrying no code, and says which is missing", async () => {
    const calls = stubOAuth();

    const res = await callback({ code: null });

    expect(res.status).toBe(400);
    expect(res.text).toContain("No authorization code was provided.");
    expect(sessionToken(res.headers)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("reports GitHub's own words when the exchange is refused", async () => {
    stubOAuth({
      token: {
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
      },
    });

    const res = await callback();

    expect(res.status).toBe(400);
    expect(res.text).toContain("Token Exchange Failed");
    expect(res.text).toContain("The code passed is incorrect or expired.");
    expect(sessionToken(res.headers)).toBeNull();
  });

  it("issues no session when the profile cannot be read", async () => {
    // A token that exchanged fine and then cannot fetch a profile has no login
    // and no GitHub id, so there is nothing to key an account on. The refusal is
    // the only correct answer; a session here would belong to nobody.
    stubOAuth({ user: new Response("Bad credentials", { status: 401 }) });

    const res = await callback();

    expect(res.status).toBe(400);
    expect(res.text).toContain("GitHub Profile Error");
    expect(sessionToken(res.headers)).toBeNull();
  });

  it("issues no session when GitHub cannot be reached at all", async () => {
    stubGitHub(() => {
      throw new Error("ECONNREFUSED");
    });

    const res = await callback();

    expect(res.status).toBe(400);
    expect(res.text).toContain("Server Error");
    expect(sessionToken(res.headers)).toBeNull();
  });
});

describe("where the reader lands afterwards", () => {
  it("honours a path this site serves", async () => {
    stubOAuth();

    const res = await callback({ returnTo: "/new" });

    expect(res.headers.get("location")).toBe("/new");
  });

  it("refuses an absolute URL in the return cookie", async () => {
    // The cookie is httpOnly and this server set it, but a redirect target read
    // back out of a request is the input an open redirect is built from — and a
    // sign-in flow is exactly what a phisher wants one for.
    stubOAuth();

    const res = await callback({ returnTo: "https://evil.example/harvest" });

    expect(res.headers.get("location")).toBe("/dashboard");
  });

  it("refuses a protocol-relative return path", async () => {
    stubOAuth();

    const res = await callback({ returnTo: "//evil.example/harvest" });

    expect(res.headers.get("location")).toBe("/dashboard");
  });

  it("sends a reader with no return cookie to the dashboard", async () => {
    stubOAuth();

    const res = await callback();

    expect(res.headers.get("location")).toBe("/dashboard");
  });
});
