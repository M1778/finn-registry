/**
 * Generate `registry/v1/packages.json`.
 *
 * The fallback index is what `finn` reads when the live API is unreachable. It
 * duplicates package -> repository data that already lives in D1, which is
 * precisely why it is generated: a hand-maintained copy becomes a second, wrong
 * source of truth about where a package's code lives, and it is read by a client
 * that has no other answer at that moment. So it is derived from the register,
 * from one place, by this script.
 *
 * Run it:
 *
 *   npm run build:fallback-index                     # the default database
 *   npm run build:fallback-index -- --db file:prod.db # an explicit one
 *
 * `.mjs`, not `.ts`, because nothing in this repository can run a TypeScript
 * file: there is no ts-node or tsx in devDependencies and adding one is not on
 * the table. It imports `@libsql/client/node` and `semver`, both already
 * dependencies, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DATA COMES FROM, AND WHY THE FILTER IS NOT A CONVENIENCE
 * ---------------------------------------------------------------------------
 *
 * This script reads a local SQLite file: the same file `next dev` and the test
 * suite use, or the local D1 that `npm run db:apply:local` creates. On a
 * developer's machine that database holds development rows, and a development
 * row is a fiction — a name pointing at a repository that does not exist, or
 * that belongs to somebody else. Publishing one in this file would hand every
 * offline `finn` a wrong answer about where a package's code lives, which is the
 * worst single fact this repository can get wrong.
 *
 * Two things keep that out:
 *
 *   1. Only **first-party** packages are included — those whose `repo_url` is
 *      under the `M1778` GitHub organisation. That is what the index is for: the
 *      standard library and the first-party libraries, not a mirror of the whole
 *      register. It is also a filter a development seed cannot accidentally
 *      satisfy.
 *   2. Every field is copied or omitted, never invented. A package with no
 *      version records gets `latest_version`, `tag` and `commit` as `null` —
 *      the same discipline `tests/regressions/no-fabricated-version.test.ts`
 *      enforces on the API, for the same reason. `trust` is derived by the same
 *      ladder as `src/lib/trust.ts`, from the same two columns, and is never
 *      defaulted.
 *
 * When this runs against a production database — export it and point `--db` at
 * the result — the output is publishable. Against a development one the filter
 * is what makes it safe, and the entry count it prints is what a reviewer
 * should check before committing the diff.
 */

import { createClient } from "@libsql/client/node";
import semverPkg from "semver";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STDLIB_ENTRIES } from "./fallback-stdlib.mjs";

const semver = semverPkg;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The schema integer the client checks before it reads anything else.
 *
 * `finn` refuses an index whose schema it does not implement rather than
 * guessing at the fields, mirroring `INDEX_SCHEMA` in its own `download.rs`. So
 * this number may only change when the *meaning* of an existing field changes;
 * adding a field does not need it, and renaming one does.
 */
const SCHEMA = 1;

/**
 * The GitHub organisation whose packages count as first-party.
 *
 * Settled in both projects' `Sync.md` §3.1: `github.com/M1778/finn-registry`,
 * `github.com/M1778/finn`.
 */
const DEFAULT_OWNER = "M1778";

/**
 * The name rule is **not restated here.** It is read out of
 * `src/lib/package-name.ts`, which is the single home of it, because a third and
 * fourth copy of a regex is a third and fourth thing that can drift -- and the
 * drift would be silent in exactly the direction that matters: a generator
 * accepting `http-client` would publish a name the register itself refuses.
 *
 * Read by pattern-matching the source rather than imported, because this is a
 * plain `.mjs` script with no TypeScript loader and no build step. Extraction
 * failing is fatal, never a fallback to a hardcoded rule: not knowing the rule
 * and guessing it are different, and only one of them is safe.
 */
function readNameRule() {
  const path = join(repoRoot, "src", "lib", "package-name.ts");
  const source = readFileSync(path, "utf8");

  const pattern = source.match(/export const NAME_RULE = \/(\S+)\/;/);
  const min = source.match(/export const NAME_MIN = (\d+);/);
  const max = source.match(/export const NAME_MAX = (\d+);/);
  const listing = source.match(/FIN_RESERVED_WORDS[^[]*\[([\s\S]*?)\]/);

  if (!pattern || !min || !max || !listing) {
    throw new Error(
      `could not read the name rule out of ${path}. The declarations moved or were ` +
        `renamed; fix this extraction rather than restating the rule here.`,
    );
  }

  const reserved = new Set([...listing[1].matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]));
  if (reserved.size < 20) {
    throw new Error(
      `read only ${reserved.size} reserved words out of ${path}, which is too few to be ` +
        `Fin's keyword list. Refusing to run with a half-read denylist.`,
    );
  }

  return {
    rule: new RegExp(pattern[1]),
    min: Number(min[1]),
    max: Number(max[1]),
    reserved,
  };
}

const NAME = readNameRule();

const TRUST_LEVELS = new Set(["verified", "trusted", "recognized"]);

function fail(message) {
  console.error(`build-fallback-index: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { db: null, out: null, owner: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) fail(`${arg} needs a value`);
      i += 1;
      return value;
    };

    if (arg === "--db") args.db = take();
    else if (arg === "--out") args.out = take();
    else if (arg === "--owner") args.owner = take();
    else fail(`unknown argument ${arg}`);
  }

  return args;
}

/**
 * Files in miniflare's D1 directory that are not D1 databases.
 *
 * `metadata.sqlite` sits beside the real database in the same directory and
 * holds a single `_cf_ALARM` table — Durable Object alarm bookkeeping, nothing
 * to do with the register. Counting it made the scan below report "2 local D1
 * databases" and demand `--db` to disambiguate a set of one, on a machine that
 * had run `npm run db:apply:local` exactly as documented.
 *
 * A denylist, not an allowlist, and that is the deliberate direction. D1's own
 * files are named by a 64-hex hash, so matching that shape would read as tidier;
 * but if miniflare ever changed the naming, an allowlist would find nothing,
 * fall through to `local.db`, and read the wrong database in silence. Failing to
 * exclude some *new* bookkeeping file instead lands back on the loud ambiguity
 * refusal below, which is the failure worth having.
 */
const MINIFLARE_BOOKKEEPING = new Set(["metadata.sqlite"]);

/**
 * Which database to read.
 *
 * The order mirrors how the app itself finds one (`src/lib/db/index.ts`), plus
 * the local D1 that `wrangler d1 migrations apply --local` writes: miniflare
 * keys that file off the binding rather than the placeholder `database_id`, so
 * it exists on any machine that has run `npm run db:apply:local`.
 */
function resolveDatabase(explicit) {
  if (explicit) return explicit.includes(":") ? explicit : `file:${explicit}`;
  if (process.env.FALLBACK_INDEX_DB) return process.env.FALLBACK_INDEX_DB;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const miniflare = join(repoRoot, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (existsSync(miniflare)) {
    const found = readdirSync(miniflare).filter(
      (name) => name.endsWith(".sqlite") && !MINIFLARE_BOOKKEEPING.has(name),
    );
    if (found.length === 1) return `file:${join(miniflare, found[0])}`;
    // Still a refusal when there genuinely are two. Picking one silently would
    // publish an index built from whichever database sorted first.
    if (found.length > 1) {
      fail(
        `${found.length} local D1 databases under ${miniflare}. Name one with --db.`,
      );
    }
  }

  return `file:${join(repoRoot, "local.db")}`;
}

// ---------------------------------------------------------------------------
// The pointer file is the one source of the URL
// ---------------------------------------------------------------------------

/**
 * Read the base URL out of `registry/v1/url.txt`, applying the rules that file
 * documents and the client implements.
 *
 * The index carries `registry_url` so that one successful fetch recovers the
 * pointer too, which only helps if the two files cannot disagree. Reading it
 * from the pointer rather than from a constant here is what guarantees that,
 * and it makes this script the one thing that checks the pointer's format
 * before either file is published.
 *
 * RETURNS NULL WHEN THE POINTER NAMES NO URL, and that is a supported state
 * rather than an error. Until the Worker is published there is no origin to
 * publish, and the pointer is comments only — see the block at the end of
 * `url.txt` for why a placeholder is worse than nothing. `registry_url: null` is
 * what the client's own tests cover for an index with no URL in it, so the
 * absence travels into `packages.json` intact instead of being invented here.
 *
 * A line that *is* present still has to be right: every rule below is a hard
 * failure, because a malformed or placeholder URL published to every installed
 * finn is the one mistake this script exists to make impossible.
 */
function registryUrlFromPointer() {
  const path = join(repoRoot, "registry/v1/url.txt");
  if (!existsSync(path)) fail(`${path} does not exist; the pointer file is not optional`);

  const lines = readFileSync(path, "utf8").split("\n");
  const url = lines
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#"));

  if (!url) return null;
  if (!url.startsWith("https://")) fail(`registry/v1/url.txt must name an https:// URL, got ${url}`);
  if (url.endsWith("/")) fail(`registry/v1/url.txt must carry no trailing slash, got ${url}`);

  // The placeholder idiom, refused in URL position specifically. It satisfies
  // every rule above, so nothing else here would catch it, and a client cannot
  // tell it from a real answer: it would be accepted, cached for 24 hours, and
  // reported as the registry being unreachable rather than undeployed.
  if (/REPLACE[-_]WITH/i.test(url)) {
    fail(
      `registry/v1/url.txt names a placeholder, not a URL: ${url}\n` +
        "  Publishing this would tell every finn that the registry is unreachable rather\n" +
        "  than that it has never been deployed. Delete the line; comments only is correct\n" +
        "  until a real origin exists.",
    );
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return fail(`registry/v1/url.txt does not name a URL: ${url}`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    fail(`registry/v1/url.txt must carry no path, query or fragment, got ${url}`);
  }

  return url;
}

// ---------------------------------------------------------------------------
// Register -> entries
// ---------------------------------------------------------------------------

/**
 * The trust ladder, identical to `deriveTrustLevel` in src/lib/trust.ts, and a
 * copy for the same reason as the constant below: no TypeScript import from a
 * Node script. `tests/scripts/build-fallback-index.test.ts` asserts the levels
 * this produces against the register's own two columns.
 */
function deriveTrustLevel({ publisherVerified, packageTrusted, repoOwnershipConfirmed }) {
  if (publisherVerified && repoOwnershipConfirmed) return "verified";
  if (packageTrusted) return "trusted";
  return "recognized";
}

/**
 * The one duplicate of `REPO_OWNERSHIP_CONFIRMED` in `src/lib/trust.ts`, and it
 * exists only because this is a Node script that cannot import TypeScript. That
 * file carries the reasoning and the two caveats — the proof is taken once at
 * registration and never retaken, and the value is the same for every row so it
 * discriminates nothing. Read it before changing this line.
 *
 * `tests/regressions/no-unproven-ownership.test.ts` reads both files and fails
 * if these two booleans ever disagree, so a change here that is not made there
 * cannot ship quietly.
 */
const REPO_OWNERSHIP_CONFIRMED = true;

/** `https://github.com/<owner>/<repo>` and nothing else counts as first-party. */
function firstPartyRepo(repoUrl, owner) {
  if (typeof repoUrl !== "string") return false;

  let parsed;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return false;

  const segments = parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  return segments.length === 2 && segments[0].toLowerCase() === owner.toLowerCase();
}

/**
 * The highest non-yanked version, by semver precedence.
 *
 * Yanked records are excluded from "latest" and only from that: a lockfile that
 * already pins one is still honoured, which is the whole point of the flag. A
 * stored version that is not valid semver is skipped and reported rather than
 * ordered by string, because ordering junk silently produces a wrong `latest`.
 */
function latestVersion(rows, name) {
  const selectable = [];
  for (const row of rows) {
    if (row.yanked) continue;
    if (!semver.valid(row.version)) {
      console.warn(`  skipped ${name}@${row.version}: not a valid semver version`);
      continue;
    }
    selectable.push(row);
  }
  if (selectable.length === 0) return null;

  return selectable.reduce((highest, row) =>
    semver.gt(row.version, highest.version) ? row : highest,
  );
}

function validName(name) {
  return (
    typeof name === "string" &&
    name.length >= NAME.min &&
    name.length <= NAME.max &&
    NAME.rule.test(name) &&
    !NAME.reserved.has(name)
  );
}

/**
 * The tables this script reads. Nothing else may be diagnosed as "unmigrated".
 *
 * Scoped to a known set rather than matched on "no such table" generally,
 * because the difference matters: one of these missing means the database never
 * had the migrations applied, which is the user's problem and has a one-line
 * fix. Any *other* table missing means the SQL below names something the schema
 * does not have, which is this script's bug and must keep its stack trace.
 */
const READ_TABLES = ["packages", "users", "versions"];

/**
 * The table name from the driver's "that table is not there" error, or null.
 *
 * Matched on the driver's own `SQLITE_ERROR` code *and* a table from
 * `READ_TABLES`, so it cannot widen into a general "something went wrong with
 * SQLite" catch.
 */
function missingTable(error) {
  if (typeof error !== "object" || error === null) return null;
  if (error.code !== "SQLITE_ERROR" || typeof error.message !== "string") return null;
  return READ_TABLES.find((table) => error.message.includes(`no such table: ${table}`)) ?? null;
}

async function registerEntries(dbUrl, owner) {
  const client = createClient({ url: dbUrl });

  /**
   * `client.execute`, with the unmigrated-database case turned into one line.
   *
   * This is the likeliest real failure in the whole script, not an edge case.
   * `registry/v1/url.txt` documents `npm run build:fallback-index` as a
   * **hand-run** command in the deploy sequence, so the person running it is a
   * human at a terminal — and if they point it at a local database they have not
   * migrated, what came back was a 31-line `LibsqlError` stack with two nested
   * `[cause]` traces, where every other failure in this script is a clean
   * one-liner. It also covers a `--db` path that does not exist at all: libsql
   * creates an empty file, so the first query is where that surfaces, and "never
   * had the migrations applied" is the true description of it.
   *
   * The first statement joins `packages` to `users`, so either name can be the
   * one that is missing; the message reports whichever the driver named rather
   * than assuming it was `packages`.
   *
   * Anything else is re-thrown untouched. Swallowing every error here would turn
   * a genuine bug in the SQL below into the same confident, wrong advice — "run
   * the migrations" for something migrations cannot fix — which is worse than
   * the stack trace this replaces.
   */
  const query = async (statement) => {
    try {
      return await client.execute(statement);
    } catch (error) {
      const table = missingTable(error);
      if (table) {
        fail(
          `the database has no \`${table}\` table, so this repository's migrations have ` +
            `never been applied to it:\n` +
            `    ${dbUrl}\n` +
            `  Run \`npm run db:apply:local\` for the local D1, or point --db at a database ` +
            `that has already been migrated.`,
        );
      }
      throw error;
    }
  };

  const packages = await query({
    sql: `select p.id as id, p.name as name, p.repo_url as repo_url,
                 p.is_trusted as is_trusted, u.is_verified as is_verified
            from packages p
            join users u on u.id = p.owner_id
           order by p.name`,
    args: [],
  });

  const kept = packages.rows.filter((row) => firstPartyRepo(row.repo_url, owner));
  const skipped = packages.rows.length - kept.length;

  const entries = [];
  for (const row of kept) {
    if (!validName(row.name)) {
      fail(
        `the register holds a package named ${JSON.stringify(row.name)}, which is not a ` +
          `valid registry name under the rule in src/lib/package-name.ts -- the grammar, ` +
          `the length bounds or the reserved-word list. Refusing to publish it rather ` +
          `than publishing a name no client can resolve.`,
      );
    }

    const versionRows = await query({
      // `commit` is a keyword in SQLite, so the column has to be quoted — the
      // migration declares it quoted too (drizzle/0000_registry_schema.sql).
      sql: `select version, git_ref, "commit", yanked from versions where package_id = ?`,
      args: [row.id],
    });
    const latest = latestVersion(versionRows.rows, row.name);

    entries.push({
      name: row.name,
      repo_url: row.repo_url,
      // Null, never a placeholder. Nothing writes to `versions` yet, so this is
      // the ordinary case and not an edge one.
      latest_version: latest ? latest.version : null,
      tag: latest ? (latest.git_ref ?? null) : null,
      commit: latest ? (latest.commit ?? null) : null,
      trust: deriveTrustLevel({
        publisherVerified: Boolean(row.is_verified),
        packageTrusted: Boolean(row.is_trusted),
        repoOwnershipConfirmed: REPO_OWNERSHIP_CONFIRMED,
      }),
      kind: "library",
    });
  }

  return { entries, skipped, total: packages.rows.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const owner = args.owner ?? DEFAULT_OWNER;
const dbUrl = resolveDatabase(args.db);
const outPath = args.out ? resolve(args.out) : join(repoRoot, "registry/v1/packages.json");
const registryUrl = registryUrlFromPointer();

console.log(`  database     ${dbUrl}`);
console.log(`  first-party  github.com/${owner}/*`);
console.log(
  `  registry_url ${registryUrl ?? "null (registry/v1/url.txt names none — no deployment yet)"}` +
    (registryUrl ? "   (from registry/v1/url.txt)" : ""),
);

const { entries, skipped, total } = await registerEntries(dbUrl, owner);

for (const entry of STDLIB_ENTRIES) {
  if (!validName(entry.name))
    fail(
      `authored entry ${JSON.stringify(entry.name)} is not a valid registry name. Authored ` +
        `entries never passed through registration, so this is the only place the rule is ` +
        `applied to them.`,
    );
  if (!TRUST_LEVELS.has(entry.trust)) fail(`authored entry ${entry.name} has trust ${JSON.stringify(entry.trust)}`);
  if (!firstPartyRepo(entry.repo_url, owner)) fail(`authored entry ${entry.name} has a repo_url that is not github.com/${owner}/<repo>`);
  if (entries.some((existing) => existing.name === entry.name)) {
    fail(`authored entry ${entry.name} collides with a registered package of the same name`);
  }
  entries.push({ ...entry, kind: "stdlib" });
}

// Sorted so that regenerating produces the same bytes for the same register.
// The only field that moves on an unchanged database is `generated_at`.
entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const packagesOut = {};
for (const entry of entries) {
  const { name, ...rest } = entry;
  packagesOut[name] = rest;
}

const index = {
  // First, and checked first: the client refuses an unknown schema rather than
  // reading the fields below it.
  schema: SCHEMA,
  registry_url: registryUrl,
  generated_at: new Date().toISOString(),
  packages: packagesOut,
};

writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

console.log(
  `  wrote        ${outPath}\n` +
    `  entries      ${entries.length} ` +
    `(${entries.length - STDLIB_ENTRIES.length} from the register, ${STDLIB_ENTRIES.length} authored)\n` +
    `  not included ${skipped} of ${total} registered packages are not first-party`,
);
