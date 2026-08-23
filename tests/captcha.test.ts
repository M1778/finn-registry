/**
 * The proof-of-work gate.
 *
 * Two halves. `verifyCaptcha` is checked directly, because every refusal it can
 * give is a distinct hole if it stops working: an unsigned challenge would let a
 * client choose difficulty zero, a replayable one would let a single solve pay
 * for a thousand submissions. Then the routes, which only need to show that the
 * gate is actually wired to them and that a refusal is legible.
 *
 * Solving is real work here — a 15-bit challenge is around 32k SHA-256s — so
 * solutions are reused across assertions wherever the property under test does
 * not need a fresh one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiGet,
  apiPost,
  captchaHeaders,
  githubRepo,
  seedPublisher,
  seedSession,
  stubGitHub,
  jsonResponse,
} from "./setup";
import {
  CAPTCHA_HEADER,
  CAPTCHA_SCOPES,
  encodeSolution,
  type Challenge,
} from "@/lib/captcha-shared";
import { issueChallenge, verifyCaptcha } from "@/lib/captcha";
import { solveChallenge } from "@/lib/captcha-solver";

const REPO_URL = "https://github.com/acme/fin-http";

/** A signed challenge and a nonce that satisfies it. */
async function solved(scope: keyof typeof CAPTCHA_SCOPES) {
  const challenge = await issueChallenge(scope);
  const nonce = await solveChallenge(challenge);
  return { challenge, nonce, token: encodeSolution(challenge, nonce) };
}

describe("verifyCaptcha", () => {
  it("accepts a solved challenge for the scope it was issued for", async () => {
    const { token } = await solved("login");
    expect(await verifyCaptcha(token, "login")).toEqual({ ok: true });
  });

  it("refuses the same solution twice", async () => {
    const { token } = await solved("login");
    expect(await verifyCaptcha(token, "login")).toEqual({ ok: true });
    expect(await verifyCaptcha(token, "login")).toEqual({
      ok: false,
      reason: "replayed",
    });
  });

  it("reports a missing token as missing, not as malformed", async () => {
    // The difference matters to the reader: one means reload, the other means
    // the page never ran its script.
    expect(await verifyCaptcha(undefined, "login")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(await verifyCaptcha("", "login")).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it.each([
    ["not a token at all", "hello"],
    ["too few parts", "v1.abc.13.1.sig"],
    ["a non-hex salt", "v1.zzzz.13.99999999999999.deadbeef.7"],
    ["a non-numeric nonce", "v1.0123456789abcdef0123456789abcdef.13.99999999999999.ab.x"],
  ])("rejects %s as malformed", async (_label, token) => {
    expect(await verifyCaptcha(token, "login")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a solution whose salt was solved for a different scope", async () => {
    // Scope is inside the signed payload, so a proof bought for signing in
    // cannot be spent on registering a package.
    const { challenge, nonce } = await solved("register");
    const token = encodeSolution(challenge, nonce);
    expect(await verifyCaptcha(token, "verify-request")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a lowered difficulty even though the rest is untouched", async () => {
    // The attack this closes: take a real challenge, rewrite 15 to 1, solve the
    // easy version. The signature covers `bits`, so it stops being valid.
    const { challenge, nonce } = await solved("register");
    const weakened: Challenge = { ...challenge, bits: 1 };
    expect(await verifyCaptcha(encodeSolution(weakened, nonce), "register")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a forged signature", async () => {
    const challenge = await issueChallenge("login");
    const forged: Challenge = { ...challenge, sig: "0".repeat(challenge.sig.length) };
    expect(await verifyCaptcha(encodeSolution(forged, 0), "login")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects an expired challenge, and one that claims to outlive the TTL", async () => {
    const challenge = await issueChallenge("login");
    const stale = encodeSolution({ ...challenge, exp: Date.now() - 1 }, 0);
    const forever = encodeSolution({ ...challenge, exp: Date.now() + 8.64e7 }, 0);
    expect(await verifyCaptcha(stale, "login")).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await verifyCaptcha(forever, "login")).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a valid challenge with work that was not done", async () => {
    const challenge = await issueChallenge("register");
    // Nonce 0 has a 1-in-32768 chance of being the answer at 15 bits, so this
    // is deterministic in practice; if it ever flakes, the salt is random and
    // the next run differs.
    expect(await verifyCaptcha(encodeSolution(challenge, 0), "register")).toEqual({
      ok: false,
      reason: "insufficient_work",
    });
  });

  it("issues a challenge at the difficulty its scope asks for", async () => {
    for (const scope of Object.keys(CAPTCHA_SCOPES) as (keyof typeof CAPTCHA_SCOPES)[]) {
      const challenge = await issueChallenge(scope);
      expect(challenge.bits).toBe(CAPTCHA_SCOPES[scope]);
      expect(challenge.salt).toMatch(/^[0-9a-f]{32}$/);
      expect(challenge.exp).toBeGreaterThan(Date.now());
    }
  });

  it("never issues the same salt twice", async () => {
    const salts = new Set<string>();
    for (let i = 0; i < 32; i += 1) {
      salts.add((await issueChallenge("login")).salt);
    }
    expect(salts.size).toBe(32);
  });
});

describe("GET /api/captcha", () => {
  it("hands out a challenge for each browser scope", async () => {
    for (const scope of ["register", "register-check", "verify-request"]) {
      const res = await apiGet(`/api/captcha?scope=${scope}`);
      expect(res.status).toBe(200);
      const body = res.body as Challenge;
      expect(Object.keys(body).sort()).toEqual(["bits", "exp", "salt", "sig"]);
    }
  });

  it("refuses an unknown scope", async () => {
    const res = await apiGet("/api/captcha?scope=admin");
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_scope");
  });

  it("refuses the login scope, which is issued by the sign-in page itself", async () => {
    // A caller that could mint login challenges here could pre-solve them in
    // bulk; the interstitial hands out its own.
    expect((await apiGet("/api/captcha?scope=login")).status).toBe(400);
  });

  it("is never cached, because a reused challenge is a replayed one", async () => {
    const res = await apiGet("/api/captcha?scope=register");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("the gated writes", () => {
  let token: string;

  beforeEach(async () => {
    const publisher = await seedPublisher({ login: "acme" });
    token = (
      await seedSession({ publisher, github_scope: "user:email,public_repo" })
    ).token;
  });

  it.each([
    ["/api/registrations/check", { repo_url: REPO_URL }],
    ["/api/packages", { name: "http", repo_url: REPO_URL }],
    ["/api/me/verification-request", { note: null }],
  ])("428s on %s without a proof", async (url, body) => {
    const res = await apiPost(url, { token, body, captcha: false });
    expect(res.status).toBe(428);
    const payload = res.body as { error: string; reason: string; message: string };
    expect(payload.error).toBe("captcha_required");
    expect(payload.reason).toBe("missing");
    // The wording must not read as "your account may not do this".
    expect(payload.message).toMatch(/reload/i);
  });

  it("still answers 401 before asking for a proof", async () => {
    // Order matters: a signed-out visitor should be told to sign in, not handed
    // a puzzle to solve first.
    const res = await apiPost("/api/registrations/check", {
      body: { repo_url: REPO_URL },
      captcha: false,
    });
    expect(res.status).toBe(401);
  });

  it("names the reason when the proof is spent rather than absent", async () => {
    const headers = await captchaHeaders("register-check");
    stubGitHub(() => jsonResponse(githubRepo()));

    const first = await apiPost("/api/registrations/check", {
      token,
      body: { repo_url: REPO_URL },
      headers,
    });
    expect(first.status).toBe(200);

    const replay = await apiPost("/api/registrations/check", {
      token,
      body: { repo_url: REPO_URL },
      headers,
    });
    expect(replay.status).toBe(428);
    expect((replay.body as { reason: string }).reason).toBe("replayed");
  });

  it("lets a real proof through to the handler", async () => {
    stubGitHub(() => jsonResponse(githubRepo()));
    const res = await apiPost("/api/registrations/check", {
      token,
      body: { repo_url: REPO_URL },
    });
    expect(res.status).toBe(200);
    expect((res.body as { push_access: boolean }).push_access).toBe(true);
  });

  it("does not gate the reads the CLI depends on", async () => {
    // Every endpoint finn calls is a public GET. If one of these ever needs a
    // proof, the CLI breaks and this test is the warning.
    for (const url of [
      "/api/health",
      "/api/packages",
      "/api/packages?q=http",
      "/api/stats",
      "/api/search/suggestions?q=ht",
    ]) {
      const res = await apiGet(url);
      expect(res.status, url).toBe(200);
      expect(res.headers.get(CAPTCHA_HEADER), url).toBeNull();
    }
  });
});

describe("the sign-in interstitial", () => {
  const CLIENT_ID = "Iv1.testclientid";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.GITHUB_CLIENT_ID;
    process.env.GITHUB_CLIENT_ID = CLIENT_ID;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = saved;
  });

  it("answers with a challenge page instead of redirecting to GitHub", async () => {
    const res = await apiGet("/api/auth/github");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("github.com/login/oauth");
    expect(res.text).toContain("Checking your browser");
    // No cookie may be set yet: state belongs to the attempt that gets through.
    expect(res.headers.get("set-cookie")).toBeNull();
    // Each value on its own line, because docker/probe.mjs reads them back out
    // of the page and a paired declaration would hide one from it.
    expect(res.text).toMatch(/var salt = "[0-9a-f]{32}";/);
    expect(res.text).toMatch(/var bits = \d+;/);
    expect(res.text).toMatch(/var exp = "\d+";/);
    expect(res.text).toMatch(/var sig = "[0-9a-f]{64}";/);
  });

  it("keeps the scope and return params across the check", async () => {
    const res = await apiGet(
      "/api/auth/github?scope=public_repo&return=%2Fnew",
    );
    const next = res.text.match(/var next = "([^"]*)"/)?.[1];
    expect(next).toBeDefined();
    expect(next).toContain("scope=public_repo");
    expect(next).toContain("return=%2Fnew");
    expect(next).toContain("cr=1");
    expect(next).toMatch(/captcha=$/);
  });

  it("treats a junk attempt counter as a first attempt, never as a loop", async () => {
    // `Number("abc")` is NaN, which compares false against every bound and used
    // to be written straight back into the next URL.
    const res = await apiGet("/api/auth/github?cr=abc");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Checking your browser");
    expect(res.text.match(/var next = "([^"]*)"/)?.[1]).toContain("cr=1");
  });

  it("gives up after two attempts rather than looping", async () => {
    // The signing key can differ between isolates when CAPTCHA_SECRET is unset,
    // and a reader must not be bounced around forever by that.
    const res = await apiGet("/api/auth/github?cr=2&captcha=nonsense");
    expect(res.status).toBe(400);
    expect(res.text).toContain("Check Failed");
    expect(res.text).not.toContain("Checking your browser");
  });

  it("redirects to GitHub once a solved proof comes back", async () => {
    const { token } = await solved("login");
    const res = await apiGet(
      `/api/auth/github?cr=1&captcha=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("github.com/login/oauth/authorize");
    expect(res.text).toContain(CLIENT_ID);
    // Now the state cookie is set, because this attempt is the one proceeding.
    expect(res.headers.get("set-cookie")).toContain("oauth_state=");
  });

  /**
   * The interstitial cannot import the solver — there is no bundle on that page
   * — so it carries a longhand copy. This runs that copy and checks the server
   * accepts what it produces, which is the only thing that keeps the two in
   * step. If this fails after a change to `captcha-shared.ts`, the inline script
   * in `router.ts` is what needs updating.
   */
  it("ships a solver the server agrees with", async () => {
    const html = (await apiGet("/api/auth/github")).text;
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();

    const navigated = new Promise<string>((resolve, reject) => {
      const fakeWindow = { location: { replace: resolve } };
      const fakeDocument = {
        getElementById: () => ({
          set textContent(message: string) {
            reject(new Error(`solver gave up: ${message}`));
          },
        }),
      };
      // Running the page's own script is the whole point of this test.
      new Function("window", "document", script!)(fakeWindow, fakeDocument);
    });

    const url = await navigated;
    const token = decodeURIComponent(url.split("captcha=")[1]);
    expect(await verifyCaptcha(token, "login")).toEqual({ ok: true });
  }, 30_000);
});
