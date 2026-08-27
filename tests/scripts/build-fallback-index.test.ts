/**
 * `scripts/build-fallback-index.mjs` — the generator behind `registry/v1/packages.json`.
 *
 * That file is what `finn` reads when the live API is unreachable, so a wrong
 * entry in it is a confident wrong answer about where a package's code lives,
 * handed to a client at the one moment it has nothing to check it against. Every
 * other script in this repository can be re-run; this one publishes.
 *
 * Until now it had no test at all, and it was verified by hand each time it
 * changed. Hand-verification does not survive the next person to edit it, which
 * is the only reason this file exists.
 *
 * ---------------------------------------------------------------------------
 * WHY A SUBPROCESS, AND WHY A MIRRORED REPOSITORY ROOT
 * ---------------------------------------------------------------------------
 *
 * The generator is a program, not a module: it has no exports, it runs its work
 * at import time with a top-level `await`, and it reports through `process.exit`
 * and stdout. Importing it would run it — against whatever `DATABASE_URL` was
 * set, writing to whatever its default output path resolved to. So it is spawned,
 * and what is asserted is what a person at a terminal or a CI job actually gets:
 * the exit status, the text, and the JSON on disk.
 *
 * It is spawned from a **mirrored root**: a temp directory holding a copy of the
 * script and of the few repository files it reads. The script derives `repoRoot`
 * from its own location (`fileURLToPath(import.meta.url)`), so a copy in a temp
 * directory has every repository-relative path it computes land inside that
 * directory. Three things follow, and they are the reason for the whole
 * arrangement:
 *
 *   1. **`registry/v1/packages.json` cannot be written by this suite.** Not
 *      "is not" — cannot. The script's *default* output path is
 *      `<root>/registry/v1/packages.json`, so even a case that passes no `--out`
 *      at all writes into the temp directory. A guard that depends on every test
 *      remembering to pass a flag is a guard that one forgotten flag removes.
 *   2. The local-D1 scan in `resolveDatabase` becomes testable. It reads
 *      `<root>/.wrangler/...`, so a case can present it with one database, or
 *      two, or one plus miniflare's `metadata.sqlite`, without going anywhere
 *      near the real `.wrangler` state that `next dev` and `wrangler` share.
 *   3. A mutation case can edit the *copy*. The narrow error catch added for the
 *      unmigrated-database message has to keep a genuine SQL bug's stack trace,
 *      and the only way to produce a genuine SQL bug is to break the SQL.
 *
 * `MIRRORED` is the list of files copied in. If the generator gains another
 * repository-relative read, add it there; the failure without it names the
 * missing temp path, so it is self-describing.
 *
 * The rows come from `tests/setup.ts`'s database and its seed helpers, like every
 * other suite here — so no schema and no `INSERT` is restated in this file. That
 * database's DDL is generated from `src/lib/db/schema.ts` via `drizzle-kit/api`,
 * which is one of the two shapes the generator can meet; the other is
 * `drizzle/*.sql`, which is what `wrangler d1 migrations apply` gives a real D1.
 * The last case in this file applies those migrations to a second database and
 * runs the generator against it too, because if the two ever drift on a column
 * the generator selects, a suite that only knew about the first would stay green
 * while the deploy-time run broke.
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type InValue } from "@libsql/client/node";
import { seedPackage, seedPublisher, testDatabaseFile } from "../setup";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REAL_INDEX = join(repoRoot, "registry/v1/packages.json");
const REAL_POINTER = join(repoRoot, "registry/v1/url.txt");

/**
 * The committed index's bytes, read once when this module loads.
 *
 * Asserted unchanged by the last case in the file. The mirrored root is what
 * makes touching it impossible; this is what would notice if that ever stopped
 * being true.
 */
const committedIndexAtStart = fs.readFileSync(REAL_INDEX);

/** Every repository file the generator or the guard reads. See the header. */
const MIRRORED = [
  "scripts/build-fallback-index.mjs",
  "scripts/fallback-stdlib.mjs",
  "scripts/check-fallback-index.mjs",
  "src/lib/package-name.ts",
  "registry/v1/url.txt",
];

const GENERATOR = "scripts/build-fallback-index.mjs";
const GUARD = "scripts/check-fallback-index.mjs";
const STDLIB = "scripts/fallback-stdlib.mjs";

/** The anchor the stdlib injection rewrites. Its absence must be loud, not silent. */
const STDLIB_ANCHOR = "export const STDLIB_ENTRIES = [];";

/**
 * The local-D1 directory, read out of the generator rather than restated.
 *
 * If that path ever changes, a hardcoded copy here would point at a directory
 * the script no longer looks in: the scan cases would fall through to the
 * `local.db` default and fail for a reason that has nothing to do with what they
 * are about. Extracting it means they fail here, saying so.
 */
function miniflareDir(): string {
  const source = fs.readFileSync(join(repoRoot, GENERATOR), "utf8");
  const match = source.match(/join\(repoRoot, "(\.wrangler[^"]*)"\)/);
  if (!match) {
    throw new Error(
      `could not find the miniflare directory in ${GENERATOR}. The scan moved or was ` +
        "renamed; fix this extraction rather than hardcoding the path here.",
    );
  }
  return match[1];
}

// --- the mirrored root ------------------------------------------------------

interface MiniflareFile {
  name: string;
  /**
   * A database to point at, symlinked rather than copied so no case can read a
   * half-written file. Omit for an empty file, which is what an unmigrated
   * database is: libsql treats a zero-byte file as a valid database with no
   * tables in it, and so does `wrangler` before its migrations run.
   */
  database?: string;
}

interface RootOptions {
  /** `registry/v1/url.txt`. Defaults to the repository's real pointer, verbatim. */
  pointer?: string;
  /** Files to place in the fake local-D1 directory. The directory is only created if this is set. */
  miniflare?: MiniflareFile[];
  /** An edit to the copied generator. Throws if it changes nothing. */
  mutate?: (source: string) => string;
  /** A JavaScript array literal to inject as `STDLIB_ENTRIES`. */
  stdlib?: string;
}

const roots: string[] = [];

function makeRoot(options: RootOptions = {}): string {
  const root = fs.mkdtempSync(join(os.tmpdir(), "finn-registry-generator-"));
  roots.push(root);

  for (const relative of MIRRORED) {
    const target = join(root, relative);
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.copyFileSync(join(repoRoot, relative), target);
  }

  // Resolution walks up from the script's directory, and the script's directory
  // is now in the temp tree. A symlink rather than a copy: `@libsql/client`
  // carries a native binding, and Node realpaths the package's own files anyway.
  fs.symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));

  if (options.pointer !== undefined) {
    fs.writeFileSync(join(root, "registry/v1/url.txt"), options.pointer, "utf8");
  }

  if (options.mutate) {
    const path = join(root, GENERATOR);
    const before = fs.readFileSync(path, "utf8");
    const after = options.mutate(before);
    if (after === before) {
      throw new Error(
        `the mutation changed nothing in ${GENERATOR}, so the case that asked for it would ` +
          "have tested the unmutated script and passed for the wrong reason. The text it " +
          "matched on has moved.",
      );
    }
    fs.writeFileSync(path, after, "utf8");
  }

  if (options.stdlib !== undefined) {
    const path = join(root, STDLIB);
    const before = fs.readFileSync(path, "utf8");
    if (!before.includes(STDLIB_ANCHOR)) {
      throw new Error(
        `could not find ${JSON.stringify(STDLIB_ANCHOR)} in ${STDLIB}. Authored entries can no ` +
          "longer be injected, so the cases about them would silently run against an empty list.",
      );
    }
    fs.writeFileSync(
      path,
      before.replace(STDLIB_ANCHOR, `export const STDLIB_ENTRIES = ${options.stdlib};`),
      "utf8",
    );
  }

  if (options.miniflare) {
    const directory = join(root, miniflareDir());
    fs.mkdirSync(directory, { recursive: true });
    for (const file of options.miniflare) {
      const target = join(directory, file.name);
      if (file.database) fs.symlinkSync(file.database, target);
      else fs.writeFileSync(target, "");
    }
  }

  return root;
}

afterEach(() => {
  // Even on failure: a red test must not leave a temp tree behind, and the
  // symlinked `node_modules` makes `force: true` worth being deliberate about —
  // `fs.rmSync` unlinks a symlink rather than following it.
  while (roots.length > 0) {
    fs.rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

// --- running a script -------------------------------------------------------

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Both streams, which is what a person at a terminal sees. */
  output: string;
}

/**
 * Spawns a mirrored script with an environment that decides nothing on its own.
 *
 * `tests/setup.ts` sets `DATABASE_URL` for the whole suite, and the generator
 * reads it — so a child that inherited it would never reach the local-D1 scan,
 * and the cases about that scan would pass without exercising it. The two CI
 * output files are cleared for the same reason in reverse: the guard appends to
 * them when they are set, and a test must not write into a real workflow's
 * summary.
 */
function runScript(root: string, script: string, args: string[], extraEnv: Record<string, string> = {}): Run {
  const env = { ...process.env, ...extraEnv };
  for (const name of ["DATABASE_URL", "FALLBACK_INDEX_DB", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"]) {
    if (!(name in extraEnv)) delete env[name];
  }

  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });

  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

interface FallbackEntry {
  repo_url: string;
  latest_version: string | null;
  tag: string | null;
  commit: string | null;
  trust: string;
  kind: string;
}

interface FallbackIndex {
  schema: number;
  registry_url: string | null;
  generated_at: string;
  packages: Record<string, FallbackEntry>;
}

interface GeneratorRun extends Run {
  /** Where the index was expected — the explicit `--out`, or the script's own default. */
  indexPath: string;
  /** The parsed index, or null when the run wrote nothing. */
  index: FallbackIndex | null;
}

interface GeneratorOptions {
  /** `--db`. Omitted when absent, which is what exercises `resolveDatabase`. */
  db?: string;
  /**
   * Pass false to omit `--out` and let the script choose. It chooses
   * `<root>/registry/v1/packages.json`, which is the point of the mirrored root.
   */
  out?: boolean;
  env?: Record<string, string>;
}

/**
 * Runs the generator. `--out` is always a path this function chose inside the
 * root, and no caller can pass one — the only way to reach the real
 * `registry/v1/` would be to edit the mirrored root itself.
 */
function runGenerator(root: string, options: GeneratorOptions = {}): GeneratorRun {
  const explicitOut = options.out === false ? null : join(root, "out/packages.json");
  const args: string[] = [];
  if (options.db) args.push("--db", options.db);
  if (explicitOut) {
    fs.mkdirSync(dirname(explicitOut), { recursive: true });
    args.push("--out", explicitOut);
  }

  const run = runScript(root, GENERATOR, args, options.env);
  const indexPath = explicitOut ?? join(root, "registry/v1/packages.json");
  const index = fs.existsSync(indexPath)
    ? (JSON.parse(fs.readFileSync(indexPath, "utf8")) as FallbackIndex)
    : null;

  return { ...run, indexPath, index };
}

/** The seeded database, in the form `--db` takes. */
function fixtureDb(): string {
  return `file:${testDatabaseFile}`;
}

/** A first-party repository URL: the filter's whole subject. */
function firstParty(repo: string): string {
  return `https://github.com/M1778/${repo}`;
}

/** The client's parse of the pointer: first line that is neither blank nor a comment. */
function pointerUrl(text: string): string | null {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("#")) ?? null
  );
}

// ---------------------------------------------------------------------------
// The success path
// ---------------------------------------------------------------------------

describe("build-fallback-index: the register becomes entries", () => {
  it("writes one entry per first-party package, with the fields the client reads", async () => {
    const pkg = await seedPackage({
      name: "http",
      repo_url: firstParty("fin-http"),
      versions: [{ version: "1.2.0" }],
    });

    const run = runGenerator(makeRoot(), { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    expect(run.index).not.toBeNull();
    const index = run.index as FallbackIndex;

    expect(index.schema).toBe(1);
    expect(Object.keys(index)).toEqual(["schema", "registry_url", "generated_at", "packages"]);
    expect(Object.keys(index.packages)).toEqual(["http"]);
    expect(index.packages.http).toEqual({
      repo_url: firstParty("fin-http"),
      latest_version: "1.2.0",
      tag: pkg.versions[0].git_ref,
      commit: pkg.versions[0].commit,
      trust: "recognized",
      kind: "library",
    });
  });

  it("writes to its own default path when no --out is given", async () => {
    // The structural guard, stated as a case. With no `--out` the script writes
    // to `<repoRoot>/registry/v1/packages.json`, and `repoRoot` is the mirrored
    // root — so the file this suite is about cannot be reached even by a case
    // that forgets the flag. Nothing else here relies on remembering it.
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    const root = makeRoot();

    const run = runGenerator(root, { db: fixtureDb(), out: false });

    expect(run.status, run.output).toBe(0);
    expect(run.indexPath).toBe(join(root, "registry/v1/packages.json"));
    expect(fs.existsSync(run.indexPath)).toBe(true);
    expect(run.stdout).toContain(`wrote        ${join(root, "registry/v1/packages.json")}`);
    expect(Object.keys((run.index as FallbackIndex).packages)).toEqual(["http"]);
  });

  it("excludes a yanked version from latest_version and keeps the one below it", async () => {
    // The case verified by hand when the unmigrated-database message went in:
    // 2.0.0 is yanked, so 1.2.0 is latest — and `tag` and `commit` must come from
    // the 1.2.0 record, not from the highest row.
    const pkg = await seedPackage({
      name: "http",
      repo_url: firstParty("fin-http"),
      versions: [{ version: "1.2.0" }, { version: "2.0.0", yanked: true }],
    });
    const [v120, v200] = pkg.versions;

    const run = runGenerator(makeRoot(), { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    const entry = (run.index as FallbackIndex).packages.http;
    expect(entry.latest_version).toBe("1.2.0");
    expect(entry.tag).toBe(v120.git_ref);
    expect(entry.commit).toBe(v120.commit);
    expect(entry.commit).not.toBe(v200.commit);
  });

  it("filters a repository outside the first-party organisation", async () => {
    // The security boundary, not a tidiness rule: an entry pointing at somebody
    // else's repository is the worst single fact this file can carry, and a
    // development database is full of exactly that.
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    await seedPackage({ name: "json", repo_url: "https://github.com/acme/fin-json" });

    const run = runGenerator(makeRoot(), { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    expect(Object.keys((run.index as FallbackIndex).packages)).toEqual(["http"]);
    expect(run.stdout).toContain("not included 1 of 2");
  });

  it.each([
    ["a lookalike host", "https://github.com.evil.example/M1778/fin-http"],
    ["a deeper path", "https://github.com/M1778/fin-http/tree/main"],
    ["a nested owner", "https://github.com/notM1778/M1778/fin-http"],
    ["plain http", "http://github.com/M1778/fin-http"],
  ])("filters %s", async (_label, repoUrl) => {
    await seedPackage({ name: "http", repo_url: repoUrl });

    const run = runGenerator(makeRoot(), { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    expect((run.index as FallbackIndex).packages).toEqual({});
  });

  it("sorts by name so an unchanged register produces the same bytes", async () => {
    await seedPackage({ name: "zlib", repo_url: firstParty("fin-zlib") });
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    await seedPackage({ name: "toml", repo_url: firstParty("fin-toml") });

    const root = makeRoot();
    const first = runGenerator(root, { db: fixtureDb() });
    const second = runGenerator(root, { db: fixtureDb() });

    expect(first.status, first.output).toBe(0);
    expect(Object.keys((first.index as FallbackIndex).packages)).toEqual(["http", "toml", "zlib"]);

    // Byte-stable apart from the timestamp — the property both the guard's
    // "changed" computation and the workflow's skip-the-no-op-commit decision
    // rest on. Asserted on the raw text, because key order is what is at stake
    // and a parsed comparison would not see it.
    const withoutTimestamp = (index: FallbackIndex) =>
      JSON.stringify({ ...index, generated_at: null });
    expect(withoutTimestamp(second.index as FallbackIndex)).toBe(
      withoutTimestamp(first.index as FallbackIndex),
    );
    expect((second.index as FallbackIndex).generated_at).not.toBe(
      (first.index as FallbackIndex).generated_at,
    );
  });

  it("derives every trust level from the register's own two columns", async () => {
    const verified = await seedPublisher({ login: "verified-one", is_verified: true });
    await seedPackage({ name: "http", repo_url: firstParty("fin-http"), publisher: verified });
    await seedPackage({
      name: "toml",
      repo_url: firstParty("fin-toml"),
      package_trusted: true,
    });
    await seedPackage({ name: "zlib", repo_url: firstParty("fin-zlib") });

    const run = runGenerator(makeRoot(), { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    const packages = (run.index as FallbackIndex).packages;
    expect(packages.http.trust).toBe("verified");
    expect(packages.toml.trust).toBe("trusted");
    expect(packages.zlib.trust).toBe("recognized");
  });

  it("leaves latest_version, tag and commit null when there are no version records", async () => {
    // Today's ordinary case rather than an edge one: nothing writes to
    // `versions` yet. The same discipline as the API's no-fabricated-version
    // regression, in the file a client reads when it cannot reach the API.
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });

    const run = runGenerator(makeRoot(), { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    const entry = (run.index as FallbackIndex).packages.http;
    expect(entry.latest_version).toBeNull();
    expect(entry.tag).toBeNull();
    expect(entry.commit).toBeNull();
  });

  it("skips a version that is not valid semver rather than ordering it as a string", async () => {
    await seedPackage({
      name: "http",
      repo_url: firstParty("fin-http"),
      versions: [{ version: "1.2.0" }, { version: "latest" }],
    });

    const run = runGenerator(makeRoot(), { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    expect((run.index as FallbackIndex).packages.http.latest_version).toBe("1.2.0");
    expect(run.output).toContain("skipped http@latest");
  });

  it("refuses to publish a name the register should never have issued", async () => {
    // No column stops a hyphen getting into `packages.name`, and a name that
    // fails the §2.1 rule is one no client can resolve. Refusing beats writing it.
    await seedPackage({ name: "http-client", repo_url: firstParty("fin-http") });

    const run = runGenerator(makeRoot(), { db: fixtureDb() });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('"http-client"');
    expect(run.stderr).toContain("src/lib/package-name.ts");
    expect(run.index).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registry_url comes from the pointer, or is absent
// ---------------------------------------------------------------------------

describe("build-fallback-index: registry_url and registry/v1/url.txt", () => {
  it("agrees with the committed pointer, whatever the committed pointer says today", async () => {
    // Deliberately not `toBeNull()`. The pointer is comments-only until the
    // Worker is deployed, and on the day a URL is appended this case must start
    // asserting that URL rather than needing an edit. What is pinned is the
    // agreement, which is the invariant on both sides of that day.
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    const expected = pointerUrl(fs.readFileSync(REAL_POINTER, "utf8"));

    const run = runGenerator(makeRoot(), { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    expect((run.index as FallbackIndex).registry_url).toBe(expected);
  });

  it("carries the pointer's URL into the index when the pointer names one", async () => {
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    const root = makeRoot({
      pointer: "# a deployed registry\nhttps://registry.example\n",
    });

    const run = runGenerator(root, { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    expect((run.index as FallbackIndex).registry_url).toBe("https://registry.example");
  });

  it.each([
    ["a placeholder", "https://finn-registry.REPLACE-WITH-ACCOUNT-SUBDOMAIN.workers.dev"],
    ["a trailing slash", "https://registry.example/"],
    ["a path", "https://registry.example/api"],
    ["a non-https scheme", "http://registry.example"],
  ])("refuses %s in URL position and writes nothing", async (_label, url) => {
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    const root = makeRoot({ pointer: `# pointer\n${url}\n` });

    const run = runGenerator(root, { db: fixtureDb() });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(url);
    // A refusal that had already written a file would leave a half-published
    // index behind for the next step to commit.
    expect(run.index).toBeNull();
  });

  it("reads the URL from the first content line and ignores a second one", async () => {
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    const root = makeRoot({
      pointer: "# two lines\nhttps://first.example\nhttps://second.example\n",
    });

    const run = runGenerator(root, { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    expect((run.index as FallbackIndex).registry_url).toBe("https://first.example");
  });
});

// ---------------------------------------------------------------------------
// Which database it reads
// ---------------------------------------------------------------------------

describe("build-fallback-index: resolving the database", () => {
  it("uses the one real local D1 and does not count miniflare's bookkeeping file", async () => {
    // THE REGRESSION. `metadata.sqlite` sits beside the real database and holds
    // a single `_cf_ALARM` table. Counting it made a machine that had run
    // `npm run db:apply:local` exactly as documented get "2 local D1 databases
    // ... Name one with --db" and exit 1, with no second database anywhere.
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    const root = makeRoot({
      miniflare: [
        { name: `${"c".repeat(64)}.sqlite`, database: testDatabaseFile },
        { name: "metadata.sqlite" },
      ],
    });

    const run = runGenerator(root, { db: undefined });

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain(join(root, miniflareDir(), `${"c".repeat(64)}.sqlite`));
    expect(Object.keys((run.index as FallbackIndex).packages)).toEqual(["http"]);
  });

  it("still refuses when there genuinely are two databases", async () => {
    // The other direction, and the one that must not be weakened into a silent
    // pick: picking one would publish an index built from whichever database
    // sorted first.
    const root = makeRoot({
      miniflare: [
        { name: `${"a".repeat(64)}.sqlite`, database: testDatabaseFile },
        { name: `${"b".repeat(64)}.sqlite`, database: testDatabaseFile },
        { name: "metadata.sqlite" },
      ],
    });

    const run = runGenerator(root, { db: undefined });

    expect(run.status).not.toBe(0);
    // "2", not "3": the bookkeeping file is excluded from the count as well as
    // from the choice.
    expect(run.stderr).toContain("2 local D1 databases");
    expect(run.stderr).toContain("Name one with --db");
    expect(run.index).toBeNull();
  });

  it("falls back to local.db when the D1 directory holds only bookkeeping", async () => {
    // The fresh-clone case: `.wrangler` exists because `wrangler dev` has run,
    // but `npm run db:apply:local` has not, so there is no D1 database in there
    // at all. Excluding the bookkeeping file has to leave zero rather than one,
    // and zero means the `local.db` default — which then produces the unmigrated
    // message naming that path, which is the true description of the situation.
    const root = makeRoot({ miniflare: [{ name: "metadata.sqlite" }] });

    const run = runGenerator(root, { db: undefined });

    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain(join(root, "local.db"));
    expect(run.stderr).toContain("migrations have never been applied");
    expect(run.stderr).not.toContain("metadata.sqlite");
  });

  it("reads DATABASE_URL when no --db is given, in preference to the scan", async () => {
    // Why `runScript` clears it: `tests/setup.ts` sets `DATABASE_URL` suite-wide,
    // so a child that inherited it would never reach the scan and the two cases
    // above would pass without exercising anything.
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    const root = makeRoot({
      miniflare: [{ name: `${"d".repeat(64)}.sqlite` }],
    });

    const run = runGenerator(root, { db: undefined, env: { DATABASE_URL: fixtureDb() } });

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain(fixtureDb());
    expect(Object.keys((run.index as FallbackIndex).packages)).toEqual(["http"]);
  });
});

// ---------------------------------------------------------------------------
// Failing usefully
// ---------------------------------------------------------------------------

describe("build-fallback-index: failures a person can act on", () => {
  it("names the cause and the fix for an unmigrated database, with no stack trace", async () => {
    // `registry/v1/url.txt` documents this script as a hand-run step in the
    // deploy sequence, so the person running it is at a terminal — and pointing
    // it at a database they have not migrated used to produce a 25-line
    // LibsqlError with two nested [cause] traces, where every other failure here
    // is one line.
    const unmigrated = join(makeRoot(), "empty.db");
    fs.writeFileSync(unmigrated, "");

    const run = runGenerator(makeRoot(), { db: `file:${unmigrated}` });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("has no `packages` table");
    expect(run.stderr).toContain("migrations have never been applied");
    expect(run.stderr).toContain("npm run db:apply:local");
    expect(run.stderr).toContain(unmigrated);
    expect(run.index).toBeNull();

    // No stack: not "shorter", none. A stack frame is the thing that made the
    // old output unreadable, and `LibsqlError` is what it was raised as.
    expect(run.stderr).not.toContain("LibsqlError");
    expect(run.stderr).not.toMatch(/^\s+at /m);
    expect(run.stderr.trimEnd().split("\n").length).toBeLessThanOrEqual(4);
  });

  it("names `users` rather than `packages` when that is the table that is missing", async () => {
    // The first statement joins the two, so either name can be the one the
    // driver reports. An earlier version of the catch assumed `packages` and
    // would have re-thrown a stack for a database missing only `users`.
    const root = makeRoot();
    const withoutUsers = join(root, "no-users.db");
    const client = createClient({ url: `file:${withoutUsers}` });
    await client.execute("CREATE TABLE packages (id text, name text, repo_url text, is_trusted integer, owner_id text)");
    client.close();

    const run = runGenerator(root, { db: `file:${withoutUsers}` });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("has no `users` table");
    expect(run.stderr).not.toContain("LibsqlError");
  });

  it("keeps the stack for a table the script has no business asking for", async () => {
    // The case most likely to rot, because widening the catch is the natural
    // thing for a future editor to do. A table outside `READ_TABLES` missing is
    // this script's bug, not the user's: "run the migrations" would be
    // confident, wrong advice for something migrations cannot fix, which is
    // worse than the stack trace it replaced.
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    const root = makeRoot({
      mutate: (source) => source.replace("from packages p", "from packagez p"),
    });

    const run = runGenerator(root, { db: fixtureDb() });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("no such table: packagez");
    expect(run.stderr).toMatch(/^\s+at /m);
    expect(run.stderr).not.toContain("npm run db:apply:local");
    expect(run.stderr).not.toContain("migrations have never been applied");
  });

  it("says so when the pointer file is gone instead of publishing without a URL", async () => {
    const root = makeRoot();
    fs.rmSync(join(root, "registry/v1/url.txt"));

    const run = runGenerator(root, { db: fixtureDb() });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("the pointer file is not optional");
  });
});

// ---------------------------------------------------------------------------
// Authored entries
// ---------------------------------------------------------------------------

describe("build-fallback-index: authored entries", () => {
  /**
   * `STDLIB_ENTRIES` is `[]` and deliberately so — the standard library ships
   * inside the compiler archive and `finn` never fetches it. That makes four
   * refusals in the generator unreachable against the real data file, so these
   * cases inject entries into the mirrored copy of it. Without the injection
   * they would assert nothing at all, which is worse than not having them: the
   * printed accounting below is the only thing the empty list can be asked
   * about.
   */
  it("accounts for authored entries separately, and there are none today", async () => {
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });

    const run = runGenerator(makeRoot(), { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain("entries      1 (1 from the register, 0 authored)");
  });

  it("refuses an authored entry that collides with a registered package", async () => {
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    const root = makeRoot({
      stdlib: JSON.stringify([
        {
          name: "http",
          repo_url: firstParty("fin"),
          latest_version: null,
          tag: null,
          commit: null,
          trust: "verified",
        },
      ]),
    });

    const run = runGenerator(root, { db: fixtureDb() });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("collides with a registered package");
    expect(run.index).toBeNull();
  });

  it("refuses an authored entry pointing outside the first-party organisation", async () => {
    const root = makeRoot({
      stdlib: JSON.stringify([
        {
          name: "json",
          repo_url: "https://github.com/acme/fin-json",
          latest_version: null,
          tag: null,
          commit: null,
          trust: "verified",
        },
      ]),
    });

    const run = runGenerator(root, { db: fixtureDb() });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("repo_url that is not github.com/M1778");
  });

  it("marks an authored entry stdlib and sorts it in before the register entry", async () => {
    /**
     * `bytes`, not `io`, and the name is the whole assertion.
     *
     * Authored entries are pushed on after the query has already returned its
     * rows in `order by p.name`, so interleaving them is the *only* job the
     * `entries.sort` in the generator has — against register rows alone that
     * sort is redundant and removing it kills nothing. This case is therefore
     * the sole detector of it, and it can only detect it if the authored name
     * sorts **before** the register entry: with `io` the append order already
     * equalled the sorted order, so the case passed with the sort deleted.
     *
     * If a future edit renames this entry, keep it sorting ahead of `http`.
     */
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    const root = makeRoot({
      stdlib: JSON.stringify([
        {
          name: "bytes",
          repo_url: firstParty("fin"),
          latest_version: null,
          tag: null,
          commit: null,
          trust: "verified",
        },
      ]),
    });

    const run = runGenerator(root, { db: fixtureDb() });

    expect(run.status, run.output).toBe(0);
    const index = run.index as FallbackIndex;
    expect(Object.keys(index.packages)).toEqual(["bytes", "http"]);
    expect(index.packages.bytes.kind).toBe("stdlib");
    expect(index.packages.http.kind).toBe("library");
    expect(run.stdout).toContain("entries      2 (1 from the register, 1 authored)");
  });
});

// ---------------------------------------------------------------------------
// The guard the workflow runs on the generator's output
// ---------------------------------------------------------------------------

describe("check-fallback-index: on the generator's own output", () => {
  it("reports only generated_at moving when the register has not changed", async () => {
    // The property the workflow's skip-the-no-op-commit decision rests on,
    // asserted through the guard's own computation of it rather than through a
    // second implementation here.
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    const root = makeRoot();

    const first = runGenerator(root, { db: fixtureDb() });
    expect(first.status, first.output).toBe(0);
    const committed = join(root, "out/committed.json");
    fs.copyFileSync(first.indexPath, committed);

    const second = runGenerator(root, { db: fixtureDb() });
    expect(second.status, second.output).toBe(0);
    expect(second.index?.generated_at).not.toBe(first.index?.generated_at);

    const check = runScript(root, GUARD, [
      "--candidate",
      second.indexPath,
      "--committed",
      committed,
      "--pointer",
      join(root, "registry/v1/url.txt"),
    ]);

    expect(check.status, check.output).toBe(0);
    expect(check.stdout).toContain("changed      no (only generated_at moved)");
  });

  it("refuses a candidate that lost a name the committed index had", async () => {
    // A package cannot be deleted from the register — the router has no DELETE
    // route — so a name that vanished between two runs is a failed read, and
    // publishing it would hand every offline finn a "no such package" for a name
    // that does exist.
    const root = makeRoot();
    await seedPackage({ name: "http", repo_url: firstParty("fin-http") });
    await seedPackage({ name: "toml", repo_url: firstParty("fin-toml") });

    const both = runGenerator(root, { db: fixtureDb() });
    expect(both.status, both.output).toBe(0);
    expect(Object.keys(both.index?.packages ?? {})).toEqual(["http", "toml"]);
    const committed = join(root, "out/committed.json");
    fs.copyFileSync(both.indexPath, committed);

    // The truncated read: the same generator, a register missing a row.
    const truncated = { ...(both.index as FallbackIndex) };
    truncated.packages = { http: (both.index as FallbackIndex).packages.http };
    const candidate = join(root, "out/candidate.json");
    fs.writeFileSync(candidate, `${JSON.stringify(truncated, null, 2)}\n`, "utf8");

    const check = runScript(root, GUARD, [
      "--candidate",
      candidate,
      "--committed",
      committed,
      "--pointer",
      join(root, "registry/v1/url.txt"),
    ]);

    expect(check.status).not.toBe(0);
    expect(check.output).toContain("toml");
  });
});

// ---------------------------------------------------------------------------
// The two schema shapes, and the file this suite must never touch
// ---------------------------------------------------------------------------

describe("build-fallback-index: against the migrations a real D1 has", () => {
  it("reads the same rows out of a database built by drizzle/*.sql", async () => {
    // `tests/setup.ts` builds its schema from `src/lib/db/schema.ts` via
    // `drizzle-kit/api`; a deployed D1 gets its schema from `drizzle/*.sql` via
    // `wrangler d1 migrations apply`. Those are meant to be the same shape, and
    // nothing here would notice if they stopped being it — a suite that only
    // knew the first would stay green while the hand-run deploy step broke on a
    // renamed column. So the rows are copied into a second database built the
    // other way and the generator is run against that too.
    //
    // Both of the generator's statements are exercised, which matters: SQLite
    // validates column names when it prepares a statement, but the `versions`
    // query only runs for a package that survived the first-party filter.
    const pkg = await seedPackage({
      name: "http",
      repo_url: firstParty("fin-http"),
      package_trusted: true,
      versions: [{ version: "1.2.0" }, { version: "2.0.0", yanked: true }],
    });

    const root = makeRoot();
    const migrated = join(root, "migrated.db");
    const target = createClient({ url: `file:${migrated}` });
    const source = createClient({ url: fixtureDb() });

    const migrations = fs
      .readdirSync(join(repoRoot, "drizzle"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations.length).toBeGreaterThan(0);
    for (const name of migrations) {
      await target.executeMultiple(fs.readFileSync(join(repoRoot, "drizzle", name), "utf8"));
    }

    // Copied by reading each table's own column list, so no column name is
    // written down here: a rename shows up as the generator failing, which is
    // the point, rather than as this copy failing first.
    for (const table of ["users", "packages", "versions"]) {
      const rows = await source.execute(`SELECT * FROM "${table}"`);
      for (const row of rows.rows) {
        const columns = rows.columns;
        await target.execute({
          sql:
            `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) ` +
            `VALUES (${columns.map(() => "?").join(", ")})`,
          args: columns.map((c) => row[c] as InValue),
        });
      }
    }
    target.close();
    source.close();

    const run = runGenerator(root, { db: `file:${migrated}` });

    expect(run.status, run.output).toBe(0);
    expect((run.index as FallbackIndex).packages).toEqual({
      http: {
        repo_url: firstParty("fin-http"),
        latest_version: "1.2.0",
        tag: pkg.versions[0].git_ref,
        commit: pkg.versions[0].commit,
        trust: "trusted",
        kind: "library",
      },
    });
  });

  it("never writes to the committed registry/v1/packages.json", () => {
    // The mirrored root is what makes this impossible; this is what would
    // notice if it stopped being. Last in the file so it sees every case above.
    expect(fs.readFileSync(REAL_INDEX).equals(committedIndexAtStart)).toBe(true);
  });
});
