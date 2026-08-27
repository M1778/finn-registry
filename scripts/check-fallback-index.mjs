/**
 * Guard a freshly generated `registry/v1/packages.json` before anything commits it.
 *
 * Run it:
 *
 *   node scripts/check-fallback-index.mjs --candidate /tmp/packages.json
 *   node scripts/check-fallback-index.mjs --candidate /tmp/packages.json --committed registry/v1/packages.json
 *
 * Exit 0 and print whether the content changed; exit 1 on anything it refuses.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM THE GENERATOR
 * ---------------------------------------------------------------------------
 *
 * `scripts/build-fallback-index.mjs` fails loudly on everything it can see from
 * the inside: an unreadable pointer file, a name the register should not hold, an
 * authored entry that collides. What it cannot see is the thing that actually
 * matters when a job runs unattended: **whether the database it just read was
 * the whole database.**
 *
 * A truncated or empty export is not an error from the generator's point of
 * view. It reads the rows it is given, filters them, and writes a perfectly
 * well-formed index describing a register with fewer packages in it than the real
 * one -- or none. Committed over a good file, that hands every offline `finn` a
 * "no such package" for names that do exist. Nothing downstream would notice: the
 * file parses, the schema is right, and the diff looks like an ordinary removal.
 *
 * So the guard is comparative, not merely structural. The load-bearing check is
 * that **no name ever disappears and no `repo_url` ever moves**, which holds
 * because nothing in the register can delete a package or repoint one:
 * `src/app/api/[[...route]]/router.ts` has no `DELETE` route at all, and its only
 * mutating routes are `POST /registrations/check`, `POST /packages`,
 * `POST /auth/logout`, `POST /me/verification-request` and `PATCH /me/settings` --
 * none of which removes a package row or rewrites `packages.repo_url`. A name that
 * vanished between two runs is therefore a failed read, not a changed register,
 * and the right response is to stop and say so rather than to publish it.
 *
 * The structural checks are here too, and deliberately re-state a few of the
 * generator's rules. They are cheap, and they are the difference between "the
 * generator is correct" and "this specific file is correct" -- which is what a job
 * is about to commit.
 *
 * ---------------------------------------------------------------------------
 * AND THE POINTER, FOR ONE REASON
 * ---------------------------------------------------------------------------
 *
 * `registry/v1/url.txt` is otherwise the generator's business, since it is the
 * only thing that reads it. The exception is the placeholder: a hostname like
 * `https://finn-registry.REPLACE-WITH-ACCOUNT-SUBDOMAIN.workers.dev` satisfies
 * every format rule either file documents -- https, non-empty host, no trailing
 * slash, no path -- so a client accepts it, caches it for 24 hours, fails to
 * connect, and reports the registry as **unreachable** when the truth is that it
 * has never been **deployed**. Those need different words, and a placeholder that
 * validates destroys the difference.
 *
 * So this guard also asserts that no non-comment line of the pointer carries a
 * placeholder, and that the pointer and the candidate's `registry_url` say the
 * same thing -- `null` on both when there is no deployment yet. That last check is
 * the one that cannot live in the generator: the generator writes both, so it
 * cannot be the thing that catches itself writing them inconsistently.
 */

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Must match `SCHEMA` in scripts/build-fallback-index.mjs. */
const SCHEMA = 1;
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

const TOP_LEVEL_KEYS = ["schema", "registry_url", "generated_at", "packages"];
const ENTRY_KEYS = ["repo_url", "latest_version", "tag", "commit", "trust", "kind"];
const TRUST_LEVELS = new Set(["verified", "trusted", "recognized"]);
const KINDS = new Set(["stdlib", "library"]);

/** The generator writes `new Date().toISOString()`, and nothing else is accepted. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEMVER_ISH = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The placeholder idiom, in the two spellings this repository uses --
 * `REPLACE-WITH-ACCOUNT-SUBDOMAIN` in the pointer and `REPLACE_WITH_D1_DATABASE_ID`
 * in `wrangler.jsonc`. Matched loosely on purpose: the failure this catches is a
 * copy-paste, and a copy-paste does not respect a precise spelling.
 */
const PLACEHOLDER = /REPLACE[-_]WITH/i;

const problems = [];

/** Collected rather than thrown, so one run reports every fault instead of the first. */
function refuse(message) {
  problems.push(message);
}

function fatal(message) {
  console.error(`::error::check-fallback-index: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { candidate: null, committed: null, owner: null, pointer: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) fatal(`${arg} needs a value`);
      i += 1;
      return value;
    };

    if (arg === "--candidate") args.candidate = take();
    else if (arg === "--committed") args.committed = take();
    else if (arg === "--owner") args.owner = take();
    else if (arg === "--pointer") args.pointer = take();
    else fatal(`unknown argument ${arg}`);
  }

  if (!args.candidate) fatal("--candidate is required: the file about to be committed");
  return args;
}

function readIndex(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return fatal(`cannot read the ${label} index at ${path}: ${err.message}`);
  }

  // A parse failure here is the whole point of the guard: a half-written file is
  // exactly what must never reach a commit.
  try {
    return JSON.parse(text);
  } catch (err) {
    return fatal(`the ${label} index at ${path} is not valid JSON: ${err.message}`);
  }
}

/** `https://github.com/<owner>/<repo>` and nothing else. Mirrors the generator. */
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

function validName(name) {
  return (
    typeof name === "string" &&
    name.length >= NAME.min &&
    name.length <= NAME.max &&
    NAME.rule.test(name) &&
    !NAME.reserved.has(name)
  );
}

// ---------------------------------------------------------------------------
// Structure: is this specific file a valid index?
// ---------------------------------------------------------------------------

function checkStructure(index) {
  if (index === null || typeof index !== "object" || Array.isArray(index)) {
    return fatal("the candidate index is not a JSON object");
  }

  const keys = Object.keys(index);

  // REGISTRY-API.md 12.4: `schema` is emitted first and checked first. A client is
  // told it may read the first key and stop, so the ordering is part of the format
  // rather than a formatting preference.
  if (keys[0] !== "schema") {
    refuse(`\`schema\` must be the first key, found \`${keys[0]}\``);
  }
  for (const key of keys) {
    if (!TOP_LEVEL_KEYS.includes(key)) refuse(`unexpected top-level key \`${key}\``);
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!keys.includes(key)) refuse(`missing top-level key \`${key}\``);
  }

  if (index.schema !== SCHEMA) {
    refuse(
      `schema is ${JSON.stringify(index.schema)}, expected the integer ${SCHEMA}. ` +
        `If the format really changed, this guard changes with it -- deliberately, ` +
        `because a client refuses a schema it does not implement.`,
    );
  }

  // `null` is a supported value, not a gap: until the Worker is published there
  // is no origin, `registry/v1/url.txt` is comments only, and the generator
  // carries that absence through rather than inventing a placeholder. See the
  // pointer file's closing block — a placeholder passes every rule below, so a
  // client would accept it, cache it for 24 hours and then report the registry
  // as unreachable rather than as undeployed.
  if (index.registry_url === null) {
    // Nothing more to check. `checkPointer` asserts the two files agree.
  } else if (typeof index.registry_url !== "string" || !index.registry_url.startsWith("https://")) {
    refuse(
      `registry_url must be an https:// string or null, got ${JSON.stringify(index.registry_url)}`,
    );
  } else if (index.registry_url.endsWith("/")) {
    refuse(`registry_url must carry no trailing slash, got ${index.registry_url}`);
  } else if (PLACEHOLDER.test(index.registry_url)) {
    refuse(
      `registry_url is a placeholder, not a URL: ${index.registry_url}. It satisfies every ` +
        `format rule, so a client cannot tell it from a real answer — it would be cached for ` +
        `24 hours and reported as the registry being unreachable rather than undeployed. ` +
        `null is the correct value until a real origin exists.`,
    );
  } else {
    let parsed = null;
    try {
      parsed = new URL(index.registry_url);
    } catch {
      refuse(`registry_url does not parse as a URL: ${index.registry_url}`);
    }
    if (parsed && (parsed.pathname !== "/" || parsed.search || parsed.hash)) {
      refuse(`registry_url must carry no path, query or fragment, got ${index.registry_url}`);
    }
  }

  if (typeof index.generated_at !== "string" || !ISO_INSTANT.test(index.generated_at)) {
    refuse(
      `generated_at must be an ISO 8601 UTC instant, got ${JSON.stringify(index.generated_at)}`,
    );
  } else if (Number.isNaN(Date.parse(index.generated_at))) {
    refuse(`generated_at is not a real instant: ${index.generated_at}`);
  }

  if (
    index.packages === null ||
    typeof index.packages !== "object" ||
    Array.isArray(index.packages)
  ) {
    return fatal("packages must be a name-keyed object, not an array or null");
  }
}

function checkEntries(index, owner) {
  const names = Object.keys(index.packages);

  // The generator sorts for byte-stable output; an unsorted map means something
  // other than the generator wrote this file.
  const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (names.join(" ") !== sorted.join(" ")) {
    refuse(
      "packages keys are not in ascending order, so this file was not written by the generator",
    );
  }

  for (const name of names) {
    if (!validName(name)) {
      refuse(
        `${JSON.stringify(name)} is not a valid registry name -- it fails the grammar, the ` +
          `length bounds, or the reserved-word list read from src/lib/package-name.ts`,
      );
      continue;
    }

    const entry = index.packages[name];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      refuse(`${name}: entry is not an object`);
      continue;
    }

    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.includes(key)) refuse(`${name}: unexpected key \`${key}\``);
    }
    for (const key of ENTRY_KEYS) {
      if (!(key in entry)) refuse(`${name}: missing key \`${key}\``);
    }

    if (!firstPartyRepo(entry.repo_url, owner)) {
      refuse(
        `${name}: repo_url ${JSON.stringify(entry.repo_url)} is not ` +
          `https://github.com/${owner}/<repo>. The index is first-party only, and this is ` +
          `the check that stops a development seed being published as fact.`,
      );
    }

    if (!TRUST_LEVELS.has(entry.trust)) {
      refuse(`${name}: trust is ${JSON.stringify(entry.trust)}`);
    }
    if (!KINDS.has(entry.kind)) {
      refuse(`${name}: kind is ${JSON.stringify(entry.kind)}`);
    }

    // The anti-fabrication invariant, in the only form a file can be checked
    // against: a version claim never appears without the tag and commit that make
    // it verifiable. `versions.git_ref` and `versions.commit` are both NOT NULL, so
    // all three travel together or none of them do -- a version with a null commit
    // would be a claim nobody can check, which is the shape
    // tests/regressions/no-fabricated-version.test.ts exists to prevent.
    const present = [entry.latest_version, entry.tag, entry.commit].filter((v) => v !== null);
    if (present.length !== 0 && present.length !== 3) {
      refuse(
        `${name}: latest_version/tag/commit must be all null or all set, got ` +
          `${JSON.stringify([entry.latest_version, entry.tag, entry.commit])}`,
      );
    }
    if (entry.latest_version !== null && !SEMVER_ISH.test(String(entry.latest_version))) {
      refuse(
        `${name}: latest_version ${JSON.stringify(entry.latest_version)} is not a semver version`,
      );
    }
    if (entry.commit !== null && String(entry.commit).trim() === "") {
      refuse(`${name}: commit is blank, which is not the same as absent`);
    }
  }

  return names;
}

// ---------------------------------------------------------------------------
// Comparison: is this file safe to commit *over the one already there*?
// ---------------------------------------------------------------------------

/** The index with `generated_at` dropped: everything a client actually resolves with. */
function contentOf(index) {
  return JSON.stringify({
    schema: index.schema,
    registry_url: index.registry_url,
    packages: index.packages,
  });
}

function compare(candidate, committed) {
  const before = Object.keys(committed.packages ?? {});
  const after = Object.keys(candidate.packages ?? {});

  const removed = before.filter((name) => !after.includes(name));
  const added = after.filter((name) => !before.includes(name));

  if (before.length > 0 && after.length === 0) {
    refuse(
      `the candidate index is empty and the committed one holds ${before.length} ` +
        `${before.length === 1 ? "entry" : "entries"}. Refusing to publish an empty index ` +
        `over a populated one: the register cannot lose every package, so this is a failed ` +
        `read of the database, not a change to it.`,
    );
  } else if (removed.length > 0) {
    refuse(
      `${removed.length} ${removed.length === 1 ? "name has" : "names have"} disappeared ` +
        `(${removed.join(", ")}). Nothing in the register deletes a package, so a name that ` +
        `vanished means the database read was incomplete. A deliberate removal is a human's ` +
        `commit, not this job's.`,
    );
  }

  // Same reasoning, one level down: no route rewrites `packages.repo_url`, and a
  // moved repository is the single highest-stakes change this file can carry -- it
  // is where an offline client will go looking for the code.
  for (const name of after) {
    if (!before.includes(name)) continue;
    const wasUrl = committed.packages[name]?.repo_url;
    const nowUrl = candidate.packages[name]?.repo_url;
    if (wasUrl !== nowUrl) {
      refuse(
        `${name}: repo_url changed from ${JSON.stringify(wasUrl)} to ${JSON.stringify(nowUrl)}. ` +
          `No code path updates a package's repository, so this needs a human to say why.`,
      );
    }
  }

  return { added, removed, before: before.length, after: after.length };
}

// ---------------------------------------------------------------------------
// The pointer, and the one thing it must agree with
// ---------------------------------------------------------------------------

/**
 * `registry/v1/url.txt` -> the URL it names, or `null` when it names none.
 *
 * The parse is the client's, restated: comments start with `#`, blanks are
 * skipped, and the first line that is neither is the URL. Nothing after it is
 * read, which is why a placeholder further down a file is harmless and one in
 * first position is not.
 */
function pointerUrl(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return fatal(`cannot read the pointer file at ${path}: ${err.message}`);
  }

  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "" && !entry.startsWith("#"));

  return line ?? null;
}

/**
 * Refuse a placeholder in URL position, and refuse a pointer that disagrees with
 * the index built from it.
 *
 * Both are the same failure seen from two sides: a URL published to every
 * installed `finn` that nobody meant to publish.
 */
function checkPointer(index, path) {
  const url = pointerUrl(path);

  if (url !== null && PLACEHOLDER.test(url)) {
    refuse(
      `${path} names a placeholder in URL position: ${url}. It satisfies every format rule ` +
        `the file documents, so a client cannot tell it from a real answer: it would be ` +
        `accepted, cached for 24 hours, and reported as the registry being unreachable rather ` +
        `than as never deployed. Delete the line — comments only is correct until a real ` +
        `origin exists.`,
    );
    return;
  }

  // The index's `registry_url` is generated *from* the pointer, so the two can
  // only disagree if something regenerated one and not the other. A client that
  // reads the index writes its `registry_url` into the same 24-hour cache the
  // pointer feeds, so a stale one there is a stale answer for every user.
  if ((index.registry_url ?? null) !== url) {
    refuse(
      `registry_url in the candidate index is ${JSON.stringify(index.registry_url ?? null)} but ` +
        `${path} names ${JSON.stringify(url)}. One was regenerated and the other was not; a ` +
        `client caches whichever it reads first, so they cannot be allowed to differ.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** One line per key; values are single-line by construction, so no heredoc syntax. */
function writeOutputs(outputs) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const body = Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/g, " ")}\n`)
    .join("");
  appendFileSync(path, body, "utf8");
}

function writeSummary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const owner = args.owner ?? DEFAULT_OWNER;
const candidatePath = resolve(args.candidate);
const committedPath = args.committed
  ? resolve(args.committed)
  : join(repoRoot, "registry/v1/packages.json");
const pointerPath = args.pointer ? resolve(args.pointer) : join(repoRoot, "registry/v1/url.txt");

const candidate = readIndex(candidatePath, "candidate");
checkStructure(candidate);
const names = checkEntries(candidate, owner);
checkPointer(candidate, pointerPath);

let comparison = null;
let changed = true;
let firstRun = false;

if (existsSync(committedPath)) {
  const committed = readIndex(committedPath, "committed");
  comparison = compare(candidate, committed);
  changed = contentOf(candidate) !== contentOf(committed);
} else {
  // Nothing to overwrite, so nothing to protect. Worth printing rather than
  // silently treating as "everything here is new".
  firstRun = true;
  console.log(`  no committed index at ${committedPath}: treating this as the first one`);
}

console.log(`  candidate    ${candidatePath}`);
console.log(`  entries      ${names.length}`);
console.log(
  `  registry_url ${
    candidate.registry_url === null || candidate.registry_url === undefined
      ? "null (no deployment yet; the pointer names none)"
      : candidate.registry_url
  }`,
);
if (comparison) {
  console.log(`  committed    ${comparison.before}`);
  if (comparison.added.length > 0) console.log(`  added        ${comparison.added.join(", ")}`);
  if (comparison.removed.length > 0) console.log(`  removed      ${comparison.removed.join(", ")}`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  console.error(
    `check-fallback-index: refusing this index (${problems.length} ` +
      `${problems.length === 1 ? "problem" : "problems"}). Nothing has been committed.`,
  );
  writeSummary([
    "### Fallback index: refused",
    "",
    ...problems.map((problem) => `- ${problem}`),
  ]);
  process.exit(1);
}

// `changed` is deliberately computed with `generated_at` removed. See the header of
// .github/workflows/fallback-index.yml for why a timestamp-only diff is not worth
// a commit.
console.log(`  changed      ${changed ? "yes" : "no (only generated_at moved)"}`);

writeOutputs({
  changed: String(changed),
  entries: String(names.length),
  previous_entries: comparison ? String(comparison.before) : "",
  added: comparison ? comparison.added.join(" ") : "",
  first_run: String(firstRun),
});
