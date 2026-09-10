/**
 * Permanent regression: the registry never claims ownership it did not prove.
 *
 * `trust.repo_ownership_confirmed` is `true` on every response, and it comes from
 * a constant rather than a column. That is only honest while the premise behind
 * it holds — every row in `packages` reached the table through a statement that
 * refused it without proven push access (ADR-0004). If a future path ever
 * inserts a row without that proof, the constant becomes a fabricated claim on
 * those rows, and `src/lib/trust.ts` promotes it to `verified` for any verified
 * publisher. This is the same class of defect as the fabricated `1.0.0` in
 * `no-fabricated-version.test.ts`: a fact published without the state to back it.
 *
 * Three separate things are pinned here, because the claim needs all three:
 *
 *  1. **Behaviour** — for every answer GitHub can give that is not proven push
 *     access, the register comes out with no row. Asserted by a genuine 404 on
 *     the name and an empty listing, never by the refusal status alone: a 403 is
 *     evidence the request was rejected, not evidence nothing was written.
 *
 *  2. **Structure** — there is exactly one statement in the tree that inserts
 *     into `packages`, and the push-access proof and its refusal both come before
 *     it in the same handler. This is the arm that catches the *next* insert
 *     someone adds, which no behavioural test can reach because it does not exist
 *     yet.
 *
 *  3. **Agreement** — every surface that publishes a trust level for a real row
 *     reads the one definition of the signal, so they cannot drift apart. Before
 *     this file, four sites wrote the literal independently.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
// The ladder and the constant are imported, never restated. A test carrying its
// own copy of either would keep passing after the real one changed, which is the
// exact failure this file exists to prevent.
import { deriveTrustLevel, REPO_OWNERSHIP_CONFIRMED, type TrustLevel } from "@/lib/trust";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_URL = "https://github.com/acme/fin-http";
const NAME = "http";

// ---------------------------------------------------------------------------
// 1. Behaviour: no proof, no row
// ---------------------------------------------------------------------------

async function signIn(options: { is_verified?: boolean } = {}): Promise<SeededSession> {
  const publisher = await seedPublisher({
    login: "acme",
    is_verified: options.is_verified ?? false,
  });

  return seedSession({
    publisher,
    github_access_token: "gho_session_token",
    // The wider grant, so that a refusal below is GitHub's answer about
    // permissions rather than the registry declining to ask.
    github_scope: "user:email,repo",
  });
}

function stubRepo(payload: unknown, status = 200) {
  return stubGitHub(() => jsonResponse(payload, status));
}

/**
 * Every answer GitHub can give that is not proven push access.
 *
 * The last entry is the one that is easiest to get wrong on a rewrite:
 * `checkPushAccess` compares `permissions.push === true`, and a loosened check
 * would let the string `"true"` — which is what a hand-rolled or proxied payload
 * can carry — stand in for the boolean.
 */
const WITHOUT_PROOF: Array<[name: string, stub: () => unknown]> = [
  [
    "read access but not push",
    () => stubRepo(githubRepo({ permissions: { admin: false, maintain: false, push: false, pull: true } })),
  ],
  [
    "no permissions at all",
    () => stubRepo(githubRepo({ permissions: { admin: false, maintain: false, push: false, pull: false } })),
  ],
  ["no permissions block in the payload", () => stubRepo(githubRepo({ permissions: undefined }))],
  ["the stored token is rejected", () => stubRepo({ message: "Bad credentials" }, 401)],
  ["no such repository, or invisible", () => stubRepo({ message: "Not Found" }, 404)],
  ["the organisation blocks third-party access", () => stubRepo({ message: "Forbidden" }, 403)],
  ["GitHub itself is broken", () => stubRepo({ message: "Server Error" }, 500)],
  [
    "GitHub cannot be reached",
    () =>
      stubGitHub(() => {
        throw new Error("ECONNREFUSED");
      }),
  ],
  ["push reported as the string \"true\"", () => stubRepo(githubRepo({ permissions: { push: "true" } }))],
];

/**
 * The register holds no package by that name.
 *
 * A 404 specifically, and never a 5xx: an error means the question could not be
 * answered, which is not the same as an answer of "no". Accepting a 5xx here
 * would let a handler that throws on every read masquerade as proof of absence.
 */
async function expectNotRegistered(name: string, because: string) {
  const resolved = await apiGet(`/api/packages/${name}`);
  expect(resolved.status, `${because}: expected a genuine 404, got ${resolved.status}`).toBe(404);

  const listed = await apiGet("/api/packages");
  expect(listed.status, `${because}: the listing itself failed`).toBe(200);
  expect(listed.body.total, `${because}: the register is not empty`).toBe(0);
  expect(listed.body.items, `${because}: the register is not empty`).toEqual([]);
}

describe("a package row never exists without proven push access", () => {
  it.each(WITHOUT_PROOF)("registration is refused and writes nothing: %s", async (label, stub) => {
    const session = await signIn();
    stub();

    const { status } = await apiPost("/api/packages", {
      token: session.token,
      body: { name: NAME, repo_url: REPO_URL },
    });

    expect(status, `${label}: registration was accepted`).not.toBe(201);
    await expectNotRegistered(NAME, label);
  });

  /**
   * The control for all nine cases above. Every one of them is a negative, and a
   * negative passes just as happily when the endpoint is unreachable, the session
   * helper is broken, or the captcha refuses every request — in which case the
   * suite above proves nothing at all. This proves the same call *does* create a
   * row when GitHub does report push access, and that the row publishes the
   * signal.
   */
  it("does register, and does publish the signal, when push access is proven", async () => {
    const session = await signIn();
    stubRepo(githubRepo());

    const created = await apiPost("/api/packages", {
      token: session.token,
      body: { name: NAME, repo_url: REPO_URL },
    });

    expect(created.status).toBe(201);
    expect(created.body.trust.repo_ownership_confirmed).toBe(REPO_OWNERSHIP_CONFIRMED);

    const resolved = await apiGet(`/api/packages/${NAME}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body.trust.repo_ownership_confirmed).toBe(REPO_OWNERSHIP_CONFIRMED);
  });

  /**
   * `admin` and `maintain` are push access too, and a rewrite that narrowed the
   * check to `push` alone would lock out repository owners whose permission set
   * GitHub reports without the `push` flag.
   */
  it.each([
    ["admin", { admin: true, maintain: false, push: false, pull: true }],
    ["maintain", { admin: false, maintain: true, push: false, pull: true }],
  ])("accepts %s permission as proof", async (_label, permissions) => {
    const session = await signIn();
    stubRepo(githubRepo({ permissions }));

    const { status } = await apiPost("/api/packages", {
      token: session.token,
      body: { name: NAME, repo_url: REPO_URL },
    });

    expect(status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// 2. Structure: one insert, and the proof comes first
// ---------------------------------------------------------------------------

/** Every source file under the given repo-relative directories. */
function sourceFiles(dirs: string[], extensions: string[]): string[] {
  const found: string[] = [];

  const walk = (absolute: string) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const next = join(absolute, entry.name);
      if (entry.isDirectory()) {
        walk(next);
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(relative(repoRoot, next));
      }
    }
  };

  for (const dir of dirs) walk(join(repoRoot, dir));
  return found.sort();
}

/**
 * Any statement that could put a row in `packages`: the Drizzle builder in either
 * of its spellings, and raw SQL.
 *
 * Deliberately broader than what the tree contains today. The point is to catch
 * the second insert, whatever it is named, not to describe the first one.
 */
const INSERTS_A_PACKAGE = /insert\s*\(\s*(?:[\w.]+\.)?packages\s*[,)]|insert\s+into\s+["'`]?packages/gi;

const SHIPPED_SOURCE = ["src", "scripts", "drizzle"];

describe("exactly one statement can create a package row", () => {
  /**
   * The scan's own control. Every assertion below counts regex matches over files
   * this test located itself, so a wrong root or a broken walk would report zero
   * matches and pass. This fails first if the walk is not actually reading the
   * tree.
   */
  it("reads a source tree that is really there", () => {
    const files = sourceFiles(SHIPPED_SOURCE, [".ts", ".tsx", ".mjs", ".sql"]);

    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("src/app/api/[[...route]]/router.ts");
    expect(files).toContain("src/lib/trust.ts");
    expect(files).toContain("scripts/build-fallback-index.mjs");

    // And the pattern below can see an insert when there is one to see.
    const migration = fs.readFileSync(join(repoRoot, "drizzle/0000_registry_schema.sql"), "utf8");
    expect(migration).toContain("CREATE TABLE `packages`");
    expect("insert into packages (name) values (?)".match(INSERTS_A_PACKAGE)).toHaveLength(1);
  });

  it("is written once, in the registration handler", () => {
    const sites: string[] = [];

    for (const file of sourceFiles(SHIPPED_SOURCE, [".ts", ".tsx", ".mjs", ".sql"])) {
      const matches = fs.readFileSync(join(repoRoot, file), "utf8").match(INSERTS_A_PACKAGE);
      for (let i = 0; i < (matches?.length ?? 0); i += 1) sites.push(file);
    }

    expect(
      sites,
      "a new path can create a package row. Prove push access before it, or " +
        "`trust.repo_ownership_confirmed` becomes a claim the register cannot back.",
    ).toEqual(["src/app/api/[[...route]]/router.ts"]);
  });

  /**
   * The arm above names `packages` literally, and that is exactly how much it can
   * see. `import { packages as pkgTable }` followed by `db.insert(pkgTable)` is a
   * second path into the table that the literal scan reports as absent — measured
   * with a planted mutant on 2026-08-25, which survived it.
   *
   * Resolving the alias would mean resolving imports, which is a type-aware pass
   * this suite has no business growing. So the question is inverted: instead of
   * asking "does any insert name `packages`", enumerate **every** insert target in
   * the tree and require the set to be one nobody has changed. An alias cannot hide
   * from that, because the alias itself is the new target.
   *
   * The cost is that adding any insert, to any table, fails this test. That is the
   * intended price: the failure is a prompt to check whether the new target can
   * reach `packages` under another name, and it is cheap to clear once it has been
   * checked.
   */
  it("has no insert target beyond the seven that exist, so an alias cannot hide one", () => {
    const INSERT_TARGET = /\.insert\(\s*([\w.]+)\s*\)/g;
    const found = new Set<string>();

    for (const file of sourceFiles(SHIPPED_SOURCE, [".ts", ".tsx", ".mjs"])) {
      const source = fs.readFileSync(join(repoRoot, file), "utf8");
      for (const match of source.matchAll(INSERT_TARGET)) found.add(`${file} -> ${match[1]}`);
    }

    // The control: this arm counts matches it found itself, so an empty result
    // would pass a set comparison against an empty allowlist. It must see the one
    // insert the rest of this file is about.
    expect(found.size).toBeGreaterThan(0);

    expect(
      [...found].sort(),
      "a new insert target appeared. If it is `packages` under another name, the " +
        "registration proof no longer guards every row and " +
        "`trust.repo_ownership_confirmed` becomes unbacked. Check it, then add it here.",
    ).toEqual([
      "src/app/admin/actions.ts -> reviewMinutes",
      "src/app/api/[[...route]]/router.ts -> logins",
      "src/app/api/[[...route]]/router.ts -> packages",
      "src/app/api/[[...route]]/router.ts -> users",
      "src/app/api/[[...route]]/router.ts -> verificationRequests",
      // Added 2026-08-27 with the GitHub App's delivery endpoint (ADR-0007), and
      // checked the way this test asks. `versions` is the versions table imported
      // under its own name, not `packages` aliased: the webhook writes a version
      // record for a package that already exists and has no branch that creates
      // one, so `trust.repo_ownership_confirmed` stays backed by the registration
      // proof. The delivery is authorised against the registered repository —
      // never against a name in its payload — so it cannot reach a row that
      // registration did not create.
      "src/app/api/[[...route]]/router.ts -> versions",
      "src/lib/security.ts -> sessions",
    ]);
  });

  it("proves and refuses push access before the row exists", () => {
    const source = fs.readFileSync(
      join(repoRoot, "src/app/api/[[...route]]/router.ts"),
      "utf8",
    );

    // The handler only, so an unrelated `checkPushAccess` elsewhere in the file
    // — `POST /registrations/check` has one — cannot satisfy this by accident.
    const start = source.indexOf('app.post("/packages"');
    expect(start, "the registration handler moved or was renamed").toBeGreaterThan(-1);
    const end = source.indexOf("\napp.", start + 1);
    expect(end, "could not find the end of the registration handler").toBeGreaterThan(start);

    const handler = source.slice(start, end);
    expect(handler.length).toBeLessThan(source.length);

    const proof = handler.indexOf("checkPushAccess(");
    const refusal = handler.indexOf("!access.pushAccess");
    const insert = handler.search(INSERTS_A_PACKAGE);

    expect(proof, "the handler does not ask GitHub about push access").toBeGreaterThan(-1);
    expect(refusal, "the handler does not branch on the answer").toBeGreaterThan(-1);
    expect(insert, "the insert is not in this handler").toBeGreaterThan(-1);

    expect(proof, "push access is checked after the row is written").toBeLessThan(insert);
    expect(refusal, "the answer is acted on after the row is written").toBeLessThan(insert);
    // A branch that does not refuse is not a gate. 403 is the status §3.10 gives.
    expect(handler.slice(refusal, insert)).toContain("403");
  });
});

// ---------------------------------------------------------------------------
// 3. Agreement: one definition, read everywhere it is published
// ---------------------------------------------------------------------------

describe("the ownership signal has one definition", () => {
  it("is declared once, in src/lib/trust.ts", () => {
    const declarations = sourceFiles(SHIPPED_SOURCE, [".ts", ".tsx"]).filter((file) =>
      /export const REPO_OWNERSHIP_CONFIRMED/.test(fs.readFileSync(join(repoRoot, file), "utf8")),
    );

    expect(declarations).toEqual(["src/lib/trust.ts"]);
  });

  /**
   * No site may hand `deriveTrustLevel` a hardcoded ownership signal. Three did,
   * independently, and a fourth restated the ladder rather than calling it — so
   * flipping the definition would have changed the API and left `/api/stats` and
   * the moderation bench publishing the old answer.
   *
   * Scoped to shipped source: `tests/trust.test.ts` passes both literals on
   * purpose, because exercising the ladder over its inputs is its whole job.
   */
  it("is never written out as a literal in shipped source", () => {
    const offenders = sourceFiles(SHIPPED_SOURCE, [".ts", ".tsx"]).filter((file) =>
      /repoOwnershipConfirmed:\s*(?:true|false)\b/.test(
        fs.readFileSync(join(repoRoot, file), "utf8"),
      ),
    );

    expect(
      offenders,
      "pass REPO_OWNERSHIP_CONFIRMED from src/lib/trust.ts, or a measured value",
    ).toEqual([]);
  });

  it.each([
    "src/app/api/[[...route]]/serializers.ts",
    "src/app/api/[[...route]]/router.ts",
    "src/app/admin/page.tsx",
  ])("%s reads the definition", (file) => {
    const source = fs.readFileSync(join(repoRoot, file), "utf8");

    expect(source).toContain("repoOwnershipConfirmed: REPO_OWNERSHIP_CONFIRMED");
    expect(source).toContain('from "@/lib/trust"');
  });

  /**
   * `scripts/build-fallback-index.mjs` publishes a trust level into the static
   * index `finn` falls back to, and it is the one place that cannot import the
   * definition — it is a Node script, and the constant is TypeScript. So it keeps
   * a copy, and the copy is pinned here rather than trusted.
   */
  it("agrees with the copy the fallback index generator has to keep", () => {
    const read = (file: string) => fs.readFileSync(join(repoRoot, file), "utf8");

    const booleanOf = (source: string, file: string): boolean => {
      const match = /REPO_OWNERSHIP_CONFIRMED(?::\s*boolean)?\s*=\s*(true|false)\s*;/.exec(source);
      expect(match, `no REPO_OWNERSHIP_CONFIRMED assignment found in ${file}`).not.toBeNull();
      return match![1] === "true";
    };

    const inTypeScript = booleanOf(read("src/lib/trust.ts"), "src/lib/trust.ts");
    const inScript = booleanOf(
      read("scripts/build-fallback-index.mjs"),
      "scripts/build-fallback-index.mjs",
    );

    // Both are read from disk, so this also catches the import being stale.
    expect(inTypeScript).toBe(REPO_OWNERSHIP_CONFIRMED);
    expect(inScript, "the fallback index publishes a different ownership signal").toBe(
      inTypeScript,
    );
  });

  /**
   * The generator's ladder is a copy for the same reason. Compared by *behaviour*
   * over all eight signal combinations rather than by text, so reformatting it is
   * free and changing what it decides is not.
   */
  it("agrees with the copy of the ladder in that generator", () => {
    const source = fs.readFileSync(join(repoRoot, "scripts/build-fallback-index.mjs"), "utf8");
    const extracted = /^function deriveTrustLevel\([\s\S]*?\n\}/m.exec(source);
    expect(extracted, "the generator's deriveTrustLevel could not be extracted").not.toBeNull();

    // The generator is plain JS and exports nothing, so evaluating its own text
    // is the only way to compare the real function rather than a restatement of
    // it. The input is a file in this repository, read from disk at test time.
    const copied = new Function(`${extracted![0]}\nreturn deriveTrustLevel;`)() as (
      signals: Parameters<typeof deriveTrustLevel>[0],
    ) => TrustLevel;

    const combinations = [false, true];
    let asserted = 0;

    for (const publisherVerified of combinations) {
      for (const packageTrusted of combinations) {
        for (const repoOwnershipConfirmed of combinations) {
          const signals = { publisherVerified, packageTrusted, repoOwnershipConfirmed };
          expect(copied(signals), `disagreed on ${JSON.stringify(signals)}`).toBe(
            deriveTrustLevel(signals),
          );
          asserted += 1;
        }
      }
    }

    expect(asserted, "the combination sweep did not run").toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 4. Agreement, observed: the surfaces cannot drift apart
// ---------------------------------------------------------------------------

/**
 * Three rows covering the three levels the register publishes. Named, not
 * ordered: nothing below asserts a sequence, so the fixtures carry no ordering
 * obligation and the `desc`-over-indexed-column tie behaviour never comes into
 * it.
 */
async function seedEveryLevel() {
  const verified = await seedPublisher({ login: "acme", is_verified: true });
  const plain = await seedPublisher({ login: "nobody", is_verified: false });

  await seedPackage({ name: "alpha", publisher: verified, package_trusted: false });
  await seedPackage({ name: "beta", publisher: plain, package_trusted: true });
  await seedPackage({ name: "gamma", publisher: plain, package_trusted: false });

  return {
    alpha: deriveTrustLevel({
      publisherVerified: true,
      packageTrusted: false,
      repoOwnershipConfirmed: REPO_OWNERSHIP_CONFIRMED,
    }),
    beta: deriveTrustLevel({
      publisherVerified: false,
      packageTrusted: true,
      repoOwnershipConfirmed: REPO_OWNERSHIP_CONFIRMED,
    }),
    gamma: deriveTrustLevel({
      publisherVerified: false,
      packageTrusted: false,
      repoOwnershipConfirmed: REPO_OWNERSHIP_CONFIRMED,
    }),
  };
}

describe("every surface publishes the same level for the same row", () => {
  /**
   * Anchors the sweep below. If the ladder ever stops distinguishing these three
   * rows, "all surfaces agree" becomes true for a trivial reason and the sweep
   * stops testing anything — so the distinctness is asserted, not assumed.
   */
  it("the three fixtures really do land on three different levels", async () => {
    const expected = await seedEveryLevel();

    expect(new Set(Object.values(expected)).size).toBe(3);
    expect(expected).toEqual({ alpha: "verified", beta: "trusted", gamma: "recognized" });
  });

  it("§3.2 resolve, §3.5 listing and /api/stats agree", async () => {
    const expected = await seedEveryLevel();

    const listing = await apiGet("/api/packages");
    expect(listing.status).toBe(200);
    const byNameInListing = new Map<string, string>(
      (listing.body.items as Array<{ name: string; trust: { level: string } }>).map((item) => [
        item.name,
        item.trust.level,
      ]),
    );

    const stats = await apiGet("/api/stats");
    expect(stats.status).toBe(200);
    const byNameInStats = new Map<string, string>(
      (stats.body.recentPackages as Array<{ name: string; trustLevel: string }>).map((entry) => [
        entry.name,
        entry.trustLevel,
      ]),
    );

    for (const [name, level] of Object.entries(expected)) {
      const resolved = await apiGet(`/api/packages/${name}`);
      expect(resolved.status).toBe(200);

      expect(resolved.body.trust.level, `§3.2 disagreed about ${name}`).toBe(level);
      expect(byNameInListing.get(name), `§3.5 disagreed about ${name}`).toBe(level);
      expect(byNameInStats.get(name), `/api/stats disagreed about ${name}`).toBe(level);

      // The signal itself, not only the level it feeds: a surface could agree on
      // the level while publishing the wrong reason for it.
      expect(resolved.body.trust.repo_ownership_confirmed).toBe(REPO_OWNERSHIP_CONFIRMED);
    }
  });

  /**
   * The consequence worth stating outright: with ownership the same for every
   * row, `verified` turns on the publisher signal alone. A verified publisher's
   * package is `verified` with no vouch; an unverified publisher's package can
   * never reach `verified`, however it is vouched for.
   */
  it("verified is decided by the publisher signal, since ownership never varies", async () => {
    const verified = await seedPublisher({ login: "acme", is_verified: true });
    const plain = await seedPublisher({ login: "nobody", is_verified: false });

    await seedPackage({ name: "alpha", publisher: verified, package_trusted: false });
    await seedPackage({ name: "beta", publisher: plain, package_trusted: true });

    expect((await apiGet("/api/packages/alpha")).body.trust.level).toBe("verified");
    expect((await apiGet("/api/packages/beta")).body.trust.level).toBe("trusted");
  });
});
