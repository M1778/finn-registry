/**
 * The sign-in interstitial never hands the OAuth `state` to a parent frame, and
 * nothing this registry serves may be framed at all.
 *
 * THE REGRESSION. `/auth/github`'s interstitial ended with:
 *
 *     if (window.self !== window.top) {
 *       window.parent.postMessage({ type: "OPEN_EXTERNAL_URL", data: { url } }, "*");
 *     } else {
 *       window.location.href = url;
 *     }
 *
 * `url` is the GitHub authorize URL, and it carries `state` — the login-CSRF
 * token. The same response that emitted this script also set `oauth_state` to
 * that value, so one HTTP response both minted the token and offered it away.
 * The frame check reads like a guard but is the trigger: the leak fires *only*
 * when the page is framed, which is the one circumstance an attacker arranges
 * and no ordinary use produces. Target origin was `"*"`, so any framing document
 * received it. Nothing in this repository listens for `OPEN_EXTERNAL_URL`; the
 * protocol belonged to a preview-tool parent frame that is not part of this
 * product, the same provenance as the other scaffold survivors.
 *
 * HOW BAD IT WAS, stated as precisely as this repository can. Two claims, and
 * they do not have the same standing.
 *
 *  1. Disclosure of the CSRF token to any framing origin is certain, and needs
 *     nothing from the browser but the ability to frame the page. That is what
 *     these cases pin.
 *  2. The onward chain — login CSRF / session fixation, where the attacker pairs
 *     the leaked `state` with a `code` from their own GitHub account and then
 *     navigates the victim top-level into the callback — additionally requires
 *     the victim's browser to keep the `Set-Cookie` from that framed, cross-site
 *     response in the same jar the later top-level navigation reads. Under
 *     third-party cookie partitioning it would not: the callback would find no
 *     matching `oauth_state` and refuse with "Session Expired". Under a browser
 *     that still writes unpartitioned third-party cookies, it would.
 *
 * Claim 2 is REASONED, NOT TESTED. There is no browser in this environment — no
 * playwright, puppeteer, jsdom or system chromium — and no dependency may be
 * installed, so no case here can demonstrate or refute the cookie-jar half. It
 * is written down as an open question rather than settled in either direction,
 * because overstating it would cost as much credibility as missing it. What is
 * *not* conditional: the token leaves the origin, and the fix does not depend on
 * how the argument about claim 2 comes out.
 *
 * WHAT IS ASSERTED. That the interstitial contains no `postMessage` and no
 * framing branch at all, that it still navigates top-level, and that the value
 * in the `oauth_state` cookie is the value that used to be posted — that last
 * one is evidence about why this mattered, not a behaviour to preserve.
 *
 * Then the second half: framing is denied repository-wide, so the deleted
 * branch's premise cannot come back. `X-Frame-Options: DENY` and CSP
 * `frame-ancestors 'none'` on every response the router serves — HTML and JSON
 * alike. The CSP carries `frame-ancestors` and nothing else on purpose, and the
 * last case here pins that: the interstitial and the proof-of-work bootstrap are
 * inline `<script>` blocks with no bundle behind them, so a `default-src` or
 * `script-src` added to this header would stop sign-in working while every
 * assertion above still passed.
 *
 * These cases cover the Hono router only, which is where every byte of the auth
 * flow is served. The page routes are covered by `headers()` in
 * `next.config.ts`, which is build configuration and cannot be reached from
 * in-process `app.request` — see the report for how that half was verified on
 * the built Worker instead.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { apiGet, type ApiResponse } from "../setup";
import { issueChallenge } from "@/lib/captcha";
import { solveToken } from "@/lib/captcha-solver";

/**
 * A solved `login` proof, as a query param.
 *
 * Real work at the production difficulty. `/auth/github` answers the
 * proof-of-work interstitial before it ever builds an authorize URL, so a case
 * about the authorize URL has to get through the gate to see one; tunnelling
 * under it would test a path no caller takes.
 */
async function solvedLogin(): Promise<string> {
  return encodeURIComponent(await solveToken(await issueChallenge("login")));
}

/** The interstitial: past the client-id check, past the proof of work. */
async function interstitial(): Promise<ApiResponse> {
  return apiGet(`/api/auth/github?cr=1&captcha=${await solvedLogin()}`);
}

/** The `oauth_state` value the response set, or null if it set none. */
function stateCookie(res: ApiResponse): string | null {
  const raw = res.headers.get("set-cookie") ?? "";
  return /oauth_state=([0-9a-f]+)/.exec(raw)?.[1] ?? null;
}

let savedClientId: string | undefined;

beforeEach(() => {
  savedClientId = process.env.GITHUB_CLIENT_ID;
  // Refused before anything else in the handler, so every case that wants to
  // reach the authorize URL has to set it.
  process.env.GITHUB_CLIENT_ID = "Iv1.testclientid";
});

afterEach(() => {
  if (savedClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
  else process.env.GITHUB_CLIENT_ID = savedClientId;
});

describe("the OAuth state never reaches a parent frame", () => {
  it("does not post the authorize URL to a parent frame", async () => {
    const res = await interstitial();

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("postMessage");
    expect(res.text).not.toContain("OPEN_EXTERNAL_URL");
  });

  it("does not branch on whether it is framed", async () => {
    const res = await interstitial();

    // The branch is the whole defect: `window.self !== window.top` is not a
    // guard around the leak, it is the condition that selects it.
    expect(res.text).not.toContain("window.top");
    expect(res.text).not.toContain("window.self");
    expect(res.text).not.toContain("window.parent");
  });

  it("navigates the top-level window to GitHub unconditionally", async () => {
    const res = await interstitial();

    expect(res.text).toContain("window.location.href");
    expect(res.text).toContain("https://github.com/login/oauth/authorize");
  });

  it("was leaking the same value it had just set as the CSRF cookie", async () => {
    const res = await interstitial();
    const state = stateCookie(res);

    // Evidence, not a behaviour to keep: the response mints `oauth_state` and
    // embeds the same value in the URL the old code offered to any parent. That
    // is why this was token disclosure and not merely an odd navigation path.
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(res.text).toContain(`state=${state}`);
    expect(res.text).not.toContain("postMessage");
  });
});

describe("nothing the router serves may be framed", () => {
  const denies = (res: ApiResponse) => {
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  };

  it("denies framing on the sign-in interstitial", async () => {
    denies(await interstitial());
  });

  it("denies framing on the proof-of-work bootstrap", async () => {
    // No `captcha` param, so this is the challenge page rather than the redirect.
    const res = await apiGet("/api/auth/github");
    expect(res.text).toContain("Checking your browser");
    denies(res);
  });

  it("denies framing on an error page", async () => {
    delete process.env.GITHUB_CLIENT_ID;
    const res = await apiGet("/api/auth/github");
    expect(res.text).toContain("Configuration Missing");
    denies(res);
  });

  it("denies framing on a JSON response", async () => {
    const res = await apiGet("/api/health");
    expect(res.status).toBe(200);
    denies(res);
  });

  it("sets frame-ancestors and no other CSP directive, so the inline solver runs", async () => {
    const csp = (await apiGet("/api/health")).headers.get("content-security-policy") ?? "";

    // The proof-of-work bootstrap and the interstitial are inline `<script>`
    // with no bundle behind them. A `script-src` or `default-src` here would
    // silently stop sign-in while every other case in this file still passed.
    expect(csp).not.toContain("script-src");
    expect(csp).not.toContain("default-src");
    expect(csp.split(";").filter((part) => part.trim().length > 0)).toHaveLength(1);
  });
});
