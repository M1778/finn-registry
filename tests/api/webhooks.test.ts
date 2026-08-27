/**
 * `POST /api/webhooks/github` — the GitHub App's delivery endpoint, and the only
 * writer of version records anywhere in the registry (ADR-0007).
 *
 * Not a §3 endpoint. `finn` never calls it, no session stands behind it and no
 * proof of work gates it: its one caller is GitHub and its one credential is the
 * HMAC over the delivery body. So the two things worth most of the coverage here
 * are (a) that a forged or altered delivery writes nothing at all, and (b) that a
 * genuine one becomes a record the §3.3 and §3.4 endpoints serve — which is what
 * turns `latest_version: null` into a version for the first time.
 *
 * Deliveries are signed with `node:crypto` in the harness, deliberately a
 * different implementation from the WebCrypto the route verifies with, so a test
 * cannot agree with the code by sharing its arithmetic.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WEBHOOK_SECRET,
  apiGet,
  apiWebhook,
  pushPayload,
  seedPackage,
  seedPublisher,
  type SeededPackage,
} from "../setup";
import { expectErrorEnvelope, expectKeys, expectSnakeCase, VERSION_KEYS } from "../contract";

const REPO_URL = "https://github.com/acme/fin-http";
const REPO_ID = 4242;

/** A registered name whose repository the default `pushPayload()` comes from. */
async function registered(
  overrides: { name?: string; repo_url?: string; github_repo_id?: number | null } = {},
): Promise<SeededPackage> {
  return seedPackage({
    name: overrides.name ?? "fin-http",
    repo_url: overrides.repo_url ?? REPO_URL,
    github_repo_id: overrides.github_repo_id === undefined ? REPO_ID : overrides.github_repo_id,
    publisher: await seedPublisher({ login: "acme" }),
  });
}

/** The §3.3 listing, which is where a written record has to become visible. */
async function versionsOf(name: string): Promise<any[]> {
  const res = await apiGet(`/api/packages/${name}/versions`);
  expect(res.status, `GET /api/packages/${name}/versions`).toBe(200);
  return res.body.versions;
}

describe("POST /api/webhooks/github — recording a version", () => {
  it("turns a tag push into a version record the CLI endpoints serve", async () => {
    await registered();
    const payload = pushPayload();

    const res = await apiWebhook({ payload });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("recorded");
    expect(res.body.recorded).toEqual(["fin-http"]);
    expect(res.body.already_recorded).toEqual([]);
    expectSnakeCase(res.body, "webhook response");

    // The point of the whole exercise: `latest_version` was null for every
    // package in the register because nothing had ever written a version record.
    const pkg = await apiGet("/api/packages/fin-http");
    expect(pkg.status).toBe(200);
    expect(pkg.body.latest_version).toBe("1.2.0");

    const listed = await versionsOf("fin-http");
    expect(listed).toHaveLength(1);
    expectKeys(listed[0], VERSION_KEYS, "recorded version");
  });

  it("stores the tag as git_ref and the version without its v", async () => {
    await registered();
    const payload = pushPayload({ ref: "refs/tags/v1.2.0" });

    await apiWebhook({ payload });

    const record = await apiGet("/api/packages/fin-http/versions/1.2.0");
    expect(record.status, JSON.stringify(record.body)).toBe(200);
    const body = record.body;
    // The version is the coordinate `finn` compares and pins; the tag is
    // provenance (§2.11). Publishing "v1.2.0" as the version would make every
    // semver comparison in the registry a string comparison.
    expect(body.version).toBe("1.2.0");
    expect(body.git_ref).toBe("v1.2.0");
    expect(body.yanked).toBe(false);
    // Nobody attested anything, so nothing is attested. The App never sees the
    // bytes (ADR-0001), so this path cannot fill these in and does not pretend to.
    expect(body.checksum).toBeNull();
    expect(body.checksum_origin).toBeNull();
  });

  it("records a bare semver tag too", async () => {
    await registered();

    const res = await apiWebhook({ payload: pushPayload({ ref: "refs/tags/2.0.0" }) });

    expect(res.status).toBe(201);
    const record = await apiGet("/api/packages/fin-http/versions/2.0.0");
    expect(record.status).toBe(200);
    expect(record.body.git_ref).toBe("2.0.0");
  });

  it("takes the commit from head_commit and not from after", async () => {
    await registered();
    // What GitHub sends for an *annotated* tag: `after` is the tag object's sha,
    // which no checkout resolves to a tree. Recording it would make §2.11's
    // "commit disagrees with the tag" signal fire on every annotated release.
    const tagObject = "1111111111111111111111111111111111111111";
    const realCommit = "2222222222222222222222222222222222222222";
    const payload = pushPayload({ after: tagObject, head_commit: { id: realCommit } });

    const res = await apiWebhook({ payload });

    expect(res.status).toBe(201);
    expect(res.body.commit).toBe(realCommit);
    const record = await apiGet("/api/packages/fin-http/versions/1.2.0");
    expect(record.body.commit).toBe(realCommit);
    expect(record.body.commit).not.toBe(tagObject);
  });

  it("writes one record per registered name pointing at the repository", async () => {
    const publisher = await seedPublisher({ login: "acme" });
    await seedPackage({ name: "fin-http", repo_url: REPO_URL, github_repo_id: REPO_ID, publisher });
    await seedPackage({ name: "fin-http-alt", repo_url: REPO_URL, github_repo_id: REPO_ID, publisher });

    const res = await apiWebhook({ payload: pushPayload() });

    expect(res.status).toBe(201);
    expect(res.body.recorded.sort()).toEqual(["fin-http", "fin-http-alt"]);
    expect(await versionsOf("fin-http")).toHaveLength(1);
    expect(await versionsOf("fin-http-alt")).toHaveLength(1);
  });
});

describe("POST /api/webhooks/github — authenticating the delivery", () => {
  it("refuses a delivery signed with the wrong secret and writes nothing", async () => {
    await registered();

    const res = await apiWebhook({ payload: pushPayload(), secret: "a-forgers-secret-value" });

    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body);
    expect(res.body.error).toBe("invalid_signature");
    expect(await versionsOf("fin-http")).toEqual([]);
  });

  it("refuses a delivery with no signature at all", async () => {
    await registered();

    const res = await apiWebhook({ payload: pushPayload(), signature: null });

    expect(res.status).toBe(401);
    expect(await versionsOf("fin-http")).toEqual([]);
  });

  it("does not accept GitHub's SHA-1 header in place of SHA-256", async () => {
    await registered();
    const body = JSON.stringify(pushPayload());
    const sha1 = createHmac("sha1", WEBHOOK_SECRET).update(body).digest("hex");

    // A correct SHA-1 signature over the right body with the right secret. It is
    // refused anyway: honouring it would hand an attacker a downgrade.
    const res = await apiWebhook({
      rawBody: body,
      signature: null,
      headers: { "X-Hub-Signature": `sha1=${sha1}` },
    });

    expect(res.status).toBe(401);
    expect(await versionsOf("fin-http")).toEqual([]);
  });

  it("refuses a body altered after it was signed", async () => {
    await registered();
    const signed = pushPayload();
    // Signed one document, delivered another. This is why the route verifies the
    // raw text and parses only what verified: verifying a re-serialized parse
    // would make these two interchangeable.
    const delivered = JSON.stringify(pushPayload({ ref: "refs/tags/v9.9.9" }));

    const res = await apiWebhook({
      rawBody: delivered,
      signature: `sha256=${createHmac("sha256", WEBHOOK_SECRET)
        .update(JSON.stringify(signed))
        .digest("hex")}`,
    });

    expect(res.status).toBe(401);
    expect(await versionsOf("fin-http")).toEqual([]);
  });

  it("verifies the bytes as delivered, not a re-serialization of them", async () => {
    await registered();
    // Byte-for-byte the same document, spelled with the whitespace GitHub is free
    // to send. `JSON.parse` followed by `JSON.stringify` would drop it, and the
    // HMAC would then be taken over a document nobody delivered — so a route that
    // verified a re-serialized parse would refuse this genuine delivery.
    const pretty = JSON.stringify(pushPayload(), null, 2);
    expect(pretty).not.toBe(JSON.stringify(pushPayload()));

    const res = await apiWebhook({ rawBody: pretty });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.recorded).toEqual(["fin-http"]);
  });

  it("refuses a signature that is not sha256-prefixed hex", async () => {
    await registered();

    const res = await apiWebhook({ payload: pushPayload(), signature: "not-a-signature" });

    expect(res.status).toBe(401);
    expect(await versionsOf("fin-http")).toEqual([]);
  });

  it("refuses every delivery with a 503 that names the variable when the secret is unset", async () => {
    await registered();
    const configured = process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;

    try {
      const res = await apiWebhook({ payload: pushPayload() });

      // 503 and not 500: the registry is fine, it is unconfigured, and the
      // message has to say which variable so an operator is not left guessing.
      expect(res.status).toBe(503);
      expectErrorEnvelope(res.body);
      expect(res.body.error).toBe("webhook_unconfigured");
      expect(res.body.message).toContain("GITHUB_WEBHOOK_SECRET");
      expect(await versionsOf("fin-http")).toEqual([]);
    } finally {
      process.env.GITHUB_WEBHOOK_SECRET = configured;
    }
  });

  it("rejects a signed body that is not JSON with a 400", async () => {
    await registered();

    const res = await apiWebhook({ rawBody: "not json at all" });

    // The one push that gets a 4xx: signed and still unreadable is a defect in
    // the request, not a decision about it.
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body);
  });
});

describe("POST /api/webhooks/github — authorising the delivery", () => {
  it("writes nothing for a repository no registered name points at", async () => {
    await registered({ repo_url: "https://github.com/acme/something-else", github_repo_id: 777 });

    const res = await apiWebhook({ payload: pushPayload() });

    // 200, not 404. One App serves every installation from one URL, so a refusal
    // that GitHub counts as a failed delivery is a step towards the hook being
    // disabled for every publisher.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(typeof res.body.reason).toBe("string");
    expect(await versionsOf("fin-http")).toEqual([]);
  });

  it("refuses a URL match when the recorded repository id disagrees", async () => {
    // The hijack this column exists to stop: the original repository was renamed
    // or transferred, somebody else claimed the freed `acme/fin-http`, and their
    // App now delivers tag pushes that match the stored URL exactly.
    await registered({ github_repo_id: 4242 });

    const res = await apiWebhook({
      payload: pushPayload({ repository: { id: 99999, full_name: "acme/fin-http" } }),
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(await versionsOf("fin-http")).toEqual([]);
  });

  it("falls back to the URL for a name registered before ids were recorded", async () => {
    await registered({ github_repo_id: null });

    const res = await apiWebhook({ payload: pushPayload() });

    expect(res.status).toBe(201);
    expect(res.body.recorded).toEqual(["fin-http"]);
  });

  it("matches the repository URL without regard to case", async () => {
    // `repo_url` carries whatever the registrant typed; GitHub's `full_name`
    // carries the repository's real casing. SQLite's `=` on text does not agree
    // with GitHub's comparison, and the registrant is not at fault for that.
    await registered({ repo_url: "https://github.com/Acme/Fin-HTTP", github_repo_id: null });

    const res = await apiWebhook({
      payload: pushPayload({ repository: { id: REPO_ID, full_name: "acme/fin-http" } }),
    });

    expect(res.status).toBe(201);
    expect(res.body.recorded).toEqual(["fin-http"]);
  });
});

describe("POST /api/webhooks/github — deliveries that record nothing", () => {
  it("ignores a branch push", async () => {
    await registered();

    const res = await apiWebhook({
      payload: pushPayload({ ref: "refs/heads/main", created: false }),
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(await versionsOf("fin-http")).toEqual([]);
  });

  it("ignores a tag deletion, because a version record is never deleted", async () => {
    const pkg = await registered();
    await apiWebhook({ payload: pushPayload() });
    expect(await versionsOf(pkg.name)).toHaveLength(1);

    const res = await apiWebhook({
      payload: pushPayload({ deleted: true, created: false, head_commit: null }),
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    // The *reason*, not just the outcome. GitHub's deletion payload also carries
    // `head_commit: null`, so a receiver with no deletion check at all would still
    // ignore this delivery — for the wrong reason, and it would record the next
    // deletion that arrived with a head commit. Asserting which check fired is
    // what makes this test able to fail.
    expect(res.body.reason).toMatch(/deleted/i);
    // §2.11: the only lever over a published version is `yanked`, which is a
    // moderation act with a minute against it — not `git push --delete`.
    const listed = await versionsOf(pkg.name);
    expect(listed).toHaveLength(1);
    expect(listed[0].yanked).toBe(false);
  });

  it("ignores a tag that does not name a version", async () => {
    await registered();

    for (const ref of ["refs/tags/nightly", "refs/tags/v1", "refs/tags/2026-08-27", "refs/tags/release-1.0.0"]) {
      const res = await apiWebhook({ payload: pushPayload({ ref }) });
      expect(res.status, ref).toBe(200);
      expect(res.body.status, ref).toBe("ignored");
    }

    expect(await versionsOf("fin-http")).toEqual([]);
  });

  it("ignores a range or a prerelease-shaped tag it cannot pin", async () => {
    await registered();

    const res = await apiWebhook({ payload: pushPayload({ ref: "refs/tags/v^1.2.0" }) });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
  });

  it("records a prerelease, which is an exact version", async () => {
    await registered();

    const res = await apiWebhook({ payload: pushPayload({ ref: "refs/tags/v1.3.0-rc.1" }) });

    expect(res.status).toBe(201);
    const record = await apiGet("/api/packages/fin-http/versions/1.3.0-rc.1");
    expect(record.status).toBe(200);
    expect(record.body.git_ref).toBe("v1.3.0-rc.1");
    // Whether a prerelease may *be* `latest_version` is `latestVersionOf`'s
    // policy, not the receiver's, so this file does not pin it. The receiver's
    // job is that an exact version becomes a record at all.
  });

  it("answers a ping and writes nothing", async () => {
    await registered();

    const res = await apiWebhook({ event: "ping", payload: { zen: "Keep it logically awesome." } });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(await versionsOf("fin-http")).toEqual([]);
  });

  it("ignores an event that is not a push", async () => {
    await registered();

    const res = await apiWebhook({ event: "installation_repositories", payload: {} });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(await versionsOf("fin-http")).toEqual([]);
  });

  it("ignores a tag push carrying no head commit", async () => {
    await registered();

    const res = await apiWebhook({ payload: pushPayload({ head_commit: null }) });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(await versionsOf("fin-http")).toEqual([]);
  });
});

describe("POST /api/webhooks/github — immutability (§2.11)", () => {
  it("reports a re-delivery as already recorded rather than as an error", async () => {
    await registered();
    const payload = pushPayload();

    const first = await apiWebhook({ payload });
    const second = await apiWebhook({ payload });

    expect(first.status).toBe(201);
    // GitHub retries deliveries. A 4xx or 5xx on the second one would make it keep
    // retrying, and eventually disable the hook for every installation.
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("already_recorded");
    expect(second.body.already_recorded).toEqual(["fin-http"]);
    expect(second.body.recorded).toEqual([]);
    expect(await versionsOf("fin-http")).toHaveLength(1);
  });

  it("keeps the original commit when a tag is force-pushed to a new one", async () => {
    await registered();
    const original = "3333333333333333333333333333333333333333";
    const moved = "4444444444444444444444444444444444444444";

    await apiWebhook({ payload: pushPayload({ head_commit: { id: original } }) });
    const res = await apiWebhook({
      payload: pushPayload({ head_commit: { id: moved }, created: false, forced: true }),
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("already_recorded");
    // The record becomes evidence of the discrepancy, which is what §2.11 asks
    // for. An update would destroy the only copy of that evidence.
    const record = await apiGet("/api/packages/fin-http/versions/1.2.0");
    expect(record.body.commit).toBe(original);
  });
});
