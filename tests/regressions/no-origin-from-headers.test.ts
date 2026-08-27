/**
 * The OAuth origin comes from configuration, never from a request header.
 *
 * THE REGRESSION. `getOrigin` used to prefer `APP_URL`/`NEXT_PUBLIC_APP_URL` and,
 * when neither was set, build an origin out of `x-forwarded-host` (or `host`)
 * and `x-forwarded-proto`. That origin became the `redirect_uri` sent to GitHub
 * in two places: the authorize URL the sign-in page redirects to, and the body
 * of the token exchange. `x-forwarded-host` is a header any client can send —
 * Cloudflare neither sets nor strips it — so an unconfigured deployment let the
 * caller help decide where an authorization code was sent.
 *
 * HOW BAD IT WAS, stated accurately. GitHub matches `redirect_uri` against the
 * OAuth app's registered callback and refuses a host that does not match, so a
 * poisoned origin failed the exchange rather than delivering a code to the
 * attacker. This was a latent defect and a defence-in-depth fix, not a live
 * hole. It is worth holding shut anyway, for the reason `registry/v1/url.txt`
 * gives about placeholders: not knowing a value and guessing it are different
 * things, and only one of them is safe. A guessed origin also turns "nobody set
 * APP_URL" into GitHub's opaque `redirect_uri_mismatch`, which reads as "the
 * OAuth app is misconfigured" — a different problem needing different words.
 *
 * WHAT IS ASSERTED. Not the shape of the refusal message, which is prose and may
 * be reworded. What is asserted is that with no origin configured, a request
 * carrying `x-forwarded-host: evil.example` produces no outbound call and no
 * response text containing that host — and that the refusal names `APP_URL`, so
 * the operator is told what to set.
 *
 * `fetch` is stubbed here rather than with the harness's `stubGitHub`, because
 * that helper throws on anything outside `https://api.github.com/` and the token
 * exchange goes to `https://github.com/login/oauth/access_token`. Capturing that
 * call is the entire point of the callback case: on the old code it carried
 * `redirect_uri=https://evil.example/...`, which is the byte this test exists to
 * catch.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiGet } from "../setup";
import { issueChallenge } from "@/lib/captcha";
import { solveToken } from "@/lib/captcha-solver";

/**
 * A solved `login` proof, as a query param.
 *
 * `/auth/github` refuses a missing client id, then answers the proof-of-work
 * interstitial, and only then needs an origin — so a case about the origin has
 * to do the work to reach the line under test. Real work, at the production
 * difficulty: the point of these cases is what happens on the far side of the
 * gate, and tunnelling under it would test a path no caller takes.
 */
async function solvedLogin(): Promise<string> {
  return encodeURIComponent(await solveToken(await issueChallenge("login")));
}

const EVIL = "evil.example";
const CONFIGURED = "https://registry.test";

const realFetch = globalThis.fetch;
let outbound: { url: string; body: string | undefined }[] = [];

/** Captures every outbound call and answers the token exchange with an error. */
function captureFetch() {
  outbound = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    outbound.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    return new Response(JSON.stringify({ error: "bad_verification_code" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

/**
 * The router reads these at call time, so a test can move them. Saved and
 * restored around every case: vitest gives this file its own module registry but
 * not its own `process.env`.
 */
let savedAppUrl: string | undefined;
let savedPublicAppUrl: string | undefined;
let savedClientId: string | undefined;

beforeEach(() => {
  savedAppUrl = process.env.APP_URL;
  savedPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  savedClientId = process.env.GITHUB_CLIENT_ID;
  captureFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
  if (savedPublicAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedPublicAppUrl;
  if (savedClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
  else process.env.GITHUB_CLIENT_ID = savedClientId;
});

function unconfigure() {
  delete process.env.APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
}

/**
 * `/auth/github` refuses a missing `GITHUB_CLIENT_ID` before it looks at the
 * origin, so a case about the origin has to get past that first. Setting it here
 * is what makes the assertion be about the origin rather than about the earlier
 * refusal happening to contain no hostname.
 */
function configureClientId() {
  process.env.GITHUB_CLIENT_ID = "Iv1.testclientid";
}

describe("the OAuth origin is configured, not derived", () => {
  it("refuses to start sign-in when no origin is configured, and names APP_URL", async () => {
    configureClientId();
    unconfigure();

    const res = await apiGet(`/api/auth/github?cr=1&captcha=${await solvedLogin()}`, {
      headers: { "x-forwarded-host": EVIL, "x-forwarded-proto": "https" },
    });

    expect(res.text).not.toContain(EVIL);
    expect(res.text).toContain("APP_URL");
  });

  it("does not build a redirect_uri from x-forwarded-host in the token exchange", async () => {
    unconfigure();

    const res = await apiGet(
      `/api/auth/github/callback?code=abc123&state=s${"t".repeat(8)}`,
      {
        headers: {
          "x-forwarded-host": EVIL,
          "x-forwarded-proto": "https",
          Cookie: `oauth_state=s${"t".repeat(8)}`,
        },
      },
    );

    // The old code reached the exchange and put the header's host in the body.
    const exchange = outbound.filter((call) => call.url.includes("/login/oauth/access_token"));
    for (const call of exchange) {
      expect(call.body ?? "").not.toContain(EVIL);
    }

    expect(res.text).not.toContain(EVIL);
    expect(res.text).toContain("APP_URL");
  });

  it("ignores x-forwarded-host even when an origin IS configured", async () => {
    process.env.APP_URL = CONFIGURED;
    delete process.env.NEXT_PUBLIC_APP_URL;

    const res = await apiGet(
      `/api/auth/github/callback?code=abc123&state=s${"t".repeat(8)}`,
      {
        headers: {
          "x-forwarded-host": EVIL,
          "x-forwarded-proto": "https",
          Cookie: `oauth_state=s${"t".repeat(8)}`,
        },
      },
    );

    const exchange = outbound.filter((call) => call.url.includes("/login/oauth/access_token"));
    expect(exchange.length).toBeGreaterThan(0);
    for (const call of exchange) {
      expect(call.body ?? "").toContain(`${CONFIGURED}/api/auth/github/callback`);
      expect(call.body ?? "").not.toContain(EVIL);
    }
    expect(res.text).not.toContain(EVIL);
  });

  it("treats the wrangler.jsonc placeholder as unconfigured rather than as an origin", async () => {
    // A value that validates but is not an answer is worse than an absent one:
    // it would build a redirect_uri and come back as `redirect_uri_mismatch`.
    configureClientId();
    process.env.APP_URL = "https://REPLACE_WITH_DEPLOYMENT_ORIGIN";
    delete process.env.NEXT_PUBLIC_APP_URL;

    const res = await apiGet(`/api/auth/github?cr=1&captcha=${await solvedLogin()}`);

    expect(res.text).not.toContain("REPLACE_WITH_DEPLOYMENT_ORIGIN");
    expect(res.text).toContain("APP_URL");
  });

  /**
   * `NEXT_PUBLIC_APP_URL` is not an origin source, and this is the case that says
   * so out loud.
   *
   * The read was once `NEXT_PUBLIC_APP_URL || APP_URL`. That is not a fallback
   * between two equivalent names: `NEXT_PUBLIC_*` is inlined by Next at build
   * time, so it froze the build machine's origin into the artifact and deleted
   * the `APP_URL` branch during minification — which made `wrangler.jsonc`'s var
   * unreachable and the placeholder guard above unreachable with it.
   *
   * What this case can and cannot do. It pins the *source selection*: with only
   * the `NEXT_PUBLIC_` copy set, sign-in refuses and names `APP_URL`, so putting
   * the old `||` back turns this red. It cannot detect the inlining itself —
   * vitest runs on Node against source, where no substitution happens, so the
   * frozen-literal failure is invisible here by construction. That half is
   * checked against the built artifact in `docker/verify.sh`.
   */
  it("does not accept NEXT_PUBLIC_APP_URL as the origin, because it is a build-time inline", async () => {
    configureClientId();
    delete process.env.APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://inlined-at-build-time.example";

    const res = await apiGet(`/api/auth/github?cr=1&captcha=${await solvedLogin()}`);

    expect(res.text).not.toContain("inlined-at-build-time.example");
    expect(res.text).toContain("APP_URL");
  });
});

describe("a completed sign-in is host-only and lands on a relative path", () => {
  /**
   * Answers the whole callback happy path: the token exchange, then
   * `api.github.com/user` and `/user/emails`.
   */
  function stubSuccessfulSignIn() {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (url.includes("/login/oauth/access_token")) {
        return json({ access_token: "gho_test", scope: "user:email" });
      }
      if (url === "https://api.github.com/user") {
        return json({
          id: 4242,
          login: "someone",
          name: "Some One",
          avatar_url: "https://avatars.example/u/4242",
          email: "someone@example.com",
        });
      }
      if (url === "https://api.github.com/user/emails") {
        return json([{ email: "someone@example.com", primary: true, verified: true }]);
      }
      throw new Error(`[tests] unexpected call to ${url}`);
    }) as typeof fetch;
  }

  it("sets a host-only session cookie, with no Domain attribute", async () => {
    // The `domain` attribute used to be set for one vendor's preview hosts and
    // left undefined everywhere else. Host-only is the tighter scope and is now
    // unconditional; a Domain would widen the cookie to every subdomain.
    process.env.APP_URL = CONFIGURED;
    stubSuccessfulSignIn();

    const res = await apiGet(
      `/api/auth/github/callback?code=abc123&state=s${"t".repeat(8)}`,
      { headers: { Cookie: `oauth_state=s${"t".repeat(8)}` } },
    );

    const cookies = res.headers.getSetCookie().filter((c) => c.startsWith("auth_token="));
    expect(cookies.length).toBe(1);
    expect(cookies[0]).not.toMatch(/;\s*domain=/i);
    expect(cookies[0]).toMatch(/;\s*httponly/i);
  });

  it("redirects to a site-relative path, not to a built absolute URL", async () => {
    // `safeReturnPath` already guarantees a single leading slash, so a relative
    // Location needs no origin and cannot be pointed off-site by a header.
    process.env.APP_URL = CONFIGURED;
    stubSuccessfulSignIn();

    const res = await apiGet(
      `/api/auth/github/callback?code=abc123&state=s${"t".repeat(8)}`,
      {
        headers: {
          Cookie: `oauth_state=s${"t".repeat(8)}; oauth_return=/dashboard`,
          "x-forwarded-host": EVIL,
        },
      },
    );

    const location = res.headers.get("location");
    expect(location).toBe("/dashboard");
    expect(location).not.toContain("://");
    expect(location).not.toContain(EVIL);
  });
});

describe("the auth error page escapes what it interpolates", () => {
  /**
   * Seven of the call sites pass constants from this repository. `:1182` passes
   * GitHub's `error_description`, which is not ours, and the next call site
   * somebody adds will not be checked either.
   */
  it("does not emit a script tag from GitHub's error_description", async () => {
    process.env.APP_URL = CONFIGURED;

    const payload = "<script>alert(1)</script>";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: "bad_verification_code", error_description: payload }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const res = await apiGet(
      `/api/auth/github/callback?code=abc123&state=s${"t".repeat(8)}`,
      { headers: { Cookie: `oauth_state=s${"t".repeat(8)}` } },
    );

    expect(res.text).not.toContain(payload);
    expect(res.text).not.toContain("<script>alert(1)");
    expect(res.text).toContain("&lt;script&gt;");
  });

  it("renders without fetching a stylesheet from the network", async () => {
    // Reachable exactly when a sign-in has failed, which is the worst moment to
    // need the network in order to be legible.
    process.env.APP_URL = CONFIGURED;

    const res = await apiGet("/api/auth/github/callback");

    expect(res.status).toBe(400);
    expect(res.text).not.toContain("cdn.tailwindcss.com");
    expect(res.text).not.toMatch(/<script\b/i);
    expect(res.text).toContain("<style>");
  });
});
