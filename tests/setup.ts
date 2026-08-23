/**
 * Test harness: a throwaway SQLite database per test file, plus contract-shaped
 * seed helpers.
 *
 * Everything temp-file related lives here. Test files never touch the
 * filesystem, never build SQL, and never see a database handle.
 *
 * How it works:
 *  - a fresh temp directory + `.db` file is created per test file (vitest gives
 *    each file its own module registry, so this module runs once per suite);
 *  - `DATABASE_URL` is set *before* any test file imports `@/lib/db`, so
 *    `getDb()` resolves to this file (it has no `env.DB`, so it falls through to
 *    the libsql branch);
 *  - the schema is generated from `src/lib/db/schema.ts` itself via
 *    `drizzle-kit/api`, so this file never restates the DDL and never drifts
 *    from the app's schema;
 *  - every row is deleted between tests, so suites are order-independent.
 *
 * SCHEMA-TOLERANT SEEDING. The contract (docs/REGISTRY-CONTRACT.md §3) names
 * fields the schema may not have a column for yet. Seeding writes each logical
 * field to the first candidate column that actually exists and silently skips
 * the rest, which keeps a missing column from turning into an SQL error: the
 * test then fails on the field the response is missing, which is the useful
 * failure. `unsupportedSeedFields()` lists what got skipped, and anything not
 * accounted for in `DERIVED_FIELDS` is printed once per suite.
 */

import { afterAll, afterEach, beforeEach } from "vitest";
import { createClient, type Client, type InValue } from "@libsql/client/node";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as schema from "@/lib/db/schema";

// --- temp database ----------------------------------------------------------

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "finn-registry-test-"));
const dbFile = path.join(tempDir, "registry.db");

// Must happen before any module reads it: `@/lib/db` picks its client up from
// this at call time, and the test files import the router (and therefore the
// db) as a side effect of their own imports.
process.env.DATABASE_URL = `file:${dbFile}`;
delete process.env.DB;

const client: Client = createClient({ url: process.env.DATABASE_URL });

/** Absolute path of this suite's database file. Exposed for diagnostics only. */
export const testDatabaseFile = dbFile;

// Foreign keys stay off: seed helpers insert in whatever order a test asks for,
// and `resetDatabase` truncates without caring about dependency order.
await client.execute("PRAGMA foreign_keys = OFF");

const prev = await generateSQLiteDrizzleJson({});
const next = await generateSQLiteDrizzleJson(schema as Record<string, unknown>);
const ddl = await generateSQLiteMigration(prev, next);
await client.executeMultiple(ddl.join("\n"));

const tableNames: string[] = (
  await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  )
).rows.map((row) => String(row.name));

const columnCache = new Map<string, Set<string>>();

async function columnsOf(table: string): Promise<Set<string>> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const info = await client.execute(`PRAGMA table_info("${table}")`);
  const columns = new Set(info.rows.map((row) => String(row.name)));
  columnCache.set(table, columns);
  return columns;
}

const skipped = new Set<string>();

/**
 * Logical fields no column was found for. Anything here that is not in
 * `DERIVED_FIELDS` is a gap between the contract and the schema.
 */
export function unsupportedSeedFields(): string[] {
  return [...skipped].sort();
}

/** Deletes every row. Registered as a `beforeEach` below. */
export async function resetDatabase(): Promise<void> {
  for (const table of tableNames) {
    await client.execute(`DELETE FROM "${table}"`);
  }
}

beforeEach(resetDatabase);

/**
 * Contract fields that deliberately have no column, so they are not worth
 * warning about:
 *  - `publisher.kind` is derived from whether the package is linked to an
 *    `organizations` row;
 *  - `trust.repo_ownership_confirmed` is a registration invariant (§2.2): every
 *    row in `packages` got there by proving push access;
 *  - publisher verification lives on `users`, so an organisation's row does not
 *    carry it.
 */
const DERIVED_FIELDS = new Set([
  "users.kind",
  "packages.repo_ownership_confirmed",
  "organizations.is_verified",
]);

afterAll(() => {
  const missing = unsupportedSeedFields().filter((field) => !DERIVED_FIELDS.has(field));
  if (missing.length > 0) {
    console.warn(
      `[tests/setup] seed fields with no column in src/lib/db/schema.ts: ${missing.join(", ")}`,
    );
  }
  client.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// --- driving the API --------------------------------------------------------

export interface ApiResponse {
  status: number;
  headers: Headers;
  /** The parsed JSON body, or the raw text when the response was not JSON. */
  body: any;
  text: string;
}

/**
 * The Hono app, imported from `./router` rather than `./route`.
 *
 * `route.ts` cannot export it: Next type-checks a route module against a fixed
 * set of allowed exports, and an extra `app` export fails `next build` even
 * though `tsc --noEmit` is happy with it. So the router lives in `router.ts` and
 * `route.ts` is only the `handle(app)` adapter.
 */
let routerModule: Promise<typeof import("@/app/api/[[...route]]/router")> | undefined;

let requestCount = 0;

/**
 * Calls the real Hono router in-process (`app.request`). No dev server, no
 * network, no mocks. The router is imported lazily so that `DATABASE_URL` is
 * already pointing at this suite's temp file when `@/lib/db` first loads.
 *
 * Each call gets a unique `x-forwarded-for` unless the caller sets one. The
 * rate limiters (§3.7) key on the caller's IP and hold state for the lifetime of
 * the module, so without this a long suite would start seeing 429s partway
 * through — the registration limiter allows 30 requests per window. A test that
 * wants to *exercise* a limit sets the header itself and gets one bucket.
 */
export async function apiGet(url: string, init?: RequestInit): Promise<ApiResponse> {
  routerModule ??= import("@/app/api/[[...route]]/router");
  const { app } = await routerModule;

  const headers = new Headers(init?.headers);
  if (!headers.has("x-forwarded-for")) {
    requestCount += 1;
    headers.set("x-forwarded-for", `203.0.113.${requestCount % 256}:${requestCount}`);
  }

  const response = await app.request(url, { ...init, headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Left as text on purpose: a non-JSON body should show up verbatim in the
    // assertion failure rather than as a parse error.
  }
  return { status: response.status, headers: response.headers, body, text };
}

/**
 * POSTs JSON. `token` is sent as the `auth_token` cookie, which is what the
 * browser flow uses (§2.5) and what `getAuth` reads when there is no
 * `Authorization` header.
 */
export async function apiPost(
  url: string,
  options: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (options.token) headers.Cookie = `auth_token=${options.token}`;

  return apiGet(url, {
    method: "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

// --- stubbing GitHub --------------------------------------------------------

export interface StubbedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const realFetch = globalThis.fetch;

/**
 * Replaces `globalThis.fetch` for one test.
 *
 * The stub sits at the network boundary rather than on our own modules: the
 * point of the §3.10 tests is that the registry actually asks GitHub about push
 * access and believes only the answer (ADR-0004), and mocking
 * `checkPushAccess` would assume away exactly that. Anything that is not the
 * GitHub API throws, so a test can never silently reach the network.
 *
 * Returns the call log, so a test can assert that the check happened at all.
 */
export function stubGitHub(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): StubbedCall[] {
  const calls: StubbedCall[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (!url.startsWith("https://api.github.com/")) {
      throw new Error(`[tests] unstubbed network call to ${url}`);
    }

    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    return handler(url, init);
  }) as typeof fetch;

  return calls;
}

/** A GitHub `GET /repos/{owner}/{repo}` payload, with only the fields we read. */
export function githubRepo(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    full_name: "acme/fin-http",
    description: "An HTTP client",
    homepage: "https://acme.example/fin-http",
    default_branch: "main",
    license: { spdx_id: "Apache-2.0" },
    permissions: { admin: false, maintain: false, push: true, pull: true },
    ...overrides,
  };
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- insert plumbing --------------------------------------------------------

type Candidates = string | string[];

function toSqlValue(value: unknown): InValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

async function insertRow(table: string, fields: Array<[Candidates, unknown]>): Promise<void> {
  const columns = await columnsOf(table);
  const names: string[] = [];
  const args: InValue[] = [];

  for (const [candidates, value] of fields) {
    const list = Array.isArray(candidates) ? candidates : [candidates];
    const column = list.find((name) => columns.has(name));
    if (!column) {
      skipped.add(`${table}.${list[0]}`);
      continue;
    }
    if (names.includes(column)) continue;
    names.push(column);
    args.push(toSqlValue(value));
  }

  await client.execute({
    sql:
      `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) ` +
      `VALUES (${names.map(() => "?").join(", ")})`,
    args,
  });
}

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
}

function fakeCommit(seed: string): string {
  return nodeCrypto.createHash("sha1").update(seed).digest("hex");
}

// --- seed helpers -----------------------------------------------------------

export interface SeedPublisherInput {
  login?: string;
  display_name?: string | null;
  avatar_url?: string | null;
  kind?: "user" | "organization";
  is_verified?: boolean;
  /** When the account joined; §3.9 publishes it. */
  created_at?: string;
}

export interface SeededPublisher {
  id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  kind: "user" | "organization";
  is_verified: boolean;
  /**
   * Set for an organisation publisher. The schema has no `users.kind` column:
   * an organisation registration is a package linked to an `organizations` row,
   * so `seedPublisher` writes both rows with the same display name and
   * `seedPackage` links the package to this id.
   */
  organization_id: string | null;
  /**
   * The login of the underlying account. Equal to `login` for a user publisher;
   * for an organisation it is the owning account, which is a different login.
   */
  owner_login: string;
}

export interface SeedVersionInput {
  version: string;
  git_ref?: string;
  commit?: string;
  checksum?: string | null;
  checksum_origin?: "publisher_attested" | null;
  yanked?: boolean;
  published_at?: string;
}

export interface SeededVersion {
  id: string;
  version: string;
  git_ref: string;
  commit: string;
  checksum: string | null;
  checksum_origin: "publisher_attested" | null;
  yanked: boolean;
  published_at: string;
}

export interface SeedPackageInput {
  name: string;
  description?: string | null;
  repo_url?: string;
  homepage?: string | null;
  license?: string | null;
  keywords?: string[];
  publisher?: SeededPublisher | SeedPublisherInput;
  downloads?: number;
  stars?: number;
  is_deprecated?: boolean;
  deprecation_message?: string | null;
  created_at?: string;
  updated_at?: string;
  /** A moderator vouched for this one package (contract §2.3). */
  package_trusted?: boolean;
  /** Proven push access at registration (contract §2.2). True for every real row. */
  repo_ownership_confirmed?: boolean;
  versions?: SeedVersionInput[];
}

export interface SeededPackage {
  id: string;
  name: string;
  repo_url: string;
  publisher: SeededPublisher;
  versions: SeededVersion[];
}

function isSeededPublisher(value: unknown): value is SeededPublisher {
  return typeof value === "object" && value !== null && "id" in value;
}

export async function seedPublisher(input: SeedPublisherInput = {}): Promise<SeededPublisher> {
  const login = input.login ?? `publisher-${sequence + 1}`;
  const kind = input.kind ?? "user";
  const publisher: SeededPublisher = {
    id: nextId("user"),
    login,
    display_name: input.display_name ?? login,
    avatar_url: input.avatar_url ?? `https://avatars.example/${login}.png`,
    kind,
    is_verified: input.is_verified ?? false,
    organization_id: null,
    // GitHub logins are globally unique across users and organisations, so an
    // organisation publisher's owning account cannot share the organisation's
    // login. Keeping them distinct matters: `GET /api/publishers/:login`
    // resolves a user login before an organisation name, so a shadowing user
    // row would hide the organisation branch and report `kind: "user"`.
    owner_login: kind === "organization" ? `${login}-owner` : login,
  };

  await insertRow("users", [
    ["id", publisher.id],
    ["github_id", sequence * 1000],
    [["login", "username"], publisher.owner_login],
    [["display_name", "name"], publisher.display_name],
    ["avatar_url", publisher.avatar_url],
    [["kind", "account_type", "publisher_kind"], publisher.kind],
    [["is_verified", "verified", "publisher_verified"], publisher.is_verified],
    ["created_at", input.created_at ?? "2026-01-01T00:00:00Z"],
  ]);

  if (publisher.kind === "organization") {
    publisher.organization_id = nextId("org");
    await insertRow("organizations", [
      ["id", publisher.organization_id],
      ["name", publisher.login],
      ["display_name", publisher.display_name],
      ["avatar_url", publisher.avatar_url],
      [["owner_id", "user_id"], publisher.id],
      [["is_verified", "verified"], publisher.is_verified],
      ["created_at", input.created_at ?? "2026-01-01T00:00:00Z"],
    ]);
  }

  return publisher;
}

export async function seedPackage(input: SeedPackageInput): Promise<SeededPackage> {
  const publisher = isSeededPublisher(input.publisher)
    ? input.publisher
    : await seedPublisher(input.publisher ?? {});

  const id = nextId("pkg");
  const repoUrl = input.repo_url ?? `https://github.com/${publisher.login}/fin-${input.name}`;

  await insertRow("packages", [
    ["id", id],
    ["name", input.name],
    ["description", input.description ?? `The ${input.name} package`],
    ["repo_url", repoUrl],
    ["homepage", input.homepage ?? null],
    ["license", input.license ?? "MIT"],
    ["keywords", input.keywords ?? []],
    [["owner_id", "publisher_id", "user_id"], publisher.id],
    ["organization_id", publisher.organization_id],
    ["downloads", input.downloads ?? 0],
    ["stars", input.stars ?? 0],
    ["is_deprecated", input.is_deprecated ?? false],
    ["deprecation_message", input.deprecation_message ?? null],
    [["is_trusted", "package_trusted", "trusted"], input.package_trusted ?? false],
    [
      ["repo_ownership_confirmed", "ownership_confirmed", "repo_verified"],
      input.repo_ownership_confirmed ?? true,
    ],
    ["created_at", input.created_at ?? "2026-08-01T00:00:00Z"],
    ["updated_at", input.updated_at ?? input.created_at ?? "2026-08-20T00:00:00Z"],
  ]);

  const pkg: SeededPackage = {
    id,
    name: input.name,
    repo_url: repoUrl,
    publisher,
    versions: [],
  };

  for (const version of input.versions ?? []) {
    pkg.versions.push(await seedVersion(pkg, version));
  }

  return pkg;
}

export async function seedVersion(
  pkg: SeededPackage,
  input: SeedVersionInput,
): Promise<SeededVersion> {
  const record: SeededVersion = {
    id: nextId("ver"),
    version: input.version,
    git_ref: input.git_ref ?? `v${input.version}`,
    commit: input.commit ?? fakeCommit(`${pkg.name}@${input.version}`),
    checksum: input.checksum ?? `sha256:${fakeCommit(`checksum:${pkg.name}@${input.version}`)}`,
    checksum_origin:
      input.checksum_origin === undefined ? "publisher_attested" : input.checksum_origin,
    yanked: input.yanked ?? false,
    published_at: input.published_at ?? "2026-08-20T00:00:00Z",
  };

  await insertRow("versions", [
    ["id", record.id],
    [["package_id", "pkg_id"], pkg.id],
    ["version", record.version],
    [["git_ref", "ref", "tag"], record.git_ref],
    [["commit", "commit_hash", "commit_sha"], record.commit],
    ["checksum", record.checksum],
    ["checksum_origin", record.checksum_origin],
    [["yanked", "is_yanked"], record.yanked],
    [["published_at", "created_at"], record.published_at],
  ]);

  return record;
}

/** Shorthand for the common "one package, one publisher, some versions" case. */
export async function seedRegistry(packages: SeedPackageInput[]): Promise<SeededPackage[]> {
  const seeded: SeededPackage[] = [];
  for (const input of packages) {
    seeded.push(await seedPackage(input));
  }
  return seeded;
}

export interface SeedSessionInput {
  publisher: SeededPublisher;
  /** The GitHub token the session was minted with; replayed to GitHub (ADR-0004). */
  github_access_token?: string | null;
  /**
   * The scopes GitHub granted, verbatim. Signing in asks for `user:email`
   * (ADR-0004), so that — not `repo` — is the default a fresh session carries.
   */
  github_scope?: string | null;
  expires_at?: number;
}

export interface SeededSession {
  id: string;
  token: string;
  publisher: SeededPublisher;
}

/**
 * An authenticated browser session. `token` goes in the `auth_token` cookie,
 * which `apiPost` does for you.
 */
export async function seedSession(input: SeedSessionInput): Promise<SeededSession> {
  const id = nextId("sess");
  const token = fakeCommit(`session:${id}`);

  await insertRow("sessions", [
    ["id", id],
    [["user_id", "publisher_id"], input.publisher.id],
    ["token", token],
    [["github_access_token", "access_token"], input.github_access_token ?? "gho_test_token"],
    [["github_scope", "scope"], input.github_scope ?? "user:email"],
    ["expires_at", input.expires_at ?? Date.now() + 60 * 60 * 1000],
    ["created_at", "2026-08-01T00:00:00Z"],
  ]);

  return { id, token, publisher: input.publisher };
}
