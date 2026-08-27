/**
 * Registration, docs/REGISTRY-CONTRACT.md §3.10 — `POST /api/registrations/check`
 * and `POST /api/packages`.
 *
 * Browser-only endpoints, driven by a signed-in human at `/new`. The CLI must
 * never call them (§2.6), so nothing here authenticates the way `finn` would.
 *
 * GitHub is stubbed at the `fetch` boundary rather than by mocking
 * `checkPushAccess`. The claim under test is that the registry proves push
 * access against the GitHub API using the signed-in user's token (§2.2,
 * ADR-0004); replacing our own module would assume that away and leave the test
 * asserting nothing but its own stub.
 */

import { describe, expect, it } from "vitest";
import {
  apiGet,
  apiPost,
  githubRepo,
  jsonResponse,
  seedPackage,
  seedPublisher,
  seedSession,
  stubGitHub,
  type SeededSession,
} from "../setup";
import {
  expectErrorEnvelope,
  expectKeys,
  expectNoCounters,
  PACKAGE_KEYS,
  REGISTRATION_CHECK_KEYS,
  REPO_FACTS_KEYS,
} from "../contract";
// The rule under test, imported rather than restated: a test that carried its own
// copy of the regex would keep passing after the regex changed.
import { FIN_RESERVED_WORDS, NAME_RULE, validatePackageName } from "@/lib/package-name";

const REPO_URL = "https://github.com/acme/fin-http";

/**
 * A signed-in publisher. `scope` defaults to the wider repository grant, since
 * most cases here are about what GitHub answers rather than about the grant;
 * the `user:email`-only case asks for it explicitly.
 */
async function signIn(
  options: { login?: string; scope?: string; is_verified?: boolean } = {},
): Promise<SeededSession> {
  const publisher = await seedPublisher({
    login: options.login ?? "acme",
    is_verified: options.is_verified ?? false,
  });

  return seedSession({
    publisher,
    github_access_token: "gho_session_token",
    github_scope: options.scope ?? "user:email,repo",
  });
}

/** Answers every `GET /repos/...` with one payload. */
function stubRepo(payload: unknown, status = 200) {
  return stubGitHub(() => jsonResponse(payload, status));
}

describe("POST /api/registrations/check", () => {
  it("401s without a session", async () => {
    const calls = stubRepo(githubRepo());

    const { status, body } = await apiPost("/api/registrations/check", {
      body: { repo_url: REPO_URL },
    });

    expect(status).toBe(401);
    expectErrorEnvelope(body);
    // Nothing was asked of GitHub on behalf of nobody.
    expect(calls).toHaveLength(0);
  });

  it("401s on an expired session", async () => {
    const publisher = await seedPublisher({ login: "acme" });
    const session = await seedSession({ publisher, expires_at: Date.now() - 1000 });
    stubRepo(githubRepo());

    const { status, body } = await apiPost("/api/registrations/check", {
      token: session.token,
      body: { repo_url: REPO_URL },
    });

    expect(status).toBe(401);
    expectErrorEnvelope(body);
  });

  it("reports push access, with the repo facts the registry will copy", async () => {
    const session = await signIn();
    stubRepo(
      githubRepo({
        full_name: "acme/fin-http",
        description: "An HTTP client",
        homepage: "https://acme.example/fin-http",
        default_branch: "trunk",
        license: { spdx_id: "Apache-2.0" },
        permissions: { admin: true, maintain: true, push: true, pull: true },
      }),
    );

    const { status, body } = await apiPost("/api/registrations/check", {
      token: session.token,
      body: { repo_url: REPO_URL },
    });

    expect(status).toBe(200);
    expectKeys(body, REGISTRATION_CHECK_KEYS, "check response");
    expect(body.push_access).toBe(true);
    expect(body.needs_scope).toBe(false);
    // Access is granted, so there is nothing to explain.
    expect(body.reason).toBeNull();

    expectKeys(body.repo, REPO_FACTS_KEYS, "check response repo");
    expect(body.repo.full_name).toBe("acme/fin-http");
    expect(body.repo.description).toBe("An HTTP client");
    expect(body.repo.homepage).toBe("https://acme.example/fin-http");
    expect(body.repo.license).toBe("Apache-2.0");
    expect(body.repo.default_branch).toBe("trunk");
  });

  it("asks GitHub with the signed-in user's own token", async () => {
    const session = await signIn();
    const calls = stubRepo(githubRepo());

    await apiPost("/api/registrations/check", {
      token: session.token,
      body: { repo_url: REPO_URL },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/fin-http");
    // Header names are lower-cased by `Headers`.
    expect(calls[0].headers.authorization).toContain("gho_session_token");
  });

  /**
   * Signing in asks for `user:email` only (ADR-0004), which cannot read
   * repository permissions. That is not a failure — it is the ordinary state of
   * a first registration, and the UI answers it by sending the user through
   * incremental authorization. So the registry must distinguish "you may not
   * push here" from "I am not yet allowed to look".
   */
  it("reports needs_scope for a session that only ever asked for user:email", async () => {
    const session = await signIn({ scope: "user:email" });
    // What GitHub returns to a token that cannot see permissions: the public
    // repository, with no `permissions` block at all.
    stubRepo(githubRepo({ permissions: undefined }));

    const { status, body } = await apiPost("/api/registrations/check", {
      token: session.token,
      body: { repo_url: REPO_URL },
    });

    expect(status).toBe(200);
    expectKeys(body, REGISTRATION_CHECK_KEYS, "check response");
    expect(body.needs_scope).toBe(true);
    expect(body.push_access).toBe(false);
    expect(typeof body.reason).toBe("string");
    expect(body.reason.length).toBeGreaterThan(0);
  });

  it("reports needs_scope when GitHub 401s the stored token", async () => {
    const session = await signIn({ scope: "user:email" });
    stubRepo({ message: "Bad credentials" }, 401);

    const { status, body } = await apiPost("/api/registrations/check", {
      token: session.token,
      body: { repo_url: REPO_URL },
    });

    expect(status).toBe(200);
    expect(body.needs_scope).toBe(true);
    expect(body.push_access).toBe(false);
  });

  /**
   * Read access is not push access (§2.2). The reason has to be readable by the
   * human staring at `/new`, because it is the only thing that tells them the
   * registration cannot proceed and why — a bare `false` is a dead end.
   */
  it("refuses read-only access with a human-readable reason", async () => {
    const session = await signIn({ scope: "user:email,repo" });
    stubRepo(
      githubRepo({
        permissions: { admin: false, maintain: false, push: false, pull: true },
      }),
    );

    const { status, body } = await apiPost("/api/registrations/check", {
      token: session.token,
      body: { repo_url: REPO_URL },
    });

    expect(status).toBe(200);
    expect(body.push_access).toBe(false);
    // The grant is wide enough; the answer really is "no".
    expect(body.needs_scope).toBe(false);
    expect(typeof body.reason).toBe("string");
    expect(body.reason).toMatch(/push/i);
    expect(body.reason.length).toBeGreaterThan(20);
  });

  it("rejects a missing repo_url", async () => {
    const session = await signIn();
    const calls = stubRepo(githubRepo());

    const { status, body } = await apiPost("/api/registrations/check", {
      token: session.token,
      body: {},
    });

    expect(status).toBe(400);
    expectErrorEnvelope(body);
    expect(calls).toHaveLength(0);
  });

  it("rejects a repo_url that is not a GitHub repository", async () => {
    const session = await signIn();
    const calls = stubRepo(githubRepo());

    const { status, body } = await apiPost("/api/registrations/check", {
      token: session.token,
      body: { repo_url: "https://gitlab.com/acme/fin-http" },
    });

    expect(status).toBe(400);
    expectErrorEnvelope(body);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/packages", () => {
  const validBody = {
    name: "http",
    repo_url: REPO_URL,
    description: "An HTTP client and server for Fin",
    homepage: null,
    license: "MIT",
  };

  it("401s without a session", async () => {
    stubRepo(githubRepo());

    const { status, body } = await apiPost("/api/packages", { body: validBody });

    expect(status).toBe(401);
    expectErrorEnvelope(body);
    expect((await apiGet("/api/packages/http")).status).toBe(404);
  });

  it("creates the package and answers 201 with the §3.2 record", async () => {
    const session = await signIn({ login: "acme" });
    stubRepo(githubRepo());

    const { status, body } = await apiPost("/api/packages", {
      token: session.token,
      body: validBody,
    });

    expect(status).toBe(201);
    expectKeys(body, PACKAGE_KEYS, "created record");
    expect(body.name).toBe("http");
    expect(body.repo_url).toBe(REPO_URL);
    expect(body.description).toBe("An HTTP client and server for Fin");
    expect(body.publisher.login).toBe("acme");
    expect(body.is_deprecated).toBe(false);
    expect(Array.isArray(body.keywords)).toBe(true);
    // A brand-new registration is the strongest case for publishing no counter:
    // there is nothing to count yet, and `downloads: 0` would be the registry's
    // first statement about the package.
    expectNoCounters(body, "created record");
  });

  it("makes the new name resolvable at §3.2 straight away", async () => {
    const session = await signIn();
    stubRepo(githubRepo());

    await apiPost("/api/packages", { token: session.token, body: validBody });

    const { status, body } = await apiGet("/api/packages/http");

    expect(status).toBe(200);
    expect(body.name).toBe("http");
  });

  /**
   * A fresh registration has no releases. `latest_version` is therefore null,
   * and specifically not `1.0.0`: a fabricated version is worse than a missing
   * one, because `finn` would resolve it, fail to find the tag, and blame the
   * publisher's repository.
   */
  it("reports latest_version null on a fresh registration", async () => {
    const session = await signIn();
    stubRepo(githubRepo());

    const { status, body, text } = await apiPost("/api/packages", {
      token: session.token,
      body: validBody,
    });

    expect(status).toBe(201);
    expect(body.latest_version).toBeNull();
    expect(text).not.toContain("1.0.0");

    // And it stays null when read back.
    const record = await apiGet("/api/packages/http");
    expect(record.body.latest_version).toBeNull();
    expect(record.text).not.toContain("1.0.0");

    const versions = await apiGet("/api/packages/http/versions");
    expect(versions.body).toEqual({ name: "http", versions: [] });
  });

  /**
   * Trust at creation can only be `recognized` or `verified`. `trusted` means a
   * moderator vouched for this specific package (§2.3), which cannot have
   * happened to a package that did not exist a moment ago — if registration can
   * mint it, the level means nothing.
   */
  it("registers an unverified publisher's package as recognized, never trusted", async () => {
    const session = await signIn({ is_verified: false });
    stubRepo(githubRepo());

    const { status, body } = await apiPost("/api/packages", {
      token: session.token,
      body: validBody,
    });

    expect(status).toBe(201);
    expect(body.trust.level).toBe("recognized");
    expect(body.trust.level).not.toBe("trusted");
    expect(body.trust.package_trusted).toBe(false);
    expect(body.trust.publisher_verified).toBe(false);
    // §2.2: the row exists because push access was proven.
    expect(body.trust.repo_ownership_confirmed).toBe(true);
  });

  it("registers a verified publisher's package as verified, never trusted", async () => {
    const session = await signIn({ is_verified: true });
    stubRepo(githubRepo());

    const { status, body } = await apiPost("/api/packages", {
      token: session.token,
      body: validBody,
    });

    expect(status).toBe(201);
    expect(body.trust.level).toBe("verified");
    expect(body.trust.package_trusted).toBe(false);
  });

  /**
   * `license` is a fact about the repository, and "GitHub reports none" is a
   * real answer. Defaulting to MIT would publish a licence claim about someone
   * else's code that nobody made.
   */
  it("reports license null when GitHub reports no license", async () => {
    const session = await signIn();
    stubRepo(githubRepo({ license: null }));

    const { status, body } = await apiPost("/api/packages", {
      token: session.token,
      body: { ...validBody, license: null },
    });

    expect(status).toBe(201);
    expect(body.license).toBeNull();
    expect(body.license).not.toBe("MIT");
  });

  it("reports license null when GitHub reports NOASSERTION", async () => {
    const session = await signIn();
    stubRepo(githubRepo({ license: { spdx_id: "NOASSERTION" } }));

    const { status, body } = await apiPost("/api/packages", {
      token: session.token,
      body: { ...validBody, license: null },
    });

    expect(status).toBe(201);
    expect(body.license).toBeNull();
  });

  it("409s a name that is already registered", async () => {
    const existing = await seedPublisher({ login: "someone-else" });
    await seedPackage({ name: "http", publisher: existing });

    const session = await signIn();
    stubRepo(githubRepo());

    const { status, body } = await apiPost("/api/packages", {
      token: session.token,
      body: validBody,
    });

    expect(status).toBe(409);
    expect(body.error).toBe("name_taken");
    expectErrorEnvelope(body);

    // The incumbent is untouched.
    const record = await apiGet("/api/packages/http");
    expect(record.body.publisher.login).toBe("someone-else");
  });

  /**
   * Re-checks push access server-side; never trusts the check call (§3.10).
   *
   * The check endpoint is a UI convenience, not an authorization. A client can
   * skip it, lie about it, or call it against a repository it does control and
   * then register a different one — so the only check that counts is the one
   * this handler makes itself.
   */
  it("asks GitHub again at registration, even after a passing check", async () => {
    const session = await signIn();
    const calls = stubRepo(githubRepo());

    await apiPost("/api/registrations/check", {
      token: session.token,
      body: { repo_url: REPO_URL },
    });
    const callsAfterCheck = calls.length;

    const { status } = await apiPost("/api/packages", {
      token: session.token,
      body: validBody,
    });

    expect(status).toBe(201);
    expect(calls.length).toBeGreaterThan(callsAfterCheck);
  });

  it("refuses to register a repository the user cannot push to", async () => {
    const session = await signIn();
    stubRepo(
      githubRepo({ permissions: { admin: false, maintain: false, push: false, pull: true } }),
    );

    const { status, body } = await apiPost("/api/packages", {
      token: session.token,
      body: validBody,
    });

    expect(status).toBe(403);
    expectErrorEnvelope(body);
    // Nothing was claimed.
    expect((await apiGet("/api/packages/http")).status).toBe(404);
  });

  // --- the name grammar, enforced server-side --------------------------------

  /**
   * §2.1, as narrowed by the owner on 2026-08-24: `^[a-z][a-z0-9]*$`, 2 to 64
   * characters, and not one of Fin's reserved words.
   *
   * Enforced here rather than only in the browser, because these endpoints are
   * reachable with a cookie and `curl`, and because a name that escapes the
   * grammar is unfixable after the fact — `finn.toml` files in the wild will
   * already refer to it.
   *
   * **The hyphen case below used to assert the opposite.** `fin-http` was a
   * legal name until the rule narrowed, and it is inverted here rather than
   * deleted so that the reversal is visible in the diff instead of looking like
   * a case somebody forgot to write.
   */
  const invalidNames: Array<[string, string]> = [
    ["Http", "uppercase"],
    ["fin_http", "underscore"],
    ["fin.http", "dot"],
    ["@acme/http", "scoped like npm"],
    ["1http", "leading digit"],
    ["-http", "leading hyphen"],
    ["http-", "trailing hyphen"],
    ["fin--http", "doubled hyphen"],
    ["fin-http", "interior hyphen — legal until 2026-08-24, refused since"],
    ["x-2-y", "interior hyphens between digits"],
    ["fin http", "space"],
    [" http", "leading whitespace"],
    ["http ", "trailing whitespace"],
    ["h", "shorter than 2 characters"],
    ["a".repeat(65), "longer than 64 characters"],
    ["", "empty"],
  ];

  it.each(invalidNames)("rejects the name %j (%s)", async (name) => {
    const session = await signIn();
    stubRepo(githubRepo());

    const { status, body } = await apiPost("/api/packages", {
      token: session.token,
      body: { ...validBody, name },
    });

    expect(status).toBe(400);
    expectErrorEnvelope(body);
    expect(body.name).toBeUndefined();
  });

  /**
   * The denylist, sampled rather than exhausted.
   *
   * One word from each shape it can take: a control keyword, a type name, a
   * boolean literal, a two-letter word that is easy to think of as too small to
   * matter, and `m1778` — Fin's "not implemented" expression, and the one entry
   * `finn`'s `FIN_KEYWORDS` does not carry. The whole set is asserted below by
   * iterating the exported constant, which is what makes this list a sample and
   * not a specification.
   */
  it.each(["let", "type", "string", "true", "as", "m1778"])(
    "refuses %j, which is a reserved word in Fin",
    async (name) => {
      const session = await signIn();
      stubRepo(githubRepo());

      const { status, body } = await apiPost("/api/packages", {
        token: session.token,
        body: { ...validBody, name },
      });

      expect(status).toBe(400);
      expectErrorEnvelope(body);
      expect(body.message).toContain("reserved word");
      expect((await apiGet(`/api/packages/${name}`)).status).toBe(404);
    },
  );

  /**
   * Every reserved word, through the real endpoint's validator.
   *
   * Asserted against `validatePackageName` rather than by 58 HTTP round trips:
   * the sample above proves the endpoint calls it, and this proves the endpoint
   * would refuse every member of the set. Each word is also checked to satisfy
   * the grammar — a denylist entry that could not be spelled as a name in the
   * first place (`Self`, `as_ptr`) is dead weight and hides a transcription
   * error behind a test that passes anyway.
   */
  it("refuses every word in the reserved set, and reserves nothing unspellable", () => {
    expect(FIN_RESERVED_WORDS.size).toBeGreaterThan(0);

    for (const word of FIN_RESERVED_WORDS) {
      expect(NAME_RULE.test(word), `${word} could not be a name anyway`).toBe(true);
      expect(word.length, `${word} is outside the length bounds`).toBeGreaterThanOrEqual(2);
      expect(validatePackageName(word), `${word} was not refused`).toContain("reserved word");
    }
  });

  /**
   * The words the narrowing deliberately did **not** reserve.
   *
   * `import { A, B } from "<name>";` takes the path as a string literal, which
   * never lexes as a keyword, so a name colliding with a *future* Fin keyword
   * loses its other import forms and keeps that one — a degradation, not a
   * break. Reserving plausible futures would spend these names permanently to
   * prevent it. This test is here so that adding one is a deliberate act.
   */
  it.each(["select", "union", "assert", "some", "none", "with", "go", "match", "await"])(
    "does not reserve %j, which Fin does not have today",
    (name) => {
      expect(FIN_RESERVED_WORDS.has(name)).toBe(false);
      expect(validatePackageName(name)).toBeNull();
    },
  );

  it.each(["ht", "http", "a1", "a".repeat(64), "x2y", "httpclient"])(
    "accepts the valid name %j",
    async (name) => {
      const session = await signIn();
      stubRepo(githubRepo());

      const { status } = await apiPost("/api/packages", {
        token: session.token,
        body: { ...validBody, name },
      });

      expect(status).toBe(201);
    },
  );
});
